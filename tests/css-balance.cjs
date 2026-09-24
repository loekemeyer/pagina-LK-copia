#!/usr/bin/env node
/**
 * tests/css-balance.cjs — que ningún bloque de CSS quede sin cerrar.
 *
 * POR QUÉ EXISTE (23/09/2026). El commit `6df4534` pegó los estilos del cartel
 * "Sin stock" justo después de `@media (max-width: 460px)` y se comió la `}`
 * que cerraba ese media query. Resultado: las ~46 líneas siguientes —y TODO lo
 * que se agregara después al final del archivo— quedaron ATRAPADAS adentro del
 * media query, o sea aplicando sólo por debajo de 460px de ancho.
 *
 * Lo caro es que no hay ningún síntoma: el CSS no tira error, el navegador no
 * avisa, la página carga bien. Se descubrió de casualidad al agregar el modo
 * presupuesto y ver que sus reglas no hacían nada. Cualquier regla nueva que
 * alguien agregue al final de este archivo se muere igual y en silencio.
 *
 * El chequeo es tonto a propósito: cuenta llaves ignorando comentarios y
 * strings. No valida CSS — valida que el archivo cierre lo que abre.
 *
 * Correr:  node tests/css-balance.cjs
 */
const fs = require("fs");
const path = require("path");

const dirCss = path.join(__dirname, "..", "css");
const archivos = fs.readdirSync(dirCss).filter((f) => f.endsWith(".css"));
let rojos = 0;

for (const f of archivos) {
  const crudo = fs.readFileSync(path.join(dirCss, f), "utf8");
  const limpio = crudo
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/"[^"\n]*"|'[^'\n]*'/g, '""');

  const pila = [];
  let sobran = 0;
  for (let i = 0; i < limpio.length; i++) {
    if (limpio[i] === "{") pila.push(i);
    else if (limpio[i] === "}") { if (pila.length) pila.pop(); else sobran++; }
  }

  if (!pila.length && !sobran) {
    console.log("  ok    ·", f);
    continue;
  }
  rojos++;
  if (pila.length) {
    // La línea del PRIMER bloque sin cerrar es la que hay que mirar: todo lo
    // que viene después está adentro de él sin querer.
    const linea = limpio.slice(0, pila[0]).split("\n").length;
    const ctx = limpio.slice(Math.max(0, pila[0] - 90), pila[0] + 1).trim().split("\n").pop();
    console.log(
      "  FALLA · " + f + ": " + pila.length + " bloque(s) sin cerrar. El primero " +
      "abre cerca de la línea " + linea + " (" + ctx.trim() + ") — todo lo que " +
      "sigue quedó adentro.",
    );
  }
  if (sobran) console.log("  FALLA · " + f + ": " + sobran + " '}' de más");
}

if (rojos) {
  console.error("\ncss-balance: EN ROJO — " + rojos + " archivo(s) con llaves sin cerrar");
  process.exit(1);
}
console.log("\ncss-balance: OK — " + archivos.length + " archivo(s), todas las llaves cierran.");
