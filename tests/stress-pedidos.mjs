#!/usr/bin/env node
/**
 * tests/stress-pedidos.mjs — ¿aguanta el sitio 100 pedidos al mismo tiempo?
 *
 * POR QUE EXISTE Y QUE MIDE DE VERDAD (2026-09-24)
 * ------------------------------------------------------------------
 * El pedido original era "100 pedidos simultaneos". Medido contra la base antes
 * de escribir una linea, el numero que importa NO es 100:
 *
 *   · submit_order_fast es UNA transaccion barata. Sus dos guards cuestan
 *     7,1 ms (sin stock, 17 lineas) y 0,17 ms (anti-reintento). La base NO es
 *     el cuello de botella.
 *   · Pero DESPUES de la RPC, script.js dispara un UPDATE HTTP POR CADA LINEA
 *     del pedido (bloque "EFECTOS SECUNDARIOS", ~9510). Con 17,5 lineas de
 *     promedio medidas sobre 645 pedidos de 90 dias, cada pedido son ~20
 *     requests a PostgREST, no uno.
 *
 *   ➜ 100 pedidos simultaneos = ~2.000 requests HTTP en rafaga.
 *
 * Por eso el script mide las DOS cosas por separado: la RPC sola (lo que la
 * gente cree que esta probando) y el pedido completo con sus efectos (lo que
 * de verdad pasa cuando 100 clientes aprietan Confirmar).
 *
 * CONTEXTO DE ESCALA, para leer el resultado
 * ------------------------------------------------------------------
 * Pico historico real de `orders`, 180 dias: 6 pedidos en el minuto mas cargado,
 * 31 en la hora mas cargada, 242 pedidos en los ultimos 30 dias. O sea que 100
 * simultaneos es ~17x el peor MINUTO que existio, concentrado en un segundo.
 * No es el escenario que va a pasar: es el techo. Esta bien medir el techo,
 * pero el numero que decide si hay que tocar algo es el de 10-20.
 *
 * ⚠⚠ ESTE SCRIPT PUEDE ESCRIBIR PEDIDOS REALES EN PRODUCCION
 * ------------------------------------------------------------------
 * Por defecto NO escribe (modo `simulacro`). El modo `carga` escribe de verdad
 * y hay que pedirlo con --si-escribir-en-produccion. Antes de usarlo, leer
 * "LOS SEIS EFECTOS COLATERALES" mas abajo: un pedido de prueba no se queda
 * quieto en `orders`, sale al deposito.
 *
 * USO
 * ------------------------------------------------------------------
 *   export LK_CUIT=30xxxxxxxxx           # cliente de prueba
 *   export LK_PIN=123456
 *
 *   node tests/stress-pedidos.mjs                        # simulacro, 100 en paralelo
 *   node tests/stress-pedidos.mjs --n 20 --rampa         # sube de a poco: 1,5,10,20
 *   node tests/stress-pedidos.mjs --test-guard           # la carrera del doble click
 *   node tests/stress-pedidos.mjs --modo carga --si-escribir-en-produccion
 *   node tests/stress-pedidos.mjs --limpiar              # borra lo que dejo
 */

import { readFileSync } from "node:fs";

const SUPABASE_URL = "https://kwkclwhmoygunqmlegrg.supabase.co";
const ANON =
  process.env.LK_ANON_KEY ||
  leerAnonDeScriptJs() ||
  "";

// ─────────────────────────────────────────────────────────────────────────────
// LOS SEIS EFECTOS COLATERALES de un pedido de prueba en produccion.
// Estan aca y no en un README porque quien corra esto tiene que verlos.
// ─────────────────────────────────────────────────────────────────────────────
const EFECTOS_COLATERALES = [
  "Google Sheets de ventas (sheets-proxy) — el script NO lo llama, pero si lo llamaras entran 100 filas a la planilla del equipo.",
  "Sheet de entregas / Base Picking (sheets-entregas-proxy) — idem.",
  "PPP de Gestion Virgilio — v_pedidos_web los publica en vivo y el cron sync-pedidos-match (cada 15 min) los empuja. Salen en 'A Programar' y alguien los arma.",
  "WhatsApp al cliente — el trigger orders_notify_whatsapp encola una fila en wa_outbox POR PEDIDO. Si el cliente de prueba tiene whatsapp cargado en bot_customer_whatsapps, son 100 mensajes reales.",
  "El numerador de pedidos salta N. Las secuencias no se revierten ni borrando las filas: el proximo pedido real arranca 100 mas arriba.",
  "Los reportes rep_* de Telegram del dia siguiente cuentan esa plata como venta del portal.",
];

