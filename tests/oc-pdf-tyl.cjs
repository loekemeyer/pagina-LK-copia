#!/usr/bin/env node
/**
 * tests/oc-pdf-tyl.cjs — la OC en PDF de Torres y Liva se lee y su total cierra.
 *
 * POR QUÉ EXISTE (06/10/2026). Torres y Liva (cod 288) sube su orden de compra
 * en PDF desde el carrito (oc-pdf.js). Lo importante no es sólo leerla: es que
 * el TOTAL de la OC coincida con nuestro programa. Dos trampas que este test fija:
 *   - el código de la OC no siempre es el nuestro: "66" = 066, "395D" = 395 y
 *     "525" (inactivo, $0) = 525E. Gana el candidato con el MISMO PRECIO.
 *   - la OC viene en UNIDADES y a precio de LISTA: se compara a lista, no contra
 *     el total con descuentos de la página.
 *
 * Fixture: tests/fixtures/oc-tyl-9575.txt = los renglones que saca pdf.js (el
 * mismo agrupado por Y que usa el navegador) de tests/fixtures/oc-tyl-9575.pdf.
 * Productos: copia de products al 06/10/2026 para esos códigos.
 *
 * Correr:  node tests/oc-pdf-tyl.cjs
 */
const fs = require("fs");
const path = require("path");
const raiz = path.join(__dirname, "..");
const O = require(path.join(raiz, "oc-pdf.js"));
const fallas = [];
const ok = (m) => console.log("  ok    ·", m);
const mal = (m) => { fallas.push(m); console.log("  FALLA ·", m); };
const chk = (c, m) => (c ? ok(m) : mal(m));

const lineas = fs.readFileSync(path.join(__dirname, "fixtures", "oc-tyl-9575.txt"), "utf8").split("\n");

// cod, uxb, list_price, badge  (products activos al 06/10/2026)
const P = [
  ["501", 6, 5520], ["502", 12, 3455], ["066", 12, 3840], ["510", 12, 955], ["500", 12, 1565],
  ["506", 12, 1190], ["504", 6, 3290], ["555", 36, 890], ["027", 24, 1495], ["812E", 12, 4020],
  ["395", 12, 2035], ["057", 12, 1290], ["586", 12, 1590], ["505", 12, 1590], ["513", 12, 2375],
  ["598E", 12, 1240, "NUEVO"], ["606E", 12, 3505, "NUEVO"], ["601E", 12, 4055, "NUEVO"], ["560", 12, 2700],
  ["323E", 12, 1295], ["525E", 24, 1845], ["531", 12, 3990], ["523", 12, 7830], ["520", 12, 3320],
  ["579", 12, 1135], ["577", 12, 1335],
].map(([cod, uxb, list_price, badge_status], i) => ({ id: "p" + i, cod, uxb, list_price, badge_status: badge_status || null }));
const prods = () => P.map((p) => ({ ...p }));

console.log("A. lectura del PDF");
chk(O.formatoPorTexto(lineas.join("\n"))?.id === "tyl", "reconoce el formato Torres y Liva");
const oc = O.parseTyl(lineas);
chk(oc.nro === "9575", "Nº de pedido 9575 (" + oc.nro + ")");
chk(oc.emision === "06/10/2026" && oc.entrega === "07/10/2026", "fechas de emisión y entrega");
chk(oc.lineas.length === 26, "26 renglones (" + oc.lineas.length + ")");
chk(oc.noLeidas.length === 0, "ningún renglón sin leer");
chk(oc.totalGeneral === 13656600, "TOTAL GENERAL 13.656.600,00 (" + oc.totalGeneral + ")");
const l395 = oc.lineas.find((l) => l.codOc === "395D");
chk(l395 && l395.unidades === 36 && l395.pu === 2035 && l395.total === 73260, "renglón 395D completo");

console.log("B. armado y control de total");
const r = O.armar(oc, prods());
chk(r.coincide, "el total coincide con nuestro programa (dif " + r.diferencia + ")");
chk(r.totalNuestro === 13656600, "nuestro total a lista 13.656.600 (" + r.totalNuestro + ")");
const fila = (c) => r.filas.find((f) => f.l.codOc === c);
chk(fila("66").prod?.cod === "066", "66 → 066");
chk(fila("395D").prod?.cod === "395", "395D → 395");
chk(fila("525").prod?.cod === "525E" && fila("525").cajas === 1, "525 → 525E, 1 caja");
chk(fila("501").cajas === 60 && fila("027").cajas === 3, "unidades → cajas (501: 60, 027: 3)");
chk(r.filas.every((f) => !f.problemas.length), "ningún renglón marcado");

console.log("C. si algo no cierra, lo dice");
const p2 = prods(); p2.find((p) => p.cod === "513").list_price = 2400;
const r2 = O.armar(oc, p2);
chk(!r2.coincide && Math.round(r2.diferencia) === 18000, "precio distinto → no coincide, diferencia 18.000");
chk(r2.filas.find((f) => f.l.codOc === "513").problemas.length, "marca el renglón del 513");
const p3 = prods(); p3.find((p) => p.cod === "504").badge_status = "SIN STOCK";
const r3 = O.armar(oc, p3);
chk(!r3.coincide && !r3.filas.find((f) => f.l.codOc === "504").prod, "SIN STOCK no se carga y el total no cierra");
const p4 = prods(); p4.find((p) => p.cod === "555").uxb = 24;
const r4 = O.armar(oc, p4);
chk(r4.filas.find((f) => f.l.codOc === "555").problemas.some((x) => /caja cerrada/.test(x)), "unidades que no son caja cerrada se marcan");

console.log("D. está enganchado a la página");
const html = fs.readFileSync(path.join(raiz, "mayorista.html"), "utf8");
const js = fs.readFileSync(path.join(raiz, "script.js"), "utf8");
chk(/id="ocPdfBtn"[\s\S]*?hidden/.test(html) && /id="ocPdfInput"/.test(html), "botón e input en el carrito");
chk(/id="modalOcPdf"/.test(html) && /<script src="oc-pdf\.js\?v=/.test(html), "modal y script");
chk(/ocPdfSyncBtn\(\)/.test(js), "updateCart muestra/oculta el botón");

if (fallas.length) { console.log("\n" + fallas.length + " FALLA(S)"); process.exit(1); }
console.log("\ntodo ok");
