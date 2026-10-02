-- ============================================================================
-- REPETIR PEDIDOS — panel del vendedor (Gastón, 02/10/2026)
-- ============================================================================
-- "El listado de los pedidos de sus clientes, ÚNICAMENTE de sus clientes:
--  estate muy seguro de no errarle con eso".
--
-- Por qué hace falta una RPC y no se lee la tabla desde el navegador:
--   order_items tiene RLS "select own" (o.auth_user_id = auth.uid()): el
--   vendedor sólo ve los renglones de los pedidos que cargó ÉL. Un pedido que
--   cargó el cliente desde su usuario, o que entró por el Cotizador, no se podía
--   copiar. Estas dos funciones son SECURITY DEFINER con el control adentro.
--
-- QUIÉN ES "SU CLIENTE" — lo más estricto que hay, las DOS condiciones a la vez:
--   1. el usuario que llama es un VENDEDOR: su ficha en customers es 100XX o
--      Loekemeyer SRL (cod 1) — mismo criterio que isActualVendor() en script.js
--      y que get_mis_clientes_inactivos — y tiene código de vendedor (vend);
--   2. el cliente está VINCULADO a ese usuario (user_customer_links, que es la
--      lista del desplegable "Pedir para") Y su vend es el del vendedor.
--   Medido el 02/10/2026 sobre los 13 vendedores con login: los vínculos y el
--   código de vendedor coinciden 1 a 1 (0 vínculos a clientes de otro vendedor),
--   así que exigir las dos no le saca a nadie un cliente propio.
--   Un usuario que no es vendedor (o un vendedor sin vend) recibe CERO filas.
--
-- No escriben nada. EXECUTE sólo para authenticated (revocado a PUBLIC/anon).
-- ============================================================================

create or replace function public.vend_repetir_pedidos(
  p_dias integer default 365,
  p_limit integer default 500
)
returns table(
  order_id bigint,
  created_at timestamptz,
  customer_id uuid,
  cod_cliente bigint,
  razon_social text,
  sucursal text,
  condicion_pago text,
  payment_discount numeric,
  total numeric,
  articulos integer,
  cajas integer,
  origen text
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_yo   uuid;
  v_vend text;
begin
  select c.id, nullif(btrim(c.vend), '')
    into v_yo, v_vend
    from public.customers c
   where c.auth_user_id = auth.uid()
     and (c.cod_cliente between 10000 and 10999 or c.cod_cliente = 1)
   limit 1;
  if v_yo is null or v_vend is null then
    return;                                   -- no es vendedor: nada
  end if;

  return query
  with cartera as (
    select c.id, c.cod_cliente, c.business_name
      from public.customers c
      join public.user_customer_links l
        on l.customer_id = c.id and l.auth_user_id = auth.uid()
     where c.id <> v_yo
       and c.cod_cliente < 10000
       and btrim(c.vend) = v_vend
  )
  select o.id,
         o.created_at,
         o.customer_id,
         ca.cod_cliente,
         ca.business_name,
         nullif(btrim(o.sheets_payload->>'sucursal_entrega'), ''),
         coalesce(nullif(btrim(o.sheets_payload->>'condicion_pago'), ''), o.payment_method),
         o.payment_discount,
         o.total,
         (select count(*)::int from public.order_items i where i.order_id = o.id),
         (select coalesce(sum(i.cajas), 0)::int from public.order_items i where i.order_id = o.id),
         nullif(btrim(o.sheets_payload->>'source'), '')
    from public.orders o
    join cartera ca on ca.id = o.customer_id
   where o.created_at >= now() - make_interval(days => greatest(coalesce(p_dias, 365), 1))
   order by o.created_at desc
   limit least(greatest(coalesce(p_limit, 500), 1), 2000);
end;
$function$;

create or replace function public.vend_repetir_pedido_items(p_order_id bigint)
returns table(
  product_id uuid,
  loke_product_id uuid,
  is_loke boolean,
  cajas integer,
  uxb integer
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_yo   uuid;
  v_vend text;
begin
  select c.id, nullif(btrim(c.vend), '')
    into v_yo, v_vend
    from public.customers c
   where c.auth_user_id = auth.uid()
     and (c.cod_cliente between 10000 and 10999 or c.cod_cliente = 1)
   limit 1;
  if v_yo is null or v_vend is null then
    return;
  end if;

  return query
  select i.product_id, i.loke_product_id, coalesce(i.is_loke, false), i.cajas, i.uxb
    from public.order_items i
    join public.orders o on o.id = i.order_id
    join public.customers c on c.id = o.customer_id
    join public.user_customer_links l
      on l.customer_id = c.id and l.auth_user_id = auth.uid()
   where i.order_id = p_order_id
     and c.id <> v_yo
     and c.cod_cliente < 10000
     and btrim(c.vend) = v_vend
   order by i.id;
end;
$function$;

revoke all on function public.vend_repetir_pedidos(integer, integer) from public, anon;
revoke all on function public.vend_repetir_pedido_items(bigint) from public, anon;
grant execute on function public.vend_repetir_pedidos(integer, integer) to authenticated, service_role;
grant execute on function public.vend_repetir_pedido_items(bigint) to authenticated, service_role;

-- Rollback:
--   drop function if exists public.vend_repetir_pedidos(integer, integer);
--   drop function if exists public.vend_repetir_pedido_items(bigint);
