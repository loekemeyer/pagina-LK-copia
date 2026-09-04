# gv-telegram-webhook

Fase 2 del módulo Gerente de ventas: los botones **Sirvió / No sirvió** del
Telegram de gerencia. Mandarlos ya andaba (`reply_markup`); lo que faltaba era
**recibir el click**, que necesita un endpoint público — de ahí esta función.

## Por qué existe

`gv_senales` aprende de un solo eje: `utilidad`. Hasta ahora solo se podía
cargar desde el panel admin, así que en la práctica el peso de casi todas las
señales seguía en el 0,50 inicial y la priorización no mejoraba nunca.

## Pasos para dejarlo andando

1. **Elegir un secret** para el webhook (cualquier string largo al azar) y
   guardarlo en el Vault de LK como `telegram_webhook_secret`.

2. **Deployar la función** desde el Dashboard de Supabase LK con
   **`verify_jwt = OFF`**. Telegram no manda un JWT de Supabase: si queda
   prendido, rechaza todo antes de entrar.

3. **Cargar los secrets** de la función (Settings → Edge Functions → Secrets):
   - `TELEGRAM_BOT_TOKEN` — el mismo del Vault (`telegram_bot_token`)
   - `TELEGRAM_WEBHOOK_SECRET` — el del paso 1
   - `TELEGRAM_CHAT_ID` — `6282395816` (opcional, es el default)

   `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` los inyecta Supabase solo.

4. **Registrar el webhook en Telegram** (una vez):

   ```
   curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
     -H "Content-Type: application/json" \
     -d '{
       "url": "https://kwkclwhmoygunqmlegrg.supabase.co/functions/v1/gv-telegram-webhook",
       "secret_token": "<EL SECRET DEL PASO 1>",
       "allowed_updates": ["callback_query"]
     }'
   ```

   Para chequear que quedó: `curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"`.

5. **Probar**: `select gv_enviar_agenda_telegram();` manda las sugerencias del
   día con botones. Tocar uno y verificar que se mueve el peso:

   ```sql
   select tipo, util_si, util_no, gv_peso(util_si+util_no, util_si) peso
   from gv_senales order by tipo;
   ```

## Seguridad

- El gate **no es el JWT**: es el `secret_token` que Telegram devuelve en el
  header `X-Telegram-Bot-Api-Secret-Token`. La URL de una Edge Function es
  pública y adivinable, así que sin ese chequeo cualquiera podría inyectar
  feedback falso y torcer el aprendizaje del agente.
- Un request que no pasa el gate devuelve **200, no 401**: a Telegram un error
  le hace reintentar la misma update en loop.
- Además se verifica el `chat_id`: aunque alguien agregue el bot a otro grupo,
  sus botones no mueven nada.
- `gv_telegram_callback` tiene `EXECUTE` revocado a `public`/`anon`/
  `authenticated` y concedido solo a `service_role`.

## Nota sobre el guard de las RPC

`gv_marcar_utilidad` y `gv_marcar_resultado` pasaron de `gv_es_admin()` a
`gv_es_admin_o_cron()`: el webhook entra con `service_role` y sin JWT, así que
`auth.uid()` es NULL y el guard estricto lo mataría. No abre nada — `anon` ya
tenía el `EXECUTE` revocado, y un `authenticated` que no sea admin sigue
rechazado por `gv_es_admin()`.
