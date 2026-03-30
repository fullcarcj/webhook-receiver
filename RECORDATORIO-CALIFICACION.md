# Recordatorio de calificación (Mercado Libre)

Este proyecto incluye el script `ml-rating-request-daily.js`, que envía mensajes post-venta pidiendo calificación cuando vos ya calificaste y el comprador aún no, dentro de una ventana de días y con **como máximo un mensaje por comprador por día (UTC)** por cuenta vendedora.

### Sincronizar “nuestro” feedback (venta → comprador) en la base

El job usa `ml_orders.feedback_sale` y/o `ml_order_feedback` (lado `sale`). Para **rellenar esos datos desde Mercado Libre** en todas las órdenes **confirmed** de todas las cuentas:

```bash
npm run sync-order-feedback-confirmed
```

Equivale a `node ml-order-feedback-sync.js --all --status=confirmed`. Ese script hace GET `/orders/{id}/feedback`, actualiza `ml_order_feedback` y las columnas **`feedback_sale`** / **`feedback_purchase`** en **`ml_orders`**. Corré también `npm run sync-orders-all` si las órdenes no están en la BD.

---

## Automático: todos los días a las **8:30** (America/Caracas) = **12:30 UTC**

Si usás **GitHub** con este repositorio:

**Importante:** el cron programado (`schedule`) solo corre en la **rama por defecto** del repo (suele ser `main`). Si el workflow está solo en otra rama, fusionalo a la default o cambiá la rama por defecto en **Settings → General**. La ejecución manual (**Run workflow**) sí puede lanzarse desde la rama que elijas.

1. En el repo: **Settings → Secrets and variables → Actions → New repository secret**.
2. Creá el secret **`DATABASE_URL`** con la misma cadena de conexión PostgreSQL que usa tu app en producción (debe ser alcanzable desde internet; muchas BDs en la nube ya lo permiten).
3. Los tokens OAuth por cuenta deben estar **guardados en la base** (`ml_accounts`), como cuando corrés el servidor localmente: el job no usa `oauth-env.json` en GitHub.

El archivo **`.github/workflows/rating-request-daily.yml`** ejecuta:

- **Cron:** `30 12 * * *` → **12:30 UTC** cada día = **8:30** en Caracas (America/Caracas, UTC−4).
- Comando: `node ml-rating-request-daily.js --all` con `ML_RATING_REQUEST_ENABLED=1` y lookback **6** días (salvo que cambies el workflow).

Si cambiás la hora local, calculá el equivalente en UTC y editá el cron en ese YAML (`minuto hora * * *`).

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

**Linux (crontab):** misma hora que GitHub (12:30 UTC = 8:30 Caracas):

```cron
30 12 * * * cd /ruta/al/webhook-receiver && ML_RATING_REQUEST_ENABLED=1 /usr/bin/node ml-rating-request-daily.js --all >> /tmp/rating-request.log 2>&1
```

Ajustá la ruta a `node` y al proyecto. Si el servidor usa otra zona, recalculá UTC o programá la tarea en hora local.

**Windows:** Programador de tareas: acción “Iniciar programa” → `node`, argumentos `ml-rating-request-daily.js --all`, carpeta inicial = raíz del repo; en “Variables de entorno” o en `oauth-env.json` definí `DATABASE_URL` y `ML_RATING_REQUEST_ENABLED=1`.

---

## Variables útiles

| Variable | Descripción |
|----------|-------------|
| `ML_RATING_REQUEST_ENABLED` | Debe ser `1` para enviar. |
| `ML_RATING_REQUEST_LOOKBACK_DAYS` | Días hacia atrás desde `date_created` de la orden (por defecto 6 en el código). |
| `ML_RATING_REQUEST_ORDER_STATUS` o `--status=` | Opcional: filtrar por estado ML, ej. `confirmed`. |
| `ML_RATING_REQUEST_BODY` | Opcional: texto fijo; si no está, se elige al azar entre 10 plantillas. |

Los envíos quedan registrados en la tabla **`ml_rating_request_log`**.

---

## Dónde ver los envíos en el navegador

La vista **solo existe en el servidor HTTP** de este proyecto (`server.js`), no en el job por consola.

1. Definí **`ADMIN_SECRET`** en el entorno o en `oauth-env.json` (ver `oauth-env.json.example`). Sin eso la ruta responde **503**.
2. Levantá el servidor: `npm start` (o tu proceso en Render, etc.).
3. Abrí en el navegador (reemplazá host, puerto y clave):

   - `http://localhost:PUERTO/recordatorios-calificacion?k=TU_ADMIN_SECRET`
   - Atajo: `http://localhost:PUERTO/recordatorios?k=TU_ADMIN_SECRET`

4. **401** = la clave en `?k=` no coincide con `ADMIN_SECRET`. **503** = falta definir `ADMIN_SECRET`.

**JSON** (útil para scripts): añadí `&format=json` a la misma URL.

En la raíz del servicio, **`GET /`** (JSON) incluye la clave `como_ver_recordatorios_calificacion` con estos pasos resumidos.
