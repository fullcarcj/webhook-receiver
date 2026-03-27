/**
 * Pruebas del extractor de nombre (guion FM) y celular sobre HTML sintético.
 * Uso:
 *   node test-ventas-detalle-celular.js
 * Con HTML real guardado en disco:
 *   node test-ventas-detalle-celular.js ruta/al/detalle.html
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  extractCelularFromVentasHtml,
  extractNombreApellidoFromVentasHtml,
  computeVentasDetalleAnchorPositions,
} = require("./ml-ventas-detalle-celular");

const delim = "\\u003e";

function buildHtmlNombre(nombre) {
  return `...padding "buyer_info_text" more "label" x${delim}1${delim}${nombre}${delim}tail...`;
}

function runSynthetic() {
  const nombre = "María Pérez";
  const htmlNombre = buildHtmlNombre(nombre);
  const pos = computeVentasDetalleAnchorPositions(htmlNombre);
  const idxBuyer = htmlNombre.indexOf('"buyer_info_text"');
  const idxLabel = htmlNombre.indexOf('"label"');
  assert.strictEqual(pos.pos_buyer_info_text, idxBuyer);
  assert.strictEqual(pos.pos_label, idxLabel - idxBuyer, "pos_label = offset respecto a buyer_info_text");
  assert.strictEqual(
    extractNombreApellidoFromVentasHtml(htmlNombre),
    nombre,
    "nombre entre 2.º y 3.º \\u003e"
  );

  const htmlBuyerDataBold = `x "buyer","data":{"label":"\\u003Cb\\u003E${nombre}\\u003C/b\\u003E" y`;
  assert.strictEqual(
    extractNombreApellidoFromVentasHtml(htmlBuyerDataBold),
    nombre,
    "patrón ML: buyer,data,label \\u003Cb\\u003E nombre \\u003C/b\\u003E"
  );

  const htmlTresPalabras = `x "buyer","data":{"label":"\\u003Cb\\u003EAna María López\\u003C/b\\u003E"`;
  assert.strictEqual(
    extractNombreApellidoFromVentasHtml(htmlTresPalabras),
    "Ana María",
    "solo las dos palabras tras \\u003Cb\\u003E"
  );

  const htmlTel = `<div>Comprador | Tel ${delim}04${delim}412${delim}1234567</p>`;
  assert.strictEqual(extractCelularFromVentasHtml(htmlTel), null, "tel sin 04XXXXXXXXX válido");

  const htmlTelOk =
    'data-testid="foo">Algo | Tel 0412-123.4567</p> resto';
  assert.strictEqual(extractCelularFromVentasHtml(htmlTelOk), "04121234567", "celular con marker | Tel ");

  const htmlTelScan = "sin marker 04123456789 fin";
  assert.strictEqual(extractCelularFromVentasHtml(htmlTelScan), "04123456789", "celular por escaneo 04+9");

  console.log("Pruebas sintéticas: OK (nombre + celular).");
}

function runFile(filePath) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) {
    console.error("No existe el archivo:", abs);
    process.exit(1);
  }
  const raw = fs.readFileSync(abs, "utf8");
  console.log("Archivo:", abs, "· bytes:", raw.length);
  const pos = computeVentasDetalleAnchorPositions(raw);
  console.log("pos_buyer_info_text:", pos.pos_buyer_info_text, "pos_label:", pos.pos_label);
  const nombre = extractNombreApellidoFromVentasHtml(raw);
  const cel = extractCelularFromVentasHtml(raw);
  console.log("extractNombreApellidoFromVentasHtml:", nombre ?? "(null)");
  console.log("extractCelularFromVentasHtml:", cel ?? "(null)");
}

const arg = process.argv[2];
if (arg) {
  runFile(arg);
} else {
  runSynthetic();
}
