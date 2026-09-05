/* Regresión (idea 8743): el estado del pedido en Gestión Virgilio se ve en "Mis pedidos"
   y, facturado o entregado, el pedido ya no se puede editar.

   Dueño (2026-09-04): "cuando un pedido queda facturado debería mostrarlo en la página y
   decir que ya no se puede modificar". El candado de verdad vive en la RPC
   `edit_order_fast` (FDW a virgilio.gv_pedido_web_estado_pagina); esto prueba la mitad
   del front, extrayendo las funciones POR NOMBRE del script.js real (mismo truco que
   tests/solo-agregar.cjs):
   (a) isOrderEditable: editable sin estado; NO editable facturado / entregado / enviado
       a compras; y ya NO existe el corte de las 12:30 (el mail está apagado),
   (b) getOrderStage: sin_programar → Recibido (0), programado → Programado (1, "para
       fecha"), en_picking/armado → En preparación (1), facturado → Facturado (2),
       entregado → Entregado (3); sin estado de Gestión cae al order_tracking de siempre
       (entregado ahora es la etapa 3),
   (c) renderStepper dibuja 4 puntos: Recibido · Programado · Facturado · Entregado.

   Correr:  node tests/estado-gestion.cjs
*/
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const src = fs.readFileSync(path.join(__dirname, "..", "script.js"), "utf8");

function extraer(nombre) {
  const i = src.indexOf("function " + nombre + "(");
  if (i < 0) throw new Error("no encontré function " + nombre + "() en script.js");
  let j = src.indexOf("{", i), prof = 0;
  for (let k = j; k < src.length; k++) {
    if (src[k] === "{") prof++;
    else if (src[k] === "}") { prof--; if (prof === 0) return src.slice(i, k + 1); }
  }
  throw new Error("no cerré las llaves de " + nombre);
}

const sandbox = { gvByOrder: {}, trackByNp: {}, Date: Date, String: String, console: console };
vm.createContext(sandbox);
for (const fn of ["isOrderEditable", "getOrderStage", "renderStepper"]) vm.runInContext(extraer(fn), sandbox);

const hace = (js) => vm.runInContext(js, sandbox);
const checks = [];
const ck = (nombre, ok) => checks.push([nombre, !!ok]);

// (a) isOrderEditable
const viejo = { id: 1, created_at: "2026-09-01T08:00:00-03:00", enviado_a_compras_at: null };   // de hace días, creado a la mañana
ck("sin estado de Gestión → editable (ya no hay corte de las 12:30)", hace("isOrderEditable(" + JSON.stringify(viejo) + ", undefined)") === true);
ck("programado → editable (sólo agregar)",                           hace("isOrderEditable(" + JSON.stringify(viejo) + ", {estado:'programado',facturado:false,entregado:false})") === true);
ck("facturado → NO editable",                                        hace("isOrderEditable(" + JSON.stringify(viejo) + ", {estado:'facturado',facturado:true,entregado:false})") === false);
ck("entregado → NO editable",                                        hace("isOrderEditable(" + JSON.stringify(viejo) + ", {estado:'entregado',facturado:true,entregado:true})") === false);
ck("enviado a compras → NO editable (legado)",                       hace("isOrderEditable({id:2,created_at:'2026-09-05T08:00:00-03:00',enviado_a_compras_at:'2026-09-05T15:30:00Z'}, undefined)") === false);

// (b) getOrderStage
hace("gvByOrder = { '10': {estado:'sin_programar',facturado:false,entregado:false}, '11': {estado:'programado',fecha_entrega:'2026-09-08',facturado:false,entregado:false}, '12': {estado:'en_picking',fecha_entrega:'2026-09-08',facturado:false,entregado:false}, '13': {estado:'facturado',facturado:true,entregado:false}, '14': {estado:'entregado',facturado:true,entregado:true,entregado_at:'2026-09-08T18:00:00Z'} }; trackByNp = { '20': {status:'entregado',fecha_entrega:'2026-09-01'}, '21': {status:'programado',fecha_entrega:'2026-09-02'} };");
const st = (id) => hace("getOrderStage(" + id + ")");
ck("sin_programar → Recibido / 0",           st(10).stage === 0 && st(10).label === "Recibido");
ck("programado → Programado / 1, 'para …'",  st(11).stage === 1 && st(11).label === "Programado" && /^para /.test(st(11).subtitle));
ck("en_picking → En preparación / 1",        st(12).stage === 1 && st(12).label === "En preparación");
ck("facturado → Facturado / 2, avisa",       st(13).stage === 2 && st(13).label === "Facturado" && /no se puede modificar/.test(st(13).subtitle));
ck("entregado → Entregado / 3, 'el …'",      st(14).stage === 3 && st(14).label === "Entregado" && /^el /.test(st(14).subtitle));
ck("sin Gestión: tracking entregado → 3",    st(20).stage === 3 && st(20).label === "Entregado");
ck("sin Gestión: tracking programado → 1",   st(21).stage === 1 && st(21).label === "Programado");
ck("sin nada → Recibido / 0",                st(99).stage === 0);

// (c) renderStepper
const html = hace("renderStepper({stage:2,label:'Facturado',subtitle:''})");
ck("4 puntos en el stepper",                 (html.match(/o-dot/g) || []).length === 4);
ck("títulos Recibido·Programado·Facturado·Entregado", /Recibido/.test(html) && /Programado/.test(html) && /Facturado/.test(html) && /Entregado/.test(html));
ck("3 puntos hechos con stage 2",            (html.match(/o-dot done/g) || []).length === 3);

let bad = 0;
for (const [n, ok] of checks) { console.log((ok ? "  ok   " : "  FALLA") + " · " + n); if (!ok) bad++; }
console.log(bad ? "estado-gestion: " + bad + " FALLA(S)" : "estado-gestion: OK (" + checks.length + " chequeos)");
process.exit(bad ? 1 : 0);
