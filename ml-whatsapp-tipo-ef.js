/**
 * Mensajes WhatsApp vía Wasender (tipos E y F en `ml-message-types.js`).
 *
 * Tipo E — máximo **2** mensajes por **orden**: (1) imagen con leyenda de tienda; (2) **ubicación** (pin Maps + nombre/dirección + texto).
 * Tipo F — un mensaje de texto por pregunta (sin cambios de secuencia).
 *
 * Env (tipo E): si un valor no está en BD (`ml_whatsapp_tipo_e_config`, editable en
 *   `/mensajes-tipo-e-whatsapp?k=ADMIN_SECRET`), se usa la variable de entorno y luego el default en código.
 *
 *   ML_WHATSAPP_TIPO_E_IMAGE_URL, ML_WHATSAPP_TIPO_E_IMAGE_CAPTION, ML_WHATSAPP_TIPO_E_DELAY_MS
 *   ML_WHATSAPP_TIPO_E_LOCATION_LAT / _LNG, _NAME, _ADDRESS, ML_WHATSAPP_TIPO_E_MAPS_URL
 *   ML_WHATSAPP_TIPO_E_LOCATION_TEXT — leyenda paso 2 ({{order_id}} {{maps_url}} …)
 *
 * Tope semanal por **destino** (E.164): no repetir el **par** (pasos 1+2) al **mismo celular** si ya hubo
 * un par completo exitoso a ese número en la ventana (por defecto 7 días). No aplica por comprador ni por
 * orden distinta con otro número: si el cliente cambia el celular en la orden y el nuevo destino normaliza
 * a otro E.164, el historial del número anterior no bloquea.
 * ML_WHATSAPP_TIPO_E_WEEKLY_CAP=0 lo desactiva. ML_WHATSAPP_TIPO_E_WEEKLY_CAP_DAYS — días (default 7).
 */

require("./load-env-local");

const db = require("./db");
const { MESSAGE_TYPE_E, MESSAGE_TYPE_F } = require("./ml-message-types");
const { sendWasenderTextMessage, sendWasenderImageMessage, sendWasenderLocationMessage } = require("./wasender-client");
const { normalizePhoneToE164 } = require("./ml-whatsapp-phone");

/** Leyenda por defecto del 1.er mensaje (imagen). Sobrescribible con ML_WHATSAPP_TIPO_E_IMAGE_CAPTION. */
const FULLCAR_TIPO_E_IMAGE_CAPTION = `SOMOS TIENDA AUTOPARTES Y CARROCERIAS FULLCAR CJ CA 

DIRECCIÓN ESCRITA: Calle Coromoto a una cuadra de la salida del CC El Recreo, Qta Cruz Maria, Urbanizacion Bello Monte Tocar el timbre. 

DIRECCIÓN GPS: Enviar número 

TELÉFONOS:  04241394269   04242701513  (0212)7626806 3266.  

HORARIO:  Lunes a Viernes Corrido de 8:00 am a 5:00 pm. Sábado CONSULTAR. 

DELIVERY: Costo depende de la zona. 

FORMA DE PAGO: Pago Móvil / Binance / Zelle / Efectivo. 

PAGO MÓVIL:  0134 17488886 04241394269.`;

/** Coordenadas del pin (Google Maps search FULLCAR CJ CA). */
const FULLCAR_MAPS_URL =
  "https://www.google.com/maps/search/FULLCAR+CJ+CA/@10.4904006,-66.8764996,882m/data=!3m1!1e3?hl=es&entry=ttu&g_ep=EgoyMDI2MDMyNC4wIKXMDSoASAFQAw%3D%3D";

const FULLCAR_LOCATION_NAME = "FULLCAR CJ CA";

const FULLCAR_LOCATION_ADDRESS =
  "CALLE COROMOTO QUINTA CRUZ MARIA EL RECREO QUINTA BLANCA DE REJAS NEGRAS CARACAS, 1010, Distrito Capital";

/** Leyenda del chat junto al pin de ubicación (además name/address en el pin). */
const DEFAULT_TIPO_E_LOCATION_TEXT = `{{maps_url}}

CALLE COROMOTO QUINTA CRUZ MARIA EL RECREO QUINTA BLANCA DE REJAS NEGRAS CARACAS, 1010, Distrito Capital

FULLCAR CJ CA`;

