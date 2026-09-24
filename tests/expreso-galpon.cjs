#!/usr/bin/env node
/**
 * tests/expreso-galpon.cjs — "Sin expreso cargado" con el galpón en la ficha.
 *
 * POR QUÉ EXISTE. El 24/09 Tomás probó un pedido de Chef y toda sucursal decía
 * "Sin expreso cargado". Medido contra las 713 sucursales de Chef: el
 * `nombre_expreso` está en 0 — pero `direccion_entrega` NO es la dirección del
 * cliente (ésa va en el `label`, "Matienzo 3578 - Rosario"): guarda el GALPÓN
 * en CABA ("Rabanal 2866") con su barrio en `zona_expreso` ("Soldati"). 327 de
 * las 328 sucursales del interior lo tienen. O sea que la página decía "no sé"
 * teniendo el dato. En LK pasa lo mismo con 79 de las 85 sin nombre.
 *
 * Lo que fija:
 *   A. galpón que el padrón resuelve a UN expreso → se muestra ese nombre
 *   B. galpón compartido (Pergamino 3751) → se muestra el galpón, y NO se
 *      elige uno de los candidatos: adivinar el expreso manda la mercadería al
 *      lugar equivocado
 *   C. `direccion_entrega` que es la ciudad de destino ("Rio Cuarto, Córdoba",
 *      sin altura) → NO se la llama galpón: sigue el cartel de siempre
 *   D. sin dirección → sigue el cartel de siempre
 *
 * Correr:  node tests/expreso-galpon.cjs
 *          node tests/expreso-galpon.cjs ../paginach   (contra Chef)
 */
const path = require("path");
let chromium;
try { ({ chromium } = require("/opt/node22/lib/node_modules/playwright")); }
catch (_e) {
  try { ({ chromium } = require("playwright")); }
  catch (_e2) { console.error("expreso-galpon: SALTEADO — no hay playwright"); process.exit(0); }
}

const raiz = process.argv[2]
  ? path.resolve(__dirname, "..", process.argv[2])
  : path.join(__dirname, "..");

const fallas = [];
const ok = (c, m) => { if (!c) fallas.push(m); };

