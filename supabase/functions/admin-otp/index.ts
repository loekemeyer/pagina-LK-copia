// Supabase Edge Function: admin-otp
// 2FA por email para el admin PPP (CUIT 30-51584245-0).
// Acciones: { action: "send" } | { action: "verify", code: "123456" }
// Secrets se guardan en Supabase Vault y se leen via RPC get_admin_otp_secret.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const PPP_ADMIN_CUIT = "30515842450";
const RECIPIENT_EMAIL = "loekemeyer.n8n@gmail.com";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

async function sha256Hex(text: string): Promise<string> {
  const buf = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function generate6DigitCode(): string {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return String(arr[0] % 1_000_000).padStart(6, "0");
}

function buildEmailHtml(code: string): string {
  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f5f5f5;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#222">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:14px;padding:32px;border:1px solid #e6e6e6">
    <div style="text-align:center;margin-bottom:20px">
      <div style="display:inline-block;background:#212122;color:#fff;width:48px;height:48px;border-radius:12px;line-height:48px;font-weight:800;letter-spacing:1px">LK</div>
    </div>
    <h2 style="margin:0 0 8px;font-size:20px;text-align:center">Código de acceso al panel admin</h2>
    <p style="color:#666;margin:0 0 24px;font-size:13.5px;text-align:center">Loekemeyer Hnos S.R.L. — Panel Administrador</p>
    <div style="background:#f5f5f5;border-radius:12px;padding:22px;text-align:center;margin:0 0 18px">
      <div style="font-size:34px;font-weight:700;letter-spacing:10px;font-family:ui-monospace,Menlo,Consolas,monospace;color:#212122">${code}</div>
    </div>
    <p style="color:#666;font-size:13px;margin:0;text-align:center">Válido por 10 minutos. Si no fuiste vos, ignorá este mail.</p>
  </div>
</body></html>`;
}

async function getSecret(
  sb: ReturnType<typeof createClient>,
  name: string,
  fallbackEnv?: string,
): Promise<string> {
  const { data, error } = await sb.rpc("get_admin_otp_secret", {
    secret_name: name,
  });
  if (!error && typeof data === "string" && data.length > 0) return data;
  if (fallbackEnv) {
    const v = Deno.env.get(fallbackEnv);
    if (v) return v;
  }
  return "";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) {
      return jsonResponse({ error: "missing_auth" }, 401);
    }
    const jwt = authHeader.slice(7);

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return jsonResponse({ error: "server_misconfigured" }, 500);
    }

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const userRes = await admin.auth.getUser(jwt);
    if (userRes.error || !userRes.data?.user) {
      return jsonResponse({ error: "invalid_auth" }, 401);
    }
    const user = userRes.data.user;
    const email = (user.email ?? "").toLowerCase();
    const cuit = email.split("@")[0];
    if (cuit !== PPP_ADMIN_CUIT) {
      return jsonResponse({ error: "not_ppp_admin" }, 403);
    }

    const adminRow = await admin
      .from("admins")
      .select("auth_user_id")
      .eq("auth_user_id", user.id)
      .maybeSingle();
    if (adminRow.error || !adminRow.data) {
      return jsonResponse({ error: "not_admin" }, 403);
    }

    let body: { action?: string; code?: string } = {};
    try {
      body = await req.json();
    } catch (_) {
      return jsonResponse({ error: "invalid_body" }, 400);
    }
    const action = body.action;

    if (action === "send") {
      const resendKey = await getSecret(admin, "RESEND_API_KEY", "RESEND_API_KEY");
      const resendFrom = (await getSecret(admin, "RESEND_FROM", "RESEND_FROM")) ||
        "onboarding@resend.dev";
      if (!resendKey) {
        return jsonResponse({ error: "mail_not_configured" }, 500);
      }

      const sinceIso = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const countRes = await admin
        .from("admin_otp_codes")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id)
        .gte("created_at", sinceIso);
      if ((countRes.count ?? 0) >= 5) {
        return jsonResponse({ error: "rate_limited" }, 429);
      }

      const code = generate6DigitCode();
      const codeHash = await sha256Hex(code);
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

      const insertRes = await admin.from("admin_otp_codes").insert({
        user_id: user.id,
        code_hash: codeHash,
        expires_at: expiresAt,
        used: false,
      });
      if (insertRes.error) {
        return jsonResponse(
          { error: "db_error", detail: insertRes.error.message },
          500,
        );
      }

      const mailRes = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${resendKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: resendFrom,
          to: [RECIPIENT_EMAIL],
          subject: "Código de acceso - Admin Loekemeyer",
          html: buildEmailHtml(code),
        }),
      });
      if (!mailRes.ok) {
        const txt = await mailRes.text();
        console.error("Resend error:", mailRes.status, txt);
        return jsonResponse({ error: "mail_failed", detail: txt }, 500);
      }

      return jsonResponse({ ok: true });
    }

    if (action === "verify") {
      const inputCode = String(body.code ?? "").replace(/\s+/g, "");
      if (!/^\d{6}$/.test(inputCode)) {
        return jsonResponse({ error: "invalid_format" }, 400);
      }
      const codeHash = await sha256Hex(inputCode);
      const nowIso = new Date().toISOString();

      const found = await admin
        .from("admin_otp_codes")
        .select("id")
        .eq("user_id", user.id)
        .eq("code_hash", codeHash)
        .eq("used", false)
        .gte("expires_at", nowIso)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (found.error || !found.data) {
        return jsonResponse({ error: "invalid_code" }, 401);
      }

      const upd = await admin
        .from("admin_otp_codes")
        .update({ used: true })
        .eq("id", found.data.id);
      if (upd.error) {
        return jsonResponse(
          { error: "db_error", detail: upd.error.message },
          500,
        );
      }

      return jsonResponse({ ok: true });
    }

    return jsonResponse({ error: "unknown_action" }, 400);
  } catch (e) {
    console.error("admin-otp exception:", e);
    return jsonResponse({ error: "exception", detail: String(e) }, 500);
  }
});
