#!/usr/bin/env node
/**
 * tests/ficha-tecnica-btn.cjs — botón «Ficha técnica» de la card del catálogo
 * mayorista (05/10/2026, Thomas) y la vuelta desde la ficha con #agregar=<cod>.
 *
 * Levanta mayorista.html por HTTP local (el fetch de productos/fichas.json no
 * anda sobre file://) con Supabase falso y verifica:
 *   1. el artículo con ficha cargada (505) lleva el botón; el que no (999X), no
 *   2. el botón tiene href a productos/articulo/505.html (abrirlo en otra
 *      pestaña da la página pública) y no hay popup
 *   3. con fichas.json caído la card sale igual, sin botón y sin error
 *   4. mayorista.html#agregar=505 (lo usa la ficha pública) agrega UNA caja del
 *      505 por addFirstBox (origen 'catalogo'), deja al cliente parado en la
 *      ficha adentro del catálogo (#ficha=505) y saca el #agregar para que
 *      recargar no vuelva a sumar
 *
 * Correr:  node tests/ficha-tecnica-btn.cjs
 */
const path = require("path");
const fs = require("fs");
const http = require("http");
let chromium;
try { ({ chromium } = require("/opt/node22/lib/node_modules/playwright")); }
catch (_e) {
  try { ({ chromium } = require("playwright")); }
  catch (_e2) { console.error("ficha-tecnica-btn: SALTEADO — no hay playwright"); process.exit(0); }
}

const RAIZ = path.join(__dirname, "..");
const FICHAS = JSON.parse(fs.readFileSync(path.join(RAIZ, "productos", "fichas.json"), "utf8")).fichas || {};
const PRODS = [
  { id: "p-1", cod: "505", category: "Peladores", subcategory: null, ranking: 1,
    orden_catalogo: 1, description: "Pelador de prueba", uxb: 12, images: ["505.webp"], badge_status: null },
  { id: "p-2", cod: "999X", category: "Peladores", subcategory: null, ranking: 2,
    orden_catalogo: 2, description: "Sin ficha", uxb: 12, images: ["999X.webp"], badge_status: null },
];
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".jpg": "image/jpeg", ".webp": "image/webp", ".png": "image/png", ".svg": "image/svg+xml" };

function servidor(fichasCaido) {
  return http.createServer((req, res) => {
    const u = decodeURIComponent(req.url.split("?")[0]);
    if (fichasCaido && u.endsWith("/fichas.json")) { res.writeHead(500); return res.end(); }
    const f = path.join(RAIZ, u === "/" ? "mayorista.html" : u);
    if (!f.startsWith(RAIZ) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(f)] || "application/octet-stream" });
    fs.createReadStream(f).pipe(res);
  });
}

async function abrir(browser, port, hash = "") {
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 } });
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
    const vacio = { data: [], error: null };
    const q = { select: () => q, eq: () => q, in: () => q, order: () => q, limit: () => q,
      single: () => Promise.resolve({ data: null, error: null }), insert: () => q, update: () => q, upsert: () => q,
      then: (f) => Promise.resolve(vacio).then(f) };
    window.supabase = { createClient: () => ({ from: () => q,
      rpc: (n) => Promise.resolve(n === "get_products_public_sorted" ? { data: prods, error: null } : vacio),
      auth: { getSession: () => Promise.resolve({ data: { session: null } }), onAuthStateChange: () => {} },
      storage: { from: () => ({ getPublicUrl: () => ({ data: { publicUrl: "" } }) }) } }) };
  }, PRODS);
  await page.goto(`http://127.0.0.1:${port}/mayorista.html${hash}`);
  await page.waitForFunction(() => typeof window.renderProducts === "function", null, { timeout: 15000 });
  return { ctx, page, errores };
}

async function mostrarCatalogo(page) {
  await page.evaluate(async () => {
    const cont = document.getElementById("productsContainer");
    const sec = cont && cont.closest(".section");
    if (sec) { document.querySelectorAll(".section.active").forEach((s) => s.classList.remove("active"));
      sec.classList.add("active"); sec.style.display = "block"; }
    await window.loadProductsFromDB();
    window.renderProducts();
  });
}

(async () => {
  const fallas = [];
  if (!FICHAS["505"]) fallas.push("0: productos/fichas.json no trae el 505 (correr scripts/generar-catalogo.py)");
  if (FICHAS["999X"]) fallas.push("0: el código de prueba 999X no puede tener ficha");
  const browser = await chromium.launch();

  // 1-2
  const srv = servidor(false); await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  let a = await abrir(browser, port);
  await mostrarCatalogo(a.page);
  await a.page.waitForSelector("#card-p-1 .ft-btn", { timeout: 8000 })
    .catch(() => fallas.push("1: el 505 (con ficha cargada) no muestra el botón Ficha técnica"));
  if (await a.page.$("#card-p-2 .ft-btn")) fallas.push("1: un artículo SIN ficha muestra el botón");
  const btn = await a.page.evaluate(() => {
    const b = document.querySelector("#card-p-1 .ft-btn");
    return b ? { tag: b.tagName, href: b.getAttribute("href"), onclick: b.getAttribute("onclick") } : null;
  });
  if (btn) {
    if (btn.tag !== "A" || btn.href !== "productos/articulo/505.html")
      fallas.push(`2: el botón no es un link a la página del artículo (${btn.tag} ${btn.href})`);
  }
  if (await a.page.$("#fichaTecModal")) fallas.push("2: quedó el popup de ficha técnica en el DOM");
  await a.ctx.close();

  // 4. #agregar=505
  a = await abrir(browser, port, "#agregar=505");
  await a.page.evaluate(() => {
    window.__agregado = null;
    window.addFirstBox = (pid, origen) => { window.__agregado = [pid, origen]; };
  });
  await mostrarCatalogo(a.page);
  await a.page.waitForFunction(() => !!window.__agregado, null, { timeout: 9000 })
    .catch(() => fallas.push("4: #agregar=505 no llamó a addFirstBox"));
  const ag = await a.page.evaluate(() => ({ ag: window.__agregado, hash: location.hash }));
  if (ag.ag && (ag.ag[0] !== "p-1" || ag.ag[1] !== "catalogo"))
    fallas.push(`4: agregó otra cosa (${JSON.stringify(ag.ag)})`);
  if (/agregar/.test(ag.hash)) fallas.push(`4: el #agregar quedó en la URL (${ag.hash}): recargar volvería a sumar`);
  if (ag.hash !== "#ficha=505") fallas.push(`4: no quedó parado en la ficha del 505 (${ag.hash})`);
  await a.ctx.close(); srv.close();

  // 3
  const srv2 = servidor(true); await new Promise((r) => srv2.listen(0, "127.0.0.1", r));
  const b = await abrir(browser, srv2.address().port);
  await mostrarCatalogo(b.page);
  await b.page.waitForSelector("#card-p-1", { timeout: 8000 }).catch(() => fallas.push("3: con fichas.json caído no se dibuja la card"));
  await b.page.waitForTimeout(500);
  if (await b.page.$(".ft-btn")) fallas.push("3: con fichas.json caído aparece un botón");
  if (b.errores.length) fallas.push("3: errores de página con fichas.json caído: " + b.errores.join(" / "));
  await b.ctx.close(); srv2.close();

  await browser.close();
  if (fallas.length) { console.error("ficha-tecnica-btn: FALLA\n  " + fallas.join("\n  ")); process.exit(1); }
  console.log("ficha-tecnica-btn: OK");
})().catch((e) => { console.error("ficha-tecnica-btn: ERROR", e); process.exit(1); });
