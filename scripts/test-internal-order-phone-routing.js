const assert = require("assert");
const Module = require("module");

const updates = [];
const sends = [];
const buyers = new Map([
  [1, null],
  [2, { phone_1: "", phone_2: null }],
  [3, { phone_1: "04111111111", phone_2: "" }],
  [4, { phone_1: "04111111111", phone_2: "04222222222" }],
]);

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent) {
  if (parent && /ml-whatsapp-internal-order-message\.js$/.test(parent.filename)) {
    if (request === "./db") {
      return {
        getMlBuyer: async (id) => buyers.get(id),
        upsertMlBuyer: async (row) => updates.push({ kind: "upsert", row }),
        updateMlBuyerPhones: async (id, row) => updates.push({ kind: "update", id, row }),
      };
    }
    if (request === "./ml-pack-extract") return { extractOrderIdFromMessage: () => 999 };
    if (request === "./ml-buyer-extract") return { extractBuyerIdForPostSale: (parsed) => parsed._buyerId };
    if (request === "./ml-whatsapp-tipo-ef") {
      return {
        trySendWhatsappTipoEForOrder: async (args) => {
          sends.push(args);
          return { ok: true, outcome: "sent" };
        },
      };
    }
  }
  return originalLoad.apply(this, arguments);
};

const mod = require("../ml-whatsapp-internal-order-message.js");

async function runCase(buyerId, phone) {
  const parsed = { _buyerId: buyerId, text: `hola ${phone}` };
  return mod.processOrderMessagePhoneForTipoE({
    mlUserId: 9309737,
    parsed,
    tipoEActivationSource: "mensajeria_pack_phone",
  });
}

(async () => {
  let result = await runCase(1, "04123333074");
  assert.equal(updates[0].kind, "upsert");
  assert.deepEqual(updates[0].row, { buyer_id: 1, phone_1: "04123333074", phone_2: null });
  assert.equal(result.buyer_slot, "phone_1");

  result = await runCase(2, "04124444075");
  assert.equal(updates[1].kind, "update");
  assert.deepEqual(updates[1].row, { phone_1: "04124444075" });
  assert.equal(result.buyer_slot, "phone_1");

  result = await runCase(3, "04125555076");
  assert.deepEqual(updates[2].row, { phone_2: "04125555076" });
  assert.equal(result.buyer_slot, "phone_2");

  result = await runCase(4, "04126666077");
  assert.deepEqual(updates[3].row, { phone_1: "04126666077" });
  assert.equal(result.buyer_slot, "phone_1");

  assert.deepEqual(
    sends.map((row) => row.overridePhoneRaw),
    ["04123333074", "04124444075", "04125555076", "04126666077"]
  );

  const nested = mod.extractMessageTextFromMlMessagePayload({
    messages: [{ text: { plain: "Tel 04123333074" } }],
  });
  assert.ok(
    nested.includes("04123333074"),
    "debe leer text.plain bajo messages[0] (payload real del webhook ML)"
  );
  assert.equal(mod.extractFirstMobile04(nested), "04123333074");

  console.log("OK buyer phone routing cases passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
