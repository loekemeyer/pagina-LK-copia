#!/usr/bin/env node
/**
 * tests/checkout-layout.cjs — cómo se arma el carrito (columna izquierda, botones
 * de arriba y listado de productos). Mide POSICIONES en Chromium, no markup.
 *
 * HISTORIA, para no volver a pedir lo que ya se retiró:
 *   - 24/09 (Tomás): Dirección y Observaciones lado a lado en LK y en Chef.
 *   - 02/10 (Gastón): con "Pedir para", Observaciones al ancho de las dos de
 *     arriba (v2.3.505).
 *   - 02/10 (Gastón, v2.3.506): RETIRADO lo anterior. Observaciones ya no es
 *     una tarjeta: es un botón al lado de "Confirmar pedido" que abre #modalObs.
 *     "Entrega estimada" no se muestra nunca. El listado de productos llega al
 *     pie de la pantalla y su encabezado queda fijo al scrollear.
 *   - 02/10 (Gastón, v2.3.507): el alto de "Pedir para" y Dirección lo manda
 *     Dirección. Con el listado al pie, la columna derecha estira a la
 *     izquierda y la grilla repartía ese sobrante entre sus filas: "Pedir
 *     para" quedaba ~50 px más alta y Pago y Subtotal bajaban. El chequeo D
 *     estira la columna a propósito para reproducirlo.
 *
 * ⚠ Es el MISMO archivo en LK (`pagina-LK-copia`) y en Chef (`paginach`):
 *   Chef recibió el cambio en la v2.0.90 y el alto de las tarjetas en la v2.0.91. Chef no tiene la barra "Entrega
 *   estimada" (nunca se portó), así que el chequeo B ahí pasa solo.
 *
 * ⚠ Viewport ANCHO (1700×1000): la columna del carrito manda, no la ventana.
 *
 * Correr:  node tests/checkout-layout.cjs
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
const cerca = (a, b, t = 2) => Math.abs(a - b) <= t;

// 25 artículos: con el tope viejo de 380 px el listado mostraba ~6 y scrolleaba.
const PRODS = Array.from({ length: 25 }, (_, i) => ({
  id: "p-" + i, cod: String(500 + i), category: "Peladores", subcategory: null,
  ranking: i + 1, orden_catalogo: i + 1, description: "Artículo de prueba " + (i + 1),
  uxb: 12, list_price: 1000 + i, images: [], badge_status: null, active: true,
}));

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1700, height: 1000 } });
  await ctx.route("**://**", (r) =>
    r.request().url().startsWith("file:") ? r.continue() : r.fulfill({ status: 200, body: "" }),
  );
  const page = await ctx.newPage();
  page.on("dialog", (d) => d.dismiss().catch(() => {}));
  await page.addInitScript((prods) => {
    const vacio = { data: [], error: null };
    const q = {
      select: () => q, eq: () => q, in: () => q, order: () => q, limit: () => q, gte: () => q,
      single: () => Promise.resolve({ data: null, error: null }),
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      insert: () => q, update: () => q, upsert: () => q,
      then: (f, g) => Promise.resolve(vacio).then(f, g),
    };
    window.supabase = {
      createClient: () => ({
        from: () => q,
        rpc: (n) => n === "get_products_public_sorted"
          ? Promise.resolve({ data: prods, error: null }) : Promise.resolve(vacio),
        auth: { getSession: () => Promise.resolve({ data: { session: null } }), onAuthStateChange: () => {} },
        storage: { from: () => ({ getPublicUrl: () => ({ data: { publicUrl: "" } }) }) },
      }),
    };
  }, PRODS);

  await page.goto("file://" + path.join(raiz, "mayorista.html"));
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => typeof window.updateCart === "function", null, { timeout: 15000 });

  // Carrito visible y con los 25 artículos.
  await page.evaluate(async () => {
    await window.loadProductsFromDB();
    products.forEach((p) => cart.push({ productId: p.id, qtyCajas: 1, source: "catalogo" }));
    const sec = document.getElementById("carrito");
    document.querySelectorAll(".section.active").forEach((s) => s.classList.remove("active"));
    sec.classList.add("active");
    sec.style.display = "block";
    window.updateCart();
  });
  await page.waitForTimeout(300);

  const R = (sel) => page.evaluate((s) => {
    const el = typeof s === "string" ? document.querySelector(s) : null;
    if (!el) return null;
    const x = el.getBoundingClientRect();
    return { top: Math.round(x.top), bottom: Math.round(x.bottom), left: Math.round(x.left),
      right: Math.round(x.right), w: Math.round(x.width), h: Math.round(x.height) };
  }, sel);

  /* ── A. OBSERVACIONES = BOTÓN AL LADO DE "CONFIRMAR PEDIDO" ─────────────── */
  const sub = await R("#submitOrderBtn");
  const obs = await R("#obsBtn");
  ok(obs && obs.w > 0, "A: no está el botón #obsBtn (Observaciones) o no se dibuja");
  if (obs && sub) {
    ok(cerca(obs.top, sub.top, 4) && obs.left > sub.right && obs.left - sub.right < 40,
      "A: Observaciones no quedó AL LADO de Confirmar pedido. sub=" + JSON.stringify(sub) + " obs=" + JSON.stringify(obs));
  }
  const tarjeta = await page.evaluate(() => {
    const t = document.getElementById("obsPedidoInput");
    return { enCol: !!(t && t.closest(".cart-col-left")), visible: !!(t && t.getBoundingClientRect().width > 0) };
  });
  ok(!tarjeta.enCol, "A: la tarjeta de Observaciones sigue en la columna izquierda");
  ok(!tarjeta.visible, "A: el cuadro de Observaciones se ve sin haber tocado el botón");

  // El botón abre la ventana, se escribe, se cierra y el texto queda donde lo lee el pedido.
  if (obs && obs.w > 0) {
  await page.click("#obsBtn");
  ok(await page.isVisible("#obsPedidoInput"), "A: tocar Observaciones no abrió el cuadro para escribir");
  await page.fill("#obsPedidoInput", "Entregar por la tarde");
  await page.click("#modalObs .modal-submit");
  ok(!(await page.isVisible("#obsPedidoInput")), "A: el botón Listo no cerró la ventana de Observaciones");
  const tick = await page.evaluate(() => ({
    v: document.getElementById("obsPedidoInput").value,
    tick: !document.querySelector("#obsBtn .obs-btn-tick").hidden,
  }));
  ok(tick.v === "Entregar por la tarde", "A: el texto no quedó en #obsPedidoInput, que es de donde lo lee el pedido");
  ok(tick.tick, "A: con una observación escrita el botón no muestra el ✓");
  }

  /* ── B. "ENTREGA ESTIMADA" NO SE MUESTRA NUNCA ──────────────────────────── */
  const est = await page.evaluate(() => {
    window._renderEntregaEstimada && window._renderEntregaEstimada("2026-10-09");
    const el = document.getElementById("entregaEstimada");
    if (el) el.hidden = false; // aunque otro código le saque el hidden
    return el ? el.getBoundingClientRect().height : 0;
  });
  ok(est === 0, "B: \"Entrega estimada\" se dibuja (alto " + est + " px) y no tiene que aparecer nunca");

  /* ── C. LISTADO AL PIE DE LA PANTALLA, CON EL ENCABEZADO FIJO ──────────── */
  const lista = await page.evaluate(() => {
    const c = document.getElementById("cart");
    const th = c.querySelector("thead th");
    const r = c.getBoundingClientRect();
    const antes = th.getBoundingClientRect().top;
    c.scrollTop = 400;
    const despues = th.getBoundingClientRect().top;
    const scrolleo = c.scrollTop;
    c.scrollTop = 0;
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height),
      vh: innerHeight, antes: Math.round(antes), despues: Math.round(despues), scrolleo };
  });
  ok(lista.scrolleo > 0, "C: con 25 artículos el listado no scrollea adentro");
  ok(cerca(lista.antes, lista.despues), "C: el encabezado (COD / DESCRIPCIÓN / …) no queda fijo al scrollear: " +
    "estaba en " + lista.antes + " y quedó en " + lista.despues);
  ok(lista.bottom <= lista.vh, "C: el listado se pasa del pie de la pantalla (" + lista.bottom + " > " + lista.vh + ")");
  ok(lista.vh - lista.bottom <= 60, "C: el listado no llega al pie de la pantalla (quedan " +
    (lista.vh - lista.bottom) + " px libres; con el tope viejo medía 456 px)");

  /* ── D. CON "PEDIR PARA": las dos tarjetas lado a lado y a la misma altura,
     y nada de hueco debajo (Observaciones ya no está en esa grilla) ────────── */
  const v = await page.evaluate(() => {
    // La columna derecha (listado al pie) estira a la izquierda: se reproduce
    // dándole a la izquierda más alto que su contenido.
    document.querySelector("#carrito .cart-col-left").style.minHeight = "1600px";
    const fila = document.getElementById("shippingSelect").closest(".ship-row");
    const cust = document.createElement("div");
    cust.id = "customerSelectorCart";
    cust.className = "ship-row";
    cust.innerHTML =
      '<div class="ship-card has-confirm"><label class="ship-label">Pedir para (Razón Social)</label>' +
      '<select><option>Retail Plastic SRL</option></select><div class="ship-hint">x</div></div>';
    fila.parentNode.insertBefore(cust, fila);
    const eb = document.getElementById("expresoBox");
    eb.hidden = false;
    eb.innerHTML = '<span class="exp-ico">🚚</span><span class="exp-txt"><span class="exp-k">Expreso</span>' +
      '<span class="exp-v">Expreso De A 4 Bahia</span><span class="exp-dir">John W. Cooke 3255, Villa Soldati</span></span>' +
      '<button type="button" class="exp-btn">Cambiar</button>';
    const B = (el) => { const x = el.getBoundingClientRect();
      return { top: Math.round(x.top), bottom: Math.round(x.bottom), left: Math.round(x.left), right: Math.round(x.right) }; };
    return {
      cust: B(cust.querySelector(".ship-card")),
      dir: B(document.getElementById("shippingSelect").closest(".ship-card")),
      pago: B(document.getElementById("paymentRow")),
      total: B(document.querySelector("#carrito .cart-col-left > .cart-total") || document.getElementById("paymentRow")),
    };
  });
  ok(cerca(v.cust.top, v.dir.top) && v.dir.left > v.cust.right,
    "D: con Pedir para, Dirección no quedó al lado. cust=" + JSON.stringify(v.cust) + " dir=" + JSON.stringify(v.dir));
  ok(cerca(v.cust.bottom, v.dir.bottom),
    "D: con Pedir para y el expreso a la vista, las dos tarjetas no terminan a la misma altura. cust=" +
    v.cust.bottom + " dir=" + v.dir.bottom);
  ok(v.pago.top >= v.dir.bottom && v.pago.top - v.dir.bottom <= 30,
    "D: con Pedir para queda un hueco entre las tarjetas de arriba y Método de pago (" +
    (v.pago.top - v.dir.bottom) + " px)");
  ok(v.total.top <= v.pago.bottom + 30,
    "D: con la columna estirada, el Subtotal no quedó pegado a Método de pago (" +
    (v.total.top - v.pago.bottom) + " px)");

  await browser.close();
  if (fallas.length) {
    console.error("checkout-layout: FALLA (" + path.basename(raiz) + ")");
    fallas.forEach((f) => console.error("  · " + f));
    process.exit(1);
  }
  console.log("checkout-layout: OK (" + path.basename(raiz) +
    ") — Observaciones al lado de Confirmar, sin fecha estimada, listado al pie con encabezado fijo");
})().catch((e) => { console.error("checkout-layout: ERROR", e); process.exit(1); });
