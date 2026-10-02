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
 *   - 02/10 (Gastón, v2.3.509): el Subtotal va SIEMPRE debajo de Método de pago,
 *     al mismo ancho, y el listado termina donde termina el Subtotal (RETIRA
 *     el "listado al pie de la pantalla" de la v2.3.506: ahora lo manda la
 *     columna izquierda). "¿Seguro que no necesitás…?" va solo en la fila de
 *     abajo, de Método de pago al borde derecho del listado, hasta 5 por fila.
 *   - 02/10 (Gastón, v2.3.510 / Chef v2.0.93): el botón Observaciones lleva borde
 *     rojo y un lápiz rojo con la misma técnica que los íconos de "Pedir para" /
 *     "Indicar dirección" (máscara + degradé). Se fue el emoji 📝.
 *   - 02/10 (Gastón, v2.3.511 / Chef v2.0.94): "Pedir para" ya no tiene botón
 *     "Confirmar": elegir la razón social alcanza. Y cambiar de razón social
 *     NUNCA vacía el carrito ni abre una ventana (antes salía un confirm "el
 *     carrito se va a vaciar"). El chequeo F lo prueba con el selector real.
 *   - 02/10 (Gastón, v2.3.514): para el VENDEDOR, "Pedir para"
 *     ya no muestra CUIT ni "Expreso". Ese "Expreso" era `zona_expreso`, el
 *     BARRIO (Liao Shuting, San Antonio de Padua). El expreso de verdad va
 *     debajo de la dirección de entrega, como para cualquier cliente. Chequeo G.
 *     (Chef no tiene esa tarjeta de vendedor: G se saltea solo.)
 *   - 02/10 (Gastón, v2.3.515): para el vendedor se va la línea "📍 <localidad>"
 *     debajo del expreso, y la fila del expreso queda en dos renglones bajos
 *     (~44 px contra ~98) para que el Total del pedido entre en la pantalla.
 *
 * ⚠ Es el MISMO archivo en LK (`pagina-LK-copia`) y en Chef (`paginach`):
 *   Chef recibió el cambio en la v2.0.90, el alto de las tarjetas en la v2.0.91 y
 *   el Subtotal / surtido a ancho total en la v2.0.92. Chef no tiene la barra "Entrega
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

// 25 artículos en el carrito (con el tope viejo de 380 px el listado mostraba ~6
// y scrolleaba) y 12 más que no están: son los de "¿Seguro que no necesitás…?".
const EN_CARRITO = 25;
const PRODS = Array.from({ length: EN_CARRITO + 12 }, (_, i) => ({
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
  const dialogos = [];
  page.on("dialog", (d) => { dialogos.push(d.message()); d.dismiss().catch(() => {}); });
  await page.addInitScript((prods) => {
    const vacio = { data: [], error: null };
    // `customers` por id devuelve una ficha, así "Pedir para" cambia de cliente
    // de verdad (onLinkedCustomerSelected). El resto, vacío.
    const mk = (tabla) => {
      let id = null;
      const fila = () => (tabla === "customers" && id
        ? { id, business_name: "Cliente " + id, dto_vol: 0, cod_cliente: id === "c1" ? "100" : "101" } : null);
      const q = {
        select: () => q, in: () => q, order: () => q, limit: () => q, gte: () => q,
        eq: (col, v) => { if (col === "id") id = v; return q; },
        single: () => Promise.resolve({ data: fila(), error: null }),
        maybeSingle: () => Promise.resolve({ data: fila(), error: null }),
        insert: () => q, update: () => q, upsert: () => q,
        then: (f, g) => Promise.resolve(vacio).then(f, g),
      };
      return q;
    };
    window.supabase = {
      createClient: () => ({
        from: (t) => mk(t),
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
  await page.evaluate(async (n) => {
    await window.loadProductsFromDB();
    products.slice(0, n).forEach((p) => cart.push({ productId: p.id, qtyCajas: 1, source: "catalogo" }));
    const sec = document.getElementById("carrito");
    document.querySelectorAll(".section.active").forEach((s) => s.classList.remove("active"));
    sec.classList.add("active");
    sec.style.display = "block";
    window.updateCart();
  }, EN_CARRITO);
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
  // Borde rojo y lápiz rojo como los íconos de las tarjetas (v2.3.510), sin emoji.
  const look = await page.evaluate(() => {
    const b = document.getElementById("obsBtn");
    if (!b) return null;
    const bf = getComputedStyle(b, "::before");
    const mask = bf.getPropertyValue("-webkit-mask-image") || bf.getPropertyValue("mask-image") || "";
    return { borde: getComputedStyle(b).borderTopColor, emoji: /\u{1F4DD}/u.test(b.textContent),
      lapiz: bf.content !== "none" && mask.includes("svg"), fondo: bf.backgroundImage };
  });
  if (look) {
    ok(look.borde === "rgb(208, 0, 0)", "A: el botón Observaciones no tiene el borde rojo (" + look.borde + ")");
    ok(!look.emoji, "A: el botón Observaciones volvió a tener el emoji 📝 en vez del lápiz");
    ok(look.lapiz && look.fondo.includes("208, 0, 0"),
      "A: el botón Observaciones no tiene el lápiz rojo (máscara + degradé, como los íconos de las tarjetas)");
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

  /* ── C. EL LISTADO TERMINA DONDE TERMINA EL SUBTOTAL, CON EL ENCABEZADO FIJO ── */
  const lista = await page.evaluate(() => {
    const c = document.getElementById("cart");
    const tot = document.querySelector("#carrito .cart-total").getBoundingClientRect();
    const th = c.querySelector("thead th");
    const r = c.getBoundingClientRect();
    const antes = th.getBoundingClientRect().top;
    c.scrollTop = 400;
    const despues = th.getBoundingClientRect().top;
    const scrolleo = c.scrollTop;
    c.scrollTop = 0;
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height),
      totBottom: Math.round(tot.bottom), antes: Math.round(antes), despues: Math.round(despues), scrolleo };
  });
  ok(lista.scrolleo > 0, "C: con 25 artículos el listado no scrollea adentro");
  ok(cerca(lista.antes, lista.despues), "C: el encabezado (COD / DESCRIPCIÓN / …) no queda fijo al scrollear: " +
    "estaba en " + lista.antes + " y quedó en " + lista.despues);
  ok(cerca(lista.bottom, lista.totBottom, 3), "C: el listado no termina donde termina el Subtotal (listado " +
    lista.bottom + ", Subtotal " + lista.totBottom + ")");

  /* ── E. CON "¿SEGURO QUE NO NECESITÁS…?" A LA VISTA: el Subtotal sigue debajo
     de Método de pago y al mismo ancho, el listado termina con él, y el módulo
     va solo abajo, de Método de pago al borde derecho del listado, 5 por fila ── */
  const e = await page.evaluate(async (n) => {
    currentSession = { user: { id: "u-prueba" } };
    customerProfile = { id: "c-prueba", business_name: "Cliente de prueba", dto_vol: 0 };
    window.getMissingAssortmentProducts = () => products.slice(n);
    window.updateCart();
    await new Promise((r) => setTimeout(r, 300));
    const B = (el) => { const x = el.getBoundingClientRect();
      return { top: Math.round(x.top), bottom: Math.round(x.bottom), left: Math.round(x.left), right: Math.round(x.right) }; };
    const mm = document.getElementById("missingAssortmentModule");
    const cards = [...mm.querySelectorAll(".missing-card")];
    const t0 = cards.length ? Math.round(cards[0].getBoundingClientRect().top) : null;
    const ult = cards.length ? cards[cards.length - 1].getBoundingClientRect() : null;
    return {
      enIzq: !!document.querySelector("#carrito .cart-col-left > .cart-total"),
      pago: B(document.getElementById("paymentRow")),
      // la tarjeta verde que se ve es .totals-inner, no su contenedor
      total: B(document.querySelector("#carrito .cart-total .totals-inner")),
      lista: B(document.getElementById("cart")),
      mm: B(mm), visible: getComputedStyle(mm).display !== "none",
      tarjetas: cards.length,
      porFila: cards.filter((c) => Math.round(c.getBoundingClientRect().top) === t0).length,
      sobraAbajo: ult ? Math.round(mm.getBoundingClientRect().bottom - ult.bottom) : null,
    };
  }, EN_CARRITO);
  ok(e.visible && e.tarjetas === 12, "E: no se dibuja \"¿Seguro que no necesitás…?\" (" + e.tarjetas + " tarjetas)");
  ok(e.enIzq, "E: con el módulo a la vista, el Subtotal se fue de la columna izquierda");
  ok(cerca(e.total.left, e.pago.left) && cerca(e.total.right, e.pago.right),
    "E: el Subtotal no tiene el ancho de Método de pago. pago=" + JSON.stringify(e.pago) + " total=" + JSON.stringify(e.total));
  ok(e.total.top >= e.pago.bottom && e.total.top - e.pago.bottom <= 30,
    "E: el Subtotal no quedó pegado debajo de Método de pago (" + (e.total.top - e.pago.bottom) + " px)");
  ok(cerca(e.lista.bottom, e.total.bottom, 3),
    "E: el listado no termina donde termina el Subtotal (listado " + e.lista.bottom + ", Subtotal " + e.total.bottom + ")");
  ok(cerca(e.mm.left, e.pago.left) && cerca(e.mm.right, e.lista.right),
    "E: el módulo no va de Método de pago al borde derecho del listado. mm=" + JSON.stringify(e.mm) +
    " pago.left=" + e.pago.left + " lista.right=" + e.lista.right);
  ok(e.mm.top > e.total.bottom && e.mm.top > e.lista.bottom, "E: el módulo no quedó debajo de las dos columnas");
  ok(e.porFila === 5, "E: en la primera fila del módulo hay " + e.porFila + " tarjetas y tienen que ser 5");
  ok(e.sobraAbajo !== null && e.sobraAbajo <= 30,
    "E: el módulo deja " + e.sobraAbajo + " px vacíos debajo de la última tarjeta");

  /* ── F. "PEDIR PARA" SIN BOTÓN CONFIRMAR, Y CAMBIAR DE RAZÓN SOCIAL NO VACÍA
     EL CARRITO NI ABRE UNA VENTANA (selector real, renderCustomerSelector) ── */
  const dialogosAntes = dialogos.length;
  const f = await page.evaluate(async () => {
    linkedCustomers = [
      { customer_id: "c1", cod_cliente: "100", business_name: "Cliente c1" },
      { customer_id: "c2", cod_cliente: "101", business_name: "Cliente c2" },
    ];
    renderCustomerSelector();
    const card = document.querySelector("#customerSelectorCart > .ship-card");
    const r = { hay: !!card, boton: !!document.getElementById("customerConfirmBtn"),
      botones: card ? card.querySelectorAll("button.ship-confirm-btn").length : -1 };
    const elegir = async (id) => {
      _csSetValue("customerSelectCart", id);
      onAnyCustomerSelectChange({ target: document.getElementById("customerSelectCart") });
      await new Promise((ok) => setTimeout(ok, 400));
    };
    const antes = cart.length;
    await elegir("c1");
    r.trasC1 = { items: cart.length, cliente: customerProfile && customerProfile.id,
      elegida: card.classList.contains("cs-elegida"),
      ayuda: getComputedStyle(card.querySelector(".ship-hint")).display };
    await elegir("c2");
    r.trasC2 = { items: cart.length, cliente: customerProfile && customerProfile.id };
    r.antes = antes;
    // Editando un pedido ya enviado (es de c2): no se cambia de razón social,
    // se avisa sin ventana y el carrito queda igual.
    setEditingOrderId("999", {});
    await elegir("c1");
    r.edicion = { items: cart.length, cliente: customerProfile && customerProfile.id,
      sel: document.getElementById("customerSelectCart").value,
      aviso: (document.getElementById("orderStatus") || {}).textContent || "" };
    setEditingOrderId(null);
    return r;
  });
  ok(f.hay, "F: no se dibujó la tarjeta \"Pedir para\"");
  ok(!f.boton && f.botones === 0, "F: \"Pedir para\" todavía tiene el botón Confirmar");
  ok(f.antes > 0 && f.trasC1.items === f.antes && f.trasC2.items === f.antes,
    "F: cambiar de razón social cambió el carrito (" + f.antes + " → " + f.trasC1.items + " → " + f.trasC2.items + ")");
  ok(f.trasC1.cliente === "c1" && f.trasC2.cliente === "c2",
    "F: elegir la razón social no cambió el cliente del pedido (" + f.trasC1.cliente + ", " + f.trasC2.cliente + ")");
  ok(dialogos.length === dialogosAntes,
    "F: cambiar de razón social abrió una ventana: " + JSON.stringify(dialogos.slice(dialogosAntes)));
  ok(f.edicion.cliente === "c2" && f.edicion.sel === "c2" && f.edicion.items === f.antes,
    "F: editando un pedido, cambiar de razón social no se frenó o tocó el carrito (" + JSON.stringify(f.edicion) + ")");
  ok(/editando un pedido/i.test(f.edicion.aviso),
    "F: editando un pedido, no se avisó por qué no se cambia la razón social (" + JSON.stringify(f.edicion.aviso) + ")");
  ok(f.trasC1.elegida && f.trasC1.ayuda === "none",
    "F: con una razón social elegida, la tarjeta no se marca completa o sigue la ayuda (" +
    JSON.stringify(f.trasC1) + ")");

  /* ── G. VENDEDOR: "PEDIR PARA" SIN CUIT NI "EXPRESO"; el expreso va debajo
     de la dirección de entrega (_expSyncUI), como para cualquier cliente.
     Caso real: Liao Shuting (LK 4262, vend 6): sucursal en San Antonio de
     Padua, GBA, sin nombre_expreso; antes salía "Expreso San Antonio de Padua"
     porque se mostraba `zona_expreso`, que es el BARRIO ─────────────────── */
  // Chef no tiene esta tarjeta de vendedor (nunca mostró CUIT ni Expreso ahí):
  // sin updateVendor10006Info el chequeo no aplica.
  const g = await page.evaluate(async () => {
    if (typeof updateVendor10006Info !== "function") return null;
    const realVend = window.isActualVendor, realGeo = window.loadCustomerGeo;
    window.isActualVendor = () => true;
    document.body.classList.add("is-vendor-user");
    const prev = customerProfile;
    customerProfile = { id: "c2", business_name: "Liao Shuting", cuit: "23945386924", dto_vol: 0 };
    const sel = document.getElementById("shippingSelect");
    const filas = {
      "1": { slot: 1, label: "Italia 1176 - S.A de Padua", direccion_entrega: "Italia 1176",
        zona_expreso: "San Antonio de Padua", nombre_expreso: "", direccion_expreso: "",
        localidad: "San Antonio de Padua", provincia: "Buenos Aires" },
      "2": { slot: 2, label: "Mendoza centro", direccion_entrega: "John W. Cooke 3255",
        zona_expreso: "Villa Soldati", nombre_expreso: "Expreso De A 4 Bahia",
        direccion_expreso: "John W. Cooke 3255, Villa Soldati", localidad: "Mendoza", provincia: "Mendoza" },
    };
    sel.innerHTML = "";
    Object.values(filas).forEach((row) => {
      const o = document.createElement("option");
      o.value = String(row.slot); o.textContent = row.slot + ": " + row.label;
      o.dataset.label = row.label; o.dataset.direccionEntrega = row.direccion_entrega;
      o.dataset.zonaExpreso = row.zona_expreso; o.dataset.nombreExpreso = row.nombre_expreso;
      o.dataset.direccionExpreso = row.direccion_expreso; o.dataset.localidad = row.localidad;
      o.dataset.provincia = row.provincia; o.dataset.expresoPendiente = "";
      sel.appendChild(o);
    });
    window.loadCustomerGeo = async () => Object.values(filas);
    const ver = async (slot) => {
      sel.value = slot; deliveryChoice.slot = slot;
      await updateVendor10006Info();
      window._expSyncUI();
      const card = document.querySelector("#customerSelectorCart > .ship-card");
      const eb = document.getElementById("expresoBox");
      const dirCard = document.getElementById("shipCardEntrega").getBoundingClientRect();
      const ebr = eb.getBoundingClientRect();
      const dirEl = eb.querySelector(".exp-dir");
      return {
        info: !!document.getElementById("v10006CustInfo"),
        textoPedirPara: card ? card.textContent : "",
        expreso: eb.hidden ? "" : eb.textContent,
        expresoEnDir: !!eb.closest("#shipCardEntrega"),
        geo: !!document.getElementById("v10006ShipGeo"),
        altoExp: eb.hidden ? 0 : Math.round(ebr.height),
        desborda: !eb.hidden && ebr.right > dirCard.right + 1,
        dirEntera: !dirEl || dirEl.scrollWidth <= dirEl.clientWidth + 1,
        title: eb.title || "",
      };
    };
    const r = { padua: await ver("1"), interior: await ver("2") };
    window.isActualVendor = realVend; window.loadCustomerGeo = realGeo;
    document.body.classList.remove("is-vendor-user");
    customerProfile = prev;
    _v10006Remove();
    document.getElementById("expresoBox").hidden = true;
    return r;
  });
  if (g) {
  for (const [k, x] of Object.entries(g)) {
    ok(!x.info && !/CUIT/i.test(x.textoPedirPara) && !/Expreso/i.test(x.textoPedirPara),
      "G (" + k + "): \"Pedir para\" del vendedor todavía muestra CUIT o Expreso: " + JSON.stringify(x.textoPedirPara));
  }
  ok(g.padua.expreso === "",
    "G: Liao Shuting (San Antonio de Padua, GBA) muestra un expreso que no tiene: " + JSON.stringify(g.padua.expreso));
  ok(!g.padua.geo && !g.interior.geo, "G: volvió la línea \"📍 <localidad>\" debajo de la dirección (v2.3.515 la sacó)");
  ok(/Expreso De A 4 Bahia/.test(g.interior.expreso) && g.interior.expresoEnDir,
    "G: con expreso real, no aparece debajo de la dirección de entrega (" + JSON.stringify(g.interior) + ")");
  // Para el vendedor el expreso va compacto (2 renglones bajos; con un nombre largo
  // como "Expreso De A 4 Bahia" el nombre baja un renglón: ~59 px), sin salirse de la
  // tarjeta y con la dirección del galpón entera (es a dónde va el camión).
  ok(g.interior.altoExp > 0 && g.interior.altoExp <= 64,
    "G: la fila del expreso del vendedor no quedó compacta (" + g.interior.altoExp + " px; antes ~98)");
  ok(!g.interior.desborda, "G: la fila del expreso se sale de la tarjeta de Dirección");
  ok(g.interior.dirEntera, "G: la dirección del galpón quedó recortada en la fila del expreso");
  ok(/Expreso De A 4 Bahia/.test(g.interior.title) && /Cooke 3255/.test(g.interior.title),
    "G: el recuadro del expreso no tiene el texto entero en el title (" + g.interior.title + ")");
  }

  /* ── D. CON "PEDIR PARA": las dos tarjetas lado a lado y a la misma altura,
     y nada de hueco debajo (Observaciones ya no está en esa grilla) ────────── */
  const v = await page.evaluate(() => {
    // Si algo estira la columna izquierda (fue el listado al pie, v2.3.507),
    // la grilla no puede repartir ese alto: se reproduce dándole más alto.
    document.querySelector("#carrito .cart-col-left").style.minHeight = "1600px";
    // El selector real (lo dibujó el chequeo F). Si no está, uno a mano.
    let cust = document.getElementById("customerSelectorCart");
    if (!cust) {
      const fila = document.getElementById("shippingSelect").closest(".ship-row");
      cust = document.createElement("div");
      cust.id = "customerSelectorCart";
      cust.className = "ship-row";
      cust.innerHTML =
        '<div class="ship-card"><label class="ship-label">Pedir para (Razón Social)</label>' +
        '<select><option>Retail Plastic SRL</option></select><div class="ship-hint">x</div></div>';
      fila.parentNode.insertBefore(cust, fila);
    }
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
    ") — Observaciones al lado de Confirmar, sin fecha estimada, listado hasta el Subtotal con encabezado fijo, surtido a ancho total");
})().catch((e) => { console.error("checkout-layout: ERROR", e); process.exit(1); });
