// Supabase Edge Function: gerente-ventas-telegram
// -----------------------------------------------------------------------------
// Envía por Telegram las acciones del día del agente Gerente de ventas.
// Ruteo: las de vendedores marcados como "gerencia" van al chat de gerencia;
// el resto va al grupo "faltantes Virgilio". Cada acción lleva botones inline
// "Sirvió / No sirvió" que pegan al webhook (gerente-ventas-telegram-webhook)
// y mueven el peso de la señal vía gv_marcar_utilidad.
//
// SECRETOS (Supabase → Project Settings → Edge Functions → Secrets):
//   TELEGRAM_BOT_TOKEN  — token del bot. NUNCA en el repo (es público).
// CONFIG (tabla public.gv_telegram_config, editable por admin):
//   chat_gerencia        — chat id del destino de gerencia
//   chat_faltantes       — chat id del grupo "faltantes Virgilio"
//   gerencia_vendedores  — lista separada por comas de vendor_label que van a gerencia
//   webhook_secret       — secreto compartido; el disparador (cron) lo manda en x-gv-secret
//
// Disparo: cron pg_cron → net.http_post con header x-gv-secret = webhook_secret.
// -----------------------------------------------------------------------------

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const TG = `https://api.telegram.org/bot${BOT_TOKEN}`;

function esc(s: string): string {
  // HTML parse_mode: escapar los 3 caracteres reservados.
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function tgSend(chatId: string, text: string, id: number): Promise<void> {
  await fetch(`${TG}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ Sirvió", callback_data: `u:${id}:util` },
          { text: "❌ No sirvió", callback_data: `u:${id}:no_util` },
        ]],
      },
    }),
  });
}

Deno.serve(async (req: Request) => {
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Config
  const { data: cfgRows } = await admin.from("gv_telegram_config").select("clave, valor");
  const cfg: Record<string, string> = {};
  (cfgRows ?? []).forEach((r: { clave: string; valor: string | null }) => {
    if (r.valor != null) cfg[r.clave] = r.valor;
  });

  // Guard: el disparador tiene que traer el secreto compartido.
  const secret = req.headers.get("x-gv-secret") ?? "";
  if (!cfg.webhook_secret || secret !== cfg.webhook_secret) {
    return new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
  }
  if (!BOT_TOKEN) {
    return new Response(JSON.stringify({ error: "falta TELEGRAM_BOT_TOKEN" }), { status: 500 });
  }
  if (!cfg.chat_gerencia && !cfg.chat_faltantes) {
    return new Response(JSON.stringify({ error: "faltan chat ids en gv_telegram_config" }), { status: 500 });
  }

  const gerenciaSet = new Set(
    (cfg.gerencia_vendedores ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  );

  const { data: acciones, error } = await admin.rpc("gv_agenda_telegram");
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });

  let enviadas = 0;
  for (const a of acciones ?? []) {
    const esGerencia = a.vendedor && gerenciaSet.has(String(a.vendedor).toLowerCase());
    const chat = esGerencia ? cfg.chat_gerencia : cfg.chat_faltantes;
    if (!chat) continue; // sin chat configurado para ese lado
    const linea =
      `👤 <b>${esc(a.vendedor ?? "sin asignar")}</b>` +
      (a.tipo ? ` · <i>${esc(a.tipo)}</i>` : "") + "\n" +
      `<b>${esc(a.titulo ?? "")}</b>\n` +
      (a.cod_cliente ? `#${esc(a.cod_cliente)} ` : "") + esc(a.motivo ?? "") + "\n" +
      (a.accion ? `➡️ ${esc(a.accion)}` : "");
    await tgSend(chat, linea, a.id);
    enviadas++;
  }

  return new Response(JSON.stringify({ ok: true, enviadas }), {
    headers: { "Content-Type": "application/json" },
  });
});