const DEFAULT_TIPO_F =
  "Hola, vimos tu consulta en Mercado Libre (pregunta #{{question_id}}). ¿En qué podemos ayudarte?";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function getTipoEWeeklyCapWindowDays() {
  const n = Number(process.env.ML_WHATSAPP_TIPO_E_WEEKLY_CAP_DAYS ?? 7);
  if (!Number.isFinite(n) || n < 1) return 7;
  return Math.min(31, Math.floor(n));
}

function tipoEWeeklyCapSinceIso() {
  const d = new Date();
  d.setTime(d.getTime() - getTipoEWeeklyCapWindowDays() * 24 * 60 * 60 * 1000);
  return d.toISOString();
}

function applyPlaceholders(template, vars) {
  let s = String(template || "");
  for (const [k, v] of Object.entries(vars)) {
    s = s.replace(new RegExp(`\\{\\{${k}\\}\\}`, "g"), v != null ? String(v) : "");
  }
  return s.trim();
}

/**
 * @returns {Promise<{ enabled: boolean, apiKey: string, apiBaseUrl: string, defaultCountryCode: string }>}
 */
async function resolveWasenderRuntimeConfig() {
  const settings = await db.getMlWasenderSettings();
  const apiKey = process.env.WASENDER_API_KEY && String(process.env.WASENDER_API_KEY).trim();
  const envOn = process.env.WASENDER_ENABLED === "1";
  const dbOn =
    settings &&
    (settings.is_enabled === true ||
      settings.is_enabled === 1 ||
      settings.is_enabled === "1");
  const enabled = (envOn || dbOn) && !!apiKey;
  const apiBaseUrl =
    (process.env.WASENDER_API_BASE_URL && String(process.env.WASENDER_API_BASE_URL).trim()) ||
    (settings && settings.api_base_url) ||
    "https://www.wasenderapi.com";
  const defaultCountryCode =
    (process.env.WASENDER_DEFAULT_PHONE_COUNTRY && String(process.env.WASENDER_DEFAULT_PHONE_COUNTRY).replace(/\D/g, "")) ||
    (settings && String(settings.default_phone_country_code || "").replace(/\D/g, "")) ||
    "58";
  return {
    enabled,
    apiKey: apiKey || "",
    apiBaseUrl,
    defaultCountryCode: defaultCountryCode || "58",
  };
}

/**
 * Prioridad: BD (`ml_whatsapp_tipo_e_config`) → env → constantes FULLCAR.
 * @returns {Promise<object>}
 */
async function mergeTipoEConfig() {
  let row = null;
  try {
    row = await db.getMlWhatsappTipoEConfig();
  } catch (_) {
    row = null;
  }
  const pickStr = (dbKey, envKey, def) => {
    if (row && row[dbKey] != null && String(row[dbKey]).trim() !== "") return String(row[dbKey]).trim();
    const e = process.env[envKey];
    if (e != null && String(e).trim() !== "") return String(e).trim();
    return def !== undefined && def !== null ? String(def) : "";
  };
  const pickNum = (dbKey, envKey, def) => {
    if (row && row[dbKey] != null && String(row[dbKey]).trim() !== "") {
      const n = Number(row[dbKey]);
      if (Number.isFinite(n)) return n;
    }
    const n = Number(process.env[envKey]);
    if (Number.isFinite(n)) return n;
    return def;
  };
  const pickChatTemplate = () => {
    if (row && row.location_chat_text != null && String(row.location_chat_text).trim() !== "") {
      return String(row.location_chat_text);
    }
    const e = process.env.ML_WHATSAPP_TIPO_E_LOCATION_TEXT;
    if (e != null && String(e).trim() !== "") return String(e);
    return DEFAULT_TIPO_E_LOCATION_TEXT;
  };
  const delayRaw = pickNum("delay_ms", "ML_WHATSAPP_TIPO_E_DELAY_MS", 800);
  return {
    imageUrl: pickStr("image_url", "ML_WHATSAPP_TIPO_E_IMAGE_URL", ""),
    imageCaption: pickStr("image_caption", "ML_WHATSAPP_TIPO_E_IMAGE_CAPTION", FULLCAR_TIPO_E_IMAGE_CAPTION),
    delayMs: Math.min(60000, Math.max(0, delayRaw)),
    locationLat: pickNum("location_lat", "ML_WHATSAPP_TIPO_E_LOCATION_LAT", 10.4904006),
    locationLng: pickNum("location_lng", "ML_WHATSAPP_TIPO_E_LOCATION_LNG", -66.8764996),
    locationName: pickStr("location_name", "ML_WHATSAPP_TIPO_E_LOCATION_NAME", FULLCAR_LOCATION_NAME),
    locationAddress: pickStr("location_address", "ML_WHATSAPP_TIPO_E_LOCATION_ADDRESS", FULLCAR_LOCATION_ADDRESS),
    mapsUrl: pickStr("location_maps_url", "ML_WHATSAPP_TIPO_E_MAPS_URL", FULLCAR_MAPS_URL),
    locationChatTemplate: pickChatTemplate(),
  };
}

