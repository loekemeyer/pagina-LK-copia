#!/usr/bin/env node
/**
 * tests/lista-super-sin-encabezado.cjs — una lista de súper en 2 columnas, sin títulos, se lee.
 *
 * POR QUÉ EXISTE (Luis, 06/10/2026). Las listas de La Anónima (export de Crystal, .xls) y
 * Toledo llegan ahora en 2 columnas —código y precio— desde la fila 1, sin encabezado. La
 * config de precios_super.cadena espera el Excel de costos (Toledo: cód A / precio E desde
 * la fila 8; La Anónima: B / G desde la 8). Con eso el cargador no leía NADA.
 *
 * Corre scotEsFilaDato + scotDetectarColumnas de admin-supercot.js:
 *   A. La Anónima (25 filas reales del archivo de Tomás) → A/B desde la fila 1, 25 artículos.
 *   B. Toledo (29 filas) → igual, 29 artículos.
 *   C. una hoja con las columnas configuradas BIEN → null (no se toca lo que anda).
 *   D. una hoja sin datos → null.
 *
 * Correr:  node tests/lista-super-sin-encabezado.cjs
 */
"use strict";
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "admin-supercot.js"), "utf8");
let fallas = 0;
function ok(c, m) { console.log((c ? "  ✓ " : "  ✗ ") + m); if (!c) fallas++; }
function fn(nombre) {
  const i = src.indexOf("\nfunction " + nombre + "(");
  if (i < 0) return null;
  const f = src.indexOf("\n}\n", i);
  return src.slice(i, f + 3);
}
const partes = [fn("scotEsFilaDato"), fn("scotDetectarColumnas")];
ok(partes.every(Boolean), "0. existen scotEsFilaDato y scotDetectarColumnas");
if (!partes.every(Boolean)) process.exit(1);
const detectar = Function(partes.join("\n") + "\nreturn scotDetectarColumnas;")();

const anonima = [["026",1075],["031",735],[280,1470],[315,2530],[504,2770],[506,1220],[513,2015],
  [523,7130],[544,2010],[546,2710],[558,1105],[577,985],[586,1525],[587,1635],["198E",1110],
  ["522E",7130],["529E",2450],[658,1990],[550,445],[248,1790],[225,1690],["601E",3790],
  ["536E",4790],["102E",2290],["541E",6190]];
let r = detectar(anonima, 1, 6, 7);
ok(r && r.codCol === 0 && r.priceCol === 1 && r.dataStart === 0 && r.n === 25,
   "A. La Anónima: columnas A/B desde la fila 1, 25 artículos (" + JSON.stringify(r) + ")");

const toledo = [[221,2470],[315,3780],[321,1950],[333,4990],[504,4405],[505,2305],[531,6430],
  [544,2930],[587,2220],["585E",6700],[224,2010],[229,1800],[332,4155],[502,4905],[508,6625],
  [546,3970],[551,1655],["503E",5220],["029",7790],[325,945],[506,1730],[550,515],["870E",15390],
  ["031",1060],["026",1615],["027",2150],["030",11965],[501,8675],[594,6200]];
r = detectar(toledo, 0, 4, 7);
ok(r && r.codCol === 0 && r.priceCol === 1 && r.dataStart === 0 && r.n === 29,
   "B. Toledo: columnas A/B desde la fila 1, 29 artículos (" + JSON.stringify(r) + ")");

const costos = [["Lista 01/08/2025"],[],["Cod","Desc","Costo","x","Lista Vigente"]];
for (let i = 0; i < 6; i++) costos.push([String(500 + i), "art", 100, "", 2000 + i]);
ok(detectar(costos, 0, 4, 3) === null, "C. hoja con las columnas configuradas bien → no se toca");
ok(detectar([["hola"],[""]], 0, 1, 0) === null, "D. hoja sin datos → null");

if (fallas) { console.log("\n✗ " + fallas + " chequeo(s) en rojo"); process.exit(1); }
console.log("\n✓ las listas sin encabezado se leen");
