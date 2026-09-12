// Edge Function: notify-tracking-status
// Lee bot_pending_notifications no enviadas, mandá WhatsApp y marcá enviado.
// La llama el cron `notify-tracking-every-minute` (jobid 5) cada minuto.
//
// ⚠ SEGURIDAD (2026-09-12, problema 21): antes esta función ignoraba el request
// por completo (`_req`) y corría con service_role sin ningún chequeo, así que
// cualquiera con la URL podía vaciar la cola de notificaciones cuando quisiera
// —clientes recibiendo WhatsApps a las 3 de la mañana— y quemar cupo de Meta.
// Ahora exige el header `x-lk-secret` con el valor del secreto LK_FN_CRON_SECRET.
// El secreto sale primero de la env var y, si no está, del Vault de Postgres vía
// la RPC `krikos_secret` (que sólo puede ejecutar service_role). Es el mismo
// patrón que ya usaba krikos-ingest.
// Falla CERRADA: si el secreto no está configurado devuelve 503, no pasa de largo.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WA_TOKEN = Deno.env.get("WHATSAPP_ACCESS_TOKEN")!;
const WA_PHONE_ID = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID")!;

// Templates Meta (opcional fallback fuera de ventana 24h)
const TPL_PROGRAMADO = Deno.env.get("TEMPLATE_PROGRAMADO") ?? "";
const TPL_ENTREGADO = Deno.env.get("TEMPLATE_ENTREGADO") ?? "";
const TPL_FECHA_CAMBIO = Deno.env.get("TEMPLATE_FECHA_CAMBIO") ?? "";
const TPL_LANG = Deno.env.get("TEMPLATE_LANG") ?? "es_AR";

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

const GRAPH = `https://graph.facebook.com/v21.0/${WA_PHONE_ID}/messages`;

// ---------- guard ----------
const SECRET_NAME = "LK_FN_CRON_SECRET";
let _secretCache: string | null = null;
async function expectedSecret(): Promise<string> {
  const env = Deno.env.get(SECRET_NAME);
  if (env) return env;
  if (_secretCache !== null) return _secretCache;
  try {
    const { data, error } = await supabase.rpc("krikos_secret", { p_name: SECRET_NAME });
    if (error) console.warn("krikos_secret", SECRET_NAME, error.message);
    _secretCache = typeof data === "string" ? data : "";
  } catch (e) {
    console.warn("krikos_secret", SECRET_NAME, e);
    _secretCache = "";
  }
  return _secretCache;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Formato fecha DD/MM
function fmtFecha(d: string | null): string {
  if (!d) return "(sin fecha)";
  // d viene tipo "2026-05-15"
  const [, m, day] = d.split("-");
  return `${day}/${m}`;
}

function firstName(business: string | null): string {
  if (!business) return "";
  // "El Trentino S.A" → "El Trentino"
  return business.replace(/\s+(S\.?A\.?|S\.?R\.?L\.?|SRL|SA|CIF|CIA|S\.?C\.?|SH).*$/i, "").trim();
}

function buildMessage(tipo: string, nombre: string, fechaNueva: string | null, fechaAnterior: string | null): string {
  const nombreLine = nombre ? `Hola ${nombre},\n` : "Hola,\n";
  if (tipo === "programado") {
    return [
      "📦 *Pedido programado*",
      "",
      `${nombreLine}su pedido fue programado para entrega el *${fmtFecha(fechaNueva)}*.`,
      "",
      "Si necesita coordinar, escríbanos.",
      "",
      'Escriba "Menú" para más opciones.',
    ].join("\n");
  }
  if (tipo === "entregado") {
    return [
      "✅ *Pedido entregado*",
      "",
      `${nombreLine}le confirmamos la entrega de su pedido el *${fmtFecha(fechaNueva)}*.`,
      "",
      "Gracias por confiar en Loekemeyer Hnos.",
      "",
      'Escriba "Menú" para más opciones.',
    ].join("\n");
  }
  if (tipo === "fecha_cambio") {
    return [
      "📅 *Cambio de fecha*",
      "",
      `${nombreLine}la fecha de entrega de su pedido se modificó.`,
      "",
      `Nueva fecha: *${fmtFecha(fechaNueva)}*`,
      `(Anterior: ${fmtFecha(fechaAnterior)})`,
      "",
      "Si necesita coordinar, escríbanos.",
      "",
      'Escriba "Menú" para más opciones.',
    ].join("\n");
  }
  return "Hubo una actualización en su pedido.";
}

async function waSendText(to: string, body: string): Promise<{ ok: boolean; status: number; error?: string }> {
  const res = await fetch(GRAPH, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WA_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { preview_url: false, body },
    }),
  });
  const txt = await res.text();
  return { ok: res.ok, status: res.status, error: res.ok ? undefined : txt };
}

