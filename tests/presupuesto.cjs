#!/usr/bin/env node
/**
 * tests/presupuesto.cjs — que un cliente en MODO PRESUPUESTO no vea un peso.
 *
 * POR QUÉ EXISTE. `customers.modo_presupuesto` (Classic S.A., Paraguay, pedido
 * de Thomas el 23/09/2026) cambia el comportamiento en ~15 lugares repartidos
 * por script.js. El día que alguien toque uno de ellos sin saber que este modo
 * existe, el síntoma es CARO y silencioso: un cliente de exportación mirando
 * precios argentinos, o —peor— un "$0" en pantalla que parece una lista de
 * regalo. Ninguna de las dos cosas tira un error.
 *
 * Son dos chequeos con naturalezas distintas y los dos hacen falta:
 *
 *   A. ESTÁTICO (leyendo script.js) — que el precio NO SE PIDA. Es lo único
 *      que hace que "no ver precios" sea de verdad y no cosmético: si
 *      `loadProductsFromDB` vuelve a pedir `list_price` siempre, el precio baja
 *      al navegador y queda a un F12 de distancia por más CSS que haya.
 *
 *   B. DE PANTALLA (Chromium, red cortada) — que no quede ni un "$" a la vista.
 *      Esto no se prueba leyendo el archivo: el bug es que un renglón que
 *      calcula sobre un `list_price` inexistente dibuje "$0", y eso sólo se ve
 *      abriendo la página.
 *
 * Verificado mutando el código a propósito: devolviendo siempre la columna
 * `list_price` (cae A) y sacando la clase `is-presupuesto` del <body> (cae B).
 *
 * Correr:  node tests/presupuesto.cjs
 */
const fs = require("fs");
const path = require("path");

const raiz = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(raiz, "script.js"), "utf8");
const css = fs.readFileSync(path.join(raiz, "css", "styles.css"), "utf8");
const fallas = [];
const ok = (m) => console.log("  ok    ·", m);
const mal = (m) => { fallas.push(m); console.log("  FALLA ·", m); };

// ── A. ESTÁTICO ────────────────────────────────────────────────────────────
console.log("A. el precio no se pide (script.js)");

