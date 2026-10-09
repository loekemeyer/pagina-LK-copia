#!/usr/bin/env node
/**
 * tests/ean-descarga.cjs — el botón «EAN» que baja el código de barras de cada producto.
 *
 * POR QUÉ EXISTE (09/10/2026). Pedido: SÓLO en Vercel, bajar el EAN de cada producto como
 * imagen. Desde la v2.3.560 es un ícono de código de barras en cada tarjeta, debajo del «1/2»
 * de las fotos, que al pasar el mouse dice «Descargar EAN». Verifica:
 *   A. fuera de *.vercel.app el ícono NO se arma (loekemeyer.com no lo ve).
 *   B. la lista con todos (abrir(), sin puerta hoy) sigue armándose.
 *   C. el PNG dibujado se LEE: se escanean las barras del canvas y se decodifican con un
 *      lector propio del test → tiene que dar el mismo EAN. Prueba el dibujo, no el código.
 *   D. un EAN con el verificador mal NO tiene botón PNG y en el ZIP va a AVISOS.txt.
 *   E. si la tabla no se puede leer, lo dice (no muestra "0 códigos").
 *
 * Correr:  node tests/ean-descarga.cjs
 */
const fs = require("fs");
const path = require("path");
let chromium;
try { ({ chromium } = require("/opt/node22/lib/node_modules/playwright")); }
catch (_e) {
  try { ({ chromium } = require("playwright")); }
  catch (_e2) { console.error("ean-descarga: SALTEADO — no hay playwright"); process.exit(0); }
}

const JS = fs.readFileSync(path.join(__dirname, "..", "ean-descarga.js"), "utf8");
const EANS = [
  { cod: "026", ean: "7795587000262" },
  { cod: "505", ean: "7795587005052" },
  { cod: "323", ean: "7795587003232" },
  { cod: "323E", ean: "7795587003232" }, // mismo EAN que el 323 (caso real)
  { cod: "999", ean: "7795587009992" },  // verificador mal (debería ser 7)
];

const PRODS = [
  { id: "p-1", cod: "026", category: "Coladores", subcategory: null, ranking: 1, orden_catalogo: 1,
    description: "Colador 8 cm", uxb: 36, images: ["026.webp", "026-2.webp"], badge_status: null, list_price: 1000 },
  { id: "p-2", cod: "505", category: "Peladores", subcategory: null, ranking: 2, orden_catalogo: 2,
    description: "Pelador", uxb: 12, images: ["505.webp"], badge_status: null, list_price: 1000 },
];

