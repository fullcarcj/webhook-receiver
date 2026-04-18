# Prompt · Módulo Unificado de Ventas — ruta `/workspace`

**Destinatario:** Cursor frontend · `C:\Users\Javier\frontend` (Next.js 15 · TypeScript · SCSS)
**Fuente de verdad visual:** archivo `solomotorx-modulo-ventas (2).html` (adjuntado por el usuario).
**Objetivo:** Página `/workspace` con diseño **100 % idéntico al mockup**, **responsive real**, **reusando el Sidebar del ERP** (reteñido con la paleta del mockup).

---

## 0 · Decisiones cerradas por el usuario (no renegociar)

| # | Decisión | Aplicación |
|---|----------|------------|
| 1 | **Ruta definitiva:** `/workspace` | Nueva entrada en `all_routes.tsx` como `workspace: '/workspace'` |
| 2 | **Móvil:** responsive real, mismo URL | No crear rutas `/m/…`; la vista móvil del mockup es la referencia a la que debe colapsar el workspace cuando el viewport se angosta |
| 3 | **Diseño:** 100 % idéntico al HTML | Copiar literal variables CSS, fuentes, animaciones, radios, sombras, textos demo |
| 4 | **Sidebar:** **reemplazar la columna `.nav` del mockup por `<Sidebar />` del ERP**, pero retintado con la paleta del mockup (tokens `--bg/--panel/--ink/--accent/--line`) | Ver sección 4 de este prompt |
| 5 | **Modal "Solicitar despacho":** dejar datos demo del HTML (motorizado Daniel, etc.) | No cablear hoy; se conecta después |
| 6 | **Modal "Calificación":** dejar datos demo del HTML (estrellas, quote, tags) | No cablear hoy; se conecta después |

**Todo lo demás** (Inbox, Conversación, Ficha 360°, Cotización, Conciliar pago, Producto/Inventario) debe quedar **preparado para Fase B** (cableado con endpoints reales), pero la entrega de hoy es **Fase A: UI estática pixel-perfect**.

---

## 1 · Fases

### Fase A · UI pixel-perfect con datos mock (entrega de hoy)

- Página completa, todos los bloques del HTML visibles con textos demo idénticos.
- Sidebar del ERP retintado (sección 4).
- Responsive: `<1400 px` el workspace colapsa a una columna; los dos móviles del mockup se siguen mostrando apilados debajo.
- Sin llamadas HTTP. Sin hooks de datos.

### Fase B · cableado real (posterior, no hoy)

- Hooks `useInbox`, `useChatMessages`, `useChatContext`, etc. — endpoints listados en sección 8.
- No cambiar clases CSS ni layout al cablear.

---

## 2 · Tokens de diseño — copiar literal del mockup

```css
:root{
  --bg:#0e0f0c;
  --panel:#151611;
  --panel-2:#1c1e18;
  --ink:#efeadb;
  --ink-dim:#a8a89a;
  --ink-mute:#6e6f64;
  --line:#2a2c24;
  --accent:#d4ff3a;
  --accent-2:#ff6a3d;
  --ok:#7fd67f;
  --warn:#ffb84d;
  --bad:#ff5c5c;
  --blue:#6ab6ff;
  --violet:#b98cff;
  --ml:#fff159;
  --wa:#25d366;
  --eco:#6ab6ff;
  --fv:#ff6a3d;
}
```

**Fuentes** (copiar el `<link>` del HTML tal cual):

- Fraunces 9..144 · 400 / 600 / 800 / 900
- Inter Tight · 400 / 500 / 600 / 700
- JetBrains Mono · 400 / 500 / 700

**Fondo del body** (los dos `radial-gradient` del mockup):

```css
body.workspace-page{
  background:
    radial-gradient(1200px 600px at 0% 0%, rgba(212,255,58,.06), transparent 60%),
    radial-gradient(900px 500px at 100% 0%, rgba(255,106,61,.05), transparent 60%),
    var(--bg);
  color: var(--ink);
  min-height: 100vh;
  padding: 28px 24px 60px;
}
```

> La clase `.workspace-page` la aplica el `page.tsx` vía `document.body.classList.add('workspace-page')` en un `useEffect` (cleanup al desmontar). No tocar `global.scss`.

---

## 3 · Estructura del DOM (orden fijo)

