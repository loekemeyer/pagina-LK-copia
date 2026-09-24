#!/usr/bin/env node
/**
 * tests/perfil-sin-columna.cjs — que al cliente NO se le caiga el perfil porque
 * el front pide una columna que la base todavía no tiene.
 *
 * ⚠ GEMELO del de Loekemeyer (`pagina-LK-copia`): el módulo es el mismo código
 *   en las dos páginas. Al tocar uno, mirar el otro.
 *
 * EL BUG QUE ESTE TEST IMPIDE (24/09/2026, clientes de Chef). El front se
 * publica por un lado y el SQL de este repo se corre A MANO por otro. Entre el
 * 23/09 a la noche y el 24/09 a la mañana estuvo publicada una versión que
 * nombraba `modo_presupuesto` dentro del `.select()` de `customers`, contra una
 * base donde el `alter` nunca se corrió.
 *
 * PostgREST NO devuelve la fila sin esa columna: rechaza la consulta ENTERA con
 * un 400. Así que no se "perdió el modo presupuesto" — TODOS los clientes
 * entraban y se quedaban SIN PERFIL: "Hola!" sin nombre, cod/cuit/correo/dto en
 * "—" y "Iniciá sesión para ver tus pedidos" estando logueados. Sin un solo
 * mensaje de error en pantalla.
 *
 * Por eso lo que se prueba acá NO es "que ande con modo_presupuesto", sino que
 * el perfil llegue igual FALTE LA COLUMNA QUE FALTE: el error de mañana va a
 * ser con otra columna, y el síntoma es el mismo.
 *
 * Se prueba contra un Supabase falso que se comporta como PostgREST: si la
 * lista de columnas nombra una que no existe, contesta 42703 y no devuelve nada.
 *
 * Correr:  node tests/perfil-sin-columna.cjs
 */
const path = require("path");

const raiz = path.join(__dirname, "..");
const fallas = [];
const ok = (m) => console.log("  ok    ·", m);
const mal = (m) => { fallas.push(m); console.log("  FALLA ·", m); };

let chromium;
try { ({ chromium } = require("/opt/node22/lib/node_modules/playwright")); }
catch (_e) {
  try { ({ chromium } = require("playwright")); }
  catch (_e2) { chromium = null; }
}

// Lo que pide el login de verdad (refreshAuthState). Si alguien le agrega una
// columna, este test la sigue cubriendo: lo que se prueba es el mecanismo.
const COLS_LOGIN =
  "id,business_name,dto_vol,cod_cliente,cuit,direccion_fiscal,localidad,vend,mail," +
  "debt,payment_term,credit_limit,escala_activa";
const TODAS = COLS_LOGIN.split(",").concat(["modo_presupuesto"]);

