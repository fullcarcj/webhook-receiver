#!/usr/bin/env node
"use strict";

/**
 * Genera scripts/eval/nlu-eval-set.template.json (50 casos v2).
 * Ejecutar: node scripts/eval/generate-nlu-eval-template.js
 *
 * Regla gold (apodos: la vieja, la nave, mi carrito, etc.):
 * Si el texto NO menciona explícitamente marca o modelo (año solo no basta),
 * expected.vehicle = null, difficulty hard, reply_hint pedir_aclaracion.
 * Excepción: hay modelo/marca en el mensaje aunque haya apodo
 * (ej. "mi carrito century 2008", "mi corola del 18").
 */

const fs = require("fs");
const path = require("path");

const out = [];

function row(o) {
  out.push(o);
}

/* product_clear 12 */
row({
  id: "vzl_001",
  bucket: "product_clear",
  difficulty: "easy",
  expected_confidence_band: "alta",
  text: "buenas tienen pastillas de freno para un corolla 2018?",
  expected: {
    intent: "consulta_producto",
    vehicle: { make: "Toyota", model: "Corolla", year: 2018 },
    parts: [{ category: "pastilla_freno", position: null }],
    reply_hint: "cotizar_inmediato",
  },
  notes: "Claro, sin tildes",
});
row({
  id: "vzl_002",
  bucket: "product_clear",
  difficulty: "easy",
  expected_confidence_band: "alta",
  text: "nesecito filtro de aceite para aveo 2012 x favor",
  expected: {
    intent: "consulta_producto",
    vehicle: { make: "Chevrolet", model: "Aveo", year: 2012 },
    parts: [{ category: "filtro_aceite", position: null }],
    reply_hint: "cotizar_inmediato",
  },
  notes: "typo + x favor",
});
row({
  id: "vzl_003",
  bucket: "product_clear",
  difficulty: "easy",
  expected_confidence_band: "alta",
  text: "Tienen amortiguador trasero para Nissan Tiida 2010?",
  expected: {
    intent: "consulta_producto",
    vehicle: { make: "Nissan", model: "Tiida", year: 2010 },
    parts: [{ category: "amortiguador", position: "trasero" }],
    reply_hint: "cotizar_inmediato",
  },
  notes: "",
});
row({
  id: "vzl_004",
  bucket: "product_clear",
  difficulty: "easy",
  expected_confidence_band: "alta",
  text: "epale pana tienen bateria para spark 2015?",
  expected: {
    intent: "consulta_producto",
    vehicle: { make: "Chevrolet", model: "Spark", year: 2015 },
    parts: [{ category: "bateria", position: null }],
    reply_hint: "cotizar_inmediato",
  },
  notes: "jerga + sin tilde",
});
row({
  id: "vzl_005",
  bucket: "product_clear",
  difficulty: "easy",
  expected_confidence_band: "alta",
  text: "BUENAS 🙏 disco de freno delantero para Hilux 2019 tienen?",
  expected: {
    intent: "consulta_producto",
    vehicle: { make: "Toyota", model: "Hilux", year: 2019 },
    parts: [{ category: "disco_freno", position: "delantero" }],
    reply_hint: "cotizar_inmediato",
  },
  notes: "mayúsculas + emoji",
});
row({
  id: "vzl_006",
  bucket: "product_clear",
  difficulty: "medium",
  expected_confidence_band: "media",
  text: "liquido de frenos dot4 para mi carrito century 2008",
  expected: {
    intent: "consulta_producto",
    vehicle: { make: "Chevrolet", model: "Century", year: 2008 },
    parts: [{ category: "liquido_freno", position: null }],
    reply_hint: "cotizar_inmediato",
  },
  notes:
    "Apodo 'carrito' pero modelo Century explícito — gold con vehicle (excepción).",
});
row({
  id: "vzl_007",
  bucket: "product_clear",
  difficulty: "easy",
  expected_confidence_band: "alta",
  text: "correia distribucion con tensor hyundai accent 2014",
  expected: {
    intent: "consulta_producto",
    vehicle: { make: "Hyundai", model: "Accent", year: 2014 },
    parts: [{ category: "correa", position: null }],
    reply_hint: "cotizar_inmediato",
  },
  notes: "correia typo",
});
row({
  id: "vzl_008",
  bucket: "product_clear",
  difficulty: "easy",
  expected_confidence_band: "alta",
  text: "filtro aire renault logan 2016 cuanto sale",
  expected: {
    intent: "consulta_producto",
    vehicle: { make: "Renault", model: "Logan", year: 2016 },
    parts: [{ category: "filtro_aire", position: null }],
    reply_hint: "cotizar_inmediato",
  },
  notes: "",
});
row({
  id: "vzl_009",
  bucket: "product_clear",
  difficulty: "medium",
  expected_confidence_band: "media",
  text: "k tienen bujia para getz 2007",
  expected: {
    intent: "consulta_producto",
    vehicle: { make: "Hyundai", model: "Getz", year: 2007 },
    parts: [{ category: "bujia", position: null }],
    reply_hint: "cotizar_inmediato",
  },
  notes: "k tienen",
});
row({
  id: "vzl_010",
  bucket: "product_clear",
  difficulty: "easy",
  expected_confidence_band: "alta",
  text: "neumatico 185/65 r15 para fiat palio 2010",
  expected: {
    intent: "consulta_producto",
    vehicle: { make: "Fiat", model: "Palio", year: 2010 },
    parts: [{ category: "neumatico", position: null }],
    reply_hint: "cotizar_inmediato",
  },
  notes: "",
});
row({
  id: "vzl_011",
  bucket: "product_clear",
  difficulty: "easy",
  expected_confidence_band: "alta",
  text: "Fortuner 2015 filtro combustible hay?",
  expected: {
    intent: "consulta_producto",
    vehicle: { make: "Toyota", model: "Fortuner", year: 2015 },
    parts: [{ category: "filtro_combustible", position: null }],
    reply_hint: "cotizar_inmediato",
  },
  notes: "",
});
row({
  id: "vzl_012",
  bucket: "product_clear",
  difficulty: "medium",
  expected_confidence_band: "media",
  text: "barra estabilizadora delantera ecosport 2013 precio",
  expected: {
    intent: "consulta_producto",
    vehicle: { make: "Ford", model: "Ecosport", year: 2013 },
    parts: [{ category: "barra_estabilizadora", position: "delantero" }],
    reply_hint: "cotizar_inmediato",
  },
  notes: "",
});

