#!/usr/bin/env node
/**
 * tests/cencosud-cliente-chef.cjs — que el PDF Krikos de LK encuentre al cliente de Chef.
 *
 * POR QUÉ EXISTE (Tomás Gonzalez, 02/10/2026). Una OC de Cencosud (Jumbo, OC 198413613)
 * cargada en el PDF Krikos de este admin mostraba "CLIENTE ⚠ no encontrado (esperaba cod
 * 2444)" y "SUCURSAL 221 — sin mapear", y sin cliente el pedido no se puede subir. La
 * clave pública de Chef NO lee `customers` (RLS: devuelve 0 filas SIN error); las
 * sucursales sí se leen, pero se buscan por el id del cliente, así que caían las dos.
 * Ahora, si Chef no lo devuelve, se pide a la RPC de LK scot_chef_cliente_super.
 *
 * Chequea, corriendo loadChefCustomer + loadChefCustomerLK de admin-supercot.js con
 * clientes falsos:
 *   A. Chef devuelve 0 filas → sale el cliente de la RPC de LK (con id, vend, deuda);
 *   B. Chef da error → también cae a la RPC;
 *   C. Chef SÍ lo devuelve → se usa ése y la RPC no se llama;
 *   D. la RPC trae la copia parcial → avisa (toast) y devuelve el cliente igual;
 *   E. la RPC falla → null (la card dice "no encontrado", no inventa un cliente).
 *   F. el pedido de Cencosud se sube como de CHEF (Pedidos CH, empresa CH) y cada código
 *      lleva L al final (816E → 816EL); Dorinka y las cadenas LK, sin L. Es lo que después
 *      toma Gestión por gv_pedidos_web_np_chef (NP CH, artículo con L → góndola LK).
 *   G. el pedido se CREA en la base de Chef: create-super-order recibe el apikey de Chef y,
 *      si falla, el admin corta en vez de inventar un número que sólo llega a la hoja.
 *
 * Verificado contra el admin-supercot.js anterior: falla 0, A, A2, B y D (C y E ya andaban).
 *
 * Correr:  node tests/cencosud-cliente-chef.cjs
 */
"use strict";
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "admin-supercot.js"), "utf8");
let fallas = 0;
function ok(cond, msg) {
  console.log((cond ? "  ✓ " : "  ✗ ") + msg);
  if (!cond) fallas++;
}
function fn(nombre) {
  const i = src.indexOf("async function " + nombre + "(");
  if (i < 0) return "";
  const f = src.indexOf("\n  }\n", i);
  return src.slice(i, f + 4);
}

const CLIENTE_LK = {
  id: "6028b7fd-ba7b-421f-bf3b-a8b8710a1aea", cod_cliente: "2444",
  business_name: "Cencosud S.A.", vend: "20", debt: 43709346.9,
  credit_limit: 12025000000, payment_term: 277, origen: "chef_vivo", parcial: false,
};

async function correr(chefResp, rpcResp) {
  const llamadas = { rpc: 0, toast: [] };
  const chefClient = {
    from() {
      return { select() { return this; }, eq() { return this; },
               limit() { return Promise.resolve(chefResp); } };
    },
  };
  const window = {
    sb: { rpc(nombre, args) { llamadas.rpc++; llamadas.args = { nombre, args };
                              return Promise.resolve(rpcResp); } },
    toast(msg, tipo) { llamadas.toast.push(tipo + ": " + msg); },
  };
  const cuerpo = fn("loadChefCustomer") + "\n" + fn("loadChefCustomerLK");
  const f = Function(
    "CHEF_CUSTOMER_COD", "getChefClient", "window", "console",
    cuerpo + "\nreturn loadChefCustomer;",
  )({ cencosud: "2444" }, () => chefClient, window, { error() {}, warn() {} });
  const c = await f("cencosud");
  return { c, llamadas };
}

