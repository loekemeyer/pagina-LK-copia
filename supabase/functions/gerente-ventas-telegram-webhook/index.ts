// Supabase Edge Function: gerente-ventas-telegram-webhook
// -----------------------------------------------------------------------------
// Recibe los updates de Telegram (callback_query de los botones "Sirvió / No
// sirvió") y mueve el peso de la señal vía gv_marcar_utilidad. Cierra el ciclo
// de aprendizaje del agente sin entrar al panel.
//
// Debe deployarse con verify_jwt = OFF (lo llama Telegram, sin sesión).
// Seguridad: Telegram manda el header X-Telegram-Bot-Api-Secret-Token con el
// secreto que se fijó en setWebhook; se compara contra gv_telegram_config.webhook_secret.
//
// callback_data: "u:<id>:util" | "u:<id>:no_util"
// -----------------------------------------------------------------------------

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const TG = `https://api.telegram.org/bot${BOT_TOKEN}`;

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("ok");

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: cfgRows } = await admin.from("gv_telegram_config").select("clave, valor");
  const cfg: Record<string, string> = {};
  (cfgRows ?? []).forEach((r: { clave: string; valor: string | null }) => {
    if (r.valor != null) cfg[r.clave] = r.valor;
  });

  // Telegram reenvía el secreto de setWebhook en este header.
  const secret = req.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
  if (!cfg.webhook_secret || secret !== cfg.webhook_secret) {
    return new Response("forbidden", { status: 403 });
  }

  const update = await req.json().catch(() => ({}));
  const cq = update?.callback_query;
  if (!cq) return new Response("ok"); // ignorar todo lo que no sea botón

  const m = String(cq.data ?? "").match(/^u:(\d+):(util|no_util)$/);
  let texto = "No entendí ese botón.";
  if (m) {
    const id = Number(m[1]);
    const utilidad = m[2]; // 'util' | 'no_util'
    const { error } = await admin.rpc("gv_marcar_utilidad", { p_id: id, p_utilidad: utilidad });
    texto = error ? "Error al guardar." : (utilidad === "util" ? "Anotado: sirvió ✅" : "Anotado: no sirvió ❌");

    // Sacar los botones del mensaje para que no se pueda votar dos veces.
    if (!error && cq.message) {
      await fetch(`${TG}/editMessageReplyMarkup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          reply_markup: { inline_keyboard: [[{ text: texto, callback_data: "noop" }]] },
        }),
      });
    }
  }

  // Confirmación efímera arriba del chat.
  await fetch(`${TG}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: cq.id, text: texto }),
  });

  return new Response("ok");
});
