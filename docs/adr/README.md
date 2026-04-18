# Architecture Decision Records (ADR)

Documentos de decisión para el módulo de ventas omnicanal. Firmar en **Sprint 0** antes de migraciones grandes.

| ADR | Tema | Estado |
|-----|------|--------|
| [ADR-001-cotizaciones.md](./ADR-001-cotizaciones.md) | Cotizaciones: **Opción A** (`inventario_presupuesto`). Auditoría: [ADR-001-auditoria-estructural-2026-04-18.md](./ADR-001-auditoria-estructural-2026-04-18.md) | Aceptado · 2026-04-18 |
| [ADR-002-conciliacion-bancaria.md](./ADR-002-conciliacion-bancaria.md) | Ingesta bancaria (CSV/Playwright) vs webhooks | Propuesta |
| [ADR-003-proveedor-ia.md](./ADR-003-proveedor-ia.md) | GROQ vs híbrido vs Claude | Propuesta · datos parciales |
| [ADR-004-naming-api.md](./ADR-004-naming-api.md) | Naming API: `/api/sales` vs `/api/ventas` | Aceptado · 2026-04-18 · Backend inglés, UI español |
| [ADR-005-catalogo-products-canonico.md](./ADR-005-catalogo-products-canonico.md) | Catálogo canónico `products` vs legacy (`productos`, `inventario_producto`) y FKs | Aceptado · 2026-04-18 · `products` canónico |
| [ADR-006-segregacion-aprobacion-pagos.md](./ADR-006-segregacion-aprobacion-pagos.md) | Segregación vendedor/caja: auto-aprobación solo alta confianza; manual → `payment_match_proposals` | Aceptado · 2026-04-18 |

Plan de ejecución: [plan-sprints-v2-ventas-omnicanal.md](../plan-sprints-v2-ventas-omnicanal.md).

Otros:

- **Índice prompts Sprints 1-6** (supervisión, gates ADR-002/003, reglas Cursor): [../prompts/README.md](../prompts/README.md)
- Sprint 1 (ejecutable): [../prompts/prompt-sprint-1.md](../prompts/prompt-sprint-1.md) · Sprints 2-6: mismos nombres `prompt-sprint-N.md` en esa carpeta
- Prompt Cursor Sprint 1 (legacy / condicional ADR): [../prompts/cursor-sprint-1-backend.md](../prompts/cursor-sprint-1-backend.md)
- Eval NLU (ADR-003): [../../scripts/eval/README.md](../../scripts/eval/README.md)
