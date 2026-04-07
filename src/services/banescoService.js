"use strict";

/**
 * Misma ruta que `npx playwright install` con PLAYWRIGHT_BROWSERS_PATH=0 (node_modules/.../.local-browsers).
 * Sin esto, en runtime Playwright busca ~/.cache/ms-playwright aunque el build haya instalado en el proyecto.
 */
if (
  process.env.PLAYWRIGHT_BROWSERS_PATH === undefined ||
  process.env.PLAYWRIGHT_BROWSERS_PATH === ""
) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = "0";
}

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const crypto = require("crypto");
const { pool } = require("../../db-postgres");
const { parseVenezuelanNumber } = require("./currencyService");

/** La raíz del dominio no sirve: el formulario está en Login.aspx (Banesco Online / Mantis). */
const URL_LOGIN =
  process.env.BANESCO_LOGIN_URL ||
  "https://www.banesconline.com/mantis/Website/Login.aspx";
const URL_EXPORTAR =
  process.env.BANESCO_EXPORT_URL ||
  "https://www.banesconline.com/Mantis/WebSite/ConsultaMovimientosCuenta/Exportar.aspx";
/** Tras login: movimientos de cuenta → ddlCuenta → botón «Exportar» → Exportar.aspx. Override: BANESCO_MOVIMIENTOS_CUENTA_URL */
const URL_MOVIMIENTOS_CUENTA =
  process.env.BANESCO_MOVIMIENTOS_CUENTA_URL ||
  "https://www.banesconline.com/Mantis/WebSite/consultamovimientoscuenta/movimientoscuenta.aspx";
/** Botón «Aceptar» en Exportar.aspx (postback ASP.NET); login usa #bAceptar. Override: BANESCO_EXPORT_BTN_SELECTOR */
const SEL_BTN_EXPORTAR_DESCARGA =
  '#ctl00_cp_btnOk, input[name="ctl00$cp$btnOk"], input.DefBtn[type="submit"][value="Aceptar"], ' +
  "#bAceptar, input[name=\"bAceptar\"], input.LogButton[type=\"submit\"][value=\"Aceptar\"], " +
  'input[value="Aceptar"], button:has-text("Aceptar"), input[type="submit"][value*="ceptar"]';
/**
 * Tras login correcto el portal suele abrir [default.aspx](https://www.banesconline.com/Mantis/WebSite/default.aspx).
 * La redirección puede tardar unos 5–10 s; el timeout dedicado es BANESCO_DEFAULT_ASPX_WAIT_MS (default 90 s).
 * El propio banco puede cerrar la sesión por inactividad (~2 min); el monitor cada 60s vuelve a usar cookies / re-login.
 */
const URL_POST_LOGIN_SUCCESS = /\/default\.aspx/i;
const SESSION_MAX_HOURS = 8;

/** Último ciclo del monitor (memoria; se pierde al reiniciar el proceso). */
let lastCycleSnapshot = null;

function getLastCycleSnapshot() {
  return lastCycleSnapshot;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Tras el POST, los handlers async (response.body / route) pueden tardar en rellenar el buffer.
 * Espera en bucle antes de cerrar el navegador.
 */
async function waitForBanescoCapturedContent(getContent, maxMs) {
  const pollMs = Number(process.env.BANESCO_EXPORT_CAPTURE_POLL_MS || 150);
  const cap = Number(maxMs || process.env.BANESCO_EXPORT_CAPTURE_MAX_MS || 15000);
  const start = Date.now();
  while (Date.now() - start < cap) {
    if (getContent()) {
      return true;
    }
    await sleep(pollMs);
  }
  return Boolean(getContent());
}

/**
 * Con Chromium aún abierto: margen 3–5 s para que termine la descarga / listeners antes de cerrar.
 * Orden correcto: esperar → cerrar (no al revés).
 */
async function sleepMarginBeforeBrowserClose() {
  const min = Number(process.env.BANESCO_EXPORT_POST_BUFFER_MS_MIN || 3000);
  const max = Number(process.env.BANESCO_EXPORT_POST_BUFFER_MS_MAX || 5000);
  const high = Math.max(min, max);
  const low = Math.min(min, max);
  const ms = low + Math.floor(Math.random() * (high - low + 1));
  console.log(
    `[banesco] ${nowVET()} — margen pre-cierre navegador (descarga/listeners): ${ms}ms`
  );
  await sleep(ms);
}

/** Errores típicos cuando Postgres/SSL cierra el socket (p. ej. tras mucho tiempo en Playwright sin consultas). */
function isTransientDbError(err) {
  if (!err) return false;
  const c = err.code;
  const m = String(err.message || "").toLowerCase();
  if (c === "ECONNRESET" || c === "ETIMEDOUT" || c === "EPIPE") return true;
  if (c === "57P01" || c === "57P02" || c === "57P03") return true;
  if (m.includes("connection terminated")) return true;
  if (m.includes("connection closed")) return true;
  if (m.includes("server closed the connection")) return true;
  if (m.includes("ssl") && m.includes("closed")) return true;
  return false;
}

async function queryRetry(text, params, opts = {}) {
  const max = opts.maxRetries ?? 4;
  let delayMs = 400;
  for (let attempt = 0; attempt < max; attempt++) {
    try {
      return await pool.query(text, params);
    } catch (e) {
      if (attempt < max - 1 && isTransientDbError(e)) {
        console.warn(
          `[banesco] ${nowVET()} — DB transitorio (reintento ${attempt + 1}/${max}): ${e.message || e}`
        );
        await sleep(delayMs);
        delayMs = Math.min(delayMs * 2, 8000);
        continue;
      }
      throw e;
    }
  }
}

function nowVET() {
  return (
    new Date(Date.now() - 4 * 3600000).toISOString().replace("T", " ").substring(0, 19) + " VET"
  );
}

/**
 * Capturas por paso del login. Activar con:
 *   BANESCO_STEP_SCREENSHOTS=1  → carpeta ./banesco-debug (en el cwd del proceso)
 *   o BANESCO_SCREENSHOT_DIR=/ruta/absoluta/o/relativa
 */
function getBanescoScreenshotState() {
  const dirRaw = process.env.BANESCO_SCREENSHOT_DIR;
  const enabled = process.env.BANESCO_STEP_SCREENSHOTS === "1" || (dirRaw && String(dirRaw).trim());
  if (!enabled) return null;
  const dir = dirRaw && String(dirRaw).trim()
    ? path.resolve(String(dirRaw).trim())
    : path.join(process.cwd(), "banesco-debug");
  const runId =
    new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19) +
    "_" +
    process.pid;
  return { dir, runId };
}

/**
 * Post-login: pantalla Exportar movimientos + opciones + descarga.
 * BANESCO_EXPORT_STEP_SCREENSHOTS=1 → ./banesco-export-debug
 * o BANESCO_EXPORT_SCREENSHOT_DIR=/ruta
 */
function getBanescoExportScreenshotState() {
  const dirRaw = process.env.BANESCO_EXPORT_SCREENSHOT_DIR;
  const enabled =
    process.env.BANESCO_EXPORT_STEP_SCREENSHOTS === "1" || (dirRaw && String(dirRaw).trim());
  if (!enabled) return null;
  const dir =
    dirRaw && String(dirRaw).trim()
      ? path.resolve(String(dirRaw).trim())
      : path.join(process.cwd(), "banesco-export-debug");
  const runId =
    new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19) +
    "_" +
    process.pid;
  return { dir, runId };
}

/**
 * Directorio de descargas de Chromium para Playwright (`downloadsPath`).
 * Sin carpeta explícita, el evento `download` y `download.path()` suelen fallar o no dispararse en automatización.
 * Orden: BANESCO_PLAYWRIGHT_DOWNLOADS_DIR → BANESCO_DOWNLOADS_DIR → BANESCO_SAVE_DOWNLOAD_DIR → data/banesco-downloads (cwd).
 */