```
<main class="ws-root">
 ├── .topbar            (brand + h1 con <em> + meta usuario)
 ├── .pipeline          (7 .step con .step-arrow entre ellos)
 ├── .workspace         (grid: 1fr 420px → 1 col en <1400px)
 │    ├── .webapp       (chrome + .webapp-body)
 │    │    ├── .webapp-chrome   (3 dots + url + device-label)
 │    │    └── .webapp-body     grid: [SIDEBAR-ERP] 380px 1fr 360px
 │    │         ├── [slot sidebar ERP retintado]     ← NUEVO (sección 4)
 │    │         ├── .inbox      (header + tabs + search + .conv-list)
 │    │         ├── .convo      (.convo-header + .pipeline-mini + .msgs + .composer)
 │    │         └── .ficha      (.ficha-section × 5: Cliente, Estado, Productos, Banco, Acciones)
 │    └── .mobile-wrap  (.phone + .phone.phone2 + leyenda “MÓVIL · iPhone · 390px”)
 ├── .modals-rack       (h2 + .modals-grid con 6 .modal)
 └── .footer-note       (3 spans)
</main>
```

Textos demo, emojis, nombres de clientes, montos, tags, estados: **copiar del HTML verbatim**.

---

## 4 · Sidebar del ERP dentro del mockup (clave de la integración)

### 4.1 Qué hacer

- **NO** replicar la columna `.nav` del mockup (con las secciones "Módulos / Canales / Por estado").
- En su lugar, renderizar el componente existente `@/core/common/sidebar/sidebar` (el que ya monta `src/app/(features)/layout.tsx` en toda la app ERP).
- El `(features)/layout.tsx` ya incluye `<Header />`, `<Sidebar />`, `<HorizontalSidebar />`, `<TwoColumnSidebar />`, `<ThemeSettings />`. La ruta `/workspace` cuelga de ese layout, así que el sidebar aparece automáticamente. **No duplicar.**
- Lo que **sí** hay que hacer es **retintar** ese sidebar cuando el body tiene la clase `.workspace-page`, usando la paleta del mockup. Alcance limitado al scope del workspace — no afecta el resto del ERP.

### 4.2 SCSS scoped de retintado

En `workspace.scss` añadir un bloque con selectores hacia las clases conocidas del sidebar ERP (`.sidebar`, `.sidebar-menu`, `.logo`, `.active`, etc.). Ejemplo base — el implementador ajusta selectores exactos tras inspeccionar el DOM del `<Sidebar />`:

```scss
body.workspace-page {
  // Retintado del sidebar del ERP con paleta del mockup.
  // Alcance: SOLO dentro de /workspace. En el resto del ERP el sidebar
  // conserva sus tokens originales.

  .sidebar,
  .sidebar .sidebar-menu,
  .sidebar .sidebar-logo {
    background: var(--panel) !important;
    border-right: 1px solid var(--line) !important;
    color: var(--ink-dim) !important;
  }

  .sidebar a,
  .sidebar .menu-title,
  .sidebar .submenu a {
    color: var(--ink-dim) !important;
  }

  .sidebar a:hover,
  .sidebar .active > a,
  .sidebar li.active > a {
    color: var(--ink) !important;
    background: var(--panel-2) !important;
  }

  .sidebar .active > a::before,
  .sidebar li.active > a::before {
    background: var(--accent) !important; // barrita accent
  }

  // Header ERP arriba del workspace: mismo fondo del mockup
  .header {
    background: var(--bg) !important;
    border-bottom: 1px solid var(--line) !important;
  }
}
```

> **Regla:** todos los `!important` viven exclusivamente bajo `body.workspace-page`. Al salir a cualquier otra ruta, el sidebar recupera sus estilos originales.

### 4.3 El grid del `.webapp-body` ya no tiene columna nav

Cambia respecto al mockup:

```scss
// MOCKUP ORIGINAL:
.webapp-body { grid-template-columns: 260px 380px 1fr 360px; }

// EN /workspace (sin columna nav interna — el sidebar ERP está afuera del chrome):
.webapp-body { grid-template-columns: 380px 1fr 360px; }
```

El chrome `.webapp-chrome` (3 dots + url + device-label) **se mantiene** — es el "navegador" falso del mockup; NO es el header del ERP.

---

## 5 · Inventario de componentes visuales (no omitir)

