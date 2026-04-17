"use strict";

/**
 * Política de datos por canal (solo referencia; la lógica vive en mostradorIdentityGate.js).
 */
module.exports = {
  whatsapp: {
    doc: "optional",
    phone: "required",
    email: "optional",
  },
  mercadolibre: {
    doc: "optional",
    phone: "optional",
    email: "optional",
  },
  mostrador: {
    doc: "required_or_consumidor_final",
    phone: "optional",
    email: "optional",
  },
};
