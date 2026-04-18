# ADR-008 · Moneda canónica para matching de conciliación

- **Estado:** Aceptado
- **Fecha de firma:** 2026-04-19
- **Dueño:** Tech lead (Javier)
- **Relacionados:** ADR-006 + amendment (segregación aprobación), ADR-007 (política omnicanal), Sprint 5 (motor de conciliación)

---

## Contexto

Durante el análisis del motor de conciliación previo a Sprint 5 se confirmó un bug estructural latente:

El motor (`reconciliationService.js`) compara `sales_orders.order_total_amount` directamente contra `bank_statements.amount` **sin conversión de moneda ni validación explícita**. Según la migración `20260412_sales_orders_order_total_amount.sql`, el campo `order_total_amount` contiene "el total en la moneda de la orden" — variable según el canal:

- **CH-3 MercadoLibre:** VES (API ML Venezuela cotiza en Bs)
- **CH-1 Mostrador:** USD (heredado del rename `total_amount_usd`)
- **CH-2 WhatsApp manual:** depende de cómo el vendedor creó la orden
- **CH-5 Fuerza de ventas:** USD probable (contratos en divisa)

`bank_statements.amount` **siempre** está en VES (Banesco Venezuela).

### Por qué el bug no es visible hoy

Verificación contra DB real (2026-04-19):
- Total de órdenes registradas: **170 órdenes**, todas de **CH-3 ML**
- Como CH-3 ML guarda en VES, coincide con la moneda de `bank_statements`
- Ratios de los últimos 4 matches exitosos: **1.00 exactamente** (match perfecto sin conversión)

El motor funciona por coincidencia de moneda, no por diseño correcto.

### Por qué el bug aparece mañana

En cuanto se registre la primera orden de CH-2, CH-5 o CH-1 con `order_total_amount` en USD:

- **Falso negativo:** orden USD 100 nunca matchea contra banco Bs 3,450 (mismo dinero real, distintas unidades)
- **Falso positivo:** orden USD 100 puede matchear contra un banco Bs 100 de otro cliente por casualidad numérica. Dinero de A se aplica a orden de B. Incorrecto y no detectable sin auditoría.

### La infraestructura para corregir ya existe

`sales_orders` tiene tres columnas diseñadas hace tiempo que nadie pobló ni usó:

- `total_amount_bs NUMERIC(14,2)` — equivalente en Bs
- `exchange_rate_bs_per_usd NUMERIC` — tasa usada al crear la orden (congelada)
- `rate_date DATE` — fecha de la tasa aplicada

Y existe `daily_exchange_rates` con la tasa BCV diaria.

**El diseño del schema previó el problema. La implementación nunca lo conectó.** ADR-008 corrige esto.

## Decisión

**`total_amount_bs` es la moneda canónica del motor de conciliación.** El motor compara siempre `total_amount_bs` contra `bank_statements.amount`, ambos en VES.

### Regla 1 · Campo canónico de matching

```
IF payment comparison (any reconciliation level):
    motor compara so.total_amount_bs CONTRA bank_statements.amount
    (ambos en VES, mismas unidades, mismo orden de magnitud)

NUNCA motor compara so.order_total_amount directamente contra banco
```

### Regla 2 · `order_total_amount` sigue existiendo con semántica clara

`order_total_amount` no se deprecara. Su rol:

- **Moneda original de la orden** (para mostrar al cliente, facturación, reportes por canal)
- **Dato fiscal** (la factura refleja la moneda en que se vendió, no solo VES)
- **NO es input del motor de conciliación**

La coexistencia de ambos campos es intencional:
- `order_total_amount` = "cuánto cuesta en la moneda de la venta"
- `total_amount_bs` = "cuánto es en Bs para cruzar con el banco"

### Regla 3 · Poblar `total_amount_bs` en origen (todos los canales)

Cada punto donde se crea una `sales_order` debe poblar las 3 columnas:

| Canal / fuente | `order_total_amount` | `total_amount_bs` | `exchange_rate_bs_per_usd` | `rate_date` |
|---|---|---|---|---|
| CH-3 ML webhook | API ML (VES) | = `order_total_amount` | 1 (es VES nativo) | hoy |
| CH-1 Mostrador POS | Como lo marca POS | Si USD: × tasa; si Bs: = order_total_amount | tasa del día desde `daily_exchange_rates` | hoy |
| CH-2 WhatsApp manual | Lo que vendedor ingresa + moneda seleccionada | Según moneda | Tasa del día | hoy |
| CH-5 Fuerza de ventas | USD típico | `order_total_amount × tasa` | Tasa del día congelada | fecha de creación |

**Cuando el canal/vendedor no declara moneda explícitamente, default = USD + convertir.** Esto fuerza disciplina: cualquier vendedor que no diga moneda, por default es divisa (lo más valioso contablemente).

### Regla 4 · Tasa congelada al crear, no dinámica