const args = process.argv.slice(2);
const opt = (k, def) => {
  const i = args.indexOf("--" + k);
  return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : true) : def;
};
const flag = (k) => args.includes("--" + k);

const CFG = {
  n: Number(opt("n", 100)),
  lineas: Number(opt("lineas", 17)),        // la mediana real es 14, el promedio 17,5
  modo: String(opt("modo", "simulacro")),    // simulacro | carga
  conEfectos: !flag("sin-efectos"),          // replicar los ~20 requests por pedido
  rampa: flag("rampa"),
  testGuard: flag("test-guard"),
  limpiar: flag("limpiar"),
  autorizado: flag("si-escribir-en-produccion"),
  verbose: flag("v"),
};

function leerAnonDeScriptJs() {
  try {
    const txt = readFileSync(new URL("../script.js", import.meta.url), "utf8");
    const m = txt.match(/SUPABASE_ANON_KEY\s*=\s*\n?\s*"([^"]+)"/);
    return m ? m[1] : null;
  } catch { return null; }
}

// ── medicion ────────────────────────────────────────────────────────────────
const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const ms = (n) => `${Math.round(n)} ms`;

function resumen(nombre, muestras, errores, wall) {
  const ok = muestras.length;
  const tot = ok + errores.length;
  console.log(`\n── ${nombre} ──`);
  console.log(`   lanzados ${tot} · ok ${ok} · error ${errores.length}`);
  if (ok) {
    console.log(
      `   p50 ${ms(pct(muestras, 50))} · p95 ${ms(pct(muestras, 95))} · ` +
      `p99 ${ms(pct(muestras, 99))} · max ${ms(Math.max(...muestras))}`,
    );
  }
  console.log(`   pared ${ms(wall)} · throughput ${(tot / (wall / 1000)).toFixed(1)}/s`);
  if (errores.length) {
    const porTipo = {};
    for (const e of errores) {
      const k = clasificar(e);
      porTipo[k] = (porTipo[k] || 0) + 1;
    }
    for (const [k, v] of Object.entries(porTipo).sort((a, b) => b[1] - a[1])) {
      console.log(`   ✗ ${v.toString().padStart(4)} · ${k}`);
    }
  }
  return { ok, err: errores.length, p95: pct(muestras, 95), wall };
}

// Clasificar el error importa mas que contarlo: un 546 de PostgREST (pool
// agotado) y un 57014 (statement timeout) se arreglan en lugares distintos.
function clasificar(e) {
  const t = String(e && (e.message || e)).slice(0, 200);
  if (/57014|statement timeout|canceling statement/i.test(t)) return "57014 statement timeout (base)";
  if (/54001|stack depth/i.test(t)) return "54001 stack depth";
  if (/53300|too many connections|remaining connection/i.test(t)) return "53300 sin conexiones (pool)";
  if (/\b546\b|pool|db_pool|Max client connections/i.test(t)) return "PostgREST sin pool";
  if (/\b503\b|\b502\b|\b504\b/.test(t)) return "5xx gateway";
  if (/\b429\b|rate ?limit|too many requests/i.test(t)) return "429 rate limit";
  if (/Sin stock/i.test(t)) return "guard SIN STOCK (esperado si el catalogo tiene badges)";
  if (/Unauthorized/i.test(t)) return "Unauthorized (auth/customer mismatch)";
  if (/timeout|aborted|fetch failed|ECONNRESET|socket/i.test(t)) return "timeout / conexion cortada";
  return t;
}

// ── HTTP ────────────────────────────────────────────────────────────────────
async function post(path, body, token, extra = {}) {
  const r = await fetch(SUPABASE_URL + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: ANON,                      // ⚠ SIEMPRE los dos headers: sin `apikey`
      Authorization: "Bearer " + token,  //   las claves nuevas dan 403 (ver CLAUDE.md §3)
      ...extra,
    },
    body: JSON.stringify(body),
  });
  const txt = await r.text();
  let data = null;
  try { data = txt ? JSON.parse(txt) : null; } catch { data = txt; }
  if (!r.ok) {
    const msg = (data && (data.message || data.error_description || data.error || data.hint)) || txt;
    throw new Error(`${r.status} ${String(msg).slice(0, 300)}`);
  }
  return data;
}

