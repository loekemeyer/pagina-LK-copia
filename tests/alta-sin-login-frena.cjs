/* Regresión (problema 679, 02/10/2026, Tomás Gonzalez): el alta de un cliente NO puede
   quedar sin login.

   Supabase Auth de LK tiene la protección de contraseñas filtradas (HIBP) y rechaza casi
   todo PIN de 6 dígitos con 422. crear-cliente-auth devolvía error, `createAuthUser`
   (admin.js) y `_expoCreateAuthUser` (script.js) devolvían null y el cliente se guardaba
   IGUAL, sin auth_user_id: el panel mostraba CUIT y PIN y la página decía "incorrectos".
   25 clientes así al 02/10.

   Lo que se prueba, corriendo las funciones REALES (extraídas por nombre) en un vm con un
   fetch falso:
     A. login rechazado (pin_debil) → TIRA, y el mensaje dice por qué
     B. login creado → devuelve el id
     C. sin CUIT → null (no hay login posible, el alta sigue)
     D. CUIT que ya tiene login (409) → tira "ya tiene usuario" (regla del 24/09)
     E. sin sesión / error de red → tira
     F. lo mismo para la página (alta de expo / vendedor)
   Y dos candados de texto sobre lo que no se puede correr suelto:
     G. la importación masiva NO inserta las filas cuyo login falló
     H. en la página el login se intenta ANTES de reservar el código de cliente
     I. la Edge Function devuelve pin_debil y mira el error de updateUserById

   Correr:  node tests/alta-sin-login-frena.cjs
*/
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = process.env.LK_ROOT || path.join(__dirname, "..");
const adminSrc = fs.readFileSync(path.join(ROOT, "admin.js"), "utf8");
const scriptSrc = fs.readFileSync(path.join(ROOT, "script.js"), "utf8");
const edgeSrc = fs.readFileSync(
  path.join(ROOT, "supabase/functions/crear-cliente-auth/index.ts"), "utf8");

function extraer(src, nombre, archivo) {
  let i = src.indexOf("async function " + nombre + "(");
  if (i < 0) i = src.indexOf("function " + nombre + "(");
  if (i < 0) throw new Error("no encontré function " + nombre + "() en " + archivo);
  let j = src.indexOf("{", i), prof = 0;
  for (let k = j; k < src.length; k++) {
    if (src[k] === "{") prof++;
    else if (src[k] === "}") { prof--; if (prof === 0) return src.slice(i, k + 1); }
  }
  throw new Error("no cerré las llaves de " + nombre);
}
function opcional(src, nombre, archivo) {
  try { return extraer(src, nombre, archivo); } catch (e) { return ""; }
}

let fallas = 0;
function ok(cond, msg) {
  console.log((cond ? "  ✓ " : "  ✗ ") + msg);
  if (!cond) fallas++;
}

function sandbox(respuesta, conSesion) {
  const toasts = [];
  const sesion = conSesion === false ? null : { access_token: "tok" };
  const ctx = {
    console: { warn: () => {}, log: () => {} },
    toasts,
    SUPABASE_URL: "https://x.supabase.co",
    SUPABASE_ANON_KEY: "anon",
    toast: (m, t) => toasts.push(String(m) + "|" + (t || "")),
    sb: { auth: { getSession: async () => ({ data: { session: sesion } }) } },
    supabaseClient: { auth: { getSession: async () => ({ data: { session: sesion } }) } },
    fetch: async () => {
      if (respuesta === "red") throw new TypeError("Failed to fetch");
      return {
        ok: respuesta.status >= 200 && respuesta.status < 300,
        status: respuesta.status,
        json: async () => respuesta.body,
      };
    },
  };
  vm.createContext(ctx);
  return ctx;
}

async function correr(src, archivo, fn, aux, args, respuesta, conSesion) {
  const ctx = sandbox(respuesta, conSesion);
  vm.runInContext(opcional(src, aux, archivo) + "\n" + extraer(src, fn, archivo), ctx);
  ctx.__args = args;
  try {
    const v = await vm.runInContext(fn + ".apply(null, __args)", ctx);
    return { valor: v, error: null, toasts: ctx.toasts };
  } catch (e) {
    return { valor: undefined, error: e, toasts: ctx.toasts };
  }
}

