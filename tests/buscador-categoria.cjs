#!/usr/bin/env node
/**
 * tests/buscador-categoria.cjs — el buscador también encuentra por CATEGORÍA, y
 * el carrito tiene "Vaciar carrito".
 *
 * POR QUÉ EXISTE (30/09/2026). Dos pedidos juntos:
 *
 *   1. Buscar "vidrio" no daba nada: ninguna descripción de la categoría Vidrio
 *      dice "vidrio" (medido: 0 de 4). Ahora el buscador suma a lo que matchea
 *      por código/descripción la categoría o subcategoría ENTERA cuyo nombre
 *      coincida. Es unión: "madera" trae los artículos que lo dicen en la
 *      descripción (22 en toda la base) MÁS la categoría Madera (15) y la
 *      subcategoría Utensilios › Madera (7, de los que sólo 1 dice "madera").
 *   2. El carrito se vaciaba sacando las líneas de a una.
 *
 * Levanta mayorista.html en Chromium con la red CORTADA y un Supabase falso, y
 * escribe en el buscador de verdad (#navSearch, evento input). Verifica:
 *   A. "vidrio" trae la categoría Vidrio entera
 *   B. "madera" trae categoría + subcategoría + los de otra categoría que lo
 *      dicen en la descripción, y NO los que no tienen nada que ver
 *   C. el orden de las categorías no cambia (Utensilios antes que Madera)
 *   D. código y descripción siguen buscando como antes
 *   E. "Vaciar carrito" aparece con líneas, cancelar no toca nada, aceptar vacía
 *      el carrito Y el localStorage
 *   F. en modo edición el botón no se dibuja (las líneas del pedido no se pueden
 *      sacar; para eso está "Cancelar edición")
 *
 * Correr:  node tests/buscador-categoria.cjs
 */
const path = require("path");
let chromium;
try { ({ chromium } = require("/opt/node22/lib/node_modules/playwright")); }
catch (_e) {
  try { ({ chromium } = require("playwright")); }
  catch (_e2) { console.error("buscador-categoria: SALTEADO — no hay playwright"); process.exit(0); }
}

const P = (id, cod, category, subcategory, description, orden) => ({
  id, cod, category, subcategory, ranking: orden, orden_catalogo: orden,
  description, uxb: 12, images: [], badge_status: null,
});
// Forma real de la base (30/09): Vidrio sin "vidrio" en la descripción,
// Madera con y sin la palabra, la subcategoría Utensilios › Madera, y un
// artículo de otra categoría que dice "madera".
const PRODS = [
  P("v-1", "901", "Vidrio", null, "Frasco hermetico 1 litro", 1),
  P("v-2", "902", "Vidrio", null, "Jarra 1,5 litros", 2),
  P("m-1", "701", "Madera", null, "Tabla de madera grande", 3),
  P("m-2", "702", "Madera", null, "Palo de amasar", 4),
  P("u-1", "601", "Utensilios", "Madera", "Cuchara de haya", 5),
  P("u-2", "602", "Utensilios", "Silicona", "Espatula flexible", 6),
  P("c-1", "505", "Peladores", null, "Pelador mango madera", 7),
  P("c-2", "504", "Afiladores", null, "Afila cuchillos", 8),
];