/* product_ambiguous 10 */
row({
  id: "vzl_013",
  bucket: "product_ambiguous",
  difficulty: "hard",
  expected_confidence_band: "baja",
  text: "algo para el freno que rechina la vieja 2018",
  expected: {
    intent: "consulta_producto",
    vehicle: null,
    parts: [{ category: "pastilla_freno", position: null }],
    reply_hint: "pedir_aclaracion",
  },
  notes:
    "Sin marca/modelo explícitos. El modelo debe reconocer que falta info y pedir aclaración, no inventar.",
});
row({
  id: "vzl_014",
  bucket: "product_ambiguous",
  difficulty: "hard",
  expected_confidence_band: "baja",
  text: "pieza del motor que hace ruido",
  expected: {
    intent: "consulta_producto",
    vehicle: null,
    parts: [{ category: "otro", position: null }],
    reply_hint: "pedir_aclaracion",
  },
  notes: "",
});
row({
  id: "vzl_015",
  bucket: "product_ambiguous",
  difficulty: "medium",
  expected_confidence_band: "media",
  text: "amortigadores para aveo sin año",
  expected: {
    intent: "consulta_producto",
    vehicle: { make: "Chevrolet", model: "Aveo", year: null },
    parts: [{ category: "amortiguador", position: null }],
    reply_hint: "pedir_aclaracion",
  },
  notes: "year null",
});
row({
  id: "vzl_016",
  bucket: "product_ambiguous",
  difficulty: "hard",
  expected_confidence_band: "baja",
  text: "d los frenos de la nave q chirrian",
  expected: {
    intent: "consulta_producto",
    vehicle: null,
    parts: [{ category: "pastilla_freno", position: null }],
    reply_hint: "pedir_aclaracion",
  },
  notes:
    "Sin marca/modelo explícitos ('la nave' es apodo). El modelo debe reconocer que falta info y pedir aclaración, no inventar.",
});
row({
  id: "vzl_017",
  bucket: "product_ambiguous",
  difficulty: "hard",
  expected_confidence_band: "baja",
  text: "repuesto pa lo q te dije ayer",
  expected: {
    intent: "otro",
    vehicle: null,
    parts: [],
    reply_hint: "pedir_aclaracion",
  },
  notes: "contexto externo",
});
row({
  id: "vzl_018",
  bucket: "product_ambiguous",
  difficulty: "medium",
  expected_confidence_band: "media",
  text: "terios 2007 goma de ventana",
  expected: {
    intent: "consulta_producto",
    vehicle: { make: "Toyota", model: "Terios", year: 2007 },
    parts: [{ category: "otro", position: null }],
    reply_hint: "cotizar_inmediato",
  },
  notes: "",
});
row({
  id: "vzl_019",
  bucket: "product_ambiguous",
  difficulty: "medium",
  expected_confidence_band: "media",
  text: "pastillaz delanteras versan 2019",
  expected: {
    intent: "consulta_producto",
    vehicle: { make: "Nissan", model: "Versa", year: 2019 },
    parts: [{ category: "pastilla_freno", position: "delantero" }],
    reply_hint: "cotizar_inmediato",
  },
  notes: "typo pastillaz",
});
row({
  id: "vzl_020",
  bucket: "product_ambiguous",
  difficulty: "hard",
  expected_confidence_band: "baja",
  text: "k vaina es esta con el clutch",
  expected: {
    intent: "consulta_producto",
    vehicle: null,
    parts: [{ category: "otro", position: null }],
    reply_hint: "pedir_aclaracion",
  },
  notes: "",
});
row({
  id: "vzl_021",
  bucket: "product_ambiguous",
  difficulty: "medium",
  expected_confidence_band: "media",
  text: "rodamiento delantero pero no se modelo exacto es un picanto viejo",
  expected: {
    intent: "consulta_producto",
    vehicle: { make: "Kia", model: "Picanto", year: null },
    parts: [{ category: "rodamiento", position: "delantero" }],
    reply_hint: "pedir_aclaracion",
  },
  notes: "",
});
row({
  id: "vzl_021b",
  bucket: "product_ambiguous",
  difficulty: "hard",
  expected_confidence_band: "baja",
  text: "tienen eso del tensor q sale debajo del carro",
  expected: {
    intent: "consulta_producto",
    vehicle: null,
    parts: [{ category: "correa", position: null }],
    reply_hint: "pedir_aclaracion",
  },
  notes: "10º ambiguo",
});
row({
  id: "vzl_022",
  bucket: "product_noisy",
  difficulty: "hard",
  expected_confidence_band: "media",
  text: "epale pana tcuento q mi corola del 18 esta haciendo un ruidito x las ruedas d adelante cuando freno 😬 q sera? necesitare pastillas o es otra cosa?",
  expected: {
    intent: "consulta_producto",
    vehicle: { make: "Toyota", model: "Corolla", year: 2018 },
    parts: [{ category: "pastilla_freno", position: "delantero" }],
    reply_hint: "cotizar_inmediato",
  },
  notes: "hard ejemplo spec",
});