async function get(path, token) {
  const r = await fetch(SUPABASE_URL + path, {
    headers: { apikey: ANON, Authorization: "Bearer " + token },
  });
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// ── login ───────────────────────────────────────────────────────────────────
// Mismo esquema sintetico que el sitio: <digitos del cuit>@cuit.loekemeyer + PIN.
async function login(cuit, pin) {
  const email = String(cuit).replace(/\D/g, "") + "@cuit.loekemeyer";
  const d = await post("/auth/v1/token?grant_type=password", { email, password: pin }, ANON);
  return { token: d.access_token, userId: d.user.id };
}

// ── armado del payload ──────────────────────────────────────────────────────
// Se piden productos REALES y activos, y se descartan los que el guard de
// backend bloquea (SIN STOCK / PROXIMAMENTE). Si no, la prueba mide el guard
// en vez de medir la carga: 100 rechazos en 40 ms no dicen nada.
async function traerProductos(token, cuantos) {
  const ps = await get(
    "/rest/v1/products?select=id,cod,uxb,list_price,badge_status,active" +
    "&active=eq.true&limit=400",
    token,
  );
  const sanos = ps.filter((p) => {
    const b = String(p.badge_status || "").trim().toUpperCase();
    return b !== "SIN STOCK" && b !== "PROXIMAMENTE" && b !== "PRÓXIMAMENTE";
  });
  if (sanos.length < cuantos) {
    console.warn(`⚠ solo ${sanos.length} productos pedibles; se usan todos y se repiten`);
  }
  return sanos;
}

async function traerPerfil(token, userId) {
  const c = await get(
    `/rest/v1/customers?select=id,cod_cliente,business_name,dto_vol,modo_presupuesto` +
    `&auth_user_id=eq.${userId}&limit=1`,
    token,
  );
  if (!c.length) throw new Error("El usuario no tiene ficha en customers");
  return c[0];
}

function armarItems(prods, n, semilla) {
  const items = [];
  for (let i = 0; i < n; i++) {
    const p = prods[(semilla + i) % prods.length];
    items.push({
      product_id: p.id,
      cajas: 1 + ((semilla + i) % 3),
      uxb: Number(p.uxb || 12),
      is_loke: false,
      source: "stress-test",
    });
  }
  return items;
}

// ⚠ El total VARIA por pedido a proposito. El guard anti-reintento de
// submit_order_fast colapsa pedidos del mismo cliente con el MISMO total y la
// misma cantidad de lineas dentro de 2 minutos: mandando 100 identicos, 99
// vuelven con el id del primero, la prueba da "100 ok" en 200 ms y no se probo
// nada. Para probar el guard esta --test-guard, que es otra cosa.
function totalDe(items, semilla) {
  const base = items.reduce((a, it) => a + it.cajas * it.uxb * 100, 0);
  return Math.round((base + semilla) * 100) / 100;
}

// ── una confirmacion completa ───────────────────────────────────────────────
async function unPedido({ token, userId, perfil, prods, semilla, escribir, conEfectos }) {
  const items = armarItems(prods, CFG.lineas, semilla);
  const total = totalDe(items, semilla);

  if (!escribir) {
    // SIMULACRO: el camino de lectura que hace el navegador justo antes de
    // confirmar (perfil, direcciones, historico para la deteccion de anomalias).
    // No escribe una sola fila y ya estresa auth + PostgREST + el pool, que es
    // donde esta la mitad del problema.
    await Promise.all([
      get(`/rest/v1/customers?select=id,cod_cliente,dto_vol&id=eq.${perfil.id}`, token),
      get(`/rest/v1/customer_delivery_addresses?select=id,provincia,localidad&customer_id=eq.${perfil.id}&limit=20`, token),
      get(`/rest/v1/orders?select=id,total,created_at&customer_id=eq.${perfil.id}&order=id.desc&limit=10`, token),
    ]);
    return { orderId: null };
  }

  const orderId = await post(
    "/rest/v1/rpc/submit_order_fast",
    {
      p_auth_user_id: userId,
      p_customer_id: perfil.id,
      p_status: "pendiente",
      p_payment_method: "STRESS TEST — NO DESPACHAR",
      p_payment_discount: 0,
      p_web_discount: 0,
      p_subtotal: total,
      p_total: total,
      p_items: items,
      p_sheets_payload: {
        cod_cliente: perfil.cod_cliente,
        cliente: perfil.business_name,
        // Marca para poder encontrarlos y borrarlos despues. NO sacarla.
        observaciones: "STRESS TEST — NO DESPACHAR — borrar",
        stress_test: true,
        source: "Web",
        mode: "new",
        items: items.map((it) => ({ cod_art: "", cajas: it.cajas, uxb: it.uxb })),
      },
    },
    token,
  );

  if (conEfectos) {
    // ⚠ ESTO ES LA PRUEBA, no un extra. script.js dispara despues de la RPC:
    // 1 update a orders, UN update a order_items POR LINEA, y (aca cortado) los
    // dos proxies de Sheets. Sin esto se mide una RPC, no un pedido.
    const tareas = [
      post(`/rest/v1/orders?id=eq.${orderId}`, { is_promo: false, extra_discount: 0, placed_by_auth_user_id: userId },
        token, { Prefer: "return=minimal", "Content-Profile": "public" })
        .catch(() => {}),
    ];
    for (const it of items) {
      tareas.push(
        fetch(`${SUPABASE_URL}/rest/v1/order_items?order_id=eq.${orderId}&product_id=eq.${it.product_id}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            apikey: ANON, Authorization: "Bearer " + token, Prefer: "return=minimal",
          },
          body: JSON.stringify({ source: it.source }),
        }).catch(() => {}),
      );
    }
    await Promise.all(tareas);
  }

  return { orderId };
}

// ── tandas ──────────────────────────────────────────────────────────────────
// Se lanzan TODAS en el mismo tick. Un for..await con await adentro seria una
// cola, no concurrencia, y daria verde siempre.
async function tanda(n, ctx, etiqueta) {
  const lat = [], errs = [], ids = [];
  const t0 = Date.now();
  const rs = await Promise.allSettled(
    Array.from({ length: n }, (_, i) => {
      const t = Date.now();
      return unPedido({ ...ctx, semilla: Date.now() % 100000 + i * 7 })
        .then((r) => { lat.push(Date.now() - t); if (r.orderId) ids.push(r.orderId); })
        .catch((e) => { errs.push(e); throw e; });
    }),
  );
  void rs;
  const r = resumen(etiqueta, lat, errs, Date.now() - t0);
  return { ...r, ids };
}

// ── la carrera del doble click ──────────────────────────────────────────────
// El guard anti-reintento hace SELECT y despues INSERT sin ningun lock. Dos
// requests del mismo cliente en el mismo instante no se ven (la fila del otro
// todavia no esta commiteada) y los dos insertan. Justo el caso que el guard
// dice cubrir. Esto lo mide: si devuelve ids distintos, se escapo.
async function testGuard(ctx) {
  console.log("\n══ CARRERA DEL DOBLE CLICK ══");
  console.log("   10 pedidos IDENTICOS del mismo cliente, lanzados juntos.");
  console.log("   Esperado si el guard aguanta: 1 id distinto. Si aparecen mas,");
  console.log("   el guard pierde bajo concurrencia (SELECT + INSERT sin lock).");
  const items = armarItems(ctx.prods, CFG.lineas, 42);
  const total = totalDe(items, 0);
  const uno = () =>
    post("/rest/v1/rpc/submit_order_fast", {
      p_auth_user_id: ctx.userId, p_customer_id: ctx.perfil.id, p_status: "pendiente",
      p_payment_method: "STRESS TEST — NO DESPACHAR", p_payment_discount: 0, p_web_discount: 0,
      p_subtotal: total, p_total: total, p_items: items,
      p_sheets_payload: { observaciones: "STRESS TEST — NO DESPACHAR — borrar", stress_test: true, items: [] },
    }, ctx.token);
  const rs = await Promise.allSettled(Array.from({ length: 10 }, uno));
  const ids = [...new Set(rs.filter((r) => r.status === "fulfilled").map((r) => r.value))];
  console.log(`   → ${ids.length} pedido(s) distinto(s): ${ids.join(", ")}`);
  console.log(ids.length === 1
    ? "   ✔ el guard aguanto"
    : `   ✗ SE ESCAPARON ${ids.length - 1}: el cliente veria ${ids.length} pedidos por un click`);
  return ids;
}

// ── limpieza ────────────────────────────────────────────────────────────────
async function limpiar(token) {
  const pend = await get(
    "/rest/v1/orders?select=id,created_at&sheets_payload->>stress_test=eq.true&order=id.desc&limit=500",
    token,
  );
  if (!pend.length) { console.log("Nada que limpiar."); return; }
  console.log(`\n⚠ ${pend.length} pedidos de prueba a borrar: ${pend[pend.length - 1].id}..${pend[0].id}`);
  console.log("   Se borran order_items primero (hijos antes que padres).");
  for (const o of pend) {
    await fetch(`${SUPABASE_URL}/rest/v1/order_items?order_id=eq.${o.id}`, {
      method: "DELETE", headers: { apikey: ANON, Authorization: "Bearer " + token },
    });
    await fetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${o.id}`, {
      method: "DELETE", headers: { apikey: ANON, Authorization: "Bearer " + token },
    });
  }
  console.log(`✔ borrados ${pend.length}.`);
  console.log("⚠ Revisar a mano: wa_outbox (context='order_created') y, si paso el cron,");
  console.log("  lk_pedidos_match en Gestion Virgilio.");
}

// ── main ────────────────────────────────────────────────────────────────────
const AYUDA = `
tests/stress-pedidos.mjs — cuantos pedidos simultaneos aguanta el sitio

  --n <N>          pedidos en paralelo (default 100)
  --lineas <N>     lineas por pedido (default 17; la mediana real es 14)
  --modo carga     ESCRIBE pedidos reales (pide --si-escribir-en-produccion)
  --rampa          escalones 1,5,10,20,50,N en vez de un solo golpe
  --test-guard     10 pedidos identicos juntos: ¿el guard anti-reintento aguanta?
  --sin-efectos    solo la RPC, sin los ~19 updates que dispara script.js
  --limpiar        borra los pedidos que dejo este script
  -v               verboso

  env: LK_CUIT, LK_PIN (cliente de prueba), LK_ANON_KEY (opcional)
`;

(async function main() {
  if (flag("help") || flag("h")) { console.log(AYUDA); return; }
  if (!ANON) { console.error("Falta LK_ANON_KEY (o no se pudo leer de script.js)."); process.exit(1); }
  const cuit = process.env.LK_CUIT, pin = process.env.LK_PIN;
  if (!cuit || !pin) {
    console.error("Falta LK_CUIT / LK_PIN (cliente de prueba).");
    console.error("  export LK_CUIT=30xxxxxxxxx && export LK_PIN=123456");
    process.exit(1);
  }

  const escribir = CFG.modo === "carga" || CFG.testGuard;
  if (escribir && !CFG.autorizado) {
    console.error("\n⛔ El modo `carga` ESCRIBE PEDIDOS REALES en produccion.");
    console.error("   Antes de correrlo, estos son los seis efectos colaterales:\n");
    EFECTOS_COLATERALES.forEach((e, i) => console.error(`   ${i + 1}. ${e}`));
    console.error("\n   Si igual va, agregar --si-escribir-en-produccion.\n");
    process.exit(2);
  }

  const t0 = Date.now();
  const { token, userId } = await login(cuit, pin);
  console.log(`login ok en ${ms(Date.now() - t0)}`);

  if (CFG.limpiar) { await limpiar(token); return; }

  const perfil = await traerPerfil(token, userId);
  const prods = await traerProductos(token, CFG.lineas);
  console.log(`cliente ${perfil.cod_cliente} — ${perfil.business_name}`);
  console.log(`modo ${CFG.modo}${escribir ? " (ESCRIBE)" : " (no escribe)"} · ` +
              `${CFG.lineas} lineas/pedido · efectos ${CFG.conEfectos ? "SI" : "no"}`);
  if (CFG.conEfectos && escribir) {
    console.log(`⚠ con efectos, cada pedido son ~${CFG.lineas + 2} requests: ` +
                `${CFG.n} pedidos ≈ ${CFG.n * (CFG.lineas + 2)} requests HTTP.`);
  }

  const ctx = { token, userId, perfil, prods, escribir, conEfectos: CFG.conEfectos };
  const creados = [];

  if (CFG.testGuard) { await testGuard(ctx); }

  // RAMPA: el dato util no es "100 rompe si/no", es EN CUANTO empieza a doler.
  const niveles = CFG.rampa ? [1, 5, 10, 20, 50, CFG.n].filter((x, i, a) => x <= CFG.n && a.indexOf(x) === i)
                            : [CFG.n];
  for (const n of niveles) {
    const r = await tanda(n, ctx, `${n} en paralelo`);
    creados.push(...r.ids);
    if (niveles.length > 1 && n !== niveles[niveles.length - 1]) {
      await new Promise((r2) => setTimeout(r2, 3000)); // dejar respirar entre escalones
    }
  }

  if (creados.length) {
    console.log(`\n⚠ QUEDARON ${creados.length} PEDIDOS DE PRUEBA EN PRODUCCION.`);
    console.log(`   Rango: ${Math.min(...creados)}..${Math.max(...creados)}`);
    console.log("   Borralos YA — el cron a Virgilio corre cada 15 min:");
    console.log("       node tests/stress-pedidos.mjs --limpiar");
  }
})().catch((e) => { console.error("\n✗ " + e.message); process.exit(1); });