(async () => {
  const fallas = [];
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await ctx.route("**://**", (r) => {
    const u = r.request().url();
    if (u.startsWith("file:")) return r.continue();
    return r.fulfill({ status: 200, body: "" });
  });

  const page = await ctx.newPage();
  const errores = [];
  page.on("pageerror", (e) => errores.push(String(e && e.message || e)));
  // El confirm() de "Vaciar carrito" lo decide cada caso con esta bandera.
  let aceptarDialogo = false;
  page.on("dialog", (d) => (aceptarDialogo ? d.accept() : d.dismiss()).catch(() => {}));

  await page.addInitScript((prods) => {
    const vacio = { data: [], error: null };
    const q = {
      select: () => q, eq: () => q, in: () => q, order: () => q, limit: () => q,
      single: () => Promise.resolve({ data: null, error: null }),
      insert: () => q, update: () => q, upsert: () => q,
      then: (f) => Promise.resolve(vacio).then(f),
    };
    window.supabase = {
      createClient: () => ({
        from: () => q,
        rpc: (name) =>
          name === "get_products_public_sorted"
            ? Promise.resolve({ data: prods, error: null })
            : Promise.resolve(vacio),
        auth: {
          getSession: () => Promise.resolve({ data: { session: null } }),
          onAuthStateChange: () => {},
        },
        storage: { from: () => ({ getPublicUrl: () => ({ data: { publicUrl: "" } }) }) },
      }),
    };
  }, PRODS);

  await page.goto("file://" + path.join(__dirname, "..", "mayorista.html"));
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => typeof window.renderProducts === "function", null, { timeout: 15000 });
  await page.evaluate(async () => {
    await window.loadProductsFromDB();
    window.renderProducts();
  });

  // Escribe en el buscador REAL y devuelve qué cards y qué títulos quedaron.
  const buscar = (txt) =>
    page.evaluate((t) => {
      const inp = document.getElementById("navSearch");
      if (!inp) return null;
      inp.value = t;
      inp.dispatchEvent(new Event("input", { bubbles: true }));
      const cont = document.getElementById("productsContainer");
      return {
        ids: [...cont.querySelectorAll("[id^='card-']")].map((n) => n.id.slice(5)).sort(),
        cats: [...cont.querySelectorAll(".category-title")].map((n) => n.textContent.trim()),
      };
    }, txt);

  const igual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  const base = await buscar("");
  if (!base) fallas.push("0: no hay #navSearch en mayorista.html");
  else if (base.ids.length !== PRODS.length)
    fallas.push(`0: sin búsqueda deberían verse ${PRODS.length} cards y se ven ${base.ids.length}`);

  if (base) {
    // A. categoría sin la palabra en la descripción
    const a = await buscar("Vidrio");
    if (!igual(a.ids, ["v-1", "v-2"]))
      fallas.push(`A: "Vidrio" debería traer la categoría entera (v-1, v-2) y trajo [${a.ids}]`);

    // B. unión: categoría + subcategoría + descripción, y nada más
    const b = await buscar("madera");
    const esperado = ["c-1", "m-1", "m-2", "u-1"];
    if (!igual(b.ids, esperado))
      fallas.push(`B: "madera" debería traer [${esperado}] y trajo [${b.ids}]`);

    // C. el orden fijo de categorías se respeta (CATEGORY_ORDER)
    if (!igual(b.cats, ["Peladores", "Utensilios", "Madera"]))
      fallas.push(`C: el orden de categorías cambió: [${b.cats}]`);

    // D. lo de antes sigue andando: código, descripción y sin acentos
    const d1 = await buscar("504");
    if (!igual(d1.ids, ["c-2"])) fallas.push(`D: buscar por código "504" trajo [${d1.ids}]`);
    const d2 = await buscar("espátula");
    if (!igual(d2.ids, ["u-2"])) fallas.push(`D: "espátula" (con acento) trajo [${d2.ids}]`);
    const d3 = await buscar("zzz");
    if (d3.ids.length) fallas.push(`D: "zzz" debería no traer nada y trajo [${d3.ids}]`);
    await buscar("");
  }

  // E. Vaciar carrito
  const estadoCarrito = () =>
    page.evaluate(() => ({
      n: cart.length,
      boton: !!document.querySelector("#cart .cart-vaciar-btn"),
      ls: (() => { try { return JSON.parse(localStorage.getItem(CART_LS_KEY) || "[]").length; } catch (e) { return -1; } })(),
    }));

  await page.evaluate(() => {
    cart.splice(0, cart.length,
      { productId: "v-1", qtyCajas: 2, source: "catalogo" },
      { productId: "m-1", qtyCajas: 1, source: "catalogo" });
    window.updateCart();
  });
  let e = await estadoCarrito();
  if (!e.boton) fallas.push("E: con 2 líneas en el carrito no se dibujó el botón Vaciar carrito");

  aceptarDialogo = false;
  await page.evaluate(() => document.querySelector("#cart .cart-vaciar-btn")?.click());
  e = await estadoCarrito();
  if (e.n !== 2) fallas.push(`E: cancelando el confirm el carrito cambió (quedaron ${e.n} líneas)`);

  aceptarDialogo = true;
  await page.evaluate(() => document.querySelector("#cart .cart-vaciar-btn")?.click());
  e = await estadoCarrito();
  if (e.n !== 0) fallas.push(`E: aceptando, el carrito quedó con ${e.n} líneas`);
  if (e.ls !== 0) fallas.push(`E: aceptando, el localStorage quedó con ${e.ls} líneas (vuelve con F5)`);
  if (e.boton) fallas.push("E: con el carrito vacío sigue el botón Vaciar carrito");

  // F. modo edición: no se ofrece
  const f = await page.evaluate(() => {
    cart.splice(0, cart.length, { productId: "v-1", qtyCajas: 2, source: "catalogo" });
    setEditingOrderId("9999", { "v-1": 2 });
    window.updateCart();
    const hay = !!document.querySelector("#cart .cart-vaciar-btn");
    window.vaciarCarrito(); // aunque alguien la llame igual, no toca nada
    const n = cart.length;
    setEditingOrderId(null);
    return { hay, n };
  });
  if (f.hay) fallas.push("F: en modo edición se dibujó Vaciar carrito");
  if (f.n !== 1) fallas.push("F: en modo edición vaciarCarrito() sacó líneas del pedido");

  if (errores.length) fallas.push("errores de JS en la página: " + errores.join(" | "));

  await browser.close();
  if (fallas.length) {
    console.error("buscador-categoria: ROJO");
    fallas.forEach((x) => console.error("  · " + x));
    process.exit(1);
  }
  console.log("buscador-categoria: OK — categoría en el buscador (A-D) y Vaciar carrito (E-F)");
})().catch((err) => {
  console.error("buscador-categoria: ERROR", err);
  process.exit(1);
});
