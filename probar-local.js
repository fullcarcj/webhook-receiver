/**
 * Con el servidor ya en marcha (node server.js), ejecuta:
 *   node probar-local.js
 *
 * Opcional: PORT=3050 node probar-local.js
 */
const PORT = process.env.PORT || 3000;
const base = `http://127.0.0.1:${PORT}`;

async function main() {
  const sample = {
    _id: "local-test",
    topic: "orders_v2",
    resource: "/orders/2000015668755526",
    user_id: 1,
  };

  console.log("POST /reg.php …");
  const ins = await fetch(`${base}/reg.php`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sample),
  });
  const insJson = await ins.json();
  console.log(insJson);

  console.log("\nGET /reg?limit=5 …");
  const list = await fetch(`${base}/reg?limit=5`);
  const listJson = await list.json();
  console.log(JSON.stringify(listJson, null, 2));

  const id = insJson.id;
  if (id) {
    console.log(`\nDELETE /reg?id=${id} …`);
    const del = await fetch(`${base}/reg?id=${id}`, { method: "DELETE" });
    console.log(await del.json());
  }

  console.log("\nGET /reg (comprobación) …");
  const end = await fetch(`${base}/reg?limit=5`);
  console.log(JSON.stringify(await end.json(), null, 2));
}

main().catch((e) => {
  console.error(e.message);
  console.error("\n¿Está arrancado el servidor?  node server.js");
  process.exit(1);
});
