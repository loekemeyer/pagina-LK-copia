// v23.37 (Luis, 28/09): el hook frena a la sesión que quiere cambiar un objeto con regla protegida.
const { main, TOKEN } = require("../scripts/claude-reglas-guard.cjs");
let bad = 0; const ok = (c, m) => { if (!c) { bad++; console.error("✗ " + m); } else console.log("✓ " + m); };
const run = (q) => { const o = main(JSON.stringify({ tool_name: "mcp__Supabase__execute_sql", tool_input: { query: q } })); return o ? JSON.parse(o).hookSpecificOutput.permissionDecision : "libre"; };
ok(run("drop trigger if exists gv_ppp_web_super_tanda_sola on public.\"PPP_Web_Programacion\"") === "deny", "dropear el trigger del súper se frena");
ok(run("create or replace function public.gv_ppp_web_super_tanda_sola() returns trigger as $$ begin return new; end $$") === "deny", "reemplazar la función del súper se frena");
ok(run("CREATE OR REPLACE VIEW public.vista_generador_oc AS select 1") === "deny", "reemplazar una vista con regla se frena");
ok(run("do $$ begin execute replace(pg_get_functiondef('public.gv_cuarentena_marcar_calc'::regproc::oid),'a','b'); end $$") === "deny", "el parche por texto (execute + pg_get_functiondef) se frena");
ok(run("delete from public.\"GV_Reglas_Centinela\" where id = 5") === "deny", "tocar el centinela se frena");
ok(run("-- " + TOKEN + "\ncreate or replace function public.gv_ppp_web_super_tanda_sola() returns trigger as $$ begin return new; end $$") === "ask", "con la confirmación pide permiso en pantalla");
ok(run("select * from public.gv_ppp_web_super_tanda_sola_x") === "libre", "una lectura no se frena");
ok(run("select pg_get_functiondef('public.gv_cuarentena_marcar_calc'::regproc)") === "libre", "leer la definición viva no se frena");
ok(run("create or replace view public.vista_saldos_stock as select 1") === "libre", "un objeto sin regla no se frena");
ok(run("create or replace function public.gv_ppp_web_camion_x() returns int as $$ select 1 $$") === "libre", "un nombre que sólo empieza igual no se frena");
const otro = main(JSON.stringify({ tool_input: { project_id: "kwkclwhmoygunqmlegrg", query: "drop trigger gv_ppp_web_super_tanda_sola on x" } }));
ok(otro === "", "SQL contra otro proyecto (LK) no se frena");
process.exit(bad ? 1 : 0);
