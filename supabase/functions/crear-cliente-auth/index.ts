// Supabase Edge Function: crear-cliente-auth
// -----------------------------------------------------------------------------
// Crea el usuario de Supabase Auth de un cliente, usando la service_role key ->
// auth.admin.createUser. Lo llaman createAuthUser (admin.js) y _expoCreateAuthUser (script.js).
//
// AUTORIZACIÓN: el que llama tiene que ser ADMIN o VENDEDOR (user_customer_links).
//
// Entrada:  { cuit, pin, sincronizar? }
// Salida:   { id, created: true } | 409 { error: "cuit_ya_registrado" } | { error }
// 24/09: un CUIT que ya tiene login NO se le resetea el PIN (antes sí). Sólo un ADMIN con
// sincronizar:true («Reparar Auth») puede alinear el PIN con el de la ficha.
//
// 02/10 (Tomás Gonzalez, problema 679): Auth tiene la protección de contraseñas filtradas
// (HIBP) y rechaza casi todo PIN de 6 dígitos con 422 "Password is known to be weak". Ese
// error ahora vuelve como { error: "pin_debil" } (422) para que el front FRENE el alta y lo
// diga, y la sincronización de «Reparar Auth» ya no contesta "sincronizado" sin haber
// cambiado nada: antes no miraba el error de updateUserById.
// -----------------------------------------------------------------------------

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const EMAIL_DOMAIN = "cuit.loekemeyer";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// Auth rechazó el PIN por débil / filtrado (HIBP). Se mira el código y, por las dudas,
// el texto: el código lo trae gotrue nuevo, el texto lo traen todos.
function esPinDebil(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  if (err.code === "weak_password") return true;
  return /weak|easy to guess|pwned|leaked/i.test(err.message ?? "");
}

async function findUserIdByEmail(admin: ReturnType<typeof createClient>, email: string): Promise<string | null> {
  const target = email.toLowerCase();
  const perPage = 1000;
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error || !data) return null;
    const hit = data.users.find((u) => (u.email ?? "").toLowerCase() === target);
    if (hit) return hit.id;
    if (data.users.length < perPage) return null;
  }
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return json({ error: "no_auth" }, 401);

  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: who, error: whoErr } = await userClient.auth.getUser();
  if (whoErr || !who?.user) return json({ error: "invalid_token" }, 401);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: adminRow } = await admin.from("admins").select("auth_user_id").eq("auth_user_id", who.user.id).maybeSingle();
  let allowed = !!adminRow;
  if (!allowed) {
    const { count } = await admin.from("user_customer_links").select("auth_user_id", { count: "exact", head: true }).eq("auth_user_id", who.user.id);
    allowed = (count ?? 0) > 0;
  }
  if (!allowed) return json({ error: "no_autorizado" }, 403);

  const body = await req.json().catch(() => ({}));
  const digits = String(body?.cuit ?? "").replace(/[^0-9]/g, "");
  const pin = String(body?.pin ?? "");
  if (!digits) return json({ error: "cuit_requerido" }, 400);
  if (pin.length < 6) return json({ error: "pin_invalido" }, 400);
  const email = `${digits}@${EMAIL_DOMAIN}`;

  const { data: created, error: cErr } = await admin.auth.admin.createUser({ email, password: pin, email_confirm: true });
  if (!cErr && created?.user) return json({ id: created.user.id, created: true });

  if (esPinDebil(cErr)) return json({ error: "pin_debil", detalle: cErr?.message ?? "" }, 422);

  const msg = (cErr?.message ?? "").toLowerCase();
  const yaExiste = msg.includes("already") || msg.includes("registered") || msg.includes("exists") || msg.includes("duplicate");
  if (yaExiste) {
    if (body?.sincronizar === true && !!adminRow) {
      const id = await findUserIdByEmail(admin, email);
      if (id) {
        const { error: uErr } = await admin.auth.admin.updateUserById(id, { password: pin, email_confirm: true });
        if (uErr) {
          return json({ error: esPinDebil(uErr) ? "pin_debil" : (uErr.message || "sincronizar_fallo"), detalle: uErr.message ?? "" }, 422);
        }
        return json({ id, created: false, sincronizado: true });
      }
    }
    return json({ error: "cuit_ya_registrado" }, 409);
  }
  return json({ error: cErr?.message ?? "create_failed" }, 400);
});
