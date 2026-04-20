# ADR-003 · Proveedor de IA: GROQ, Claude o híbrido

- **Estado:** Propuesta
- **Fecha:** _(pendiente)_
- **Dueño:** Backend lead + Product Owner
- **Deadline de firma:** Día 4 de la Semana 0
- **Relacionados:** Sprint 4 (cotización automática NLU), ADR-001 (donde se guardan las cotizaciones auto-generadas)

---

## Contexto

El repo `webhook-receiver` ya tiene infraestructura de IA en producción:

- `callChatBasic` · wrapper sobre GROQ para respuestas conversacionales
- AI Responder · servicio que genera respuestas automáticas vía GROQ
- _(completar: modelos GROQ, costos mensuales actuales, volumen de llamadas)_

El plan v1 asumía Claude (Anthropic API) para el NLU del Sprint 4. Eso añadiría otra facturación, SDK, configuración y operación.

La pregunta es: **¿qué proveedor(es) de IA usa el sistema para qué capa del flujo?**

Capas típicas en el módulo de ventas:

1. Clasificación de intención del mensaje entrante
2. Extracción de entidades (vehículo, pieza, cantidad)
3. Generación de respuestas conversacionales (ya existe con GROQ)
4. Resolución de ambigüedades
5. Cotizaciones enriquecidas (complementarios, bundling)

## Opciones

### Opción A · GROQ para todo

Extender el uso actual. El NLU del Sprint 4 usa los modelos GROQ disponibles.

**Pros:** sin nuevo proveedor; equipo ya opera GROQ; latencia y costo usualmente favorables.

**Contras:** medir accuracy en structured output; límites en casos muy ambiguos.

### Opción B · GROQ barato + Claude para casos complejos

Pipeline híbrido: GROQ primero; si confidence baja, escalado a Claude.

**Pros:** costo/accuracy balanceados. **Contras:** dos proveedores, dos facturas, lógica de fallback.

### Opción C · Claude para todo, deprecar GROQ

**Pros:** un solo proveedor nuevo. **Contras:** costo, latencia, migrar código que hoy funciona con GROQ.

## Criterio de decisión · eval set obligatorio

Antes de firmar, construir un **eval set de 50 mensajes reales** representativos del inbox (consultas claras, ambiguas, saludos, quejas, ruido).

Medir en cada opción:

| Métrica | Opción A (GROQ) | Opción B (híbrido) | Opción C (Claude) |
|---------|-----------------|---------------------|-------------------|
| Accuracy clasificación | ? | ? | ? |
| Accuracy extracción entidades | ? | ? | ? |
| Latencia p50 | ? | ? | ? |
| Latencia p95 | ? | ? | ? |
| Costo estimado mensual* | ? | ? | ? |

*Ajustar volumen (ej. mensajes/día) a la realidad del negocio.

## Decisión

_(Pendiente de firma. Recomendación inicial: **Opción A** si GROQ supera umbrales acordados en el eval set; si no, valorar **Opción B**. **Opción C** solo con justificación de negocio fuerte.)_

## Consecuencias

_(Completar una vez firmada)_

- Si **Opción A**: Sprint 4 usa GROQ; p. ej. `nluService` reutiliza patrones de `callChatBasic`.
- Si **Opción B**: añadir SDK Anthropic como dependencia secundaria y wrapper por confidence.
- Si **Opción C**: plan de migración GROQ → Claude; **no cabe** en el plan actual (**6 sprints / 12 semanas**) sin recortar otro alcance.

## Política de observabilidad

Desde el día 1 del Sprint 4: tokens por día y por capa, costo estimado, latencia, tasa de errores. Alerta si el costo diario supera el 150% del promedio móvil de 7 días.

## Criterios de éxito del Sprint 4 (dependen de este ADR)

- Accuracy de clasificación y extracción medidos sobre el eval set (objetivos numéricos a fijar tras baseline)
- Latencia p95 acordada con UX (ej. ≤ 3 s para respuesta percibida)
- Tope de costo mensual _(definir)_

## Notas al implementar

- Timeout duro y fallback a revisión humana si el proveedor falla
- Minimizar PII en prompts
- Cache corta para mensajes idénticos si aplica
- Revisar términos de uso del proveedor respecto a datos de clientes
