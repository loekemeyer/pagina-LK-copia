/// <reference lib="deno.ns" />
/// <reference lib="dom" />
// sheets-proxy (proyecto LK) — v74 desplegada el 07/10/2026.
// ⚠ SHEETS_SECRET va hardcodeado como en la versión desplegada (v73 y anteriores).

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SHEETS_SECRET = "Damian.10.2026.WEB";
const SHEETS_WEBAPP_URL = "https://script.google.com/macros/s/AKfycbysTeROf-qEIPAhuCJBaXwo7NPd4zA6EAJSDyDmfneag1CetWznRCgve84bEfnbVcsA/exec";
const GOOGLE_FETCH_TIMEOUT_MS = 15000;

// v74 (Luis, 07/10/2026): la leyenda D / LC / PP (deuda, limite, plazo) la arma
// el SERVIDOR. Se toma de la ficha guardada en orders.sheets_payload, que la
// calcula el trigger aa_orders_leyenda_servidor desde customers. El navegador
// ya no baja debt / credit_limit. Fail-open: si no se puede leer, va lo que vino.
const LEYENDA = ["deuda", "credit_limit", "payment_term", "lc", "d", "pp"];
async function leyendaServidor(orderNumber: string): Promise<Record<string, unknown> | null> {
  const id = String(orderNumber || "").trim();
  if (!/^\d+$/.test(id)) return null;
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return null;
  try {
    const r = await fetch(`${url}/rest/v1/orders?id=eq.${id}&select=sheets_payload`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (!r.ok) return null;
    const rows = await r.json();
    const sp = rows?.[0]?.sheets_payload;
    if (!sp || sp.leyenda_origen !== "servidor") return null;
    const out: Record<string, unknown> = {};
    for (const k of LEYENDA) out[k] = sp[k] ?? null;
    return out;
  } catch {
    return null;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const json = (o: unknown, status = 200) =>
    new Response(JSON.stringify(o), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  try {
    const auth = req.headers.get("Authorization") || "";
    if (!auth.toLowerCase().startsWith("bearer ")) return json({ ok: false, error: "Missing bearer token" }, 401);
    const body = await req.json();
    const ley = await leyendaServidor(body?.order_number ?? body?.orderNumber);
    const payload = { ...body, ...(ley || {}), secret: SHEETS_SECRET };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GOOGLE_FETCH_TIMEOUT_MS);
    let r: Response;
    try {
      r = await fetch(SHEETS_WEBAPP_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (fetchErr: any) {
      clearTimeout(timer);
      const isTimeout = fetchErr?.name === "AbortError";
      return json({ ok: false, error: isTimeout ? "Google Apps Script timeout (15s)" : String(fetchErr?.message || fetchErr) }, 504);
    }
    clearTimeout(timer);
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      return json({ ok: false, error: `AppsScript ${r.status}: ${txt}` }, 502);
    }
    return json({ ok: true, leyenda: ley ? "servidor" : "front" });
  } catch (e) {
    return json({ ok: false, error: String((e as any)?.message || e) }, 500);
  }
});