/**
 * @param {object} vars — order_id, buyer_id, seller_id, status
 * @param {string|null|undefined} argsTextOverride — sustituye plantilla del paso 2
 * @param {object} merged — resultado de `mergeTipoEConfig()`
 */
function buildTipoELocationStep2(vars, argsTextOverride, merged) {
  const mapsUrl = merged.mapsUrl.trim();
  const template =
    argsTextOverride != null && String(argsTextOverride).trim() !== ""
      ? String(argsTextOverride)
      : merged.locationChatTemplate;
  const text = applyPlaceholders(template, {
    ...vars,
    maps_url: mapsUrl,
  });
  return {
    latitude: Number.isFinite(merged.locationLat) ? merged.locationLat : 10.4904006,
    longitude: Number.isFinite(merged.locationLng) ? merged.locationLng : -66.8764996,
    name: merged.locationName.trim(),
    address: merged.locationAddress.trim(),
    text,
  };
}

/** Primer teléfono normalizable. El tope semanal tipo E usa solo el E.164 de destino (no buyer_id). */
function pickFirstPhoneE164(buyer, defaultCountryCode) {
  const phones = [
    { raw: buyer.phone_1, source: "phone_1" },
    { raw: buyer.phone_2, source: "phone_2" },
  ];
  for (const p of phones) {
    const e164 = normalizePhoneToE164(p.raw, defaultCountryCode);
    if (e164) return { e164, source: p.source };
  }
  return null;
}

/**
 * @param {{ mlUserId: number, orderId: number, text?: string }} args — `text` opcional: plantilla del **2.º** mensaje (ubicación + leyenda; ver ML_WHATSAPP_TIPO_E_LOCATION_TEXT).
 * @returns {Promise<object>}
 */
