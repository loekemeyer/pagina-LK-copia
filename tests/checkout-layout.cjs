#!/usr/bin/env node
/**
 * tests/checkout-layout.cjs — Dirección de entrega y Observaciones, UNA fila.
 *
 * POR QUÉ EXISTE. El 24/09 Tomás comparó las dos páginas: en LK las dos
 * tarjetas del envío van lado a lado (`.ship-row-split`) y en Chef Observaciones
 * caía debajo, en su propia `.ship-row`. Es el mismo checkout y tiene que verse
 * igual en las dos.
 *
 * Mide POSICIONES, no markup: dos `.ship-card` hermanas pueden estar en la misma
 * fila del HTML y apilarse igual si falta el CSS de `.ship-row-split` — que es
 * justo lo que le faltaba a Chef.
 *
 * ⚠ Va con viewport ANCHO (1700). La columna del carrito manda, no la ventana:
 *   con 1280 mide 683 px y las dos tarjetas (flex-basis 340 + gap 16 = 696) NO
 *   entran, así que se apilan — y ahí el test da rojo con las dos páginas bien.
 *   A 1700 la columna mide 858 y entran. Apilarse en pantalla angosta es el
 *   comportamiento correcto (`flex-wrap: wrap`), no una falla.
 *
 * Correr:  node tests/checkout-layout.cjs
 *          node tests/checkout-layout.cjs ../paginach
 */
const path = require("path");
let chromium;
try { ({ chromium } = require("/opt/node22/lib/node_modules/playwright")); }
catch (_e) {
  try { ({ chromium } = require("playwright")); }
  catch (_e2) { console.error("checkout-layout: SALTEADO — no hay playwright"); process.exit(0); }
}

const raiz = process.argv[2] ? path.resolve(__dirname, "..", process.argv[2]) : path.join(__dirname, "..");
const fallas = [];
const ok = (c, m) => { if (!c) fallas.push(m); };

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1700, height: 1000 } });
  await ctx.route("**://**", (r) =>
    r.request().url().startsWith("file:") ? r.continue() : r.fulfill({ status: 200, body: "" }),
  );
  const page = await ctx.newPage();
  page.on("dialog", (d) => d.dismiss().catch(() => {}));
  await page.goto("file://" + path.join(raiz, "mayorista.html"));
  await page.waitForLoadState("domcontentloaded");

  const r = await page.evaluate(() => {
    const sel = document.getElementById("shippingSelect");
    const fila = sel && sel.closest(".ship-row");
    if (!fila) return { err: "no se encontró la .ship-row del selector de sucursal" };
    const sec = fila.closest(".section");
    if (sec) { sec.classList.add("active"); sec.style.display = "block"; }
    const obs = document.getElementById("obsPedidoInput");
    if (!obs) return { err: "no se encontró #obsPedidoInput" };
    const tarjetaDir = sel.closest(".ship-card");
    const tarjetaObs = obs.closest(".ship-card");
    const a = tarjetaDir.getBoundingClientRect();
    const b = tarjetaObs.getBoundingClientRect();
    return {
      hermanas: tarjetaDir.parentElement === tarjetaObs.parentElement,
      split: fila.classList.contains("ship-row-split"),
      mismaFila: Math.abs(a.top - b.top) < 24 && b.left > a.left + 40,
      dir: { top: Math.round(a.top), left: Math.round(a.left), w: Math.round(a.width) },
      obs: { top: Math.round(b.top), left: Math.round(b.left), w: Math.round(b.width) },
      obsVisible: b.width > 0 && b.height > 0,
    };
  });

  if (r.err) { console.error("checkout-layout: ERROR —", r.err); process.exit(1); }

  ok(r.hermanas, "las dos .ship-card no son hermanas: Observaciones quedó en otra fila del HTML");
  ok(r.split, "a la fila le falta la clase .ship-row-split");
  ok(r.obsVisible, "la tarjeta de Observaciones no se está dibujando");
  ok(r.mismaFila,
    "Observaciones NO quedó al lado de Dirección de entrega (falta el CSS de .ship-row-split). " +
    "dir=" + JSON.stringify(r.dir) + " obs=" + JSON.stringify(r.obs));

  await browser.close();
  if (fallas.length) {
    console.error("checkout-layout: FALLA (" + path.basename(raiz) + ")");
    fallas.forEach((f) => console.error("  · " + f));
    process.exit(1);
  }
  console.log("checkout-layout: OK (" + path.basename(raiz) + ") — dirección y observaciones en la misma fila");
})().catch((e) => { console.error("checkout-layout: ERROR", e); process.exit(1); });
