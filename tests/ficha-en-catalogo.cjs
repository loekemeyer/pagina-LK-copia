#!/usr/bin/env node
/**
 * tests/ficha-en-catalogo.cjs — la ficha del artículo ADENTRO de mayorista.html
 * (Thomas, 05/10/2026: "el header no tiene que cambiar… si quiero volver atrás
 * no tengo que perder nada de lo cargado").
 *
 * Con un carrito ya armado (999X × 3) verifica:
 *   1. «Ficha técnica» de la card NO sale de mayorista.html: muestra la sección
 *      #fichaArticulo con la .art-ficha de la página pública, el header sigue
 *      ahí y la URL pasa a #ficha=505
 *   2. con sesión, «Agregar al pedido» suma el 505 SIN tocar lo que había
 *      (999X × 3 sigue en memoria y en localStorage); "+" suma otra caja
 *   3. un artículo relacionado se abre en la misma sección (#ficha=513)
 *   4. «atrás» vuelve a la ficha anterior y otra vez «atrás» al catálogo, en el
 *      mismo scroll y con el carrito intacto
 *   5. sin sesión, la ficha ofrece «Iniciar sesión», no «Agregar al pedido»
 *
 *   6. es un popup blanco encima del catálogo; la X y Escape lo cierran
 *
 * Correr:  node tests/ficha-en-catalogo.cjs
 */
const path = require("path");
const fs = require("fs");
const http = require("http");
let chromium;
try { ({ chromium } = require("/opt/node22/lib/node_modules/playwright")); }
catch (_e) {
  try { ({ chromium } = require("playwright")); }
  catch (_e2) { console.error("ficha-en-catalogo: SALTEADO — no hay playwright"); process.exit(0); }
}

const RAIZ = path.join(__dirname, "..");
const PRODS = [
  { id: "p-1", cod: "505", category: "Peladores", subcategory: null, ranking: 1,
    orden_catalogo: 1, description: "Pelador de prueba", uxb: 12, list_price: 1000, images: ["505.webp"], badge_status: null },
  { id: "p-2", cod: "999X", category: "Peladores", subcategory: null, ranking: 2,
    orden_catalogo: 2, description: "Otro artículo", uxb: 12, list_price: 500, images: ["999X.webp"], badge_status: null },
];
for (let i = 3; i < 40; i++) PRODS.push({ id: "p-" + i, cod: "Z" + i, category: "Peladores", subcategory: null,
  ranking: i, orden_catalogo: i, description: "Relleno " + i, uxb: 6, list_price: 100, images: [], badge_status: null });
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".jpg": "image/jpeg", ".webp": "image/webp", ".png": "image/png", ".svg": "image/svg+xml" };

