# ADR-002 · Conciliación bancaria: webhook de tiempo real vs ingesta por archivo

- **Estado:** Propuesta
- **Fecha:** _(pendiente)_
- **Dueño:** Backend lead
- **Deadline de firma:** Día 3 de la Semana 0
- **Relacionados:** Sprint 5 (conciliación), órdenes / pagos en `sales_orders`. **Flujo de aprobación vendedor/caja y reglas de auto-match:** [ADR-006-segregacion-aprobacion-pagos.md](./ADR-006-segregacion-aprobacion-pagos.md) (aceptado).

---

## Contexto

El mockup plantea “conciliación bancaria automática” como si hubiera webhooks en tiempo real estilo Stripe. La realidad del repo y del mercado venezolano es distinta:

- **Banesco:** hoy se procesa vía monitor Playwright + ingesta CSV + tablas de extractos (`bank_statements` o equivalente). No hay webhook oficial.
- **BDV (Banco de Venezuela):** principalmente ingesta de archivos (CSV/PDF/Excel). Sin API pública estable.
- **Mercantil:** similar a BDV.
- **Provincial / BBVA:** situación variable según acuerdos comerciales.

Los bancos venezolanos, en general, no ofrecen webhooks estándar. Cualquier automatización de conciliación se apoya en:

1. Scraping periódico con herramientas tipo Playwright
2. Carga de archivos CSV/Excel (manual o automatizada)
3. APIs internas acordadas por convenio (raras)

La pregunta es: **¿qué arquitectura adopta el sistema para la conciliación, sabiendo que cada banco es distinto?**

## Opciones

### Opción A · Mantener ingesta CSV/Playwright por banco, sin abstracción

Cada banco tiene su propio job/adaptador con lógica específica, escribiendo a `bank_statements`. El matching lee de ahí.

```
BanescoMonitor (Playwright) ──┐
BDVCsvImporter (cron)         ├──► bank_statements ──► paymentMatchingService
MercantilCsvImporter (cron)   ┘
```

**Pros:**

- Cero complejidad nueva
- Respeta lo que ya funciona (Banesco Playwright)
- Cada banco se mantiene y debuggea por separado

**Contras:**

- Código duplicado entre jobs (normalización de formato, reintentos, logging)
- Agregar un banco nuevo = crear job nuevo desde cero
- Testing más difícil (cada job tiene sus propias dependencias externas)

### Opción B · Webhooks donde existan + archivo como fallback

Si algún banco expone webhook en algún momento, se agrega. El resto siguen por archivo.

**Pros:** aprovecha webhooks si aparecen. **Contras:** hoy suele añadir complejidad sin valor inmediato en el scope VE.

### Opción C · Ports & Adapters (Hexagonal) con interfaz común

Definir una interfaz única `IBankStatementSource`. Cada banco implementa un adaptador. El motor de matching es agnóstico del origen.

```typescript
interface IBankStatementSource {
  readonly bankName: string;
  fetchNew(since: Date): Promise<BankTransaction[]>;
  healthCheck(): Promise<boolean>;
}

class BanescoPlaywrightAdapter implements IBankStatementSource { ... }
class BDVCsvAdapter implements IBankStatementSource { ... }
class MercantilCsvAdapter implements IBankStatementSource { ... }
// Futuro: class BancoXWebhookAdapter implements IBankStatementSource { ... }
```

Un orquestador (`BankIngestionService`) corre todos los adaptadores por cron y unifica en `bank_statements`.

**Pros:**

- Interfaz única → matching service simple y testeable con mocks
- Agregar banco nuevo = implementar interfaz
- Si aparece un webhook en el futuro, es solo otro adaptador

**Contras:**

- Trabajo inicial de refactor de Banesco a adaptador (2-3 días)
- Más archivos y abstracciones
- Si solo habrá 2 bancos jamás, puede ser overkill

## Decisión

_(Pendiente de firma. Recomendación del equipo de arquitectura: **Opción C** para S5 con Banesco (ya existente) + BDV + Mercantil como primeros adaptadores. Webhooks se agregan si aparecen, sin replantear arquitectura.)_

## Consecuencias

_(Completar una vez firmada)_

- Si **Opción A**: S5 mantiene el monitor de Banesco y agrega jobs separados (BDV, Mercantil). Sin refactor.
- Si **Opción B**: igual que A + scaffolding para webhook handler si aplica.
- Si **Opción C**: S5 incluye refactor para envolver Banesco en adaptador y escribir los otros. El motor de matching se simplifica.

## Scope para Sprint 5

| Banco | Método | Prioridad |
|-------|--------|-----------|
| Banesco | Ya funciona vía Playwright | Alta (productivo) |
| BDV | CSV manual o cron | Alta |
| Mercantil | CSV manual o cron | Media |
| Otros | — | Roadmap futuro |

## Tasa de matching esperada

**70-85%** de matching automático es un objetivo razonable. No prometer 95%+ por referencias ambiguas, terceros pagando, redondeos USD/VES, etc.

## Criterios de éxito de la conciliación

1. Tasa de match automático medida contra total de pagos recibidos en el período
2. Tiempo medio desde ingreso al extracto hasta `payment_status = approved` cuando aplique
3. Falsos positivos (matches deshechos): objetivo menor al 1%

## Notas al implementar

- Tolerancia de monto configurable (default: ±$1 o 0.5%)
- Ventana temporal configurable (default: ±30 min del mensaje de pago en WA, si se usa)
- Idempotencia en re-ingesta
- Logs estructurados con correlation ID
