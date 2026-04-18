# Amendment breve a ADR-007 · Moneda canónica del motor

**Fecha:** 2026-04-19  
**Tipo:** Ajuste por ADR-008 firmado  
**Estado:** Aceptado

Este amendment se incorpora al final de `ADR-007-politica-omnicanal-pagos.md` y se mantiene aquí como referencia rápida.

---

## Adición a ADR-007

### Regla 10 · Moneda canónica del motor es `total_amount_bs` (por ADR-008)

Tras firma de ADR-008, se aclara que el motor de conciliación compara **`sales_orders.total_amount_bs`** contra `bank_statements.amount`, no `order_total_amount`.

La consulta canónica actualizada del motor:

```sql
WHERE so.payment_status = 'pending'
  AND so.channel_id IN (2, 5)
  AND so.total_amount_bs IS NOT NULL
  AND so.total_amount_bs > 0
```

Esto **no cambia** las reglas 1-9 originales de ADR-007 (whitelist de canales, métodos conciliables, split payment, etc.). Solo precisa **contra qué columna se hace el matching**.

### Impacto en regla 5 (split payment)

El split payment Bs + divisa se resuelve contra `total_amount_bs`:

- Pagos VES matchean directo contra `total_amount_bs`
- Pagos USD/EUR se convierten con `exchange_rate_bs_per_usd` (tasa congelada de la orden)
- Suma de pagos convertidos debe ≥ `total_amount_bs` ± tolerancia para cerrar la orden

### Impacto en regla 3 (métodos conciliables)

Sin cambios en qué métodos son conciliables automáticamente. Solo precisar que la comparación numérica usa `total_amount_bs`.

### Referencia

Ver `ADR-008-moneda-canonica-matching.md` para justificación técnica, backfill y tickets Sprint 5 (principalmente BE-5.0).
