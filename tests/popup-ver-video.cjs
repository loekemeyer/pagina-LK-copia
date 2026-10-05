#!/usr/bin/env node
/**
 * tests/popup-ver-video.cjs — el botón "Ver video" del popup de producto.
 *
 * POR QUÉ EXISTE (05/10/2026). El popup que abre la foto de una card ahora
 * muestra "Ver video" arriba a la derecha SÓLO si el producto tiene video en el
 * bucket products-videos. Corre mayorista.html en Chromium (red cortada, lista
 * del bucket simulada) y verifica:
 *   A. producto con video → el botón aparece, arriba a la derecha de la foto;
 *      producto sin video → no aparece.
 *   B. abrir el popup NO baja el video (sin src, sin autoplay, preload=none):
 *      cada video pesa ~15 MB contra la cuota de transferencia de Supabase.
 *   C. tocar el botón → el video reemplaza a la foto y el botón dice "Ver fotos";
 *      tocarlo de nuevo vuelve a la foto y le saca el src.
 *   D. cerrar el popup con el video andando → se corta y se le saca el src.
 *   E. si la lista del bucket falla, no se cachea "no hay videos": el próximo
 *      popup vuelve a preguntar y el botón aparece.
 *   F. la × de cerrar se ve (antes era blanca sobre la tarjeta blanca).
 *
 * Correr:  node tests/popup-ver-video.cjs
 */
const path = require("path");
let chromium;
try { ({ chromium } = require("/opt/node22/lib/node_modules/playwright")); }
catch (_e) {
  try { ({ chromium } = require("playwright")); }
  catch (_e2) { console.error("popup-ver-video: SALTEADO — no hay playwright"); process.exit(0); }
}

const PRODS = [
  { id: "p-1", cod: "523", category: "Sacacorchos", subcategory: null, ranking: 1,
    orden_catalogo: 1, description: "Sacacorcho con video", uxb: 12,
    images: ["523-2.webp", "523.webp"], badge_status: null, list_price: 1000 },
  { id: "p-2", cod: "505", category: "Peladores", subcategory: null, ranking: 2,
    orden_catalogo: 2, description: "Pelador sin video", uxb: 12,
    images: ["505.webp"], badge_status: null, list_price: 1000 },
];

