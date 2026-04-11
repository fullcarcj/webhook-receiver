"use strict";

/**
 * Handler de mensajes entrantes WASender.
 *
 * Flujo de onboarding (3 casos exclusivos):
 *
 * CASO 1 — Teléfono ya existe en customers (crm_customer_identities o customers.phone):
 *   → Flujo normal: enriquecer datos, guardar chat y mensaje, post-commit bienvenida con nombre.
 *
 * CASO 2 — Teléfono NO en customers, pero SÍ en crm_chat_states (AWAITING_NAME):
 *   → TRANSACCIÓN ATÓMICA:
 *      1. Crear cliente en customers con full_name = TEXTO.UPPER, phone = teléfono, name_suggested = push_name guardado.
 *      2. DELETE crm_chat_states.
 *      3. upsertChat + guardar mensaje.
 *   → Post-commit: "Gracias [NOMBRE], ya te hemos registrado. ¿En qué podemos ayudarte?"
 *
 * CASO 3 — Teléfono NO en customers NI en crm_chat_states:
 *   → Solo INSERT crm_chat_states (AWAITING_NAME, push_name, trigger_message_id).
 *   → NO se toca customers, crm_chats ni crm_messages.
 *   → Post-commit: "¡Hola! Bienvenido a Solomotor3k. ¿Cómo te llamas? (Nombre y Apellido)"
 *
 * AWAITING_NAME + texto que no es nombre válido (incl. 1 palabra tipo ASK_SURNAME):
 *   → upsertChat(customer_id NULL) + crm_messages + maybeQueueInboundText → **Tipo M sin customer**
 *   (crm_chat_states sigue AWAITING_NAME hasta que envíe nombre válido en CASO 2).
 */

const pino = require("pino");
const { pool } = require("../../../db");
const { normalizePhone } = require("../../utils/phoneNormalizer");
const { resolveCustomerId, upsertChat } = require("./_shared");
const { pickWaFullNameCandidate, sanitizeWaPersonName, isLikelyChatNotName, isValidFullName } = require("../waNameCandidate");
const { runWaMlBuyerMatchTipoE } = require("../../services/waMlBuyerMatchTipoE");
const {
  trySendCrmWaWelcome,
  trySendCrmWaWelcomeAfterName,
  trySendCrmWaWelcomeNameConfirmation,
  trySendCrmWaAskName,
} = require("../../services/crmWaWelcome");
const {
  getCrmChatState,
  upsertCrmChatStateAwaitingName,
  deleteCrmChatState,
} = require("../../services/crmChatStates");
const { maybeQueueInboundText } = require("../../services/aiResponder");

const msgLog = pino({ level: process.env.LOG_LEVEL || "info", name: "whatsapp_messages" });

/** Wasender: `messages.received`, `messages-personal.received` y `message.received` comparten lógica CRM/Tipo M. */
function isInboundMessagesReceived(eventType) {
  const e = String(eventType || "").trim().toLowerCase();
  return (
    e === "messages.received" ||
    e === "messages-personal.received" ||
    e === "message.received"
  );
}

let _nameSuggestedColumnWarned = false;

function isPriority(normalized) {
  const t = normalized.content && normalized.content.text;
  if (!t) return false;
  const text = String(t).toLowerCase();
  const keywords = [
    "precio",
    "pago",
    "urgente",
    "no sirve",
    "roto",
    "cuanto",
    "cuánto",
    "disponible",
    "tienen",
    "hay",
    "cuanto vale",
    "transferencia",
  ];
  return keywords.some((kw) => text.includes(kw));
}

/**
 * Regla de negocio Tipo H:
 * - Solo se considera "cliente existente" si senderPn (normalizado) coincide con customers.phone.
 * - No usa crm_customer_identities ni customers.phone_2 para decidir este disparador.
 * @param {import("pg").PoolClient} db
 * @param {string} phoneRaw
 * @returns {Promise<{customerId:number}|null>}
 */
async function findExistingCustomerByPhone(db, phoneRaw) {
  const normalized = normalizePhone(phoneRaw);
  const digits = (normalized || String(phoneRaw)).replace(/\D/g, "");
  if (!digits) return null;

  const { rows } = await db.query(
    `SELECT c.id AS customer_id
     FROM customers c
     WHERE NULLIF(TRIM(c.phone), '') IS NOT NULL
       AND REGEXP_REPLACE(c.phone, '\\D', '', 'g') = $1
     LIMIT 1`,
    [digits]
  );
  return rows[0] ? { customerId: Number(rows[0].customer_id) } : null;
}