async function trySendWhatsappTipoEForOrder(args) {
  const mlUserId = Number(args.mlUserId);
  const orderId = Number(args.orderId);
  if (!Number.isFinite(mlUserId) || mlUserId <= 0 || !Number.isFinite(orderId) || orderId <= 0) {
    return { ok: false, outcome: "invalid_args", detail: "mlUserId u orderId inválido" };
  }

  const cfg = await resolveWasenderRuntimeConfig();
  const order = await db.getMlOrderByUserAndOrderId(mlUserId, orderId);
  if (!order || order.buyer_id == null) {
    await db.insertMlWhatsappWasenderLog({
      message_kind: "E",
      ml_user_id: mlUserId,
      buyer_id: order && order.buyer_id != null ? Number(order.buyer_id) : null,
      order_id: orderId,
      phone_e164: "—",
      outcome: "skipped",
      skip_reason: "orden o buyer no encontrado",
      text_preview: MESSAGE_TYPE_E,
    });
    return { ok: false, outcome: "no_order", detail: "orden o comprador no en BD" };
  }

  const buyerId = Number(order.buyer_id);
  const buyer = await db.getMlBuyer(buyerId);
  if (!buyer) {
    await db.insertMlWhatsappWasenderLog({
      message_kind: "E",
      ml_user_id: mlUserId,
      buyer_id: buyerId,
      order_id: orderId,
      phone_e164: "—",
      outcome: "skipped",
      skip_reason: "ml_buyers sin fila",
      text_preview: MESSAGE_TYPE_E,
    });
    return { ok: false, outcome: "no_buyer" };
  }

  const prevOk = await db.countMlWhatsappTipoESuccessForOrder(mlUserId, orderId);
  if (prevOk >= 2) {
    await db.insertMlWhatsappWasenderLog({
      message_kind: "E",
      ml_user_id: mlUserId,
      buyer_id: buyerId,
      order_id: orderId,
      phone_e164: "—",
      outcome: "skipped",
      skip_reason: "ya se enviaron 2 mensajes tipo E para esta orden",
      text_preview: MESSAGE_TYPE_E,
    });
    return { ok: false, outcome: "already_complete", detail: "máximo 2 mensajes tipo E por orden" };
  }

  if (!cfg.enabled) {
    const id = await db.insertMlWhatsappWasenderLog({
      message_kind: "E",
      ml_user_id: mlUserId,
      buyer_id: buyerId,
      order_id: orderId,
      phone_e164: "—",
      outcome: "skipped",
      skip_reason: "WASENDER desactivado o sin WASENDER_API_KEY",
      text_preview: MESSAGE_TYPE_E,
    });
    return { ok: false, outcome: "disabled", logId: id };
  }

  const picked = pickFirstPhoneE164(buyer, cfg.defaultCountryCode);
  if (!picked) {
    const id = await db.insertMlWhatsappWasenderLog({
      message_kind: "E",
      ml_user_id: mlUserId,
      buyer_id: buyerId,
      order_id: orderId,
      phone_e164: "—",
      outcome: "skipped",
      skip_reason: "phone_1 y phone_2 vacíos o no normalizables",
      text_preview: MESSAGE_TYPE_E,
    });
    return { ok: false, outcome: "no_phone", logId: id };
  }

  const { e164, source } = picked;

  if (
    prevOk === 0 &&
    process.env.ML_WHATSAPP_TIPO_E_WEEKLY_CAP !== "0" &&
    process.env.ML_WHATSAPP_TIPO_E_WEEKLY_CAP !== "false"
  ) {
    const since = tipoEWeeklyCapSinceIso();
    const pairsThisWindow = await db.countMlWhatsappTipoECompletedPairsForPhoneSince(
      mlUserId,
      e164,
      since
    );
    if (pairsThisWindow > 0) {
      await db.insertMlWhatsappWasenderLog({
        message_kind: "E",
        ml_user_id: mlUserId,
        buyer_id: buyerId,
        order_id: orderId,
        phone_e164: e164,
        phone_source: source,
        outcome: "skipped",
        skip_reason: `tope semanal tipo E (mismo celular / E.164): ya hubo un par completo a este destino en los últimos ${getTipoEWeeklyCapWindowDays()} día(s)`,
        text_preview: MESSAGE_TYPE_E,
      });
      return {
        ok: false,
        outcome: "weekly_cap_phone",
        detail: "máximo un par tipo E por destino (E.164) en la ventana; otro celular no cuenta",
      };
    }
  }

  const vars = {
    order_id: orderId,
    buyer_id: buyerId,
    seller_id: mlUserId,
    status: order.status || "",
  };
  const merged = await mergeTipoEConfig();
  const loc2 = buildTipoELocationStep2(vars, args.text, merged);

  const caption = merged.imageCaption.trim();
  const imageUrl = merged.imageUrl.trim();
  const delayMs = merged.delayMs;

  function msgIdFrom(res) {
    return res.json && res.json.data && res.json.data.msgId != null ? Number(res.json.data.msgId) : null;
  }

  if (prevOk === 0) {
    if (!imageUrl) {
      await db.insertMlWhatsappWasenderLog({
        message_kind: "E",
        ml_user_id: mlUserId,
        buyer_id: buyerId,
        order_id: orderId,
        phone_e164: e164,
        phone_source: source,
        outcome: "skipped",
        skip_reason: "ML_WHATSAPP_TIPO_E_IMAGE_URL no definida (requerida para el 1.er mensaje)",
        text_preview: "[tipo E paso 1 imagen]",
        tipo_e_step: 1,
      });
      return { ok: false, outcome: "no_image_url", detail: "definí ML_WHATSAPP_TIPO_E_IMAGE_URL" };
    }

    const resImg = await sendWasenderImageMessage({
      apiBaseUrl: cfg.apiBaseUrl,
      apiKey: cfg.apiKey,
      to: e164,
      text: caption,
      imageUrl,
    });
    const mid1 = msgIdFrom(resImg);
    if (!resImg.ok) {
      await db.insertMlWhatsappWasenderLog({
        message_kind: "E",
        ml_user_id: mlUserId,
        buyer_id: buyerId,
        order_id: orderId,
        phone_e164: e164,
        phone_source: source,
        outcome: "api_error",
        http_status: resImg.status,
        wasender_msg_id: Number.isFinite(mid1) ? mid1 : null,
        response_body: resImg.bodyText ? resImg.bodyText.slice(0, 8000) : null,
        error_message: `paso 1 imagen HTTP ${resImg.status}`,
        text_preview: caption.slice(0, 200),
        tipo_e_step: 1,
      });
      return { ok: false, outcome: "api_error", step: 1, detail: resImg.bodyText };
    }
    await db.insertMlWhatsappWasenderLog({
      message_kind: "E",
      ml_user_id: mlUserId,
      buyer_id: buyerId,
      order_id: orderId,
      phone_e164: e164,
      phone_source: source,
      outcome: "success",
      http_status: resImg.status,
      wasender_msg_id: Number.isFinite(mid1) ? mid1 : null,
      response_body: resImg.bodyText ? resImg.bodyText.slice(0, 8000) : null,
      text_preview: caption.slice(0, 200),
      tipo_e_step: 1,
    });

    if (delayMs > 0) await sleep(delayMs);

    const resLoc = await sendWasenderLocationMessage({
      apiBaseUrl: cfg.apiBaseUrl,
      apiKey: cfg.apiKey,
      to: e164,
      latitude: loc2.latitude,
      longitude: loc2.longitude,
      name: loc2.name,
      address: loc2.address,
      text: loc2.text,
    });
    const mid2 = msgIdFrom(resLoc);
    const locPreview = `${loc2.name} | ${loc2.address}`.slice(0, 200);
    if (!resLoc.ok) {
      await db.insertMlWhatsappWasenderLog({
        message_kind: "E",
        ml_user_id: mlUserId,
        buyer_id: buyerId,
        order_id: orderId,
        phone_e164: e164,
        phone_source: source,
        outcome: "api_error",
        http_status: resLoc.status,
        wasender_msg_id: Number.isFinite(mid2) ? mid2 : null,
        response_body: resLoc.bodyText ? resLoc.bodyText.slice(0, 8000) : null,
        error_message: `paso 2 ubicación HTTP ${resLoc.status}`,
        text_preview: locPreview,
        tipo_e_step: 2,
      });
      return { ok: false, outcome: "api_error", step: 2, detail: resLoc.bodyText, partial: true };
    }
    await db.insertMlWhatsappWasenderLog({
      message_kind: "E",
      ml_user_id: mlUserId,
      buyer_id: buyerId,
      order_id: orderId,
      phone_e164: e164,
      phone_source: source,
      outcome: "success",
      http_status: resLoc.status,
      wasender_msg_id: Number.isFinite(mid2) ? mid2 : null,
      response_body: resLoc.bodyText ? resLoc.bodyText.slice(0, 8000) : null,
      text_preview: locPreview,
      tipo_e_step: 2,
    });
    return { ok: true, outcome: "sent_both", phone: e164, steps: [1, 2] };
  }

  if (prevOk === 1) {
    const resLoc = await sendWasenderLocationMessage({
      apiBaseUrl: cfg.apiBaseUrl,
      apiKey: cfg.apiKey,
      to: e164,
      latitude: loc2.latitude,
      longitude: loc2.longitude,
      name: loc2.name,
      address: loc2.address,
      text: loc2.text,
    });
    const mid2 = msgIdFrom(resLoc);
    const locPreview = `${loc2.name} | ${loc2.address}`.slice(0, 200);
    if (!resLoc.ok) {
      await db.insertMlWhatsappWasenderLog({
        message_kind: "E",
        ml_user_id: mlUserId,
        buyer_id: buyerId,
        order_id: orderId,
        phone_e164: e164,
        phone_source: source,
        outcome: "api_error",
        http_status: resLoc.status,
        wasender_msg_id: Number.isFinite(mid2) ? mid2 : null,
        response_body: resLoc.bodyText ? resLoc.bodyText.slice(0, 8000) : null,
        error_message: `paso 2 ubicación HTTP ${resLoc.status}`,
        text_preview: locPreview,
        tipo_e_step: 2,
      });
      return { ok: false, outcome: "api_error", step: 2, detail: resLoc.bodyText };
    }
    await db.insertMlWhatsappWasenderLog({
      message_kind: "E",
      ml_user_id: mlUserId,
      buyer_id: buyerId,
      order_id: orderId,
      phone_e164: e164,
      phone_source: source,
      outcome: "success",
      http_status: resLoc.status,
      wasender_msg_id: Number.isFinite(mid2) ? mid2 : null,
      response_body: resLoc.bodyText ? resLoc.bodyText.slice(0, 8000) : null,
      text_preview: locPreview,
      tipo_e_step: 2,
    });
    return { ok: true, outcome: "sent_step2_only", phone: e164, steps: [2] };
  }

  return { ok: false, outcome: "unexpected", detail: `prevOk=${prevOk}` };
}

