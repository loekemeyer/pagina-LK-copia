#!/usr/bin/env node
/**
 * tests/ficha-tecnica-btn.cjs — botón «Ficha técnica» de la card del catálogo
 * mayorista y su popup (05/10/2026, Thomas).
 *
 * Levanta mayorista.html por HTTP local (el fetch de productos/fichas.json no
 * anda sobre file://) con Supabase falso y verifica:
 *   1. el artículo con ficha cargada (505) lleva el botón; el que no (999X), no
 *   2. tocar el botón abre el popup con la ficha COMPLETA (nombre, destacado,
 *      tabla con lavavajillas, dónde comprar, la línea) sin link a otra página,
 *      y NO abre el popup de foto de la card
 *   3. Escape lo cierra
 *   4. el popup sólo muestra lo que está en fichas.json: sin la fila Material
 *      si el 505 no tiene material cargado
 *   5. con fichas.json caído la card sale igual, sin botón y sin error
 *   6. «Agregar al pedido» SÓLO con sesión: sin sesión no hay botón de compra
 *      en el popup; con sesión aparece y llama a addFirstBox del producto
 *   7. la foto queda fija mientras la ficha scrollea (en pantalla de compu)
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
      const q = (sel) => (m ? m.querySelector(sel) : null);
      return {
        abierto: !!m && m.classList.contains("open") && getComputedStyle(m).display !== "none",
        titulo: (q(".ft-titulo") || {}).textContent,
        dst: !!q(".ft-dst"),
        filas: m ? [...m.querySelectorAll(".ft-tabla dt")].map((t) => t.textContent) : [],
        tabla: (q(".ft-tabla") || {}).textContent || "",
        texto: m ? m.textContent : "",
        linkInterno: m ? [...m.querySelectorAll("a")].some((a) => /articulo\/|donde-comprar/.test(a.getAttribute("href") || "")) : null,
        ml: !!q(".ft-ml"),
        compra: !!q(".ft-acciones .add-btn"),
        fotoAbierta: !!pp && pp.classList.contains("open"),
      };
    });
    const f = FICHAS["505"] || {};
    if (!r.abierto) fallas.push("2: tocar el botón no abre el popup");
    if (r.titulo !== f.n) fallas.push(`2: el popup no muestra el nombre (${r.titulo})`);
    if (!!f.dst !== r.dst) fallas.push("2: el destacado no coincide con fichas.json");
    if (f.lv && !r.tabla.includes("Apto lavavajillas" + f.lv)) fallas.push("2: falta la fila Apto lavavajillas");
    if (f.lin && !r.tabla.includes("Línea" + f.lin)) fallas.push("2: falta la fila Línea");
    if (!r.texto.includes("Dónde comprar") || !r.ml) fallas.push("2: falta el bloque Dónde comprar / Mercado Libre");
    if (f.lin && !r.texto.includes("Sobre la línea")) fallas.push("2: falta el texto de la línea");
    if (r.linkInterno) fallas.push("2: el popup linkea a otra página del sitio (no tiene que abrir una página nueva)");
    if (r.fotoAbierta) fallas.push("2: el botón también abrió el popup de la foto");
    if (!f.m && r.filas.includes("Material")) fallas.push("4: muestra Material sin que esté cargado");
    if (r.compra) fallas.push("6: SIN sesión el popup muestra un botón de compra");

    // 7. foto fija: se scrollea la card y la foto no se mueve
    const st = await page.evaluate(() => {
      const card = document.querySelector("#fichaTecModal .ft-card");
      const foto = document.querySelector("#fichaTecModal .ft-foto");
      const y0 = foto.getBoundingClientRect().top;
      card.scrollTop = card.scrollHeight;
      const y1 = foto.getBoundingClientRect().top;
      const scrolleo = card.scrollTop > 0;
      card.scrollTop = 0;
      return { y0, y1, scrolleo };
    });
    if (st.scrolleo && Math.abs(st.y1 - st.y0) > 30)
      fallas.push(`7: la foto se movió al scrollear la ficha (${st.y0.toFixed(0)} → ${st.y1.toFixed(0)})`);
    await page.screenshot({ path: process.env.FT_SHOT || "/dev/null" }).catch(() => {});
    await page.keyboard.press("Escape");
    const cerrado = await page.evaluate(() => !document.getElementById("fichaTecModal").classList.contains("open"));
    if (!cerrado) fallas.push("3: Escape no cierra el popup");

    // 6. con sesión: aparece «Agregar al pedido» y apunta al producto
    const conSesion = await page.evaluate(() => {
      currentSession = { user: { id: "u-test" } };
      let llamado = null;
      const orig = window.addFirstBox;
      window.addFirstBox = (pid, origen) => { llamado = [pid, origen]; };
      window.abrirFichaTec("505");
      const b = document.querySelector("#fichaTecModal .ft-acciones .add-btn");
      const txt = b ? b.textContent.trim() : null;
      if (b) b.click();
      const abierto = document.getElementById("fichaTecModal").classList.contains("open");
      window.addFirstBox = orig;
      currentSession = null;
      return { txt, llamado, abierto };
    });
    if (conSesion.txt !== "Agregar al pedido") fallas.push(`6: CON sesión no aparece «Agregar al pedido» (${conSesion.txt})`);
    else {
      if (!conSesion.llamado || conSesion.llamado[0] !== "p-1") fallas.push("6: el botón no agrega el producto correcto");
      if (conSesion.abierto) fallas.push("6: después de agregar el popup sigue abierto");
    }
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