`exchange_rate_bs_per_usd` se **guarda al crear la orden** con la tasa vigente. **No se recalcula después**. Razones:

- Fiscalmente la tasa de la transacción es la del día de la transacción
- Si la tasa sube 20% entre la orden y el pago, el matching no debe fallar por eso
- El cliente pagó lo que se le cotizó, no lo que vale hoy

Consecuencia: una orden creada con tasa 34.5 y pagada una semana después con tasa 38.0 matchea contra el Bs pagado usando la tasa 34.5 (la congelada). El "pago en exceso" por tasa es decisión fiscal/comercial, no técnica.

### Regla 5 · Backfill de órdenes históricas

Se ejecuta como parte del Sprint 5 (ticket BE-5.0):

```sql
-- Verificación previa: detectar total_amount_bs ya populados (posiblemente con valor incorrecto)
SELECT channel_id,
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE total_amount_bs IS NULL)     AS sin_bs,
       COUNT(*) FILTER (WHERE total_amount_bs IS NOT NULL) AS con_bs
FROM sales_orders
GROUP BY channel_id;

-- Backfill CH-3 (ML Venezuela, ya está en VES)
-- IMPORTANTE: sin filtro IS NULL porque importSalesOrderFromMlOrder ya populaba
-- total_amount_bs = order_total_amount × BCV_rate (incorrecto para VES nativo).
-- Este UPDATE sobreescribe todos los CH-3 para garantizar el valor correcto.
UPDATE sales_orders
SET total_amount_bs         = order_total_amount,
    exchange_rate_bs_per_usd = 1,  -- ML Venezuela es VES nativo; tasa = 1
    rate_date               = COALESCE(rate_date, DATE(created_at))
WHERE channel_id = 3
  AND order_total_amount IS NOT NULL;
```

**Si en el futuro aparecen órdenes históricas sin `total_amount_bs` en otros canales:**

- Query de detección mensual: contar órdenes con `total_amount_bs IS NULL`
- Si aparecen: no migrar automáticamente. Auditor manual revisa cada una. Sin moneda verificable, es mejor `NULL` que dato incorrecto.

### Regla 6 · Validación del motor antes de matchear

El motor valida que `total_amount_bs IS NOT NULL` antes de considerar una orden candidata:

```sql
WHERE so.payment_status = 'pending'
  AND so.channel_id IN (2, 5)
  AND so.total_amount_bs IS NOT NULL
  AND so.total_amount_bs > 0
```

Si `total_amount_bs IS NULL`, la orden **no entra al motor**. Se genera excepción de tipo `missing_canonical_amount` para revisión humana. Sin moneda canónica, no hay matching posible y no hay riesgo de falso positivo.

## Consecuencias

### Sprint 5 · nuevo ticket BE-5.0

**Pre-requisito de todo lo demás en el sprint.**

Tareas:
1. Backfill de las 170 órdenes CH-3 con SQL anterior
2. Agregar populate de `total_amount_bs` en los puntos de creación de órdenes
3. Modificar `reconciliationService.js`: leer `total_amount_bs` en lugar de `order_total_amount` para comparación
4. Agregar validación `total_amount_bs IS NOT NULL AND > 0` al filtro inicial
5. Tests con orden simulada de cada canal

**Estimación:** 2 días de backend. Bloquea todos los demás tickets del Sprint 5.

### Campo `order_total_amount` no se toca

Sigue existiendo, se sigue poblando como hoy, se sigue usando para UI, facturación y reportes por canal. **El motor de conciliación no lo consulta más** para comparar contra banco.

### Integración con split payment

Cuando una orden tenga pagos mixtos (parte Bs + parte USD), la suma se verifica contra `total_amount_bs` según ADR-007 regla 5.

### Reglas fiscales no cambian

IGTF, retenciones y facturación siguen usando la semántica fiscal existente. ADR-008 solo afecta el motor de conciliación numérica contra extracto Bs.

## Criterios de éxito

- [ ] Las órdenes CH-3 elegibles tienen `total_amount_bs` poblado tras backfill
- [ ] Ningún punto de creación de orden deja `total_amount_bs` en NULL (canales en scope)
- [ ] Motor compara `total_amount_bs` vs `bank_statements.amount`
- [ ] Motor rechaza órdenes con `total_amount_bs IS NULL` con excepción explícita
- [ ] Reporte mensual de órdenes con `total_amount_bs IS NULL` (monitoreo)

## Decisiones que quedan abiertas

- Selector de moneda en UI: Sprint 6
- Reportes multi-moneda: Sprint 6
- Conciliación automática de divisa pura: fuera de scope hasta volumen justifique (ver ADR-007)

## Observaciones

- Este ADR **cierra una trampa** que habría costado caro en producción.
- La infraestructura ya estaba en schema (`total_amount_bs`); ADR-008 formaliza y conecta.
