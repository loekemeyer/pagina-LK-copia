#!/usr/bin/env node
/**
 * tests/lista-super-jumbo.cjs — que Jumbo (Cencosud) aparezca en "Elegí el supermercado".
 *
 * POR QUÉ EXISTE (Tomás Gonzalez, 02/10/2026). PDF Krikos → "Actualizar lista de precios"
 * salteaba a toda cadena que factura por Chef, así que la lista de Cencosud no se podía
 * cargar acá (0 precios en precios_super). Pero las OC de Cencosud se cargan en ESTE admin
 * —matchean contra LK + Loke; en el de Chef se bloquearon (paginach v2.0.89)— y su lista
 * es la que usa el cotizador para comparar precios. Dorinka sigue afuera: matchea contra
 * el catálogo de Chef y su lista se carga en el admin de Chef.
 *
 * Chequea, corriendo los helpers de admin-supercot.js con la config real de
 * precios_super.cadena:
 *   A. cencosud entra, dorinka no, una cadena LK (coto) sí;
 *   B. el selector (scotChooseSuper) y el camino de varias hojas usan ese criterio, no
 *      isChefSuper a secas.
 *
 * Verificado contra el admin-supercot.js anterior: falla A y B.
 *
 * Correr:  node tests/lista-super-jumbo.cjs
 */
"use strict";
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "admin-supercot.js"), "utf8");
let fallas = 0;
function ok(cond, msg) {
  console.log((cond ? "  ✓ " : "  ✗ ") + msg);
  if (!cond) fallas++;
}
function fn(nombre) {
  const i = src.indexOf("function " + nombre + "(");
  if (i < 0) return null;
  const f = src.indexOf("\n  }\n", i);
  return src.slice(i, f + 4);
}

// A — los helpers, con la config de precios_super.cadena al 02/10/2026
const cuerpo = [fn("isChefSuper"), fn("usesChefProducts"), fn("superListaEnEsteAdmin")];
let entra = null;
if (cuerpo.every(Boolean)) {
  entra = Function(
    "SUPER_EMPRESA", "SUPER_USA_PRODUCTOS_CHEF",
    cuerpo.join("\n") + "\nreturn superListaEnEsteAdmin;"
  )(
    { coto: "lk", cencosud: "chef", dorinka: "chef" },
    { coto: false, cencosud: false, dorinka: true }
  );
}
ok(!!entra, "A0. existe superListaEnEsteAdmin");
ok(!!entra && entra("cencosud") === true, "A1. Cencosud (Jumbo) entra al selector");
ok(!!entra && entra("dorinka") === false, "A2. Dorinka sigue afuera (catálogo Chef)");
ok(!!entra && entra("coto") === true, "A3. una cadena LK (Coto) sigue adentro");

// B — que el selector y el camino de varias hojas usen ese criterio
const sel = fn("scotChooseSuper") || "";
ok(/superListaEnEsteAdmin\(k\)/.test(sel) && !/if \(isChefSuper\(k\)\) return;/.test(sel),
   "B1. scotChooseSuper filtra con superListaEnEsteAdmin");
const imp = fn("updateSuperPricesFromFile") || "";
ok(/superListaEnEsteAdmin\(SHEET_CONFIG\[n\]\.key\)/.test(imp) &&
   !/if \(isChefSuper\(SHEET_CONFIG\[n\]\.key\)\) return;/.test(imp),
   "B2. el camino de varias hojas usa el mismo criterio");

if (fallas) {
  console.log("\n✗ " + fallas + " chequeo(s) en rojo");
  process.exit(1);
}
console.log("\n✓ Jumbo aparece en la lista de supermercados");
