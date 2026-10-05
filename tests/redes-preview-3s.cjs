#!/usr/bin/env node
/**
 * tests/redes-preview-3s.cjs — preview de 3 s en «Contenido para tus redes».
 *
 * POR QUÉ EXISTE (05/10/2026). Cada video de la grilla se reproduce MUDO los
 * primeros 3 s cuando entra en pantalla, una vez por apertura, y al terminar se
 * le saca el src para que deje de bajar (los videos pesan 9-21 MB y la
 * transferencia de Supabase es compartida). Corre mayorista.html en Chromium,
 * con la lista del bucket simulada y un video de prueba de 8 s, y verifica:
 *   A. al abrir, los videos visibles arrancan solos y mudos; los que quedan
 *      fuera de pantalla no arrancan ni piden el archivo.
 *   B. el preview llega a ~3 s y se corta: pausado, sin sonido pendiente
 *      (muted=false para el play de la persona), src repuesto y en 0.
 *   C. después del corte no se pide más nada del video.
 *   D. volver a dibujar la grilla (buscar) no repite el preview.
 *   E. cerrar a mitad del preview lo corta; reabrir lo vuelve a mostrar.
 *   F. si la persona toca el video durante el preview, sigue andando entero.
 *   G. con «ahorro de datos» del celular, no hay preview.
 *   H. la grilla scrollea en vez de aplastar las filas (tapaban «Descargar»).
 *
 * Necesita ffmpeg (arma el video de prueba); sin ffmpeg o sin playwright se saltea.
 * Correr:  node tests/redes-preview-3s.cjs
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFileSync } = require("child_process");
let chromium;
try { ({ chromium } = require("/opt/node22/lib/node_modules/playwright")); }
catch (_e) {
  try { ({ chromium } = require("playwright")); }
  catch (_e2) { console.error("redes-preview-3s: SALTEADO — no hay playwright"); process.exit(0); }
}

const VIDEO = path.join(os.tmpdir(), "redes-preview-3s-prueba.webm");
try {
  if (!fs.existsSync(VIDEO))
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=160x160:rate=15",
      "-t", "8", "-c:v", "libvpx", "-b:v", "120k", "-an", VIDEO]);
} catch (_e) {
  console.error("redes-preview-3s: SALTEADO — no hay ffmpeg para armar el video de prueba");
  process.exit(0);
}

const N = 12;
const PRODS = Array.from({ length: N }, (_, i) => ({
  id: "p-" + (i + 1), cod: "V" + (i + 1), category: "Sacacorchos", subcategory: null,
  ranking: i + 1, orden_catalogo: i + 1, description: "Producto con video " + (i + 1), uxb: 12,
  images: ["V" + (i + 1) + ".webp"], badge_status: null, list_price: 1000,
}));

async function abrirPagina(browser, { saveData = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const FOTO = path.join(__dirname, "..", "img", "no-image.jpg");
  const pedidos = {}; // cod -> requests al archivo de video
  await ctx.route("**://**", (r) => {
    const u = r.request().url();
    if (u.startsWith("file:")) return r.continue();
    const m = u.match(/\/products-videos\/([^/?#]+)\.webm/);
    if (m) {
      pedidos[m[1]] = (pedidos[m[1]] || 0) + 1;
      return r.fulfill({ status: 200, contentType: "video/webm", path: VIDEO });
    }
    if (r.request().resourceType() === "image" || /\.(webp|jpe?g|png)(\?|$)/i.test(u))
      return r.fulfill({ status: 200, contentType: "image/jpeg", path: FOTO });
    return r.fulfill({ status: 200, body: "" });
  });
  const page = await ctx.newPage();
  page.on("dialog", (d) => d.dismiss().catch(() => {}));
  await page.addInitScript(({ prods, saveData }) => {
    if (saveData) Object.defineProperty(navigator, "connection", { value: { saveData: true }, configurable: true });
    const of = window.fetch;
    window.fetch = (u, o) => {
      if (String(u).includes("/object/list/products-videos"))
        return Promise.resolve(new Response(JSON.stringify(prods.map((p) => ({ name: p.cod + ".webm" }))),
          { status: 200, headers: { "Content-Type": "application/json" } }));
      return of(u, o);
    };
    const vacio = { data: [], error: null };
    const q = {
      select: () => q, eq: () => q, in: () => q, order: () => q, limit: () => q,
      single: () => Promise.resolve({ data: null, error: null }),
      insert: () => q, update: () => q, upsert: () => q, delete: () => q,
      then: (f) => Promise.resolve(vacio).then(f),
    };
    window.supabase = {
      createClient: () => ({
        from: () => q,
        rpc: (name) =>
          name === "get_products_public_sorted"
            ? Promise.resolve({ data: prods, error: null })
            : Promise.resolve(vacio),
        auth: {
          getSession: () => Promise.resolve({ data: { session: null } }),
          onAuthStateChange: () => {},
        },
        storage: { from: () => ({ getPublicUrl: () => ({ data: { publicUrl: "" } }) }) },
      }),
    };
    // Registra el currentTime máximo de cada video mientras dura la prueba.
    window.__crMax = {};
    setInterval(() => {
      document.querySelectorAll("#crGrid video.cr-video").forEach((v) => {
        const cod = v.closest(".cr-item").getAttribute("data-cod");
        window.__crMax[cod] = Math.max(window.__crMax[cod] || 0, v.currentTime || 0);
      });
    }, 40);
  }, { prods: PRODS, saveData });
  await page.goto("file://" + path.join(__dirname, "..", "mayorista.html"));
  await page.waitForFunction(() => typeof window.abrirContenidoRedes === "function", null, { timeout: 15000 });
  await page.evaluate(async () => { await window.loadProductsFromDB(); });
  return { ctx, page, pedidos };
}

const estado = (page) => page.evaluate(() => {
  // La grilla scrollea adentro de la tarjeta: lo visible lo recorta #crGrid.
  const card = document.getElementById("crGrid");
  const cr = card ? card.getBoundingClientRect() : null;
  return [...document.querySelectorAll("#crGrid video.cr-video")].map((v) => {
    const r = v.getBoundingClientRect();
    const top = Math.max(r.top, cr ? cr.top : 0, 0);
    const bot = Math.min(r.bottom, cr ? cr.bottom : innerHeight, innerHeight);
    return {
      cod: v.closest(".cr-item").getAttribute("data-cod"),
      visible: r.height > 0 && (bot - top) / r.height >= 0.6,
      paused: v.paused, muted: v.muted, t: v.currentTime,
      src: v.getAttribute("src") || "", auto: v.hasAttribute("autoplay"),
      prev: !!v._crPrev,
    };
  });
});

(async () => {
  const fallas = [];
  const browser = await chromium.launch();
  const espera = (page, ms) => page.waitForTimeout(ms);

  const { ctx, page, pedidos } = await abrirPagina(browser);

  // A: al abrir, arrancan los visibles; los de abajo no.
  await page.evaluate(() => window.abrirContenidoRedes());
  await espera(page, 1200);
  let st = await estado(page);
  if (st.length !== N) fallas.push(`A: la grilla tiene ${st.length} videos, se esperaban ${N}`);
  const vis = st.filter((x) => x.visible), fuera = st.filter((x) => !x.visible);
  if (!vis.length) fallas.push("A: ningún video quedó visible: la prueba no mide nada");
  if (!fuera.length) fallas.push("A: todos los videos entran en pantalla: no se puede medir que los de abajo no arranquen");
  vis.forEach((x) => {
    if (x.paused) fallas.push(`A: ${x.cod} está visible y no arrancó el preview`);
    if (!x.muted) fallas.push(`A: ${x.cod} arrancó el preview con sonido`);
  });
  fuera.forEach((x) => {
    if (!x.paused) fallas.push(`A: ${x.cod} está fuera de pantalla y se reproduce`);
    if (pedidos[x.cod]) fallas.push(`A: ${x.cod} está fuera de pantalla y ya pidió el video (${pedidos[x.cod]} requests)`);
  });
  st.forEach((x) => { if (x.auto) fallas.push(`A: ${x.cod} tiene el atributo autoplay (bajaría el archivo entero)`); });

  // H: la grilla scrollea en vez de aplastar las filas (bug previo: cada
  // tarjeta tapaba el código, el nombre y «Descargar» de la de arriba).
  const lay = await page.evaluate(() => {
    const g = document.getElementById("crGrid");
    const it = g.querySelector(".cr-item");
    const a = it.querySelector(".cr-actions").getBoundingClientRect();
    return { sh: g.scrollHeight, ch: g.clientHeight, itB: it.getBoundingClientRect().bottom, acB: a.bottom };
  });
  if (lay.sh <= lay.ch) fallas.push(`H: la grilla no scrollea con ${N} videos (scrollHeight ${lay.sh} = ${lay.ch}): se aplastan las filas`);
  if (lay.acB > lay.itB + 1) fallas.push(`H: «Descargar» queda cortado dentro de la tarjeta (${lay.acB} > ${lay.itB})`);

  // B: a los ~3 s se corta.
  await espera(page, 3600);
  st = await estado(page);
  const max = await page.evaluate(() => window.__crMax);
  vis.forEach((x0) => {
    const x = st.find((y) => y.cod === x0.cod);
    const m = max[x0.cod] || 0;
    if (m < 2.6) fallas.push(`B: ${x0.cod} no llegó a los 3 s de preview (máx ${m.toFixed(2)} s)`);
    if (m > 3.5) fallas.push(`B: ${x0.cod} pasó de los 3 s (máx ${m.toFixed(2)} s)`);
    if (!x.paused) fallas.push(`B: ${x0.cod} sigue reproduciéndose después de los 3 s`);
    if (x.muted) fallas.push(`B: ${x0.cod} quedó mudo: el play de la persona saldría sin sonido`);
    if (!/\/products-videos\/V\d+\.webm$/.test(x.src)) fallas.push(`B: ${x0.cod} quedó sin src: el play de la persona no andaría (${x.src})`);
    if (x.t > 0.05) fallas.push(`B: ${x0.cod} no se cortó la descarga (sigue cargado en ${x.t.toFixed(2)} s)`);
    if (x.prev) fallas.push(`B: ${x0.cod} sigue en modo preview`);
  });

  // C: después del corte no se pide nada más.
  const antesC = JSON.stringify(pedidos);
  await espera(page, 1500);
  if (JSON.stringify(pedidos) !== antesC)
    fallas.push(`C: después del corte se siguió pidiendo video: ${antesC} → ${JSON.stringify(pedidos)}`);

  // D: re-dibujar la grilla no repite el preview.
  await page.evaluate(() => window.crRender());
  await espera(page, 900);
  st = await estado(page);
  st.filter((x) => vis.some((y) => y.cod === x.cod)).forEach((x) => {
    if (!x.paused) fallas.push(`D: ${x.cod} repitió el preview al volver a dibujar la grilla`);
  });
  if (JSON.stringify(pedidos) !== antesC) fallas.push("D: re-dibujar la grilla volvió a pedir videos");

  // E: cerrar a mitad del preview lo corta; reabrir lo vuelve a mostrar.
  await page.evaluate(() => window.cerrarContenidoRedes());
  await page.evaluate(() => window.abrirContenidoRedes());
  await espera(page, 1200);
  st = await estado(page);
  if (!st.some((x) => x.visible && !x.paused)) fallas.push("E: al reabrir la pantalla no volvió el preview");
  await page.evaluate(() => window.cerrarContenidoRedes());
  await espera(page, 200);
  st = await estado(page);
  st.forEach((x) => {
    if (!x.paused) fallas.push(`E: ${x.cod} sigue reproduciéndose con la pantalla cerrada`);
    if (x.prev) fallas.push(`E: ${x.cod} quedó en modo preview con la pantalla cerrada`);
    if (x.t > 0.05) fallas.push(`E: ${x.cod} quedó cargado al cerrar (no se cortó la descarga)`);
  });

  // F: la persona toca el video durante el preview → sigue entero y con sonido.
  await page.evaluate(() => window.abrirContenidoRedes());
  await espera(page, 1200);
  const cod1 = (await estado(page)).find((x) => x.visible && !x.paused);
  if (!cod1) fallas.push("F: no hay ningún preview andando para tocar");
  else {
    const box = await page.locator(`#crGrid .cr-item[data-cod="${cod1.cod}"] video`).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y - 60); // soltar afuera: sin click
    await page.mouse.up();
    await espera(page, 3600);
    const x = (await estado(page)).find((y) => y.cod === cod1.cod);
    if (x.paused) fallas.push(`F: ${x.cod} se cortó a los 3 s aunque la persona lo tocó`);
    if (x.muted) fallas.push(`F: ${x.cod} sigue mudo después de que la persona lo tocó`);
    if (x.t < 3.2) fallas.push(`F: ${x.cod} no siguió después de los 3 s (va en ${x.t.toFixed(2)} s)`);
  }
  await ctx.close();

  // G: ahorro de datos → sin preview.
  const g = await abrirPagina(browser, { saveData: true });
  await g.page.evaluate(() => window.abrirContenidoRedes());
  await espera(g.page, 1000);
  const stg = await estado(g.page);
  if (stg.some((x) => !x.paused)) fallas.push("G: con «ahorro de datos» igual arrancó el preview");
  if (Object.keys(g.pedidos).length) fallas.push("G: con «ahorro de datos» se pidieron videos: " + JSON.stringify(g.pedidos));
  await g.ctx.close();

  await browser.close();
  if (fallas.length) {
    console.error("redes-preview-3s: FALLA\n - " + fallas.join("\n - "));
    process.exit(1);
  }
  console.log("redes-preview-3s: OK — preview mudo de 3 s sólo en lo visible, corta la descarga y no se repite.");
})().catch((e) => {
  console.error("redes-preview-3s: ERROR\n" + (e && e.stack ? e.stack : e));
  process.exit(1);
});
