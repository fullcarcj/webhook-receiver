# Prompt · Dashboard de Observación (Combinado Bandeja + Tablero)

**Destinatario:** Cursor frontend · `C:\Users\Javier\frontend` (Next.js 15 + TypeScript + SCSS)  
**Objetivo:** Crear una nueva página en `/observacion` que combine `/bandeja` y `/ventas/tablero` con el diseño **100% idéntico** al archivo `dashboard-observacion-48h (2).html`.

---

## 0 · Verificación previa (OBLIGATORIA antes de escribir código)

```
1. Confirmar que existen estos hooks en src/hooks/:
   - useSupervisorKPIs.ts      → fetch /api/ventas/supervisor/kpis
   - useSupervisorExceptions.ts → fetch /api/ventas/supervisor/exceptions
   - useInbox.ts                → fetch /api/bandeja (con filters)

2. Confirmar que existe src/app/api/ventas/supervisor/ con route handlers

3. Confirmar que NO existe todavía src/hooks/useAiResponderStats.ts
   (lo vamos a crear)

4. Confirmar que NO existe todavía src/app/api/ai-responder/stats/route.ts
   (lo vamos a crear)
```

---

## 1 · Nuevo hook: `useAiResponderStats`

**Archivo:** `src/hooks/useAiResponderStats.ts`

Patrón idéntico a `useSupervisorKPIs.ts`. Seguir exactamente el mismo estilo:
- `'use client'`
- `useCallback` + `useEffect` + `cancelledRef`
- `POLL_INTERVAL_MS = 30_000`
- fetch a `/api/ai-responder/stats`
- No lanzar error si la respuesta falla, solo setear `error`

**Shape de respuesta del backend** (`GET /api/ai-responder/stats`):
```ts
interface AiResponderStats {
  today_log_by_action: Array<{ action_taken: string; n: number }>;
  today_by_status: {
    ai_replied: number;
    needs_human_review: number;
    skipped: number;
    processing: number;
    pending: number;
  };
  pending_count: number;
  needs_review_count: number;
  force_send: boolean;
  human_review_gate: boolean;
}
```

**Interface a exportar:**
```ts
interface Result {
  stats: AiResponderStats | null;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}
export function useAiResponderStats(): Result { ... }
```

---

## 2 · Nuevo proxy API: `/api/ai-responder/stats`

**Archivo:** `src/app/api/ai-responder/stats/route.ts`

Patrón idéntico a los proxies existentes en `src/app/api/ventas/supervisor/`.  
Proxea `GET` a `${process.env.BACKEND_URL}/api/ai-responder/stats` con las mismas cabeceras de auth que usa el resto del BFF.

---

## 3 · Página nueva: `/observacion`

**Archivo:** `src/app/(features)/observacion/page.tsx`

```
'use client'
```

**Hooks que usa:**
```ts
import { useSupervisorKPIs }     from '@/hooks/useSupervisorKPIs';
import { useSupervisorExceptions } from '@/hooks/useSupervisorExceptions';
import { useInbox }              from '@/hooks/useInbox';
import { useAiResponderStats }   from '@/hooks/useAiResponderStats';
```

**Lógica de auto-refresh del contador visual (igual que el HTML):**
- Mostrar cuenta regresiva de 30s en el header (igual que `<span id="autoRefreshTimer">30s</span>`)
- Los hooks ya hacen polling cada 30s — el contador solo es visual con `setInterval` local de 1s

---

## 4 · SCSS: `src/app/(features)/observacion/observacion.scss`

**CRÍTICO: El SCSS debe replicar 100% el CSS del HTML. No inventar, no simplificar.**

### Variables exactas (copiar tal cual del HTML):
```scss
:root {
  --bg:       #0e0f0c;
  --panel:    #151611;
  --panel-2:  #1c1e18;
  --ink:      #efeadb;
  --ink-dim:  #a8a89a;
  --ink-mute: #6e6f64;
  --line:     #2a2c24;
  --accent:   #d4ff3a;
  --accent-2: #ff6a3d;
  --ok:       #7fd67f;
  --warn:     #ffb84d;
  --bad:      #ff5c5c;
  --bot:      #b98cff;
  --human:    #6ab6ff;
}
```

### Fuentes (ya cargadas globalmente en el HTML vía Google Fonts):
- **Títulos grandes:** `'Fraunces', serif` — font-weight 800, letter-spacing -0.02em
- **UI general:** `'Inter Tight', system-ui, sans-serif`
- **Código / labels / tablas:** `'JetBrains Mono', monospace`

