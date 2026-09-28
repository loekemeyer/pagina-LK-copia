// ficha-chef — puerta de la Ficha de Cliente del panel de CHEF (Luis, 28/09/2026).
//
// El panel de Chef (chefsrl.com, repo paginach) lee los datos del cliente de SU
// base. La facturacion de ISIS y la deuda del ERP no estan ahi: las tiene LK por
// FDW a Gestion Virgilio. Esta funcion:
//   1. valida el token de la sesion de CHEF contra el auth de Chef,
//   2. confirma que ese usuario esta en `admins` de Chef (con SU token: la RLS de
//      Chef decide, no esta funcion),
//   3. recien ahi llama a get_ficha_isis_chef con la service key de LK.
// verify_jwt = false porque el token es de OTRO proyecto: LK no lo puede validar.
// La validacion real es el paso 1 + 2.

const CHEF_URL = "https://nkhzocgdpwtgrmwleihr.supabase.co";
// clave PUBLICA de Chef (la misma que esta en paginach/admin.js)
const CHEF_KEY = "sb_publishable_aThHtJLBKytg9k_6UdH2Eg_Use7f1zH";

const ORIGENES = [
  "https://www.chefsrl.com",
  "https://chefsrl.com",
  "https://loekemeyer.github.io",
];

function cors(origin: string | null) {
  const ok = origin && ORIGENES.includes(origin) ? origin : ORIGENES[0];
  return {
    "Access-Control-Allow-Origin": ok,
    "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(body: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(origin), "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(origin) });
  if (req.method !== "POST") return json({ error: "metodo no permitido" }, 405, origin);

  const auth = req.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token) return json({ error: "sin sesion" }, 401, origin);

  // 1) el token es de un usuario de Chef
  const u = await fetch(CHEF_URL + "/auth/v1/user", {
    headers: { apikey: CHEF_KEY, Authorization: "Bearer " + token },
  });
  if (!u.ok) return json({ error: "sesion de Chef invalida" }, 401, origin);
  const user = await u.json();
  const uid = user && user.id;
  if (!uid) return json({ error: "sesion de Chef invalida" }, 401, origin);

  // 2) y es admin de Chef
  const a = await fetch(
    CHEF_URL + "/rest/v1/admins?select=auth_user_id&auth_user_id=eq." + encodeURIComponent(uid),
    { headers: { apikey: CHEF_KEY, Authorization: "Bearer " + token } },
  );
  const filas = a.ok ? await a.json() : [];
  if (!Array.isArray(filas) || !filas.length) return json({ error: "no autorizado" }, 403, origin);

  // 3) la ficha, con la service key de LK
  let body: { cod?: string } = {};
  try { body = await req.json(); } catch (_) { /* vacio */ }
  const cod = String(body.cod || "").replace(/[^0-9]/g, "");
  if (!cod) return json({ error: "falta el codigo de cliente" }, 400, origin);

  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const r = await fetch(url + "/rest/v1/rpc/get_ficha_isis_chef", {
    method: "POST",
    headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({ p_cod: cod }),
  });
  const txt = await r.text();
  if (!r.ok) return json({ error: "no se pudo leer ISIS", detalle: txt.slice(0, 300) }, 502, origin);
  return new Response(txt, { status: 200, headers: { ...cors(origin), "Content-Type": "application/json" } });
});
