-- =============================================================================
-- krikos-auto-import — lo que la Edge Function necesita del lado de la base.
-- =============================================================================
-- Pedido del dueño (2026-09-11): "Siempre quiero que se cargue directo a PPP y
-- si la lógica del importe NO DA, QUE LO ACLARE MUY GRANDE EN PPP".
--
-- Todo ADITIVO: 3 columnas nuevas en krikos_oc_inbox y 4 funciones nuevas con
-- prefijo krikos_auto_. No se toca nada de lo que ya usa el panel.
-- Rollback al final.
-- =============================================================================

-- 1) Resultado del intento automático, por OC. Se guarda SIEMPRE, se haya
--    podido cargar o no: es el texto que la PPP muestra en el cartel.
alter table public.krikos_oc_inbox
  add column if not exists auto_estado text,   -- ok | parcial | no | salteada
  add column if not exists auto_aviso  text,
  add column if not exists auto_at     timestamptz;

comment on column public.krikos_oc_inbox.auto_estado is
  'Intento del importador automático: ok = entró completa · parcial = entró pero algo no dio · no = no se pudo · salteada = guarda de fecha.';
comment on column public.krikos_oc_inbox.auto_aviso is
  'Qué fue lo que no dio, en castellano. Lo muestra la PPP de Gestión arriba de A Programar.';

-- 2) Config de cadenas y precios para el service_role (las RPC que usa el panel
--    exigen is_admin(), que con service_role es false).
create or replace function public.krikos_auto_cadenas()
returns table(super_key text, label text, empresa text, cod_cliente_lk text,
              cod_cliente_chef text, usa_productos_chef boolean, payment_code integer,
              pdf_ratio numeric, item_discount numeric)
language sql stable security definer set search_path to 'public', 'precios_super' as $$
  select c.super_key, c.label, c.empresa, c.cod_cliente_lk, c.cod_cliente_chef,
         c.usa_productos_chef, c.payment_code, c.pdf_ratio, c.item_discount
    from precios_super.cadena c
   where c.activo
   order by c.orden, c.super_key;
$$;

create or replace function public.krikos_auto_precios()
returns table(super_key text, cod text, price numeric)
language sql stable security definer set search_path to 'public', 'precios_super' as $$
  select p.super_key, p.cod, p.price from precios_super.precio p order by p.super_key, p.cod;
$$;

-- 3) Alta del pedido + cierre de la OC, en UNA transacción.
--    submit_order_fast no sirve acá: exige p_auth_user_id = auth.uid(), y la
--    Edge Function corre con service_role (auth.uid() = null). Esta hace lo
--    mismo que aquélla, con el usuario admin del panel como dueño del pedido.
create or replace function public.krikos_auto_crear_pedido(
  p_inbox_id       bigint,
  p_customer_id    uuid,
  p_payment_method text,
  p_subtotal       numeric,
  p_total          numeric,
  p_items          jsonb,
  p_sheets_payload jsonb,
  p_auto_estado    text,
  p_auto_aviso     text
) returns bigint
language plpgsql security definer set search_path to 'public' as $$
declare
  v_order_id bigint;
  v_admin    uuid := public.get_admin_login_user_id();
  v_ya       bigint;
begin
  if v_admin is null then raise exception 'no hay usuario admin para colgar el pedido'; end if;

  -- Candado de idempotencia: si la OC ya tiene pedido, no se crea otro. Sin
  -- esto una corrida repetida del cron duplicaría el pedido del súper.
  select order_id into v_ya from public.krikos_oc_inbox where id = p_inbox_id for update;
  if v_ya is not null then raise exception 'la OC % ya tiene el pedido %', p_inbox_id, v_ya; end if;

  insert into orders (auth_user_id, customer_id, status, payment_method,
                      payment_discount, web_discount, subtotal, total,
                      sheets_payload, is_promo, extra_discount, placed_by_auth_user_id)
  values (v_admin, p_customer_id, 'pendiente', coalesce(p_payment_method, ''),
          0, 0, p_subtotal, p_total,
          p_sheets_payload || jsonb_build_object('order_number', ''), false, 0, v_admin)
  returning id into v_order_id;

  -- Mismos dos inserts que submit_order_fast (regulares y Loke), con los
  -- precios que sacó el parser del PDF.
  insert into order_items (order_id, product_id, cajas, uxb, is_loke,
                           unit_list_price, unit_your_price, line_total)
  select v_order_id, (i->>'product_id')::uuid, (i->>'cajas')::int, (i->>'uxb')::int, false,
         coalesce((i->>'unit_list_price')::numeric, 0),
         coalesce((i->>'unit_your_price')::numeric, 0),
         coalesce((i->>'line_total')::numeric, 0)
    from jsonb_array_elements(p_items) i
   where (i->>'is_loke')::boolean is distinct from true;

  insert into order_items (order_id, loke_product_id, cajas, uxb, is_loke,
                           unit_list_price, unit_your_price, line_total)
  select v_order_id, (i->>'product_id')::uuid, (i->>'cajas')::int, (i->>'uxb')::int, true,
         coalesce((i->>'unit_list_price')::numeric, 0),
         coalesce((i->>'unit_your_price')::numeric, 0),
         coalesce((i->>'line_total')::numeric, 0)
    from jsonb_array_elements(p_items) i
   where (i->>'is_loke')::boolean = true;

  -- El order_number del payload se completa recién acá (necesita el id real).
  update orders set sheets_payload = p_sheets_payload || jsonb_build_object('order_number', v_order_id::text)
   where id = v_order_id;

  update public.krikos_oc_inbox
     set estado = 'cargado', order_id = v_order_id, resuelto_at = now(),
         auto_estado = p_auto_estado, auto_aviso = p_auto_aviso, auto_at = now()
   where id = p_inbox_id;

  return v_order_id;
