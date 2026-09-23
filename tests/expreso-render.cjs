#!/usr/bin/env node
/**
 * tests/expreso-render.cjs — que la línea del expreso SE DIBUJE y el popup ande.
 *
 * POR QUÉ EXISTE. `tests/expreso-buscador.cjs` prueba el ranking, que es lógica
 * pura. Pero el bug que le llega al cliente no es que ordene mal: es que el
 * bloque no aparezca, o que el botón "Cambiar" no abra nada. Eso no se prueba
 * leyendo el archivo — hay que abrir la página y mirar el DOM.
 *
 * Levanta mayorista.html en Chromium con la red CORTADA (ningún CDN, ninguna
 * llamada a Supabase: se stubean), arma a mano un `shippingSelect` con dos
 * sucursales —una del interior con expreso y una de CABA— y verifica:
 *   1. interior con expreso  → el bloque se ve y dice el nombre
 *   2. CABA                  → el bloque queda oculto (ahí repartimos nosotros)
 *   3. "Cambiar"             → abre el popup
 *   4. tipear "la sev"       → sugiere LA SEVILLANITA y se puede clickear
 *   5. un expreso inventado  → NO bloquea: muestra el cartel ámbar y habilita
 *                              el botón igual ("Usar igual")
 *
 * Correr:  node tests/expreso-render.cjs
 */
const path = require("path");
let chromium;
try { ({ chromium } = require("/opt/node22/lib/node_modules/playwright")); }
catch (_e) {
  try { ({ chromium } = require("playwright")); }
  catch (_e2) { console.error("expreso-render: SALTEADO — no hay playwright"); process.exit(0); }
}

const PADRON = [
  { razon_social: "LA SEVILLANITA", domicilio: "PERGAMINO 3751", localidad: "Soldati", cp: "", provincia: "Capital Federal" },
  { razon_social: "SEVILLANITA", domicilio: "PERGAMINO 3751", localidad: "Soldati", cp: "", provincia: "Capital Federal" },
  { razon_social: "ALBO", domicilio: "PINEDO 50 GALPON 3", localidad: "Barracas", cp: "", provincia: "Capital Federal" },
];