(async () => {
  const fallas = [];
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const FOTO = path.join(__dirname, "..", "img", "no-image.jpg");
  await ctx.route("**://**", (r) => {
    const u = r.request().url();
    if (u.startsWith("file:")) return r.continue();
    if (r.request().resourceType() === "image" || /\.(webp|jpe?g|png)(\?|$)/i.test(u))
      return r.fulfill({ status: 200, contentType: "image/jpeg", path: FOTO });
    return r.fulfill({ status: 200, body: "" });
  });
  const page = await ctx.newPage();
  page.on("dialog", (d) => d.dismiss().catch(() => {}));

  await page.addInitScript((prods) => {
    // La lista del bucket: la 1ª llamada FALLA (para el chequeo E), después responde.
    window.__vvLlamadas = 0;
    const of = window.fetch;
    window.fetch = (u, o) => {
      if (String(u).includes("/object/list/products-videos")) {
        window.__vvLlamadas++;
        if (window.__vvLlamadas === 1)
          return Promise.resolve(new Response("caido", { status: 503 }));
        return Promise.resolve(new Response(JSON.stringify([{ name: "523.mp4" }]),
          { status: 200, headers: { "Content-Type": "application/json" } }));
      }
      return of(u, o);
    };
    const vacio = { data: [], error: null };
    const q = {
      select: () => q, eq: () => q, in: () => q, order: () => q, limit: () => q,
      single: () => Promise.resolve({ data: null, error: null }),
      insert: () => q, update: () => q, upsert: () => q,
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
  }, PRODS);

  await page.goto("file://" + path.join(__dirname, "..", "mayorista.html"));
  await page.waitForFunction(() => typeof window.openProdPreview === "function", null, { timeout: 15000 });
  await page.evaluate(async () => { await window.loadProductsFromDB(); });

  const visible = () => page.evaluate(() => {
    const b = document.getElementById("ppVideoBtn");
    return !!b && getComputedStyle(b).display !== "none";
  });
  const espera = (ms) => page.waitForTimeout(ms);

  // E (1ª mitad): la lista falla → sin botón, y NO queda cacheado.
  await page.evaluate(() => window.openProdPreview("p-1"));
  await espera(300);
  if (await visible()) fallas.push("E: con la lista del bucket caída igual mostró el botón");
  await page.evaluate(() => window.cerrarProdPreview());

  // A: con la lista respondiendo, el producto con video muestra el botón.
  await page.evaluate(() => window.openProdPreview("p-1"));
  await page.waitForFunction(() => {
    const b = document.getElementById("ppVideoBtn");
    return b && getComputedStyle(b).display !== "none";
  }, null, { timeout: 3000 }).catch(() =>
    fallas.push("E/A: después de una lista caída el botón no apareció — quedó cacheado el «no hay videos»"));
  if (!(await visible())) {
    // Sin botón no hay nada más que medir: se corta acá con el motivo.
    await browser.close();
    console.error("popup-ver-video: FALLA\n - " + fallas.join("\n - "));
    process.exit(1);
  }

  const geo = await page.evaluate(() => {
    const b = document.getElementById("ppVideoBtn").getBoundingClientRect();
    const w = document.querySelector("#prodPreviewModal .pp-imgwrap").getBoundingClientRect();
    return { bR: b.right, bT: b.top, bW: b.width, wR: w.right, wT: w.top, wL: w.left, txt: document.getElementById("ppVideoBtn").textContent };
  });
  if (!(geo.wR - geo.bR >= 0 && geo.wR - geo.bR <= 24 && geo.bT - geo.wT >= 0 && geo.bT - geo.wT <= 24))
    fallas.push(`A: el botón no está arriba a la derecha de la foto (${JSON.stringify(geo)})`);
  if (!/Ver video/.test(geo.txt)) fallas.push("A: el botón no dice «Ver video»: " + geo.txt);

  // B: abrir no baja el video.
  const antes = await page.evaluate(() => {
    const v = document.getElementById("ppVideo");
    return { src: v.getAttribute("src"), auto: v.hasAttribute("autoplay"), pre: v.getAttribute("preload"),
      disp: getComputedStyle(v).display };
  });
  if (antes.src) fallas.push("B: el video ya tiene src al abrir el popup — se baja sin que lo pidan");
  if (antes.auto) fallas.push("B: el video del popup tiene autoplay");
  if (antes.pre !== "none") fallas.push("B: el video del popup no tiene preload=none");
  if (antes.disp !== "none") fallas.push("B: el video se ve antes de tocar el botón");

  // C: tocar → video en lugar de la foto.
  await page.click("#ppVideoBtn");
  await espera(200);
  const con = await page.evaluate(() => ({
    src: document.getElementById("ppVideo").getAttribute("src") || "",
    vDisp: getComputedStyle(document.getElementById("ppVideo")).display,
    iDisp: getComputedStyle(document.getElementById("ppImg")).display,
    prev: getComputedStyle(document.getElementById("ppPrev")).display,
    txt: document.getElementById("ppVideoBtn").textContent,
    abierto: document.getElementById("prodPreviewModal").classList.contains("open"),
  }));
  if (!/\/products-videos\/523\.mp4$/.test(con.src)) fallas.push("C: el video no apunta a 523.mp4: " + con.src);
  if (con.vDisp === "none") fallas.push("C: tocado el botón, el video no se ve");
  if (con.iDisp !== "none") fallas.push("C: tocado el botón, la foto sigue a la vista");
  if (con.prev !== "none") fallas.push("C: con el video andando siguen las flechas de las fotos");
  if (!/Ver fotos/.test(con.txt)) fallas.push("C: el botón no pasó a «Ver fotos»: " + con.txt);
  if (!con.abierto) fallas.push("C: tocar el botón cerró el popup");

  await page.click("#ppVideoBtn");
  await espera(150);
  const vuelta = await page.evaluate(() => ({
    src: document.getElementById("ppVideo").getAttribute("src"),
    iDisp: getComputedStyle(document.getElementById("ppImg")).display,
    prev: getComputedStyle(document.getElementById("ppPrev")).display,
  }));
  if (vuelta.src) fallas.push("C: al volver a las fotos el video sigue con src (sigue bajando)");
  if (vuelta.iDisp === "none") fallas.push("C: al volver, la foto no reaparece");
  if (vuelta.prev === "none") fallas.push("C: al volver, las flechas de las fotos no reaparecen");

  // D: cerrar con el video andando.
  await page.click("#ppVideoBtn");
  await espera(150);
  await page.evaluate(() => window.cerrarProdPreview());
  const cerrado = await page.evaluate(() => document.getElementById("ppVideo").getAttribute("src"));
  if (cerrado) fallas.push("D: cerrar el popup dejó el video con src (sigue bajando de fondo)");

  // A: producto sin video → sin botón.
  await page.evaluate(() => window.openProdPreview("p-2"));
  await espera(200);
  if (await visible()) fallas.push("A: el producto SIN video muestra el botón");

  // F: la × se ve.
  const cruz = await page.evaluate(() => getComputedStyle(document.querySelector("#prodPreviewModal .fotos-popup-close")).color);
  if (/rgb\(255,\s*255,\s*255\)/.test(cruz)) fallas.push("F: la × del popup sigue blanca sobre la tarjeta blanca");

  await browser.close();

  // Candado estático sobre el HTML: el <video> del popup sin autoplay.
  const html = require("fs").readFileSync(path.join(__dirname, "..", "mayorista.html"), "utf8");
  const tag = (html.match(/<video[^>]*id="ppVideo"[^>]*>/) || [""])[0];
  if (!tag) fallas.push("estático: no está el <video id=\"ppVideo\"> en mayorista.html");
  else if (/\bautoplay\b/.test(tag) || !/preload="none"/.test(tag))
    fallas.push("estático: el <video id=\"ppVideo\"> tiene autoplay o le falta preload=\"none\": " + tag);

  if (fallas.length) {
    console.error("popup-ver-video: FALLA\n - " + fallas.join("\n - "));
    process.exit(1);
  }
  console.log("popup-ver-video: OK — el botón aparece sólo con video, arriba a la derecha, y el video baja recién al tocarlo.");
})().catch((e) => {
  console.error("popup-ver-video: ERROR\n" + (e && e.stack ? e.stack : e));
  process.exit(1);
});
