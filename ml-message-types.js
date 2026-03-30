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

module.exports = {
  MESSAGE_TYPE_A,
  MESSAGE_TYPE_B,
  MESSAGE_TYPE_C,
};
