# Recordatorio de calificación (Mercado Libre)

Este proyecto incluye el script `ml-rating-request-daily.js`, que envía mensajes post-venta pidiendo calificación cuando vos ya calificaste y el comprador aún no, dentro de una ventana de días y con **como máximo un mensaje por comprador por día (UTC)** por cuenta vendedora.

---

## Automático: todos los días a las 10:00 UTC

Si usás **GitHub** con este repositorio:

1. En el repo: **Settings → Secrets and variables → Actions → New repository secret**.
2. Creá el secret **`DATABASE_URL`** con la misma cadena de conexión PostgreSQL que usa tu app en producción (debe ser alcanzable desde internet; muchas BDs en la nube ya lo permiten).
3. Los tokens OAuth por cuenta deben estar **guardados en la base** (`ml_accounts`), como cuando corrés el servidor localmente: el job no usa `oauth-env.json` en GitHub.

El archivo **`.github/workflows/rating-request-daily.yml`** ejecuta:

- **Cron:** `0 10 * * *` → **10:00 UTC** cada día.
- Comando: `node ml-rating-request-daily.js --all` con `ML_RATING_REQUEST_ENABLED=1` y lookback **6** días (salvo que cambies el workflow).

**Zona horaria:** 10:00 UTC equivale a **07:00** en Argentina (ART, UTC−3). Si cambiás la hora, editá el cron en ese YAML (minuto hora * * *).

---

## Manual: activar cuando quieras

### Opción A — Tu PC o servidor (PowerShell, Windows)

Desde la carpeta del proyecto:

```powershell
cd c:\ruta\a\webhook-receiver
$env:ML_RATING_REQUEST_ENABLED="1"
$env:ML_RATING_REQUEST_LOOKBACK_DAYS="6"
node ml-rating-request-daily.js --all
```

Solo **una cuenta** ML:

```powershell
node ml-rating-request-daily.js --user=TU_ML_USER_ID
```

Con variables ya en **`oauth-env.json`** (copiá desde `oauth-env.json.example`), podés omitir las dos primeras líneas si ahí tenés `ML_RATING_REQUEST_ENABLED` y `ML_RATING_REQUEST_LOOKBACK_DAYS`.

**Ver plantillas de mensaje sin enviar nada:**

```powershell
npm run rating-request-print-message
```

### Opción B — GitHub Actions (sin consola)

1. **Actions** → workflow **“Recordatorio calificación ML”**.
2. **Run workflow** → **Run workflow** (usa los mismos secrets que el cron diario).

---

## Opción sin GitHub: cron en Linux o Programador de tareas en Windows

**Linux (crontab):** 10:00 UTC sería:

```cron
0 10 * * * cd /ruta/al/webhook-receiver && ML_RATING_REQUEST_ENABLED=1 /usr/bin/node ml-rating-request-daily.js --all >> /tmp/rating-request.log 2>&1
```

Ajustá la ruta a `node` y al proyecto. Si el servidor está en hora local Argentina y querés 10:00 UTC, el sistema debe usar zona correcta o calculá el minuto/hora equivalente.

**Windows:** Programador de tareas: acción “Iniciar programa” → `node`, argumentos `ml-rating-request-daily.js --all`, carpeta inicial = raíz del repo; en “Variables de entorno” o en `oauth-env.json` definí `DATABASE_URL` y `ML_RATING_REQUEST_ENABLED=1`.

---

## Variables útiles

| Variable | Descripción |
|----------|-------------|
| `ML_RATING_REQUEST_ENABLED` | Debe ser `1` para enviar. |
| `ML_RATING_REQUEST_LOOKBACK_DAYS` | Días hacia atrás desde `date_created` de la orden (por defecto 6 en el código). |
| `ML_RATING_REQUEST_ORDER_STATUS` o `--status=` | Opcional: filtrar por estado ML, ej. `confirmed`. |
| `ML_RATING_REQUEST_BODY` | Opcional: texto fijo; si no está, se elige al azar entre 10 plantillas. |

Los envíos quedan registrados en la tabla **`ml_rating_request_log`** y podés consultarlos en la ruta de administración que ya uses para recordatorios (según tu `server.js`).