/* product_noisy: need 5 more to reach 6 total - vzl_022 is 1, add vzl_023-027 */
row({
  id: "vzl_023",
  bucket: "product_noisy",
  difficulty: "medium",
  expected_confidence_band: "media",
  text: "necesito bateria para tiida 2013 tienen",
  expected: {
    intent: "consulta_producto",
    vehicle: { make: "Nissan", model: "Tiida", year: 2013 },
    parts: [{ category: "bateria", position: null }],
    reply_hint: "cotizar_inmediato",
  },
  notes: "sin tildes",
});
row({
  id: "vzl_024",
  bucket: "product_noisy",
  difficulty: "hard",
  expected_confidence_band: "media",
  text: "x favor frenos para corrola 2017 🙏😅",
  expected: {
    intent: "consulta_producto",
    vehicle: { make: "Toyota", model: "Corolla", year: 2017 },
    parts: [{ category: "pastilla_freno", position: null }],
    reply_hint: "cotizar_inmediato",
  },
  notes: "corrola typo",
});
row({
  id: "vzl_025",
  bucket: "product_noisy",
  difficulty: "medium",
  expected_confidence_band: "media",
  text: "Do you ship brake pads for Frontier 2014",
  expected: {
    intent: "consulta_producto",
    vehicle: { make: "Nissan", model: "Frontier", year: 2014 },
    parts: [{ category: "pastilla_freno", position: null }],
    reply_hint: "cotizar_inmediato",
  },
  notes: "inglés",
});
row({
  id: "vzl_026",
  bucket: "product_noisy",
  difficulty: "hard",
  expected_confidence_band: "baja",
  text: "foto del repuesto 📷",
  expected: {
    intent: "otro",
    vehicle: null,
    parts: [],
    reply_hint: "ninguna",
  },
  notes: "sin imagen",
});
row({
  id: "vzl_027",
  bucket: "product_noisy",
  difficulty: "hard",
  expected_confidence_band: "baja",
  text: "[nota de voz transcrita con erores] ose pastiya freo corola",
  expected: {
    intent: "consulta_producto",
    vehicle: { make: "Toyota", model: "Corolla", year: null },
    parts: [{ category: "pastilla_freno", position: null }],
    reply_hint: "pedir_aclaracion",
  },
  notes: "audio mal transcrito",
});