| Bloque | Clase raíz | Detalles |
|--------|-----------|----------|
| Top bar | `.topbar` | `.brand-mark` 44×44 con "S" Fraunces · `h1.title` con `<em>Unificado</em>` accent · `.meta` con dot animado |
| Pipeline maestro | `.pipeline` | 7 `.step` (+ `.done`, `.active`) con `.step-arrow` "→" entre ellos |
| Webapp chrome | `.webapp-chrome` | 3 `.dot-btn` (`.r/.y/.g`) + `.url` con `<span>solomotorx.app</span>` + `.device-label` |
| Inbox | `.inbox` | `.inbox-header` (h2 Fraunces) · `.inbox-tabs` (5 pestañas) · `.inbox-search` · `.conv-list` |
| Conversación | `.conv` | `.conv.active::before` 3 px accent · avatar con `.ch-badge` (wa/ml/eco/fv) · `.conv-tags` |
| Avatares | `.av.solomotor/.blue/.orange/.violet/.green/.yellow` | 40×40 |
| Tags | `.tag-cot/.tag-apr/.tag-pag/.tag-des/.tag-cer/.tag-new` | 6 variantes |
| Convo header | `.convo-header` | avatar + nombre + tag + `.convo-sub` + 3 `.icon-btn` |
| Pipeline mini | `.pipeline-mini` | 7 `.pm` (+ `.done`, `.current`) |
| Mensajes | `.msg.them/.me/.system` | system dashed centrado |
| Tarjeta cotización embebida | `.msg-card` | `.card-head` + `.card-body` + `.actions` |
| Composer | `.composer` | input fake + 3 `.quick` (+ `.primary` para "COTIZAR") |
| Ficha | `.ficha-section` × 5 | Cliente · Estado · Productos · Banco · Acciones |
| Estado card | `.estado-card` | `.tipo` pill + `.monto` Fraunces 28 px con `<span class="cur">USD</span>` |
| Productos | `.items-list` con `.it` | emoji-img + name + sku + stock `.ok/.low/.none` + precio |
| Banco | `.banco-row` | descripción + `.ref` + `.ok`/`.pending` |
| Acciones | `.acciones` grid 2 × | `.btn.primary.wide` (CONCILIAR PAGO) · `.btn.ghost.wide` (CERRAR VENTA) |
| Phone 1 y 2 | `.phone`, `.phone.phone2` | 380×780 con notch `::before` |
| Modales | `.modal` × 6 | rotación `-0.3deg` / `0.4deg` alternada |
| Footer | `.footer-note` | 3 `<span>` — textos en sección 9 |

---

## 6 · Responsive

```scss
@media (max-width: 1400px){
  .workspace { grid-template-columns: 1fr; }
  .mobile-wrap { order: 2; }
}

@media (max-width: 1100px){
  .webapp-body { grid-template-columns: 1fr; }   // apilar inbox/convo/ficha
  .webapp-body .inbox,
  .webapp-body .convo,
  .webapp-body .ficha { border-right: 0; border-bottom: 1px solid var(--line); }
  .pipeline { overflow-x: auto; }
}

@media (max-width: 768px){
  body.workspace-page { padding: 16px 12px 40px; }
  .topbar h1.title { font-size: 28px; }
  .mobile-wrap { grid-template-columns: 1fr; }
}
```

En móvil real (viewport ≤ 768 px), **no** mostrar los dos `.phone` decorativos del mockup (los ocultamos con `display:none`). Toda la UX queda en el workspace colapsado.

---

## 7 · Animaciones y scrollbar (copiar del HTML)

```scss
@keyframes fadeUp { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
.topbar, .pipeline, .workspace, .modals-rack, .footer-note { animation: fadeUp .6s ease both; }
.pipeline    { animation-delay: .05s; }
.workspace   { animation-delay: .1s; }
.modals-rack { animation-delay: .15s; }

body.workspace-page ::-webkit-scrollbar{ width:8px; height:8px; }
body.workspace-page ::-webkit-scrollbar-thumb{ background: var(--line); border-radius: 8px; }
```

---

## 8 · Endpoints backend disponibles (sólo referencia para Fase B)

