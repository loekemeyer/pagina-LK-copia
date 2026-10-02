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

  /* ── CON "PEDIR PARA (RAZÓN SOCIAL)" (02/10/2026) ──────────────────────────
     Vendedores y clientes con varias razones sociales tienen una tarjeta más,
     `#customerSelectorCart`, que el JS mete antes de la fila de envío. Ahí la
     columna pasa a grilla de 2: "Pedir para" | "Dirección". Hasta hoy la fila
     de envío ENTERA iba a la columna 2, así que Observaciones caía debajo de
     Dirección y debajo de "Pedir para" quedaba un hueco vacío. Pedido: que
     Observaciones ocupe el ancho de las dos de arriba.
     Se arma la tarjeta como lo hace el JS (misma clase, mismo lugar) y se mide. */
  const v = await page.evaluate(() => {
    const fila = document.getElementById("shippingSelect").closest(".ship-row");
    const cust = document.createElement("div");
    cust.id = "customerSelectorCart";
    cust.className = "ship-row";
    cust.innerHTML =
      '<div class="ship-card has-confirm"><label class="ship-label">Pedir para (Razón Social)</label>' +
      '<select><option>Retail Plastic SRL</option></select><div class="ship-hint">x</div></div>';
    fila.parentNode.insertBefore(cust, fila);
    // la fecha estimada también puede estar: va arriba, a todo el ancho
    const est = document.getElementById("entregaEstimada");
    if (est) { est.hidden = false; est.textContent = "Entrega estimada: 09/10"; }
    const R = (el) => { const x = el.getBoundingClientRect();
      return { top: Math.round(x.top), bottom: Math.round(x.bottom), left: Math.round(x.left), right: Math.round(x.right) }; };
    const sel = document.getElementById("shippingSelect");
    return {
      cust: R(cust.querySelector(".ship-card")),
      dir: R(sel.closest(".ship-card")),
      obs: R(document.getElementById("obsPedidoInput").closest(".ship-card")),
      pago: R(document.getElementById("paymentRow")),
      est: est ? R(est) : null,
    };
  });
  const cerca = (a, b) => Math.abs(a - b) <= 2;
  ok(cerca(v.cust.top, v.dir.top) && v.dir.left > v.cust.right,
    "con Pedir para: Dirección de entrega no quedó al lado de Pedir para. cust=" +
    JSON.stringify(v.cust) + " dir=" + JSON.stringify(v.dir));
  ok(v.obs.top >= Math.max(v.cust.bottom, v.dir.bottom),
    "con Pedir para: Observaciones no quedó debajo de la fila Pedir para + Dirección. obs=" + JSON.stringify(v.obs));
  ok(cerca(v.obs.left, v.cust.left) && cerca(v.obs.right, v.dir.right),
    "con Pedir para: Observaciones no ocupa el ancho de Pedir para + Dirección (queda un hueco). obs=" +
    JSON.stringify(v.obs) + " cust=" + JSON.stringify(v.cust) + " dir=" + JSON.stringify(v.dir));
  ok(v.pago.top >= v.obs.bottom, "con Pedir para: Método de pago quedó arriba de Observaciones");
  if (v.est)
    ok(v.est.bottom <= v.cust.top && cerca(v.est.left, v.cust.left) && cerca(v.est.right, v.dir.right),
      "con Pedir para: la fecha estimada no quedó arriba y a todo el ancho. est=" + JSON.stringify(v.est));

  // Con el expreso a la vista Dirección crece (~290 px contra ~170 de "Pedir
  // para"): las dos tienen que terminar a la misma altura, sin hueco abajo.
  const w = await page.evaluate(() => {
    const eb = document.getElementById("expresoBox");
    eb.hidden = false;
    eb.innerHTML = '<span class="exp-ico">🚚</span><span class="exp-txt"><span class="exp-k">Expreso</span>' +
      '<span class="exp-v">Expreso De A 4 Bahia</span><span class="exp-dir">John W. Cooke 3255, Villa Soldati</span></span>' +
      '<button type="button" class="exp-btn">Cambiar</button>';
    const B = (el) => Math.round(el.getBoundingClientRect().bottom);
    return {
      cust: B(document.querySelector("#customerSelectorCart .ship-card")),
      dir: B(document.getElementById("shippingSelect").closest(".ship-card")),
    };
  });
  ok(cerca(w.cust, w.dir),
    "con Pedir para y el expreso a la vista: las dos tarjetas de arriba no terminan a la misma altura " +
    "(queda hueco debajo de la más corta). cust=" + w.cust + " dir=" + w.dir);

  await browser.close();
  if (fallas.length) {
    console.error("checkout-layout: FALLA (" + path.basename(raiz) + ")");
    fallas.forEach((f) => console.error("  · " + f));
    process.exit(1);
  }
  console.log("checkout-layout: OK (" + path.basename(raiz) + ") — dirección y observaciones en la misma fila");
})().catch((e) => { console.error("checkout-layout: ERROR", e); process.exit(1); });