/* payment_info 4 */
row({
  id: "vzl_028",
  bucket: "payment_info",
  difficulty: "easy",
  expected_confidence_band: "alta",
  text: "ya pagué por pago móvil ref 0145788",
  expected: {
    intent: "pago_informado",
    vehicle: null,
    parts: [],
    reply_hint: "ninguna",
  },
  notes: "",
});
row({
  id: "vzl_029",
  bucket: "payment_info",
  difficulty: "easy",
  expected_confidence_band: "alta",
  text: "te mande el comprobante por aqui",
  expected: {
    intent: "pago_informado",
    vehicle: null,
    parts: [],
    reply_hint: "ninguna",
  },
  notes: "",
});
row({
  id: "vzl_030",
  bucket: "payment_info",
  difficulty: "medium",
  expected_confidence_band: "media",
  text: "mire le envie 120 bs x favor confirme",
  expected: {
    intent: "pago_informado",
    vehicle: null,
    parts: [],
    reply_hint: "ninguna",
  },
  notes: "",
});
row({
  id: "vzl_031",
  bucket: "payment_info",
  difficulty: "easy",
  expected_confidence_band: "alta",
  text: "LISTO PAGADO",
  expected: {
    intent: "pago_informado",
    vehicle: null,
    parts: [],
    reply_hint: "ninguna",
  },
  notes: "",
});

/* order_followup 3 */
row({
  id: "vzl_032",
  bucket: "order_followup",
  difficulty: "easy",
  expected_confidence_band: "alta",
  text: "donde esta mi pedido?",
  expected: {
    intent: "seguimiento_pedido",
    vehicle: null,
    parts: [],
    reply_hint: "ninguna",
  },
  notes: "",
});
row({
  id: "vzl_033",
  bucket: "order_followup",
  difficulty: "easy",
  expected_confidence_band: "alta",
  text: "ya despacharon lo q compré?",
  expected: {
    intent: "seguimiento_pedido",
    vehicle: null,
    parts: [],
    reply_hint: "ninguna",
  },
  notes: "",
});
row({
  id: "vzl_034",
  bucket: "order_followup",
  difficulty: "medium",
  expected_confidence_band: "media",
  text: "llego o no llego el envio chamo",
  expected: {
    intent: "seguimiento_pedido",
    vehicle: null,
    parts: [],
    reply_hint: "ninguna",
  },
  notes: "",
});

/* greeting 4 */
row({
  id: "vzl_035",
  bucket: "greeting",
  difficulty: "easy",
  expected_confidence_band: "alta",
  text: "hola buenos dias",
  expected: {
    intent: "saludo",
    vehicle: null,
    parts: [],
    reply_hint: "saludar",
  },
  notes: "",
});
row({
  id: "vzl_036",
  bucket: "greeting",
  difficulty: "easy",
  expected_confidence_band: "alta",
  text: "epale que fino todo",
  expected: {
    intent: "saludo",
    vehicle: null,
    parts: [],
    reply_hint: "saludar",
  },
  notes: "",
});
row({
  id: "vzl_037",
  bucket: "greeting",
  difficulty: "easy",
  expected_confidence_band: "alta",
  text: "gracias mil",
  expected: {
    intent: "despedida",
    vehicle: null,
    parts: [],
    reply_hint: "ninguna",
  },
  notes:
    "Agradecimiento final; dominante cierre (no apertura). En raros casos puede ser cortesía inicial.",
});
row({
  id: "vzl_038",
  bucket: "greeting",
  difficulty: "easy",
  expected_confidence_band: "alta",
  text: "chao nos vemos",
  expected: {
    intent: "despedida",
    vehicle: null,
    parts: [],
    reply_hint: "ninguna",
  },
  notes: "",
});