/**
 * @param {{ mlUserId: number, mlQuestionId: number, text?: string }} args
 */
async function trySendWhatsappTipoFForQuestion(args) {
  const mlUserId = Number(args.mlUserId);
  const mlQuestionId = Number(args.mlQuestionId);
  if (!Number.isFinite(mlUserId) || mlUserId <= 0 || !Number.isFinite(mlQuestionId) || mlQuestionId <= 0) {
    return { ok: false, outcome: "invalid_args", detail: "mlUserId o mlQuestionId inválido" };
  }

  const cfg = await resolveWasenderRuntimeConfig();
  const q = await db.getMlQuestionContextForWhatsapp(mlQuestionId);
  if (!q || q.ml_user_id == null) {
    await db.insertMlWhatsappWasenderLog({
      message_kind: "F",
      ml_user_id: mlUserId,
      buyer_id: null,
      ml_question_id: mlQuestionId,
      phone_e164: "—",
      outcome: "skipped",
      skip_reason: "pregunta no en pending/answered",
      text_preview: MESSAGE_TYPE_F,
    });
    return { ok: false, outcome: "no_question" };
  }
  if (Number(q.ml_user_id) !== mlUserId) {
    return { ok: false, outcome: "user_mismatch", detail: "ml_user_id de la pregunta no coincide" };
  }
  if (q.buyer_id == null) {
    await db.insertMlWhatsappWasenderLog({
      message_kind: "F",
      ml_user_id: mlUserId,
      buyer_id: null,
      ml_question_id: mlQuestionId,
      phone_e164: "—",
      outcome: "skipped",
      skip_reason: "buyer_id nulo en pregunta",
      text_preview: MESSAGE_TYPE_F,
    });
    return { ok: false, outcome: "no_buyer_id" };
  }

  const buyerId = Number(q.buyer_id);
  const buyer = await db.getMlBuyer(buyerId);
  if (!buyer) {
    await db.insertMlWhatsappWasenderLog({
      message_kind: "F",
      ml_user_id: mlUserId,
      buyer_id: buyerId,
      ml_question_id: mlQuestionId,
      phone_e164: "—",
      outcome: "skipped",
      skip_reason: "ml_buyers sin fila",
      text_preview: MESSAGE_TYPE_F,
    });
    return { ok: false, outcome: "no_buyer" };
  }

  const bodyTemplate = args.text != null ? String(args.text) : process.env.ML_WHATSAPP_TIPO_F_BODY || DEFAULT_TIPO_F;
  const text = applyPlaceholders(bodyTemplate, {
    question_id: mlQuestionId,
    item_id: q.item_id || "",
    buyer_id: buyerId,
    seller_id: mlUserId,
  });

  return sendWhatsappToBuyerPhones({
    messageKind: "F",
    mlUserId,
    buyerId,
    orderId: null,
    mlQuestionId,
    buyer,
    text,
    cfg,
  });
}