async function waSendTemplate(
  to: string,
  templateName: string,
  variables: string[],
): Promise<{ ok: boolean; status: number; error?: string }> {
  if (!templateName) {
    return { ok: false, status: 0, error: "template not configured" };
  }
  const components = variables.length > 0
    ? [{
      type: "body",
      parameters: variables.map((v) => ({ type: "text", text: v })),
    }]
    : [];
  const res = await fetch(GRAPH, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WA_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: templateName,
        language: { code: TPL_LANG },
        components,
      },
    }),
  });
  const txt = await res.text();
  return { ok: res.ok, status: res.status, error: res.ok ? undefined : txt };
}

function isOutOfWindowError(errText: string): boolean {
  // Codigos comunes de Meta para "fuera de ventana 24h" o "no opt-in"
  return errText.includes('"code":131047') ||
         errText.includes('"code":131026') ||
         errText.includes("Re-engagement message");
}

function templateFor(tipo: string): string {
  if (tipo === "programado") return TPL_PROGRAMADO;
  if (tipo === "entregado") return TPL_ENTREGADO;
  if (tipo === "fecha_cambio") return TPL_FECHA_CAMBIO;
  return "";
}

Deno.serve(async (req) => {
  // 0. Guard: sólo el cron (o quien tenga el secreto). Falla CERRADA.
  const secret = await expectedSecret();
  if (!secret) {
    return json({ ok: false, error: `${SECRET_NAME} no configurado (ni env ni Vault)` }, 503);
  }
  if ((req.headers.get("x-lk-secret") ?? "") !== secret) {
    return json({ ok: false, error: "forbidden" }, 403);
  }

  // 1. Levantar pendientes (max 50 por corrida)
  const { data: pendings, error: pErr } = await supabase
    .from("bot_pending_notifications")
    .select("*")
    .is("enviado_at", null)
    .is("error_at", null)
    .order("created_at", { ascending: true })
    .limit(50);

  if (pErr) {
    return json({ ok: false, error: pErr.message }, 500);
  }
  if (!pendings || pendings.length === 0) {
    return json({ ok: true, processed: 0 });
  }

  let sent = 0, skipped = 0, failed = 0;

  for (const n of pendings) {
    // Lookup cliente
    const { data: cust } = await supabase
      .from("customers")
      .select("whatsapp, business_name")
      .eq("cod_cliente", n.cod_cliente)
      .maybeSingle();

    if (!cust || !cust.whatsapp) {
      // Sin WhatsApp → marcar como skip (no reintenta)
      await supabase.from("bot_pending_notifications").update({
        error_at: new Date().toISOString(),
        error_msg: "sin whatsapp asociado al cliente",
      }).eq("id", n.id);
      skipped++;
      continue;
    }

    const nombre = firstName(cust.business_name);
    const msg = buildMessage(n.tipo, nombre, n.fecha_nueva, n.fecha_anterior);
    let result = await waSendText(cust.whatsapp, msg);

    // Si fallo por ventana 24h y hay template, intentamos
    if (!result.ok && result.error && isOutOfWindowError(result.error)) {
      const tpl = templateFor(n.tipo);
      if (tpl) {
        const vars: string[] = [];
        if (nombre) vars.push(nombre);
        if (n.fecha_nueva) vars.push(fmtFecha(n.fecha_nueva));
        const tplResult = await waSendTemplate(cust.whatsapp, tpl, vars);
        if (tplResult.ok) {
          result = { ok: true, status: 200 };
        } else {
          result.error = `text-fail then template-fail: ${tplResult.error}`;
        }
      }
    }

    if (result.ok) {
      await supabase.from("bot_pending_notifications").update({
        enviado_at: new Date().toISOString(),
      }).eq("id", n.id);
      sent++;
    } else {
      await supabase.from("bot_pending_notifications").update({
        error_at: new Date().toISOString(),
        error_msg: (result.error || "unknown").substring(0, 500),
      }).eq("id", n.id);
      failed++;
    }
  }

  return json({ ok: true, processed: pendings.length, sent, skipped, failed });
});
