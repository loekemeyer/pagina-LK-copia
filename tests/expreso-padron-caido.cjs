#!/usr/bin/env node
/**
 * tests/expreso-padron-caido.cjs — "no pude leer el padrón" NO es "no existe".
 *
 * POR QUÉ EXISTE. El 24/09 Tomás probó el módulo en la página de Chef: escribió
 * "con" y no le apareció CONTE. Medido: en el proyecto de Chef la tabla
 * `expresos` NO EXISTE (el padrón, 412 filas, vive en el de Loekemeyer), así que
 * `cargarExpresosCache()` reventaba, el `catch` lo tragaba y dejaba la lista en
 * `[]`. Para el cliente eso es idéntico a "tu expreso no está en nuestro
 * sistema" — y encima el cache se quedaba pegado en vacío para toda la sesión.
 *
 * Es el pozo de §"una lectura ROTA no es un CERO" (Gestión, v19.58) aplicado al
 * checkout, y el de Elías (v20.58): el tapón va con la forma de enterarse.
 *
 * Lo que fija, con el padrón CAÍDO (la consulta tira):
 *   1. el buscador avisa (.exp-op-vacio), no se queda mudo
 *   2. el cartel ámbar de "cargalo a mano" igual aparece
 *   3. el botón NO se deshabilita: se puede mandar el expreso escrito a mano
 *   4. el vacío NO se cachea: el segundo intento vuelve a pedir el padrón
 *
 * Correr:  node tests/expreso-padron-caido.cjs
 *          node tests/expreso-padron-caido.cjs ../paginach   (contra Chef)
 */
const path = require("path");
let chromium;
try { ({ chromium } = require("/opt/node22/lib/node_modules/playwright")); }
catch (_e) {
  try { ({ chromium } = require("playwright")); }
  catch (_e2) { console.error("expreso-padron-caido: SALTEADO — no hay playwright"); process.exit(0); }
}

const raiz = process.argv[2]
  ? path.resolve(__dirname, "..", process.argv[2])
  : path.join(__dirname, "..");

const fallas = [];
const ok = (c, m) => { if (!c) fallas.push(m); };

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  await ctx.route("**://**", (r) =>
    r.request().url().startsWith("file:") ? r.continue() : r.fulfill({ status: 200, body: "" }),
  );

  const page = await ctx.newPage();
  page.on("dialog", (d) => d.dismiss().catch(() => {}));

  // El padrón FALLA, que es lo que pasaba de verdad en Chef. Se cuenta cuántas
  // veces se pidió: si el vacío se cachea, la 2.ª búsqueda no vuelve a pedirlo.
  await page.addInitScript(() => {
    window.__pedidosPadron = 0;
    const resp = { data: [], error: null };
    const q = {
      select: () => q, eq: () => q, order: () => q, limit: () => q,
      single: () => Promise.resolve(resp), insert: () => q,
      then: (f) => Promise.resolve(resp).then(f),
    };
    const cli = {
      from: (t) => (t === "expresos"
        ? { select: () => ({ order: () => {
              window.__pedidosPadron++;
              return Promise.resolve({ data: null, error: { message: "relation does not exist" } });
            } }) }
        : q),
      rpc: () => Promise.resolve({ data: { ok: true }, error: null }),
      auth: { getSession: () => Promise.resolve({ data: { session: null } }), onAuthStateChange: () => {} },
    };
    window.supabase = { createClient: () => cli };
  });

  await page.goto("file://" + path.join(raiz, "mayorista.html"));
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => typeof window.onExpBuscarInput === "function", null, { timeout: 15000 });

  // El popup del expreso, abierto a mano (no hace falta el select para esto).
  await page.evaluate(() => {
    const m = document.getElementById("modalExpreso");
    if (m) { m.hidden = false; m.style.display = "flex"; m.classList.add("active"); }
    const s = m && m.closest(".section");
    if (s) { s.classList.add("active"); s.style.display = "block"; }
  });

  const buscar = async (txt) => {
    await page.evaluate((t) => {
      const i = document.getElementById("expBuscar");
      i.value = t;
      return window.onExpBuscarInput(t);
    }, txt);
    await page.waitForTimeout(150);
  };

  await buscar("con");

  const r = await page.evaluate(() => {
    const res = document.getElementById("expResultados");
    const libre = document.getElementById("expLibre");
    const btn = document.getElementById("expGuardarBtn");
    return {
      avisa: !!(res && res.querySelector(".exp-op-vacio")),
      textoRes: res ? res.textContent.trim().slice(0, 90) : "(sin #expResultados)",
      libreVisible: !!(libre && !libre.hidden),
      btnHabilitado: !!(btn && !btn.disabled),
      pedidos: window.__pedidosPadron,
    };
  });

  ok(r.avisa, "1: el buscador quedó MUDO con el padrón caído — el cliente lee 'tu expreso no existe'. res=" + JSON.stringify(r.textoRes));
  ok(r.libreVisible, "2: no apareció el bloque para cargarlo a mano (#expLibre)");
  ok(r.btnHabilitado, "3: FRENÓ al cliente — con el padrón caído el botón tiene que dejar mandarlo igual");

  // 4. el vacío no se cachea
  await buscar("cont");
  const dos = await page.evaluate(() => window.__pedidosPadron);
  ok(dos > r.pedidos, "4: el vacío quedó cacheado (" + r.pedidos + " → " + dos + "): el padrón no se vuelve a pedir en toda la sesión");

  await browser.close();

  if (fallas.length) {
    console.error("expreso-padron-caido: FALLA (" + path.basename(raiz) + ")");
    fallas.forEach((f) => console.error("  ✗ " + f));
    process.exit(1);
  }
  console.log("expreso-padron-caido: OK (" + path.basename(raiz) + ") — avisa, ofrece cargarlo a mano, no frena y no cachea el vacío.");
})().catch((e) => { console.error("expreso-padron-caido: ERROR", e); process.exit(1); });