(async () => {
  if (!chromium) {
    console.log("SALTEADO — no hay playwright");
    process.exit(0);
  }

  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  // Red cortada: ni CDN ni Supabase. Todo sale del Supabase falso de abajo.
  await ctx.route("**://**", (r) =>
    r.request().url().startsWith("file:") ? r.continue() : r.fulfill({ status: 200, body: "" }),
  );
  const page = await ctx.newPage();
  page.on("dialog", (d) => d.dismiss().catch(() => {}));

  await page.addInitScript(() => {
    window.__fakeDb = {
      // Qué columnas TIENE la base. Los tests de abajo le sacan de a una.
      columnas: null,          // lo setea cada caso
      fila: {
        id: "c1", business_name: "CLASSIC S.A.", cod_cliente: 1362,
        cuit: "800130570", dto_vol: 0, mail: "classic@cuit.loekemeyer",
        modo_presupuesto: true,
      },
      errorForzado: null,      // para los errores que NO son de columna (RLS, red)
      pedidos: [],             // cada lista de columnas pedida, en orden
      session: null,
      // Sucursales. Por defecto, una base SIN las columnas del expreso: es como
      // esta Chef hoy (sql/expreso_cambio_cliente.sql tampoco se corrio).
      columnasSucursales: ["slot", "label", "direccion_entrega", "zona_expreso",
                           "localidad", "provincia", "pending_isis"],
      sucursales: [{ slot: 1, label: "CASA CENTRAL", direccion_entrega: "Av. Siempreviva 742",
                     zona_expreso: "", localidad: "CABA", provincia: "CABA",
                     pending_isis: false }],
      pedidosSucursales: [],
    };

    function consultar(tabla, cols) {
      const pedidas = String(cols || "").split(",").map((s) => s.trim()).filter(Boolean);
      // Sucursales: la MISMA trampa que customers. El select largo pide las
      // columnas del expreso (sql/expreso_cambio_cliente.sql, que en Chef
      // tampoco se corrio) y si no estan, PostgREST rechaza todo.
      if (tabla === "customer_delivery_addresses") {
        window.__fakeDb.pedidosSucursales.push(pedidas);
        const faltaDir = pedidas.filter(
          (c) => window.__fakeDb.columnasSucursales.indexOf(c) === -1)[0];
        if (faltaDir) {
          return Promise.resolve({ data: null, error: {
            code: "42703", details: null, hint: null,
            message: "column customer_delivery_addresses." + faltaDir + " does not exist" } });
        }
        return Promise.resolve({
          data: window.__fakeDb.sucursales.map((suc) => {
            const fila = {};
            pedidas.forEach((c) => { fila[c] = suc[c] !== undefined ? suc[c] : null; });
            return fila;
          }),
          error: null,
        });
      }
      if (tabla !== "customers") return Promise.resolve({ data: null, error: null });
      window.__fakeDb.pedidos.push(pedidas);
      if (window.__fakeDb.errorForzado) {
        return Promise.resolve({ data: null, error: window.__fakeDb.errorForzado });
      }
      const falta = pedidas.filter((c) => window.__fakeDb.columnas.indexOf(c) === -1)[0];
      if (falta) {
        // Textual lo que contesta PostgREST: 400, y la consulta ENTERA rechazada.
        return Promise.resolve({
          data: null,
          error: { code: "42703", details: null, hint: null,
                   message: "column customers." + falta + " does not exist" },
        });
      }
      const out = {};
      pedidas.forEach((c) => {
        out[c] = window.__fakeDb.fila[c] !== undefined ? window.__fakeDb.fila[c] : null;
      });
      return Promise.resolve({ data: out, error: null });
    }

    function q(tabla) {
      let cols = "";
      const api = {
        select: (c) => { cols = c; return api; },
        eq: () => api, in: () => api, order: () => api, limit: () => api,
        insert: () => api, update: () => api, delete: () => api,
        maybeSingle: () => consultar(tabla, cols),
        single: () => consultar(tabla, cols),
        then: (f) => consultar(tabla, cols).then(f),
      };
      return api;
    }

    window.supabase = {
      createClient: () => ({
        from: (t) => q(t),
        rpc: () => Promise.resolve({ data: null, error: null }),
        auth: {
          getSession: () => Promise.resolve({ data: { session: window.__fakeDb.session } }),
          onAuthStateChange: () => {},
        },
      }),
    };
  });

  await page.goto("file://" + path.join(raiz, "mayorista.html"));
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(
    () => typeof window._customerSelect === "function" || typeof _customerSelect === "function",
    null, { timeout: 15000 },
  );

  // Un caso = una base con ciertas columnas; se pide el perfil y se mira qué volvió.
  const correr = (columnas, cols, errorForzado) =>
    page.evaluate(async (arg) => {
      window.__fakeDb.columnas = arg.columnas;
      window.__fakeDb.errorForzado = arg.errorForzado || null;
      window.__fakeDb.pedidos = [];
      const r = await _customerSelect(arg.cols, (qq) => qq.eq("id", "c1"));
      return {
        data: r && r.data ? r.data : null,
        error: r && r.error ? { code: r.error.code, message: r.error.message } : null,
        pedidos: window.__fakeDb.pedidos,
      };
    }, { columnas, cols, errorForzado });

  console.log("A. el perfil llega igual, falte la columna que falte");

  // A1. Base COMPLETA: tiene que traer la fila y la bandera.
  let r = await correr(TODAS, COLS_LOGIN);
  if (!r.data) mal("con la base completa no volvió el perfil: " + JSON.stringify(r.error));
  else if (r.data.modo_presupuesto !== true) mal("con la base completa se perdió modo_presupuesto");
  else ok("base completa: perfil + modo_presupuesto");

  // A2. Base SIN modo_presupuesto — el caso exacto de Chef el 24/09.
  r = await correr(TODAS.filter((c) => c !== "modo_presupuesto"), COLS_LOGIN);
  if (!r.data) {
    mal("SIN la columna modo_presupuesto el cliente se queda sin perfil (el bug del 24/09): " +
        JSON.stringify(r.error));
  } else if (!r.data.business_name) {
    mal("volvió una fila sin business_name: el header queda en 'Hola!' pelado");
  } else {
    ok("sin modo_presupuesto: el perfil llega igual (reintento sin esa columna)");
  }

  // A3. Base sin OTRA columna cualquiera. El bug de mañana no va a ser con
  //     modo_presupuesto: va a ser con la próxima que alguien agregue al front
  //     antes de correr el .sql. El reintento no puede estar atado a un nombre.
  for (const col of ["escala_activa", "credit_limit", "direccion_fiscal"]) {
    r = await correr(TODAS.filter((c) => c !== col), COLS_LOGIN);
    if (!r.data) {
      mal("sin la columna " + col + " el cliente se queda SIN PERFIL: el reintento " +
          "sólo cubre modo_presupuesto y el problema es de cualquier columna");
    } else {
      ok("sin " + col + ": el perfil llega igual");
    }
  }

  // A4. Base a la que le faltan DOS. Tiene que sacar las dos, no rendirse en la primera.
  r = await correr(TODAS.filter((c) => c !== "modo_presupuesto" && c !== "escala_activa"), COLS_LOGIN);
  if (!r.data) mal("con DOS columnas faltantes se rinde y deja al cliente sin perfil");
  else ok("dos columnas faltantes: el perfil llega igual");

  console.log("\nB. no se puede tapar cualquier error ni quedarse dando vueltas");

  // B1. Un error que NO es de columna (RLS, credencial, red) se devuelve tal
  //     cual y en UN solo viaje: reintentar no lo arregla y esconderlo es peor.
  r = await correr(TODAS, COLS_LOGIN, { code: "42501", details: null, hint: null,
                                        message: "permission denied for table customers" });
  if (!r.error) mal("un error de permisos se está tragando como si fuera una columna faltante");
  else if (r.pedidos.length !== 1) mal("un error de permisos disparó " + r.pedidos.length + " consultas");
  else ok("error de permisos: se devuelve tal cual, en una sola consulta");

  // B2. `id` no se saca NUNCA: sin id no hay perfil, hay una fila de adorno.
  r = await correr(TODAS.filter((c) => c !== "id"), COLS_LOGIN);
  const pidieronId = r.pedidos.every((p) => p.indexOf("id") !== -1);
  if (!pidieronId) mal("se sacó `id` del select: el perfil vuelve sin id y no sirve para nada");
  else ok("`id` nunca se saca del select");
  if (r.pedidos.length > TODAS.length) mal("se quedó reintentando " + r.pedidos.length + " veces");
  else ok("el reintento termina (" + r.pedidos.length + " consultas)");

  console.log("\nC. la pantalla del cliente logueado (refreshAuthState)");

  // C. El end-to-end del síntoma: sesión abierta, base SIN la columna nueva.
  //    Lo que se mira es lo que ve el cliente en el header.
  const ui = await page.evaluate(async (cols) => {
    window.__fakeDb.columnas = cols;
    window.__fakeDb.errorForzado = null;
    window.__fakeDb.pedidos = [];
    window.__fakeDb.session = { user: { id: "00000000-0000-0000-0000-000000000000" } };
    await refreshAuthState(window.__fakeDb.session);
    const el = document.getElementById("helloNavText");
    return {
      hola: el ? el.innerText : "",
      perfil: typeof customerProfile !== "undefined" && customerProfile
        ? { id: customerProfile.id, nombre: customerProfile.business_name } : null,
    };
  }, TODAS.filter((c) => c !== "modo_presupuesto"));

  if (!ui.perfil) {
    mal("logueado y con la base sin la columna, customerProfile quedó en null: " +
        "es exactamente la pantalla que reportaron los clientes");
  } else if (!/CLASSIC/.test(ui.hola)) {
    mal("el header dice '" + ui.hola + "' en vez del nombre del cliente");
  } else {
    ok("logueado contra una base sin la columna: header '" + ui.hola.trim() + "'");
  }

  console.log("\nD. cuando el perfil NO se puede arreglar, se avisa");

  // Lo que el reintento no puede resolver (permisos, red, base caída) tiene que
  // DECIRSE. Antes era mudo y el cliente miraba una página vacía sin saber por
  // qué: así estuvimos el 24/09 hasta que llamaron ellos.
  const aviso = await page.evaluate(async (cols) => {
    window.__fakeDb.columnas = cols;
    window.__fakeDb.pedidos = [];
    window.__fakeDb.errorForzado = {
      code: "42501", details: null, hint: null,
      message: "permission denied for table customers",
    };
    window.__fakeDb.session = { user: { id: "00000000-0000-0000-0000-000000000001" } };
    const el = document.getElementById("perfilCaidoAviso");
    if (el) el.remove();
    await refreshAuthState(window.__fakeDb.session);
    // La sección "Mi Perfil" arranca sin .active: sin esto se estaría midiendo
    // el display de la sección, no el del aviso.
    document.querySelectorAll(".section.active").forEach((s) => s.classList.remove("active"));
    const secPerfil = document.getElementById("perfil");
    if (secPerfil) secPerfil.classList.add("active");
    const caido = document.getElementById("perfilCaidoAviso");
    return {
      hayAviso: !!caido && caido.getClientRects().length > 0,
      existe: !!caido,
      texto: caido ? caido.textContent : "",
      nota: (document.getElementById("customerNote") || {}).innerText || "",
    };
  }, TODAS);

  if (!aviso.hayAviso) {
    mal("el perfil falló y no se dibujó ningún aviso: el cliente vuelve a mirar " +
        "una pantalla vacía sin saber que algo se rompió");
  } else if (!/perfil/i.test(aviso.texto)) {
    mal("el aviso no dice nada del perfil: '" + aviso.texto.slice(0, 80) + "'");
  } else {
    ok("se avisa en pantalla: '" + aviso.texto.slice(0, 60) + "…'");
  }

  console.log("\nE. con una base a la que le faltan las columnas nuevas, se puede pedir");

  // No alcanza con que entre: el pedido tiene que poder armarse. Esta base
  // falsa no tiene NINGUNA de las columnas nuevas (customers.modo_presupuesto
  // ni las del expreso en las sucursales), que es como esta Chef hoy y como
  // puede quedar LK el dia que se publique el front antes que el .sql.
  const pedido = await page.evaluate(async (cols) => {
    window.__fakeDb.columnas = cols;                 // sin modo_presupuesto
    window.__fakeDb.errorForzado = null;
    window.__fakeDb.pedidos = [];
    window.__fakeDb.pedidosSucursales = [];
    window.__fakeDb.session = { user: { id: "00000000-0000-0000-0000-000000000000" } };

    const av = document.getElementById("perfilCaidoAviso");
    if (av) av.remove();

    await refreshAuthState(window.__fakeDb.session);
    await loadDeliveryOptions();

    const ship = document.getElementById("shippingSelect");
    const pay = document.getElementById("paymentSelect");
    const btn = document.getElementById("submitOrderBtn");

    // El cliente elige sucursal y forma de pago, que es todo lo que la pagina
    // le pide antes de habilitar el boton.
    if (ship && ship.options.length > 1) ship.value = ship.options[1].value;
    deliveryConfirmed = true;
    if (pay) pay.value = (pay.options[1] || pay.options[0] || {}).value || "";
    cart.splice(0, cart.length);
    cart.push({ id: "p1", cod: "505", description: "Pelapapas", boxes: 2, uxb: 12 });
    refreshSubmitEnabled();

    return {
      perfil: !!customerProfile,
      presupuesto: isPresupuestoMode(),
      sucursales: ship ? ship.options.length - 1 : 0,
      botonHabilitado: !!btn && !btn.disabled,
      avisoDeError: !!document.getElementById("perfilCaidoAviso"),
      intentosSucursales: window.__fakeDb.pedidosSucursales.length,
    };
  }, TODAS.filter((c) => c !== "modo_presupuesto"));

  if (!pedido.perfil) mal("sin modo_presupuesto no hay perfil: el cliente no puede ni empezar");
  else ok("el perfil carga");

  if (pedido.presupuesto) {
    mal("sin la columna, isPresupuestoMode() dio true: el cliente normal quedaria sin precios");
  } else {
    ok("un cliente normal NO queda en modo presupuesto por la columna que falta");
  }

  if (!pedido.sucursales) {
    mal("el select de sucursales quedo vacio: sin sucursal no se puede confirmar un pedido " +
        "(las columnas del expreso tampoco estan en Chef)");
  } else {
    ok("las sucursales cargan igual (" + pedido.sucursales + "; " +
       pedido.intentosSucursales + " consultas: cayo al select corto)");
  }

  if (pedido.avisoDeError) mal("se dibujo el aviso de perfil caido sin que hubiera fallado nada");
  else ok("no se muestra ningun error al cliente");

  if (!pedido.botonHabilitado) mal("el boton de confirmar el pedido quedo deshabilitado");
  else ok("el boton de confirmar el pedido queda habilitado");

  await browser.close();

  console.log("");
  if (fallas.length) {
    console.log("ROJO — " + fallas.length + " falla(s)");
    process.exit(1);
  }
  console.log("VERDE");
})();