function harness(forzar, falla) {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>
<script>
${forzar ? "window.GV_EAN_FORZAR = true;" : ""}
const supabaseClient = { from(t) { const q = {
  select(){return q;}, order(){return q;}, limit(){
    if (t === "item_ean") return Promise.resolve(${falla ? '{data:null,error:{message:"timeout"}}' : `{data:${JSON.stringify(EANS)},error:null}`});
    if (t === "products") return Promise.resolve({data:[{cod:"026",description:"Colador 8 cm"},{cod:"505",description:"Pelador"}],error:null});
    return Promise.resolve({data:[],error:null}); } }; return q; } };
window.__zip = {};
window.JSZip = function(){ this.file = (n,b)=>{ window.__zip[n]=b; }; this.generateAsync = ()=>Promise.resolve(new Blob(["z"])); };
</script>
<script>${JS}</script></body></html>`;
}

// Lector EAN-13 independiente: módulos (95) → dígitos.
function decodificar(m) {
  const L = ["0001101","0011001","0010011","0111101","0100011","0110001","0101111","0111011","0110111","0001011"];
  const G = L.map((s) => s.split("").map((c) => (c === "1" ? "0" : "1")).reverse().join(""));
  const R = L.map((s) => s.split("").map((c) => (c === "1" ? "0" : "1")).join(""));
  const PAR = ["LLLLLL","LLGLGG","LLGGLG","LLGGGL","LGLLGG","LGGLLG","LGGGLL","LGLGLG","LGLGGL","LGGLGL"];
  if (m.length !== 95 || m.slice(0,3) !== "101" || m.slice(45,50) !== "01010" || m.slice(92) !== "101") return null;
  let izq = "", par = "";
  for (let i = 0; i < 6; i++) {
    const s = m.substr(3 + i * 7, 7);
    if (L.includes(s)) { izq += L.indexOf(s); par += "L"; }
    else if (G.includes(s)) { izq += G.indexOf(s); par += "G"; }
    else return null;
  }
  let der = "";
  for (let i = 0; i < 6; i++) { const s = m.substr(50 + i * 7, 7); if (!R.includes(s)) return null; der += R.indexOf(s); }
  const d0 = PAR.indexOf(par);
  return d0 < 0 ? null : d0 + izq + der;
}

(async () => {
  const fallas = [];
  const ok = (c, msg) => { if (!c) fallas.push(msg); console.log((c ? "  ✓ " : "  ✗ ") + msg); };
  const browser = await chromium.launch();
  try {
    // A
    let page = await browser.newPage();
    await page.setContent(harness(false));
    ok((await page.evaluate(() => eanDescarga.btnHtml("026"))) === "", "A. sin Vercel no hay ícono");
    await page.close();

    // B
    page = await browser.newPage();
    await page.setContent(harness(true));
    ok(!(await page.$("#eanDescBtn")), "B. ya no hay botón flotante");
    await page.evaluate(() => eanDescarga.abrir());
    await page.waitForSelector(".ean-row");
    const filas = await page.$$eval(".ean-row", (r) => r.length);
    ok(filas === 5, "B. la lista trae los 5 códigos (" + filas + ")");

    // C — dibujar y leer las barras de verdad
    for (const e of [EANS[0], EANS[1]]) {
      const mods = await page.evaluate((it) => {
        // Se usa el mismo dibujo que baja el botón: se intercepta el canvas.
        const orig = HTMLCanvasElement.prototype.toBlob; let cv = null;
        HTMLCanvasElement.prototype.toBlob = function (cb) { cv = this; cb(new Blob(["x"])); };
        const btn = [...document.querySelectorAll(".ean-row")].find((r) => r.querySelector(".c").textContent === it.cod).querySelector("button");
        btn.click();
        return new Promise((res) => setTimeout(() => {
          HTMLCanvasElement.prototype.toBlob = orig;
          const x = cv.getContext("2d"), W = cv.width;
          const y = 58 + 10; // dentro de las barras
          const px = x.getImageData(0, y, W, 1).data;
          let bits = ""; for (let i = 0; i < W; i++) bits += px[i * 4] < 128 ? "1" : "0";
          const a = bits.indexOf("1"), b = bits.lastIndexOf("1");
          const mod = (b - a + 1) / 95; let m = "";
          for (let k = 0; k < 95; k++) m += bits[Math.floor(a + k * mod + mod / 2)];
          res(m);
        }, 50));
      }, e);
      const leido = decodificar(mods);
      ok(leido === e.ean, "C. la imagen de " + e.cod + " se lee como " + e.ean + " (leído: " + leido + ")");
    }

    // D
    const sinPng = await page.$$eval(".ean-row", (rs) => rs.filter((r) => r.querySelector(".c").textContent === "999").map((r) => !!r.querySelector("button")));
    ok(sinPng.length === 1 && sinPng[0] === false, "D. el 999 (verificador mal) no tiene PNG (" + JSON.stringify(sinPng) + ")");
    await page.click(".ean-zip");
    await page.waitForFunction(() => /imágenes bajadas/.test(document.querySelector(".ean-msg").textContent));
    const zip = await page.evaluate(async () => {
      const a = String(window.__zip["AVISOS.txt"] || "");
      return { files: Object.keys(window.__zip), avisos: a };
    });
    ok(zip.files.filter((f) => f.endsWith(".png")).length === 4, "D. el ZIP lleva 4 PNG (" + zip.files.join(", ") + ")");
    ok(/999 .*verificador mal/.test(zip.avisos) && /323E .*mismo EAN que 323/.test(zip.avisos), "D. AVISOS.txt nombra el verificador mal y el EAN repetido");
    await page.close();

    // E
    page = await browser.newPage();
    await page.setContent(harness(true, true));
    await page.evaluate(() => eanDescarga.abrir());
    await page.waitForFunction(() => /No se pudieron leer/.test(document.querySelector(".ean-msg").textContent));
    ok(true, "E. lectura rota → lo dice");
    await page.close();

    // G. el ícono en las tarjetas reales de mayorista.html
    for (const forzar of [true, false]) {
      const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
      const FOTO = path.join(__dirname, "..", "img", "no-image.jpg");
      await ctx.route("**://**", (r) => {
        const u = r.request().url();
        if (u.startsWith("file:")) return r.continue();
        if (r.request().resourceType() === "image" || /\.(webp|jpe?g|png)(\?|$)/i.test(u))
          return r.fulfill({ status: 200, contentType: "image/jpeg", path: FOTO });
        return r.fulfill({ status: 200, body: "" });
      });
      const pg = await ctx.newPage();
      pg.on("dialog", (d) => d.dismiss().catch(() => {}));
      await pg.addInitScript(([prods, eans, forz]) => {
        if (forz) window.GV_EAN_FORZAR = true;
        const datos = { item_ean: eans, products: prods.map((p) => ({ cod: p.cod, description: p.description })) };
        const mk = (t) => { const r = { data: datos[t] || [], error: null }; const q = {
          select: () => q, eq: () => q, in: () => q, order: () => q, limit: () => q,
          single: () => Promise.resolve({ data: null, error: null }),
          insert: () => q, update: () => q, upsert: () => q,
          then: (f, g) => Promise.resolve(r).then(f, g) }; return q; };
        window.supabase = { createClient: () => ({
          from: mk,
          rpc: (n) => Promise.resolve(n === "get_products_public_sorted" ? { data: prods, error: null } : { data: [], error: null }),
          auth: { getSession: () => Promise.resolve({ data: { session: null } }), onAuthStateChange: () => {} },
          storage: { from: () => ({ getPublicUrl: () => ({ data: { publicUrl: "" } }) }) },
        }) };
      }, [PRODS, EANS, forzar]);
      await pg.goto("file://" + path.join(__dirname, "..", "mayorista.html"));
      await pg.waitForFunction(() => typeof window.loadProductsFromDB === "function", null, { timeout: 15000 });
      await pg.evaluate(async () => { await window.loadProductsFromDB(); });
      await pg.waitForSelector("#card-p-1", { timeout: 10000 });
      const n = await pg.$$eval(".product-card .pc-ean", (b) => b.length);
      if (!forzar) { ok(n === 0, "G. fuera de Vercel ninguna tarjeta tiene el ícono (" + n + ")"); await ctx.close(); continue; }
      ok(n === 2, "G. cada tarjeta tiene su ícono (" + n + ")");
      const geo = await pg.evaluate(() => {
        const c = document.querySelector("#card-p-1 .pc-count").getBoundingClientRect();
        const e = document.querySelector("#card-p-1 .pc-ean").getBoundingClientRect();
        const t = document.querySelector("#card-p-1 .pc-ean-txt").getBoundingClientRect();
        return { cB: c.bottom, cR: c.right, eT: e.top, eR: e.right, tW: t.width };
      });
      ok(geo.eT >= geo.cB && geo.eT - geo.cB <= 8 && Math.abs(geo.eR - geo.cR) <= 2,
        "G. el ícono va debajo del «1/2», alineado a la derecha (" + JSON.stringify(geo) + ")");
      ok(geo.tW < 1, "G. sin mouse encima es sólo el ícono (texto " + geo.tW + " px)");
      await pg.hover("#card-p-1 .pc-ean");
      await pg.waitForTimeout(350);
      const tx = await pg.$eval("#card-p-1 .pc-ean-txt", (t) => ({ w: t.getBoundingClientRect().width, txt: t.textContent }));
      ok(tx.w > 40 && tx.txt === "Descargar EAN", "G. con el mouse encima se estira y dice «Descargar EAN» (" + JSON.stringify(tx) + ")");
      const [dl] = await Promise.all([pg.waitForEvent("download", { timeout: 8000 }), pg.click("#card-p-1 .pc-ean")]);
      ok(dl.suggestedFilename() === "EAN_026_7795587000262.png", "G. el click baja el PNG del producto (" + dl.suggestedFilename() + ")");
      const abierto = await pg.evaluate(() => { const m = document.getElementById("prodPreviewModal"); return !!m && getComputedStyle(m).display !== "none" && !m.hidden && m.classList.contains("open"); });
      ok(!abierto, "G. el click en el ícono no abre el popup de la foto");
      await ctx.close();
    }
  } catch (err) {
    fallas.push("excepción: " + err.message); console.error(err);
  } finally { await browser.close(); }
  if (fallas.length) { console.error("ean-descarga: " + fallas.length + " FALLA(S)"); process.exit(1); }
  console.log("ean-descarga: OK");
})();
