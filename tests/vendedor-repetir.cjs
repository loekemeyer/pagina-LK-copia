#!/usr/bin/env node
/**
 * tests/vendedor-repetir.cjs — "Repetir pedidos" del panel del vendedor
 * (Gastón, 02/10/2026). Corre mayorista.html en Chromium contra una base falsa.
 *
 * Lo que tiene que pasar:
 *   A. La tarjeta sale SÓLO para el vendedor en su perfil y lista lo que
 *      devuelve la RPC vend_repetir_pedidos (el control de "sus clientes" es del
 *      server: sql/vendedor_repetir_pedidos.sql). Un cliente común no la ve.
 *   B. Si la RPC falla, la tarjeta lo DICE ("no se pudo cargar"), no muestra
 *      "no tienen pedidos" (una lectura rota no es un cero).
 *   C. "Repetir" abre el asistente con la razón social del pedido y la
 *      sucursal original preseleccionadas; cambiar la razón social recarga las
 *      sucursales de ESA razón social (y con una sola, la elige sola).
 *   D. "Copiar al carrito" sólo se habilita con razón social + sucursal + pago.
 *      Al confirmar: el carrito anterior se reemplaza (pregunta antes), el
 *      cliente del pedido pasa a ser la razón social elegida, la sucursal y el
 *      método de pago quedan puestos, los artículos SIN STOCK no se copian y
 *      se avisa, y se abre el carrito para editar antes de enviar.
 *   E. Los renglones del pedido se piden por RPC (vend_repetir_pedido_items),
 *      no leyendo order_items: la RLS de esa tabla sólo deja ver lo propio.
 *
 * Correr:  node tests/vendedor-repetir.cjs
 */
const path = require("path");
let chromium;
try { ({ chromium } = require("/opt/node22/lib/node_modules/playwright")); }
catch (_e) {
  try { ({ chromium } = require("playwright")); }
  catch (_e2) { console.error("vendedor-repetir: SALTEADO — no hay playwright"); process.exit(0); }
}

const raiz = process.argv[2] ? path.resolve(__dirname, "..", process.argv[2]) : path.join(__dirname, "..");
const fallas = [];
const ok = (c, m) => { if (!c) fallas.push(m); };

const PRODS = Array.from({ length: 6 }, (_, i) => ({
  id: "p-" + i, cod: String(500 + i), category: "Peladores", subcategory: null,
  ranking: i + 1, orden_catalogo: i + 1, description: "Artículo " + i,
  uxb: 12, list_price: 1000 + i, images: [], active: true,
  badge_status: i === 2 ? "SIN STOCK" : null,
}));

async function correr(rpcFalla) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  await ctx.route("**://**", (r) =>
    r.request().url().startsWith("file:") ? r.continue() : r.fulfill({ status: 200, body: "" }),
  );
  const page = await ctx.newPage();
  const errores = [];
  page.on("pageerror", (e) => errores.push(e.message));
  await page.addInitScript(({ prods, rpcFalla }) => {
    window.__rpcLlamadas = [];
    window.__tablasLeidas = [];
    const vacio = { data: [], error: null };
    const SUC = {
      c1: [ { slot: 1, label: "Depósito Norte" }, { slot: 2, label: "Local Centro" } ],
      c2: [ { slot: 1, label: "Única c2" } ],
    };
    const mk = (tabla) => {
      window.__tablasLeidas.push(tabla);
      const f = {};
      const datos = () => {
        if (tabla === "customers" && f.id)
          return { id: f.id, business_name: "Cliente " + f.id, dto_vol: 0, cod_cliente: f.id === "c1" ? "100" : "101", cuit: "30711111110" };
        if (tabla === "customer_delivery_addresses") return SUC[f.customer_id] || [];
        if (tabla === "products") return prods; // con sesión el catálogo sale de la tabla
        return null;
      };
      const q = {
        select: () => q, in: () => q, order: () => q, limit: () => q, gte: () => q,
        eq: (c, v) => { f[c] = v; return q; },
        single: () => Promise.resolve({ data: datos(), error: null }),
        maybeSingle: () => Promise.resolve({ data: datos(), error: null }),
        insert: () => q, update: () => q, upsert: () => q,
        then: (a, b) => Promise.resolve({ data: Array.isArray(datos()) ? datos() : [], error: null }).then(a, b),
      };
      return q;
    };
    const rpc = (n, args) => {
      window.__rpcLlamadas.push([n, args]);
      if (n === "get_products_public_sorted") return Promise.resolve({ data: prods, error: null });
      if (n === "vend_repetir_pedidos") {
        if (rpcFalla) return Promise.resolve({ data: null, error: { message: "timeout" } });
        return Promise.resolve({ data: [
          { order_id: 1577, created_at: "2026-09-30T14:30:00Z", customer_id: "c1", cod_cliente: 100,
            razon_social: "Cliente c1", sucursal: "Local Centro", condicion_pago: "Pago 15-30 días: 20% Dto",
            payment_discount: 0.2, total: 1129747.92, articulos: 3, cajas: 7, origen: "Web" },
          { order_id: 1560, created_at: "2026-09-20T10:00:00Z", customer_id: "c2", cod_cliente: 101,
            razon_social: "Cliente c2", sucursal: "Única c2", condicion_pago: "Contado",
            payment_discount: 0.25, total: 50000, articulos: 1, cajas: 2, origen: "Web" },
        ], error: null });
      }
      if (n === "vend_repetir_pedido_items")
        return Promise.resolve({ data: [
          { product_id: "p-0", loke_product_id: null, is_loke: false, cajas: 3, uxb: 12 },
          { product_id: "p-1", loke_product_id: null, is_loke: false, cajas: 2, uxb: 12 },
          { product_id: "p-2", loke_product_id: null, is_loke: false, cajas: 2, uxb: 12 },
        ], error: null });
      return Promise.resolve(vacio);
    };
    window.supabase = {
      createClient: () => ({
        from: (t) => mk(t), rpc,
        auth: { getSession: () => Promise.resolve({ data: { session: null } }), onAuthStateChange: () => {} },
        storage: { from: () => ({ getPublicUrl: () => ({ data: { publicUrl: "" } }) }) },
      }),
    };
  }, { prods: PRODS, rpcFalla });

  await page.goto("file://" + path.join(raiz, "mayorista.html"));
  await page.waitForFunction(() => typeof window.updateCart === "function", null, { timeout: 15000 });
  return { browser, page, errores };
}