end $$;

-- 4) Dejar anotado por qué una OC no se pudo cargar (sigue pendiente).
create or replace function public.krikos_auto_marcar(
  p_id bigint, p_auto_estado text, p_auto_aviso text
) returns void
language sql security definer set search_path to 'public' as $$
  update public.krikos_oc_inbox
     set auto_estado = p_auto_estado, auto_aviso = p_auto_aviso, auto_at = now()
   where id = p_id;
$$;

-- Sólo el service_role (la Edge Function). Nadie más las ejecuta.
revoke all on function public.krikos_auto_cadenas()      from public, anon, authenticated;
revoke all on function public.krikos_auto_precios()      from public, anon, authenticated;
revoke all on function public.krikos_auto_crear_pedido(bigint, uuid, text, numeric, numeric, jsonb, jsonb, text, text) from public, anon, authenticated;
revoke all on function public.krikos_auto_marcar(bigint, text, text) from public, anon, authenticated;
grant execute on function public.krikos_auto_cadenas()      to service_role;
grant execute on function public.krikos_auto_precios()      to service_role;
grant execute on function public.krikos_auto_crear_pedido(bigint, uuid, text, numeric, numeric, jsonb, jsonb, text, text) to service_role;
grant execute on function public.krikos_auto_marcar(bigint, text, text) to service_role;

-- =============================================================================
-- CRON — APLICADO el 2026-09-11 18:28 ART. Es el jobid 43.
-- =============================================================================
-- Antes de prenderlo se corrió {"dry_run": true, "force": true} contra las 6 OC
-- pendientes reales: 5 entraban limpias con el total EXACTO al del PDF, y la 6ª
-- (La Anonima 22908256) salia 'parcial' avisando que falta el 198E y que por eso
-- el total difiere 5,3%. La corrida real dejo las 6 en 'salteada' (vencidas), sin
-- crear ningun pedido.
--
-- Para apagarlo: select cron.alter_job(43, active := false);
--
-- select cron.schedule('krikos-auto-import-10min', '3-59/10 * * * *', $c$
--   select net.http_post(
--     url := 'https://kwkclwhmoygunqmlegrg.supabase.co/functions/v1/krikos-auto-import',
--     headers := jsonb_build_object('Content-Type','application/json',
--                                   'x-krikos-secret', public.krikos_secret('KRIKOS_INGEST_SECRET')),
--     body := '{}'::jsonb, timeout_milliseconds := 120000);
-- $c$);
--
-- Corre 3 minutos después del ingest (jobid 26, */10) y 2 antes del espejo a
-- Virgilio (jobid 42, 5-59/10): baja el mail → importa → se ve en la PPP.

-- =============================================================================
-- ROLLBACK
-- =============================================================================
-- select cron.unschedule('krikos-auto-import-10min');
-- drop function if exists public.krikos_auto_crear_pedido(bigint, uuid, text, numeric, numeric, jsonb, jsonb, text, text);
-- drop function if exists public.krikos_auto_marcar(bigint, text, text);
-- drop function if exists public.krikos_auto_cadenas();
-- drop function if exists public.krikos_auto_precios();
-- alter table public.krikos_oc_inbox drop column if exists auto_estado,
--   drop column if exists auto_aviso, drop column if exists auto_at;
-- (Las columnas se pueden dejar: no las lee nadie más.)
