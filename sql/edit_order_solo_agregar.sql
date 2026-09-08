-- =============================================================================
-- edit_order_solo_agregar.sql — el cliente sólo puede AGREGAR al pedido (2026-09-04)
-- Idea 4990 · proyecto LK (kwkclwhmoygunqmlegrg)
-- =============================================================================
-- PEDIDO DEL DUEÑO: "Módulo Editar pedidos (clientes pueden agregar cosas al
-- pedido) recomiendo que sea solo agregar (hace difícil que saquen o cancelen)".
--
-- QUÉ HACÍA ANTES: `edit_order_fast` hace `delete from order_items where
-- order_id = …` y reinserta lo que venga en `p_items`. O sea que si el carrito
-- llega con menos, el pedido se achica; si llega vacío, queda vacío. El cliente
-- podía vaciar un pedido ya mandado sin que nadie se enterara.
--
-- POR QUÉ EL CANDADO VA ACÁ Y NO EN EL FRONT: esconder el botón de quitar es
-- una comodidad, no un candado — cualquiera que llame la RPC a mano igual vacía
-- el pedido. La regla de negocio vive en el server; el front la duplica sólo
-- como UX. Además del lado de Producción Virgilio la vista `gv_ppp_web_estado`
-- ya declara `puede_quitar` = false SIEMPRE, así que esto es lo que hace cierta
-- esa declaración.
--
-- LA REGLA, EXACTA: para cada (producto, is_loke) que YA está en el pedido, lo
-- que llega tiene que traer al menos las mismas cajas. Se puede subir cantidad y
-- se pueden sumar productos nuevos. No se puede bajar, sacar, ni mandar vacío.
--
-- ⚠ SE SUMA POR PRODUCTO, no se compara fila contra fila: hay 18 grupos reales
-- con el mismo producto repetido en dos filas del mismo pedido (medido el
-- 2026-09-04). Comparando fila a fila, esos pedidos darían falso positivo.
--
-- ADMINS EXCEPTUADOS: un admin (tabla `admins`) sigue pudiendo sacar. Es la
-- salida de emergencia para cuando el cliente llama por teléfono y pide sacar
-- algo — sin eso no habría forma de hacerlo desde ningún lado. El candado es
-- para el cliente y para el vendedor con "Pedir para" (user_customer_links),
-- que es lo que pidió el dueño.
--
-- LO QUE **NO** CAMBIA: la ventana de edición. Sigue siendo
-- `enviado_a_compras_at is null` (el corte de las 12:30). El régimen nuevo dice
-- "se puede agregar hasta que se factura", pero mientras el pedido siga saliendo
-- a ISIS por el mail de las 12:30, ese flag es el candado que sostiene la
-- operación de todos los días. Se afloja el día que Gestión Virgilio tome
-- control, no antes. Decisión del dueño, 2026-09-04.
--
-- ROLLBACK: sql/backups/edit_order_fast_20260904_pre_solo_agregar.sql
-- (sacado con pg_get_functiondef, no escrito a mano). Se ejecuta tal cual.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.edit_order_fast(p_order_id bigint, p_auth_user_id uuid, p_customer_id uuid, p_payment_method text, p_payment_discount numeric, p_web_discount numeric, p_subtotal numeric, p_total numeric, p_items jsonb)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_enviado timestamptz;
  v_owner uuid;
  v_es_admin boolean;
  v_quitado text;
begin
  if p_auth_user_id is distinct from auth.uid() then
    raise exception 'Unauthorized: auth_user_id mismatch';
  end if;

  v_es_admin := exists (select 1 from admins a where a.auth_user_id = auth.uid());

  -- Mismas reglas de pertenencia que submit_order_fast (dueño / link / admin).
  if not exists (
    select 1 from customers c where c.id = p_customer_id and c.auth_user_id = auth.uid()
  ) and not exists (
    select 1 from user_customer_links ucl where ucl.auth_user_id = auth.uid() and ucl.customer_id = p_customer_id
  ) and not v_es_admin then
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

  -- ==========================================================================
  -- SÓLO AGREGAR (idea 4990). Va DESPUÉS de las validaciones de siempre y ANTES
  -- del delete, que es lo que hace irreversible el achique. El FOR UPDATE de
  -- arriba ya tiene el pedido tomado, así que nadie mete un item en el medio.
  -- ==========================================================================
  if not v_es_admin then
    select string_agg(distinct coalesce(p.cod, lp.cod, viejo.pid::text), ', ')
      into v_quitado
    from (
      select coalesce(oi.product_id, oi.loke_product_id) as pid,
             coalesce(oi.is_loke, false)                 as il,
             sum(oi.cajas)::int                          as cajas
      from order_items oi
      where oi.order_id = p_order_id
      group by 1, 2
    ) viejo
    left join (
      select (i->>'product_id')::uuid                      as pid,
             coalesce((i->>'is_loke')::boolean, false)     as il,
             sum((i->>'cajas')::int)                       as cajas
      from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) i
      group by 1, 2
    ) nuevo on nuevo.pid = viejo.pid and nuevo.il = viejo.il
    left join products      p  on not viejo.il and p.id  = viejo.pid
    left join loke_products lp on     viejo.il and lp.id = viejo.pid
    where coalesce(nuevo.cajas, 0) < viejo.cajas;

    if v_quitado is not null then
      raise exception 'Al pedido sólo se le puede AGREGAR: no se pueden quitar productos ni bajar cantidades (%). Si necesitás sacar algo, escribinos.', v_quitado
        using errcode = 'check_violation';
    end if;
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
