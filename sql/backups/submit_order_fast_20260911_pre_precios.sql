-- BACKUP 2026-09-11, ANTES de que submit_order_fast guarde los precios del parseo.
-- Definición EXACTA que estaba desplegada (pg_get_functiondef). ROLLBACK = correr esto.
CREATE OR REPLACE FUNCTION public.submit_order_fast(p_auth_user_id uuid, p_customer_id uuid, p_status text, p_payment_method text, p_payment_discount numeric, p_web_discount numeric, p_subtotal numeric, p_total numeric, p_items jsonb)
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