const PADRON = [
  { razon_social: "SUDAMERICANO", domicilio: "Riestra 1655", localidad: "Pompeya", provincia: "CABA" },
  { razon_social: "SANTA ROSA", domicilio: "Pergamino 3751", localidad: "Soldati", provincia: "CABA" },
  { razon_social: "PEDRITO", domicilio: "PERGAMINO 3751", localidad: "Villa Soldati", provincia: "CABA" },
];

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
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
    const cli = {
      from: (t) => (t === "expresos"
        ? { select: () => ({ order: () => Promise.resolve({ data: padron, error: null }) }) }
        : q),
      rpc: () => Promise.resolve({ data: { ok: true }, error: null }),
      auth: { getSession: () => Promise.resolve({ data: { session: null } }), onAuthStateChange: () => {} },
    };
    window.supabase = { createClient: () => cli };
  }, PADRON);

  await page.goto("file://" + path.join(raiz, "mayorista.html"));
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => typeof window._expSyncUI === "function", null, { timeout: 15000 });

  // Una sucursal del interior SIN nombre de expreso, como las 713 de Chef.
  const pintar = async (dirEntrega, zona, prov) => {
    await page.evaluate((d) => {
      const sel = document.getElementById("shippingSelect");
      sel.innerHTML = "";
      const o = document.createElement("option");
      o.value = "1";
      o.textContent = "1: Entre Rios 2147 - Rosario";
      o.dataset.label = "Entre Rios 2147 - Rosario";
      o.dataset.direccionEntrega = d.dir;
      o.dataset.zonaExpreso = d.zona;
      o.dataset.nombreExpreso = "";      // <- lo que nunca llegó del ISIS
      o.dataset.direccionExpreso = "";
      o.dataset.localidad = "Rosario";
      o.dataset.provincia = d.prov === undefined ? "Santa Fe" : d.prov;
      sel.appendChild(o);
      sel.value = "1";
      window._expSyncUI();
    }, { dir: dirEntrega, zona: zona, prov: prov });
    // el padrón llega async y la línea se redibuja sola
    await page.waitForTimeout(250);
    return page.evaluate(() => {
      const b = document.getElementById("expresoBox");
      return { visible: !!(b && !b.hidden), txt: b ? b.textContent.replace(/\s+/g, " ").trim() : "" };
    });
  };

  // A. galpón de UN solo expreso → el nombre
  const a = await pintar("Riestra 1655", "Pompeya");
  ok(a.visible && /SUDAMERICANO/i.test(a.txt),
    "A: el galpón Riestra 1655 es de un solo expreso y no se mostró el nombre. box=" + JSON.stringify(a.txt));
  ok(!/Sin expreso cargado/i.test(a.txt),
    "A: sigue diciendo 'Sin expreso cargado' teniendo el galpón en la ficha");

  // B. galpón compartido → el galpón, sin elegir candidato
  const b = await pintar("Pergamino 3751 Nave 3 Box 89", "Soldati");
  ok(b.visible && /Pergamino 3751/i.test(b.txt),
    "B: no se mostró el galpón compartido. box=" + JSON.stringify(b.txt));
  ok(!/Sin expreso cargado/i.test(b.txt),
    "B: dice 'Sin expreso cargado' sabiendo que va a Pergamino 3751");
  ok(!/SANTA ROSA|PEDRITO/i.test(b.txt),
    "B: ELIGIÓ un expreso de un galpón compartido — eso es adivinar el ruteo. box=" + JSON.stringify(b.txt));
  // Tomás sacó la bajada el 24/09: el galpón es el dato, el resto era contarle
  // al cliente un problema nuestro. El candado es por el re-copiado entre repos.
  ok(!/operan varios expresos|Nos falta el nombre del expreso/i.test(b.txt),
    "B: volvió la bajada que Tomás sacó. box=" + JSON.stringify(b.txt));

  // C. la ciudad de destino NO es un galpón
  const c = await pintar("Rio Cuarto, Córdoba", "");
  ok(/Sin expreso cargado/i.test(c.txt),
    "C: trató la ciudad de destino como si fuera el galpón del expreso. box=" + JSON.stringify(c.txt));

  // D. sin dirección, el cartel de siempre
  const d = await pintar("", "");
  ok(/Sin expreso cargado/i.test(d.txt),
    "D: sin dirección tiene que quedar el cartel de siempre. box=" + JSON.stringify(d.txt));

  // E. galpón con provincia CABA: la dirección manda sobre la provincia.
  // Caso real (Altuna, cod 4 de LK): direccion_entrega = "Pergamino 3751",
  // provincia = "CABA". Ahí operan 44 expresos — de CABA no tiene nada, es el
  // galpón. Preguntando por la provincia primero, la línea no se dibujaba.
  const e = await pintar("Pergamino 3751", "Soldati", "CABA");
  ok(e.visible, "E: con provincia CABA no se dibujó la línea, y la dirección es un galpón del padrón");
  ok(/Pergamino 3751/i.test(e.txt),
    "E: no se mostró el galpón. box=" + JSON.stringify(e.txt));

  // F. y una dirección de CABA que NO es galpón sigue sin línea: al cliente de
  //    Flores le repartimos nosotros y "sin expreso" no significa nada para él.
  const f = await pintar("Av. Rivadavia 5000", "Caballito", "CABA");
  ok(!f.visible, "F: le dibujó la línea del expreso a un cliente de CABA. box=" + JSON.stringify(f.txt));

  await browser.close();

  if (fallas.length) {
    console.error("expreso-galpon: FALLA (" + path.basename(raiz) + ")");
    fallas.forEach((f) => console.error("  · " + f));
    process.exit(1);
  }
  console.log("expreso-galpon: OK (" + path.basename(raiz) + ") — 10 chequeos");
})().catch((e) => { console.error("expreso-galpon: ERROR", e); process.exit(1); });
