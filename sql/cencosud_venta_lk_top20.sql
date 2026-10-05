-- ============================================================================
-- Cencosud (Chef 2444) se analiza como venta de Loekemeyer, una sola vez y con su nombre
-- Pedido de Thomas, 05/10/2026 — YA APLICADO en el proyecto LK (kwkclwhmoygunqmlegrg).
--
-- Problema: el reporte TOP 20 (cron 32, lunes) mostraba "Relca S.R.L - DEJO DE COMPRAR".
--   * sales_lines tiene un lote manual 'jumbo_2026_02_20' (525 lineas, 22.373 cajas,
--     03/2024-01/2026) con las ventas de Cencosud cargadas como empresa 'lk' cod 2444.
--     En LK el 2444 es Relca S.R.L, que no tiene ni una venta propia.
--   * Ese lote DUPLICA el historial de Chef de Cencosud (22.357 cajas mismo periodo).
--   * El historial de Chef (2021-05 a 2026-01) trae articulos de Loekemeyer SIN L, asi que
--     contaba como Chef; desde 02/2026 ISIS Chef factura con L y ya contaba como LK.
--   * rep_top_clientes leia sales_lines empresa='lk' a secas: no veia lo de Chef con L.
--
-- Arreglo (no se borra ningun dato):
--   1. ventas_proy_lineas: toda venta de Chef a una cadena con usa_productos_chef=false
--      (hoy solo Cencosud) cuenta como LK, con o sin L, si el articulo esta en el padron LK.
--   2. ventas_proy_lineas: el lote 'jumbo_2026_02_20' no se cuenta (queda en la tabla).
--   3. rep_top_clientes lee ventas_proy_lineas (empresa analizada 'lk') y nombra al cliente
--      por (empresa que factura, codigo): 'Cencosud S.A. (Chef 2444)', cod 'CH 2444'.
--
-- Medido antes/despues, ultimos 12 meses (desde 2025-10-01):
--   LK  228.731 -> 228.731 cajas (Cencosud 13.859 -> 13.859: sale la copia, entra el original)
--   Chef 29.228 -> 25.275 (deja de contar las 3.953 cajas duplicadas de Cencosud)
--   TOP 20: Relca desaparece; Cencosud aparece con 1.115 cj/mes base y 776 recientes.
-- ============================================================================

create or replace view public.ventas_proy_lineas as
 WITH cli_art_lk AS (
         SELECT c.cod_cliente_chef AS cod
           FROM precios_super.cadena c
          WHERE c.empresa = 'chef'::text AND NOT COALESCE(c.usa_productos_chef, false) AND c.cod_cliente_chef IS NOT NULL
        UNION
         SELECT i.cod_isis
           FROM cliente_isis_cache i
          WHERE i.isis_empresa = 'chef'::text AND i.cod_isis IS NOT NULL
        ),
      cli_super_lk AS (
         SELECT c.cod_cliente_chef AS cod
           FROM precios_super.cadena c
          WHERE c.empresa = 'chef'::text AND NOT COALESCE(c.usa_productos_chef, false) AND c.cod_cliente_chef IS NOT NULL
        ),
      cod_lk AS (
         SELECT p.cod FROM products p UNION SELECT l.cod FROM loke_products l
        )
 SELECT invoice_date,
    customer_code,
    item_code,
    empresa AS empresa_venta,
        CASE
            WHEN empresa = 'chef'::text AND upper(btrim(item_code)) ~ '[0-9E]L$'::text AND (customer_code IN ( SELECT cli_art_lk.cod
               FROM cli_art_lk)) THEN 'lk'::text
            WHEN empresa = 'chef'::text AND (customer_code IN ( SELECT cli_super_lk.cod FROM cli_super_lk))
                 AND upper(btrim(item_code)) IN ( SELECT cod_lk.cod FROM cod_lk) THEN 'lk'::text
            ELSE empresa
        END AS empresa,
    regexp_replace(regexp_replace(upper(btrim(item_code)), '^0+(?=.)'::text, ''::text), '([0-9E])L$'::text, '\1'::text) AS nitem,
    boxes
   FROM sales_lines sl
  WHERE (empresa = ANY (ARRAY['lk'::text, 'chef'::text])) AND customer_code IS NOT NULL AND NOT (EXISTS ( SELECT 1
           FROM ventas_clientes_internos vi
          WHERE vi.empresa = sl.empresa AND vi.cod_cliente = sl.customer_code))
    AND COALESCE(sl.import_batch, '') <> 'jumbo_2026_02_20';

-- rep_top_clientes: ver la definicion viva con
--   select pg_get_functiondef('public.rep_top_clientes(integer)'::regprocedure);
-- Cambios: CTE base = ventas_proy_lineas where empresa='lk'; cod = 'CH '||codigo si factura Chef;
-- nombre desde chef_padron para Chef y desde customers para LK.

-- ROLLBACK de la vista: la misma definicion sin el WHEN de cli_super_lk, sin los CTE
-- cli_super_lk / cod_lk y sin la linea del import_batch.
-- ROLLBACK de rep_top_clientes: CTE mov desde sales_lines where empresa='lk'
-- and customer_code not in ('1','3878'), nombre por customers.cod_cliente.
