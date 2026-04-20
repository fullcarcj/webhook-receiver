# Índice · Prompts de Sprints 1-6

**Módulo Unificado de Ventas Omnicanal — `webhook-receiver` + frontend Next.js**

---

## Filosofía del proyecto

1. **La venta nunca espera por el vendedor.** El sistema espera al comprador.
2. **Solo el comprador cancela.** El sistema acompaña.
3. **El vendedor es supervisor de excepciones.**
4. **El bot actúa, el supervisor corrige después.** El sistema aprende de las correcciones.
5. **Clientes saben que están en desarrollo.** Tolerancia explícita a errores, comunicación transparente.

**Decisiones de supervisión (resumen):** el bot envía siempre (rápido, optimista); el supervisor corrige después. Supervisión activa casi en tiempo real — sin gates de aprobación previa ni muestreo estadístico. Las correcciones son aprendizaje y trazabilidad, no control previo.

---

## Tabla de sprints

| Sprint | Prompt | Foco | Estado |
|--------|--------|------|--------|
| 1 | `prompt-sprint-1.md` | Cimientos: schema + handoff básico | Listo para ejecutar |
| 2 | `prompt-sprint-2.md` | Bandeja pulida + capa de supervisión | Listo para ejecutar |
| 3 | `prompt-sprint-3.md` | Kanban de pipeline + correcciones supervisor | Listo para ejecutar |
| 4 | `prompt-sprint-4.md` | Motor NLU + cotización automática + supervisor UI | Listo con 1 placeholder (ADR-003) |
| 5 | `prompt-sprint-5.md` | Conciliación bancaria adaptadores + supervisor caja | Listo con 1 placeholder (ADR-002) |
| 6 | `prompt-sprint-6.md` | Ficha 360° + dashboard supervisor + hardening | Listo para ejecutar |

---

## Arquitectura de supervisión (hilo transversal)

Desde Sprint 2 hasta Sprint 6, cada sprint suma piezas al **supervisor activo**:

- **Sprint 2** · Registro de cada acción del bot (tabla `bot_actions` con contexto completo) + vista cruda "todo lo que hizo el bot hoy"
- **Sprint 3** · Correcciones estructuradas (tabla `bot_corrections`) + botón "marcar como incorrecta" en cada mensaje/acción
- **Sprint 4** · Supervisor ve clasificación NLU + puede corregir intent/entities, alimentando dataset de re-eval
- **Sprint 5** · Supervisor ve matches bancarios automáticos + puede desarmar/reasignar
- **Sprint 6** · Dashboard unificado del supervisor con métricas de calidad, tendencias de corrección, alertas

**La regla:** ninguna acción del bot es opaca. Todo queda registrado con contexto suficiente para que el supervisor entienda por qué lo hizo y pueda corregirlo.

---

## Orden de ejecución

**Camino crítico secuencial** (un sprint tras otro sin pausa):

1. Sprint 1 (semanas 1-2): migraciones base + handoff
2. Sprint 2 (semanas 3-4): bandeja supervisable
3. Sprint 3 (semanas 5-6): Kanban con correcciones
4. Sprint 4 (semanas 7-8): IA + cotización automática
5. Sprint 5 (semanas 9-10): conciliación bancaria
6. Sprint 6 (semanas 11-12): ficha 360° + dashboard supervisor

**ADRs pendientes durante la ejecución:**

- **ADR-003** (proveedor IA) debe firmarse antes del día 3 del Sprint 4. El prompt de Sprint 4 tiene placeholders explícitos para la decisión.
- **ADR-002** (conciliación bancaria) debe firmarse antes del día 3 del Sprint 5. El prompt tiene placeholders para el adaptador concreto.

**No bloquean el arranque.** Se firman cuando lleguen esos sprints.

---

## Reglas operativas para Cursor durante los 12 sprints

1. **Los ADRs son autoridad.** Si el código contradice un ADR, actualizar el ADR antes de escribir código.
2. **Nunca inventar nombres de tabla o columna.** Los nombres reales están en `docs/SCHEMA_ACTUAL.md` y en los prompts.
3. **Migraciones aditivas con `IF NOT EXISTS`.** Reversibles.
4. **Commits por ticket, no por sprint.** Cada commit nombra el ticket (ej: `feat(sales): BE-3.2 endpoint pipeline`).
5. **Si aparece sorpresa, parar y preguntar.** Nunca improvisar sobre estructura existente.
6. **Frontend en repo separado.** Tickets `FE-*` van al repo Next.js, no a `webhook-receiver`.
7. **El supervisor es ciudadano de primera clase.** Ninguna funcionalidad nueva se implementa sin pensar "¿cómo lo ve y corrige el supervisor?".

---

## Documentos de soporte

- `docs/adr/` · decisiones arquitectónicas firmadas
- `docs/plan-sprints-v2-ventas-omnicanal.md` · visión de alto nivel
- `docs/SCHEMA_ACTUAL.md` · estructura real de la DB (mantener actualizado)
- `docs/prompts/prompt-sprint-N.md` · instrucciones detalladas por sprint