Agregar en `src/app/global.scss` o en el `layout.tsx` de observacion si no están:
```html
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,600;0,800;1,400&family=Inter+Tight:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
```

### Background especial del body (igual que el HTML):
```scss
.obs-page {
  background-color: var(--bg);
  background-image:
    radial-gradient(1200px 600px at 10% -10%, rgba(212,255,58,.04), transparent 60%),
    radial-gradient(900px 500px at 110% 10%, rgba(255,106,61,.03), transparent 60%);
  min-height: 100vh;
  padding: 24px;
  color: var(--ink);
  font-family: 'Inter Tight', system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
}
```

### Container:
```scss
.obs-container { max-width: 1600px; margin: 0 auto; }
```

### Header:
```scss
.obs-header {
  max-width: 1600px; margin: 0 auto 24px;
  padding-bottom: 20px;
  border-bottom: 1px solid var(--line);
  display: flex; justify-content: space-between;
  align-items: flex-end; gap: 32px; flex-wrap: wrap;

  h1 {
    font-family: 'Fraunces', serif;
    font-weight: 800; font-size: 32px;
    margin: 0; letter-spacing: -0.02em;
    em { font-style: italic; color: var(--accent); font-weight: 400; }
  }
  .obs-sub {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px; letter-spacing: 0.15em;
    text-transform: uppercase; color: var(--ink-dim); margin-top: 4px;
  }
}
```

### Status bar:
```scss
.obs-status-bar {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px; color: var(--ink-mute);
  display: flex; align-items: center; gap: 10px;
  margin-bottom: 24px;
  .dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: var(--ok); box-shadow: 0 0 8px var(--ok);
  }
  &.error .dot { background: var(--bad); box-shadow: 0 0 8px var(--bad); }
  &.loading .dot { background: var(--warn); box-shadow: 0 0 8px var(--warn);
    animation: obs-pulse 1s infinite; }
}
@keyframes obs-pulse { 50% { opacity: 0.5; } }
```

### Sección genérica:
```scss
.obs-section {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 12px; padding: 20px; margin-bottom: 20px;
  h2 {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px; letter-spacing: 0.25em;
    text-transform: uppercase; color: var(--ink-mute);
    margin: 0 0 16px;
    display: flex; align-items: center;
    justify-content: space-between; gap: 12px;
    .tag { font-size: 9px; color: var(--ink-dim);
           font-weight: 400; letter-spacing: 0.1em; }
  }
}
```

### KPI grid (4 columnas):
```scss
.obs-kpis-grid {
  display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px;
  @media (max-width: 900px) { grid-template-columns: repeat(2, 1fr); }
}
.obs-kpi {
  background: var(--panel-2); border: 1px solid var(--line);
  border-radius: 8px; padding: 18px;
  .label {
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px; letter-spacing: 0.2em;
    text-transform: uppercase; color: var(--ink-mute);
    display: flex; align-items: center; gap: 8px;
    .dot { width: 8px; height: 8px; border-radius: 50%; }
  }
  .value {
    font-family: 'Fraunces', serif;
    font-size: 36px; font-weight: 800;
    margin: 8px 0 4px; line-height: 1; letter-spacing: -0.02em;
  }
  .sub {
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px; color: var(--ink-mute); letter-spacing: 0.05em;
  }
  &.bot   .value { color: var(--bot); }
  &.human .value { color: var(--human); }
  &.warn  .value { color: var(--accent-2); }
  &.ok    .value { color: var(--ok); }
}
```

### Ratio bars (2 columnas):
```scss
.obs-ratio-container {
  display: grid; grid-template-columns: 1fr 1fr; gap: 20px;
  @media (max-width: 900px) { grid-template-columns: 1fr; }
}
.obs-ratio-card {
  background: var(--panel-2); border: 1px solid var(--line);
  border-radius: 8px; padding: 18px;
  .big {
    font-family: 'Fraunces', serif;
    font-size: 48px; font-weight: 800;
    letter-spacing: -0.02em; line-height: 1;
  }
  .pct-bar {
    height: 8px; background: var(--panel);
    border-radius: 4px; overflow: hidden; margin: 12px 0 8px;
    .fill { height: 100%; background: var(--accent); transition: width 0.5s ease; }
  }
  .legend {
    font-family: 'JetBrains Mono', monospace; font-size: 10px;
    color: var(--ink-dim); display: flex; justify-content: space-between;
  }
}
```

