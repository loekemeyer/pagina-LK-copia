-- BACKUP / ROLLBACK — public.edit_order_fast tal como estaba en el proyecto LK
-- (kwkclwhmoygunqmlegrg) el 2026-09-04, ANTES del candado "sólo agregar" (idea 4990).
-- Sacado con pg_get_functiondef, no a mano. Para revertir: ejecutar este archivo tal cual.
CREATE OR REPLACE FUNCTION public.edit_order_fast(p_order_id bigint, p_auth_user_id uuid, p_customer_id uuid, p_payment_method text, p_payment_discount numeric, p_web_discount numeric, p_subtotal numeric, p_total numeric, p_items jsonb)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_enviado timestamptz;
  v_owner uuid;
begin
  if p_auth_user_id is distinct from auth.uid() then
    raise exception 'Unauthorized: auth_user_id mismatch';
  end if;

  -- Mismas reglas de pertenencia que submit_order_fast (dueño / link / admin).
  if not exists (
    select 1 from customers c where c.id = p_customer_id and c.auth_user_id = auth.uid()
  ) and not exists (
    select 1 from user_customer_links ucl where ucl.auth_user_id = auth.uid() and ucl.customer_id = p_customer_id
  ) and not exists (
    select 1 from admins a where a.auth_user_id = auth.uid()
  ) then
    raise exception 'Unauthorized: customer mismatch';
  end if;

  -- El pedido debe existir, ser de este cliente y NO haber salido a compras.
  -- FOR UPDATE para serializar contra el cron que setea enviado_a_compras_at.
  select o.enviado_a_compras_at, o.customer_id
    into v_enviado, v_owner
  from orders o
  where o.id = p_order_id
  for update;

  if not found then
    raise exception 'Pedido inexistente';
  end if;

  if v_owner is distinct from p_customer_id then
    raise exception 'Unauthorized: order does not belong to customer';
  end if;

  if v_enviado is not null then
    raise exception 'Pedido ya enviado a compras: no editable';
  end if;

  -- Cabecera (no se toca status ni created_at: sigue siendo el mismo pedido).
  update orders
     set payment_method   = p_payment_method,
         payment_discount = p_payment_discount,
         web_discount     = p_web_discount,
         subtotal         = p_subtotal,
         total            = p_total
   where id = p_order_id;

  -- Reemplazar items: borrar y reinsertar con la misma lógica que submit_order_fast.
  delete from order_items where order_id = p_order_id;

  -- Items regulares (product_id en products).
  insert into order_items (order_id, product_id, cajas, uxb, is_loke, source)
  select
    p_order_id,
    (item->>'product_id')::uuid,
    (item->>'cajas')::int,
    (item->>'uxb')::int,
    false,
    nullif(btrim(item->>'source'), '')
  from jsonb_array_elements(p_items) as item
  where (item->>'is_loke')::boolean is distinct from true;

  -- Items Loke (loke_product_id en loke_products).
  insert into order_items (order_id, loke_product_id, cajas, uxb, is_loke, source)
  select
    p_order_id,
    (item->>'product_id')::uuid,
    (item->>'cajas')::int,
    (item->>'uxb')::int,
    true,
    nullif(btrim(item->>'source'), '')
  from jsonb_array_elements(p_items) as item
  where (item->>'is_loke')::boolean = true;

  return p_order_id;
end;
$function$;