async function sendWhatsappToBuyerPhones({
  messageKind,
  mlUserId,
  buyerId,
  orderId,
  mlQuestionId,
  buyer,
  text,
  cfg,
}) {
  if (!cfg.enabled) {
    const id = await db.insertMlWhatsappWasenderLog({
      message_kind: messageKind,
      ml_user_id: mlUserId,
      buyer_id: buyerId,
      order_id: orderId,
      ml_question_id: mlQuestionId,
      phone_e164: "—",
      outcome: "skipped",
      skip_reason: "WASENDER desactivado o sin WASENDER_API_KEY",
      text_preview: text.slice(0, 200),
    });
    return { ok: false, outcome: "disabled", logId: id };
  }

  const phones = [
    { raw: buyer.phone_1, source: "phone_1" },
    { raw: buyer.phone_2, source: "phone_2" },
  ];

  for (const p of phones) {
    const e164 = normalizePhoneToE164(p.raw, cfg.defaultCountryCode);
    if (!e164) continue;

    const res = await sendWasenderTextMessage({
      apiBaseUrl: cfg.apiBaseUrl,
      apiKey: cfg.apiKey,
      to: e164,
      text,
    });

    const msgId =
      res.json && res.json.data && res.json.data.msgId != null ? Number(res.json.data.msgId) : null;
    const preview = text.slice(0, 200);
    if (res.ok) {
      const logId = await db.insertMlWhatsappWasenderLog({
        message_kind: messageKind,
        ml_user_id: mlUserId,
        buyer_id: buyerId,
        order_id: orderId,
        ml_question_id: mlQuestionId,
        phone_e164: e164,
        phone_source: p.source,
        outcome: "success",
        http_status: res.status,
        wasender_msg_id: Number.isFinite(msgId) ? msgId : null,
        response_body: res.bodyText ? res.bodyText.slice(0, 8000) : null,
        text_preview: preview,
      });
      return { ok: true, outcome: "sent", logId, phone: e164 };
    }

    await db.insertMlWhatsappWasenderLog({
      message_kind: messageKind,
      ml_user_id: mlUserId,
      buyer_id: buyerId,
      order_id: orderId,
      ml_question_id: mlQuestionId,
      phone_e164: e164,
      phone_source: p.source,
      outcome: "api_error",
      http_status: res.status,
      response_body: res.bodyText ? res.bodyText.slice(0, 8000) : null,
      error_message: !res.ok ? `HTTP ${res.status}` : null,
      text_preview: preview,
    });
    return { ok: false, outcome: "api_error", detail: res.bodyText };
  }

  const id = await db.insertMlWhatsappWasenderLog({
    message_kind: messageKind,
    ml_user_id: mlUserId,
    buyer_id: buyerId,
    order_id: orderId,
    ml_question_id: mlQuestionId,
    phone_e164: "—",
    outcome: "skipped",
    skip_reason: "phone_1 y phone_2 vacíos o no normalizables",
    text_preview: text.slice(0, 200),
  });
  return { ok: false, outcome: "no_phone", logId: id };
}

