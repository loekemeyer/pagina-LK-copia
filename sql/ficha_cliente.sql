-- =====================================================================
-- Ficha de Cliente (vista 360 por cliente) — ABM Clientes
-- =====================================================================
-- Dos RPC, ambas con chequeo de admin adentro (son SECURITY DEFINER y
-- nacen ejecutables por anon; ver CLAUDE.md → Seguridad):
--   buscar_cliente_ficha(p_q)   -> busca por cod / razon social / CUIT / direccion de entrega
--   get_ficha_cliente(p_cod)    -> arma toda la ficha en un JSON (1 viaje)
--
-- Empresa: LK + Chef por CUIT. La identidad y las metricas se valorizan
-- con la MISMA cadena que datos_cliente_empresa / get_ranking_inactivos:
--   boxes * v_item_precio.uxb * v_item_precio.list_price
--         * (1 - dto_vol[solo LK]) * (1 - web_order_discount)
-- filtrando sales_excluded_items. El lado Chef resuelve el/los codigos por
-- CUIT (chef_padron) mas los vinculos manuales (clientes_lk_ch_links).
--
-- "Cant compras x año" = dias distintos con facturacion (sales_lines no
-- guarda numero de factura). Pedidos mes/trimestre salen de orders (portal
-- LK) con el origen de v_orders_origen (cliente / vendedor / admin).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Normalizador local sin acentos ni puntuacion (para el buscador).
-- No usa norm_razon_social porque esa ademas borra sufijos societarios,
-- que en una direccion o un nombre parcial no corresponde.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ficha_norm(p text)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
  SELECT regexp_replace(
           lower(translate(COALESCE(p,''),
             'áéíóúàèìòùäëïöüâêîôûãõñÁÉÍÓÚÀÈÌÒÙÄËÏÖÜÂÊÎÔÛÃÕÑ',
             'aeiouaeiouaeiouaeiouaonAEIOUAEIOUAEIOUAEIOUAON')),
           '[^a-z0-9]+', ' ', 'g');
$$;

-- =====================================================================
-- buscar_cliente_ficha(p_q)
-- =====================================================================
CREATE OR REPLACE FUNCTION public.buscar_cliente_ficha(p_q text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
AS $$
DECLARE
  v_q     text := btrim(COALESCE(p_q,''));
  v_norm  text := ficha_norm(p_q);
  v_dig   text := regexp_replace(COALESCE(p_q,''),'[^0-9]','','g');
  v_res   jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admins a WHERE a.auth_user_id = auth.uid()) THEN
    RAISE EXCEPTION 'no autorizado';
  END IF;

  IF length(v_norm) < 2 AND length(v_dig) < 3 THEN
    RETURN '[]'::jsonb;
  END IF;

  WITH dir AS (
    -- direccion de entrega por cliente (una linea por cod que matchea)
    SELECT DISTINCT c.cod_cliente::text AS cod
    FROM customer_delivery_addresses a
    JOIN customers c ON c.id = a.customer_id
    WHERE v_norm <> '' AND (
          ficha_norm(a.label)     LIKE '%'||v_norm||'%'
       OR ficha_norm(a.localidad) LIKE '%'||v_norm||'%'
       OR ficha_norm(a.calle)     LIKE '%'||v_norm||'%'
    )
  ),
  m AS (
    SELECT c.cod_cliente::text AS cod,
           c.business_name,
           NULLIF(regexp_replace(COALESCE(c.cuit,''),'[^0-9]','','g'),'') AS cuit_dig,
           c.cuit AS cuit_raw,
           c.localidad,
           c.vend,
           (c.cod_cliente::text = v_q)                                        AS x_cod_exact,
           (v_q <> '' AND c.cod_cliente::text ILIKE '%'||v_q||'%')            AS x_cod,
           (v_norm <> '' AND ficha_norm(c.business_name) LIKE '%'||v_norm||'%') AS x_nom,
           (length(v_dig) >= 6 AND regexp_replace(COALESCE(c.cuit,''),'[^0-9]','','g') LIKE '%'||v_dig||'%') AS x_cuit,
           (d.cod IS NOT NULL)                                                AS x_dir
    FROM customers c
    LEFT JOIN dir d ON d.cod = c.cod_cliente::text
    WHERE c.cod_cliente IS NOT NULL
  ),
  f AS (
    SELECT *,
      ARRAY_REMOVE(ARRAY[
        CASE WHEN x_cod OR x_cod_exact THEN 'codigo' END,
        CASE WHEN x_nom  THEN 'razon social' END,
        CASE WHEN x_cuit THEN 'cuit' END,
        CASE WHEN x_dir  THEN 'direccion' END
      ], NULL) AS motivos
    FROM m
    WHERE x_cod OR x_cod_exact OR x_nom OR x_cuit OR x_dir
  )
  SELECT COALESCE(jsonb_agg(row ORDER BY row->>'_ord', (row->>'cod_cliente')::int), '[]'::jsonb)
  INTO v_res
  FROM (
    SELECT jsonb_build_object(
             'cod_cliente', f.cod,
             'business_name', f.business_name,
             'cuit', f.cuit_raw,
             'localidad', f.localidad,
             'vend', f.vend,
             'motivos', to_jsonb(f.motivos),
             '_ord', CASE WHEN f.x_cod_exact THEN '0'
                          WHEN f.x_cod THEN '1'
                          WHEN f.x_nom THEN '2'
                          WHEN f.x_cuit THEN '3'
                          ELSE '4' END
           ) AS row
    FROM f
    LIMIT 40
  ) s;

  RETURN v_res;