(async () => {
  ok(fn("loadChefCustomerLK") !== "", "0. existe loadChefCustomerLK");

  const a = await correr({ data: [], error: null }, { data: CLIENTE_LK, error: null });
  ok(a.c && a.c.id === CLIENTE_LK.id && a.c.vend === "20" && a.c.debt === 43709346.9,
     "A. Chef oculta el cliente (0 filas) → sale de la RPC de LK con id, vend y deuda");
  ok(a.llamadas.args && a.llamadas.args.nombre === "scot_chef_cliente_super" &&
     a.llamadas.args.args.p_cod === "2444", "A2. pregunta por el cod 2444 a scot_chef_cliente_super");

  const b = await correr({ data: null, error: { message: "boom" } }, { data: CLIENTE_LK, error: null });
  ok(b.c && b.c.id === CLIENTE_LK.id, "B. Chef da error → también cae a la RPC");

  const propio = { id: "x-chef", cod_cliente: 2444, business_name: "Cencosud S.A." };
  const c = await correr({ data: [propio], error: null }, { data: CLIENTE_LK, error: null });
  ok(c.c === propio && c.llamadas.rpc === 0, "C. si Chef lo devuelve se usa ése, sin llamar a la RPC");

  const parcial = Object.assign({}, CLIENTE_LK, { vend: null, debt: null, parcial: true, origen: "chef_customers_cache" });
  const d = await correr({ data: [], error: null }, { data: parcial, error: null });
  ok(d.c && d.c.id === CLIENTE_LK.id && d.llamadas.toast.length === 1 && /warning/.test(d.llamadas.toast[0]),
     "D. copia parcial → devuelve el cliente y avisa que falta vendedor/deuda");

  const e = await correr({ data: [], error: null }, { data: null, error: { message: "no autorizado" } });
  ok(e.c === null, "E. la RPC falla → null, no inventa un cliente");

  // F — Tomás Gonzalez, 02/10/2026: "al hacer la conversión en Gestión-Virgilio, el pedido
  // debe pasar a ser de Chef, y los códigos de los artículos se le agregan una L al final".
  // El feed de Gestión (gv_pedidos_web_np_chef) toma empresa y códigos del sheets_payload que
  // arma submitOrder, así que se corre ese pedazo con la config real de las cadenas.
  const sub = (function () {
    const i = src.indexOf("async function submitOrder(");
    return i < 0 ? "" : src.slice(i, src.indexOf("\n  }\n", i));
  })();
  function fnSync(nombre) {
    const i = src.indexOf("function " + nombre + "(");
    return i < 0 ? "" : src.slice(i, src.indexOf("\n  }\n", i) + 4);
  }
  const mL = sub.match(/var addLSuffix = ([^;]+);/);
  const mOut = sub.match(/function outCod\(cod\) \{[\s\S]*?\n      \}/);
  function salida(superKey) {
    return Function(
      "SUPER_EMPRESA", "SUPER_USA_PRODUCTOS_CHEF", "state",
      fnSync("isChefSuper") + fnSync("usesChefProducts") +
        "var isChef = isChefSuper(state.superKey);\n" +
        "var addLSuffix = " + (mL ? mL[1] : "false") + ";\n" +
        "var SUPER_COD_MAP = { coto: { '505': '505I' } };\n" +
        (mOut ? mOut[0] : "function outCod(c){return String(c);}") +
        "\nreturn { isChef: isChef, cods: ['816E', '026', '102E'].map(outCod) };",
    )({ cencosud: "chef", dorinka: "chef", coto: "lk" },
      { cencosud: false, dorinka: true, coto: false }, { superKey: superKey });
  }
  const cen = salida("cencosud"), dor = salida("dorinka"), cot = salida("coto");
  ok(!!mL && !!mOut, "F0. submitOrder tiene addLSuffix y outCod");
  ok(cen.isChef && cen.cods.join(",") === "816EL,026L,102EL",
     "F1. Cencosud: el pedido es de Chef y cada código lleva L (816E → 816EL)");
  ok(dor.isChef && dor.cods.join(",") === "816E,026,102E",
     "F2. Dorinka: es de Chef pero SIN L (sus artículos son de Chef)");
  ok(!cot.isChef && cot.cods.join(",") === "816E,026,102E", "F3. una cadena LK (Coto): sin L");
  ok(/target_sheet:\s*isChef \? "Pedidos CH"/.test(sub) && /empresa:\s*isChef \? "CH"/.test(sub) &&
     /cod_art:\s*outCod\(it\.codLk\)/.test(sub),
     "F4. el sheets_payload va a «Pedidos CH», empresa CH, con los códigos de outCod");

  // G — Tomás Gonzalez, 02/10/2026: "llegó bien el pedido de Jumbo en Chef pero no lo veo
  // en la PPP". Desde el 11/09 el admin le mandaba a create-super-order (proyecto CHEF) el
  // `apikey` de LK; el gateway de Chef contestaba 401 "Invalid API key" y el admin caía a un
  // número sintético CHEF-CENCOSUD-<fecha>: el pedido iba a la hoja y decía "subido", pero no
  // existía en la base de Chef, de donde lo lee Gestión.
  const iCo = sub.indexOf("fetch(CHEF_CREATE_ORDER_URL");
  const coFetch = iCo < 0 ? "" : sub.slice(iCo, sub.indexOf("body:", iCo));
  ok(/apikey:\s*CHEF_KEY\b/.test(coFetch),
     "G1. create-super-order recibe el apikey de CHEF, no el de LK");
  ok(!/"CHEF-"\s*\+\s*state\.superKey/.test(sub) &&
     /throw new Error\("El pedido no se creó en Chef/.test(sub),
     "G2. si Chef no crea el pedido, se corta (sin número sintético que vaya sólo a la hoja)");

  if (fallas) {
    console.log("\n✗ " + fallas + " chequeo(s) en rojo");
    process.exit(1);
  }
  console.log("\n✓ el PDF Krikos de LK encuentra al cliente de Chef de la cadena");
})();
