/**
 * Convención de negocio para mensajería automática ML (tag post_sale en API).
 * No es un campo de Mercado Libre: sirve para documentar y enlazar código con cada flujo.
 */

/** Post-venta al recibir la orden (webhook orders_v2 / topic messages). Máx. un envío efectivo por orden; pasos extra respetan 1/día por paso (zona ML_AUTO_MESSAGE_TIMEZONE). */
const MESSAGE_TYPE_A = "tipo_a_post_venta_orden";

/** Recordatorio de retiro / despacho en tienda. Franjas mañana y tarde (p. ej. 7:30 y 14:20 en ML_RETIRO_TIMEZONE); como máximo uno por slot y comprador por día. */
const MESSAGE_TYPE_B = "tipo_b_recordatorio_tienda";

/** Recordatorio para que el comprador califique. Tras calificar el vendedor al comprador; 1/día por comprador y hasta ML_RATING_REQUEST_MAX_DAYS (def. 8) envíos por orden mientras siga pendiente la calificación compra→vendedor. */
const MESSAGE_TYPE_C = "tipo_c_recordatorio_calificacion";

/** Respuestas automáticas a preguntas de publicaciones (POST /answers, `ml-questions-ia-auto.js`). */
const MESSAGE_TYPE_D = "tipo_d_preguntas_auto";

/** WhatsApp (Wasender API): aviso al comprador identificado por orden (p. ej. oferta / compra); usa `ml_buyers.phone_1` y `phone_2`. Ver `ml-whatsapp-tipo-ef.js`. */
const MESSAGE_TYPE_E = "tipo_e_whatsapp_orden";

/** WhatsApp (Wasender API): mensaje al comprador identificado por pregunta ML (`ml_questions_*`); usa `ml_buyers.phone_1` y `phone_2`. Ver `ml-whatsapp-tipo-ef.js`. */
const MESSAGE_TYPE_F = "tipo_f_whatsapp_pregunta";

/**
 * Origen FileMaker: POST dedicado actualiza comprador y encadena tipo E (mismo envío Wasender que tipo E).
 * Ver `ml-filemaker-tipo-g.js` y tabla `ml_filemaker_tipo_g_log`.
 */
const MESSAGE_TYPE_G = "tipo_g_filemaker_retiro";

module.exports = {
  MESSAGE_TYPE_A,
  MESSAGE_TYPE_B,
  MESSAGE_TYPE_C,
  MESSAGE_TYPE_D,
  MESSAGE_TYPE_E,
  MESSAGE_TYPE_F,
  MESSAGE_TYPE_G,
};
