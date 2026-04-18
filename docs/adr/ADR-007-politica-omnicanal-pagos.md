# ADR-007 · Política omnicanal de pagos y conciliación

- **Estado:** Aceptado
- **Fecha de firma:** 2026-04-19
- **Dueño:** Tech lead (Javier)
- **Relacionados:** ADR-006 (segregación vendedor/caja), ADR-008 (moneda canónica `total_amount_bs`), `sales_channels`, `payment_methods`, Sprint 5

---

## Contexto

El negocio opera **cinco canales de venta** (`sales_channels`: Mostrador, WhatsApp/Redes, MercadoLibre, E-Commerce, Fuerza de ventas) y **ocho métodos de pago** (`payment_methods` en `igtf.sql` / `tax-retentions.sql`). No todos los canales reciben transferencia por Banesco ni comprobante por WhatsApp; no todos los métodos pasan por el mismo pipeline de conciliación.

Este ADR fija las **reglas de negocio** que el código y los prompts de sprint deben respetar. El detalle de implementación vive en tickets (p. ej. `docs/prompts/prompt-sprint-5.md` v3).

---

## Reglas 1-9 (resumen operativo)

1. **Whitelist de canales para motor de conciliación bancaria:** solo canales donde el pago típico entra por transferencia/comprobante en Bs alineable con `bank_statements` — p. ej. CH-2 y CH-5 (`channel_id IN (2, 5)`). CH-3 ML y CH-4 e-commerce usan pasarela externa; el motor no debe tratarlos como candidatos por defecto.

2. **Fuentes de verdad:** movimientos bancarios en `bank_statements` (VES); comprobantes WA en `payment_attempts` (extracción Gemini). Motor Node en `reconciliationService.js` (no el `run_reconciliation()` SQL sobre `invoices`).

3. **Métodos conciliables vs no:** transferencia Bs, Pago Móvil típicamente sí; efectivo y divisas sin extracto en Banesco VES requieren otro flujo (manual / registro POS).

4. **Niveles L1/L2/L3:** definidos en comentarios de `reconciliationService.js` (monto + referencia + fecha → L1; monto + fecha en ventana → L2; fuera de ventana o baja confianza → L3 `manual_review`).

5. **Split payment:** cuando aplique, la suma de líneas de pago debe cerrar contra el total canónico en Bs (`total_amount_bs` tras ADR-008).

6. **Segregación vendedor/caja:** ver ADR-006 (propuestas, aprobación, rechazo).

7. **Fiscalidad:** IGTF, retenciones y facturación no se redefinen aquí; usan `payment_methods` y tablas fiscales existentes.

8. **Divisa (USD/Zelle) sin extracto Banesco VES:** pipeline automático de matching contra `bank_statements` no aplica igual que Bs; estrategia por fases (captura en comprobante, conversión, revisión manual) según volumen — trigger de reapertura cuando el volumen lo justifique.

9. **Métricas:** priorizar SLAs operativos (pendientes de caja, antigüedad L3) frente a “% match automático” como KPI único; el % alto se logra con datos de calidad y reglas, no forzando un número en el ADR.

---

## Amendments

> **Referencia:** el mismo texto vive en [`ADR-007-amendment-moneda-canonica.md`](./ADR-007-amendment-moneda-canonica.md) para diffs y enlaces rápidos.

### 2026-04-19 · Regla 10 — Moneda canónica (`ADR-007-amendment-moneda-canonica.md`)

La comparación numérica del motor de conciliación es contra **`total_amount_bs`**, no contra `order_total_amount`. Texto íntegro del amendment:

---

**Fecha:** 2026-04-19  
**Tipo:** Ajuste por ADR-008 firmado  
**Estado:** Aceptado

#### Regla 10 · Moneda canónica del motor es `total_amount_bs` (por ADR-008)

Tras firma de ADR-008, se aclara que el motor de conciliación compara **`sales_orders.total_amount_bs`** contra `bank_statements.amount`, no `order_total_amount`.

```sql
WHERE so.payment_status = 'pending'
  AND so.channel_id IN (2, 5)
  AND so.total_amount_bs IS NOT NULL
  AND so.total_amount_bs > 0
```

Esto **no cambia** las reglas 1-9 anteriores. Solo precisa **contra qué columna se hace el matching**.

**Split payment:** se resuelve contra `total_amount_bs` (pagos VES directo; USD/EUR con tasa congelada de la orden).

**Referencia:** `ADR-008-moneda-canonica-matching.md`.

---

## Estado de revisión

Revisar si cambian canales activos, política de tasas o normativa fiscal.
