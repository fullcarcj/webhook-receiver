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
 */

const pino = require("pino");
const { pool } = require("../../../db");
const { normalizePhone } = require("../../utils/phoneNormalizer");
const { resolveCustomerId, upsertChat } = require("./_shared");
const { pickWaFullNameCandidate, sanitizeWaPersonName, isLikelyChatNotName } = require("../waNameCandidate");
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

const msgLog = pino({ level: process.env.LOG_LEVEL || "info", name: "whatsapp_messages" });

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

function normalizeOnboardingNameUpper(rawText) {
  const raw = String(rawText || "").trim();
  if (!raw) return null;
  if (isLikelyChatNotName(raw)) return null;
  const sanitized = sanitizeWaPersonName(raw);
  if (!sanitized) return null;
  const lower = sanitized.toLowerCase();
  // Bloquea textos de prueba muy comunes que suelen contaminar customers.
  if (/\b(prueba|test|testing|nombre|apellido|nuevo|nueva|cliente)\b/i.test(lower)) return null;
  const words = sanitized.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 4) return null;
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
      const nameExtra = pickWaFullNameCandidate(normalized);
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
      const validatedOnboardingName = normalizeOnboardingNameUpper(messageText);
      const isInboundText =
        eventType === "messages.received" &&
        (normalized.type || "text") !== "reaction" &&
        Boolean(validatedOnboardingName);

      // Detecta si este messageId es el mismo que disparó la creación del estado
      // (webhook duplicado sobre el primer mensaje → no tratar como nombre).
      const isTriggerReplay =
        chatState != null &&
        chatState.trigger_message_id != null &&
        chatState.trigger_message_id === normalized.messageId;

      if (chatState && chatState.status === "AWAITING_NAME" && !isTriggerReplay && isInboundText) {
        // ══════════════════════════════════════════════════════════════
        // CASO 2: AWAITING_NAME + texto recibido → registrar cliente
        // ══════════════════════════════════════════════════════════════
        const confirmedName = String(validatedOnboardingName).slice(0, 200);
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
        eventType === "messages.received" &&
        (normalized.type || "text") === "text" &&
        messageText.length > 0 &&
        !validatedOnboardingName
      ) {
        // Mantiene el estado pendiente y vuelve a pedir nombre/apellido válido.
        postAction = "ask_name";
      } else if (!chatState || isTriggerReplay) {
        // ══════════════════════════════════════════════════════════════
        // CASO 3: Contacto completamente nuevo (o mismo trigger replay)
        // NO tocar customers, crm_chats ni crm_messages.
        // ══════════════════════════════════════════════════════════════
        if (eventType === "messages.received" && (normalized.type || "text") !== "reaction") {
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
      if (eventType === "messages.received" && (normalized.type || "text") !== "reaction") {
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
