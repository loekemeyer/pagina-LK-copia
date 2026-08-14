-- RPC: get_estadistica_clientes_agg
-- Alimenta el módulo "Estadística Clientes" (tablas "Próximos a comprar" y
-- "De baja") en admin.js -> cargarEstadisticaClientes.
--
-- Agrega, por cod_cliente: fecha de última compra, cantidad de compras y
-- intervalo promedio entre compras. Une las dos fuentes:
--   - orders                -> pedidos web (cada order = una fecha)
--   - sales_lines           -> histórico importado del ERP
--
-- Pseudo-artículos: sales_lines trae códigos que NO son artículos (descuentos
-- por pago tipo PAGO-25%, notas de crédito administrativas, agregados de ISIS).
-- Están listados en sales_excluded_items y se filtran acá. Sin ese filtro una
-- línea de "PAGO-25%" cuenta como una compra: corre la fecha de última compra
-- del cliente y suma al conteo de pedidos, y un cliente que en realidad dejó de
-- comprar aparece como activo.
--
-- La comparación va SIN upper() a propósito: aplicar una función a item_code
-- sobre 260k filas rompe el plan. Por eso sales_excluded_items guarda las
-- variantes de grafía tal cual vienen del ERP (DtoSuper, DtoxVol, DevErrorFC,
-- Cotiz-2%) además de las mayúsculas. Si aparece una grafía nueva hay que
-- darla de alta en esa tabla.

CREATE OR REPLACE FUNCTION public.get_estadistica_clientes_agg()
 RETURNS TABLE(cod_cliente text, last_purchase_date date, purchase_count integer, avg_interval_days numeric)
 LANGUAGE sql
 SECURITY DEFINER
AS $function$
  WITH all_dates AS (
    -- Pedidos web: cada order = una fecha
    SELECT
      c.cod_cliente::text AS cod_cliente,
      o.created_at::date AS purchase_date
    FROM orders o
    JOIN customers c ON c.id = o.customer_id
    WHERE c.cod_cliente IS NOT NULL
      AND c.cod_cliente NOT IN ('1', '3878')

    UNION

    -- Histórico ERP desde sales_lines (invoice_date ya está en ISO YYYY-MM-DD)
    SELECT
      sl.customer_code::text AS cod_cliente,
      to_date(substr(sl.invoice_date::text, 1, 10), 'YYYY-MM-DD') AS purchase_date
    FROM sales_lines sl
    WHERE sl.empresa = 'lk'
      AND sl.customer_code IS NOT NULL
      AND sl.customer_code NOT IN ('1', '3878')
      AND sl.invoice_date::text ~ '^\d{4}-\d{2}-\d{2}'
      -- SIN upper(): aplicar una función a item_code sobre las 189k líneas de
      -- lk rompía el plan y forzaba un seq scan. Sin ella sale por el índice
      -- parcial sales_lines_lk_cliente_idx: 594 ms contra 2.773 ms.
      -- sales_excluded_items guarda las grafías tal cual vienen del ERP, así
      -- que comparar en crudo da lo mismo — verificado: 170 líneas excluidas
      -- por las dos vías, 0 que aparezcan solo con upper(), y las 995 filas
      -- del resultado idénticas.
      AND sl.item_code <> ALL (ARRAY(SELECT item_code FROM sales_excluded_items))
  ),
  with_lag AS (
    SELECT
      cod_cliente,
      purchase_date,
      LAG(purchase_date) OVER (PARTITION BY cod_cliente ORDER BY purchase_date) AS prev_date
    FROM all_dates
  )
  SELECT
    cod_cliente,
    MAX(purchase_date) AS last_purchase_date,
    COUNT(*)::int AS purchase_count,
    ROUND(
      AVG(CASE
        WHEN (purchase_date - prev_date) > 0 AND (purchase_date - prev_date) < 730
        THEN (purchase_date - prev_date)::numeric
        ELSE NULL
      END), 0
    ) AS avg_interval_days
  FROM with_lag
  GROUP BY cod_cliente;
$function$;
