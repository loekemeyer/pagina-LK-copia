#!/usr/bin/env node
/**
 * tests/fc-acuerdo-desglose.cjs — El "Acuerdo Cliente" de la ficha se toca y
 * muestra de dónde sale (Luis, 29/09/2026).
 *
 * Corre fcRender() de verdad en admin.html (red cortada) con los parámetros
 * REALES de acuerdo_parametros y el cliente 3997 (Piovan Liliana, dto 0%,
 * comisión 10%), y mide:
 *   A. la celda es clickeable y abre el pop-up;
 *   B. el desglose trae la cadena entera: lista 151,00 -> vol -> pago 25% ->
 *      cotizador (cheque) -> flete+comisión (recibo);
 *   C. los números del pop-up son los MISMOS que los del panel — si la RPC ya
 *      trajo cheque/recibo/factor se muestran ésos, no un recálculo que
 *      redondearía distinto (110,99 contra 110,98);
 *   D. cierra con la × y con Escape, y no deja nada colgado;
 *   E. sin parámetros no explota: dice que no se pudo calcular.
 *
 * Correr:  node tests/fc-acuerdo-desglose.cjs
 */
const path = require("path");
let chromium;
try { ({ chromium } = require("/opt/node22/lib/node_modules/playwright")); }
catch (_e) {
  try { ({ chromium } = require("playwright")); }
  catch (_e2) { console.error("fc-acuerdo-desglose: SALTEADO — no hay playwright"); process.exit(0); }
}
const raiz = path.join(__dirname, "..");
const fallas = [];
const ok = (c, m) => { if (!c) fallas.push(m); };

