#!/usr/bin/env node
/* v23.37 (Luis, 28/09/2026): "le tiene que saltar a la sesion que esta tratando de cambiar la regla
   para que frene y pida confirmacion positiva del usuario".
   Hook PreToolUse de las herramientas SQL de Supabase. Si el SQL REEMPLAZA / BORRA / ALTERA un objeto
   que tiene una regla en GV_Reglas_Centinela (o toca el centinela mismo), la llamada se FRENA y el
   modelo recibe la regla con la instruccion de pedirle al usuario un "si" explicito.
   Con el "si" del usuario, se reintenta agregando al SQL el comentario  -- REGLA_CONFIRMADA_POR_USUARIO
   y entonces el hook pide el permiso en pantalla (ask) mostrando la regla, en vez de frenar.
   La lista sale de scripts/reglas-protegidas.json. Regenerarla (MCP, proyecto hrxfctzncixxqmpfhskv):
     select json_agg(json_build_object('objeto',objeto,'regla',left(regla,160),'quien',quien) order by objeto)
       from (select objeto, (array_agg(regla order by id))[1] regla,
                    string_agg(distinct coalesce(quien_pidio,''), ', ') quien
               from public."GV_Reglas_Centinela" where activo group by objeto) z;
   Al agregar una fila al centinela, agregar el objeto al JSON (o regenerarlo). */
const fs = require("fs"), path = require("path");
const TOKEN = "REGLA_CONFIRMADA_POR_USUARIO";
function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function cargar() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, "reglas-protegidas.json"), "utf8")).reglas || []; }
  catch (_e) { return []; }
}
function revisar(sql, reglas) {
  const q = String(sql || "");
  const hits = [];
  const ddl = "(?:create\\s+or\\s+replace\\s+(?:function|view|trigger|materialized\\s+view)|create\\s+(?:function|view|trigger|materialized\\s+view)|drop\\s+(?:function|view|trigger|materialized\\s+view)(?:\\s+if\\s+exists)?|alter\\s+(?:function|view|materialized\\s+view|trigger))";
  const hayExecute = /\bexecute\b/i.test(q);
  for (const r of reglas) {
    const n = esc(r.objeto);
    const re1 = new RegExp(ddl + "\\s+(?:\"?public\"?\\.)?\"?" + n + "\"?(?![A-Za-z0-9_])", "i");
    const re2 = new RegExp("pg_get_(?:functiondef|viewdef)\\s*\\(\\s*'(?:public\\.)?\"?" + n + "\"?[('\"]", "i");
    if (re1.test(q) || (hayExecute && re2.test(q))) hits.push(r);
  }
  if (/(?:delete\s+from|update|truncate(?:\s+table)?|alter\s+table|drop\s+table)\s+(?:"?public"?\.)?"?GV_Reglas_Centinela/i.test(q) ||
      /(?:create\s+or\s+replace\s+(?:view|function)|drop\s+(?:view|function))\s+(?:"?public"?\.)?"?(?:gv_reglas_perdidas|gv_regla_presente)\b/i.test(q))
    hits.push({ objeto: "GV_Reglas_Centinela / gv_reglas_perdidas", regla: "El centinela de reglas: apagarlo o cambiarlo deja todas las reglas sin vigilancia", quien: "Luis, Thomas" });
  return hits;
}
function main(input) {
  let ev = {};
  try { ev = JSON.parse(input || "{}"); } catch (_e) { return ""; }
  // Las reglas son de la base de Gestion Virgilio: SQL contra otro proyecto (LK, Chef) no se mira.
  const pid = (ev.tool_input && ev.tool_input.project_id) || "";
  if (pid && pid !== "hrxfctzncixxqmpfhskv") return "";
  const sql = (ev.tool_input && (ev.tool_input.query || ev.tool_input.sql)) || "";
  const hits = revisar(sql, cargar());
  if (!hits.length) return "";
  const lista = hits.map(function (h) { return "• " + h.objeto + " — " + h.regla + " (pidió: " + (h.quien || "?") + ")"; }).join("\n");
  const confirmado = sql.indexOf(TOKEN) >= 0;
  const out = { hookSpecificOutput: { hookEventName: "PreToolUse" } };
  if (confirmado) {
    out.hookSpecificOutput.permissionDecision = "ask";
    out.hookSpecificOutput.permissionDecisionReason = "Este SQL cambia objetos con REGLA PROTEGIDA:\n" + lista + "\nConfirmá sólo si ya aceptaste este cambio en el chat.";
  } else {
    out.hookSpecificOutput.permissionDecision = "deny";
    out.hookSpecificOutput.permissionDecisionReason =
      "FRENADO: este SQL reemplaza, borra o altera un objeto con una REGLA PROTEGIDA (GV_Reglas_Centinela):\n" + lista +
      "\nNO lo reintentes por tu cuenta. Explicale al usuario qué regla toca este cambio y si la regla sigue en pie después, " +
      "y pedile una confirmación EXPLÍCITA (un \"sí\"). Recién con su sí, reintentá agregando al SQL el comentario -- " + TOKEN +
      ". Antes de reescribir el objeto, traé su definición VIVA (pg_get_functiondef / pg_get_viewdef) y agregale el cambio encima.";
  }
  return JSON.stringify(out);
}
module.exports = { revisar, main, TOKEN };
if (require.main === module) {
  let buf = "";
  process.stdin.on("data", function (c) { buf += c; });
  process.stdin.on("end", function () { const o = main(buf); if (o) process.stdout.write(o); process.exit(0); });
}
