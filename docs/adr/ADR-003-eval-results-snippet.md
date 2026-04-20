# Resultados del eval NLU · [FECHA]

**Configuración:** GROQ · modelo _ · 50 casos · N corridas

## Métricas globales

| Métrica | Meta | Resultado | ¿Pasa? |
|---------|------|-----------|--------|
| Accuracy de intent global | ≥ 80% | _% | |
| Accuracy extracción vehicle | ≥ 75% | _% | |
| Accuracy extracción parts (categorías) | ≥ 70% | _% | |
| Accuracy banda de confidence | ≥ 70% | _% | |
| Tasa JSON inválido | ≤ 1% | _% | |
| Tasa validation_fail | ≤ 3% | _% | |
| Latencia p50 | ≤ 1.5 s | _ s | |
| Latencia p95 | ≤ 3 s | _ s | |
| Desviación entre corridas (intent acc) | ≤ 3 pp | _ pp | |
| Costo por 1000 mensajes (estimado) | ≤ $_ | $_ | |

## Por bucket

| Bucket | N | Intent acc | Vehicle acc | Parts acc | Band acc |
|--------|---|------------|-------------|-----------|----------|
| product_clear | 12 | _% | _% | _% | _% |
| product_ambiguous | 10 | _% | _% | _% | _% |
| product_noisy | 6 | _% | _% | _% | _% |
| payment_info | 4 | _% | — | — | _% |
| order_followup | 3 | _% | — | — | _% |
| greeting | 4 | _% | — | — | _% |
| complaint | 4 | _% | — | — | _% |
| handoff_request | 3 | _% | — | — | _% |
| noise | 4 | _% | — | — | _% |

## Decisión ADR-003

Opción elegida: _ (A GROQ solo / B híbrido / C Claude)

Justificación breve:

---

*Rellenar tras `npm run eval:nlu` usando `scripts/eval/out/nlu-eval-last.json`.*