END;
$$;

-- =====================================================================
-- get_ficha_cliente(p_cod)
-- =====================================================================
CREATE OR REPLACE FUNCTION public.get_ficha_cliente(p_cod text)
RETURNS jsonb
LANGUAGE plpgsql
-- VOLATILE (default) a proposito: crea tablas TEMP, no puede ser STABLE.
SECURITY DEFINER
AS $$
DECLARE
  v_cod       text := btrim(COALESCE(p_cod,''));
  v_cuit      text;
  v_chef      text[];
  v_wd        numeric;
  v_cut12     text := to_char((now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date - INTERVAL '12 months','YYYY-MM-DD');
  v_anio_hoy  text := to_char(now() AT TIME ZONE 'America/Argentina/Buenos_Aires','YYYY');
  v_datos     jsonb;
  v_dirs      jsonb;
  v_ped_mes   jsonb;
  v_ped_tri   jsonb;
  v_fact      jsonb;
  v_arts      jsonb;
  v_res_art   jsonb;
  v_meses     jsonb;   -- lista de los ultimos 12 meses (YYYY-MM), del mas nuevo al mas viejo
  v_mes_desde text;    -- primer dia del mes de hace 11 meses (corte de la matriz art x mes)
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admins a WHERE a.auth_user_id = auth.uid()) THEN
    RAISE EXCEPTION 'no autorizado';
  END IF;

  IF v_cod = '' THEN RETURN NULL; END IF;

  SELECT COALESCE((SELECT s.value::numeric FROM app_settings s WHERE s.key='web_order_discount'),0.02)
    INTO v_wd;

  -- Ventana de 12 meses para la matriz articulo x mes. El frontend muestra 6
  -- por defecto y deja "ver mas" para los otros 6.
  v_mes_desde := to_char(
    date_trunc('month', (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')) - INTERVAL '11 months',
    'YYYY-MM-DD');
  SELECT jsonb_agg(to_char(m,'YYYY-MM') ORDER BY m DESC)
    INTO v_meses
    FROM generate_series(
      date_trunc('month', (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')) - INTERVAL '11 months',
      date_trunc('month', (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')),
      INTERVAL '1 month') m;

  -- CUIT (digitos) del cliente LK
  SELECT NULLIF(regexp_replace(COALESCE(c.cuit,''),'[^0-9]','','g'),'')
    INTO v_cuit
    FROM customers c WHERE c.cod_cliente::text = v_cod;

  -- Codigos de Chef del mismo CUIT + vinculos manuales
  SELECT ARRAY(
    SELECT DISTINCT cp.cod_cliente
    FROM chef_padron cp
    WHERE v_cuit IS NOT NULL
      AND regexp_replace(COALESCE(cp.cuit,''),'[^0-9]','','g') = v_cuit
    UNION
    SELECT DISTINCT l2.cod_cliente
    FROM clientes_lk_ch_links l1
    JOIN clientes_lk_ch_links l2 ON l2.link_id = l1.link_id AND l2.empresa = 'chef'
    WHERE l1.empresa = 'lk' AND l1.cod_cliente = v_cod
  ) INTO v_chef;

  -- ---------------- Datos del cliente (LK) ----------------
  SELECT jsonb_build_object(
           'cod_cliente', c.cod_cliente,
           'business_name', c.business_name,
           'cuit', c.cuit,
           'direccion_fiscal', c.direccion_fiscal,
           'localidad', c.localidad,
           'vend', c.vend,
           'vendedor', COALESCE(cc.vendor_label, NULL),
           'dto_vol', c.dto_vol,
           'payment_term', c.payment_term,
           'debt', c.debt,
           'credit_limit', c.credit_limit,
           'mail', c.mail,
           'whatsapp', c.whatsapp,
           'permiso_ver_pedidos', c.permiso_ver_pedidos,
           'escala_activa', c.escala_activa,
           'chef_cods', to_jsonb(v_chef)
         )
    INTO v_datos
    FROM customers c
    LEFT JOIN customer_commissions cc ON cc.cod_cliente::text = c.cod_cliente::text
   WHERE c.cod_cliente::text = v_cod;

  -- ---------------- Direcciones de entrega ----------------
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'slot', a.slot, 'label', a.label,
           'localidad', a.localidad, 'provincia', a.provincia,
           'zona_expreso', a.zona_expreso
         ) ORDER BY a.slot NULLS LAST), '[]'::jsonb)
    INTO v_dirs
    FROM customer_delivery_addresses a
    JOIN customers c ON c.id = a.customer_id
   WHERE c.cod_cliente::text = v_cod;

  -- ---------------- Pedidos ultimo mes (portal LK) ----------------
  SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'created_at') DESC), '[]'::jsonb)
    INTO v_ped_mes
    FROM (
      SELECT jsonb_build_object(
               'id', o.id, 'created_at', o.created_at, 'status', o.status,
               'total', o.total, 'payment_method', o.payment_method,
               'origen', COALESCE(vo.origen_pedido,'-'),
               'herramienta', COALESCE(vo.herramienta,'-'),
               'items', (SELECT count(*) FROM order_items oi WHERE oi.order_id = o.id)
             ) AS x
      FROM orders o
      LEFT JOIN v_orders_origen vo ON vo.order_id = o.id
      WHERE o.customer_code = v_cod
        AND o.created_at >= now() - INTERVAL '1 month'
    ) t;

  -- ---------------- Pedidos ultimo trimestre ----------------
  SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'created_at') DESC), '[]'::jsonb)
    INTO v_ped_tri
    FROM (
      SELECT jsonb_build_object(
               'id', o.id, 'created_at', o.created_at, 'status', o.status,
               'total', o.total, 'payment_method', o.payment_method,
               'origen', COALESCE(vo.origen_pedido,'-'),
               'herramienta', COALESCE(vo.herramienta,'-'),
               'items', (SELECT count(*) FROM order_items oi WHERE oi.order_id = o.id)
             ) AS x
      FROM orders o
      LEFT JOIN v_orders_origen vo ON vo.order_id = o.id
      WHERE o.customer_code = v_cod
        AND o.created_at >= now() - INTERVAL '3 months'
    ) t;

  -- ---------------- CTE base: lineas valorizadas (LK + Chef) ----------------
  -- DROP defensivo: si la funcion se llama dos veces en la MISMA transaccion,
  -- ON COMMIT DROP todavia no libero la tabla de la llamada anterior.
  DROP TABLE IF EXISTS _sl_ficha;
  DROP TABLE IF EXISTS _art_ficha;
  CREATE TEMP TABLE _sl_ficha ON COMMIT DROP AS
    SELECT sl.empresa,
           sl.item_code,
           sl.boxes,
           NULLIF(left(sl.invoice_date,4),'') AS anio,
           sl.invoice_date,
           (sl.boxes * COALESCE(p.uxb,0) * COALESCE(p.list_price,0)
             * (1 - CASE WHEN sl.empresa='lk' THEN COALESCE(c.dto_vol,0) ELSE 0 END)
             * (1 - v_wd))::numeric AS neto,
           p.description AS descripcion,
           p.category    AS categoria
    FROM sales_lines sl
    LEFT JOIN v_item_precio p ON p.cod = sl.item_code
    LEFT JOIN customers c ON sl.empresa='lk' AND c.cod_cliente::text = sl.customer_code
    WHERE sl.item_code <> ALL (ARRAY(SELECT item_code FROM sales_excluded_items))
      AND (
            (sl.empresa='lk'   AND sl.customer_code = v_cod)
         OR (sl.empresa='chef' AND v_chef IS NOT NULL AND sl.customer_code = ANY (v_chef))
      );

  -- ---------------- Facturacion + compras por año (2020..hoy) ----------------
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'anio', gs.anio,
           'lk',    ROUND(COALESCE((SELECT sum(neto) FROM _sl_ficha s WHERE s.anio=gs.anio::text AND s.empresa='lk'),0)),
           'chef',  ROUND(COALESCE((SELECT sum(neto) FROM _sl_ficha s WHERE s.anio=gs.anio::text AND s.empresa='chef'),0)),
           'total', ROUND(COALESCE((SELECT sum(neto) FROM _sl_ficha s WHERE s.anio=gs.anio::text),0)),
           'compras', COALESCE((SELECT count(DISTINCT invoice_date) FROM _sl_ficha s WHERE s.anio=gs.anio::text),0),
           'cajas',   COALESCE((SELECT sum(boxes) FROM _sl_ficha s WHERE s.anio=gs.anio::text),0)
         ) ORDER BY gs.anio DESC), '[]'::jsonb)
    INTO v_fact
    FROM generate_series(2020, extract(year FROM now())::int) gs(anio);

  -- ---------------- Articulos: agregado por (empresa,item) ----------------
  -- alta = primer año que aparece; baja = ultimo año (si dejo de comprarlo);
  -- activo = compro en los ultimos 12 meses.
  CREATE TEMP TABLE _art_ficha ON COMMIT DROP AS
    SELECT empresa, item_code,
           max(descripcion) AS descripcion,
           max(categoria)   AS categoria,
           sum(boxes)       AS cajas,
           sum(neto)        AS neto,
           min(invoice_date) AS primera,
           max(invoice_date) AS ultima,
           min(anio)        AS anio_alta,
           max(anio)        AS anio_baja,
           (max(invoice_date) >= v_cut12) AS activo
    FROM _sl_ficha
    WHERE anio IS NOT NULL
    GROUP BY empresa, item_code;

  -- Resumen (sobre TODOS los articulos, no solo el top que se muestra)
  SELECT jsonb_build_object(
           'total_distintos', (SELECT count(*) FROM _art_ficha),
           'activos_count',   (SELECT count(*) FROM _art_ficha WHERE activo),
           'altas_por_anio', (
             SELECT COALESCE(jsonb_agg(jsonb_build_object('anio', anio_alta, 'n', n) ORDER BY anio_alta DESC),'[]'::jsonb)
             FROM (SELECT anio_alta, count(*) n FROM _art_ficha GROUP BY anio_alta) a
           ),
           'bajas_por_anio', (
             SELECT COALESCE(jsonb_agg(jsonb_build_object('anio', anio_baja, 'n', n) ORDER BY anio_baja DESC),'[]'::jsonb)
             FROM (SELECT anio_baja, count(*) n FROM _art_ficha WHERE anio_baja < v_anio_hoy GROUP BY anio_baja) b
           )
         )
    INTO v_res_art;

  -- Top articulos para la tabla (por neto)
  SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'neto')::numeric DESC), '[]'::jsonb)
    INTO v_arts
    FROM (
      SELECT jsonb_build_object(
               'empresa', af.empresa, 'cod', af.item_code,
               'descripcion', af.descripcion, 'categoria', af.categoria,
               'cajas', af.cajas, 'neto', ROUND(COALESCE(af.neto,0)),
               'primera', af.primera, 'ultima', af.ultima,
               'anio_alta', af.anio_alta, 'anio_baja', af.anio_baja,
               'activo', af.activo,
               -- cajas por mes (ultimos 12); el frontend muestra 6 y expande a 12
               'mm', COALESCE((
                 SELECT jsonb_object_agg(mk, cj)
                 FROM (
                   SELECT to_char(date_trunc('month', s.invoice_date::date),'YYYY-MM') AS mk,
                          sum(s.boxes) AS cj
                   FROM _sl_ficha s
                   WHERE s.empresa = af.empresa
                     AND s.item_code = af.item_code
                     AND s.invoice_date >= v_mes_desde
                   GROUP BY 1
                 ) mm
               ), '{}'::jsonb)
             ) AS x
      FROM _art_ficha af
      ORDER BY af.neto DESC NULLS LAST
      LIMIT 80
    ) t;

  RETURN jsonb_build_object(
    'cod', v_cod,
    'datos', v_datos,
    'direcciones', v_dirs,
    'pedidos_mes', v_ped_mes,
    'pedidos_trimestre', v_ped_tri,
    'facturacion_anio', v_fact,
    'resumen_articulos', v_res_art,
    'meses', v_meses,
    'articulos', v_arts
  );
END;
$$;

-- No hace falta revoke: el chequeo de admins esta adentro de ambas.