const prepVendedor = () => {
  _vendorOwnProfile = { id: "v1", cod_cliente: "10006", business_name: "Vendedor Prueba", dto_vol: 0, vend: "6" };
  customerProfile = Object.assign({}, _vendorOwnProfile);
  currentSession = { user: { id: "u-v1" } };
  linkedCustomers = [
    { customer_id: "c1", cod_cliente: "100", business_name: "Cliente c1" },
    { customer_id: "c2", cod_cliente: "101", business_name: "Cliente c2" },
  ];
};

(async () => {
  /* ── B. RPC caída: se dice, no se muestra "no tienen pedidos" ── */
  {
    const { browser, page } = await correr(true);
    const b = await page.evaluate(async (prep) => {
      eval("(" + prep + ")")();
      await loadVendorRepetirUI();
      return document.getElementById("vendorRepetirBox").textContent;
    }, prepVendedor.toString());
    ok(/no se pudo cargar/i.test(b) && !/no tienen pedidos/i.test(b),
      "B: con la RPC caída la tarjeta no dice que falló (" + JSON.stringify(b) + ")");
    await browser.close();
  }

  const { browser, page, errores } = await correr(false);

  /* ── A. Cliente común: no ve la tarjeta. Vendedor: la ve con lo de la RPC ── */
  const a0 = await page.evaluate(async () => {
    currentSession = { user: { id: "u-c" } };
    _vendorOwnProfile = null;
    customerProfile = { id: "c9", business_name: "Común", dto_vol: 0, cod_cliente: "999" };
    await loadVendorRepetirUI();
    return { hidden: document.getElementById("vendorRepetirCard").hidden,
      llamo: window.__rpcLlamadas.some((x) => x[0] === "vend_repetir_pedidos") };
  });
  ok(a0.hidden && !a0.llamo, "A: un cliente común ve la tarjeta Repetir pedidos o se llamó la RPC (" + JSON.stringify(a0) + ")");

  await page.evaluate(async (n) => {
    await window.loadProductsFromDB();
    const sec = document.getElementById("perfil");
    document.querySelectorAll(".section.active").forEach((s) => s.classList.remove("active"));
    sec.classList.add("active"); sec.style.display = "block";
  });
  const a = await page.evaluate(async (prep) => {
    eval("(" + prep + ")")();
    renderCustomerSelector();
    await loadVendorRepetirUI();
    const card = document.getElementById("vendorRepetirCard");
    return { hidden: card.hidden, filas: card.querySelectorAll(".vrep-tabla tbody tr").length,
      texto: card.textContent };
  }, prepVendedor.toString());
  ok(!a.hidden && a.filas === 2, "A: el vendedor no ve sus 2 pedidos (" + JSON.stringify({ h: a.hidden, f: a.filas }) + ")");
  ok(/1\.129\.748/.test(a.texto) && /Local Centro/.test(a.texto), "A: la fila no muestra total y sucursal");

  /* ── C. El asistente ── */
  const c = await page.evaluate(async () => {
    // carrito previo de otra cosa: se tiene que preguntar antes de reemplazarlo
    cart.splice(0, cart.length, { productId: "p-5", qtyCajas: 9, source: "catalogo" });
    abrirRepetirPedido(1577);
    await new Promise((r) => setTimeout(r, 200));
    const b = () => document.getElementById("vrepBody");
    const r = {
      abierto: document.getElementById("modalRepetir").classList.contains("open"),
      cli: document.getElementById("vrepCliente").value,
      suc: (document.getElementById("vrepSucursal") || {}).value,
      pagos: b().querySelectorAll(".vrep-pago").length,
      okDis: b().querySelector(".vrep-ok").disabled,
    };
    vrepElegirCliente("c2");
    await new Promise((r2) => setTimeout(r2, 200));
    r.suc2 = (document.getElementById("vrepSucursal") || {}).value;
    r.opc2 = document.querySelectorAll("#vrepSucursal option:not([disabled])").length;
    vrepElegirPago("0.20");
    r.okDis2 = b().querySelector(".vrep-ok").disabled;
    return r;
  });
  ok(c.abierto && c.cli === "c1" && c.suc === "2",
    "C: el asistente no arranca con la razón social y la sucursal del pedido (" + JSON.stringify(c) + ")");
  ok(c.pagos === 7 && c.okDis, "C: faltan los 7 métodos de pago o \"Copiar\" está habilitado sin elegir pago");
  ok(c.suc2 === "1" && c.opc2 === 1, "C: al cambiar la razón social no se cargaron sus sucursales (" + JSON.stringify(c) + ")");
  ok(!c.okDis2, "C: con razón social, sucursal y pago, \"Copiar al carrito\" sigue deshabilitado");

  /* ── D. Copiar al carrito ── */
  const d = await page.evaluate(async () => {
    const preguntas = [];
    const realConfirm = window.confirm;
    window.confirm = (m) => { preguntas.push(m); return true; };
    await confirmarRepetirPedido();
    await new Promise((r) => setTimeout(r, 300));
    window.confirm = realConfirm;
    return {
      preguntas,
      cart: cart.map((x) => x.productId + "x" + x.qtyCajas + ":" + x.source),
      cliente: customerProfile && customerProfile.id,
      sel: document.getElementById("customerSelectCart").value,
      suc: document.getElementById("shippingSelect").value,
      slot: deliveryChoice && deliveryChoice.slot,
      pago: document.getElementById("paymentSelect").value,
      carrito: document.getElementById("carrito").classList.contains("active"),
      modal: document.getElementById("modalRepetir").classList.contains("open"),
      aviso: (document.getElementById("orderStatus") || {}).textContent || "",
      items: window.__rpcLlamadas.filter((x) => x[0] === "vend_repetir_pedido_items").map((x) => x[1]),
      leyoOrderItems: window.__tablasLeidas.includes("order_items"),
    };
  });
  ok(d.preguntas.length === 1 && /se reemplaza/i.test(d.preguntas[0]),
    "D: no preguntó antes de reemplazar el carrito que había (" + JSON.stringify(d.preguntas) + ")");
  ok(JSON.stringify(d.cart) === JSON.stringify(["p-0x3:repetir_vendedor", "p-1x2:repetir_vendedor"]),
    "D: el carrito no quedó con la copia (sin el SIN STOCK): " + JSON.stringify(d.cart));
  ok(d.cliente === "c2" && d.sel === "c2", "D: el pedido no quedó para la razón social elegida (" + d.cliente + ")");
  ok(d.suc === "1" && String(d.slot) === "1", "D: la sucursal elegida no quedó puesta (" + d.suc + "/" + d.slot + ")");
  ok(d.pago === "0.20", "D: el método de pago elegido no quedó puesto (" + d.pago + ")");
  ok(d.carrito && !d.modal, "D: no se abrió el carrito o el asistente quedó abierto");
  ok(/#1577/.test(d.aviso) && /502/.test(d.aviso), "D: el aviso no dice qué pedido se copió y qué no se copió por stock (" + d.aviso + ")");

  /* ── E. Los renglones salen de la RPC, no de order_items ── */
  ok(d.items.length === 1 && d.items[0].p_order_id === 1577 && !d.leyoOrderItems,
    "E: los renglones no se pidieron por vend_repetir_pedido_items (" + JSON.stringify(d.items) + ", order_items=" + d.leyoOrderItems + ")");

  ok(!errores.length, "errores de página: " + errores.join(" | "));
  await browser.close();

  if (fallas.length) {
    console.error("vendedor-repetir: FALLA (" + path.basename(raiz) + ")");
    fallas.forEach((f) => console.error("  · " + f));
    process.exit(1);
  }
  console.log("vendedor-repetir: OK (" + path.basename(raiz) + ") — sólo vendedor, razón social → sucursal → pago, copia editable en el carrito");
})().catch((e) => { console.error("vendedor-repetir: ERROR", e); process.exit(1); });
