#!/usr/bin/env node
/**
 * tests/carrito-animacion.cjs — que agregar al carrito NO apague la foto de la
 * card, y que la animación de "volar al carrito" efectivamente arranque.
 *
 * POR QUÉ EXISTE (24/09/2026). Desde la v2.3.452 las cards con 2ª foto nacen
 * con `data-src` (carga diferida propia, para Chrome 109). Pero `renderProducts()`
 * rehace la grilla ENTERA en cada cambio del carrito, así que cada "agregar al
 * pedido" devolvía TODAS esas fotos a `data-src`: quedaban sin `src` hasta que
 * el IntersectionObserver las volvía a resolver un frame después. Eso rompía
 * dos cosas a la vez, y las dos las reportó el usuario:
 *
 *   · la página TEMBLABA — en desktop manda
 *     `#productsContainer .product-card img { width:auto!important; height:auto!important }`,
 *     o sea que el alto lo da la imagen; una <img> sin src mide 0 y la card se
 *     desploma y vuelve.
 *   · la ANIMACIÓN desaparecía — `flyProductImageToCart` mide la foto y corta
 *     en seco si el rect da 0, así que ni siquiera empezaba.
 *
 * Levanta mayorista.html en Chromium con la red CORTADA, mete dos productos de
 * dos fotos por el RPC público, renderiza, espera a que la foto cargue, y
 * vuelve a renderizar (que es lo que hace un "agregar"). Verifica:
 *   1. tras el re-render la foto sigue con `src` (no volvió a `data-src`)
 *   2. tras el re-render la card mide lo mismo que antes (no se desploma)
 *   3. `flyProductImageToCart` deja el clon .fly-to-cart en el DOM, con foto
 *
 * Verificado en rojo mutando el código: volviendo `_pcAttrFoto` a devolver
 * siempre `data-src` fallan los tres puntos.
 *
 * Correr:  node tests/carrito-animacion.cjs
 */
const path = require("path");
let chromium;
try { ({ chromium } = require("/opt/node22/lib/node_modules/playwright")); }
catch (_e) {
  try { ({ chromium } = require("playwright")); }
  catch (_e2) { console.error("carrito-animacion: SALTEADO — no hay playwright"); process.exit(0); }
}

// Dos fotos por producto → camino .pc-persiana, que es el que tenía el bug.
const PRODS = [
  { id: "p-1", cod: "505", category: "Peladores", subcategory: null, ranking: 1,
    orden_catalogo: 1, description: "Pelador de prueba", uxb: 12,
    images: ["505-2.webp", "505.webp"], badge_status: null },
  { id: "p-2", cod: "504", category: "Afiladores", subcategory: null, ranking: 2,
    orden_catalogo: 2, description: "Afilador de prueba", uxb: 12,
    images: ["504-2.webp", "504.webp"], badge_status: null },
];

