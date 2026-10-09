#!/usr/bin/env node
/**
 * tests/ficha-fuente.cjs — cada dato de la hoja de la Ficha de Cliente dice de dónde sale.
 *
 * POR QUÉ EXISTE (09/10/2026). Pedido: tocar una celda de la hoja (ej. la FC de 2024)
 * abre un pop-up con la información de dónde toma el dato. Corre fcRender() de verdad en
 * admin.html (red cortada, RPC simulada) y mide:
 *   A. TODA celda de dato de la hoja es clickeable (no queda ninguna sin fuente).
 *   B. tocar la FC de un año abre el detalle comprobante por comprobante, las NC restan,
 *      y el total del pop-up es el número de la celda.
 *   C. tocar Mayor compra marca la factura más grande (★).
 *   D. una celda sin detalle (Lím. crédito, Deuda) dice la tabla y cómo se carga.
 *   E. si la RPC del detalle falla, lo dice (no muestra una tabla vacía).
 *   F. si la suma no coincide con la hoja, avisa en rojo.
 *
 * Correr:  node tests/ficha-fuente.cjs
 */
const path = require("path");
let chromium;
try { ({ chromium } = require("/opt/node22/lib/node_modules/playwright")); }
catch (_e) {
  try { ({ chromium } = require("playwright")); }
  catch (_e2) { console.error("ficha-fuente: SALTEADO — no hay playwright"); process.exit(0); }
}
const raiz = path.join(__dirname, "..");
const fallas = [];
const ok = (c, m) => { console.log((c ? "  ✓ " : "  ✗ ") + m); if (!c) fallas.push(m); };

