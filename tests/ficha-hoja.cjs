#!/usr/bin/env node
/**
 * tests/ficha-hoja.cjs — Ficha de Cliente con la visual de la planilla (Luis, 25/09).
 *
 * Corre fcRender() de verdad en admin.html (red cortada, datos de Messina 1573)
 * y mide:
 *   A. la hoja trae los datos de la planilla (FC por año de ISIS, mayor compra,
 *      cant. facturas, límite, acuerdo cliente/tomado/rent);
 *   B. la DEUDA es la del Excel del ERP (la de Cuarentena), no customers.debt;
 *   C. si ISIS no responde dice "s/d", nunca "$ 0" (una lectura rota no es un cero);
 *   D. estándar de tablas: encabezados centrados, ninguna tabla estirada al ancho
 *      de la pantalla, y todo centrado horizontalmente.
 *
 * Correr:  node tests/ficha-hoja.cjs
 */
const path = require("path");
let chromium;
try { ({ chromium } = require("/opt/node22/lib/node_modules/playwright")); }
catch (_e) {
  try { ({ chromium } = require("playwright")); }
  catch (_e2) { console.error("ficha-hoja: SALTEADO — no hay playwright"); process.exit(0); }
}
const raiz = path.join(__dirname, "..");
const fallas = [];
const ok = (c, m) => { if (!c) fallas.push(m); };

const ANIO = new Date().getFullYear();
const FICHA = {
  cod: "1573",
  datos: { cod_cliente: 1573, business_name: "Messina Hnos S.A.", cuit: "30710393679",
    vendedor: "Fca.", dto_vol: 0.12, payment_term: 2, debt: 256701.98,
    credit_limit: 17000000, mail: "a@b.com", chef_cods: [] },
  direcciones: [{ slot: 1, label: "Quilmes", localidad: "Quilmes", provincia: "Buenos Aires" }],
  pedidos_mes: [], pedidos_trimestre: [],
  facturacion_anio: [{ anio: String(ANIO - 1), lk: 36218834, chef: 0, total: 36218834, compras: 13, cajas: 900 }],
  resumen_articulos: { total_distintos: 1, activos_count: 1 },
  meses: [ANIO + "-09"], articulos: [{ empresa: "lk", cod: "505", descripcion: "Pelador", cajas: 10, neto: 1000, mm: {} }],
};
const ISIS = {
  anios: [
    { anio: ANIO, fc: 35254400, fc_lk: 35254400, fc_ch: 0, mayor: 6448542, n_fact: 16 },
    { anio: ANIO - 1, fc: 30048890, fc_lk: 30048890, fc_ch: 0, mayor: 7479231, n_fact: 14 },
    { anio: ANIO - 2, fc: 17225952, fc_lk: 17225952, fc_ch: 0, mayor: 3847435, n_fact: 10 },
  ],
  primera_compra: "2019-08-02", deuda: 5700753.28, deuda_at: "2026-09-25T12:13:48Z",
};
const ACU = { factor: 1.562, dto_pago_hoy: 25, dto_pago_antes: 8, mejora_pago: 18.5, acuerdo: -3.3,
  recibo: 96.7, cheque: 97.7, dto_max: 2, dto_vol: 12, comision: 0, margen_dto: -10,
  parametros: { indice_lista: 151 }, simulacion: [{ comision: 0, dto_max: 2, acuerdo_con_dto_actual: -3.3 }] };

