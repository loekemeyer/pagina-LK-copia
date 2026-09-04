// ============================================================================
// gv-telegram-webhook  ·  proyecto Supabase LK (kwkclwhmoygunqmlegrg)
// ============================================================================
// Recibe los clicks de los botones inline del bot de gerencia (@Lk_gerencia_bot)
// y los manda a la RPC `gv_telegram_callback`. Es la fase 2 del modulo Gerente
// de ventas: sin esto el feedback solo se puede cargar desde el panel, o sea
// que el peso de las senales casi nunca se mueve y la automejora no arranca.
//
// DEPLOY: verify_jwt = OFF. Telegram no manda un JWT de Supabase, asi que si
// queda prendido la funcion rechaza todo antes de entrar. El gate NO es el JWT:
// es el secret token de abajo.
//
// AUTENTICACION: al registrar el webhook se le pasa a Telegram un
// `secret_token`; Telegram lo devuelve en cada request en el header
// X-Telegram-Bot-Api-Secret-Token. Comparar contra el del Vault es lo unico que
// impide que cualquiera que descubra la URL inyecte feedback falso. La URL de
// una Edge Function es publica y adivinable, asi que sin este chequeo la
// funcion queda abierta.
//
// TAMBIEN se verifica que el click venga del chat de gerencia: aunque alguien
// agregue el bot a otro grupo, sus botones no mueven nada.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL      = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BOT_TOKEN         = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const WEBHOOK_SECRET    = Deno.env.get("TELEGRAM_WEBHOOK_SECRET")!;
const CHAT_GERENCIA     = Deno.env.get("TELEGRAM_CHAT_ID") ?? "6282395816";

const tg = (metodo: string, body: unknown) =>
  fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${metodo}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

Deno.serve(async (req) => {
  // 200 y no 401 a proposito: a Telegram un error le hace reintentar la misma
  // update en loop. Un request que no pasa el gate se descarta en silencio.
  if (req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== WEBHOOK_SECRET) {
    return new Response("ok", { status: 200 });
  }

  let update: any;
  try {
    update = await req.json();
  } catch {
    return new Response("ok", { status: 200 });
  }

  const cb = update?.callback_query;
  if (!cb) return new Response("ok", { status: 200 });

  const chatId = String(cb.message?.chat?.id ?? "");
  if (chatId !== CHAT_GERENCIA) {
    await tg("answerCallbackQuery", {
      callback_query_id: cb.id,
      text: "Este bot solo responde en el chat de gerencia.",
    });
    return new Response("ok", { status: 200 });
  }

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // Todo el parseo y la logica viven en la RPC, no aca: asi el criterio esta
  // definido una sola vez y se puede cambiar sin re-deployar la funcion.
  const { data, error } = await sb.rpc("gv_telegram_callback", {
    p_data: String(cb.data ?? ""),
  });

  const respuesta = error ? "No se pudo registrar" : String(data ?? "Anotado");

  await tg("answerCallbackQuery", { callback_query_id: cb.id, text: respuesta });

  // Se saca el teclado y se deja la respuesta al pie del mensaje original, para
  // que al scrollear el historial se vea que ya fue contestado y con que.
  if (!error) {
    await tg("editMessageText", {
      chat_id: chatId,
      message_id: cb.message.message_id,
      text: (cb.message.text ?? "") + "\n\n— " + respuesta,
      reply_markup: { inline_keyboard: [] },
    });
  }

  return new Response("ok", { status: 200 });
});
