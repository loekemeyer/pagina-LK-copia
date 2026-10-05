#!/usr/bin/env node
/**
 * tests/ficha-articulo.cjs — la página del artículo (productos/articulo/505.html)
 * con el diseño de Thomas del 05/10/2026.
 *
 * Abre la página generada en Chromium por HTTP local, con Supabase falso, y
 * verifica:
 *   A. SIN sesión: no hay botón de compra ni precio; queda el link de WhatsApp
 *   B. CON sesión de cliente: «Agregar al pedido» lleva a
 *      ../../mayorista.html#agregar=505 y el precio es el contado de la card:
 *      lista × (1 − dto_vol) × (1 − dto web) × 0,75
 *   C. SIN STOCK: el botón sale deshabilitado (no es un link)
 *   D. modo presupuesto: botón sí, precio no
 *   E. vendedor (cod 100XX): Precio Lista
 *   F. la columna izquierda (breadcrumb + foto) queda fija al scrollear
 *   G. estructura: COD en pastilla, h1, tabla en dos columnas, secciones
 *      desplegables abiertas (se indexan sin JS)
 *
 * Correr:  node tests/ficha-articulo.cjs
 */
const path = require("path");
const fs = require("fs");
const http = require("http");
let chromium;
try { ({ chromium } = require("/opt/node22/lib/node_modules/playwright")); }
catch (_e) {
  try { ({ chromium } = require("playwright")); }
  catch (_e2) { console.error("ficha-articulo: SALTEADO — no hay playwright"); process.exit(0); }
}

const RAIZ = path.join(__dirname, "..");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".jpg": "image/jpeg", ".webp": "image/webp", ".png": "image/png", ".svg": "image/svg+xml" };

async function abrir(browser, port, escenario, ancho = 1400) {
  const ctx = await browser.newContext({ viewport: { width: ancho, height: 900 } });
  const FOTO = path.join(RAIZ, "img", "no-image.jpg");
  await ctx.route("**/*", (r) => {
    const u = r.request().url();
    if (u.startsWith("http://127.0.0.1:" + port)) return r.continue();
    if (u.includes("supabase-js")) return r.fulfill({ status: 200, contentType: "text/javascript", body: "" });
    if (/\.(webp|jpe?g|png)(\?|$)/i.test(u)) return r.fulfill({ status: 200, contentType: "image/jpeg", path: FOTO });
    return r.fulfill({ status: 200, body: "" });
  });
  const page = await ctx.newPage();
  const errores = [];
  page.on("pageerror", (e) => errores.push(String(e)));
  await page.addInitScript((e) => {
    const tabla = {
      products: { data: { id: "p1", cod: "505", list_price: 1000, badge_status: e.badge || null, active: true } },
      customers: { data: e.cli ? [e.cli] : [] },
      admins: { data: null },
      app_settings: { data: { value: "0.02" } },
    };
    const fake = { createClient: () => ({
      auth: { getSession: () => Promise.resolve({ data: { session: e.sesion ? { user: { id: "u" } } : null } }) },
      from: (t) => { const q = { select: () => q, eq: () => q,
        limit: () => Promise.resolve(tabla[t]), maybeSingle: () => Promise.resolve(tabla[t]) }; return q; },
    }) };
    Object.defineProperty(window, "supabase", { value: fake, writable: false });
  }, escenario);
  await page.goto(`http://127.0.0.1:${port}/productos/articulo/505.html`);
  await page.waitForTimeout(600);
  const r = await page.evaluate(() => {
    const c = document.getElementById("artCompra");
    const a = c && c.querySelector(".art-agregar");
    return {
      html: c ? c.innerHTML : "",
      texto: c ? c.textContent.replace(/\s+/g, " ").trim() : "",
      agregarTag: a ? a.tagName : null,
      agregarHref: a ? a.getAttribute("href") : null,
      wa: !!(c && c.querySelector('a[href*="wa.me"], a[href*="whatsapp"]')),
    };
  });
  return { ctx, page, r, errores };
}

