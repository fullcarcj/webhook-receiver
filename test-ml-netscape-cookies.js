/**
 * node test-ml-netscape-cookies.js
 */
const assert = require("assert");
const { buildCookieHeaderFromNetscapeFile } = require("./ml-netscape-cookies");

const netscape = [
  "# Netscape HTTP Cookie File",
  ".mercadolibre.com.ve\tTRUE\t/\tTRUE\t9999999999\tsid\tabc123",
  ".google.com\tTRUE\t/\tTRUE\t9999999999\tx\tignore",
].join("\n");

const jsonArr = JSON.stringify([
  {
    name: "ssid",
    value: "jwt-here",
    domain: ".mercadolibre.com.ve",
    path: "/",
    secure: true,
    expirationDate: 9999999999,
  },
  { name: "ignored", value: "x", domain: ".google.com" },
]);

const jsonWrapped = JSON.stringify({
  cookies: [{ name: "orguserid", value: "99", domain: "www.mercadolibre.com.ve" }],
});

const h1 = buildCookieHeaderFromNetscapeFile(netscape);
assert(h1.includes("sid=abc123"), h1);
assert(!h1.includes("ignore"));

const h2 = buildCookieHeaderFromNetscapeFile(jsonArr);
assert(h2.includes("ssid=jwt-here"), h2);
assert(!h2.includes("ignored"));

const h3 = buildCookieHeaderFromNetscapeFile(jsonWrapped);
assert(h3.includes("orguserid=99"), h3);

const headerStr = "Cookie: ssid=aa; orguserid=7";
const h4 = buildCookieHeaderFromNetscapeFile(headerStr);
assert(h4.includes("ssid=aa") && h4.includes("orguserid=7"), h4);

console.log("ok ml-netscape-cookies (Netscape + JSON + Header String)");
