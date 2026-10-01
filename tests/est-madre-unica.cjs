/* LK — la ESTADÍSTICA MADRE es UN SOLO CUADRO (Tomás Beviglia, 01/10/2026: "es un solo cuadro que
   se imprime en dos lados distintos. NUNCA puede un cuadro de est madre quedar más actualizado que
   otro. Si alguien quiere cambiar uno solo NO se puede hacer").

   La Est. Madre NO vive en este repo: vive en admin/est-madre.js del repo Gestion-Virgilio y este
   panel la baja de GitHub Pages (abrirEstadisticaMadre). Chequea:
   A) que admin.js, admin.html y css/admin.css NO tengan una Est. Madre propia;
   B) que el cargador apunte a la URL única y sea IDÉNTICO al del espejo de Gestión (huella md5: el
      mismo número está en tests/est-madre-unica.cjs de Gestion-Virgilio; si cambia acá, cambia
      allá en el mismo pedido);
   C) que el menú abra la Est. Madre por el cargador.
   Sale 1 si falla. */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const R = path.resolve(__dirname, "..");
const HUELLA_CARGADOR = "416c801a060ef3743a35ccfb476c4ff4";
const URL_MODULO = "https://loekemeyer.github.io/Gestion-Virgilio/admin/est-madre.js";
const fallas = [];
const ok = (c, m) => { if (!c) fallas.push(m); };
const leer = (p) => fs.readFileSync(path.join(R, p), "utf8").replace(/^﻿/, "");

const adm = leer("admin.js");
for (const f of ["function cargarEstadisticaMadre", "function _renderEstMadreTable", "function mostrarDetalleVentaMadre",
                 "function descargarEstadisticaMadreExcel", "function descargarReporteVentasDisruptivas", "get_estadistica_madre_cache"]) {
  ok(adm.indexOf(f) < 0, "A: admin.js tiene una copia propia: " + f);
}
const html = leer("admin.html");
ok(/<section class="page" id="estadistica-madre"><\/section>/.test(html), "A: la sección de admin.html no está vacía");
ok(!/estMadreTable/.test(html), "A: admin.html trae HTML propio de la Est. Madre");
ok(!/\.est-madre-table/.test(leer("css/admin.css")), "A: css/admin.css trae estilos propios de la Est. Madre");
ok(!fs.existsSync(path.join(R, "est-madre.js")), "A: hay un est-madre.js en este repo: la única copia es la de Gestion-Virgilio");

const i = adm.indexOf("/* =========================================================\n   ESTADÍSTICA MADRE — UN SOLO CUADRO");
const fin = "window.abrirEstadisticaMadre = abrirEstadisticaMadre;\n";
const j = i >= 0 ? adm.indexOf(fin, i) : -1;
const huella = j > 0 ? crypto.createHash("md5").update(adm.slice(i, j + fin.length), "utf8").digest("hex") : "(sin cargador)";
ok(huella === HUELLA_CARGADOR, "B: el cargador cambió (" + huella + "): cambiarlo IGUAL en Gestion-Virgilio/admin/admin.js y actualizar la huella en los dos tests");
ok(adm.indexOf('var EM_MODULO_URL = "' + URL_MODULO + '"') >= 0, "B: el cargador no apunta a " + URL_MODULO);
ok(/btn\.dataset\.page === "estadistica-madre"\) \{\s*abrirEstadisticaMadre\(\);/.test(adm), "C: el menú no abre la Est. Madre por el cargador");

console.log("est-madre-unica:", fallas.length ? "✗ FAIL\n  - " + fallas.join("\n  - ") : "✓ OK (cargador " + huella + ")");
process.exit(fallas.length ? 1 : 0);
