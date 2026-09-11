-- ══════════════════════════════════════════════════════════════════════════
-- submit_order_fast ahora GUARDA el precio que sacó el parseo (2026-09-11)
-- ══════════════════════════════════════════════════════════════════════════
-- De dónde salió: se buscaban los precios de la línea Loke que le compra Cencosud.
-- Thomas: *"los precios los podés conseguir vos en función del parseo"*. Tiene razón en que
-- el parseo los tiene —cada parser de `admin-supercot.js` saca el precio de la OC de la
-- cadena (Cencosud `CostoBruto` del EAN, Alberdi `P.Lista`, Diarco `Costo/Bto`, …) y la card
-- arma `rpcItems` con `unit_list_price`, `unit_your_price` y `line_total`— pero **ese precio
-- se tiraba al guardar**: `submit_order_fast` insertaba en `order_items` sin esas tres
-- columnas, así que tomaban su default `0 NOT NULL`.
--
-- Medido antes del cambio (11/09):
--   · 393 de 393 líneas de OC de súper (`sheets_payload->>'source' = 'Krikos'`) con
--     unit_list_price = unit_your_price = line_total = **0**. 36 OC de 5 cadenas.
--   · 18.384 de 18.392 líneas de `order_items` en total, con 8 excepciones históricas.
--
-- Qué cambia: las dos INSERT ... SELECT ahora copian las tres columnas desde el payload,
-- con COALESCE(..., 0). **El carrito (`script.js`) y `admin.js` NO mandan esos campos**
-- (verificado con grep), así que para los pedidos normales no cambia nada: siguen en 0.
-- El único que los manda es la card de OC de súper, que es justo el parseo que queríamos
-- conservar. O sea: de la próxima OC en adelante, cada cadena deja escrito su propio precio.
--
-- Esto además destraba el pendiente que ya estaba anotado en el CLAUDE.md de este repo:
-- *"No existe historial de precios… `order_items.unit_list_price` está cargado en 43 de
-- 13.597 líneas (0,3%). Para tener nominal propio habría que empezar a poblar
-- `order_items.unit_list_price`."*
--
-- Lo que NO arregla (sigue pendiente):
--   · **Cencosud** manda `p_items = []` a propósito (`rpcItemsForChef`, admin-supercot.js
--     ~línea 3552): matchea contra products de LK pero la orden va a Chef, y con los items
--     reales rompía la FK de `chef.order_items`. Así que de Cencosud no se guarda ni el ítem,
--     ni el precio. Para capturar SU precio hay que persistir el parseo en una tabla propia
--     (cadena, cod, precio, fecha, nº OC), independiente de en qué proyecto cae la orden.
--   · Lo YA facturado no se recupera: no hay ninguna OC de Cencosud parseada guardada, ni
--     PDF suyo en la bandeja Krikos (sólo Coto, La Anónima, Carrefour y Diarco, 12 PDFs), ni
--     orden suya en Chef con `sheets_payload`. Sus NP en Virgilio vinieron de ISIS.
--
-- VERIFICACIÓN hecha: se corrieron los dos INSERT contra una copia temporal de order_items
-- con un payload de dos ítems, uno con precios y otro sin. El primero guardó 1.100 / 1.260 /
-- 756.000; el segundo, 0 / 0 / 0. O sea que el camino del carrito queda idéntico.
--
-- ROLLBACK: sql/backups/submit_order_fast_20260911_pre_precios.sql
-- ══════════════════════════════════════════════════════════════════════════

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
  -- 2026-09-11: se guardan unit_list_price / unit_your_price / line_total cuando el payload
  -- los trae. Los manda SÓLO la card de OC de súper (admin-supercot.js), que los saca del
  -- PARSEO del PDF de la cadena. El carrito y admin.js no los mandan → siguen en 0.
  INSERT INTO order_items (order_id, product_id, cajas, uxb, is_loke, source,
                           unit_list_price, unit_your_price, line_total)
  SELECT
    v_order_id,
    (item->>'product_id')::uuid,
    (item->>'cajas')::int,
    (item->>'uxb')::int,
    false,
    NULLIF(btrim(item->>'source'), ''),
    COALESCE((item->>'unit_list_price')::numeric, 0),
    COALESCE((item->>'unit_your_price')::numeric, 0),
    COALESCE((item->>'line_total')::numeric, 0)
  FROM jsonb_array_elements(p_items) AS item
  WHERE (item->>'is_loke')::boolean IS DISTINCT FROM true;

  -- Items Loke (loke_product_id en loke_products)
  INSERT INTO order_items (order_id, loke_product_id, cajas, uxb, is_loke, source,
                           unit_list_price, unit_your_price, line_total)
  SELECT
    v_order_id,
    (item->>'product_id')::uuid,
    (item->>'cajas')::int,
    (item->>'uxb')::int,
    true,
    NULLIF(btrim(item->>'source'), ''),
    COALESCE((item->>'unit_list_price')::numeric, 0),
    COALESCE((item->>'unit_your_price')::numeric, 0),
    COALESCE((item->>'line_total')::numeric, 0)
  FROM jsonb_array_elements(p_items) AS item
  WHERE (item->>'is_loke')::boolean = true;

  RETURN v_order_id;
END;
$function$;

-- Control de que efectivamente se empiece a guardar (correr después de la próxima OC de súper):
-- select o.sheets_payload->>'cod_cliente' cod, o.created_at::date,
--        count(*) lineas, count(*) filter (where oi.unit_your_price > 0) con_precio
--   from orders o join order_items oi on oi.order_id = o.id
--  where o.sheets_payload->>'source' = 'Krikos'
--  group by 1,2 order by 2 desc;