/**
 * Palabras que NUNCA son parte de un nombre propio en español.
 * Pronombres, artículos, verbos comunes, adverbios, conjunciones,
 * adjetivos técnicos y expresiones de chat.
 * La regla: si CUALQUIER palabra del texto está aquí → rechazar todo.
 */
const NON_NAME_WORDS = new Set([
  // Pronombres
  "yo","tu","tú","el","él","ella","nosotros","ustedes","ellos","ellas",
  "me","te","se","nos","les","lo","le","les",
  // Artículos
  "un","una","unos","unas","los","las",
  // Preposiciones
  "de","del","al","en","con","por","para","sin","sobre","bajo","entre",
  "ante","tras","hacia","hasta","desde","durante","mediante","según",
  // Conjunciones / conectores
  "y","e","o","u","ni","pero","sino","aunque","porque","pues","que",
  "como","cuando","donde","si","ya","mas","más","pero","luego","entonces",
  // Verbos comunes (conjugados o infinitivos)
  "es","son","era","fue","ser","estar","sido","tengo","tiene","tienen",
  "hay","hace","hacer","ir","voy","va","ven","voy","venir","puede","pueden",
  "sé","se","no","soy","quiero","quiere","sabe","ver","veo","vea","doy","da",
  "decir","digo","dice","llevar","llegar","poner","pongo","pasar","pasa",
  "comprar","compro","busco","buscar","enviar","envío","salir","sale","salen",
  // Adverbios
  "solo","sólo","si","sí","no","también","tampoco","nunca","siempre","ya",
  "muy","bien","mal","mejor","peor","más","menos","todo","nada","algo","aquí",
  "allá","ahora","hoy","mañana","antes","después","igual","claro","exacto",
  "obvio","seguro","listo","entendido","perfecto","correcto","genial",
  // Chat / respuestas comunes
  "hola","buenas","buenos","tardes","noches","días","gracias","ok","dale",
  "chao","bye","adiós","adios","oye","mira","ojo","hey","epa","oe",
  // Adjetivos que nunca son apellidos
  "nuevo","nueva","bueno","buena","malo","mala","grande","pequeño","viejo",
  "carburado","inyeccion","inyección","disponible","urgente",
  // Sustantivos comunes (no nombres propios)
  "carro","moto","repuesto","precio","envío","envio","mano","cosa","parte",
  "nombre","apellido","numero","número","cliente","persona","trabajo","prueba",
  "test","testing","celular","teléfono","telefono","whatsapp",
  // Operación / logística (no son nombre y apellido)
  "debemos","debe","deben","esperar","esperamos","espera","esperan","esperando",
  "verificar","verifiquen","verifique","verifican","verificamos","inventario","inventarios",
  "verificación","verificacion",
  "estamos","están","estan","estoy",
  "descargar","descarga","descargando","descargamos",
  "podemos","pudieron",
  "quedar","quedará","quedara","quedo","queda","quedan",
  "lunes","martes","miércoles","miercoles","jueves","viernes","sábado","sabado","domingo",
  "sorry","disculpa","disculpen","favor",
]);

/**
 * Validación positiva: el texto es un nombre válido si:
 * 1. Solo contiene letras (con tildes/ñ) y espacios.
 * 2. Tiene entre 2 y 4 palabras.
 * 3. Cada palabra tiene entre 3 y 20 caracteres.
 * 4. NINGUNA palabra pertenece al vocabulario cotidiano (NON_NAME_WORDS).
 * 5. No termina con sufijos verbales (-ando, -iendo, -ado, -ido, -ar, -er, -ir).
 */
