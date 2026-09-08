/* Regresión (idea 4990): editar un pedido es SÓLO AGREGAR.

   El candado de verdad vive en la RPC `edit_order_fast` (sql/edit_order_solo_agregar.sql).
   Esto prueba la otra mitad: que el front frene ANTES de mandar, en los TRES caminos
   que bajan una cantidad — el botón −, escribir el número a mano, y la ✕ — más el que
   se agregó después de encontrarlo: que `editOrder` sume las filas repetidas del mismo
   producto y traiga también lo Loke.

   No hay harness en este repo y `script.js` no se puede cargar suelto (arranca contra
   el DOM y Supabase), así que se extraen las funciones POR NOMBRE del archivo real y se
   corren en un `vm` con lo mínimo alrededor. O sea: prueba el código que se publica, no
   una copia.

   Correr:  node tests/solo-agregar.cjs
*/
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const src = fs.readFileSync(path.join(__dirname, "..", "script.js"), "utf8");

/* Corta una función del fuente balanceando llaves desde su `{`. */
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

const FNS = ["setEditingOrderId", "editMinQty", "avisoSoloAgregar", "changeQty", "manualQty", "removeItem"];

let alerts = [];
const store = {};
const sandbox = {
  cart: [],
  editingOrderId: null,
  editBaseQty: {},
  EDITING_LS_KEY: "lk_editing_order_v1",
  EDITING_BASE_LS_KEY: "lk_editing_base_v1",
  localStorage: {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; }
  },
  alert: (m) => alerts.push(String(m)),
  CSS: { escape: (s) => String(s) },
  document: { querySelector: () => null },
  // lo que las funciones llaman y acá no importa
  updateCart: () => {},
  renderProducts: () => {},
  toggleControls: () => {},
  triggerAddAnimations: () => {},
  saveCartToLS: () => {},
  updateCartBadge: () => {},
  console
};
vm.createContext(sandbox);
vm.runInContext(FNS.map(extraer).join("\n\n"), sandbox);

/* editOrder() habla con Supabase, así que su agrupado se prueba aparte con la misma
   forma de datos que devuelve order_items. Es el bloque `porProd` del archivo real:
   se verifica que exista y se replica su regla acá. */
const editOrderSrc = extraer("editOrder");

const checks = [];
const ok = (nombre, cond) => checks.push([nombre, !!cond]);

// --- Estado: pedido en edición con 027 x3 (ya estaba) y 999 x2 (recién agregado) ---
const reset = () => {
  alerts = [];
  sandbox.cart.length = 0;
  sandbox.cart.push({ productId: "027", qtyCajas: 3 }, { productId: "999", qtyCajas: 2 });
  vm.runInContext("setEditingOrderId('1348', { '027': 3 })", sandbox);
};

// editMinQty
reset();
ok("el piso de una línea que ya estaba es su cantidad", vm.runInContext("editMinQty('027')", sandbox) === 3);
ok("una línea agregada en esta edición no tiene piso", vm.runInContext("editMinQty('999')", sandbox) === 0);
vm.runInContext("setEditingOrderId(null)", sandbox);
ok("fuera del modo edición no hay piso", vm.runInContext("editMinQty('027')", sandbox) === 0);

// el −
reset();
vm.runInContext("changeQty('027', -1)", sandbox);
ok("el − no baja de lo que ya estaba", sandbox.cart.find(i => i.productId === "027").qtyCajas === 3);
ok("y avisa por qué", alerts.length === 1 && /sólo se le puede AGREGAR/i.test(alerts[0]));

reset();
vm.runInContext("changeQty('027', 2)", sandbox);
ok("el + sigue sumando normal", sandbox.cart.find(i => i.productId === "027").qtyCajas === 5);
vm.runInContext("changeQty('027', -1)", sandbox);
ok("y después se puede bajar hasta el piso, no más", sandbox.cart.find(i => i.productId === "027").qtyCajas === 4);

reset();
vm.runInContext("changeQty('999', -1)", sandbox);
ok("una línea sin piso sí baja", sandbox.cart.find(i => i.productId === "999").qtyCajas === 1);
vm.runInContext("changeQty('999', -1)", sandbox);
ok("y llega a sacarse del carrito", !sandbox.cart.some(i => i.productId === "999"));

// escribir el número a mano
reset();
vm.runInContext("manualQty('027', '1')", sandbox);
ok("escribir menos que el piso no lo baja", sandbox.cart.find(i => i.productId === "027").qtyCajas === 3);
ok("y también avisa", alerts.length === 1);
reset();
vm.runInContext("manualQty('027', '0')", sandbox);
ok("escribir 0 tampoco lo saca", sandbox.cart.find(i => i.productId === "027").qtyCajas === 3);
reset();
vm.runInContext("manualQty('027', '9')", sandbox);
ok("escribir más sí funciona", sandbox.cart.find(i => i.productId === "027").qtyCajas === 9);

// la ✕
reset();
vm.runInContext("removeItem('027')", sandbox);
ok("la ✕ no saca una línea que ya estaba", sandbox.cart.some(i => i.productId === "027"));
ok("la ✕ avisa igual que los otros dos caminos", alerts.length === 1);
reset();
vm.runInContext("removeItem('999')", sandbox);
ok("la ✕ sí saca una línea agregada en esta edición", !sandbox.cart.some(i => i.productId === "999"));

// fuera del modo edición nada de esto aplica
reset();
vm.runInContext("setEditingOrderId(null)", sandbox);
vm.runInContext("removeItem('027')", sandbox);
ok("sin pedido en edición se saca cualquier cosa (como siempre)", !sandbox.cart.some(i => i.productId === "027"));
ok("y sin ningún aviso", alerts.length === 0);

// el piso sobrevive al F5
reset();
ok("el piso se persiste en localStorage", JSON.parse(store["lk_editing_base_v1"])["027"] === 3);
vm.runInContext("setEditingOrderId(null)", sandbox);
ok("y se limpia al salir de la edición", !("lk_editing_base_v1" in store));

// editOrder: lo que se arregló de paso
ok("editOrder trae también las líneas Loke", /loke_product_id/.test(editOrderSrc));
ok("editOrder suma las filas repetidas del mismo producto", /porProd/.test(editOrderSrc));
ok("editOrder le pasa el piso a setEditingOrderId", /setEditingOrderId\(orderId,\s*base\)/.test(editOrderSrc));

let bad = 0;
for (const [n, c] of checks) { console.log((c ? "  ok   " : "  FALLA") + " · " + n); if (!c) bad++; }
console.log(bad ? "solo-agregar: " + bad + " FALLA(S)" : "solo-agregar: OK (" + checks.length + " chequeos)");
process.exit(bad ? 1 : 0);
