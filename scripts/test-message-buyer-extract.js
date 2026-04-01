const assert = require("assert");
const { extractBuyerIdForPostSale } = require("../ml-buyer-extract");

const SELLER_ID = 22696929;
const BUYER_ID = 1335920698;

const payloads = [
  {
    name: "root to array",
    data: {
      from: { user_id: BUYER_ID },
      to: [{ user_id: SELLER_ID }],
      text: { plain: "04123333074" },
      order_id: 2000015794834688,
    },
  },
  {
    name: "nested message to array",
    data: {
      message: {
        from: { user_id: BUYER_ID },
        to: [{ user_id: SELLER_ID }],
        text: { plain: "04123333074" },
      },
    },
  },
  {
    name: "messages[0] to array",
    data: {
      messages: [
        {
          from: { user_id: SELLER_ID },
          to: [{ user_id: BUYER_ID }],
          text: { plain: "04123333074" },
        },
      ],
    },
  },
];

for (const testCase of payloads) {
  const buyerId = extractBuyerIdForPostSale(testCase.data, SELLER_ID);
  assert.equal(buyerId, BUYER_ID, `fallo en ${testCase.name}`);
}

console.log("OK message buyer extraction cases passed");
