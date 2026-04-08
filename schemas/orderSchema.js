"use strict";

const { z } = require("zod");

const MOTIVOS_ANULACION = [
  "falta_stock",
  "no_respondio",
  "error_precio",
  "pago_rechazado",
  "solicitud_comprador",
  "duplicada",
  "otro",
];

const TIPOS_CALIFICACION_ML = [
  "positive_fulfilled",
  "positive_not_fulfilled",
  "negative_not_fulfilled",
];

const METODOS_DESPACHO = ["pick_up", "envio_gratis_ml", "envio_cod", "delivery_propio"];

const baseTransitionSchema = z.object({
  status: z.enum(["pagada", "anulada", "pendiente_entrega", "entregado", "archivado"]),
  changed_by: z.string().min(2).max(100),
  notes: z.string().max(500).optional(),
});

const pagadaSchema = baseTransitionSchema.extend({
  status: z.literal("pagada"),
  aprobado_por_user_id: z.string().min(2).max(100).optional(),
  es_pago_auto_banesco: z.boolean().default(false),
}).refine((data) => data.es_pago_auto_banesco === true || !!data.aprobado_por_user_id, {
  message: "aprobado_por_user_id es obligatorio salvo pagos automáticos Banesco",
  path: ["aprobado_por_user_id"],
});

const anuladaSchema = baseTransitionSchema.extend({
  status: z.literal("anulada"),
  motivo_anulacion: z.enum(MOTIVOS_ANULACION),
  tipo_calificacion_ml: z.enum(TIPOS_CALIFICACION_ML),
});

const pendienteEntregaSchema = baseTransitionSchema.extend({
  status: z.literal("pendiente_entrega"),
  metodo_despacho: z.enum(METODOS_DESPACHO),
});

const entregadoSchema = baseTransitionSchema.extend({
  status: z.literal("entregado"),
});

const archivadoSchema = baseTransitionSchema.extend({
  status: z.literal("archivado"),
  calificacion_ml: z.string().min(1).max(100),
});

function getTransitionSchema(status) {
  const schemas = {
    pagada: pagadaSchema,
    anulada: anuladaSchema,
    pendiente_entrega: pendienteEntregaSchema,
    entregado: entregadoSchema,
    archivado: archivadoSchema,
  };
  return schemas[status] ?? null;
}

module.exports = {
  getTransitionSchema,
  MOTIVOS_ANULACION,
  TIPOS_CALIFICACION_ML,
  METODOS_DESPACHO,
};
