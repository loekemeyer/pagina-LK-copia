#!/usr/bin/env node
/**
 * tests/payload-scope.cjs — que el sheetsPayload no tome variables prestadas.
 *
 * POR QUÉ EXISTE. `_submitSingleOrder` arma el `sheetsPayload` DESPUÉS de que la
 * RPC ya grabó el pedido. Si ahí adentro se usa una variable que en realidad está
 * declarada en `submitOrder()` —otra función—, salta un ReferenceError: el pedido
 * queda grabado sin `sheets_payload`, el cliente ve "No se pudo confirmar el
 * pedido" y lo vuelve a cargar.
 *
 * Pasó dos veces:
 *   · `observacionesValue` — corregido, y el comentario del código lo explica.
 *   · `retiroSel` — 2.3.359 (11/09 00:07) a 2.3.388. Del 11/09 al 14/09 dejó 32
 *     filas de `orders` = 6 pedidos reales invisibles para Gestión Virgilio
 *     (4,30 M$); Rodríguez (3969) lo cargó 9 veces en un minuto.
 *
 * Este test recorre los identificadores que usa el literal `sheetsPayload` y falla
 * si alguno no está declarado dentro de `_submitSingleOrder` (var/let/const o
 * parámetro). No reemplaza a un linter: cubre exactamente el lugar que ya falló
 * dos veces.
 *
 * Correr:  node tests/payload-scope.cjs
 */
const fs = require("fs");
const path = require("path");

// Por defecto el script.js del repo; se le puede pasar otro path para probar el
// propio test contra una versión anterior (ver la nota de reproducción abajo).
const objetivo = process.argv[2] || path.join(__dirname, "..", "script.js");
const src = fs.readFileSync(objetivo, "utf8");

const inicio = src.indexOf("async function _submitSingleOrder(");
if (inicio < 0) {
  console.error("FALLA: no se encontró _submitSingleOrder en script.js");
  process.exit(1);
}
// La función termina donde arranca la siguiente declaración a nivel de módulo.
const desdeCuerpo = src.slice(inicio + 1);
const relFin = desdeCuerpo.search(/\n(?:async )?function [A-Za-z_$]/);
const fn = desdeCuerpo.slice(0, relFin < 0 ? undefined : relFin);

// El literal del payload: desde la "{" de "var sheetsPayload = {" hasta su "}"
// pareja, contando llaves (el cierre está indentado y cambia con el try/catch).
const pIni = fn.indexOf("var sheetsPayload = {");
if (pIni < 0) {
  console.error("FALLA: no se encontró el literal sheetsPayload");
  process.exit(1);
}
const abre = fn.indexOf("{", pIni);
let nivel = 0;
let pFin = -1;
for (let i = abre; i < fn.length; i++) {
  if (fn[i] === "{") nivel++;
  else if (fn[i] === "}" && --nivel === 0) {
    pFin = i + 1;
    break;
  }
}
if (pFin < 0) {
  console.error("FALLA: el literal sheetsPayload no cierra");
  process.exit(1);
}
const payload = fn.slice(abre, pFin);

// Declaraciones y parámetros de _submitSingleOrder.
const declaradas = new Set();
for (const m of fn.matchAll(/\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)/g)) {
  declaradas.add(m[1]);
}
const params = fn.slice(0, fn.indexOf(")")).replace(/^[^(]*\(/, "");
for (const p of params.split(",")) {
  const n = p.trim();
  if (n) declaradas.add(n);
}

// Palabras del lenguaje: no son variables que haya que declarar.
const PALABRAS_JS = new Set([
  "var", "let", "const", "function", "return", "new", "typeof", "null", "true",
  "false", "undefined", "if", "else", "this", "void", "in", "of",
]);

// Globales del módulo y helpers que el payload SÍ puede usar sin declarar acá.
const permitidas = new Set([
  "String", "Number", "Boolean", "Math", "JSON", "Object", "Array", "Date",
  "window", "document",
  "customerProfile", "isAdmin",
  "getPaymentMethodText", "getPaymentMethodCode",
]);

// Identificadores en posición de VALOR (después de ':' o dentro de una expresión),
// salteando las claves del objeto y los accesos a propiedad (.algo).
const sinComentarios = payload
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/^\s*\/\/.*$/gm, " ");
const sinStrings = sinComentarios.replace(/"[^"]*"|'[^']*'/g, '""');
const sinClaves = sinStrings.replace(/^\s*[A-Za-z_$][\w$]*\s*:/gm, " ");
const limpio = sinClaves.replace(/\.\s*[A-Za-z_$][\w$]*/g, "");

// Los callbacks de adentro del payload (map, filter…) traen sus propios parámetros.
for (const m of payload.matchAll(/function\s*\(([^)]*)\)/g)) {
  for (const p of m[1].split(",")) {
    const n = p.trim();
    if (n) declaradas.add(n);
  }
}

const faltan = new Set();
for (const m of limpio.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)) {
  const id = m[1];
  if (declaradas.has(id) || permitidas.has(id) || PALABRAS_JS.has(id)) continue;
  faltan.add(id);
}

if (faltan.size) {
  console.error(
    "FALLA: el sheetsPayload usa variables que NO están declaradas en " +
      "_submitSingleOrder:\n  " +
      [...faltan].join(", ") +
      "\n\nDeclaralas dentro de _submitSingleOrder (como observacionesValue y " +
      "retiroSel). Si las tomás de submitOrder() salta un ReferenceError DESPUÉS " +
      "de que la RPC grabó el pedido: queda sin sheets_payload, el cliente ve " +
      '"No se pudo confirmar el pedido" y lo carga de nuevo.',
  );
  process.exit(1);
}

// Y que los efectos secundarios post-RPC no puedan tumbar la confirmación.
if (!/EFECTOS SECUNDARIOS[\s\S]{0,600}?\n  try \{/.test(fn)) {
  console.error(
    "FALLA: el bloque de efectos secundarios posterior a la RPC perdió su try/catch.\n" +
      "Sin él, cualquier error ahí tumba la confirmación de un pedido YA grabado.",
  );
  process.exit(1);
}

console.log(
  "payload-scope: OK — " +
    declaradas.size +
    " variables declaradas en _submitSingleOrder, 0 prestadas, try/catch presente.",
);
