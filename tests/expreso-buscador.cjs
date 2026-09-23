#!/usr/bin/env node
/**
 * tests/expreso-buscador.cjs — el buscador de expresos del checkout.
 *
 * POR QUÉ EXISTE. El cliente elige el expreso escribiendo, no de una lista: es
 * el único camino, porque el padrón tiene 412 filas y nadie scrollea eso. Si el
 * orden se rompe, el cliente elige el expreso equivocado y la mercadería sale
 * para el galpón que no es — un error que se descubre cuando el expreso llama
 * diciendo que no tiene nada a nombre de ese cliente.
 *
 * Lo que fija:
 *   A. "la sev" trae LA SEVILLANITA, y ANTES que las que sólo comparten dirección.
 *   B. se puede buscar por la DIRECCIÓN del galpón ("pinedo 50"): el cliente
 *      muchas veces sabe a dónde va la mercadería y no cómo se llama el expreso.
 *   C. sin acentos y con mayúsculas mezcladas encuentra igual.
 *   D. 1 sola letra no devuelve nada (si no, la primera tecla tira 412 filas).
 *   E. `_expAplica` oculta la línea en CABA/GBA, donde repartimos nosotros.
 *
 * Corre la función REAL de script.js (`_expRankear`, `_expNorm`, `_expAplica`),
 * no una copia: se extraen del archivo y se evalúan.
 *
 * Correr:  node tests/expreso-buscador.cjs
 */
const fs = require("fs");
const path = require("path");

const objetivo = process.argv[2] || path.join(__dirname, "..", "script.js");
const src = fs.readFileSync(objetivo, "utf8");

function extraer(nombre) {
  const i = src.indexOf("function " + nombre + "(");
  if (i < 0) {
    console.error("FALLA: no se encontró " + nombre + "() en " + path.basename(objetivo));
    process.exit(1);
  }
  // Hasta el cierre de llave a columna 0, que es como está escrito el archivo.
  const rel = src.slice(i).search(/\n\}\n/);
  return src.slice(i, i + rel + 3);
}

const ctx = {};
new Function(
  "ctx",
  extraer("_expNorm") + extraer("_expRankear") + extraer("_expAplica") +
    "\nctx._expNorm=_expNorm; ctx._expRankear=_expRankear; ctx._expAplica=_expAplica;",
)(ctx);
const { _expRankear, _expAplica } = ctx;

/* Fixture: filas REALES del padrón de LK (public.expresos), tomadas el
   23/09/2026. Las cuatro de Pinedo 50 existen tal cual — ese domicilio es una
   estación de cargas y lo comparten muchos expresos, que es justo lo que hace
   interesante la búsqueda por dirección. */
const PADRON = [
  { razon_social: "LA SEVILLANITA", domicilio: "PERGAMINO 3751", localidad: "Soldati", provincia: "Capital Federal" },
  { razon_social: "SEVILLANITA", domicilio: "PERGAMINO 3751", localidad: "Soldati", provincia: "Capital Federal" },
  { razon_social: "LA ANTARTIDA", domicilio: "RIO CUARTO 4491", localidad: "Pompeya", provincia: "Capital Federal" },
  { razon_social: "LA CAMIONERA ANDINA", domicilio: "CNEL G POMAR 3499", localidad: "P.Patricios", provincia: "Capital Federal" },
  { razon_social: "ALBO", domicilio: "PINEDO 50 GALPON 3 PUERTA 1Y2", localidad: "Barracas", provincia: "Capital Federal" },
  { razon_social: "ALONSO", domicilio: "PINEDO 50 ESTACION SOLA", localidad: "Barracas", provincia: "Capital Federal" },
  { razon_social: "FOR ZAP", domicilio: "PINEDO 50", localidad: "Barracas", provincia: "Capital Federal" },
  { razon_social: "DE LA VEGA", domicilio: "PINEDO 50 G1 PTA 4", localidad: "Barracas", provincia: "Capital Federal" },
  { razon_social: "ANDESMAR", domicilio: "AV GRAL PAZ 10868", localidad: "Liniers", provincia: "Capital Federal" },
  { razon_social: "ARIAS (SANTA FE)", domicilio: "Pergamino 3751 Nave C Modulo 7", localidad: "Villa Soldati", provincia: "Capital Federal" },
];

