"use strict";

const botHandoffsService = require("../services/botHandoffsService");
const botActionsService  = require("../services/botActionsService");

/**
 * Decide si un pipeline del bot debe saltar la respuesta automática
 * porque un vendedor humano tomó el control del chat (handoff activo).
 *
 * Uso: llamar antes de generar o enviar respuesta automática.
 * - Devuelve true  → el caller NO envía nada (skip).
 * - Devuelve false → flujo normal del bot.
 *
 * La decisión (skip/no-skip) es SÍNCRONA y BLOQUEANTE.
 * El logging en bot_actions es FIRE-AND-FORGET (no bloquea si falla).
 *
 * @param {Object} params
 * @param {number|null} params.chatId        - requerido; sin chatId no hay guard
 * @param {number|null} [params.orderId]     - opcional, para trazabilidad
 * @param {string|null} [params.correlationId]
 * @returns {Promise<boolean>} true si debe saltar
 */
async function shouldSkipBotReply({ chatId, orderId = null, correlationId = null }) {
  if (!chatId) return false;

  const { active, handoff } = await botHandoffsService.isHandedOver(chatId);
  if (!active) return false;

  // Handoff activo — loguear fire-and-forget para trazabilidad (Paso 2 · bot_actions)
  botActionsService.log({
    chatId,
    orderId,
    actionType:   "handoff_triggered",
    inputContext: {
      reason:      "active_human_handoff",
      detectedBy:  "handoff_guard",
    },
    outputResult: {
      blocked:       true,
      handoffId:     handoff.id,
      handoffUserId: handoff.to_user_id,
      startedAt:     handoff.started_at,
    },
    provider:      "handoff_guard",
    correlationId,
  }).catch((err) => {
    console.error("[handoffGuard] bot_actions log falló (no crítico):", err.message);
  });

  return true;
}

module.exports = { shouldSkipBotReply };
