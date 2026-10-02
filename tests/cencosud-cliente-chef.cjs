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

  if (fallas) {
    console.log("\n✗ " + fallas + " chequeo(s) en rojo");
    process.exit(1);
  }
  console.log("\n✓ el PDF Krikos de LK encuentra al cliente de Chef de la cadena");
})();