const FICHA = {
  cod: "3997",
  datos: { cod_cliente: 3997, business_name: "Piovan Liliana", cuit: "27220102217",
    vendedor: "Audisio", dto_vol: 0, credit_limit: 10000000, chef_cods: [] },
  direcciones: [], pedidos_mes: [], pedidos_trimestre: [], facturacion_anio: [],
  resumen_articulos: { total_distintos: 0, activos_count: 0 }, meses: [], articulos: [],
};
// Lo que devuelve get_acuerdo_cliente('3997') con acuerdo_parametros id=1
// (indice 151, pago 25%, cotizador 2%, flete 1%, piso 100) y comisión 10%.
const ACU = {
  cod: 3997, vendedor: "Audisio", dto_vol: 0, comision: 10,
  cheque: 110.99, recibo: 98.78, acuerdo: -1.22, factor: 1.529,
  dto_max: 9, dto_max_exacto: 9.9, margen_dto: 9,
  dto_pago_hoy: 25, dto_pago_antes: 8, mejora_pago: 18.5, simulacion: [],
  parametros: { indice_lista: 151, dto_pago: 0.25, dto_cot: 0.02, flete: 0.01, piso: 100 },
};

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await ctx.route("**://**", (r) =>
    r.request().url().startsWith("file:") ? r.continue() : r.fulfill({ status: 200, body: "" }));
  const page = await ctx.newPage();
  await page.goto("file://" + path.join(raiz, "admin.html"));
  await page.waitForLoadState("load");
  await page.waitForTimeout(400);

  const prep = await page.evaluate(([F, A]) => {
    document.querySelectorAll(".page").forEach((p) => (p.style.display = "none"));
    const sec = document.getElementById("ficha-cliente");
    sec.style.display = "block"; sec.classList.add("active");
    const ls = document.getElementById("loadingScreen"); if (ls) ls.style.display = "none";
    for (let e = sec; e && e !== document.body; e = e.parentElement) {
      if (getComputedStyle(e).display === "none") e.style.display = "block";
      e.hidden = false;
    }
    _fcData = F; _fcAcuerdo = A; _fcIsis = null; _fcIsisError = null; fcRender();
    const cel = document.querySelector("#fcContenido .fc-acud-click");
    return {
      hay: !!cel,
      cursor: cel ? getComputedStyle(cel).cursor : "",
      txt: cel ? cel.innerText.replace(/\s+/g, " ").trim() : "",
      abiertoAntes: !!document.getElementById("fcAcuOv"),
    };
  }, [FICHA, ACU]);

  // A. la celda del panel es la puerta
  ok(prep.hay, "A: el Acuerdo Cliente no es clickeable (falta .fc-acud-click)");
  ok(prep.cursor === "pointer", `A: la celda no muestra que se puede tocar (cursor ${prep.cursor})`);
  ok(/^1,53/.test(prep.txt), `A: la celda no muestra 1,53 (dice "${prep.txt}")`);
  ok(!prep.abiertoAntes, "A: el pop-up ya estaba abierto sin tocar nada");

  if (prep.hay) {
    for (let i = 0; i < 3; i++) {
      try { await page.click("#fcContenido .fc-acud-click", { timeout: 2000 }); break; }
      catch (_) { await page.waitForTimeout(200); }
    }
    await page.waitForTimeout(150);
  }

  const pop = await page.evaluate(() => {
    const ov = document.getElementById("fcAcuOv");
    if (!ov) return null;
    const filas = [...ov.querySelectorAll(".fc-acud-tab tr")].map((tr) =>
      [...tr.children].map((c) => c.innerText.replace(/\s+/g, " ").trim()));
    const b = ov.querySelector(".fc-acud-box").getBoundingClientRect();
    const tb = [...ov.querySelectorAll("table")].map((t) => t.getBoundingClientRect().width);
    return { txt: ov.innerText.replace(/\s+/g, " "), filas, boxW: b.width, tb,
             z: Number(getComputedStyle(ov).zIndex) || 0 };
  });

  ok(pop, "A: tocar el Acuerdo Cliente no abrió el desglose");
  if (pop) {
    const t = pop.txt;
    // B. la cadena entera, en orden
    ["Índice de lista", "Dto x volumen", "Dto pago contado", "Cotizador", "Flete + comisión"]
      .forEach((p) => ok(t.includes(p), `B: falta el paso "${p}"`));
    ok(t.includes("cheque") && t.includes("recibo"), "B: no marca cuál es el cheque y cuál el recibo");
    ok(/25%/.test(t) && /2%/.test(t) && /1%/.test(t) && /10%/.test(t),
       "B: faltan los porcentajes (25 pago, 2 cotizador, 1 flete, 10 comisión)");
    // C. los mismos números que el panel
    ok(t.includes("151,00"), "C: falta el índice de lista 151,00");
    ok(t.includes("113,25"), "C: falta el saldo después del 25% de pago (113,25)");
    ok(t.includes("110,99"), "C: el cheque no es el de la RPC (110,99)");
    ok(!t.includes("110,98"), "C: recalculó el cheque en vez de usar el de la RPC (110,98)");
    ok(t.includes("98,78"), "C: falta el recibo (98,78)");
    ok(t.includes("1,53"), "C: falta el Acuerdo cliente 1,53");
    ok(t.includes("1,51"), "C: falta el Acuerdo tomado 1,51");
    ok(/-1%/.test(t), "C: el +-Rent del desglose no es el del panel (-1%)");
    ok(t.includes("no encadenados"), "C: no aclara que flete y comisión no se encadenan");
    // ancho segun el dato: el pop-up no se estira mas alla de su tabla mas ancha
    const maxTab = Math.max.apply(null, pop.tb.concat([0]));
    ok(pop.boxW <= maxTab + 60, `C: el pop-up sobra ancho (${Math.round(pop.boxW)} contra tabla ${Math.round(maxTab)})`);
    ok(pop.z >= 1000, `C: el pop-up queda abajo de la pantalla (z-index ${pop.z})`);
  }

  // D. cierra con la x y con Escape
  const cerradoX = await page.evaluate(() => {
    const b = document.querySelector("#fcAcuOv .fc-acud-x"); if (!b) return null;
    b.click(); return !document.getElementById("fcAcuOv");
  });
  ok(cerradoX === true, "D: la × no cierra el desglose");
  await page.evaluate(() => fcAcuDesglose());
  await page.keyboard.press("Escape");
  await page.waitForTimeout(80);
  ok(await page.evaluate(() => !document.getElementById("fcAcuOv")), "D: Escape no cierra el desglose");

  // E. sin parametros no explota
  const sinParam = await page.evaluate(() => {
    _fcAcuerdo = { factor: 1.5, dto_vol: 0, comision: 0, parametros: { indice_lista: 151 } };
    try { fcAcuDesglose(); } catch (e) { return "EXPLOTO: " + e.message; }
    const ov = document.getElementById("fcAcuOv");
    const txt = ov ? ov.innerText : "";
    if (ov) ov.remove();
    return txt;
  });
  ok(!/^EXPLOTO/.test(sinParam), `E: ${sinParam}`);
  ok(/No se pudo calcular/.test(sinParam), `E: sin parámetros tiene que decirlo (dijo "${String(sinParam).slice(0, 60)}")`);

  await ctx.close();
  await browser.close();
  if (fallas.length) { console.error("fc-acuerdo-desglose: ROJO\n  - " + fallas.join("\n  - ")); process.exit(1); }
  console.log("fc-acuerdo-desglose: verde");
})().catch((e) => { console.error("fc-acuerdo-desglose: ERROR", e); process.exit(1); });
