# Catálogo de códigos de excepción — Solomotor3k ERP

Tabla `exceptions`, campo `reason TEXT`. Sin CHECK constraint en BD: los valores
canónicos viven aquí y en `src/services/supervisorService.js` (KIND_MAPPING).

---

## Códigos

| Código | Significado | Origen típico | Severidad típica | Acción esperada |
|--------|-------------|---------------|-----------------|-----------------|
| `payment_no_match` | Comprobante de pago recibido sin match automático en extracto bancario | Motor de conciliación / AI Responder al detectar comprobante sin orden | medium | Vendedor asocia manualmente → caja aprueba (ADR-006) |
| `stock_zero_no_supplier` | Cotización aprobada pero el SKU no tiene stock y no hay proveedor activo | Sistema de inventario al confirmar orden | high | Admin asigna proveedor o cancela la línea |
| `unhappy_customer` | Calificación < 3 estrellas o queja explícita detectada en el chat | AI Responder al clasificar mensaje de queja | high | Vendedor senior interviene manualmente |
| `ambiguity_unresolved` | El bot no pudo extraer vehículo o pieza después de 2 intentos | AI Responder (NLU con baja confianza) | low | Cualquier vendedor clarifica con el cliente |
| `high_amount_policy` | Cotización supera el umbral de aprobación automática | Motor de cotización | medium | Vendedor o supervisor aprueba manualmente |
| `product_not_found` | El bot no encontró un producto compatible para el vehículo/pieza solicitado | AI Responder al fallar búsqueda en catálogo | low | Cualquier vendedor busca alternativa manual |
| `manual_review_required` | El bot marcó la situación como revisión humana sin clasificar en otro código | Fallback de AI Responder | medium | Vendedor revisa contexto y resuelve o re-clasifica |

---

## Tipos de entidad (`entity_type`)

| Valor | Contexto |
|-------|----------|
| `chat` | Excepción ligada a un hilo de conversación |
| `order` | Excepción ligada a una orden de venta |
| `payment` | Excepción ligada a un intento de pago o comprobante |
| `quote` | Excepción ligada a una cotización |
| `product_match` | Excepción de matching de producto/pieza |

---

## Estados de ciclo de vida (`status`)

| Estado | Significado |
|--------|-------------|
| `open` | Excepción activa, sin atender |
| `in_progress` | Un agente la está gestionando |
| `resolved` | Resuelta con nota de resolución |
| `ignored` | Descartada (falso positivo o fuera de scope) |

---

## Severidades (`severity`)

| Nivel | Criterio operativo |
|-------|--------------------|
| `low` | Puede esperar horas sin impacto directo en el cliente |
| `medium` | Atender en el turno actual |
| `high` | Impacta al cliente o hay dinero en juego; atender < 1h |
| `critical` | Bloquea despacho o pago confirmado; atender de inmediato |

---

## Uso en código

```javascript
const { raise } = require("./exceptionsService");

// Registrar desde el bot o cualquier servicio
await raise({
  entityType: "order",
  entityId:   orderId,
  reason:     "payment_no_match",
  severity:   "medium",
  context:    { amount_received_bs: 100, amount_expected_bs: 191, reference: "REF123" },
  chatId:     chatId,
});
```

```
# Resolver desde la UI del vendedor
PATCH /api/sales/exceptions/:id/resolve
Body: { "resolution_note": "Match manual confirmado por caja" }
```

---

## Relación con ADR-006 y ADR-009

- `payment_no_match` → workflow de aprobación de dos pasos (vendedor propone, caja aprueba) definido en ADR-006.
- Todas las excepciones se reflejan en el tablero supervisor vía `GET /api/sales/supervisor/exceptions` (adoptado en ADR-009) y en el contador `exceptions` de `GET /api/inbox/counts`.