// A1. El select de productos tiene que ser condicional y la rama sin precio NO
//     puede nombrar list_price.
const mSel = src.match(
  /_productsSinPrecio\s*\n?\s*\?\s*"([^"]*)"\s*\n?\s*:\s*"([^"]*)"/,
);
if (!mSel) {
  mal("loadProductsFromDB ya no elige las columnas según _productsSinPrecio");
} else if (mSel[1].includes("list_price")) {
  mal("la rama SIN precio de loadProductsFromDB igual pide list_price");
} else if (!mSel[2].includes("list_price")) {
  mal("la rama CON precio de loadProductsFromDB dejó de pedir list_price");
} else {
  ok("loadProductsFromDB: sin precio no pide list_price, con precio sí");
}

// A2. La línea Loke, lo mismo.
if (!/isPresupuestoMode\(\)\s*\n?\s*\?\s*"id,cod,description,category,uxb/.test(src)) {
  mal("loadLokeProducts volvió a pedir list_price siempre");
} else {
  ok("loadLokeProducts: sin precio no pide list_price");
}

// A3. Los cuatro lugares donde se decide un descuento tienen que mirar el modo.
for (const fn of ["getDtoVol", "getPaymentDiscount", "getPaymentMethodText", "getPaymentMethodCode"]) {
  const i = src.indexOf("function " + fn + "(");
  const cuerpo = i < 0 ? "" : src.slice(i, i + 700);
  if (!cuerpo.includes("isPresupuestoMode()")) {
    mal(fn + " dejó de mirar isPresupuestoMode(): el cliente vuelve a tener descuentos");
  } else {
    ok(fn + " mira isPresupuestoMode()");
  }
}

// A4. Las dos puertas del método de pago. Si alguna vuelve a exigirlo, el botón
//     "Solicitar presupuesto" queda deshabilitado para siempre: el cliente NO
//     puede mandar nada y no hay ningún error que lo explique.
const iRef = src.indexOf("function refreshSubmitEnabled(");
if (!/isPresupuestoMode\(\)/.test(src.slice(iRef, iRef + 1800))) {
  mal("refreshSubmitEnabled volvió a exigir método de pago: el botón nunca se habilita");
} else {
  ok("refreshSubmitEnabled no exige método de pago en presupuesto");
}
if (!/!isPresupuestoMode\(\) &&[\s\S]{0,120}Debes seleccionar un metodo de pago/.test(src)) {
  mal("submitOrder volvió a exigir método de pago en presupuesto");
} else {
  ok("submitOrder no exige método de pago en presupuesto");
}

// A5. El aviso para la PPP de Gestión. Es lo ÚNICO que separa un presupuesto de
//     un pedido cualquiera en "A Programar": sin esto lo pickean y lo despachan.
if (!src.includes("PRESUPUESTO — NO DESPACHAR, COTIZAR")) {
  mal("se perdió el aviso 'PRESUPUESTO — NO DESPACHAR, COTIZAR' de observaciones");
} else {
  ok("observaciones lleva el aviso para la PPP");
}
if (!/tipo_documento: esPresupuesto \? "presupuesto" : "pedido"/.test(src)) {
  mal("la ficha (sheets_payload) perdió tipo_documento");
} else {
  ok("sheets_payload lleva tipo_documento");
}

// A6. El RUC paraguayo tiene 9 dígitos: con el piso en 10 no se puede ni entrar.
const iLL = src.indexOf("function looksLikeCUIT(");
if (!/cleaned\.length >= 8/.test(src.slice(iLL, iLL + 600))) {
  mal("looksLikeCUIT volvió a exigir 10 dígitos: el RUC paraguayo no puede loguearse");
} else {
  ok("looksLikeCUIT acepta el RUC paraguayo (9 dígitos)");
}

// A7. El CSS que tapa los renglones en $0.
for (const sel of [".is-presupuesto .card-prices", ".is-presupuesto .cart-total"]) {
  if (!css.includes(sel)) mal("falta la regla " + sel + " en css/styles.css");
  else ok("css: " + sel);
}

// ── B. DE PANTALLA ─────────────────────────────────────────────────────────
let chromium;
try { ({ chromium } = require("/opt/node22/lib/node_modules/playwright")); }
catch (_e) {
  try { ({ chromium } = require("playwright")); }
  catch (_e2) { chromium = null; }
}

(async () => {
  if (!chromium) {
    console.log("\nB. de pantalla: SALTEADO — no hay playwright");
  } else {
    console.log("\nB. no queda ni un '$' a la vista (Chromium)");
    const browser = await chromium.launch();
    const ctx = await browser.newContext();
    // Red cortada: ni CDN ni Supabase.
    await ctx.route("**://**", (r) =>
      r.request().url().startsWith("file:") ? r.continue() : r.fulfill({ status: 200, body: "" }),
    );
    const page = await ctx.newPage();
    page.on("dialog", (d) => d.dismiss().catch(() => {}));
    await page.addInitScript(() => {
      const resp = { data: [], error: null };
      const q = {
        select: () => q, eq: () => q, order: () => q, limit: () => q,
        maybeSingle: () => Promise.resolve(resp), single: () => Promise.resolve(resp),
        insert: () => q, then: (f) => Promise.resolve(resp).then(f),
      };
      window.supabase = {
        createClient: () => ({
          from: () => q,
          rpc: () => Promise.resolve({ data: null, error: null }),
          auth: {
            getSession: () => Promise.resolve({ data: { session: null } }),
            onAuthStateChange: () => {},
          },
        }),
      };
    });
    await page.goto("file://" + path.join(raiz, "mayorista.html"));
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(
      () => typeof window.isPresupuestoMode === "function" && typeof window.renderProducts === "function",
      null, { timeout: 15000 },
    );

    // Se simula el RESULTADO de estar logueado como Classic S.A.: sesión, perfil
    // con la bandera y productos SIN list_price, que es exactamente lo que
    // devuelve loadProductsFromDB en este modo.
    const res = await page.evaluate(() => {
      currentSession = { user: { id: "00000000-0000-0000-0000-000000000000" } };
      isAdmin = false;
      customerProfile = {
        id: "c1", business_name: "CLASSIC S.A.", cod_cliente: 1362,
        cuit: "800130570", dto_vol: 0.05, modo_presupuesto: true,
      };
      products = [{
        id: "p1", cod: "505", category: "Peladores", description: "Pelapapas",
        uxb: 12, images: [], badge_status: null, active: true,
      }];
      _presupuestoSyncUI();
      renderProducts();
      updateCart();

      // El carrito arranca sin .active: sin esto NADA de adentro se renderiza y
      // el test mediría el display de la sección, no el de los renglones.
      document.querySelectorAll(".section.active").forEach((s) => s.classList.remove("active"));
      document.getElementById("carrito").classList.add("active");
      document.getElementById("productos").classList.add("active");

      const cont = document.getElementById("productsContainer");
      const carrito = document.getElementById("carrito");
      // ⚠ NO sirve mirar getComputedStyle(el).display: dentro de un padre en
      // display:none, Chrome igual devuelve "block" para el hijo. Lo que dice si
      // algo se está DIBUJANDO de verdad son sus rects.
      const visible = (el) => !!el && el.getClientRects().length > 0;
      const textoVisible = (raiz) => {
        if (!raiz) return "";
        let out = "";
        raiz.querySelectorAll("*").forEach((el) => {
          if (el.getClientRects().length === 0) return;
          if (getComputedStyle(el).visibility === "hidden") return;
          for (const nodo of el.childNodes) {
            if (nodo.nodeType === 3) out += nodo.nodeValue + " ";
          }
        });
        return out;
      };
      return {
        clase: document.body.classList.contains("is-presupuesto"),
        textoFichas: textoVisible(cont),
        textoCarrito: textoVisible(carrito),
        pagoVisible: visible(document.getElementById("paymentRow")),
        totalesVisible: visible(document.querySelector("#carrito .cart-total")),
        botonTxt: (document.getElementById("submitOrderBtn") || {}).textContent || "",
        tituloCarrito: (document.querySelector("#carrito .section-title") || {}).textContent || "",
        dtoVol: getDtoVol(),
        dtoPago: getPaymentDiscount(),
        condPago: getPaymentMethodText(),
      };
    });
    await browser.close();

    if (!res.clase) mal("el <body> no quedó con la clase is-presupuesto");
    else ok("el <body> lleva is-presupuesto");

    if (/\$/.test(res.textoFichas)) mal("quedó un '$' visible en la ficha del producto: " + res.textoFichas.trim().slice(0, 120));
    else ok("la ficha del producto no muestra ningún '$'");

    if (/\$/.test(res.textoCarrito)) mal("quedó un '$' visible en el carrito: " + res.textoCarrito.trim().slice(0, 120));
    else ok("el carrito no muestra ningún '$'");

    if (res.pagoVisible) mal("el bloque de método de pago sigue visible");
    else ok("método de pago oculto");

    if (res.totalesVisible) mal("el bloque de totales sigue visible");
    else ok("totales ocultos");

    if (!/presupuesto/i.test(res.botonTxt)) mal('el botón sigue diciendo "' + res.botonTxt.trim() + '"');
    else ok('el botón dice "' + res.botonTxt.trim() + '"');

    if (!/presupuesto/i.test(res.tituloCarrito)) mal('el título del carrito sigue diciendo "' + res.tituloCarrito.trim() + '"');
    else ok("el título del carrito dice Presupuesto");

    // El cliente TIENE dto_vol 5% cargado: el modo tiene que ignorarlo.
    if (res.dtoVol !== 0) mal("getDtoVol devolvió " + res.dtoVol + " teniendo dto_vol cargado");
    else ok("getDtoVol ignora el dto x volumen del cliente");
    if (res.dtoPago !== 0) mal("getPaymentDiscount devolvió " + res.dtoPago);
    else ok("getPaymentDiscount en 0");
    if (!/PRESUPUESTO/i.test(res.condPago)) mal("la condición de pago dice '" + res.condPago + "'");
    else ok("la condición de pago avisa que es un presupuesto");
  }

  console.log("");
  if (fallas.length) {
    console.error("presupuesto: EN ROJO — " + fallas.length + " problema(s)");
    process.exit(1);
  }
  console.log("presupuesto: OK — no se pide el precio, no se ve un peso y el envío no se traba.");
})();