(async () => {
  const fallas = [];
  const srv = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url.split("?")[0]);
    const f = path.join(RAIZ, u === "/" ? "mayorista.html" : u);
    if (!f.startsWith(RAIZ) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(f)] || "application/octet-stream" });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 800 } });
  const FOTO = path.join(RAIZ, "img", "no-image.jpg");
  await ctx.route("**/*", (r) => {
    const u = r.request().url();
    if (u.startsWith("http://127.0.0.1:" + port)) return r.continue();
    if (/\.(webp|jpe?g|png)(\?|$)/i.test(u)) return r.fulfill({ status: 200, contentType: "image/jpeg", path: FOTO });
    return r.fulfill({ status: 200, body: "" });
  });
  const page = await ctx.newPage();
  const errores = [];
  page.on("pageerror", (e) => errores.push(String(e)));
  page.on("dialog", (d) => d.dismiss().catch(() => {}));
  await page.addInitScript((prods) => {
    try { localStorage.setItem("lk_mayorista_cart_v1", JSON.stringify([{ productId: "p-2", qtyCajas: 3, source: "catalogo" }])); } catch (e) {}
    const vacio = { data: [], error: null };
    const q = { select: () => q, eq: () => q, in: () => q, order: () => q, limit: () => q, gte: () => q, lte: () => q,
      neq: () => q, or: () => q, ilike: () => q, range: () => q,
      single: () => Promise.resolve({ data: null, error: null }), maybeSingle: () => Promise.resolve({ data: null, error: null }),
      insert: () => q, update: () => q, upsert: () => q, delete: () => q,
      then: (f) => Promise.resolve(vacio).then(f) };
    window.supabase = { createClient: () => ({ from: () => q,
      rpc: (n) => Promise.resolve(n === "get_products_public_sorted" ? { data: prods, error: null } : vacio),
      auth: { getSession: () => Promise.resolve({ data: { session: null } }), onAuthStateChange: () => {} },
      storage: { from: () => ({ getPublicUrl: () => ({ data: { publicUrl: "" } }) }) } }) };
  }, PRODS);
  await page.goto(`http://127.0.0.1:${port}/mayorista.html`);
  await page.waitForFunction(() => typeof window.renderProducts === "function", null, { timeout: 15000 });
  await page.evaluate(async () => {
    const cont = document.getElementById("productsContainer");
    const sec = cont && cont.closest(".section");
    if (sec) { document.querySelectorAll(".section.active").forEach((s) => s.classList.remove("active")); sec.classList.add("active"); }
    await window.loadProductsFromDB();
    window.renderProducts();
  });
  await page.waitForSelector("#card-p-1 .ft-btn", { timeout: 8000 }).catch(() => fallas.push("0: no aparece el botón Ficha técnica del 505"));

  // 1
  await page.evaluate(() => window.scrollTo(0, 300));
  const y0 = await page.evaluate(() => window.scrollY);
  const url0 = page.url();
  await page.click("#card-p-1 .ft-btn");
  await page.waitForSelector("#fichaArticulo:not([hidden]) .art-ficha", { timeout: 8000 }).catch(() => fallas.push("1: la ficha no se abrió adentro del catálogo"));
  const r1 = await page.evaluate(() => ({
    path: location.pathname, hash: location.hash,
    header: !!document.querySelector(".header") && getComputedStyle(document.querySelector(".header")).display !== "none",
    h1: (document.querySelector("#fichaArticulo .art-datos h1") || {}).textContent,
    prodVisible: document.getElementById("productos").classList.contains("active"),
    y: window.scrollY,
    fondoBlanco: getComputedStyle(document.getElementById("fichaModalCaja")).backgroundColor,
    fixed: getComputedStyle(document.getElementById("fichaArticulo")).position,
    compra: (document.querySelector("#fichaArticulo #artCompra") || {}).textContent,
  }));
  if (!/mayorista\.html$/.test(r1.path)) fallas.push(`1: salió de mayorista.html (${r1.path})`);
  if (r1.hash !== "#ficha=505") fallas.push(`1: la URL no quedó en #ficha=505 (${r1.hash})`);
  if (!r1.header) fallas.push("1: desapareció el header de mayorista");
  if (!r1.h1) fallas.push("1: la ficha no trae el título");
  if (!r1.prodVisible) fallas.push("1: el catálogo dejó de estar activo debajo del popup");
  if (r1.fixed !== "fixed") fallas.push(`1: la ficha no es un popup (position ${r1.fixed})`);
  if (r1.fondoBlanco !== "rgb(255, 255, 255)") fallas.push(`1: el popup no es blanco (${r1.fondoBlanco})`);
  if (Math.abs(r1.y - y0) > 5) fallas.push(`1: abrir el popup movió el catálogo (${y0} → ${r1.y})`);
  if (!/iniciar sesi/i.test(r1.compra || "")) fallas.push(`5: sin sesión la ficha no ofrece iniciar sesión (${r1.compra})`);

  // 2 — con sesión
  const r2 = await page.evaluate(async () => {
    currentSession = { user: { id: "u-test" } };
    customerProfile = { id: "c1", cod_cliente: "588", dto_vol: 0, business_name: "Prueba" };
    _fichaPintarCompra();
    const b = document.querySelector("#fichaArticulo #artCompra .art-agregar-cat");
    const txt = b ? b.textContent.trim() : null;
    if (b) b.click();
    await new Promise((r) => setTimeout(r, 300));
    const mas = document.querySelector("#fichaArticulo .art-qty-btn[aria-label='Una caja más']");
    if (mas) mas.click();
    await new Promise((r) => setTimeout(r, 300));
    return {
      txt,
      cart: cart.map((i) => i.productId + "x" + i.qtyCajas).sort().join(","),
      ls: JSON.parse(localStorage.getItem("lk_mayorista_cart_v1") || "[]").map((i) => i.productId + "x" + i.qtyCajas).sort().join(","),
      compra: document.querySelector("#fichaArticulo #artCompra").textContent.replace(/\s+/g, " ").trim(),
    };
  });
  if (r2.txt !== "Agregar al pedido") fallas.push(`2: con sesión no aparece «Agregar al pedido» (${r2.txt})`);
  if (r2.cart !== "p-1x2,p-2x3") fallas.push(`2: el carrito en memoria quedó mal (${r2.cart}); esperaba p-1x2,p-2x3`);
  if (r2.ls !== "p-1x2,p-2x3") fallas.push(`2: el carrito guardado quedó mal (${r2.ls})`);
  if (!/En tu pedido: 2 cajas/.test(r2.compra)) fallas.push(`2: la ficha no muestra lo que hay en el pedido (${r2.compra})`);

  // 3 — relacionado
  const rel = await page.$("#fichaArticulo .art-rel-grid a[href*='/articulo/513.html']");
  if (!rel) fallas.push("3: no está el link al 513 en «Otros artículos»");
  else {
    await rel.click();
    await page.waitForFunction(() => location.hash === "#ficha=513" && /513/.test((document.querySelector("#fichaArticulo .art-cod") || {}).textContent || ""), null, { timeout: 8000 })
      .catch(() => fallas.push("3: el relacionado no se abrió en la misma sección"));
    if (!/mayorista\.html$/.test(new URL(page.url()).pathname)) fallas.push("3: el relacionado salió de mayorista.html");
  }

  // 4 — atrás, atrás
  await page.goBack();
  await page.waitForFunction(() => location.hash === "#ficha=505", null, { timeout: 5000 }).catch(() => fallas.push("4: «atrás» no volvió a la ficha del 505"));
  await page.goBack();
  await page.waitForFunction(() => document.getElementById("fichaArticulo").hidden && document.getElementById("productos").classList.contains("active"), null, { timeout: 5000 })
    .catch(() => fallas.push("4: el segundo «atrás» no cerró el popup"));
  await page.waitForTimeout(200);
  const r4 = await page.evaluate(() => ({
    y: window.scrollY, hash: location.hash, path: location.pathname,
    cart: cart.map((i) => i.productId + "x" + i.qtyCajas).sort().join(","),
  }));
  if (!/mayorista\.html$/.test(r4.path)) fallas.push("4: «atrás» salió de mayorista.html");
  if (Math.abs(r4.y - y0) > 5) fallas.push(`4: el catálogo no volvió al mismo scroll (${y0} → ${r4.y})`);
  if (r4.cart !== "p-1x2,p-2x3") fallas.push(`4: al volver se perdió algo del carrito (${r4.cart})`);
  if (r4.hash) fallas.push(`4: quedó el hash ${r4.hash}`);
  // 6 — la X y Escape cierran el popup sin salir de mayorista
  await page.click("#card-p-1 .ft-btn");
  await page.waitForSelector("#fichaArticulo:not([hidden])", { timeout: 8000 }).catch(() => fallas.push("6: no reabrió"));
  await page.click("#fichaArticulo .ficha-modal-x");
  await page.waitForFunction(() => document.getElementById("fichaArticulo").hidden && !location.hash, null, { timeout: 5000 })
    .catch(() => fallas.push("6: la X no cerró el popup"));
  await page.click("#card-p-1 .ft-btn");
  await page.waitForSelector("#fichaArticulo:not([hidden])", { timeout: 8000 }).catch(() => {});
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.getElementById("fichaArticulo").hidden, null, { timeout: 5000 })
    .catch(() => fallas.push("6: Escape no cerró el popup"));
  if (!/mayorista\.html$/.test(new URL(page.url()).pathname)) fallas.push("6: cerrar salió de mayorista.html");
  if (errores.length) fallas.push("errores de página: " + errores.join(" / "));

  await browser.close(); srv.close();
  if (fallas.length) { console.error("ficha-en-catalogo: FALLA\n  " + fallas.join("\n  ")); process.exit(1); }
  console.log("ficha-en-catalogo: OK");
})().catch((e) => { console.error("ficha-en-catalogo: ERROR", e); process.exit(1); });