(async () => {
  const casos = [
    ["admin.js", adminSrc, "createAuthUser", "_authLoginMotivo"],
    ["script.js", scriptSrc, "_expoCreateAuthUser", "_expoAuthMotivo"],
  ];
  for (const [archivo, src, fn, aux] of casos) {
    console.log("== " + archivo + " · " + fn + " ==");
    let r = await correr(src, archivo, fn, aux, ["27-23883774-5", "443065"],
      { status: 422, body: { error: "pin_debil", detalle: "Password is known to be weak" } });
    ok(r.error && /contraseña filtrada/.test(r.error.message),
      "A. PIN rechazado → tira y dice «contraseña filtrada» (" + (r.error ? r.error.message : "devolvió " + r.valor) + ")");
    ok(!r.toasts.some((t) => /sin acceso login/.test(t)),
      "A. no avisa «se creará sin acceso login»");

    r = await correr(src, archivo, fn, aux, ["27238837745", "443065"],
      { status: 200, body: { id: "uid-1", created: true } });
    ok(r.valor === "uid-1" && !r.error, "B. login creado → devuelve el id");

    r = await correr(src, archivo, fn, aux, ["", "443065"], { status: 200, body: {} });
    ok(r.valor === null && !r.error, "C. sin CUIT → null, el alta sigue");

    r = await correr(src, archivo, fn, aux, ["27238837745", "443065"],
      { status: 409, body: { error: "cuit_ya_registrado" } });
    ok(r.error && /ya tiene usuario/.test(r.error.message), "D. CUIT con login (409) → tira «ya tiene usuario»");

    r = await correr(src, archivo, fn, aux, ["27238837745", "443065"], "red");
    ok(r.error && /red/.test(r.error.message), "E. error de red → tira");

    r = await correr(src, archivo, fn, aux, ["27238837745", "443065"], { status: 200, body: { id: "x" } }, false);
    ok(r.error && /sesión/.test(r.error.message), "E. sin sesión → tira");
  }

  console.log("== candados de texto ==");
  const imp = adminSrc.slice(adminSrc.indexOf('getElementById("importBtn")'));
  const impCuerpo = imp.slice(0, imp.indexOf("// ---- CARGAR SUCURSAL"));
  ok(/sbInsert\(TABLE_CUSTOMERS,\s*aInsertar\)/.test(impCuerpo) && !/sbInsert\(TABLE_CUSTOMERS,\s*importData\)/.test(impCuerpo),
    "G. la importación masiva inserta sólo las filas con login (aInsertar)");

  const guardar = extraer(scriptSrc, "_expoGuardarNuevo", "script.js");
  const iAuth = guardar.indexOf("_expoCreateAuthUser(");
  const iCod = guardar.indexOf('"expo_reservar_cod"');
  ok(iAuth > 0 && iCod > 0 && iAuth < iCod, "H. el login se intenta ANTES de reservar el código");

  ok(/"pin_debil"/.test(edgeSrc) && /esPinDebil\(cErr\)/.test(edgeSrc), "I. la Edge Function devuelve pin_debil");
  ok(/error:\s*uErr\s*}\s*=\s*await admin\.auth\.admin\.updateUserById/.test(edgeSrc) && /if \(uErr\)/.test(edgeSrc),
    "I. «Reparar Auth» mira el error de updateUserById (no dice «sincronizado» si falló)");

  // J. «Reparar Auth» no prueba el PIN de TODOS los clientes con login sin preguntar
  //    (~1.237 ingresos, choca con el límite por IP y los "rate" se pierden en silencio).
  //    Sólo LK tiene esa fase; en Chef el botón repara sólo los que no tienen login.
  const iRep = adminSrc.indexOf('getElementById("repairAuthBtn")');
  if (iRep >= 0 && adminSrc.indexOf("_repairTestPin(", iRep) >= 0) {
    const rep = adminSrc.slice(iRep, adminSrc.indexOf("// ---- VERIFICAR PINES", iRep));
    const iPrompt = rep.indexOf("window.prompt(");
    const iLoop = rep.indexOf("_repairTestPin(");
    ok(iPrompt > 0 && iPrompt < iLoop && /conAuthTodos/.test(rep),
      "J. «Reparar Auth» pregunta a quién revisar el PIN antes de probar ingresos");
  } else {
    console.log("  · J. (este admin no prueba PINes en «Reparar Auth»)");
  }

  console.log(fallas ? "\nROJO — " + fallas + " fallas" : "\nVERDE");
  process.exit(fallas ? 1 : 0);
})();