const fallas = [];
const nombres = (r) => r.map((x) => x.razon_social);

// A. por nombre, y el prefijo manda
{
  const r = _expRankear(PADRON, "LA SEV");
  if (r[0]?.razon_social !== "LA SEVILLANITA")
    fallas.push('A: "LA SEV" tenía que traer LA SEVILLANITA primero, trajo ' + (r[0]?.razon_social || "nada"));
  // "SEVILLANITA" (sin el "LA") NO tiene que salir con "LA SEV": no contiene
  // esa cadena. Sale escribiendo "sev", que es lo que el cliente hace si duda.
  if (!nombres(_expRankear(PADRON, "sev")).includes("SEVILLANITA"))
    fallas.push('A: "sev" tenía que traer también SEVILLANITA');
  const iSev = nombres(r).indexOf("LA SEVILLANITA");
  const iVega = nombres(r).indexOf("DE LA VEGA");
  if (iVega >= 0 && iVega < iSev)
    fallas.push("A: DE LA VEGA quedó antes que LA SEVILLANITA — el prefijo del nombre no está ganando");
}

// B. por dirección del galpón
{
  const r = _expRankear(PADRON, "pinedo 50");
  const n = nombres(r);
  ["ALBO", "ALONSO", "FOR ZAP", "DE LA VEGA"].forEach((x) => {
    if (!n.includes(x)) fallas.push('B: "pinedo 50" no encontró ' + x + " por dirección");
  });
  if (n.includes("LA SEVILLANITA"))
    fallas.push('B: "pinedo 50" trajo LA SEVILLANITA, que está en Pergamino');
}

// B2. por localidad
{
  const n = nombres(_expRankear(PADRON, "barracas"));
  if (n.length < 4) fallas.push('B2: "barracas" tenía que traer los 4 de Barracas, trajo ' + n.length);
}

// C. acentos y mayúsculas
{
  if (!nombres(_expRankear(PADRON, "sevillánita")).includes("LA SEVILLANITA"))
    fallas.push("C: con acento no encontró LA SEVILLANITA");
  if (!nombres(_expRankear(PADRON, "aNdEsMaR")).includes("ANDESMAR"))
    fallas.push("C: mayúsculas mezcladas no encontró ANDESMAR");
}

// D. una sola letra no dispara
{
  if (_expRankear(PADRON, "l").length !== 0)
    fallas.push("D: con 1 letra tiene que devolver 0 (si no, la primera tecla tira el padrón entero)");
}

// E. dónde se muestra la línea
{
  const casos = [
    ["Misiones", "Puerto Rico", true, "el interior va por expreso"],
    ["Santa Fe", "Rosario", true, "el interior va por expreso"],
    ["CABA", "Flores", false, "en CABA repartimos nosotros"],
    ["Capital Federal", "Palermo", false, "en CABA repartimos nosotros"],
    ["Buenos Aires", "Moron", false, "en GBA repartimos nosotros"],
    ["", "", false, "sin dato no se inventa"],
  ];
  casos.forEach(([prov, loc, esperado, porque]) => {
    const dio = _expAplica(prov, loc);
    if (dio !== esperado)
      fallas.push('E: _expAplica("' + prov + '","' + loc + '") dio ' + dio + " y tenía que dar " + esperado + " — " + porque);
  });
}

if (fallas.length) {
  console.error("expreso-buscador: FALLA\n - " + fallas.join("\n - "));
  process.exit(1);
}
console.log(
  "expreso-buscador: OK — nombre con prefijo, dirección, localidad, acentos, " +
    "piso de 2 letras y CABA/GBA ocultos.",
);
