#!/usr/bin/env node
/**
 * tests/ficha-tecnica-btn.cjs — botón «Ficha técnica» de la card del catálogo
 * mayorista y su popup (05/10/2026, Thomas).
 *
 * Levanta mayorista.html por HTTP local (el fetch de productos/fichas.json no
 * anda sobre file://) con Supabase falso y verifica:
 *   1. el artículo con ficha cargada (505) lleva el botón; el que no (999X), no
 *   2. tocar el botón abre el popup con nombre, destacado, lavavajillas y el
 *      link a la ficha pública — y NO abre el popup de foto de la card
 *   3. Escape lo cierra
 *   4. el popup sólo muestra lo que está en fichas.json: sin la fila Material
 *      si el 505 no tiene material cargado
 *   5. con fichas.json caído la card sale igual, sin botón y sin error
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
const FICHAS = JSON.parse(fs.readFileSync(path.join(RAIZ, "productos", "fichas.json"), "utf8"));
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

async function abrir(browser, port) {
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
  await page.goto(`http://127.0.0.1:${port}/mayorista.html`);
  await page.waitForFunction(() => typeof window.renderProducts === "function", null, { timeout: 15000 });
  await page.evaluate(async () => {
    const cont = document.getElementById("productsContainer");
    const sec = cont && cont.closest(".section");
    if (sec) { document.querySelectorAll(".section.active").forEach((s) => s.classList.remove("active"));
      sec.classList.add("active"); sec.style.display = "block"; }
    await window.loadProductsFromDB();
    window.renderProducts();
  });
  return { ctx, page, errores };
}

(async () => {
  const fallas = [];
  if (!FICHAS["505"]) fallas.push("0: productos/fichas.json no trae el 505 (correr scripts/generar-catalogo.py)");
  if (FICHAS["999X"]) fallas.push("0: el código de prueba 999X no puede tener ficha");
  const browser = await chromium.launch();

  const srv = servidor(false); await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const { ctx, page } = await abrir(browser, srv.address().port);
  await page.waitForSelector("#card-p-1 .ft-btn", { timeout: 8000 })
    .catch(() => fallas.push("1: el 505 (con ficha cargada) no muestra el botón Ficha técnica"));
  if (await page.$("#card-p-2 .ft-btn")) fallas.push("1: un artículo SIN ficha muestra el botón");

  if (await page.$("#card-p-1 .ft-btn")) {
    await page.click("#card-p-1 .ft-btn");
    const r = await page.evaluate(() => {
      const m = document.getElementById("fichaTecModal");
      const pp = document.getElementById("prodPreviewModal");
      return {
        abierto: !!m && m.classList.contains("open") && getComputedStyle(m).display !== "none",
        titulo: m && (m.querySelector(".ft-titulo") || {}).textContent,
        dst: m && !!m.querySelector(".ft-dst"),
        filas: m ? [...m.querySelectorAll(".ft-tabla th")].map((t) => t.textContent) : [],
        lv: m ? [...m.querySelectorAll(".ft-tabla tr")].map((t) => t.textContent).join("|") : "",
        link: m && (m.querySelector(".ft-link") || {}).getAttribute && m.querySelector(".ft-link").getAttribute("href"),
        fotoAbierta: !!pp && pp.classList.contains("open"),
      };
    });
    const f = FICHAS["505"] || {};
    if (!r.abierto) fallas.push("2: tocar el botón no abre el popup");
    if (r.titulo !== f.n) fallas.push(`2: el popup no muestra el nombre (${r.titulo})`);
    if (!!f.dst !== r.dst) fallas.push("2: el destacado no coincide con fichas.json");
    if (f.lv && !r.lv.includes("Apto lavavajillas" + f.lv)) fallas.push("2: falta la fila Apto lavavajillas");
    if (r.link !== "productos/articulo/505.html") fallas.push(`2: el link a la ficha está mal (${r.link})`);
    if (r.fotoAbierta) fallas.push("2: el botón también abrió el popup de la foto");
    if (!f.m && r.filas.includes("Material")) fallas.push("4: muestra Material sin que esté cargado");
    await page.screenshot({ path: process.env.FT_SHOT || "/dev/null" }).catch(() => {});
    await page.keyboard.press("Escape");
    const cerrado = await page.evaluate(() => !document.getElementById("fichaTecModal").classList.contains("open"));
    if (!cerrado) fallas.push("3: Escape no cierra el popup");
  }
  await ctx.close(); srv.close();

  const srv2 = servidor(true); await new Promise((r) => srv2.listen(0, "127.0.0.1", r));
  const b = await abrir(browser, srv2.address().port);
  await b.page.waitForSelector("#card-p-1", { timeout: 8000 }).catch(() => fallas.push("5: con fichas.json caído no se dibuja la card"));
  await b.page.waitForTimeout(500);
  if (await b.page.$(".ft-btn")) fallas.push("5: con fichas.json caído aparece un botón");
  if (b.errores.length) fallas.push("5: errores de página con fichas.json caído: " + b.errores.join(" / "));
  await b.ctx.close(); srv2.close();

  await browser.close();
  if (fallas.length) { console.error("ficha-tecnica-btn: FALLA\n  " + fallas.join("\n  ")); process.exit(1); }
  console.log("ficha-tecnica-btn: OK");
})().catch((e) => { console.error("ficha-tecnica-btn: ERROR", e); process.exit(1); });