(async () => {
  const browser = await chromium.launch();
  for (const ancho of [1920, 1280]) {
    const ctx = await browser.newContext({ viewport: { width: ancho, height: 1000 } });
    await ctx.route("**://**", (r) =>
      r.request().url().startsWith("file:") ? r.continue() : r.fulfill({ status: 200, body: "" }));
    const page = await ctx.newPage();
    await page.goto("file://" + path.join(raiz, "admin.html"));
    await page.waitForTimeout(300);
    const r = await page.evaluate(([F, I, A]) => {
      document.querySelectorAll(".page").forEach((p) => (p.style.display = "none"));
      const sec = document.getElementById("ficha-cliente");
      sec.style.display = "block"; sec.classList.add("active");
      const ls = document.getElementById("loadingScreen"); if (ls) ls.style.display = "none";
      // El panel arranca oculto hasta el login: se destapa la cadena de padres.
      for (let e = sec; e && e !== document.body; e = e.parentElement) {
        if (getComputedStyle(e).display === "none") e.style.display = "block";
        e.hidden = false;
      }
      function correr(isis, err) {
        _fcData = F; _fcAcuerdo = A; _fcIsis = isis; _fcIsisError = err; fcRender();
        return document.getElementById("fcContenido");
      }
      const out = {};
      const c = correr(I, null);
      out.txt = c.innerText;
      const cr = c.getBoundingClientRect();
      out.cont = { l: cr.left, r: cr.right };
      out.tablas = [...c.querySelectorAll("table")].map((t) => {
        const b = t.getBoundingClientRect();
        return { cls: t.className, w: b.width, l: b.left, r: b.right };
      });
      out.cards = [...c.querySelectorAll(".fc-card, .fc-hoja")].map((t) => {
        const b = t.getBoundingClientRect(); return { cls: t.className, l: b.left, r: b.right };
      });
      out.thNoCentrado = [...c.querySelectorAll("table thead th, .fc-h-tabla th")]
        .filter((th) => getComputedStyle(th).textAlign !== "center").map((th) => th.innerText);
      out.txtSinIsis = correr(null, "timeout").innerText;
      return out;
    }, [FICHA, ISIS, ACU]);

    const t = r.txt.replace(/\s+/g, " ");
    ok(t.includes("17.225.952"), `[${ancho}] A: falta FC ${ANIO - 2} de ISIS (17.225.952)`);
    ok(t.includes("30.048.890"), `[${ancho}] A: falta FC ${ANIO - 1} de ISIS`);
    ok(t.includes("7.479.231"), `[${ancho}] A: falta Mayor compra ${ANIO - 1}`);
    ok(/Cant\. Facturas \d{4} 14/.test(t) || t.includes("14"), `[${ancho}] A: falta cant. facturas`);
    ok(t.includes("17.000.000"), `[${ancho}] A: falta límite de crédito`);
    ok(t.includes("1,56") && t.includes("1,51"), `[${ancho}] A: falta acuerdo cliente/tomado`);
    ok(t.includes("-3%"), `[${ancho}] A: falta +-Rent (-3%)`);
    ok(t.includes("5.700.753"), `[${ancho}] B: la deuda no es la del Excel del ERP`);
    ok(!t.includes("256.702"), `[${ancho}] B: sigue mostrando customers.debt`);
    const s = r.txtSinIsis.replace(/\s+/g, " ");
    ok(s.includes("s/d") && !/FC \d{4} \$ 0/.test(s), `[${ancho}] C: sin ISIS tiene que decir s/d`);
    ok(r.thNoCentrado.length === 0, `[${ancho}] D: encabezados no centrados: ${r.thNoCentrado.slice(0, 5).join(" | ")}`);
    const anchoCont = r.cont.r - r.cont.l;
    r.tablas.forEach((tb) => {
      ok(tb.w < anchoCont * 0.95, `[${ancho}] D: tabla "${tb.cls}" estirada (${Math.round(tb.w)} de ${Math.round(anchoCont)})`);
    });
    const centro = (r.cont.l + r.cont.r) / 2;
    r.cards.forEach((cd) => {
      const cc = (cd.l + cd.r) / 2;
      ok(Math.abs(cc - centro) < 3, `[${ancho}] D: "${cd.cls}" no está centrada (${Math.round(cc)} vs ${Math.round(centro)})`);
    });
    await ctx.close();
  }
  await browser.close();
  if (fallas.length) { console.error("ficha-hoja: ROJO\n  - " + fallas.join("\n  - ")); process.exit(1); }
  console.log("ficha-hoja: verde");
})().catch((e) => { console.error("ficha-hoja: ERROR", e); process.exit(1); });