(async () => {
  const fallas = [];
  const browser = await chromium.launch();
  const ctx = await browser.newContext();

  // Nada sale a la red: los CDN devuelven vacío y Supabase se stubea abajo.
  await ctx.route("**://**", (r) =>
    r.request().url().startsWith("file:") ? r.continue() : r.fulfill({ status: 200, body: "" }),
  );

  const page = await ctx.newPage();
  page.on("dialog", (d) => d.dismiss().catch(() => {}));

  await page.addInitScript((padron) => {
    const resp = { data: [], error: null };
    const q = {
      select: () => q, eq: () => q, order: () => q, limit: () => q,
      single: () => Promise.resolve(resp), insert: () => q,
      then: (f) => Promise.resolve(resp).then(f),
    };
    window.supabase = {
      createClient: () => ({
        from: (t) => (t === "expresos"
          ? { select: () => ({ order: () => Promise.resolve({ data: padron, error: null }) }) }
          : q),
        rpc: () => Promise.resolve({ data: { ok: true, del_padron: true }, error: null }),
        auth: { getSession: () => Promise.resolve({ data: { session: null } }), onAuthStateChange: () => {} },
      }),
    };
  }, PADRON);

  await page.goto("file://" + path.join(__dirname, "..", "mayorista.html"));
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => typeof window._expSyncUI === "function", null, { timeout: 15000 });

  // Dos sucursales a mano: el select real, con los datasets que llena
  // loadDeliveryOptions(). No se simula la consulta: se simula su RESULTADO.
  await page.evaluate(() => {
    // El carrito arranca oculto (.section sin .active). Sin esto todo da
    // "not visible" y el test mediría el display de la sección, no el bloque.
    const sel = document.getElementById("shippingSelect");
    const sec = sel.closest(".section");
    if (sec) {
      document.querySelectorAll(".section.active").forEach((s) => s.classList.remove("active"));
      sec.classList.add("active");
      sec.style.display = "block";
    }
    sel.innerHTML = "";
    const mk = (v, label, d) => {
      const o = document.createElement("option");
      o.value = v; o.textContent = label; o.dataset.label = label;
      Object.assign(o.dataset, d);
      sel.appendChild(o);
    };
    mk("1", "Ruta 12 km 4 - Puerto Rico", {
      nombreExpreso: "LA SEVILLANITA", direccionExpreso: "PERGAMINO 3751, Soldati",
      localidad: "Puerto Rico", provincia: "Misiones", zonaExpreso: "Soldati",
    });
    mk("2", "Rivadavia 100 - Flores", {
      nombreExpreso: "", direccionExpreso: "", localidad: "Flores",
      provincia: "CABA", zonaExpreso: "Flores",
    });
  });

  // 1. interior con expreso
  await page.evaluate(() => { document.getElementById("shippingSelect").value = "1"; window._expSyncUI(); });
  const visible = await page.isVisible("#expresoBox");
  const txt = (await page.textContent("#expresoBox")) || "";
  if (!visible) fallas.push("1: el bloque del expreso no se ve en una sucursal del interior");
  if (!/LA SEVILLANITA/.test(txt)) fallas.push("1: el bloque no dice el nombre del expreso (dice: " + txt.trim().slice(0, 80) + ")");
  if (!/Cambiar/.test(txt)) fallas.push("1: falta el botón Cambiar");

  // 2. CABA → oculto
  await page.evaluate(() => { document.getElementById("shippingSelect").value = "2"; window._expSyncUI(); });
  if (await page.isVisible("#expresoBox"))
    fallas.push("2: el bloque se ve en CABA, donde repartimos nosotros");

  // 3. abre el popup
  await page.evaluate(() => { document.getElementById("shippingSelect").value = "1"; window._expSyncUI(); });
  await page.click("#expresoBox .exp-btn");
  if (!(await page.isVisible("#modalExpreso"))) fallas.push("3: el botón Cambiar no abrió el popup");

  // 4. sugerencias por nombre
  await page.fill("#expBuscar", "la sev");
  await page.waitForTimeout(250);
  const ops = await page.$$eval(".exp-op-n", (n) => n.map((x) => x.textContent.trim()));
  if (ops[0] !== "LA SEVILLANITA")
    fallas.push('4: "la sev" no sugirió LA SEVILLANITA primero (dio: ' + JSON.stringify(ops) + ")");
  await page.click(".exp-op");
  if (!(await page.isVisible(".exp-sel"))) fallas.push("4: clickear la sugerencia no la marcó como elegida");
  if (await page.isDisabled("#expGuardarBtn")) fallas.push("4: con un expreso del padrón el botón quedó deshabilitado");

  // 5. inventado → avisa pero NO frena
  await page.fill("#expBuscar", "EXPRESO QUE NO EXISTE SA");
  await page.waitForTimeout(250);
  if (!(await page.isVisible("#expLibre")))
    fallas.push("5: con un expreso fuera del padrón no apareció el cartel de 'lo damos de alta nosotros'");
  if (await page.isDisabled("#expGuardarBtn"))
    fallas.push("5: FRENÓ al cliente — con un expreso fuera del padrón el botón tiene que quedar habilitado");
  const label = (await page.textContent("#expGuardarBtn")) || "";
  if (!/Usar igual/.test(label))
    fallas.push('5: el botón tenía que decir "Usar igual", dice "' + label.trim() + '"');
  // los dos campos extra son OPCIONALES
  for (const id of ["#expDireccion", "#expLocalidad"]) {
    if (await page.getAttribute(id, "required")) fallas.push("5: " + id + " quedó como obligatorio y tiene que ser opcional");
  }

  await browser.close();

  if (fallas.length) {
    console.error("expreso-render: FALLA\n - " + fallas.join("\n - "));
    process.exit(1);
  }
  console.log("expreso-render: OK — se dibuja en el interior, oculto en CABA, el popup sugiere y el expreso desconocido NO frena.");
})().catch((e) => {
  console.error("expreso-render: ERROR\n" + (e && e.stack ? e.stack : e));
  process.exit(1);
});
