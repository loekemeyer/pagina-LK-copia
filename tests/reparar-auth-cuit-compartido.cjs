/* Regresión (02/10/2026, Tomás Gonzalez): «Reparar Auth» le pisaba la clave a OTRO cliente.

   El login es uno por CUIT (<cuit>@cuit.loekemeyer). En Chef, 274/2311/1708 no tenían login
   porque su CUIT ya entraba como 2447/1310/1589. Reparar Auth los tomó como "sin login",
   la Edge Function encontró la cuenta del CUIT y la SINCRONIZÓ con el PIN del código viejo,
   y recién después falló con "duplicate key" al vincularla: los tres activos quedaron sin
   poder entrar con su PIN.

   Se prueba, corriendo la función REAL (extraída por nombre):
     A. un sin-login cuyo CUIT ya entra con otro código → devuelve ese otro (se saltea)
     B. un sin-login sin otro código con login → null (se repara)
     C. el mismo código no cuenta como "otro"; CUIT con guiones/espacios se compara limpio
   Y un candado: el botón filtra con esa función ANTES de llamar a la Edge Function.

   Correr:  node tests/reparar-auth-cuit-compartido.cjs
            LK_ROOT=../paginach node tests/reparar-auth-cuit-compartido.cjs
            LK_ROOT=../Gestion-Virgilio/admin node tests/reparar-auth-cuit-compartido.cjs
*/
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = process.env.LK_ROOT || path.join(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "admin.js"), "utf8");

function extraer(nombre) {
  const i = src.indexOf("function " + nombre + "(");
  if (i < 0) throw new Error("no encontré function " + nombre + "() en admin.js");
  let j = src.indexOf("{", i), prof = 0;
  for (let k = j; k < src.length; k++) {
    if (src[k] === "{") prof++;
    else if (src[k] === "}") { prof--; if (prof === 0) return src.slice(i, k + 1); }
  }
  throw new Error("no cerré las llaves de " + nombre);
}

let fallas = 0;
function ok(cond, msg) { console.log((cond ? "  ✓ " : "  ✗ ") + msg); if (!cond) fallas++; }

const ctx = {};
vm.createContext(ctx);
vm.runInContext(extraer("cleanCuit") + "\n" + extraer("_repairCuitConLoginDeOtro"), ctx);
const f = ctx._repairCuitConLoginDeOtro;

const lista = [
  { id: 1, cod_cliente: 2447, cuit: "27-05499563-1", auth_user_id: "u-2447", pin: "11112222" },
  { id: 2, cod_cliente: 274, cuit: "27054995631", auth_user_id: null, pin: "33334444" },
  { id: 3, cod_cliente: 999, cuit: "20111111112", auth_user_id: null, pin: "55556666" },
];

console.log("A. CUIT que ya entra con otro código");
const a = f(lista[1], lista);
ok(a && a.cod_cliente === 2447, "274 sin login → devuelve 2447 (no se repara)");
console.log("B. CUIT sin otro login");
ok(f(lista[2], lista) === null, "999 → null (se repara)");
console.log("C. bordes");
ok(f(lista[0], lista) === null, "2447 no se cuenta a sí mismo");
ok(f({ id: 9, cuit: "" }, lista) === null, "sin CUIT → null");

console.log("D. candado sobre el botón");
const i = src.indexOf('getElementById("repairAuthBtn")');
const bloque = src.slice(i, i + 4000);
const iFiltro = bloque.indexOf("_repairCuitConLoginDeOtro(");
const iEdge = bloque.search(/_createAuthWithRetry\(|createAuthUser\(/);
ok(i >= 0 && iFiltro > 0, "Reparar Auth llama a _repairCuitConLoginDeOtro");
ok(iFiltro > 0 && iEdge > iFiltro, "…antes de llamar a la Edge Function");

if (fallas) { console.log("\n✗ " + fallas + " fallas"); process.exit(1); }
console.log("\n✓ reparar-auth-cuit-compartido OK");