const ANIO = new Date().getFullYear();
const A2 = ANIO - 2;
const FICHA = {
  cod: "2533",
  datos: { cod_cliente: 2533, business_name: "Osa Distribuidora", cuit: "30715175017",
    vendedor: "Fca.", dto_vol: 0.16, payment_term: 2, credit_limit: 72000000,
    mail: "a@b.com", chef_cods: ["2340"] },
  direcciones: [{ slot: 1, label: "Lugano", localidad: "Villa Lugano" }],
  pedidos_mes: [], pedidos_trimestre: [], facturacion_anio: [],
  resumen_articulos: { total_distintos: 0, activos_count: 0 }, meses: [], articulos: [],
};
const ISIS = {
  anios: [
    { anio: ANIO, fc: 100, fc_lk: 100, fc_ch: 0, mayor: 100, n_fact: 1 },
    { anio: ANIO - 1, fc: 100, fc_lk: 100, fc_ch: 0, mayor: 100, n_fact: 1 },
    { anio: A2, fc: 1250000, fc_lk: 1000000, fc_ch: 250000, mayor: 900000, n_fact: 2 },
  ],
  primera_compra: "2020-03-01", deuda: 6867805, deuda_at: "2026-10-09T12:00:00Z",
};
const DET = {
  anio: A2, cods_ch: ["2340"], comprobantes: [
    { emp: "lk", familia: "factura_venta", signo: 1, fecha: A2 + "-03-02", tipo: "FC Electr. A", pv: "0005", numero: "00000901", total: 900000, cajas: 40 },
    { emp: "lk", familia: "nc_venta", signo: -1, fecha: A2 + "-04-01", tipo: "NC Electr. A", pv: "0005", numero: "00000077", total: 150000, cajas: -5 },
    { emp: "lk", familia: "nd_venta", signo: 1, fecha: A2 + "-05-01", tipo: "ND Electr. A", pv: "0005", numero: "00000003", total: 250000, cajas: 0 },
    { emp: "chef", familia: "factura_venta", signo: 1, fecha: A2 + "-06-01", tipo: "FC Electr. A", pv: "0006", numero: "00004679", total: 250000, cajas: 5 },
  ],
};
const ACU = { factor: 1.64, dto_pago_hoy: 25, acuerdo: -7.7, recibo: 92, cheque: 93, dto_vol: 16,
  comision: 0, parametros: { indice_lista: 151, dto_pago: 0.25, dto_cot: 0.02, flete: 0.01, piso: 100 },
  simulacion: [] };

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await ctx.route("**://**", (r) =>
    r.request().url().startsWith("file:") ? r.continue() : r.fulfill({ status: 200, body: "" }));
  const page = await ctx.newPage();
  await page.goto("file://" + path.join(raiz, "admin.html"));
  await page.waitForTimeout(300);
  await page.evaluate(([F, I, A, D]) => {
    document.querySelectorAll(".page").forEach((p) => (p.style.display = "none"));
    const sec = document.getElementById("ficha-cliente");
    sec.style.display = "block"; sec.classList.add("active");
    const ls = document.getElementById("loadingScreen"); if (ls) ls.style.display = "none";
    for (let e = sec; e && e !== document.body; e = e.parentElement) {
      if (getComputedStyle(e).display === "none") e.style.display = "block";
      e.hidden = false;
    }
    window.__modo = "ok";
    window.sb = { rpc: (fn, args) => {
      window.__llamada = { fn, args };
      if (window.__modo === "falla") return Promise.resolve({ data: null, error: { message: "timeout" } });
      return Promise.resolve({ data: D, error: null });
    } };
    _fcData = F; _fcAcuerdo = A; _fcIsis = I; _fcIsisError = null; fcRender();
  }, [FICHA, ISIS, ACU, DET]);

  try {
    // A
    const sinFuente = await page.$$eval(".fc-h-grid td", (tds) => tds.filter((t) => !t.classList.contains("fc-src")).map((t) => t.innerText));
    ok(sinFuente.length === 0, "A. toda celda de la hoja es clickeable (sin fuente: " + JSON.stringify(sinFuente) + ")");

    // B — FC del año A2 (3.ª columna de años = la más vieja va primero)
    await page.click(`.fc-h-grid td.fc-src[onclick="fcFuente('fc',${A2})"]`);
    await page.waitForSelector("#fcAcuOv .fc-src-tab");
    const b = await page.evaluate(() => ({
      tit: document.querySelector("#fcAcuOv .fc-acud-head").innerText,
      filas: document.querySelectorAll("#fcAcuOv .fc-src-tab tbody tr:not(.fc-src-tot):not(.fc-src-sub)").length,
      tot: document.querySelector("#fcAcuOv .fc-src-tot .fc-src-imp").innerText,
      nc: document.querySelector("#fcAcuOv tr.fc-src-nc .fc-src-imp").innerText,
      txt: document.querySelector("#fcAcuOv").innerText,
      llamada: window.__llamada,
    }));
    ok(/FC \d{4} — de dónde sale/.test(b.tit), "B. el título dice FC del año (" + b.tit + ")");
    ok(b.llamada.fn === "get_ficha_isis_detalle" && b.llamada.args.p_cod === "2533" && b.llamada.args.p_anio === A2,
      "B. pide el detalle del cliente y año (" + JSON.stringify(b.llamada) + ")");
    ok(b.filas === 4, "B. lista los 4 comprobantes (" + b.filas + ")");
    ok(/^−/.test(b.nc), "B. la NC resta (" + b.nc + ")");
    ok(b.tot.replace(/\D/g, "") === "1250000", "B. el total es el de la celda (" + b.tot + ")");
    ok(/ISIS/.test(b.txt) && /2340/.test(b.txt), "B. dice que sale de ISIS y nombra el código de Chef");
    ok(!/no coincide/.test(b.txt), "B. no avisa diferencia cuando la suma cuadra");
    await page.evaluate(() => fcAcuCerrar());

    // C
    await page.click(`.fc-h-grid td.fc-src[onclick="fcFuente('mayor',${A2})"]`);
    await page.waitForSelector("#fcAcuOv tr.fc-src-may");
    const may = await page.$eval("#fcAcuOv tr.fc-src-may", (t) => t.innerText);
    ok(/★/.test(may) && /900\.000/.test(may), "C. Mayor compra marca la factura más grande (" + may.replace(/\s+/g, " ") + ")");
    await page.evaluate(() => fcAcuCerrar());

    // D
    await page.click(`.fc-h-grid td.fc-src[onclick="fcFuente('lim')"]`);
    const lim = await page.$eval("#fcAcuOv", (o) => o.innerText);
    ok(/credit_limit/.test(lim) && /Límites de crédito/.test(lim), "D. Lím. crédito dice la tabla y cómo se carga");
    await page.evaluate(() => fcAcuCerrar());
    await page.click(`.fc-h-grid td.fc-src[onclick="fcFuente('deuda')"]`);
    const deu = await page.$eval("#fcAcuOv", (o) => o.innerText);
    ok(/Excel de deuda del ERP/.test(deu) && /09\/10\/26/.test(deu), "D. Deuda dice el Excel del ERP y su fecha");
    await page.evaluate(() => fcAcuCerrar());

    // E
    await page.evaluate(() => { window.__modo = "falla"; _fcDetCache = {}; });
    await page.click(`.fc-h-grid td.fc-src[onclick="fcFuente('nfact',${A2})"]`);
    await page.waitForFunction(() => /No se pudo leer el detalle/.test((document.querySelector("#fcAcuOv") || {}).innerText || ""));
    ok(true, "E. RPC caída → lo dice");
    await page.evaluate(() => fcAcuCerrar());

    // F
    await page.evaluate(() => { window.__modo = "ok"; _fcDetCache = {}; _fcIsis.anios[2].fc = 999; });
    await page.click(`.fc-h-grid td.fc-src[onclick="fcFuente('fc',${A2})"]`);
    await page.waitForSelector("#fcAcuOv .fc-src-tab");
    const f = await page.$eval("#fcAcuOv", (o) => o.innerText);
    ok(/no coincide con la hoja/.test(f), "F. si la suma no da la celda, avisa");
  } catch (err) {
    fallas.push("excepción: " + err.message); console.error(err);
  }
  await browser.close();
  if (fallas.length) { console.error("ficha-fuente: " + fallas.length + " FALLA(S)"); process.exit(1); }
  console.log("ficha-fuente: verde");
})();