module.exports = {
  MESSAGE_TYPE_E,
  MESSAGE_TYPE_F,
  FULLCAR_TIPO_E_IMAGE_CAPTION,
  FULLCAR_MAPS_URL,
  FULLCAR_LOCATION_NAME,
  FULLCAR_LOCATION_ADDRESS,
  mergeTipoEConfig,
  buildTipoELocationStep2,
  resolveWasenderRuntimeConfig,
  trySendWhatsappTipoEForOrder,
  trySendWhatsappTipoFForQuestion,
  applyPlaceholders,
};

if (require.main === module) {
  const argv = process.argv.slice(2);
  (async () => {
    if (argv[0] === "--tipo-e" && argv[1] && argv[2]) {
      const r = await trySendWhatsappTipoEForOrder({
        mlUserId: Number(argv[1]),
        orderId: Number(argv[2]),
      });
      console.log(JSON.stringify(r, null, 2));
      process.exit(r.ok ? 0 : 1);
    }
    if (argv[0] === "--tipo-f" && argv[1] && argv[2]) {
      const r = await trySendWhatsappTipoFForQuestion({
        mlUserId: Number(argv[1]),
        mlQuestionId: Number(argv[2]),
      });
      console.log(JSON.stringify(r, null, 2));
      process.exit(r.ok ? 0 : 1);
    }
    console.error(
      "Uso: node ml-whatsapp-tipo-ef.js --tipo-e <ml_user_id> <order_id>  |  --tipo-f <ml_user_id> <ml_question_id>"
    );
    process.exit(2);
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
