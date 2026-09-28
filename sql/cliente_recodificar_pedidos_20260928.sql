-- 2026-09-28 (Luis) — cuando cambia el NÚMERO de un cliente, sus pedidos se recodifican solos.
-- Casos: Capo (pedidos 1548/1549 cargados con 4318; la ficha pasó a 4286 sin tocar los pedidos) y
-- Chaverim (pedido 1452 con 4317; la ficha se BORRÓ y se recreó como 4285 → orders.customer_id quedó
-- NULL por el ON DELETE SET NULL y el pedido quedó huérfano con el código viejo).
-- El código del pedido lo copiaba UNA sola vez trg_fill_order_customer_code (BEFORE INSERT).
--   1) UPDATE de cod_cliente: los pedidos de ese cliente (últimos 120 días) toman el código nuevo.
--   2) INSERT / UPDATE de la ficha: los pedidos HUÉRFANOS (customer_id null) del mismo usuario —mismo
--      auth_user_id o usuario de login por CUIT (<cuit>@cuit.loekemeyer)— se vuelven a vincular.
-- Los 120 días son para no mover pedidos viejos ya facturados en ISIS con otro código.
-- Gestión recibe el código nuevo por sync_pedidos_match_virgilio (cada 15 min) y
-- gv_pedido_recodificado lo lleva a la programación.
create or replace function public.gv_cliente_recodificar_pedidos()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_cod text := new.cod_cliente::text; v_cuit text;
begin
  if v_cod is null then return new; end if;
  -- Tocar sheets_payload dispara trg_marcar_pedido_diferido, que re-evaluaría el stock de HOY sobre
  -- un pedido viejo (y podría diferir uno ya programado). Esta marca, local a la transacción, lo apaga.
  perform set_config('lk.recodificando', '1', true);

  if tg_op = 'UPDATE' and new.cod_cliente is distinct from old.cod_cliente then
    update public.orders o
       set customer_code  = v_cod,
           sheets_payload = case when o.sheets_payload ? 'cod_cliente'
                                 then jsonb_set(o.sheets_payload, '{cod_cliente}', to_jsonb(v_cod))
                                 else o.sheets_payload end
     where o.customer_id = new.id
       and o.customer_code is distinct from v_cod
       and o.created_at >= now() - interval '120 days';
  end if;

  v_cuit := nullif(regexp_replace(coalesce(new.cuit, ''), '\D', '', 'g'), '');
  update public.orders o
     set customer_id    = new.id,
         customer_code  = v_cod,
         sheets_payload = case when o.sheets_payload ? 'cod_cliente'
                               then jsonb_set(o.sheets_payload, '{cod_cliente}', to_jsonb(v_cod))
                               else o.sheets_payload end
   where o.customer_id is null
     and o.created_at >= now() - interval '120 days'
     and ( (new.auth_user_id is not null and o.auth_user_id = new.auth_user_id)
        or (v_cuit is not null and length(v_cuit) = 11 and o.auth_user_id in (
              select u.id from auth.users u where lower(u.email) = v_cuit || '@cuit.loekemeyer')) );
  perform set_config('lk.recodificando', '', true);
  return new;
end $$;

-- El freno del lado del diferido (sobre la definición viva de trg_marcar_pedido_diferido):
create or replace function public.trg_marcar_pedido_diferido()
 returns trigger language plpgsql security definer set search_path to 'public' as $function$
begin
  -- 2026-09-28: un recodificado de cliente (gv_cliente_recodificar_pedidos) no re-evalúa el stock.
  if coalesce(current_setting('lk.recodificando', true), '') = '1' then return null; end if;
  if new.sheets_payload is not null
     and jsonb_typeof(new.sheets_payload -> 'items') = 'array' then
    perform public.marcar_pedido_diferido(new.id);
  end if;
  return null;
end;
$function$;

drop trigger if exists trg_cliente_recodificar_pedidos on public.customers;
create trigger trg_cliente_recodificar_pedidos
  after insert or update of cod_cliente, auth_user_id, cuit on public.customers
  for each row execute function public.gv_cliente_recodificar_pedidos();

-- Rollback:
--   drop trigger trg_cliente_recodificar_pedidos on public.customers;
--   drop function public.gv_cliente_recodificar_pedidos();