### Actividad bot (2 columnas):
```scss
.obs-bot-activity {
  display: grid; grid-template-columns: 1fr 1fr; gap: 20px;
  @media (max-width: 900px) { grid-template-columns: 1fr; }
}
.obs-bot-list {
  list-style: none; padding: 0; margin: 0;
  li {
    display: flex; justify-content: space-between;
    align-items: center; padding: 10px 12px;
    border-bottom: 1px solid var(--line);
    &:last-child { border-bottom: none; }
  }
  .action-type {
    font-family: 'JetBrains Mono', monospace; font-size: 11px; color: var(--ink);
  }
  .count {
    font-family: 'JetBrains Mono', monospace; font-size: 14px;
    font-weight: 700; color: var(--accent);
  }
}
```

### Tabla chats:
```scss
.obs-table {
  width: 100%; border-collapse: collapse; font-size: 12px;
  th {
    font-family: 'JetBrains Mono', monospace; font-size: 9px;
    letter-spacing: 0.2em; text-transform: uppercase;
    color: var(--ink-mute); text-align: left;
    padding: 10px 12px; border-bottom: 1px solid var(--line); font-weight: 600;
  }
  td {
    padding: 10px 12px; border-bottom: 1px solid var(--line); font-size: 12px;
    &.mono { font-family: 'JetBrains Mono', monospace; font-size: 11px; }
  }
  tbody tr:hover { background: var(--panel-2); }
}
.obs-badge {
  display: inline-block; padding: 2px 8px; border-radius: 999px;
  font-family: 'JetBrains Mono', monospace; font-size: 9px;
  letter-spacing: 0.1em; text-transform: uppercase; font-weight: 600;
  &.ok   { background: rgba(127,214,127,0.15); color: var(--ok); }
  &.null { background: rgba(110,111,100,0.2);  color: var(--ink-mute); }
  &.ch1  { background: rgba(110,111,100,0.2);  color: var(--ink-dim); }
  &.ch2  { background: rgba(106,182,255,0.15); color: var(--human); }
  &.ch3  { background: rgba(255,241,89,0.15);  color: #fff159; }
  &.ch4  { background: rgba(106,182,255,0.15); color: var(--human); }
  &.ch5  { background: rgba(255,106,61,0.15);  color: var(--accent-2); }
}
```

### SQL helper block:
```scss
.obs-sql {
  background: #0a0b08; border: 1px solid var(--line);
  border-radius: 6px; padding: 12px; margin-top: 12px;
  font-family: 'JetBrains Mono', monospace; font-size: 10px;
  line-height: 1.6; color: var(--ink-dim);
  white-space: pre-wrap; position: relative;
  &::before {
    content: "SQL · correr en DBeaver";
    position: absolute; top: 8px; right: 12px;
    font-size: 8px; color: var(--ink-mute);
    letter-spacing: 0.15em; text-transform: uppercase;
  }
  .kw  { color: var(--accent); }
  .str { color: var(--ok); }
}
.obs-note {
  font-size: 11px; color: var(--ink-mute);
  font-style: italic; padding: 8px 0; line-height: 1.5;
}
.obs-empty {
  text-align: center; padding: 32px;
  color: var(--ink-mute); font-style: italic; font-size: 13px;
}
```

---

## 5 · Estructura JSX de la página

La página tiene exactamente estas 5 secciones en orden, igual que el HTML:

```
1. HEADER
   - Título: "Dashboard de <em>observación</em>"
   - Sub: "Solomotorx · Monitoreo 48h · Fix conversation_id"
   - Status bar con dot animado + "Auto-refresh: {countdown}s"

2. SECCIÓN: KPIs generales · producción hoy
   - 4 cards: Bot resolvió / Esperando comprador / Excepciones / Cerradas hoy
   - Datos: useSupervisorKPIs()
   - Tag derecho: timestamp de última actualización

3. SECCIÓN: Ratio conversation_id · desde el fix
   - 2 barras de ratio: Última hora / Últimas 24h
   - Datos: useInbox({ limit: 100 }) → computar en cliente igual que el HTML
   - Nota: "⚠️ Este ratio no viene de endpoint · se calcula desde /api/inbox"
   - Bloque SQL (estático, igual que el HTML):
     SELECT DATE(created_at) AS dia, channel_id,
            COUNT(*) AS total, COUNT(conversation_id) AS con_link,
            ROUND((COUNT(conversation_id)::numeric / COUNT(*)) * 100, 1) AS pct
     FROM sales_orders
     WHERE created_at > NOW() - INTERVAL '48 hours'
     GROUP BY DATE(created_at), channel_id ORDER BY dia DESC, channel_id;

4. SECCIÓN: Actividad del bot · últimas 24h
   - 2 columnas: "Top acciones registradas" / "Excepciones abiertas"
   - Top acciones: useAiResponderStats() → stats.today_log_by_action
     (cada item: { action_taken, n } → mostrar como lista)
   - Excepciones: useSupervisorExceptions() → lista con reason + severity
   - Sub-label de columna: "desde ai_response_log" / "desde tabla exceptions"

5. SECCIÓN: Últimos 15 chats · producción
   - Tabla con columnas: Chat ID / Cliente / Canal / Stage / Order ID / Updated
   - Datos: useInbox({ limit: 15 })
   - Canal badge: mapear source_type → ch1..ch5 según CHANNEL_NAMES del HTML:
     wa_inbound="WA+REDES"(ch2), ml_question="ML·Q"(ch3), ml_message="ML·M"(ch3)
     wa_ml_linked="WA+ML"(ch4), default=source_type(ch1)
   - Order ID: verde si existe, muted si es null
   - Updated: tiempo relativo (ahora / Xm / Xh / Xd)
```