function normalizeOnboardingNameUpper(rawText) {
  const raw = String(rawText || "").trim();
  if (!raw) return null;
  if (isLikelyChatNotName(raw)) return null;

  // Solo letras y espacios (incluye tildes, ñ, ü)
  if (!/^[a-záéíóúüñA-ZÁÉÍÓÚÜÑ\s'-]+$/.test(raw)) return null;

  const sanitized = sanitizeWaPersonName(raw);
  if (!sanitized) return null;

  const words = sanitized.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 4) return null;

  // Longitud por palabra: mínimo 2, máximo 20
  if (words.some((w) => w.length < 2 || w.length > 20)) return null;

  const lower = words.map((w) => w.toLowerCase());

  // Validación positiva: ninguna palabra puede ser vocabulario cotidiano
  if (lower.some((w) => NON_NAME_WORDS.has(w))) return null;

  // Ninguna palabra termina con sufijo verbal claro
  const verbalSuffix = /(?:ando|iendo|ado|ido|ción|cion|ando|ente|mente|able|ible)$/i;
  if (lower.some((w) => verbalSuffix.test(w))) return null;

  // 1ª persona plural común ("debemos", "esperamos") sin bloquear "Morgan" (-gan).
  const pluralVerbRe = /(?:amos|emos|imos|mos)$/i;
  if (lower.some((w) => w.length >= 6 && pluralVerbRe.test(w) && !/gan$/i.test(w))) return null;
  // Imperativo/plural tipo "verifiquen"
  if (lower.some((w) => w.length >= 8 && /quen$/i.test(w))) return null;

  // Al menos 2 palabras tienen 3+ letras (descarta iniciales sueltas)
  if (lower.filter((w) => w.length >= 3).length < 2) return null;

  return sanitized.toUpperCase();
}

/**
 * Persiste el mensaje entrante y actualiza el chat. Reutilizable por Caso 1 y Caso 2.
 */
async function saveMessageAndUpdateChat(client, { chatId, customerId, normalized, eventType }) {
  if (eventType === "messages.update" && normalized.messageId) {
    await client.query(
      `UPDATE crm_messages
       SET content = $1::jsonb, is_edited = TRUE
       WHERE external_message_id = $2`,
      [JSON.stringify(normalized.content || {}), normalized.messageId]
    );
    return;
  }
  // Inbound image/audio/video/document/sticker: la fila en crm_messages la crea
  // `processors/media.js` + mediaSaver (URL Firebase, transcripción, etc.).
  // Si insertáramos aquí un stub con el mismo external_message_id, el media processor
  // haría already_saved_dedup y no descargaría ni transcribiría (2.º, 3.er mensaje, …).
  if (isInboundMessagesReceived(eventType)) {
    const t = String(normalized.type || "text").toLowerCase();
    if (["image", "audio", "video", "document", "sticker"].includes(t)) {
      return;
    }
  }
  const pri = isPriority(normalized);
  const ins = await client.query(
    `INSERT INTO crm_messages
       (chat_id, customer_id, external_message_id, direction, type, content, is_priority, created_at)
     VALUES ($1, $2, $3, 'inbound', $4, $5::jsonb, $6, NOW())
     ON CONFLICT (external_message_id) DO NOTHING
     RETURNING id`,
    [
      chatId,
      customerId,
      normalized.messageId,
      normalized.type || "text",
      JSON.stringify(normalized.content || {}),
      pri,
    ]
  );
  if (ins.rows.length) {
    await client.query(
      `UPDATE crm_chats SET unread_count = unread_count + 1, updated_at = NOW() WHERE id = $1`,
      [chatId]
    );
    const t = String(normalized.type || "text").toLowerCase();
    if (isInboundMessagesReceived(eventType) && t === "text") {
      await maybeQueueInboundText(client, ins.rows[0].id);
    }
  }
}

async function handle(normalized) {
  const eventType = normalized.eventType || "messages.received";
  if (!normalized.fromPhone || !normalized.messageId) {
    msgLog.warn(
      { fromPhone: normalized.fromPhone, messageId: normalized.messageId, eventType },
      "tipo_h_skip: fromPhone o messageId ausente"
    );
    return;
  }

  msgLog.info(
    { fromPhone: normalized.fromPhone, messageId: normalized.messageId, eventType, type: normalized.type },
    "tipo_h_handle_start"
  );

  const client = await pool.connect();

  // Variables de post-commit: se rellenan dentro de la transacción y se usan después del COMMIT.
  let postAction = null; // 'existing_welcome' | 'confirm_name' | 'ask_name'
  let postCustomerId = null;
  let postChatId = null;
  let postConfirmedName = null;
  let postWaMlBuyerCheck = null;

  try {
    await client.query("BEGIN");
    // Serializa el onboarding por teléfono para evitar duplicados por carreras concurrentes.
    {
      const phoneLockKey = normalizePhone(normalized.fromPhone) || String(normalized.fromPhone || "");
      if (phoneLockKey) {
        await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [phoneLockKey]);
      }
    }

    const cn = normalized.contactName != null ? String(normalized.contactName).trim() : "";

    // ── Verificación inicial: ¿el teléfono ya tiene cliente en BD? ───
    const existingCustomer = await findExistingCustomerByPhone(client, normalized.fromPhone);
    msgLog.info(
      { fromPhone: normalized.fromPhone, existingCustomer: existingCustomer || null },
      "tipo_h_customer_lookup"
    );

    if (existingCustomer) {
      // ════════════════════════════════════════════════════════════════
      // CASO 1: Cliente ya registrado → flujo normal
      // ════════════════════════════════════════════════════════════════
      const nameExtra = await pickWaFullNameCandidate(normalized);
      const extra = {};
      if (nameExtra.name) extra.name = nameExtra.name;
      if (cn) extra.contact_name = cn;

      const { customerId, waMlBuyerTipoECheck } = await resolveCustomerId(
        client,
        normalized.fromPhone,
        extra
      );
      postCustomerId = customerId;
      postWaMlBuyerCheck = waMlBuyerTipoECheck;

      if (cn) {
        try {
          await client.query(
            `UPDATE customers SET name_suggested = $1, updated_at = NOW() WHERE id = $2`,
            [cn.slice(0, 500), customerId]
          );
        } catch (e) {
          if (e && e.code === "42703") {
            if (!_nameSuggestedColumnWarned) {
              _nameSuggestedColumnWarned = true;
              msgLog.warn(
                "customers.name_suggested no existe — ejecutar: npm run db:customers-name-suggested"
              );
            }
          } else throw e;
        }
      }

      const lastAt = new Date((normalized.timestamp || Math.floor(Date.now() / 1000)) * 1000);
      const preview = normalized.content?.text ? String(normalized.content.text).slice(0, 200) : "";
      const chatRow = await upsertChat(client, {
        customerId,
        phone: normalized.fromPhone,
        lastMessageAt: lastAt,
        lastMessageText: preview,
        lastMessageType: normalized.type || "text",
      });
      postChatId = chatRow.id;

      await saveMessageAndUpdateChat(client, {
        chatId: postChatId,
        customerId,
        normalized,
        eventType,
      });

      postAction = "existing_welcome";
    } else {
      // ── El teléfono NO está en customers ────────────────────────────
      const chatState = await getCrmChatState(client, normalized.fromPhone);
      msgLog.info(
        { fromPhone: normalized.fromPhone, chatState: chatState || null },
        "tipo_h_chat_state_lookup"
      );

      const messageText = normalized.content?.text ? String(normalized.content.text).trim() : "";

      // isValidFullName es async: valida con IA para 2-4 palabras; fallback estático si IA falla.
      // Retorna: true | false | 'ASK_SURNAME'
      let nameValidationResult = false;
      if (isInboundMessagesReceived(eventType) && (normalized.type || "text") !== "reaction" && messageText.length > 0) {
        nameValidationResult = await isValidFullName(messageText);
      }
      const isInboundText = nameValidationResult === true;
      const isAskSurnameResult = nameValidationResult === "ASK_SURNAME";

      // Pre-computar confirmedName con fallback para partículas (De La Cruz, Del Valle, etc.)
      // que la IA acepta pero NON_NAME_WORDS rechaza en normalizeOnboardingNameUpper.
      const confirmedName = isInboundText
        ? (normalizeOnboardingNameUpper(messageText) || sanitizeWaPersonName(messageText)?.toUpperCase())?.slice(0, 200) || null
        : null;
      // Solo procesar registro si también tenemos el nombre normalizado
      const isInboundTextFinal = isInboundText && Boolean(confirmedName);

      // Detecta si este messageId es el mismo que disparó la creación del estado
      // (webhook duplicado sobre el primer mensaje → no tratar como nombre).
      const isTriggerReplay =
        chatState != null &&
        chatState.trigger_message_id != null &&
        chatState.trigger_message_id === normalized.messageId;

      if (chatState && chatState.status === "AWAITING_NAME" && !isTriggerReplay && isInboundTextFinal) {
        // ══════════════════════════════════════════════════════════════
        // CASO 2: AWAITING_NAME + texto recibido → registrar cliente
        // ══════════════════════════════════════════════════════════════
        postConfirmedName = confirmedName;

        // Crear cliente vía resolveCustomerId (maneja identities, ML buyer match, etc.)
        // Para nombres de ≥2 palabras enrichCustomer también actualizará full_name;
        // el UPDATE directo posterior garantiza MAYÚSCULAS y cubre nombres de 1 palabra.
        const { customerId, waMlBuyerTipoECheck } = await resolveCustomerId(
          client,
          normalized.fromPhone,
          {
            name: confirmedName,
            ...(cn ? { contact_name: cn } : {}),
          }
        );
        postCustomerId = customerId;
        postWaMlBuyerCheck = waMlBuyerTipoECheck;

        // UPDATE directo: garantiza MAYÚSCULAS + cubre nombre de 1 palabra
        try {
          await client.query(
            `UPDATE customers SET
               full_name      = $1,
               name_suggested = COALESCE(name_suggested, $2),
               updated_at     = NOW()
             WHERE id = $3
               AND (
                 TRIM(full_name) = 'Cliente WhatsApp' OR
                 TRIM(full_name) = 'Cliente'           OR
                 full_name LIKE 'WA-%'                 OR
                 COALESCE(TRIM(full_name), '') = ''
               )`,
            [confirmedName, chatState.push_name || null, customerId]
          );
        } catch (e) {
          if (e && e.code === "42703") {
            /* name_suggested aún no existe: actualizar solo full_name */
            await client.query(
              `UPDATE customers SET full_name = $1, updated_at = NOW()
               WHERE id = $2
                 AND (
                   TRIM(full_name) = 'Cliente WhatsApp' OR
                   TRIM(full_name) = 'Cliente'           OR
                   full_name LIKE 'WA-%'                 OR
                   COALESCE(TRIM(full_name), '') = ''
                 )`,
              [confirmedName, customerId]
            );
          } else throw e;
        }

        // Atómico: eliminar estado junto con la creación del cliente
        await deleteCrmChatState(client, normalized.fromPhone);

        const lastAt = new Date((normalized.timestamp || Math.floor(Date.now() / 1000)) * 1000);
        const preview = messageText.slice(0, 200);
        const chatRow = await upsertChat(client, {
          customerId,
          phone: normalized.fromPhone,
          lastMessageAt: lastAt,
          lastMessageText: preview,
          lastMessageType: normalized.type || "text",
        });
        postChatId = chatRow.id;

        // Tras confirmar nombre ya enviamos respuesta; marcar bienvenida como enviada
        // evita que el siguiente mensaje vuelva a disparar "Hola {{nombre}}...".
        try {
          await client.query(
            `UPDATE crm_chats
             SET wa_welcome_pending_name = FALSE,
                 wa_welcome_sent_at = COALESCE(wa_welcome_sent_at, NOW())
             WHERE id = $1`,
            [postChatId]
          );
        } catch (_e) { /* columna puede no existir */ }

        await saveMessageAndUpdateChat(client, {
          chatId: postChatId,
          customerId,
          normalized,
          eventType,
        });

        postAction = "confirm_name";
      } else if (
        chatState &&
        chatState.status === "AWAITING_NAME" &&
        !isTriggerReplay &&
        isInboundMessagesReceived(eventType) &&
        (normalized.type || "text") === "text" &&
        messageText.length > 0 &&
        !isInboundTextFinal
      ) {
        // Texto no válido como nombre completo (frase, 1 palabra, etc.) → Tipo M sin customer
        // (crm_chats.phone = fromPhone; customer_id NULL hasta que registre nombre en otro mensaje).
        msgLog.info(
          {
            fromPhone: normalized.fromPhone,
            messageText: messageText.slice(0, 120),
            askSurname: isAskSurnameResult,
          },
          "tipo_m_awaiting_name_non_valid_text"
        );
        const lastAt = new Date((normalized.timestamp || Math.floor(Date.now() / 1000)) * 1000);
        const preview = messageText.slice(0, 200);
        const chatRow = await upsertChat(client, {
          customerId: null,
          phone: normalized.fromPhone,
          lastMessageAt: lastAt,
          lastMessageText: preview,
          lastMessageType: normalized.type || "text",
        });
        postChatId = chatRow.id;
        await saveMessageAndUpdateChat(client, {
          chatId: postChatId,
          customerId: null,
          normalized,
          eventType,
        });
        postAction = null;
      } else if (!chatState || isTriggerReplay) {
        // ══════════════════════════════════════════════════════════════
        // CASO 3: Contacto completamente nuevo (o mismo trigger replay)
        // NO tocar customers, crm_chats ni crm_messages.
        // ══════════════════════════════════════════════════════════════
        if (isInboundMessagesReceived(eventType) && (normalized.type || "text") !== "reaction") {
          await upsertCrmChatStateAwaitingName(
            client,
            normalized.fromPhone,
            cn || null,
            normalized.messageId
          );
          postAction = "ask_name";
        }
      }
      // else: AWAITING_NAME pero media/reacción/vacío → no hacer nada, estado permanece.
    }

    await client.query("COMMIT");
    msgLog.info({ fromPhone: normalized.fromPhone, postAction, postCustomerId }, "tipo_h_post_commit");

    // ── Post-commit ──────────────────────────────────────────────────
    if (postAction === "existing_welcome") {
      if (isInboundMessagesReceived(eventType) && (normalized.type || "text") !== "reaction") {
        setImmediate(() => {
          const ctx = { chatId: postChatId, customerId: postCustomerId, phoneRaw: normalized.fromPhone };
          const logSkip = (step, r) => {
            if (!r || r.ok) return;
            const o = r.outcome;
            if (o === "already_sent" || o === "not_pending") return;
            msgLog.info({ ...ctx, step, outcome: o }, "crm_welcome_no_enviado");
          };
          Promise.resolve()
            .then(() =>
              trySendCrmWaWelcome({
                chatId: postChatId,
                customerId: postCustomerId,
                phoneRaw: normalized.fromPhone,
              })
            )
            .then((r) => {
              logSkip("trySendCrmWaWelcome", r);
              return trySendCrmWaWelcomeAfterName({
                chatId: postChatId,
                customerId: postCustomerId,
                phoneRaw: normalized.fromPhone,
              });
            })
            .then((r) => logSkip("trySendCrmWaWelcomeAfterName", r))
            .catch((err) => msgLog.error({ err, ...ctx }, "trySendCrmWaWelcome"));
        });
      }
    } else if (postAction === "confirm_name") {
      setImmediate(() => {
        Promise.resolve()
          .then(() =>
            trySendCrmWaWelcomeNameConfirmation({
              chatId: postChatId,
              customerId: postCustomerId,
              phoneRaw: normalized.fromPhone,
              confirmedName: postConfirmedName,
            })
          )
          .then((r) => {
            if (r && r.ok) return;
            // Fallback: si falla la confirmación, intenta saludo estándar para no quedar sin respuesta.
            msgLog.warn(
              { outcome: r && r.outcome, chatId: postChatId, customerId: postCustomerId },
              "crm_name_confirm_failed_fallback_to_welcome"
            );
            return trySendCrmWaWelcome({
              chatId: postChatId,
              customerId: postCustomerId,
              phoneRaw: normalized.fromPhone,
            });
          })
          .catch((err) =>
            msgLog.error(
              { err, chatId: postChatId, customerId: postCustomerId },
              "trySendCrmWaWelcomeNameConfirmation"
            )
          );
      });
    } else if (postAction === "ask_name") {
      const _askPhone = normalized.fromPhone;
      msgLog.info({ phoneRaw: _askPhone }, "tipo_h_ask_name_dispatch");
      setImmediate(() => {
        Promise.resolve()
          .then(() => trySendCrmWaAskName({ phoneRaw: _askPhone }))
          .then((r) => {
            msgLog.info({ outcome: r && r.outcome, ok: r && r.ok, phoneRaw: _askPhone }, "tipo_h_ask_name_result");
            if (r && r.ok) return;
            msgLog.warn(
              { outcome: r && r.outcome, phoneRaw: _askPhone },
              "trySendCrmWaAskName_not_sent"
            );
          })
          .catch((err) => msgLog.error({ err, phoneRaw: _askPhone }, "trySendCrmWaAskName"));
      });
    }

    if (postWaMlBuyerCheck) {
      setImmediate(() => {
        runWaMlBuyerMatchTipoE({
          ...postWaMlBuyerCheck,
          customerId: postCustomerId,
        }).catch((err) => {
          msgLog.error({ err }, "runWaMlBuyerMatchTipoE");
        });
      });
    }
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch (_r) {
      /* ignore */
    }
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { handle };
