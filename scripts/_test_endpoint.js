"use strict";
require("../load-env-local");
const http = require("http");
const req = http.request({
  hostname: "localhost",
  port: process.env.PORT || 3002,
  path: "/api/inbox/counts?pipeline_default=1&facets=0",
  headers: { "X-Admin-Secret": process.env.ADMIN_SECRET || "admin" }
}, r => {
  let b = "";
  r.on("data", c => b += c);
  r.on("end", () => {
    console.log("STATUS:", r.statusCode);
    try { console.log(JSON.stringify(JSON.parse(b), null, 2)); } catch { console.log(b.slice(0, 500)); }
  });
});
req.on("error", e => console.error("ERROR:", e.message));
req.end();