(async () => {
  const fallas = [];
  const srv = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url.split("?")[0]);
    const f = path.join(RAIZ, u);
    if (!f.startsWith(RAIZ) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(f)] || "application/octet-stream" });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  const browser = await chromium.launch();

  // A
  let x = await abrir(browser, port, { sesion: false });
  if (x.r.agregarTag) fallas.push("A: sin sesión aparece el botón de compra");
  if (/precio/i.test(x.r.texto)) fallas.push("A: sin sesión aparece un precio");
  if (!x.r.wa) fallas.push("A: sin sesión no quedó el link de WhatsApp");
  if (x.errores.length) fallas.push("A: errores de página: " + x.errores.join(" / "));

  // G (estructura, sobre la misma página)
  const g = await x.page.evaluate(() => ({
    cod: (document.querySelector(".art-cabecera .art-cod") || {}).textContent,
    h1: (document.querySelector(".art-datos h1") || {}).textContent,
    tablas: document.querySelectorAll(".art-tablas .art-tabla").length,
    tablaTxt: (document.querySelector(".art-tablas") || {}).textContent || "",
    donde: !!document.getElementById("donde-comprar") || /Dónde lo puedo comprar/.test(document.body.textContent),
    logos: document.querySelectorAll(".art-logos li a img").length,
    logosTxt: [...document.querySelectorAll(".art-logos li")].map((li) => li.textContent.trim()).join(""),
    secs: [...document.querySelectorAll("details.art-sec")].map((d) => d.open),
    izq: !!document.querySelector(".art-izq .prod-breadcrumb") && !!document.querySelector(".art-izq .art-foto"),
  }));
  if (g.cod !== "COD 505") fallas.push(`G: falta la pastilla COD 505 (${g.cod})`);
  if (!g.h1) fallas.push("G: falta el h1");
  // 05/10/2026 (Thomas): la tabla ya no repite código, línea, marca ni unidades por caja;
  // sin «¿Dónde lo puedo comprar?»; los comercios van sólo como logos.
  if (/Código:|Línea:|Marca:|Unidades por caja:/.test(g.tablaTxt)) fallas.push(`G: la tabla repite datos que ya están a la vista (${g.tablaTxt.trim()})`);
  if (!/Apto lavavajillas:\s*No/.test(g.tablaTxt)) fallas.push(`G: el 505 perdió «Apto lavavajillas: No» (${g.tablaTxt.trim()})`);
  if (g.donde) fallas.push("G: sigue la sección «¿Dónde lo puedo comprar?»");
  if (!g.logos || g.logosTxt) fallas.push(`G: «Comercios» no son sólo logos (${g.logos} logos, texto «${g.logosTxt}»)`);
  if (!g.secs.length || g.secs.some((o) => !o)) fallas.push("G: las secciones no están abiertas por defecto (no se indexarían)");
  if (!g.izq) fallas.push("G: breadcrumb y foto no están en la columna izquierda");

  // F
  const f = await x.page.evaluate(async () => {
    const izq = document.querySelector(".art-izq");
    scrollTo(0, 0); await new Promise((r) => setTimeout(r, 50));
    // Primero hasta donde la columna ya se pegó; después 150 px más (sin llegar al final del artículo).
    const y0 = izq.getBoundingClientRect().top + scrollY - 84 + 20;
    scrollTo(0, y0); await new Promise((r) => setTimeout(r, 80));
    const y1 = izq.getBoundingClientRect().top;
    scrollTo(0, y0 + 150); await new Promise((r) => setTimeout(r, 80));
    const y2 = izq.getBoundingClientRect().top;
    return { y1, y2, pos: getComputedStyle(izq).position };
  });
  if (f.pos !== "sticky" || Math.abs(f.y1 - f.y2) > 2) fallas.push(`F: la columna izquierda no queda fija (${f.pos}, ${f.y1}→${f.y2})`);
  await x.ctx.close();

  // B
  x = await abrir(browser, port, { sesion: true, cli: { cod_cliente: "588", dto_vol: 0.03 } });
  if (x.r.agregarTag !== "A" || x.r.agregarHref !== "../../mayorista.html#agregar=505")
    fallas.push(`B: con sesión el botón no lleva a mayorista#agregar=505 (${x.r.agregarTag} ${x.r.agregarHref})`);
  const esperado = Math.round(1000 * 0.97 * 0.98 * 0.75).toLocaleString("es-AR");
  if (!x.r.texto.includes("Tu Precio Contado: $" + esperado)) fallas.push(`B: precio mal (${x.r.texto}), esperaba $${esperado}`);
  await x.ctx.close();

  // C
  x = await abrir(browser, port, { sesion: true, cli: { cod_cliente: "588", dto_vol: 0 }, badge: "SIN STOCK" });
  if (x.r.agregarTag === "A") fallas.push("C: SIN STOCK y el botón sigue siendo un link");
  if (!/sin stock/i.test(x.r.texto)) fallas.push("C: SIN STOCK no se avisa");
  await x.ctx.close();

  // D
  x = await abrir(browser, port, { sesion: true, cli: { cod_cliente: "4284", dto_vol: 0, modo_presupuesto: true } });
  if (x.r.agregarTag !== "A") fallas.push("D: presupuesto sin botón");
  if (/precio/i.test(x.r.texto)) fallas.push("D: a un cliente en modo presupuesto se le muestra precio");
  await x.ctx.close();

  // E
  x = await abrir(browser, port, { sesion: true, cli: { cod_cliente: "10006", dto_vol: 0.1 } });
  if (!x.r.texto.includes("Precio Lista: $1.000")) fallas.push(`E: al vendedor no le sale Precio Lista (${x.r.texto})`);
  await x.ctx.close();

  await browser.close(); srv.close();
  if (fallas.length) { console.error("ficha-articulo: FALLA\n  " + fallas.join("\n  ")); process.exit(1); }
  console.log("ficha-articulo: OK");
})().catch((e) => { console.error("ficha-articulo: ERROR", e); process.exit(1); });