function resolveBanescoPlaywrightDownloadsPath() {
  const raw =
    process.env.BANESCO_PLAYWRIGHT_DOWNLOADS_DIR ||
    process.env.BANESCO_DOWNLOADS_DIR ||
    process.env.BANESCO_SAVE_DOWNLOAD_DIR;
  const dir =
    raw && String(raw).trim()
      ? path.resolve(String(raw).trim())
      : path.join(process.cwd(), "data", "banesco-downloads");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function banescoWriteScreenshot(page, state, stepName, logLabel) {
  if (!state || !page) return;
  const safe = String(stepName).replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 100);
  try {
    fs.mkdirSync(state.dir, { recursive: true });
    const file = path.join(state.dir, `${state.runId}__${safe}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.log(`[banesco] captura ${logLabel} → ${file}`);
  } catch (e) {
    console.warn(`[banesco] captura ${logLabel} falló (${stepName}):`, e.message || e);
  }
}

async function banescoStepScreenshot(page, state, stepName) {
  return banescoWriteScreenshot(page, state, stepName, "login");
}

async function banescoExportScreenshot(page, state, stepName) {
  return banescoWriteScreenshot(page, state, stepName, "post-login");
}

function banescoChromiumLaunchOptions() {
  const args = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-blink-features=AutomationControlled",
  ];
  /** Solo si hace falta (algunos entornos headless); puede afectar seguridad del proceso — opt-in. */
  if (process.env.BANESCO_CHROMIUM_DISABLE_SITE_ISOLATION === "1") {
    args.push("--disable-features=IsolateOrigins,site-per-process");
  }
  const opts = {
    headless: process.env.BANESCO_HEADLESS !== "0",
    args,
  };
  /**
   * Sin esto, Playwright abre el Chromium del paquete (ventana "Chrome for Testing").
   * Para el navegador estable del sistema (descargas más parecidas a uso manual):
   *   BANESCO_PLAYWRIGHT_CHANNEL=chrome   → Google Chrome instalado
   *   BANESCO_PLAYWRIGHT_CHANNEL=msedge   → Microsoft Edge instalado (Windows)
   */
  const channel =
    process.env.BANESCO_PLAYWRIGHT_CHANNEL || process.env.BANESCO_USE_SYSTEM_CHROME;
  const ch = channel && String(channel).trim().toLowerCase();
  if (ch === "chrome" || ch === "msedge") {
    opts.channel = ch;
  }
  return opts;
}

/**
 * Chromium instalado por `playwright install` con PLAYWRIGHT_BROWSERS_PATH=0 vive en
 * `node_modules/playwright-core/.local-browsers/chromium-*`. En Render suele ser
 * `.../src/node_modules/...` (un `..` desde `src/services`), no siempre la raíz del repo.
 */
function resolvePlaywrightEmbeddedChromiumExecutable() {
  const localRel = ["playwright-core", ".local-browsers"];
  const roots = [
    path.join(__dirname, "..", "node_modules", ...localRel),
    path.join(__dirname, "..", "..", "node_modules", ...localRel),
    path.join(process.cwd(), "node_modules", ...localRel),
  ];
  const seen = new Set();
  for (const root of roots) {
    const key = path.resolve(root);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!fs.existsSync(root)) continue;
    let dirs;
    try {
      dirs = fs.readdirSync(root);
    } catch (_) {
      continue;
    }
    const chromiumDirs = dirs.filter((d) => /^chromium-\d+/.test(d));
    if (chromiumDirs.length === 0) continue;
    chromiumDirs.sort(
      (a, b) =>
        parseInt(a.replace(/^chromium-/, ""), 10) -
        parseInt(b.replace(/^chromium-/, ""), 10)
    );
    const dirName = chromiumDirs[chromiumDirs.length - 1];
    const base = path.join(root, dirName);
    let exe = null;
    if (process.platform === "win32") {
      exe = path.join(base, "chrome-win", "chrome.exe");
    } else if (process.platform === "darwin") {
      exe = path.join(
        base,
        "chrome-mac",
        "Chromium.app",
        "Contents",
        "MacOS",
        "Chromium"
      );
    } else {
      exe = path.join(base, "chrome-linux64", "chrome");
    }
    if (exe && fs.existsSync(exe)) {
      return exe;
    }
  }
  return null;
}

/**
 * Lanza Chromium; si `BANESCO_PLAYWRIGHT_CHANNEL` apunta a Chrome/Edge pero no está instalado
 * (p. ej. Linux en Render sin `/opt/google/chrome/chrome`), reintenta sin canal → Chromium del paquete npm.
 * Si existe binario en `.local-browsers`, se pasa `executablePath` para no depender de ~/.cache/ms-playwright.
 */
async function launchBanescoBrowser() {
  const opts = banescoChromiumLaunchOptions();
  const embedded = resolvePlaywrightEmbeddedChromiumExecutable();
  if (embedded && !opts.channel) {
    opts.executablePath = embedded;
  }
  try {
    return await chromium.launch(opts);
  } catch (e) {
    if (!opts.channel) throw e;
    const msg = String(e.message || e);
    const looksMissing =
      /not found|doesn't exist|is not installed|not installed at|distribution/i.test(msg);
    if (!looksMissing) throw e;
    console.warn(
      `[banesco] ${nowVET()} — Canal "${opts.channel}" no disponible en este host; ` +
        `usando Chromium embebido de Playwright. (${msg.slice(0, 200)})`
    );
    const { channel: _ch, ...rest } = opts;
    if (embedded) {
      rest.executablePath = embedded;
    }
    return await chromium.launch(rest);
  }
}

/**
 * Tras el POST de exportación, el iframe suele vaciarse al entregar el adjunto (los radios/select «desaparecen»).
 * Tras leer el archivo, volvemos a Exportar.aspx y re-aplicamos _configurarFormulario (sin segunda descarga).
 * Por defecto: activo. Desactivar solo si no te importa la UI y querés ahorrar ~3–8 s: BANESCO_EXPORT_RESTORE_UI_AFTER_DOWNLOAD=0.
 */
function shouldRestoreBanescoExportUiAfterDownload() {
  const v = process.env.BANESCO_EXPORT_RESTORE_UI_AFTER_DOWNLOAD;
  if (v === "0") return false;
  return true;
}

/**
 * Chromium a veces bloquea descargas en automatización pese a acceptDownloads/downloadsPath.
 * CDP fuerza "allow" y la ruta donde guardar (equivalente a política interna de descargas).
 */
async function applyChromiumDownloadPolicyViaCdp(page, absoluteDownloadsPath) {
  if (process.env.BANESCO_SKIP_CDP_DOWNLOAD === "1") {
    return;
  }
  const dir = path.resolve(String(absoluteDownloadsPath || ""));
  try {
    const session = await page.context().newCDPSession(page);
    try {
      await session.send("Browser.setDownloadBehavior", {
        behavior: "allow",
        downloadPath: dir,
        eventsEnabled: true,
      });
      console.log(
        `[banesco] ${nowVET()} — CDP Browser.setDownloadBehavior: allow, downloadPath=${dir}`
      );
    } catch (e1) {
      await session.send("Page.setDownloadBehavior", {
        behavior: "allow",
        downloadPath: dir,
      });
      console.log(
        `[banesco] ${nowVET()} — CDP Page.setDownloadBehavior: allow, downloadPath=${dir}`
      );
    }
  } catch (e) {
    console.warn(`[banesco] ${nowVET()} — CDP descargas no aplicado:`, e.message || e);
  }
}

/**
 * Banesco suele pintar el login dentro de un iframe; page.locator() solo ve el frame principal.
 */
async function waitForUserFieldInAnyFrame(page, selUsuario, stepMs) {
  const deadline = Date.now() + stepMs;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      const candidates = [
        () => frame.getByPlaceholder(/USUARIO/i),
        () => frame.locator(selUsuario).first(),
        () => frame.locator('input[type="email"]').first(),
      ];
      for (const mk of candidates) {
        const loc = mk();
        if (await loc.isVisible().catch(() => false)) {
          return { frame, loc };
        }
      }
    }
    await sleep(300);
  }
  throw new Error(
    `Timeout ${stepMs}ms: sin campo usuario visible (${page.frames().length} frame(s)). ` +
      `¿Captcha, bloqueo headless? Probá BANESCO_HEADLESS=0 o revisá la página.`
  );
}

/** Variantes típicas (ASP.NET, autocomplete; etiquetas con * de obligatorio). */
function passwordLocatorCandidates(frame, selClave) {
  const cssExtra =
    'input[type="password"], input[autocomplete="current-password"], ' +
    'input[autocomplete="new-password"], ' +
    'input[id*="txtClave"], input[id*="TxtClave"], input[id*="Password"], input[id*="password"], ' +
    'input[name*="clave"], input[name*="Clave"], input[name*="Password"], input[name*="password"]';
  // Placeholder / texto auxiliar: "CLAVE", "* CLAVE", "CLAVE *", etc.
  const rePhPass = /(\*?\s*)?(CLAVE|CONTRASEÑA|PASSWORD|PIN)(\s*\*)?/i;
  // Nombre accesible del campo (label con asterisco obligatorio)
  const reLabelPass = /(\*?\s*)?(clave|contraseña|password|pin)(\s*\*)?/i;

  return [
    () => frame.getByLabel(reLabelPass).first(),
    () =>
      frame
        .getByPlaceholder(rePhPass)
        .or(frame.getByPlaceholder(/CLAVE|CONTRASEÑA|PASSWORD|PIN/i))
        .or(frame.locator(selClave))
        .or(frame.locator(cssExtra))
        .first(),
    () => frame.getByRole("textbox", { name: reLabelPass }).first(),
    () => frame.getByRole("textbox", { name: /clave|contraseña|password|pin/i }).first(),
    () => frame.locator('input[type="password"]').first(),
    () => frame.locator(cssExtra).first(),
  ];
}

async function waitForPasswordFieldInAnyFrame(page, preferredFrame, selClave, stepMs) {
  const deadline = Date.now() + stepMs;

  while (Date.now() < deadline) {
    const frames = page.frames();
    const frameOrder = [];
    if (preferredFrame && frames.includes(preferredFrame)) {
      frameOrder.push(preferredFrame);
    }
    for (const f of frames) {
      if (!frameOrder.includes(f)) {
        frameOrder.push(f);
      }
    }

    for (const frame of frameOrder) {
      for (const mk of passwordLocatorCandidates(frame, selClave)) {
        const loc = mk();
        try {
          await loc.waitFor({ state: "visible", timeout: 1200 });
          await loc.scrollIntoViewIfNeeded().catch(() => {});
          return loc;
        } catch {
          continue;
        }
      }
    }
    await sleep(250);
  }
  throw new Error(
    `Timeout ${stepMs}ms: sin campo clave visible (${page.frames().length} frame(s) al final). ` +
      `Si hay OTP o segunda pantalla, hay que ampliar el flujo.`
  );
}

/** Banesco Login.aspx: botón verde (mismo id en paso usuario; puede repetirse en paso clave). */
const SEL_BOTON_ACEPTAR =
  '#bAceptar, input[name="bAceptar"], input.LogButton[type="submit"][value="Aceptar"], ' +
  'input[type="submit"][value="Aceptar"], input[type="button"][value="Aceptar"], ' +
  'button:has-text("Aceptar"), [role="button"]:has-text("Aceptar")';

/**
 * Primer control visible que coincida (evita .first() en unión que toma un nodo oculto).
 * Override opcional: selector CSS de un solo elemento o grupo (ver BANESCO_BOTON_ACEPTAR_PASO1_SELECTOR).
 */
async function clickFirstVisibleAceptarInFrame(frame, selectorOverride) {
  const sel = (selectorOverride && String(selectorOverride).trim()) || SEL_BOTON_ACEPTAR;
  const buttons = frame.locator(sel);
  const n = await buttons.count();
  if (n === 0) {
    throw new Error(
      selectorOverride
        ? `Selector no encontró ningún elemento en este frame: ${sel}`
        : "No hay candidatos a botón Aceptar en este frame"
    );
  }
  for (let i = 0; i < n; i++) {
    const b = buttons.nth(i);
    if (await b.isVisible().catch(() => false)) {
      await b.scrollIntoViewIfNeeded().catch(() => {});
      try {
        await b.click({ timeout: 20000 });
      } catch {
        await b.click({ timeout: 20000, force: true });
      }
      return;
    }
  }
  throw new Error("No hay botón Aceptar visible en este frame");
}

async function clickAceptarInFrame(frame) {
  const custom = process.env.BANESCO_BOTON_ACEPTAR_PASO1_SELECTOR;
  if (custom && String(custom).trim()) {
    console.log(`[banesco] ${nowVET()} — primer Aceptar: selector personalizado (BANESCO_BOTON_ACEPTAR_PASO1_SELECTOR)`);
  }
  await clickFirstVisibleAceptarInFrame(frame, custom);
}

/** Segundo «Aceptar» puede estar en el mismo iframe que la clave o en otro. */
async function clickAceptarVisibleInAnyFrame(page, preferredFrame) {
  const custom = process.env.BANESCO_BOTON_ACEPTAR_PASO2_SELECTOR;
  if (custom && String(custom).trim()) {
    console.log(`[banesco] ${nowVET()} — segundo Aceptar: selector personalizado (BANESCO_BOTON_ACEPTAR_PASO2_SELECTOR)`);
  }
  if (preferredFrame) {
    try {
      await clickFirstVisibleAceptarInFrame(preferredFrame, custom);
      return;
    } catch {
      /* seguir con el resto de frames */
    }
  }
  for (const fr of page.frames()) {
    try {
      await clickFirstVisibleAceptarInFrame(fr, custom);
      return;
    } catch {
      continue;
    }
  }
  throw new Error("No hay botón Aceptar visible en ningún frame");
}

/**
 * Botón de descarga en Exportar.aspx: no usar .first() en el page (suele haber iframes
 * y varios "Aceptar"; el primero del DOM puede estar oculto y el clic no hace efecto).
 */
async function resolveVisibleExportDownloadButton(page) {
  const custom = process.env.BANESCO_EXPORT_BTN_SELECTOR && String(process.env.BANESCO_EXPORT_BTN_SELECTOR).trim();
  const selectorList = custom
    ? [custom]
    : [
        // DOM real Exportar.aspx: el submit está en <td class="ExportAcceptBtnWrapper">
        "td.ExportAcceptBtnWrapper #ctl00_cp_btnOk",
        'td.ExportAcceptBtnWrapper input[name="ctl00$cp$btnOk"]',
        "td.ExportAcceptBtnWrapper input.DefBtn[type='submit']",
        "#ctl00_cp_btnOk",
        'input[name="ctl00$cp$btnOk"]',
        'input[id="ctl00_cp_btnOk"]',
        SEL_BTN_EXPORTAR_DESCARGA,
      ];

  for (const frame of page.frames()) {
    const frameLabel =
      frame.parentFrame() === null ? "main" : (frame.url() || frame.name() || "iframe");
    for (const sel of selectorList) {
      const buttons = frame.locator(sel);
      const n = await buttons.count().catch(() => 0);
      for (let i = 0; i < n; i++) {
        const b = buttons.nth(i);
        if (await b.isVisible().catch(() => false)) {
          await b.scrollIntoViewIfNeeded().catch(() => {});
          return { locator: b, sel, frameLabel, nth: i };
        }
      }
    }
  }

  throw new Error(
    "No hay botón visible de descarga en ningún frame (probá BANESCO_EXPORT_BTN_SELECTOR o revisá captura export-05)."
  );
}

function isLikelyHtmlBuffer(buf) {
  if (!buf || buf.length === 0) return true;
  const head = buf.slice(0, 400).toString("utf8").trimStart().toLowerCase();
  return head.startsWith("<!doctype") || head.startsWith("<html") || head.startsWith("<head");
}

/**
 * El POST a Exportar.aspx suele devolver primero la página completa (text/html) por postback;
 * eso NO es el archivo. Solo aceptamos respuestas que parezcan descarga o texto plano.
 */
function isFileLikeExportResponse(response) {
  if (response.status() !== 200) return false;
  const u = response.url();
  if (!/Exportar\.aspx/i.test(u) && !/ConsultaMovimientosCuenta\/Exportar/i.test(u)) {
    return false;
  }
  const h = response.headers();
  const ct = (h["content-type"] || h["Content-Type"] || "").toLowerCase();
  const cd = (h["content-disposition"] || h["Content-Disposition"] || "").toLowerCase();
  if (cd.includes("attachment") || cd.includes("filename=")) return true;
  if (ct.includes("text/html") || ct.includes("application/xhtml")) {
    return false;
  }
  if (
    ct.includes("text/plain") ||
    ct.includes("application/octet-stream") ||
    ct.includes("text/csv") ||
    ct.includes("csv")
  ) {
    return true;
  }
  return false;
}

/** Contenido tipo movimientos Banesco (líneas con varios |), aunque el servidor mande text/html mal puesto. */
function looksLikeBanescoMovimientosTxt(buf) {
  if (!buf || buf.length < 30) return false;
  if (isLikelyHtmlBuffer(buf)) return false;
  const sample = buf.slice(0, 16000).toString("utf8");
  if (/<\s*html[\s>]/i.test(sample) || /<!DOCTYPE/i.test(sample)) return false;
  const lines = sample
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return false;
  let pipeLines = 0;
  for (const line of lines.slice(0, 50)) {
    if ((line.match(/\|/g) || []).length >= 3) pipeLines++;
  }
  return pipeLines >= 1;
}

async function trySniffTxtFromExportResponses(responses) {
  const bodies = [];
  for (const response of responses) {
    try {
      bodies.push(await response.body());
    } catch {
      bodies.push(null);
    }
  }

  for (let i = 0; i < responses.length; i++) {
    const buf = bodies[i];
    if (!buf || !buf.length) continue;
    const ct = (responses[i].headers()["content-type"] || responses[i].headers()["Content-Type"] || "")
      .toLowerCase();
    if (ct.includes("text/html")) {
      const htmlPreview = new TextDecoder("utf-8").decode(new Uint8Array(buf).slice(-2000));
      console.log("[banesco] ÚLTIMOS 2000 chars del HTML de respuesta:");
      console.log(htmlPreview);
      break;
    }
  }

  for (let i = bodies.length - 1; i >= 0; i--) {
    const buf = bodies[i];
    if (!buf) continue;
    if (looksLikeBanescoMovimientosTxt(buf)) {
      return buf;
    }
  }
  return null;
}

/** Chromium escribe *.crdownload mientras copia; esperar a que desaparezca (equiv. Selenium/Python). */
async function waitForCrdownloadGone(dir, maxMs) {
  if (!dir || !fs.existsSync(dir)) return;
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    if (!names.some((n) => /\.crdownload$/i.test(n))) {
      return;
    }
    await sleep(120);
  }
}

/**
 * Si el evento download no llegó pero el archivo sí cayó en downloadsPath (p. ej. V017488886.txt).
 */
function tryReadLatestBanescoTxtFromDownloadsDir(dir) {
  if (!dir || !fs.existsSync(dir)) return null;
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const txtFiles = names.filter((f) => /\.txt$/i.test(f));
  if (txtFiles.length === 0) return null;
  const withStat = txtFiles.map((name) => {
    const full = path.join(dir, name);
    try {
      return { full, name, mtime: fs.statSync(full).mtimeMs };
    } catch {
      return null;
    }
  }).filter(Boolean);
  withStat.sort((a, b) => b.mtime - a.mtime);
  for (const { full, name } of withStat.slice(0, 8)) {
    const buf = fs.readFileSync(full);
    if (looksLikeBanescoMovimientosTxt(buf)) {
      return { buffer: buf, suggestedName: name };
    }
  }
  return null;
}

function safeSuggestedDownloadFilename(suggested) {
  const raw =
    suggested && String(suggested).trim() ? path.basename(String(suggested).trim()) : "";
  const name = raw.replace(/[^a-zA-Z0-9._\-\s]/g, "_").trim();
  return name || "banesco-export.txt";
}

/**
 * Escribe siempre el buffer en disco (Node fs), aparte de lo que haga Playwright.
 * Así hay un archivo visible aunque saveAs o el evento download fallen en parte.
 */
function persistExportBufferToDir(dir, buffer, preferredName) {
  if (!buffer || buffer.length === 0 || !dir) return;
  const d = path.resolve(String(dir));
  fs.mkdirSync(d, { recursive: true });
  const lastPath = path.join(d, "banesco-last-export.txt");
  try {
    fs.writeFileSync(lastPath, buffer);
    console.log(
      `[banesco] ${nowVET()} — fs.writeFileSync (siempre): ${lastPath} (${buffer.length} bytes)`
    );
  } catch (e) {
    console.error(`[banesco] ${nowVET()} — No se pudo escribir ${lastPath}:`, e.message || e);
  }
  if (preferredName && String(preferredName).trim()) {
    const namedPath = path.join(d, safeSuggestedDownloadFilename(preferredName));
    if (namedPath !== lastPath) {
      try {
        fs.writeFileSync(namedPath, buffer);
        console.log(`[banesco] ${nowVET()} — fs.writeFileSync (nombre portal): ${namedPath}`);
      } catch (e) {
        console.warn(`[banesco] ${nowVET()} — Copia con nombre sugerido falló:`, e.message || e);
      }
    }
  }
}

/**
 * Persiste con download.saveAs (ruta estable) y luego lee; si falla, stream / path temporal.
 * Sin saveAs, al cerrar el contexto el archivo temporal puede perderse.
 */
async function bufferFromPlaywrightDownload(download, absoluteSaveDir) {
  const suggestedName =
    typeof download.suggestedFilename === "function" ? download.suggestedFilename() : "";
  const fileName = safeSuggestedDownloadFilename(suggestedName);

  if (absoluteSaveDir && typeof download.saveAs === "function") {
    const dir = path.resolve(String(absoluteSaveDir));
    fs.mkdirSync(dir, { recursive: true });
    const targetPath = path.join(dir, fileName);
    try {
      await download.saveAs(targetPath);
      console.log(`[banesco] ${nowVET()} — download.saveAs → ${targetPath}`);
      return fs.readFileSync(targetPath);
    } catch (e) {
      console.warn(
        `[banesco] ${nowVET()} — download.saveAs falló (${e.message || e}); leyendo stream/tmp`
      );
    }
  }

  if (typeof download.createReadStream === "function") {
    const stream = await download.createReadStream();
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  const tmpPath = await download.path();
  return fs.readFileSync(tmpPath);
}

/**
 * Orden: 1) evento download 2) respuesta HTTP con cabeceras de archivo 3) inspección POST
 * 4) espera .crdownload + lectura del .txt en downloadsPath (equiv. opción B Python/Selenium,
 * pero en Node/Playwright: CDP ya está en applyChromiumDownloadPolicyViaCdp; ruta absoluta en
 * resolveBanescoPlaywrightDownloadsPath).
 */
async function clickExportAndObtainBuffer(page, locator, timeoutMs, clickOpts, absoluteDownloadsDir) {
  const exportPostResponses = [];
  const onExportPost = (response) => {
    try {
      if (response.request().method() !== "POST") return;
      const u = response.url();
      if (!/Exportar\.aspx/i.test(u) && !/ConsultaMovimientosCuenta\/Exportar/i.test(u)) return;
      if (response.status() !== 200) return;
      exportPostResponses.push(response);
    } catch {
      /* ignore */
    }
  };
  page.on("response", onExportPost);

  const downloadPromise = page
    .waitForEvent("download", { timeout: timeoutMs })
    .then((d) => ({ kind: "download", download: d }));
  const fileResponsePromise = page
    .waitForResponse(isFileLikeExportResponse, { timeout: timeoutMs })
    .then((r) => ({ kind: "response", response: r }));

  try {
    console.log(`[banesco] ${nowVET()} — Clic en descarga (Aceptar/Ok)…`);
    await locator.click({ timeout: 25000, ...clickOpts });
    console.log(
      `[banesco] ${nowVET()} — Clic enviado; esperando download / respuesta HTTP / análisis POST (máx ${timeoutMs}ms)…`
    );

    let outcome = null;
    try {
      outcome = await Promise.any([downloadPromise, fileResponsePromise]);
    } catch {
      outcome = null;
    }

    if (outcome && outcome.kind === "download") {
      const dl = outcome.download;
      const failReason =
        typeof dl.failure === "function" ? await dl.failure().catch(() => null) : null;
      if (failReason) {
        console.warn(
          `[banesco] ${nowVET()} — Evento download pero la descarga fue cancelada: ${failReason}`
        );
      } else {
        const suggestedName =
          typeof dl.suggestedFilename === "function" ? dl.suggestedFilename() : "";
        const buffer = await bufferFromPlaywrightDownload(dl, absoluteDownloadsDir);
        if (absoluteDownloadsDir) {
          persistExportBufferToDir(absoluteDownloadsDir, buffer, suggestedName);
        }
        console.log(
          `[banesco] ${nowVET()} — Archivo recibido vía download del navegador` +
            (suggestedName ? ` (${suggestedName})` : "")
        );
        return { buffer, suggestedName, source: "download" };
      }
    }

    if (outcome && outcome.kind === "response") {
      const buffer = await outcome.response.body();
      if (!isLikelyHtmlBuffer(buffer)) {
        if (absoluteDownloadsDir) {
          persistExportBufferToDir(absoluteDownloadsDir, buffer, "export-http.txt");
        }
        console.log(`[banesco] ${nowVET()} — Archivo recibido en cuerpo de respuesta HTTP`);
        return { buffer, suggestedName: "", source: "response" };
      }
    }

    await page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => {});
    if (absoluteDownloadsDir) {
      await waitForCrdownloadGone(
        absoluteDownloadsDir,
        Math.min(20000, 5000 + timeoutMs)
      );
    }
    await sleep(800);

    let sniffed = await trySniffTxtFromExportResponses(exportPostResponses);
    if (!sniffed) {
      await sleep(2000);
      sniffed = await trySniffTxtFromExportResponses(exportPostResponses);
    }
    if (!sniffed) {
      await sleep(2000);
      sniffed = await trySniffTxtFromExportResponses(exportPostResponses);
    }

    if (sniffed) {
      if (absoluteDownloadsDir) {
        persistExportBufferToDir(absoluteDownloadsDir, sniffed, "export-sniff.txt");
      }
      console.log(
        `[banesco] ${nowVET()} — TXT obtenido por análisis de POST a Exportar ` +
          `(${exportPostResponses.length} respuesta(s); cabeceras incorrectas o sin evento download)`
      );
      return { buffer: sniffed, suggestedName: "", source: "response_sniff" };
    }

    if (absoluteDownloadsDir) {
      const fromDisk = tryReadLatestBanescoTxtFromDownloadsDir(absoluteDownloadsDir);
      if (fromDisk) {
        persistExportBufferToDir(absoluteDownloadsDir, fromDisk.buffer, fromDisk.suggestedName);
        console.log(
          `[banesco] ${nowVET()} — TXT leído desde disco (downloadsPath): ${fromDisk.suggestedName}`
        );
        return {
          buffer: fromDisk.buffer,
          suggestedName: fromDisk.suggestedName,
          source: "download_disk",
        };
      }
    }

    throw new Error(
      `Sin TXT reconocible: ${exportPostResponses.length} POST a Exportar capturados. ` +
        `Probá BANESCO_HEADLESS=0, BANESCO_PLAYWRIGHT_CHANNEL=chrome, rango de fechas con movimientos, o BANESCO_DOWNLOAD_EVENT_TIMEOUT_MS.`
    );
  } finally {
    page.off("response", onExportPost);
  }
}

async function loadSession(bankAccountId) {
  const {
    rows: [row],
  } = await queryRetry(
    `SELECT session_cookies, session_saved_at
     FROM bank_accounts WHERE id = $1`,
    [bankAccountId]
  );

  if (!row?.session_cookies || !row?.session_saved_at) {
    return null;
  }

  const ageHours = (Date.now() - new Date(row.session_saved_at).getTime()) / 3600000;

  if (ageHours > SESSION_MAX_HOURS) {
    console.log(
      `[banesco] ${nowVET()} — Sesión expirada (${ageHours.toFixed(1)}h > ${SESSION_MAX_HOURS}h)`
    );
    return null;
  }

  try {
    return JSON.parse(row.session_cookies);
  } catch {
    return null;
  }
}

async function saveSession(bankAccountId, cookies) {
  await queryRetry(
    `UPDATE bank_accounts
     SET session_cookies  = $1,
         session_saved_at = now()
     WHERE id = $2`,
    [JSON.stringify(cookies), bankAccountId]
  );
}

async function doLogin() {
  console.log(`[banesco] ${nowVET()} — Iniciando login...`);

  if (!process.env.BANESCO_USER || !process.env.BANESCO_PASS) {
    throw new Error("BANESCO_USER o BANESCO_PASS no configurados en variables de entorno");
  }

  const stepMs = Number(process.env.BANESCO_LOGIN_STEP_TIMEOUT_MS || 45000);
  /** default.aspx suele aparecer 5–10 s después del segundo Aceptar; no usar el mismo tope que los campos del formulario. */
  const waitDefaultAspxMs = Number(process.env.BANESCO_DEFAULT_ASPX_WAIT_MS || 90000);
  /** Tras el 1.er Aceptar, el HTML del paso clave a veces tarda; esperar antes de localizar el input. */
  const preClaveWaitMs = Number(process.env.BANESCO_LOGIN_PRE_CLAVE_WAIT_MS || 10000);

  const shotState = getBanescoScreenshotState();

  const browser = await launchBanescoBrowser();

  try {
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
        "AppleWebKit/537.36 Chrome/124.0 Safari/537.36",
      locale: "es-VE",
      timezoneId: "America/Caracas",
      viewport: { width: 1366, height: 768 },
    });

    const page = await context.newPage();

    await page.goto(URL_LOGIN, {
      waitUntil: "load",
      timeout: 60000,
    });
    await page.waitForLoadState("networkidle", { timeout: 25000 }).catch(() => {});
    await banescoStepScreenshot(page, shotState, "01-login-page-loaded");

    // Banesco en línea: paso 1 = usuario + Aceptar; paso 2 = clave + Aceptar (mismo texto de botón).
    const selUsuario =
      'input[placeholder*="USUARIO"], input[placeholder*="Usuario"], ' +
      'input[id*="txtUsuario"], input[id*="TxtUsuario"], input[name*="Usuario"], input[type="email"]';
    const selClave =
      'input[id$="txtClave"], input[id*="txtClave"], input[id*="Clave"], #txtClave, input[type="password"]';

    let framePaso1 = null;

    try {
      console.log(`[banesco] ${nowVET()} — Login paso 1: buscando campo usuario (incl. iframes)…`);
      const found = await waitForUserFieldInAnyFrame(page, selUsuario, stepMs);
      framePaso1 = found.frame;
      console.log(
        `[banesco] ${nowVET()} — Login paso 1: campo encontrado (${page.frames().length} frame(s)) — rellenando…`
      );
      await found.loc.fill(process.env.BANESCO_USER);

      await sleep(400 + Math.floor(Math.random() * 200));
      await banescoStepScreenshot(page, shotState, "02-usuario-filled");

      console.log(`[banesco] ${nowVET()} — Login paso 1: pulsando Aceptar…`);
      const esperaPaso2 = Number(process.env.BANESCO_LOGIN_STEP2_WAIT_MS || 8000);
      await clickAceptarInFrame(framePaso1);
      console.log(
        `[banesco] ${nowVET()} — Login paso 1: Aceptar enviado — esperando carga y pausa (${esperaPaso2 / 1000}s)…`
      );
      await page.waitForLoadState("load", { timeout: stepMs }).catch(() => {});
      await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
      await sleep(Number.isFinite(esperaPaso2) ? esperaPaso2 : 8000);
      await banescoStepScreenshot(page, shotState, "03-tras-primer-aceptar-y-carga");
    } catch (e) {
      await banescoStepScreenshot(page, shotState, "error-paso1-usuario-o-primer-aceptar");
      if (process.env.BANESCO_DEBUG_SCREENSHOT) {
        await page.screenshot({ path: String(process.env.BANESCO_DEBUG_SCREENSHOT), fullPage: true });
      }
      throw new Error(`Login paso 1 (usuario / primer Aceptar): ${e.message || e}`);
    }

    try {
      console.log(
        `[banesco] ${nowVET()} — Login: esperando ${preClaveWaitMs / 1000}s antes de buscar campo clave (config: BANESCO_LOGIN_PRE_CLAVE_WAIT_MS)…`
      );
      await sleep(Number.isFinite(preClaveWaitMs) && preClaveWaitMs >= 0 ? preClaveWaitMs : 10000);
      await banescoStepScreenshot(page, shotState, "04-tras-espera-pre-clave");
      console.log(
        `[banesco] ${nowVET()} — Login paso 2: buscando campo clave (${page.frames().length} frame(s))…`
      );
      const passField = await waitForPasswordFieldInAnyFrame(page, framePaso1, selClave, stepMs);
      console.log(`[banesco] ${nowVET()} — Login paso 2: clave encontrada — rellenando…`);
      await passField.fill(process.env.BANESCO_PASS);

      await sleep(500 + Math.floor(Math.random() * 200));
      await banescoStepScreenshot(page, shotState, "05-clave-filled");

      console.log(`[banesco] ${nowVET()} — Login paso 2: segundo Aceptar…`);
      await clickAceptarVisibleInAnyFrame(page, framePaso1);
      await page.waitForLoadState("load", { timeout: stepMs }).catch(() => {});
      await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
      await banescoStepScreenshot(page, shotState, "06-tras-segundo-aceptar-y-carga");

      console.log(
        `[banesco] ${nowVET()} — Login: esperando default.aspx (típ. 5–10 s; timeout ${waitDefaultAspxMs / 1000}s)…`
      );
      await page.waitForURL(URL_POST_LOGIN_SUCCESS, { timeout: waitDefaultAspxMs });
      await banescoStepScreenshot(page, shotState, "07-default-aspx-ok");
    } catch (e) {
      await banescoStepScreenshot(page, shotState, "error-paso2-clave-o-default-aspx");
      if (process.env.BANESCO_DEBUG_SCREENSHOT) {
        await page.screenshot({ path: String(process.env.BANESCO_DEBUG_SCREENSHOT), fullPage: true });
      }
      throw new Error(`Login paso 2 (clave / segundo Aceptar / default.aspx): ${e.message || e}`);
    }

    const cookies = await context.cookies();
    console.log(`[banesco] ${nowVET()} — Login exitoso ✓`);
    await browser.close();
    return cookies;
  } catch (err) {
    await browser.close();
    throw new Error(`Login fallido: ${err.message}`);
  }
}

/**
 * Flujo del portal: movimientos → ddlCuenta → pausa → clic «Exportar» → pausa → navegación a Exportar.aspx.
 * BANESCO_SKIP_MOVIMIENTOS_CUENTA=1 → ir directo a Exportar (solo si el banco no exige este paso).
 * BANESCO_CUENTA_SELECT_VALUE: value del <option> (ej. 1); si no va, se usa index 1 (saltar opción vacía).
 * Pausas: BANESCO_POST_CUENTA_SELECT_MS (default 1500), BANESCO_POST_EXPORTAR_BTN_MS (default 2000).
 * El botón «Exportar» en movimientos se resuelve solo con selectores internos (DefBtn, XPath, etc.).
 */
async function navegarExportarSeleccionandoCuenta(page) {
  if (String(process.env.BANESCO_SKIP_MOVIMIENTOS_CUENTA || "").trim() === "1") {
    console.log(
      `[banesco] ${nowVET()} — BANESCO_SKIP_MOVIMIENTOS_CUENTA=1 → Exportar.aspx directo`
    );
    await page.goto(URL_EXPORTAR, {
      waitUntil: "networkidle",
      timeout: Number(process.env.BANESCO_MOVIMIENTOS_GOTO_TIMEOUT_MS || 45000),
    });
    if (page.url().toLowerCase().includes("login")) {
      throw new Error("SESSION_EXPIRED");
    }
    return;
  }

  if (page.url().toLowerCase().includes("exportar.aspx")) {
    console.log(`[banesco] ${nowVET()} — Ya en Exportar.aspx`);
    return;
  }

  const gotoMs = Number(process.env.BANESCO_MOVIMIENTOS_GOTO_TIMEOUT_MS || 45000);
  console.log(`[banesco] ${nowVET()} — Abriendo movimientos de cuenta → ${URL_MOVIMIENTOS_CUENTA}`);
  await page.goto(URL_MOVIMIENTOS_CUENTA, {
    waitUntil: "networkidle",
    timeout: gotoMs,
  });
  if (page.url().toLowerCase().includes("login")) {
    throw new Error("SESSION_EXPIRED");
  }
  if (page.url().toLowerCase().includes("exportar.aspx")) {
    console.log(`[banesco] ${nowVET()} — Redirigido a Exportar.aspx sin abrir ddlCuenta`);
    return;
  }

  const sel = '#ctl00_cp_ddlCuenta, select[name="ctl00$cp$ddlCuenta"]';
  let loc = null;
  for (const frame of page.frames()) {
    const l = frame.locator(sel).first();
    if ((await l.count().catch(() => 0)) > 0) {
      loc = l;
      break;
    }
  }
  if (!loc) {
    if (page.url().toLowerCase().includes("exportar.aspx")) {
      return;
    }
    throw new Error(
      "No se encontró ddlCuenta (#ctl00_cp_ddlCuenta). Probá BANESCO_SKIP_MOVIMIENTOS_CUENTA=1 o BANESCO_MOVIMIENTOS_CUENTA_URL."
    );
  }

  const rawVal = process.env.BANESCO_CUENTA_SELECT_VALUE;
  const valueToUse =
    rawVal != null && String(rawVal).trim() !== "" ? String(rawVal).trim() : null;
  const timeoutNav = Number(process.env.BANESCO_CUENTA_NAV_TIMEOUT_MS || 60000);

  console.log(`[banesco] ${nowVET()} — Seleccionando cuenta en ddlCuenta…`);

  try {
    if (valueToUse) {
      await loc.selectOption({ value: valueToUse }, { timeout: 15000, force: true });
    } else {
      await loc.selectOption({ index: 1 }, { timeout: 15000, force: true });
    }
  } catch (e1) {
    console.warn(`[banesco] ${nowVET()} — ddlCuenta: (${e1.message || e1})`);
    if (!valueToUse) {
      await loc
        .selectOption({ label: /Cuenta Corriente|C\/Intereses/i }, { timeout: 12000, force: true })
        .catch(() => {});
    }
  }

  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});

  const pauseBeforeExportarBtnMs = Number(process.env.BANESCO_POST_CUENTA_SELECT_MS || 1500);
  console.log(
    `[banesco] ${nowVET()} — Pausa ${pauseBeforeExportarBtnMs}ms antes del botón Exportar…`
  );
  await sleep(pauseBeforeExportarBtnMs);

  /**
   * Clic en el submit «Exportar» del paso movimientos.
   * El botón real está en el panel #content-right (tablas ASP.NET); un selector global puede
   * acertar otro control o un duplicado y el postback no navega a Exportar.aspx.
   * DevTools: div#content-right > table.TDat > td.NoBr.Cent con «Consultar» + «Exportar» (sin id en Exportar).
   * Fallback nth si cambia el árbol: SEL_EXPORTAR_MOVIMIENTOS_TABLA.
   */
  const SEL_EXPORTAR_MOVIMIENTOS_TABLA =
    "#content-right > table:nth-child(14) > tbody > tr:nth-child(6) > td > input:nth-child(2)";

  async function tryClickExportarInContext(ctx) {
    /** Prioridad: TDat / misma celda que Consultar; luego #content-right genérico. */
    const attempts = [
      {
        label: "css hermano de Consultar (btnMostrar)",
        loc: () =>
          ctx.locator(
            '#content-right input#ctl00_cp_btnMostrar ~ input[value="Exportar"]'
          ),
      },
      {
        label: "css table.TDat td.NoBr.Cent Exportar",
        loc: () =>
          ctx.locator(
            '#content-right table.TDat td.NoBr.Cent input[type="submit"][value="Exportar"]'
          ),
      },
      {
        label: "css table.TDat td Exportar",
        loc: () =>
          ctx.locator(
            '#content-right table.TDat td input[type="submit"][value="Exportar"]'
          ),
      },
      {
        label: "xpath TDat celda Cent Exportar",
        loc: () =>
          ctx.locator(
            "xpath=//div[@id='content-right']//table[contains(@class,'TDat')]//td[contains(@class,'Cent')]//input[@type='submit' and @value='Exportar']"
          ),
      },
      {
        label: "css #content-right DefBtn+submit+Exportar",
        loc: () =>
          ctx.locator('#content-right input.DefBtn[type="submit"][value="Exportar"]'),
      },
      {
        label: "css #content-right submit Exportar",
        loc: () =>
          ctx.locator('#content-right input[type="submit"][value="Exportar"]'),
      },
      {
        label: "css #content-right tabla nth→Exportar",
        loc: () => ctx.locator(SEL_EXPORTAR_MOVIMIENTOS_TABLA),
      },
      {
        label: "css DefBtn+submit+Exportar (global)",
        loc: () => ctx.locator('input.DefBtn[type="submit"][value="Exportar"]'),
      },
      {
        label: "css DefBtn+Exportar (global)",
        loc: () => ctx.locator('input.DefBtn[value="Exportar"]'),
      },
      {
        label: "xpath submit DefBtn exacto",
        loc: () =>
          ctx.locator(
            "xpath=//input[@type='submit' and @value='Exportar' and @class='DefBtn']"
          ),
      },
      {
        label: "xpath name ctl26",
        loc: () =>
          ctx.locator(
            "xpath=//input[@type='submit' and @name='ctl00$cp$ctl26' and @value='Exportar']"
          ),
      },
      { label: "getByRole(button,Exportar)", loc: () => ctx.getByRole("button", { name: "Exportar" }) },
      {
        label: "xpath DefBtn contains class",
        loc: () =>
          ctx.locator(
            "xpath=//input[contains(@class,'DefBtn') and @type='submit' and @value='Exportar']"
          ),
      },
      {
        label: "xpath submit Exportar",
        loc: () => ctx.locator("xpath=//input[@type='submit' and @value='Exportar']"),
      },
      {
        label: "css submit Exportar",
        loc: () => ctx.locator('input[type="submit"][value="Exportar"]'),
      },
    ];

    try {
      const didFirst = await ctx.evaluate((selTabla) => {
        /** Solo clic en el DOM (eventos + HTMLElement.click); sin WebForm_DoPostBack/__doPostBack. */
        function fireRealClick(el) {
          if (!el) return false;
          try {
            el.dispatchEvent(
              new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window })
            );
            el.dispatchEvent(
              new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window })
            );
            el.dispatchEvent(
              new MouseEvent("click", { bubbles: true, cancelable: true, view: window })
            );
          } catch (_) {
            /* ignore */
          }
          if (typeof el.click === "function") el.click();
          return true;
        }
        function findExportarInput() {
          const q = [
            () =>
              document.querySelector(
                '#content-right input#ctl00_cp_btnMostrar ~ input[value="Exportar"]'
              ),
            () =>
              document.querySelector(
                '#content-right table.TDat td.NoBr.Cent input[type="submit"][value="Exportar"]'
              ),
            () =>
              document.querySelector(
                '#content-right table.TDat td[class*="NoBr"][class*="Cent"] input[type="submit"][value="Exportar"]'
              ),
            () =>
              document.querySelector(
                '#content-right table.TDat td input[type="submit"][value="Exportar"]'
              ),
            () =>
              document.evaluate(
                "//div[@id='content-right']//table[contains(@class,'TDat')]//td[contains(@class,'Cent')]//input[@type='submit' and @value='Exportar']",
                document,
                null,
                XPathResult.FIRST_ORDERED_NODE_TYPE,
                null
              ).singleNodeValue,
            () => (selTabla ? document.querySelector(selTabla) : null),
            () =>
              document.querySelector(
                '#content-right input.DefBtn[type="submit"][value="Exportar"]'
              ),
            () =>
              document.querySelector('#content-right input[type="submit"][value="Exportar"]'),
            () =>
              document.querySelector('input.DefBtn[type="submit"][value="Exportar"]'),
            () => document.querySelector('input[type="submit"][value="Exportar"]'),
          ];
          for (const fn of q) {
            try {
              const n = fn();
              if (n) return n;
            } catch (_) {
              /* ignore */
            }
          }
          return null;
        }
        const el = findExportarInput();
        if (!el) return false;
        fireRealClick(el);
        return "dom-click";
      }, SEL_EXPORTAR_MOVIMIENTOS_TABLA);
      if (didFirst) {
        console.log(
          `[banesco] ${nowVET()} — Clic Exportar (evaluate DOM primero: ${didFirst})`
        );
        return true;
      }
    } catch (_) {
      /* ignore */
    }

    for (const { label, loc } of attempts) {
      const btn = loc().first();
      const n = await btn.count().catch(() => 0);
      if (n === 0) continue;
      try {
        await btn.scrollIntoViewIfNeeded({ timeout: 8000 }).catch(() => {});
        await btn.click({ timeout: 18000, force: true });
        console.log(`[banesco] ${nowVET()} — Clic Exportar (${label})`);
        return true;
      } catch (e1) {
        try {
          await btn.evaluate((el) => {
            if (el && typeof el.click === "function") el.click();
          });
          console.log(`[banesco] ${nowVET()} — Clic Exportar via evaluate (${label})`);
          return true;
        } catch (e2) {
          console.warn(
            `[banesco] ${nowVET()} — Exportar falló (${label}): ${e1.message || e1}`
          );
        }
      }
    }
    return false;
  }

  /** Marco principal primero: el panel #content-right suele estar ahí; si se recorre otro frame antes, el clic puede ser inútil. */
  let clickedExportar = await tryClickExportarInContext(page);
  if (!clickedExportar) {
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      if (await tryClickExportarInContext(frame)) {
        clickedExportar = true;
        break;
      }
    }
  }
  if (!clickedExportar) {
    throw new Error(
      "No se encontró o no se pudo hacer clic en el botón Exportar tras ddlCuenta."
    );
  }

  const pauseAfterExportarMs = Number(process.env.BANESCO_POST_EXPORTAR_BTN_MS || 2000);
  console.log(
    `[banesco] ${nowVET()} — Esperando ${pauseAfterExportarMs}ms por redirección a Exportar.aspx…`
  );
  await sleep(pauseAfterExportarMs);

  await page.waitForURL(/Exportar\.aspx/i, { timeout: timeoutNav });
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});

  if (page.url().toLowerCase().includes("login")) {
    throw new Error("SESSION_EXPIRED");
  }
  if (!page.url().toLowerCase().includes("exportar.aspx")) {
    console.warn(
      `[banesco] ${nowVET()} — URL tras Exportar no es Exportar.aspx: ${page.url()} — se intenta continuar`
    );
  } else {
    console.log(`[banesco] ${nowVET()} — En Exportar.aspx ✓`);
  }
}

/**
 * Descarga del TXT: _configurarFormulario (mismos clics que el flujo acordado: iframe + radios +
 * delimitador |) + Promise.all(waitForEvent("download"), clic en Aceptar visible) y stream en memoria (latin1).
 */
async function downloadTxt(cookies) {
  if (process.env.BANESCO_HEADLESS === "0") {
    console.log(
      `[banesco] ${nowVET()} — Exportar: ventana del navegador visible (BANESCO_HEADLESS=0)`
    );
  }

  const browser = await launchBanescoBrowser();

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36",
    locale: "es-VE",
    timezoneId: "America/Caracas",
    viewport: { width: 1366, height: 768 },
    acceptDownloads: true,
  });

  await context.addCookies(cookies);
  const page = await context.newPage();

  try {
    await navegarExportarSeleccionandoCuenta(page);

    if (page.url().toLowerCase().includes("login")) {
      throw new Error("SESSION_EXPIRED");
    }

    await _configurarFormulario(page);

    const downloadTimeoutMs = Number(process.env.BANESCO_DOWNLOAD_EVENT_TIMEOUT_MS || 30000);

    const { locator } = await resolveVisibleExportDownloadButton(page);

    console.log(`[banesco] ${nowVET()} — Click en Aceptar, esperando download...`);

    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: downloadTimeoutMs }),
      locator.click({ timeout: 25000, force: true }),
    ]);

    console.log(`[banesco] Download capturado: ${download.suggestedFilename()}`);

    const stream = await download.createReadStream();
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const buffer = Buffer.concat(chunks);

    if (buffer.length < 10) {
      await browser.close().catch(() => {});
      throw new Error(`Archivo demasiado pequeño: ${buffer.length} bytes`);
    }

    if (shouldRestoreBanescoExportUiAfterDownload()) {
      try {
        console.log(
          `[banesco] ${nowVET()} — Re-abriendo Exportar y re-aplicando parámetros (misma selección; sin segunda descarga)…`
        );
        await navegarExportarSeleccionandoCuenta(page);
        if (page.url().toLowerCase().includes("login")) {
          console.warn(
            `[banesco] ${nowVET()} — Post-descarga: sesión expirada al re-armar UI (el archivo ya se obtuvo).`
          );
        } else {
          await _configurarFormulario(page);
          const pauseMs = Number(process.env.BANESCO_EXPORT_RESTORE_UI_PAUSE_MS || 1500);
          await sleep(pauseMs);
        }
      } catch (e) {
        console.warn(
          `[banesco] ${nowVET()} — Post-descarga no se pudo re-armar la UI:`,
          e.message || e
        );
      }
    } else {
      console.log(
        `[banesco] ${nowVET()} — Post-descarga: no se re-arma el formulario (BANESCO_EXPORT_RESTORE_UI_AFTER_DOWNLOAD=0)`
      );
    }

    await browser.close();

    const content = buffer.toString("latin1");

    console.log(
      `[banesco] ${nowVET()} — Descarga exitosa: ${buffer.length} bytes | ` +
        `${content.split("\n").filter((l) => l.trim()).length} líneas`
    );

    return content;
  } catch (err) {
    try {
      await browser.close();
    } catch {
      /* ya cerrado */
    }
    throw err;
  }
}

/**
 * Banesco suele cargar Exportar.aspx dentro de un iframe; `page.evaluate` solo ve el frame principal.
 * Buscamos el frame que contiene el formulario real.
 */
async function findFrameWithExportForm(page) {
  for (const frame of page.frames()) {
    try {
      const ok = await frame.evaluate(() => {
        return !!(
          document.querySelector("#ctl00_cp_btnOk") ||
          document.querySelector('input[name="ctl00$cp$btnOk"]') ||
          document.querySelector('input[name="ctl00$cp$rbFormato"]') ||
          document.querySelector("#ctl00_cp_rbFormato_1")
        );
      });
      if (ok) {
        return frame;
      }
    } catch {
      /* frame aún cargando o cross-origin */
    }
  }
  return null;
}

/** Solo clic real en el botón Aceptar visible (sin __doPostBack ni click() por evaluate). */
async function clickExportarAceptarEnFrame(page) {
  const { locator, sel, frameLabel } = await resolveVisibleExportDownloadButton(page);
  console.log(
    `[banesco] ${nowVET()} — Exportar: clic en Aceptar (selector=${sel}, frame=${frameLabel})`
  );
  await locator.click({ timeout: 25000, force: true });
}

/**
 * Carácter de campo en el TXT que genera el portal: «;» (default) o «|».
 * Override: BANESCO_EXPORT_FIELD_DELIMITER=|  —  BANESCO_EXPORT_DELIMITER_OPTION_VALUE=2 si hace falta forzar value del <option>.
 */
function getBanescoExportFieldDelimiter() {
  const v = String(process.env.BANESCO_EXPORT_FIELD_DELIMITER ?? ";").trim();
  if (v === ";" || v === "|") return v;
  return ";";
}

/**
 * Selecciona el delimitador de campos en el <select> (punto y coma o barra vertical).
 */
async function seleccionarDelimitadorCampoEnFrame(frame) {
  const delimiterChar = getBanescoExportFieldDelimiter();
  const forcedValue =
    process.env.BANESCO_EXPORT_DELIMITER_OPTION_VALUE != null &&
    String(process.env.BANESCO_EXPORT_DELIMITER_OPTION_VALUE).trim() !== ""
      ? String(process.env.BANESCO_EXPORT_DELIMITER_OPTION_VALUE).trim()
      : null;

  const result = await frame.evaluate(
    ({ delimiterChar: char, forcedValue: forced }) => {
      const out = { ok: false, detail: null, debug: [] };
      const candidates = [];
      for (const sel of document.querySelectorAll("select[name*='ddlDelimitador' i]")) {
        candidates.push(sel);
      }
      for (const sel of document.querySelectorAll("select[id*='ddlDelimitador' i]")) {
        if (!candidates.includes(sel)) {
          candidates.push(sel);
        }
      }
      if (candidates.length === 0) {
        for (const sel of document.querySelectorAll("select")) {
          const lab = (sel.name || "") + (sel.id || "");
          if (/delimit/i.test(lab)) {
            candidates.push(sel);
          }
        }
      }

      function pickDelimiterOption(selectEl, want) {
        const opts = [...selectEl.options];
        if (forced) {
          for (let i = 0; i < opts.length; i++) {
            const opt = opts[i];
            if (String(opt.value ?? "").trim() === forced) {
              return { index: i, value: opt.value, text: String(opt.text ?? "").trim() };
            }
          }
        }
        for (let i = 0; i < opts.length; i++) {
          const opt = opts[i];
          const v = String(opt.value ?? "").trim();
          const tRaw = String(opt.text ?? "").trim();
          const tCompact = tRaw.replace(/\s+/g, "");
          if (want === "|") {
            if (
              v === "|" ||
              v === "%7C" ||
              tCompact === "|" ||
              tRaw === "|" ||
              /^[|｜¦\u2502\uFF5C]$/.test(tCompact) ||
              (/barra|pipe|vertical/i.test(tRaw) && /[|｜]/.test(tRaw))
            ) {
              return { index: i, value: opt.value, text: tRaw };
            }
          } else {
            if (
              v === ";" ||
              v === "%3B" ||
              tCompact === ";" ||
              /punto\s*y\s*coma/i.test(tRaw) ||
              (tRaw.includes(";") && !/\|/.test(tRaw))
            ) {
              return { index: i, value: opt.value, text: tRaw };
            }
          }
        }
        return null;
      }

      for (const sel of candidates) {
        const picked = pickDelimiterOption(sel, char);
        out.debug.push({
          name: sel.name,
          id: sel.id,
          disabled: sel.disabled,
          optionSample: [...sel.options].slice(0, 16).map((o) => ({ v: o.value, t: o.text.trim().slice(0, 32) })),
        });
        if (sel.disabled) {
          continue;
        }
        if (picked) {
          sel.selectedIndex = picked.index;
          sel.value = picked.value;
          sel.dispatchEvent(new Event("input", { bubbles: true }));
          sel.dispatchEvent(new Event("change", { bubbles: true }));
          try {
            const ev = new Event("click", { bubbles: true });
            sel.dispatchEvent(ev);
          } catch {
            /* ignore */
          }
          out.ok = true;
          out.detail = { name: sel.name, id: sel.id, ...picked };
          return out;
        }
      }
      return out;
    },
    { delimiterChar, forcedValue }
  );

  const label = delimiterChar === ";" ? "punto y coma" : "barra vertical";
  if (result.ok) {
    console.log(`[banesco] ${nowVET()} — Delimitador de campo «${delimiterChar}» (${label}): DOM OK`, result.detail);
    return true;
  }
  console.warn(
    `[banesco] ${nowVET()} — Delimitador «${delimiterChar}»: DOM sin coincidencia; opciones:`,
    JSON.stringify(result.debug).slice(0, 2500)
  );
  return false;
}

/** Fallback Playwright si el evaluate no encontró el combo. */
async function seleccionarDelimitadorCampoPlaywrightFallback(frame) {
  const delimiterChar = getBanescoExportFieldDelimiter();
  const loc = frame
    .locator(
      'select[name*="ddlDelimitador" i], select[id*="ddlDelimitador" i], #ctl00_cp_ddlDelimitadores, #ctl00_cp_ddlDelimitador'
    )
    .first();
  const forced = process.env.BANESCO_EXPORT_DELIMITER_OPTION_VALUE;
  try {
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    const count = await loc.count();
    if (count === 0) {
      return;
    }
    if (forced != null && String(forced).trim() !== "") {
      try {
        await loc.selectOption({ value: String(forced).trim() }, { timeout: 6000, force: true });
        console.log(
          `[banesco] ${nowVET()} — Delimitador: Playwright fallback por BANESCO_EXPORT_DELIMITER_OPTION_VALUE=${forced}`
        );
        return;
      } catch {
        /* siguiente */
      }
    }
    const specsPipe = [
      { value: "|" },
      { label: "|" },
      { label: /\|/ },
      { index: 1 },
      { index: 2 },
      { index: 0 },
    ];
    const specsSemi = [
      { value: ";" },
      { label: ";" },
      { label: /;/ },
      { label: /punto\s*y\s*coma/i },
      { index: 2 },
      { index: 1 },
      { index: 0 },
    ];
    const specs = delimiterChar === ";" ? specsSemi : specsPipe;
    for (const spec of specs) {
      try {
        await loc.selectOption(spec, { timeout: 6000, force: true });
        console.log(
          `[banesco] ${nowVET()} — Delimitador «${delimiterChar}»: Playwright fallback OK`,
          spec
        );
        return;
      } catch {
        /* siguiente */
      }
    }
  } catch (e) {
    console.warn(`[banesco] ${nowVET()} — Delimitador fallback Playwright:`, e.message || e);
  }
}

/**
 * Quita el foco del combo de delimitadores (blur + Escape) para que no quede abierto
 * ni bloqueando el clic en «Aceptar». La opción elegida no se pierde al hacer blur.
 */
async function soltarFocoTrasDelimitador(frame) {
  await frame.evaluate(() => {
    const q =
      "select[name*='ddlDelimitador' i], select[id*='ddlDelimitador' i], #ctl00_cp_ddlDelimitadores, #ctl00_cp_ddlDelimitador";
    for (const sel of document.querySelectorAll(q)) {
      try {
        sel.blur();
      } catch {
        /* ignore */
      }
    }
    const ae = document.activeElement;
    if (ae && ae !== document.body && typeof ae.blur === "function") {
      try {
        ae.blur();
      } catch {
        /* ignore */
      }
    }
  });
  try {
    await frame.locator("body").first().press("Escape");
  } catch {
    /* ignore */
  }
  console.log(`[banesco] ${nowVET()} — Foco liberado tras delimitador (listo para Aceptar)`);
}

/**
 * Opciones acordadas: formato «Configurar Parámetros» (valor Personalizado),
 * división «Delimitador», carácter de campo «;» o «|» (BANESCO_EXPORT_FIELD_DELIMITER).
 * Usa clics Playwright (como el usuario) + ids/names reales del portal; no el primer <select> del DOM.
 */
async function _configurarFormulario(page) {
  const found = await findFrameWithExportForm(page);
  const frame = found || page.frames()[0];
  if (found) {
    console.log(
      `[banesco] ${nowVET()} — Configurando radios/select en frame con formulario Exportar (${(found.url() || "").slice(0, 100)})`
    );
  }

  async function tryClickRadio(selectors, stepLabel) {
    for (const sel of selectors) {
      const loc = frame.locator(sel).first();
      try {
        if ((await loc.count()) === 0) {
          continue;
        }
        await loc.scrollIntoViewIfNeeded().catch(() => {});
        await loc.click({ timeout: 12000, force: true });
        console.log(`[banesco] ${nowVET()} — ${stepLabel}: clic OK → ${sel}`);
        return true;
      } catch {
        /* siguiente selector */
      }
    }
    console.warn(`[banesco] ${nowVET()} — ${stepLabel}: no se pudo cliquear ningún selector`);
    return false;
  }

  await tryClickRadio(
    [
      "#ctl00_cp_rbFormato_1",
      'input[name="ctl00$cp$rbFormato"][value="Personalizado"]',
      'label:has-text("Configurar Parámetros")',
    ],
    "Formato «Configurar Parámetros» (Personalizado)"
  );
  try {
    const grp = frame.locator('input[type="radio"][name="ctl00$cp$rbFormato"]');
    const n = await grp.count();
    if (n >= 2) {
      const checked = await frame.evaluate(() => {
        const el = document.querySelector('input[name="ctl00$cp$rbFormato"]:checked');
        return el ? el.value : null;
      });
      if (checked !== "Personalizado") {
        await grp.nth(1).click({ timeout: 12000, force: true });
        console.log(
          `[banesco] ${nowVET()} — Formato: fallback nth(1) en grupo rbFormato (${n} radios)`
        );
      }
    }
  } catch (e) {
    console.warn(`[banesco] ${nowVET()} — Formato: fallback nth rbFormato:`, e.message || e);
  }

  await sleep(800);

  await tryClickRadio(
    [
      'input[name="ctl00$cp$rbDivision"][value="optDelimitador"]',
      "#ctl00_cp_rbDivision_1",
      'label:has-text("Delimitador")',
    ],
    "División «Delimitador»"
  );
  try {
    const grpD = frame.locator('input[type="radio"][name="ctl00$cp$rbDivision"]');
    const nd = await grpD.count();
    if (nd >= 2) {
      const checkedD = await frame.evaluate(() => {
        const el = document.querySelector('input[name="ctl00$cp$rbDivision"]:checked');
        return el ? el.value : null;
      });
      if (!checkedD || !String(checkedD).toLowerCase().includes("delimit")) {
        await grpD.nth(1).click({ timeout: 12000, force: true });
        console.log(
          `[banesco] ${nowVET()} — División: fallback nth(1) en grupo rbDivision (${nd} radios)`
        );
      }
    }
  } catch (e) {
    console.warn(`[banesco] ${nowVET()} — División: fallback nth rbDivision:`, e.message || e);
  }

  await sleep(600);

  await frame
    .waitForFunction(
      () => {
        const sel =
          document.querySelector("select[name*='ddlDelimitador' i]") ||
          document.querySelector("select[id*='ddlDelimitador' i]");
        return sel && !sel.disabled && sel.options && sel.options.length > 0;
      },
      null,
      { timeout: 15000 }
    )
    .catch(() => {});

  const delimOk = await seleccionarDelimitadorCampoEnFrame(frame);
  if (!delimOk) {
    await seleccionarDelimitadorCampoPlaywrightFallback(frame);
  }

  const _dChar = getBanescoExportFieldDelimiter();
  console.log(
    `[banesco] ${nowVET()} — Pausa 2s tras seleccionar delimitador de campo «${_dChar}»…`
  );
  await sleep(2000);

  await soltarFocoTrasDelimitador(frame);

  const estado = await frame.evaluate(() => {
    const rf = document.querySelector('input[name="ctl00$cp$rbFormato"]:checked');
    const rd = document.querySelector('input[name="ctl00$cp$rbDivision"]:checked');
    let sel =
      document.querySelector('select[name="ctl00$cp$ddlDelimitadores"]') ||
      document.querySelector('select[name="ctl00$cp$ddlDelimitador"]') ||
      document.querySelector("#ctl00_cp_ddlDelimitadores") ||
      document.querySelector("#ctl00_cp_ddlDelimitador");
    if (!sel) {
      sel = document.querySelector("select[name*='ddlDelimitador' i]");
    }
    const opt = sel && sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex] : null;
    const textoOpt = opt ? String(opt.text || "").trim() : null;
    return {
      rbFormato: rf ? rf.value : null,
      rbDivision: rd ? rd.value : null,
      ddlDelimitador: sel ? sel.value : null,
      ddlDelimitadorTexto: textoOpt,
    };
  });
  console.log(`[banesco] ${nowVET()} — Estado Exportar antes de Aceptar:`, estado);

  if (estado.rbFormato && estado.rbFormato !== "Personalizado") {
    console.warn(
      `[banesco] ${nowVET()} — Aviso: rbFormato="${estado.rbFormato}" (se esperaba Personalizado)`
    );
  }
  if (estado.rbDivision && !/delimit/i.test(String(estado.rbDivision))) {
    console.warn(
      `[banesco] ${nowVET()} — Aviso: rbDivision="${estado.rbDivision}" (se esperaba opción Delimitador)`
    );
  }
  const txt = estado.ddlDelimitadorTexto || "";
  const val = estado.ddlDelimitador || "";
  const want = getBanescoExportFieldDelimiter();
  if (want === "|") {
    if (txt && !/[|｜]/.test(txt) && val !== "|" && !/^[|｜]/.test(String(val))) {
      console.warn(
        `[banesco] ${nowVET()} — Aviso: delimitador no parece «|» (texto="${txt}" value="${val}")`
      );
    }
  } else if (want === ";") {
    if (txt && !/;/.test(txt) && val !== ";" && val !== "%3B") {
      console.warn(
        `[banesco] ${nowVET()} — Aviso: delimitador no parece «;» (texto="${txt}" value="${val}")`
      );
    }
  }
}

function stripBom(s) {
  if (!s) return s;
  const t = String(s);
  if (t.charCodeAt(0) === 0xfeff) return t.slice(1);
  return t;
}

/** Fecha tipo DD/MM/YYYY, DD-MM-YYYY o DD.MM.YYYY (día primero). */
function parseFechaToIso(fechaRaw) {
  const t = stripBom(String(fechaRaw || "").trim());
  if (!t) return null;
  const partesFecha = t.split(/[/.\-]/);
  if (partesFecha.length !== 3) return null;
  const [dd, mm, yyyy] = partesFecha.map((x) => String(x).trim());
  if (!yyyy || yyyy.length < 4) return null;
  return `${yyyy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

/**
 * Importe en columna Débito/Crédito del TXT: suele ser positivo, pero Banesco a veces manda
 * el débito como negativo o entre paréntesis. `parseVenezuelanNumber` rechaza negativos (sanity
 * pensada para tasas BCV), así que normalizamos signo antes.
 */
function parseAmountColumnUnsigned(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return 0;
  const unsigned = s.replace(/^\(+|\)+$/g, "").replace(/^[+-]/, "").trim();
  if (!unsigned) return 0;
  return Math.abs(parseVenezuelanNumber(unsigned) || 0);
}

function paymentTypeFromDescription(description) {
  const descUpper = String(description || "").toUpperCase();
  if (descUpper.includes("PAGO MOVIL") || descUpper.includes("PAGO MÓ")) {
    return "PAGO_MOVIL";
  }
  if (descUpper.includes("TRF") || descUpper.includes("TRANSF")) {
    return "TRANSFERENCIA";
  }
  return "OTRO";
}

/**
 * Elige el separador de campo (; primero — suele ir mejor con montos 1.234,56).
 * Override: BANESCO_CSV_DELIMITER=; o =|
 */
function detectDelimiter(sampleLines) {
  const candidates = [
    [";", ";"],
    ["|", "|"],
    ["\t", "TAB"],
  ];
  let bestDelim = ";";
  let bestScore = -1;
  for (const [delim] of candidates) {
    let score = 0;
    for (const line of sampleLines) {
      const n = line.split(delim).length;
      if (n >= 6) score += 3;
      else if (n >= 5) score += 2;
      else if (n >= 4) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      bestDelim = delim;
    }
  }
  return bestDelim;
}

/** Columna “vacía” entre descripción e importe (espacios, NBSP, etc.). */
function isBlankGapColumn(s) {
  return !String(s ?? "").replace(/\s/g, "").length;
}

function resolveCsvDelimiter(sampleLines) {
  const raw = process.env.BANESCO_CSV_DELIMITER;
  const d = raw != null ? String(raw).trim() : "";
  if (d === ";" || d === "|" || d === "\\t" || d === "TAB") {
    return d === "\\t" || d === "TAB" ? "\t" : d;
  }
  return detectDelimiter(sampleLines);
}

/** Una fila: fecha, ref, descripción, monto (+/-), saldo (opcional). */
function parseLineaFiveCols(cols) {
  const [fechaRaw, refRaw, descRaw, montoRaw, saldoRaw] = cols;

  const txDate = parseFechaToIso(fechaRaw);
  if (!txDate) return null;

  const reference = (refRaw || "").trim() || null;
  const description = (descRaw || "").trim();

  const montoStr = (montoRaw || "").trim();
  /** Algunos extractos usan paréntesis para cargos: (1.234,56) */
  const isDebit =
    montoStr.startsWith("-") || /^\(/.test(montoStr.replace(/^\s+/, ""));
  const txType = isDebit ? "DEBIT" : "CREDIT";
  const montoSinSigno = montoStr
    .replace(/^\(+|\)+$/g, "")
    .replace(/^[+-]/, "");
  const amount = parseVenezuelanNumber(montoSinSigno);

  if (!amount || amount <= 0) return null;

  const balanceAfter = parseVenezuelanNumber((saldoRaw || "").trim());

  const rowHash = crypto
    .createHash("md5")
    .update(`${cols[0]}|${cols[1]}|${cols[3]}`)
    .digest("hex");

  return {
    tx_date: txDate,
    reference_number: reference,
    description,
    tx_type: txType,
    amount,
    balance_after: balanceAfter || null,
    payment_type: paymentTypeFromDescription(description),
    row_hash: rowHash,
  };
}

/**
 * Variante: fecha, ref, desc, débito, crédito, saldo (columnas separadas).
 * Algunos extractos Banesco traen el orden invertido: crédito | débito (columnas 4–5).
 */
function parseLineaSixCols(cols) {
  const [fechaRaw, refRaw, descRaw, debitoRaw, creditoRaw, saldoRaw] = cols;

  const txDate = parseFechaToIso(fechaRaw);
  if (!txDate) return null;

  const reference = (refRaw || "").trim() || null;
  const description = (descRaw || "").trim();

  const debito = parseAmountColumnUnsigned(debitoRaw);
  const credito = parseAmountColumnUnsigned(creditoRaw);

  let amount;
  let txType;
  if (credito > 0 && debito === 0) {
    amount = credito;
    txType = "CREDIT";
  } else if (debito > 0 && credito === 0) {
    amount = debito;
    txType = "DEBIT";
  } else if (credito > 0 && debito > 0) {
    return null;
  } else {
    return null;
  }

  const balanceAfter = parseVenezuelanNumber((saldoRaw || "").trim());

  const rowHash = crypto
    .createHash("md5")
    .update(`${cols[0]}|${cols[1]}|${debitoRaw}|${creditoRaw}`)
    .digest("hex");

  return {
    tx_date: txDate,
    reference_number: reference,
    description,
    tx_type: txType,
    amount,
    balance_after: balanceAfter || null,
    payment_type: paymentTypeFromDescription(description),
    row_hash: rowHash,
  };
}

/**
 * Resuelve orden Débito|Crédito vs Crédito|Débito en columnas 4–5.
 * BANESCO_CSV_SIXCOL_CREDITO_FIRST=1 asume que en el TXT la columna 4 es crédito y la 5 débito.
 */
function parseLineaSixColsBest(trimmed) {
  const swapped = [
    trimmed[0],
    trimmed[1],
    trimmed[2],
    trimmed[4],
    trimmed[3],
    trimmed[5],
  ];
  if (String(process.env.BANESCO_CSV_SIXCOL_CREDITO_FIRST || "").trim() === "1") {
    return parseLineaSixCols(swapped) || parseLineaSixCols(trimmed);
  }

  const std = parseLineaSixCols(trimmed);
  const alt = parseLineaSixCols(swapped);

  if (std && alt && std.amount === alt.amount && std.tx_type !== alt.tx_type) {
    const v3 = parseAmountColumnUnsigned(trimmed[3]);
    const v4 = parseAmountColumnUnsigned(trimmed[4]);
    /** Solo importe en col.5: suele ser archivo Crédito|Débito mal leído como Débito|Crédito */
    if (v3 === 0 && v4 > 0 && std.tx_type === "CREDIT" && alt.tx_type === "DEBIT") {
      return alt;
    }
    /** Solo importe en col.4: orden Débito|Crédito clásico */
    if (v4 === 0 && v3 > 0 && std.tx_type === "DEBIT" && alt.tx_type === "CREDIT") {
      return std;
    }
  }
  if (std) return std;
  return alt;
}

/** Quita celdas vacías finales (línea que termina en |). */
function trimTrailingEmptyCols(trimmed) {
  const out = [...trimmed];
  while (out.length > 0 && out[out.length - 1] === "") {
    out.pop();
  }
  return out;
}

/**
 * Banesco exporta a veces: fecha|ref|descripción| columna vacía | ±importe | saldo
 * (un solo monto con +/−, no dos columnas débito/crédito).
 */
function parseLineaBanescoSignedAmountSixCols(trimmed) {
  if (trimmed.length < 6) return null;
  if (!isBlankGapColumn(trimmed[3])) return null;
  return parseLineaFiveCols([
    trimmed[0],
    trimmed[1],
    trimmed[2],
    trimmed[4],
    trimmed[5],
  ]);
}

function parseLineaColumns(cols) {
  const trimmed = trimTrailingEmptyCols(cols.map((c) => String(c || "").trim()));

  if (trimmed.length >= 6) {
    /** fecha|ref|desc| |±monto|saldo — no mezclar con parseLineaSixCols (trataría − como crédito). */
    if (isBlankGapColumn(trimmed[3])) {
      return parseLineaBanescoSignedAmountSixCols(trimmed);
    }
    return parseLineaSixColsBest(trimmed);
  }

  if (trimmed.length === 5) {
    return parseLineaFiveCols(trimmed);
  }
  if (trimmed.length === 4) {
    return parseLineaFiveCols([trimmed[0], trimmed[1], trimmed[2], trimmed[3], ""]);
  }
  return null;
}

function parseTxt(txtContent) {
  const raw = stripBom(String(txtContent || ""));
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) {
    return { movements: [], delimiter: null, rawLineCount: 0 };
  }

  const sample = lines.slice(0, 30);
  const delimiter = resolveCsvDelimiter(sample);
  const movements = [];

  for (const line of lines) {
    const cols = line.split(delimiter);
    if (cols.length < 4) continue;
    const mov = parseLineaColumns(cols);
    if (mov) movements.push(mov);
  }

  return {
    movements,
    delimiter,
    rawLineCount: lines.length,
  };
}

async function insertMovements(bankAccountId, movements) {
  let inserted = 0;
  let duplicates = 0;
  let errors = 0;

  for (const mov of movements) {
    if (!mov.row_hash) {
      errors++;
      continue;
    }

    try {
      const r = await queryRetry(
        `INSERT INTO bank_statements
           (bank_account_id, tx_date, description,
            reference_number, tx_type, amount,
            balance_after, payment_type, row_hash)
         VALUES ($1,$2,$3,$4,$5::statement_tx_type,$6,$7,$8,$9)
         ON CONFLICT (row_hash) DO NOTHING`,
        [
          Number(bankAccountId),
          mov.tx_date,
          mov.description || "",
          mov.reference_number || null,
          mov.tx_type,
          mov.amount,
          mov.balance_after || null,
          mov.payment_type || null,
          mov.row_hash,
        ]
      );

      if (r.rowCount > 0) inserted++;
      else duplicates++;
    } catch (err) {
      console.error(`[banesco] Error INSERT:`, {
        message: err.message,
        tx_date: mov.tx_date,
        amount: mov.amount,
        reference_number: mov.reference_number,
        row_hash: mov.row_hash,
      });
      errors++;
    }
  }

  return { inserted, duplicates, errors };
}

async function runCycle(bankAccountId) {
  try {
    let cookies = await loadSession(bankAccountId);

    if (!cookies) {
      cookies = await doLogin();
      await saveSession(bankAccountId, cookies);
    }

    let txtContent;
    try {
      txtContent = await downloadTxt(cookies);
    } catch (err) {
      if (err && err.message === "SESSION_EXPIRED") {
        console.log(`[banesco] ${nowVET()} — Sesión expirada en banco. Re-login...`);
        cookies = await doLogin();
        await saveSession(bankAccountId, cookies);
        txtContent = await downloadTxt(cookies);
      } else {
        throw err;
      }
    }

    const rawLen = (txtContent || "").length;
    console.log(`[banesco] ${nowVET()} — Texto recibido tras descarga: ${rawLen} caracteres`);
    if (rawLen > 0 && /<!DOCTYPE|<\s*html/i.test(String(txtContent).slice(0, 800))) {
      console.warn(
        `[banesco] ${nowVET()} — El contenido parece HTML, no un TXT con columnas | — revisá exportación`
      );
    }

    const { movements, delimiter, rawLineCount } = parseTxt(txtContent);
    const delimLabel = delimiter === "\t" ? "TAB" : delimiter || "?";
    console.log(
      `[banesco] ${nowVET()} — Parseo: ${rawLineCount} línea(s) en archivo, delimitador detectado: "${delimLabel}", ` +
        `${movements.length} movimiento(s) válido(s)`
    );
    if (movements.length === 0 && rawLen > 0) {
      const first = String(txtContent)
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.length > 0);
      const preview = first
        ? first.length > 220
          ? `${first.slice(0, 220)}…`
          : first
        : "(vacío)";
      console.warn(
        `[banesco] ${nowVET()} — Ninguna fila parseable (fecha + monto). Revisá columnas/delimitador. ` +
          `Primera línea no vacía: ${preview}`
      );
    }

    const result = await insertMovements(bankAccountId, movements);

    let reconciliationRan = false;
    if (result.inserted > 0) {
      await queryRetry(
        `SELECT * FROM run_reconciliation($1::bigint, CURRENT_DATE - 7, CURRENT_DATE)`,
        [bankAccountId]
      );
      reconciliationRan = true;
    }

    if (result.inserted > 0) {
      console.log(
        `[banesco] ${nowVET()} — Base de datos: OK — ${result.inserted} movimiento(s) nuevo(s) en bank_statements (cuenta id=${bankAccountId})`
      );
    } else if (movements.length > 0) {
      console.log(
        `[banesco] ${nowVET()} — Base de datos: sin filas nuevas (${result.duplicates} ya existían por row_hash, ${result.errors} error(es) de insert)`
      );
    } else {
      console.log(`[banesco] ${nowVET()} — Base de datos: sin inserts (no hubo líneas parseadas)`);
    }

    if (reconciliationRan) {
      console.log(`[banesco] ${nowVET()} — Conciliación automática: ejecutada (ventana 7 días)`);
    }

    console.log(
      `[banesco] ${nowVET()} — Resumen ciclo: parsed=${movements.length} inserted=${result.inserted} duplicates=${result.duplicates} errors=${result.errors}` +
        (reconciliationRan ? " reconciliation=si" : " reconciliation=no")
    );
    console.log(`[banesco] ${nowVET()} — Ciclo Banesco: terminado OK (cuenta id=${bankAccountId})`);

    lastCycleSnapshot = {
      at: new Date().toISOString(),
      ok: true,
      parsed: movements.length,
      rawLineCount,
      delimiter: delimLabel,
      inserted: result.inserted,
      duplicates: result.duplicates,
      errors: result.errors,
      reconciliationRan,
    };

    return { ...result, parsed: movements.length, rawLineCount, delimiter: delimLabel, reconciliationRan };
  } catch (err) {
    console.error(
      `[banesco] ${nowVET()} — Ciclo Banesco: FALLÓ (descarga, sesión o base de datos) —`,
      err.message || err
    );
    lastCycleSnapshot = {
      at: new Date().toISOString(),
      ok: false,
      error: err.message,
    };
    return { error: err.message };
  }
}

module.exports = { runCycle, getLastCycleSnapshot, SESSION_MAX_HOURS };
