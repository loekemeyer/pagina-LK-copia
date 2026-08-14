-- Guardar order_items.source al confirmar y al editar un pedido.
--
-- Alimenta la columna "Líneas en pedidos confirmados" del panel Uso de Módulos
-- (admin.js -> cargarUsoModulos, vía la vista v_order_items_source).
--
-- EL PROBLEMA
-- El módulo de origen (catalogo / novedades / upsell_popup / loke / ...) se
-- perdía en DOS lugares distintos de la cadena:
--
--   1. script.js: el carrito guarda `source` en cada ítem e itemsPayload lo
--      arrastra, pero `rpcItems` —lo único que se le manda a la RPC— mapeaba
--      sólo product_id, cajas, uxb e is_loke. El dato moría en el navegador.
--   2. Estas dos funciones: insertaban en order_items sin la columna `source`.
--
-- Resultado: order_items.source en NULL en las 13.086 filas históricas, y el
-- panel mostrando 0 en todos los módulos, porque filtra con .eq("source", ...)
-- y eso nunca matchea NULL.
--
-- Arreglar sólo submit_order_fast no alcanza: edit_order_fast BORRA todas las
-- líneas del pedido y las reinserta, así que la primera edición le vaciaría el
-- origen a todas. Por eso van las dos.
--
-- POR QUÉ NULLIF Y NO COALESCE A 'catalogo'
-- Si un llamador no manda `source`, queda NULL ("sin origen") en vez de
-- inventarle un módulo. Un pedido cargado por un admin, o por una herramienta
-- interna, no pasó por el catálogo: contarlo ahí inflaría ese módulo con
-- ventas que no originó. El default a 'catalogo' se aplica en el navegador,
-- que es quien sabe que el ítem salió del catálogo principal.
--
-- La firma de ambas funciones no cambia, sólo el cuerpo: alcanza
-- CREATE OR REPLACE, sin DROP, así que el checkout no queda ni un instante sin
-- función. El orden de despliegue tampoco importa: si sube primero la RPC el
-- source llega vacío, y si sube primero el JS la RPC recibe una clave de más
-- en el jsonb y la ignora sin error.
--
-- Lo histórico no se recupera: no existe registro de qué módulo originó cada
-- una de las líneas ya cargadas.

CREATE OR REPLACE FUNCTION public.submit_order_fast(
  p_auth_user_id uuid,
  p_customer_id uuid,
  p_status text,
  p_payment_method text,
  p_payment_discount numeric,
  p_web_discount numeric,
  p_subtotal numeric,
  p_total numeric,
  p_items jsonb
)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_order_id bigint;
BEGIN
  IF p_auth_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Unauthorized: auth_user_id mismatch';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM customers c WHERE c.id = p_customer_id AND c.auth_user_id = auth.uid()
  ) AND NOT EXISTS (
    SELECT 1 FROM user_customer_links ucl WHERE ucl.auth_user_id = auth.uid() AND ucl.customer_id = p_customer_id
  ) AND NOT EXISTS (
    SELECT 1 FROM admins a WHERE a.auth_user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Unauthorized: customer mismatch';
  END IF;

  INSERT INTO orders (auth_user_id, customer_id, status, payment_method, payment_discount, web_discount, subtotal, total)
  VALUES (p_auth_user_id, p_customer_id, p_status, p_payment_method, p_payment_discount, p_web_discount, p_subtotal, p_total)
  RETURNING id INTO v_order_id;

  -- Items regulares (product_id en products)
  INSERT INTO order_items (order_id, product_id, cajas, uxb, is_loke, source)
  SELECT
    v_order_id,
    (item->>'product_id')::uuid,
    (item->>'cajas')::int,
    (item->>'uxb')::int,
    false,
    NULLIF(btrim(item->>'source'), '')
  FROM jsonb_array_elements(p_items) AS item
  WHERE (item->>'is_loke')::boolean IS DISTINCT FROM true;

  -- Items Loke (loke_product_id en loke_products)
  INSERT INTO order_items (order_id, loke_product_id, cajas, uxb, is_loke, source)
  SELECT
    v_order_id,
    (item->>'product_id')::uuid,
    (item->>'cajas')::int,
    (item->>'uxb')::int,
    true,
    NULLIF(btrim(item->>'source'), '')
  FROM jsonb_array_elements(p_items) AS item
  WHERE (item->>'is_loke')::boolean = true;

  RETURN v_order_id;
END;
$function$;


CREATE OR REPLACE FUNCTION public.edit_order_fast(
  p_order_id bigint,
  p_auth_user_id uuid,
  p_customer_id uuid,
  p_payment_method text,
  p_payment_discount numeric,
  p_web_discount numeric,
  p_subtotal numeric,
  p_total numeric,
  p_items jsonb
)
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