/* complaint 4 */
row({
  id: "vzl_039",
  bucket: "complaint",
  difficulty: "medium",
  expected_confidence_band: "media",
  text: "me mandaron mal la pieza esto es un abuso",
  expected: {
    intent: "queja",
    vehicle: null,
    parts: [],
    reply_hint: "derivar_humano",
  },
  notes: "",
});
row({
  id: "vzl_040",
  bucket: "complaint",
  difficulty: "medium",
  expected_confidence_band: "media",
  text: "el envio llego tarde y golpeado",
  expected: {
    intent: "queja",
    vehicle: null,
    parts: [],
    reply_hint: "derivar_humano",
  },
  notes: "",
});
row({
  id: "vzl_041",
  bucket: "complaint",
  difficulty: "easy",
  expected_confidence_band: "alta",
  text: "mal servicio nojoda",
  expected: {
    intent: "queja",
    vehicle: null,
    parts: [],
    reply_hint: "derivar_humano",
  },
  notes: "",
});
row({
  id: "vzl_042",
  bucket: "complaint",
  difficulty: "medium",
  expected_confidence_band: "media",
  text: "quiero devolucion ya",
  expected: {
    intent: "queja",
    vehicle: null,
    parts: [],
    reply_hint: "derivar_humano",
  },
  notes: "",
});

/* handoff_request 3 */
row({
  id: "vzl_043",
  bucket: "handoff_request",
  difficulty: "easy",
  expected_confidence_band: "alta",
  text: "necesito hablar con alguien de verdad, este bot no me entiende",
  expected: {
    intent: "handoff_humano",
    vehicle: null,
    parts: [],
    reply_hint: "derivar_humano",
  },
  notes: "spec ejemplo",
});
row({
  id: "vzl_044",
  bucket: "handoff_request",
  difficulty: "easy",
  expected_confidence_band: "alta",
  text: "pasame con un asesor por favor",
  expected: {
    intent: "handoff_humano",
    vehicle: null,
    parts: [],
    reply_hint: "derivar_humano",
  },
  notes: "",
});
row({
  id: "vzl_045",
  bucket: "handoff_request",
  difficulty: "easy",
  expected_confidence_band: "alta",
  text: "operador humano ya",
  expected: {
    intent: "handoff_humano",
    vehicle: null,
    parts: [],
    reply_hint: "derivar_humano",
  },
  notes: "",
});

/* noise 4 */
row({
  id: "vzl_046",
  bucket: "noise",
  difficulty: "hard",
  expected_confidence_band: "baja",
  text: "👍",
  expected: {
    intent: "otro",
    vehicle: null,
    parts: [],
    reply_hint: "ninguna",
  },
  notes: "spec ejemplo emoji",
});
row({
  id: "vzl_047",
  bucket: "noise",
  difficulty: "hard",
  expected_confidence_band: "baja",
  text: "ok",
  expected: {
    intent: "otro",
    vehicle: null,
    parts: [],
    reply_hint: "ninguna",
  },
  notes: "",
});
row({
  id: "vzl_048",
  bucket: "noise",
  difficulty: "hard",
  expected_confidence_band: "baja",
  text: "asdf qwe 123",
  expected: {
    intent: "otro",
    vehicle: null,
    parts: [],
    reply_hint: "ninguna",
  },
  notes: "",
});
row({
  id: "vzl_049",
  bucket: "noise",
  difficulty: "hard",
  expected_confidence_band: "baja",
  text: "🔧🚗💨",
  expected: {
    intent: "otro",
    vehicle: null,
    parts: [],
    reply_hint: "ninguna",
  },
  notes: "",
});

const pack = {
  meta: {
    purpose: "ADR-003 · eval NLU v2 · realismo VE + enum español",
    version: "2",
    counts: {
      product_clear: 12,
      product_ambiguous: 10,
      product_noisy: 6,
      payment_info: 4,
      order_followup: 3,
      greeting: 4,
      complaint: 4,
      handoff_request: 3,
      noise: 4,
    },
  },
  messages: out,
};

const target = path.join(__dirname, "nlu-eval-set.template.json");
fs.writeFileSync(target, JSON.stringify(pack, null, 2), "utf8");
console.log("Escrito", target, "mensajes:", out.length);