| Pieza | Endpoint |
|-------|----------|
| Lista bandeja + filtros (`todos/unread/quote/ventas/mine`) | `GET /api/inbox?filter=&src=` |
| Counts por filtro/canal (tabs e inbox nav) | `GET /api/inbox/counts` |
| Mensajes del hilo | `GET /api/crm/chats/:id/messages` |
| Enviar mensaje desde composer | `POST /api/crm/chats/:id/messages` |
| Ficha 360° (cliente, orden, cotización, banco) | `GET /api/crm/chats/:id/context` |
| Estado WA (dot header) | `GET /api/crm/system/wa-status` |
| Cotización — tabla + totales del modal #1 | `GET/POST /api/inbox/quotations/*` |
| Conciliar pago — modal #2 | `GET /api/bank/statements`, motor conciliación |
| Producto / stock — modal #6 | `GET /api/wms/*`, vista `v_stock_by_sku` |
| Despacho — modal #3 | **demo · no cablear (decisión 5)** |
| Calificación — modal #4 | **demo · no cablear (decisión 6)** |
| Canales unificados — modal #5 | `GET /api/inbox/counts` agrupando por `src` |

Proxy Next: todas estas rutas deben consumirse a través de los proxies en `src/app/api/**` que ya existen (siguen el patrón `X-Admin-Secret`). **No** llamar al Node backend directo desde el cliente.

### Gap conocido (documentar en código pero no bloquear Fase A)

- **Pipeline maestro 7 pasos del mockup vs `chat_stage` backend (8 valores técnicos):** definir constante FE `PIPELINE_STAGE_MAP` con el mapeo acordado con producto en el momento de Fase B. Fase A: hardcodear el estado `.active` como el del mockup.

---

## 9 · Texto footer (verbatim del mockup)

```
MOCKUP · MÓDULO UNIFICADO DE VENTAS · SOLOMOTORX
REGLA CLAVE: LOS PRECIOS NUNCA SE COMPARTEN AL AIRE · SIEMPRE VÍA COTIZACIÓN FORMAL
v2.4.0 · CJ
```

---

## 10 · Entregables

| # | Archivo | Contenido |
|---|---------|-----------|
| 1 | `src/app/(features)/workspace/page.tsx` | `'use client'`. Markup JSX Fase A replicando el HTML. `useEffect` que aplica/retira `document.body.classList` `workspace-page` |
| 2 | `src/app/(features)/workspace/workspace.scss` | Tokens del mockup + fondos + animaciones + todas las clases de componentes + **bloque de retintado del sidebar ERP (sección 4.2)** + media queries (sección 6) |
| 3 | `src/data/all_routes.tsx` | Añadir `workspace: "/workspace"` |
| 4 | (opcional) `src/app/(features)/workspace/mock-data.ts` | Constantes con las 7 conversaciones, mensajes demo, items de cotización, etc. del HTML — para que `page.tsx` quede legible |

**Verificación final:**

1. Abrir `file:///…/solomotorx-modulo-ventas (2).html` y `http://localhost:3000/workspace` lado a lado en Chrome zoom 100 %.
2. Topbar, pipeline, webapp (con sidebar ERP retintado en lugar de la columna `.nav`), inbox, convo, ficha, dos móviles, 6 modales, footer — todos visibles y con el mismo aspecto salvo la columna sidebar.
3. Resize a 1200 px: workspace colapsa a 1 col. Resize a 768 px: phones ocultos, layout apilado.
4. Navegar a `/admin-dashboard` u otra ruta del ERP: el sidebar vuelve a sus colores originales (prueba que el retintado está scoped).

---

## 11 · Mensaje pegable al desarrollador frontend

```
Implementar /workspace según docs/prompts/prompt-modulo-unificado-ventas.md.

Decisiones cerradas:
1. Ruta /workspace (nueva en all_routes.tsx)
2. Responsive real, mismo URL (sin /m/...)
3. Diseño 100% idéntico al HTML solomotorx-modulo-ventas (2).html
4. Sidebar ERP existente (core/common/sidebar), RETINTADO con paleta del mockup — scoped a body.workspace-page, nunca global
5. Modal "Solicitar despacho": datos demo del HTML (cablea después)
6. Modal "Calificación": datos demo del HTML (cablea después)

Fase A (entrega de hoy): UI pixel-perfect con mock data (mismos textos del HTML).
Fase B (posterior): cablear con /api/inbox, /api/crm/chats/:id/messages, etc. sin tocar clases ni layout.

La columna .nav de 260px del mockup NO se replica; en su lugar el <Sidebar /> del ERP aparece automáticamente desde (features)/layout.tsx y se reteñido via selectores bajo body.workspace-page.
```

---

*Prompt generado con decisiones del usuario ya firmadas. Cualquier ajuste de alcance antes de implementar debe hacerse sobre este archivo y commitear el cambio.*
