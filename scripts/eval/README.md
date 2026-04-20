# Eval NLU v2 (ADR-003)

## Qué es

Dataset JSON (50 casos) + script que llama a **GROQ** con vocabulario **canónico en español** (`consulta_producto`, `pago_informado`, …) y mide:

- Accuracy de **intent**, **vehicle**, **parts** (categorías) y **banda de confidence** (`alta` / `media` / `baja`)
- Tasa de **JSON inválido** vs **validación de schema**
- Latencias p50 / p95 / p99
- Por **bucket** y por **difficulty** (easy / medium / hard)
- **Historial** en `out/history.ndjson` (append) + snapshot por timestamp + `nlu-eval-last.json`

## Archivos

| Archivo | Descripción |
|---------|-------------|
| `nlu-eval-set.template.json` | 50 casos sintéticos (realismo VE). Regenerar: `npm run eval:nlu:gen-template` |
| `generate-nlu-eval-template.js` | Generador del template (editar aquí y volver a correr) |
| `../eval-nlu-groq.js` | Script principal |
| `out/` | Salidas generadas (en `.gitignore`) |

Copia local con datos sensibles: `cp nlu-eval-set.template.json nlu-eval-set.json` y usa `--dataset=...` (el archivo local puede ignorarse en git).

## Requisitos

- `DATABASE_URL`, `GROQ_API_KEY` (carga vía `load-env-local` / `oauth-env.json`)
- Opcional `--model=llama-3.3-70b-versatile`: usa `legacyGroqChat` directo; si la API reporta uso, el costo usa tokens reales

## Comandos

```bash
npm run eval:nlu:gen-template   # regenerar template desde el generador
npm run eval:nlu:smoke          # 5 casos
npm run eval:nlu                # eval completo
npm run eval:nlu:noisy          # solo bucket product_noisy
npm run eval:nlu:hard           # solo difficulty hard
npm run eval:nlu:stability      # 3 pasadas completas (variación entre corridas)
node scripts/eval-nlu-groq.js --dry-run
node scripts/eval-nlu-groq.js --bucket=payment_info --limit=10 --verbose
```

## Interpretación

- **`intent_accuracy`**: solo casos con `expected.intent` en el JSON.
- **`vehicle_accuracy`**: solo cuando el gold trae `vehicle` no nulo.
- **`parts_accuracy`**: solo cuando `expected.parts` tiene al menos un ítem; compara **conjunto de categorías** (orden irrelevante).
- **`confidence_band_accuracy`**: si la `confidence` del modelo cae en la banda esperada (`alta` ≥0.85, `media` 0.6–0.85, `baja` <0.6).
- **`json_fail_rate`**: respuesta no parseable a JSON.
- **`validation_fail_rate`**: JSON parseable pero incumple schema (intent inválido, `parts` no array, etc.).
- **Costo estimado**: `$0.05/1M` tokens entrada + `$0.08/1M` salida (ajustar según facturación real de Groq). Si el camino por defecto no reporta tokens en la API, el script aproxima **entrada ≈ (len(system)+len(user))/4** y **salida ≈ len(respuesta)/4** (~4 caracteres por token en español) para no dejar `total_cost_usd_estimated` en 0; ver `token_cost_basis` y `meta.token_cost_note` en el JSON de salida. Para ADR con mediciones más cercanas al facturado, usar `--model=…` cuando `legacyGroqChat` devuelva uso de API.

## Resultados para ADR-003

Pegar métricas en `docs/adr/ADR-003-proveedor-ia.md` (sección Resultados) usando la tabla del plan o los valores de `nlu-eval-last.json`.

## Mantenimiento

Con mensajes reales anonimizados: sustituir el contenido de un `nlu-eval-set.json` local y:

`node scripts/eval-nlu-groq.js --dataset=scripts/eval/nlu-eval-set.json`