---

## 6 · Bloque SQL estático al final (sección 6)

Sección sin fetch — solo HTML estático con los 4 bloques SQL del HTML original:

```
Q1 · Ratio exacto de populate (48h agrupado por día y canal)
Q2 · Actividad del bot últimas 48h (bot_actions)
Q3 · ai_reply_status en 48h (crm_messages inbound)
Q4 · Handoffs activos ahora (bot_handoffs WHERE ended_at IS NULL)
```

Mostrar con la clase `.obs-sql` y keywords en `.kw`, strings en `.str`.

---

## 7 · Lógica del ratio conversation_id (igual que el HTML)

```ts
// Desde los chats del useInbox({ limit: 100 })
const now = Date.now();
const oneHour = chats.filter(c => {
  const t = new Date(c.updated_at || c.last_message_at || '').getTime();
  return (now - t) < 3_600_000 && (c.order_id || c.order?.id);
});
const oneHourLinked = oneHour.filter(
  c => c.order?.conversation_id || c.conversation_id
).length;
// Repetir para 24h con < 86_400_000
```

---

## 8 · Lógica de tiempo relativo

```ts
function formatRelTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60)    return 'ahora';
  if (diff < 3600)  return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}
```

---

## 9 · CHANNEL_NAMES exactos del HTML

```ts
const CHANNEL_NAMES: Record<number, string> = {
  1: 'MOSTRADOR',
  2: 'WA+REDES',
  3: 'ML',
  4: 'ECO',
  5: 'F.VENTA',
};
```

Badge class: `ch${channelId}` o `null` si no hay canal.

---

## 10 · Footer

```html
<div style="text-align:center; padding:20px; color:var(--ink-mute);
            font-family:'JetBrains Mono',monospace; font-size:10px;
            letter-spacing:0.1em;">
  DASHBOARD DE OBSERVACIÓN · NO OPERATIVO · SE DESCARTA AL CONSTRUIR MÓDULO UNIFICADO
</div>
```

---

## 11 · Agregar ruta al menú

En `src/data/all_routes.ts` (o donde estén definidas las rutas):
```ts
observacion: '/observacion',
```

En `src/config/menuDefinition.js` (del backend, si aplica) o en el nav del frontend, agregar ítem temporal "Observación 48h" bajo el grupo de supervisión.

---

## Reglas de estilo estrictas

1. **NO usar variables de color del tema existente** (Bootstrap, Tailwind, etc.) — usar únicamente las variables `--bg`, `--panel`, `--accent`, etc. definidas en el SCSS de esta página.
2. **NO usar componentes UI del kit existente** (`<Card>`, `<Badge>`, etc.) — todo custom con las clases `.obs-*`.
3. La página es `page.tsx` con `'use client'` — no Server Component.
4. Los 3 hooks existentes no se modifican. Solo se crea `useAiResponderStats.ts`.
5. El `useInbox` se llama con `limit: 100` para el ratio y `limit: 15` para la tabla — **son dos instancias separadas del hook**.
6. Auto-refresh visual: `useEffect` con `setInterval(1000)` para el countdown de 30s, independiente del polling de los hooks.

---

## Entregables

1. `src/hooks/useAiResponderStats.ts`
2. `src/app/api/ai-responder/stats/route.ts`
3. `src/app/(features)/observacion/page.tsx`
4. `src/app/(features)/observacion/observacion.scss`
5. Actualizar `src/data/all_routes.ts` con `observacion: '/observacion'`

**Al terminar:** verificar que `npm run build` no tiene errores y que la página carga en `http://localhost:3000/observacion` con los 5 bloques visibles y el auto-refresh funcionando.