(async () => {
  const fallas = [];
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });

  // Nada sale a la red. Las fotos del bucket se responden con un JPG REAL del
  // repo: sin una imagen que cargue de verdad la <img> mide 0 y el test estaría
  // midiendo el stub, no el bug.
  const FOTO = path.join(__dirname, "..", "img", "no-image.jpg");
  await ctx.route("**://**", (r) => {
    const u = r.request().url();
    if (u.startsWith("file:")) return r.continue();
    if (r.request().resourceType() === "image" || /\.(webp|jpe?g|png)(\?|$)/i.test(u))
      return r.fulfill({ status: 200, contentType: "image/jpeg", path: FOTO });
    return r.fulfill({ status: 200, body: "" });
  });

  const page = await ctx.newPage();
  page.on("dialog", (d) => d.dismiss().catch(() => {}));

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

  // Sección de productos visible: si no, todo mide 0 y el test se mentiría solo.
  await page.evaluate(() => {
    const cont = document.getElementById("productsContainer");
    const sec = cont && cont.closest(".section");
    if (sec) {
      document.querySelectorAll(".section.active").forEach((s) => s.classList.remove("active"));
      sec.classList.add("active");
      sec.style.display = "block";
    }
  });

  await page.evaluate(async () => {
    await window.loadProductsFromDB();
    window.renderProducts();
  });

  // Primer pintado: la carga diferida le tiene que poner el src.
  await page.waitForFunction(
    () => {
      const i = document.getElementById("img-p-1");
      return !!i && !i.hasAttribute("data-src") && !!i.getAttribute("src")
        && i.complete && i.naturalWidth > 0;
    },
    null,
    { timeout: 10000 },
  ).catch(() => fallas.push("0: la foto nunca salió del lazy en el primer render"));

  // ⚠ TODO EL BUG DURA UN FRAME. El IntersectionObserver entrega sus avisos
  // DESPUÉS de los requestAnimationFrame, así que hay que medir en el mismo
  // frame en que mide la animación real: si acá se hace un page.evaluate()
  // aparte para medir, el observer ya devolvió el src y el test pasa siempre,
  // esté el bug o no (probado: con el arreglo revertido daba verde igual).
  const r = await page.evaluate(
    () =>
      new Promise((res) => {
        const cardAntes = document.getElementById("card-p-1").getBoundingClientRect().height;
        const fotoAntes = document.getElementById("img-p-1").getBoundingClientRect().height;

        // Esto es lo que hace un "agregar al pedido": rehace la grilla entera.
        window.renderProducts();

        // …y esto es lo que hace triggerAddAnimations() justo después.
        requestAnimationFrame(() => {
          const i = document.getElementById("img-p-1");
          const b = document.querySelector("#card-p-1 img.pc-back");
          document.querySelectorAll(".fly-to-cart").forEach((n) => n.remove());
          window.flyProductImageToCart("p-1");
          const c = document.querySelector(".fly-to-cart");
          const cr = c ? c.getBoundingClientRect() : null;
          res({
            cardAntes,
            fotoAntes,
            frontLazy: i ? i.hasAttribute("data-src") : null,
            frontSrc: i ? i.getAttribute("src") : null,
            backLazy: b ? b.hasAttribute("data-src") : null,
            cardDespues: document.getElementById("card-p-1").getBoundingClientRect().height,
            fotoDespues: i ? i.getBoundingClientRect().height : 0,
            vuelo: c ? { src: c.getAttribute("src") || "", w: cr.width, h: cr.height } : null,
            dobles: document.querySelectorAll("[id='img-p-1']").length,
          });
        });
      }),
  );

  if (!r.cardAntes || !r.fotoAntes) fallas.push("0: la card no medía nada antes de agregar");

  // 1. la foto NO volvió al lazy
  if (r.frontLazy)
    fallas.push("1: tras el re-render la foto de adelante volvió a data-src — queda un frame sin src y la página tiembla");
  if (r.backLazy) fallas.push("1: tras el re-render la 2ª foto volvió a data-src");
  if (!r.frontSrc) fallas.push("1: tras el re-render la foto quedó sin src");

  // 2. y nada se desploma en ese frame
  if (Math.abs(r.fotoDespues - r.fotoAntes) > 2)
    fallas.push(`2: la FOTO cambió de alto en el frame del re-render (${r.fotoAntes.toFixed(0)}px → ${r.fotoDespues.toFixed(0)}px): eso es el temblor`);
  if (Math.abs(r.cardDespues - r.cardAntes) > 2)
    fallas.push(`2: la CARD cambió de alto en el frame del re-render (${r.cardAntes.toFixed(0)}px → ${r.cardDespues.toFixed(0)}px): eso es el temblor`);

  // 3. la animación arranca de verdad: deja el clon colgado de <body>
  if (!r.vuelo)
    fallas.push("3: flyProductImageToCart no dejó ningún .fly-to-cart — la animación no arranca");
  else {
    if (!r.vuelo.src) fallas.push("3: el clon que vuela salió sin foto");
    if (!r.vuelo.w || !r.vuelo.h) fallas.push("3: el clon que vuela mide 0 — no se ve nada");
  }

  // 4. y no deja dos elementos con el mismo id mientras vuela
  if (r.dobles > 1)
    fallas.push("4: el clon arrastró el id de la foto original (" + r.dobles + " elementos con id img-p-1)");

  // 5. GUARD DEL CSS: la caja de la foto no puede depender de que la imagen
  // esté cargada. Si depende, cualquier re-render vuelve a abrir la puerta al
  // temblor aunque el lazy esté bien.
  const sinSrc = await page.evaluate(() => {
    const i = document.getElementById("img-p-2");
    if (!i) return null;
    const con = i.getBoundingClientRect().height;
    const src = i.getAttribute("src");
    i.removeAttribute("src");
    const sin = i.getBoundingClientRect().height;
    if (src) i.setAttribute("src", src);
    return { con, sin };
  });
  if (!sinSrc) fallas.push("5: no se encontró la foto de la 2ª card");
  else if (Math.abs(sinSrc.con - sinSrc.sin) > 2)
    fallas.push(`5: la caja de la foto depende de la imagen (${sinSrc.con.toFixed(0)}px con src, ${sinSrc.sin.toFixed(0)}px sin src): falta la reserva de css/styles.css`);

  await browser.close();

  if (fallas.length) {
    console.error("carrito-animacion: FALLA\n - " + fallas.join("\n - "));
    process.exit(1);
  }
  console.log("carrito-animacion: OK — el re-render no apaga la foto, la card no se desploma y el vuelo al carrito arranca.");
})().catch((e) => {
  console.error("carrito-animacion: ERROR\n" + (e && e.stack ? e.stack : e));
  process.exit(1);
});
