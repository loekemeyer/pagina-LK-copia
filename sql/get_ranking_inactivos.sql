-- RPC: get_ranking_inactivos
-- Alimenta el módulo "Ranking Inactivos" (admin.html -> Estadística Clientes).
--
-- Rankea a TODOS los clientes SIN compras en los últimos p_meses por su VALOR
-- HISTÓRICO TOTAL (todos los pedidos) recalculado a precios de hoy, y devuelve
-- una hoja de p_limit filas a partir de p_offset. Cada fila trae su puesto
-- global (`ranking`) y el total de inactivos (`total_filas`), así el paginador
-- del panel se arma con una sola llamada.
-- Además devuelve el valor del último pedido, el desglose por año y el WhatsApp.
--
-- Por qué va server-side: el histórico vive en sales_lines (~260k filas). El
-- REST de Supabase corta en 1000 filas, así que el cálculo no puede hacerse en
-- el navegador. Ojo también con el statement_timeout del rol `authenticated` (~8s).
--
-- Fuentes de compra (las mismas que usa get_estadistica_clientes_agg):
--   - orders + order_items -> pedidos web
--   - sales_lines          -> histórico importado del ERP
--
-- Valorización: cantidad * products.list_price * factor_neto, donde cantidad es
-- boxes * products.uxb (ERP) o cajas * uxb (web).
--
-- QUÉ QUEDA AFUERA. Solo se valorizan los artículos VIGENTES: todos los joins
-- con products llevan `AND p.active IS TRUE`. Quedan fuera del total, del
-- desglose por año y del valor del último pedido:
--   - los que no tienen ficha en products (221 códigos viejos del ERP)
--   - los que la tienen pero con active = false (54 códigos)
-- Es deliberado: el módulo sirve para decidir a quién recontactar, y un
-- artículo que no se puede vender no es plata recuperable. Contarlo infla el
-- valor del cliente con mercadería que no le podés ofrecer.
-- El impacto medido al aplicarlo fue -0,6% sobre el total de los 493 inactivos,
-- ningún cliente cayó a cero y los 100 primeros siguieron siendo los mismos.
-- El filtro NO se aplica a la fecha de última compra (ult_erp): comprar un
-- artículo hoy discontinuado sigue siendo una compra, y mover esa fecha
-- cambiaría quién entra al ranking.
--
-- NETO (CTEs desc_web + factor). El precio de lista NO es lo que paga el
-- cliente, así que los montos salen netos de los dos descuentos que se pueden
-- reconstruir:
--   customers.dto_vol                 descuento por volumen, propio de la ficha
--   app_settings.web_order_discount   2% por pedido web
-- Se MULTIPLICAN, no se suman: es la misma cadena que arma un pedido real en
-- script.js -> listUnit * (1 - dtoVol) * (1 - webDiscountRate) * (1 - extraRate).
-- El tercer factor (descuento por medio de pago) queda afuera: depende de cómo
-- se pagó cada pedido y sales_lines no lo guarda.
--
-- Dos limitaciones asumidas: se usa el dto_vol de HOY, no el que el cliente
-- tenía cuando compró (que no está registrado), y el 2% web se aplica también a
-- las compras del ERP, que no fueron web. Ambas son coherentes con la métrica,
-- que ya es hipotética ("cuánto valdría esta canasta si la comprara hoy"), pero
-- implican que el número no coincide con ninguna factura emitida.
--
-- El factor varía por cliente, así que NO es un cambio de escala: reordena el
-- ranking. Medido sobre los 12 meses: de los 100 primeros, 99 siguen en el top
-- 100 y el corrimiento promedio es de 2,5 puestos (máximo 9).
--
-- Los códigos del ERP sin ficha en customers (236 de 1233) quedan con dto_vol 0
-- vía COALESCE, o sea que solo pierden el 2% web.
-- OJO: sales_lines tiene ~12.7k líneas con boxes negativos (devoluciones /
-- notas de crédito). Se restan, así que los montos son netos. Un cliente cuyo
-- último movimiento fue una devolución muestra valor_ultimo_pedido negativo.
--
-- invoice_date es TEXT en formato ISO 'YYYY-MM-DD', así que se compara como
-- string (ordena igual que una fecha) para aprovechar el índice
-- idx_sales_lines_customer_date.
--
-- Razón social: 236 de los 1233 códigos del ERP no tienen ficha en customers.
-- Para esos se cae a Wpp_Clientes, pero SOLO si el código mapea a un único
-- nombre: ~10 códigos ahí tienen dos razones sociales distintas (ej. 448 ->
-- "Supermercado Remo S.R.L." y "M.Sanchez Y Cia. S.R.L."). Mostrar la empresa
-- equivocada es peor que dejarlo vacío.
--
-- WhatsApp: customers.whatsapp quedó casi vacío (3 de 1245) tras un borrado
-- masivo durante la fase de testing del bot; por eso se cae al snapshot
-- bot_customers_whatsapp_backup, que recupera 82 de los 532 inactivos.
--
-- Pseudo-artículos: sales_lines trae códigos que NO son artículos (descuentos
-- por pago tipo PAGO-25%, notas de crédito administrativas, agregados de ISIS).
-- Están listados en sales_excluded_items y se filtran acá. Sin ese filtro, una
-- línea de "PAGO-25%" cuenta como compra y corre la fecha de última compra del
-- cliente. La tabla guarda las variantes de grafía tal cual vienen del ERP
-- (DtoSuper, DtoxVol, DevErrorFC, Cotiz-2%) para poder comparar SIN upper():
-- aplicar una función a item_code sobre 260k filas rompía el plan (~+700ms).
-- Si aparece una grafía nueva, hay que darla de alta en esa tabla.
--
-- ultimo_solo_discontinuados: distingue el "$0" de un pedido real cuyos
-- artículos hoy no tienen precio, del "$0" de no haber comprado nada.
--
-- articulos_distintos / articulos_discontinuados: el surtido histórico del
-- cliente y cuánto de ese surtido hoy ya no se puede vender. Sirve para leer el
-- valor histórico con contexto: un cliente de $50M cuyo mix está discontinuado
-- al 60% no se recupera ofreciéndole lo mismo que compraba.
-- Discontinuado = sin ficha en products, o con active = false. No se mira
-- list_price porque hoy NO existe ningún artículo con precio 0 que siga activo
-- (los 221 sin ficha y los 54 inactivos cubren el 100% de los casos). Si eso
-- cambia, hay que agregar la condición.
-- Los discontinuados que cuentan acá son EXACTAMENTE los que la valorización
-- deja afuera: todos los joins con products filtran por active IS TRUE. Así
-- articulos_discontinuados explica el hueco entre lo que el cliente compró y
-- lo que el total le atribuye, en vez de ser un dato suelto al costado.
--
-- total_pedidos / frecuencia_meses: mismos números que la tabla "De baja".
-- Un pedido = una fecha de compra distinta (el UNION de fechas dedupe), y la
-- frecuencia es el promedio de días entre compras consecutivas /30, ignorando
-- los saltos de más de 730 días. Se calculan solo para los N del ranking.
--
-- p_solo_excluidos: invierte el filtro de ranking_inactivos_excluidos, que es
-- la lista de clientes que un admin sacó a mano del módulo. En false (normal)
-- los esconde; en true muestra SOLO esos, que es la vista "Ver ocultos" del
-- panel. El filtro se aplica antes del ranking para que la numeración 1..N
-- corra sobre los visibles.
--
-- Rendimiento (12 meses, 25 por hoja): ~620 ms la hoja 1, ~810 ms con búsqueda
-- (offset 500). Las hojas del fondo cuestan más porque son clientes cuyos
-- artículos ya no están en products, así que sus líneas no se recortan en el join. Tres claves: (1) el pre-agregado por
-- (cliente, año, artículo) antes de joinear products, (2) calcular el valor del
-- último pedido con joins únicos y no con subconsultas correlacionadas —estas
-- costaban ~3.8s extra al pasar de 10 a 100 filas—, y (3) NO materializar
-- sales_lines filtrada en un CTE: copiaba 260k filas a una relación sin índices
-- y los joins pasaban a seq scan (~+1.5s).
--
-- GRUPOS DE RAZONES SOCIALES (customer_grupos)
-- Muchos clientes dejaron de comprar con una razón social y siguieron con
-- otra. Son el mismo cliente real, pero con códigos distintos, y sin agrupar
-- el viejo figura como inactivo con todo su histórico mientras el nuevo compra
-- normalmente. La tabla customer_grupos los junta y marca uno como vigente.
--
-- Qué hace acá:
--   1. La FECHA de última compra se calcula sobre el vigente (CTE canon), así
--      que si el grupo sigue comprando, ninguna de sus razones sociales entra
--      al ranking.
--   2. El HISTÓRICO de todas se suma en el vigente (CTE miembros), y las demás
--      no aparecen como fila propia.
--
-- El factor de descuento se aplica POR CÓDIGO CRUDO, no por el vigente: cada
-- razón social valoriza su historia con SU dto_vol. Si saliera del vigente,
-- cambiar cuál está marcada como vigente movería el total del grupo, y esa es
-- una decisión administrativa que no tiene por qué mover la plata. Con el
-- factor por miembro el total es invariante: se verificó dando vuelta la
-- vigente de un grupo de prueba y el total quedó idéntico ($19.785.183).
--
-- miembros expande el canónico a códigos CRUDOS en vez de mapear dentro del
-- join contra sales_lines: `sl.customer_code = m.raw` usa
-- idx_sales_lines_customer_date, y un COALESCE del lado del join lo rompía.
--
-- EL RANKING MIDE SOLO LOEKEMEYER (empresa = 'lk')
-- sales_lines guarda las ventas de las dos empresas. Toda lectura de acá
-- filtra empresa = 'lk': el módulo contesta quién dejó de comprarle a
-- Loekemeyer. Antes mezclaba y los 243 códigos que operan únicamente en Chef
-- figuraban como clientes a recuperar sin haberle comprado nunca a Loekemeyer.
-- Pasó de 524 a 368 filas.
--
-- El filtro va INLINE en cada join, NO en un CTE. Se probó
-- (`WITH lk_lines AS (SELECT * FROM sales_lines WHERE empresa = 'lk')`) y como
-- se referencia seis veces Postgres lo materializa: 189k filas a una relación
-- sin índices y cada join pasa a seq scan. Costó 2.163 ms contra 496 ms con el
-- filtro inline. Hay un índice parcial para esto:
--   CREATE INDEX sales_lines_lk_cliente_idx
--     ON public.sales_lines (customer_code) WHERE empresa = 'lk';
--
-- CLIENTES QUE SE PASARON A CHEF (lk_ch_excluidos_cache)
-- Un cliente que dejó de comprarle a Loekemeyer pero le sigue comprando a Chef
-- no se perdió: cambió de línea, y reclamarlo por inactivo es un falso
-- positivo. El CTE inactivos los saca leyendo lk_ch_excluidos_cache.
-- Se lee la CACHE y no se recalcula en vivo con codigos_lk_excluidos_por_chef:
-- recalcular en cada carga costaba 2.163 ms contra 496 ms. La refrescan las
-- RPC que la pueden cambiar (set_lk_ch_excluido, reset_lk_ch_excluido,
-- vincular_lk_ch, desvincular_lk_ch) y el cron sincronizar-chef-diario.
-- Todo eso vive en sql/clientes_lk_ch.sql.
-- Es distinto de ranking_inactivos_excluidos, que es ocultar a mano una fila
-- puntual (ver p_solo_excluidos más arriba).
DROP FUNCTION IF EXISTS public.get_ranking_inactivos(int, int);
DROP FUNCTION IF EXISTS public.get_ranking_inactivos(int, int, boolean);
DROP FUNCTION IF EXISTS public.get_ranking_inactivos(int, int, boolean, int);
DROP FUNCTION IF EXISTS public.get_ranking_inactivos(int, int, boolean, int, text);

CREATE OR REPLACE FUNCTION public.get_ranking_inactivos(p_meses integer DEFAULT 12, p_limit integer DEFAULT 100, p_solo_excluidos boolean DEFAULT false, p_offset integer DEFAULT 0, p_q text DEFAULT NULL::text, p_vendedores text[] DEFAULT NULL::text[])
 RETURNS TABLE(cod_cliente text, business_name text, last_date date, total_historico numeric, valor_ultimo_pedido numeric, desglose_por_anio jsonb, whatsapp text, ultimo_solo_discontinuados boolean, total_pedidos integer, frecuencia_meses numeric, articulos_distintos integer, articulos_discontinuados integer, miembros jsonb, ranking integer, total_filas bigint, cuit text, vendedor text, vendedor_nombre text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  WITH cutoff AS (
    SELECT to_char(CURRENT_DATE - (p_meses || ' months')::interval, 'YYYY-MM-DD') AS c
  ),
  canon AS (
    SELECT g.cod_cliente AS cod, v.cod_cliente AS canonico
    FROM customer_grupos g
    JOIN customer_grupos v ON v.grupo_id = g.grupo_id AND v.es_vigente
    WHERE g.empresa = 'lk'
  ),
  ult_erp AS (
    SELECT COALESCE(cn.canonico, sl.customer_code)::text AS cod,
           MAX(sl.invoice_date) AS last_txt
    FROM sales_lines sl
    LEFT JOIN canon cn ON cn.cod = sl.customer_code
    WHERE sl.empresa = 'lk' AND sl.customer_code IS NOT NULL
      AND sl.customer_code NOT IN ('1', '3878')
      AND sl.invoice_date IS NOT NULL
      AND sl.item_code <> ALL (ARRAY(SELECT item_code FROM sales_excluded_items))
    GROUP BY 1
  ),
  ult_web AS (
    SELECT COALESCE(cn.canonico, c.cod_cliente::text) AS cod,
           to_char(MAX(o.created_at::date), 'YYYY-MM-DD') AS last_txt
    FROM orders o
    JOIN customers c ON c.id = o.customer_id
    LEFT JOIN canon cn ON cn.cod = c.cod_cliente::text
    WHERE c.cod_cliente IS NOT NULL
      AND c.cod_cliente NOT IN ('1', '3878')
    GROUP BY 1
  ),
  ult AS (
    SELECT cod, MAX(last_txt) AS last_txt
    FROM (SELECT * FROM ult_erp UNION ALL SELECT * FROM ult_web) t
    GROUP BY cod
  ),
  inactivos AS (
    SELECT u.cod, u.last_txt
    FROM ult u CROSS JOIN cutoff
    WHERE u.last_txt < cutoff.c
      AND (p_solo_excluidos OR u.cod NOT IN (SELECT cod_cliente FROM lk_ch_excluidos_cache))
      AND (
        CASE WHEN p_solo_excluidos
          THEN u.cod IN (SELECT cod_cliente FROM ranking_inactivos_excluidos)
          ELSE u.cod NOT IN (SELECT cod_cliente FROM ranking_inactivos_excluidos)
        END
      )
  ),
  -- Razón social resuelta para TODOS los inactivos, no solo la hoja visible:
  -- el buscador filtra por nombre y necesita el nombre resuelto antes de
  -- paginar. Antes esto vivía en un LATERAL al final, sobre las 25 filas.
  -- El CUIT sale del mismo lado y por la misma razón: también se busca por él.
  -- Nombre del vendedor por CÓDIGO, para los clientes que no tienen fila
  -- propia en customer_commissions. Se toma la etiqueta dominante del código:
  -- 18 de los 22 códigos mapean a un solo nombre con 100% de concordancia y
  -- el resto va de 78% a 98%. Se deriva en vivo y no se materializa, así no
  -- hay una tabla más que se pueda desincronizar.
  vend_nom AS (
    SELECT cod, lab FROM (
      SELECT btrim(c2.vend) AS cod, cc.vendor_label AS lab,
             ROW_NUMBER() OVER (PARTITION BY btrim(c2.vend)
                                ORDER BY count(*) DESC, cc.vendor_label) AS rn
      FROM customer_commissions cc
      JOIN customers c2 ON c2.cod_cliente = cc.cod_cliente
      WHERE NULLIF(btrim(c2.vend), '') IS NOT NULL
        AND NULLIF(btrim(cc.vendor_label), '') IS NOT NULL
      GROUP BY btrim(c2.vend), cc.vendor_label
    ) t WHERE rn = 1
  ),
  nombres AS (
    SELECT i.cod,
           COALESCE(NULLIF(btrim(c.business_name), ''), wn.nombre, '') AS nom,
           NULLIF(btrim(c.cuit), '') AS cuit,
           -- Vendedor asignado al cliente. Es el mismo campo que viaja a Google
           -- Sheets en cada pedido (sheets_payload->>'vend'), o sea el código
           -- del ERP, no un nombre. 8 de 1.245 fichas no lo tienen cargado.
           NULLIF(btrim(c.vend), '') AS vend,
           -- customer_commissions tiene UNA fila por cod_cliente, así que el
           -- vínculo directo manda; el mapa por código es el respaldo para los
           -- que no tienen fila. Cubre 357 de las 368 filas del ranking.
           COALESCE(NULLIF(btrim(cm.vendor_label), ''), vn.lab) AS vend_nombre
    FROM inactivos i
    LEFT JOIN customers c ON c.cod_cliente::text = i.cod
    LEFT JOIN customer_commissions cm ON cm.cod_cliente::text = i.cod
    LEFT JOIN vend_nom vn ON vn.cod = btrim(c.vend)
    LEFT JOIN LATERAL (
      SELECT MIN(btrim(w.nombre)) AS nombre
      FROM "Wpp_Clientes" w
      WHERE w.marca = 'LK' AND w.cod_cli::text = i.cod
        AND btrim(COALESCE(w.nombre, '')) <> ''
      HAVING count(DISTINCT btrim(w.nombre)) = 1
    ) wn ON TRUE
  ),
  miembros AS (
    SELECT i.cod AS canon, i.cod AS raw FROM inactivos i
    UNION
    SELECT i.cod, g.cod_cliente
    FROM inactivos i
    JOIN customer_grupos gv ON gv.cod_cliente = i.cod AND gv.es_vigente
    JOIN customer_grupos g ON g.grupo_id = gv.grupo_id
  ),
  desc_web AS (
    SELECT COALESCE(
             (SELECT s.value FROM app_settings s WHERE s.key = 'web_order_discount'),
             0.02
           )::numeric AS d
  ),
  factor AS (
    SELECT DISTINCT m.raw AS cod,
           ((1 - COALESCE(c.dto_vol, 0)) * (1 - dw.d))::numeric AS f
    FROM miembros m
    CROSS JOIN desc_web dw
    LEFT JOIN customers c ON c.cod_cliente::text = m.raw
  ),
  erp_agg AS (
    SELECT m.canon AS cod,
           m.raw,
           substr(sl.invoice_date, 1, 4) AS anio,
           sl.item_code,
           SUM(sl.boxes) AS boxes
    FROM miembros m
    JOIN sales_lines sl ON sl.empresa = 'lk' AND sl.customer_code = m.raw
    WHERE sl.empresa = 'lk' AND sl.invoice_date IS NOT NULL
      AND sl.item_code <> ALL (ARRAY(SELECT item_code FROM sales_excluded_items))
    GROUP BY m.canon, m.raw, substr(sl.invoice_date, 1, 4), sl.item_code
  ),
  por_raw AS (
    SELECT e.cod, e.raw, e.anio,
           (e.boxes * COALESCE(p.uxb, 0) * COALESCE(p.list_price, 0) * f.f)::numeric AS monto
    FROM erp_agg e
    JOIN products p ON p.cod = e.item_code AND p.active IS TRUE
    JOIN factor f ON f.cod = e.raw

    UNION ALL

    SELECT m.canon, m.raw,
           to_char(o.created_at, 'YYYY'),
           (oi.cajas * COALESCE(NULLIF(oi.uxb, 0), p.uxb, 0) * COALESCE(p.list_price, 0) * f.f)::numeric
    FROM miembros m
    JOIN factor f ON f.cod = m.raw
    JOIN customers c ON c.cod_cliente::text = m.raw
    JOIN orders o ON o.customer_id = c.id
    JOIN order_items oi ON oi.order_id = o.id
    JOIN products p ON p.id = oi.product_id AND p.active IS TRUE
  ),
  por_anio AS (
    SELECT cod, anio, ROUND(SUM(monto))::numeric AS monto
    FROM por_raw GROUP BY cod, anio
  ),
  tot AS (
    SELECT cod, SUM(monto) AS total FROM por_anio GROUP BY cod
  ),
  -- El puesto se calcula sobre TODOS los inactivos, antes de filtrar: buscando
  -- un cliente se quiere ver que es el 317 de 532, no el 1 de 1.
  ranked AS (
    SELECT i.cod, i.last_txt, COALESCE(t.total, 0)::numeric AS total,
           ROW_NUMBER() OVER (ORDER BY COALESCE(t.total, 0) DESC, i.cod ASC)::int AS pos
    FROM inactivos i
    LEFT JOIN tot t ON t.cod = i.cod
  ),
  -- n_total sale de acá y no de ranked: el paginador tiene que contar las
  -- coincidencias de la búsqueda, no el total de inactivos.
  filtrado AS (
    SELECT r.*, COUNT(*) OVER ()::bigint AS n_total
    FROM ranked r
    JOIN nombres nm ON nm.cod = r.cod
    WHERE (
        COALESCE(btrim(p_q), '') = ''
        OR r.cod ILIKE '%' || btrim(p_q) || '%'
        OR nm.nom ILIKE '%' || btrim(p_q) || '%'
       -- CUIT comparado solo por dígitos, así "30-59036076-3" encuentra al que
       -- está cargado como "30590360763".
       -- El mínimo de 6 dígitos no es un capricho: los códigos de cliente
       -- tienen 1 a 4 dígitos, y sin el piso buscar el código 996 devolvía
       -- además todos los clientes cuyo CUIT contiene "996" en algún lado.
       -- Con 6 la búsqueda por código sigue siendo exacta y el CUIT se
       -- encuentra igual, entero o por el DNI del medio.
       OR (
         length(regexp_replace(btrim(p_q), '[^0-9]', '', 'g')) >= 6
         AND regexp_replace(COALESCE(nm.cuit, ''), '[^0-9]', '', 'g')
             LIKE '%' || regexp_replace(btrim(p_q), '[^0-9]', '', 'g') || '%'
        )
      )
      -- Filtro por vendedor, que viene del menú del encabezado de la columna.
      -- Va aparte del buscador y no dentro de él: son dos filtros que se
      -- combinan con Y, no alternativas. NULL o arreglo vacío = todos.
      AND (
        p_vendedores IS NULL
        OR cardinality(p_vendedores) = 0
        OR nm.vend_nombre = ANY (p_vendedores)
      )
  ),
  top_n AS (
    SELECT * FROM filtrado
    ORDER BY pos
    LIMIT GREATEST(p_limit, 1) OFFSET GREATEST(p_offset, 0)
  ),
  miembros_top AS (
    SELECT m.* FROM miembros m WHERE m.canon IN (SELECT cod FROM top_n)
  ),
  fechas AS (
    SELECT m.canon AS cod, sl.invoice_date AS d
    FROM miembros_top m
    JOIN sales_lines sl ON sl.empresa = 'lk' AND sl.customer_code = m.raw
    WHERE sl.empresa = 'lk' AND sl.invoice_date IS NOT NULL
      AND sl.item_code <> ALL (ARRAY(SELECT item_code FROM sales_excluded_items))
    UNION
    SELECT m.canon, to_char(o.created_at::date, 'YYYY-MM-DD')
    FROM miembros_top m
    JOIN customers c3 ON c3.cod_cliente::text = m.raw
    JOIN orders o ON o.customer_id = c3.id
  ),
  fechas_lag AS (
    SELECT cod,
           to_date(d, 'YYYY-MM-DD') AS dd,
           LAG(to_date(d, 'YYYY-MM-DD')) OVER (PARTITION BY cod ORDER BY d) AS prev
    FROM fechas
  ),
  stats AS (
    SELECT cod,
           count(*)::int AS total_pedidos,
           ROUND(
             AVG(CASE
               WHEN (dd - prev) > 0 AND (dd - prev) < 730 THEN (dd - prev)::numeric
             END) / 30.0, 1
           ) AS frecuencia_meses
    FROM fechas_lag
    GROUP BY cod
  ),
  arts AS (
    SELECT m.canon AS cod, sl.item_code AS item
    FROM miembros_top m
    JOIN sales_lines sl ON sl.empresa = 'lk' AND sl.customer_code = m.raw
    WHERE sl.empresa = 'lk' AND sl.item_code <> ALL (ARRAY(SELECT item_code FROM sales_excluded_items))
    UNION
    SELECT m.canon, p.cod
    FROM miembros_top m
    JOIN customers c4 ON c4.cod_cliente::text = m.raw
    JOIN orders o ON o.customer_id = c4.id
    JOIN order_items oi ON oi.order_id = o.id
    JOIN products p ON p.id = oi.product_id
  ),
  arts_cnt AS (
    SELECT a.cod,
           count(*)::int AS articulos_distintos,
           count(*) FILTER (WHERE p.cod IS NULL OR p.active IS NOT TRUE)::int
             AS articulos_discontinuados
    FROM arts a
    LEFT JOIN products p ON p.cod = a.item
    GROUP BY a.cod
  ),
  grupos_top AS (
    SELECT m.canon
    FROM miembros_top m
    GROUP BY m.canon
    HAVING count(*) > 1
  ),
  val_miembro AS (
    SELECT pr.cod, pr.raw, ROUND(SUM(pr.monto))::numeric AS total
    FROM por_raw pr
    WHERE pr.cod IN (SELECT canon FROM grupos_top)
    GROUP BY pr.cod, pr.raw
  ),
  ult_miembro AS (
    SELECT m.raw, MAX(sl.invoice_date) AS d
    FROM miembros_top m
    JOIN sales_lines sl ON sl.empresa = 'lk' AND sl.customer_code = m.raw
    WHERE m.canon IN (SELECT canon FROM grupos_top)
      AND sl.item_code <> ALL (ARRAY(SELECT item_code FROM sales_excluded_items))
    GROUP BY m.raw
  ),
  miembros_det AS (
    SELECT m.canon AS cod,
           jsonb_agg(
             jsonb_build_object(
               'cod', m.raw,
               'nombre', COALESCE(NULLIF(btrim(cm.business_name), ''), wnm.nombre, ''),
               'last_date', um.d,
               'valor', COALESCE(vm.total, 0),
               'vigente', (m.raw = m.canon)
             )
             ORDER BY COALESCE(vm.total, 0) DESC, m.raw
           ) AS d
    FROM miembros_top m
    JOIN grupos_top gt ON gt.canon = m.canon
    LEFT JOIN val_miembro vm ON vm.cod = m.canon AND vm.raw = m.raw
    LEFT JOIN ult_miembro um ON um.raw = m.raw
    LEFT JOIN customers cm ON cm.cod_cliente::text = m.raw
    LEFT JOIN LATERAL (
      SELECT MIN(btrim(w.nombre)) AS nombre
      FROM "Wpp_Clientes" w
      WHERE w.marca = 'LK' AND w.cod_cli::text = m.raw
        AND btrim(COALESCE(w.nombre, '')) <> ''
      HAVING count(DISTINCT btrim(w.nombre)) = 1
    ) wnm ON TRUE
    GROUP BY m.canon
  ),
  erp_ult AS (
    SELECT t.cod,
           SUM(sl.boxes * COALESCE(p.uxb, 0) * COALESCE(p.list_price, 0) * f.f)::numeric AS monto
    FROM top_n t
    JOIN miembros_top m ON m.canon = t.cod
    JOIN factor f ON f.cod = m.raw
    JOIN sales_lines sl ON sl.empresa = 'lk' AND sl.customer_code = m.raw
                       AND sl.invoice_date = t.last_txt
    JOIN products p ON p.cod = sl.item_code AND p.active IS TRUE
    WHERE sl.empresa = 'lk' AND sl.item_code <> ALL (ARRAY(SELECT item_code FROM sales_excluded_items))
    GROUP BY t.cod
  ),
  erp_ult_cnt AS (
    SELECT t.cod,
           count(*) AS lineas,
           count(*) FILTER (
             WHERE p.cod IS NOT NULL
               AND p.active IS TRUE
               AND COALESCE(p.list_price, 0) <> 0
           ) AS lineas_valorizadas
    FROM top_n t
    JOIN miembros_top m ON m.canon = t.cod
    JOIN sales_lines sl ON sl.empresa = 'lk' AND sl.customer_code = m.raw
                       AND sl.invoice_date = t.last_txt
    LEFT JOIN products p ON p.cod = sl.item_code
    WHERE sl.empresa = 'lk' AND sl.item_code <> ALL (ARRAY(SELECT item_code FROM sales_excluded_items))
    GROUP BY t.cod
  ),
  web_ult AS (
    SELECT t.cod,
           SUM(oi.cajas * COALESCE(NULLIF(oi.uxb, 0), p.uxb, 0) * COALESCE(p.list_price, 0) * f.f)::numeric AS monto,
           count(*) AS lineas
    FROM top_n t
    JOIN miembros_top m ON m.canon = t.cod
    JOIN factor f ON f.cod = m.raw
    JOIN customers c2 ON c2.cod_cliente::text = m.raw
    JOIN orders o ON o.customer_id = c2.id
                 AND to_char(o.created_at::date, 'YYYY-MM-DD') = t.last_txt
    JOIN order_items oi ON oi.order_id = o.id
    JOIN products p ON p.id = oi.product_id AND p.active IS TRUE
    GROUP BY t.cod
  ),
  desg AS (
    SELECT pa.cod, jsonb_object_agg(pa.anio, pa.monto) AS d
    FROM por_anio pa
    WHERE pa.cod IN (SELECT cod FROM top_n) AND pa.monto > 0
    GROUP BY pa.cod
  )
  SELECT
    t.cod AS cod_cliente,
    nm.nom AS business_name,
    to_date(t.last_txt, 'YYYY-MM-DD') AS last_date,
    ROUND(t.total)::numeric AS total_historico,
    ROUND(COALESCE(eu.monto, 0) + COALESCE(wu.monto, 0))::numeric AS valor_ultimo_pedido,
    COALESCE(d.d, '{}'::jsonb) AS desglose_por_anio,
    COALESCE(
      NULLIF(btrim(c.whatsapp), ''),
      NULLIF(btrim(bw.whatsapp), '')
    ) AS whatsapp,
    (
      COALESCE(ec.lineas, 0) > 0
      AND COALESCE(ec.lineas_valorizadas, 0) = 0
      AND COALESCE(wu.lineas, 0) = 0
    ) AS ultimo_solo_discontinuados,
    COALESCE(st.total_pedidos, 0) AS total_pedidos,
    st.frecuencia_meses,
    COALESCE(ac.articulos_distintos, 0) AS articulos_distintos,
    COALESCE(ac.articulos_discontinuados, 0) AS articulos_discontinuados,
    md.d AS miembros,
    t.pos AS ranking,
    t.n_total AS total_filas,
    nm.cuit AS cuit,
    nm.vend AS vendedor,
    nm.vend_nombre AS vendedor_nombre
  FROM top_n t
  JOIN nombres nm ON nm.cod = t.cod
  LEFT JOIN erp_ult eu ON eu.cod = t.cod
  LEFT JOIN erp_ult_cnt ec ON ec.cod = t.cod
  LEFT JOIN web_ult wu ON wu.cod = t.cod
  LEFT JOIN desg d ON d.cod = t.cod
  LEFT JOIN stats st ON st.cod = t.cod
  LEFT JOIN arts_cnt ac ON ac.cod = t.cod
  LEFT JOIN miembros_det md ON md.cod = t.cod
  LEFT JOIN customers c ON c.cod_cliente::text = t.cod
  LEFT JOIN LATERAL (
    SELECT MIN(btrim(b.whatsapp)) AS whatsapp
    FROM bot_customers_whatsapp_backup b
    WHERE b.cod_cliente::text = t.cod
      AND btrim(COALESCE(b.whatsapp, '')) <> ''
  ) bw ON TRUE
  ORDER BY t.pos;
$function$;

GRANT EXECUTE ON FUNCTION public.get_ranking_inactivos(int, int, boolean, int, text, text[]) TO authenticated;


-- ---------------------------------------------------------------------------
-- Lista para el menú de filtro por vendedor del encabezado de la columna.
--
-- Devuelve SOLO los vendedores que aparecen en el ranking con los mismos
-- parámetros con que está cargada la tabla. Antes agrupaba customer_commissions
-- entera y ofrecía 20 nombres, tres de ellos ("Fab.", "La Bianca", "Sphan") sin
-- un solo cliente en el ranking a 12 meses: elegirlos vaciaba la tabla.
--
-- OJO — DUPLICACIÓN DELIBERADA. Los CTE cutoff/canon/ult_erp/ult_web/ult/
-- inactivos/vend_nom son los MISMOS que los de get_ranking_inactivos y hay que
-- mantenerlos alineados a mano. No se reusa la RPC de pantalla porque pedirle
-- el ranking completo (p_limit alto) cuesta 8.466 ms medidos, por encima del
-- statement_timeout de ~8 s: es el mismo motivo por el que existe
-- get_ranking_inactivos_export. Copiando solo los CTE baratos son 1.316 ms.
-- Verificado contra get_ranking_inactivos(12, 5000, false, 0, null, null):
-- mismos 17 nombres y mismas cuentas, 0 diferencias.
--
-- La lista DEPENDE del período: a 3 meses aparecen "La Bianca" y "Sphan", que a
-- 12 no están. Por eso admin.js invalida su cache al cambiar de período o al
-- entrar a la vista de ocultos.
--
-- Revocada de anon/PUBLIC: es SECURITY DEFINER y el módulo es solo de admin.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.get_vendedores_ranking();

CREATE OR REPLACE FUNCTION public.get_vendedores_ranking(p_meses integer DEFAULT 12, p_solo_excluidos boolean DEFAULT false)
 RETURNS TABLE(vendedor_nombre text, clientes bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  WITH cutoff AS (
    SELECT to_char(CURRENT_DATE - (p_meses || ' months')::interval, 'YYYY-MM-DD') AS c
  ),
  canon AS (
    SELECT g.cod_cliente AS cod, v.cod_cliente AS canonico
    FROM customer_grupos g
    JOIN customer_grupos v ON v.grupo_id = g.grupo_id AND v.es_vigente
    WHERE g.empresa = 'lk'
  ),
  ult_erp AS (
    SELECT COALESCE(cn.canonico, sl.customer_code)::text AS cod,
           MAX(sl.invoice_date) AS last_txt
    FROM sales_lines sl
    LEFT JOIN canon cn ON cn.cod = sl.customer_code
    WHERE sl.empresa = 'lk' AND sl.customer_code IS NOT NULL
      AND sl.customer_code NOT IN ('1', '3878')
      AND sl.invoice_date IS NOT NULL
      AND sl.item_code <> ALL (ARRAY(SELECT item_code FROM sales_excluded_items))
    GROUP BY 1
  ),
  ult_web AS (
    SELECT COALESCE(cn.canonico, c.cod_cliente::text) AS cod,
           to_char(MAX(o.created_at::date), 'YYYY-MM-DD') AS last_txt
    FROM orders o
    JOIN customers c ON c.id = o.customer_id
    LEFT JOIN canon cn ON cn.cod = c.cod_cliente::text
    WHERE c.cod_cliente IS NOT NULL
      AND c.cod_cliente NOT IN ('1', '3878')
    GROUP BY 1
  ),
  ult AS (
    SELECT cod, MAX(last_txt) AS last_txt
    FROM (SELECT * FROM ult_erp UNION ALL SELECT * FROM ult_web) t
    GROUP BY cod
  ),
  inactivos AS (
    SELECT u.cod
    FROM ult u CROSS JOIN cutoff
    WHERE u.last_txt < cutoff.c
      AND (p_solo_excluidos OR u.cod NOT IN (SELECT cod_cliente FROM lk_ch_excluidos_cache))
      AND (
        CASE WHEN p_solo_excluidos
          THEN u.cod IN (SELECT cod_cliente FROM ranking_inactivos_excluidos)
          ELSE u.cod NOT IN (SELECT cod_cliente FROM ranking_inactivos_excluidos)
        END
      )
  ),
  vend_nom AS (
    SELECT cod, lab FROM (
      SELECT btrim(c2.vend) AS cod, cc.vendor_label AS lab,
             ROW_NUMBER() OVER (PARTITION BY btrim(c2.vend)
                                ORDER BY count(*) DESC, cc.vendor_label) AS rn
      FROM customer_commissions cc
      JOIN customers c2 ON c2.cod_cliente = cc.cod_cliente
      WHERE NULLIF(btrim(c2.vend), '') IS NOT NULL
        AND NULLIF(btrim(cc.vendor_label), '') IS NOT NULL
      GROUP BY btrim(c2.vend), cc.vendor_label
    ) t WHERE rn = 1
  )
  SELECT COALESCE(NULLIF(btrim(cm.vendor_label), ''), vn.lab) AS vendedor_nombre,
         count(*)::bigint
  FROM inactivos i
  LEFT JOIN customers c ON c.cod_cliente::text = i.cod
  LEFT JOIN customer_commissions cm ON cm.cod_cliente::text = i.cod
  LEFT JOIN vend_nom vn ON vn.cod = btrim(c.vend)
  WHERE COALESCE(NULLIF(btrim(cm.vendor_label), ''), vn.lab) IS NOT NULL
  GROUP BY 1
  ORDER BY 1;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_vendedores_ranking(integer, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_vendedores_ranking(integer, boolean) TO authenticated;

-- Índice funcional sobre Wpp_Clientes.cod_cli::text.
-- La tabla ya tiene un índice sobre (cod_cli, marca), pero acá se compara
-- `w.cod_cli::text = <cod>` porque del otro lado el código es text. El cast
-- del lado de la COLUMNA anula ese índice, y el LATERAL que resuelve la razón
-- social hacía un scan por cliente: con 532 inactivos, ~320 ms de más.
-- Se indexa la expresión en vez de cambiar la comparación a
-- `w.cod_cli = <cod>::int`: un código no numérico reventaría ese cast.
CREATE INDEX IF NOT EXISTS wpp_clientes_cod_cli_text_idx
  ON public."Wpp_Clientes" ((cod_cli::text));


-- ===========================================================================
-- get_ranking_inactivos_export
-- ===========================================================================
-- Versión liviana para el botón "Descargar como .xlsx" del mismo módulo.
--
-- POR QUÉ EXISTE. El archivo lleva el ranking COMPLETO, no la hoja visible.
-- Pedirle esas 531 filas a get_ranking_inactivos de una (p_limit alto) hacía
-- correr sobre TODO el ranking sus CTEs caras — frecuencia entre pedidos
-- (fechas/fechas_lag/stats), artículos distintos y discontinuados
-- (arts/arts_cnt), detalle de miembros del grupo (miembros_det) y el conteo de
-- líneas del último pedido (erp_ult_cnt) — que están acotadas a top_n porque
-- se pensaron para las 25 filas de la pantalla. Medido: 23.004 ms y 10,6 M de
-- buffers, contra un statement_timeout de ~8 s del rol `authenticated`. O sea,
-- el botón fallaba siempre con "canceling statement due to statement timeout".
--
-- Esta función calcula SOLO las columnas que van al archivo (ranking, código,
-- razón social, valor histórico, valor y fecha del último pedido, desglose por
-- año): 740 ms y 52 k buffers. Verificado fila por fila contra la RPC de
-- pantalla: las 531 filas coinciden en las 6 columnas.
--
-- Si se toca la valorización, hay que tocar las DOS: una alimenta la tabla en
-- pantalla y la otra el Excel del mismo módulo, así que si divergen muestran
-- números distintos para el mismo cliente.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_ranking_inactivos_export(p_meses integer DEFAULT 12, p_solo_excluidos boolean DEFAULT false)
 RETURNS TABLE(cod_cliente text, business_name text, last_date date, total_historico numeric, valor_ultimo_pedido numeric, desglose_por_anio jsonb, ranking integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  WITH cutoff AS (
    SELECT to_char(CURRENT_DATE - (p_meses || ' months')::interval, 'YYYY-MM-DD') AS c
  ),
  canon AS (
    SELECT g.cod_cliente AS cod, v.cod_cliente AS canonico
    FROM customer_grupos g
    JOIN customer_grupos v ON v.grupo_id = g.grupo_id AND v.es_vigente
    WHERE g.empresa = 'lk'
  ),
  ult_erp AS (
    SELECT COALESCE(cn.canonico, sl.customer_code)::text AS cod,
           MAX(sl.invoice_date) AS last_txt
    FROM sales_lines sl
    LEFT JOIN canon cn ON cn.cod = sl.customer_code
    WHERE sl.empresa = 'lk' AND sl.customer_code IS NOT NULL
      AND sl.customer_code NOT IN ('1', '3878')
      AND sl.invoice_date IS NOT NULL
      AND sl.item_code <> ALL (ARRAY(SELECT item_code FROM sales_excluded_items))
    GROUP BY 1
  ),
  ult_web AS (
    SELECT COALESCE(cn.canonico, c.cod_cliente::text) AS cod,
           to_char(MAX(o.created_at::date), 'YYYY-MM-DD') AS last_txt
    FROM orders o
    JOIN customers c ON c.id = o.customer_id
    LEFT JOIN canon cn ON cn.cod = c.cod_cliente::text
    WHERE c.cod_cliente IS NOT NULL
      AND c.cod_cliente NOT IN ('1', '3878')
    GROUP BY 1
  ),
  ult AS (
    SELECT cod, MAX(last_txt) AS last_txt
    FROM (SELECT * FROM ult_erp UNION ALL SELECT * FROM ult_web) t
    GROUP BY cod
  ),
  inactivos AS (
    SELECT u.cod, u.last_txt
    FROM ult u CROSS JOIN cutoff
    WHERE u.last_txt < cutoff.c
      AND (p_solo_excluidos OR u.cod NOT IN (SELECT cod_cliente FROM lk_ch_excluidos_cache))
      AND (
        CASE WHEN p_solo_excluidos
          THEN u.cod IN (SELECT cod_cliente FROM ranking_inactivos_excluidos)
          ELSE u.cod NOT IN (SELECT cod_cliente FROM ranking_inactivos_excluidos)
        END
      )
  ),
  nombres AS (
    SELECT i.cod,
           COALESCE(NULLIF(btrim(c.business_name), ''), wn.nombre, '') AS nom
    FROM inactivos i
    LEFT JOIN customers c ON c.cod_cliente::text = i.cod
    LEFT JOIN LATERAL (
      SELECT MIN(btrim(w.nombre)) AS nombre
      FROM "Wpp_Clientes" w
      WHERE w.marca = 'LK' AND w.cod_cli::text = i.cod
        AND btrim(COALESCE(w.nombre, '')) <> ''
      HAVING count(DISTINCT btrim(w.nombre)) = 1
    ) wn ON TRUE
  ),
  miembros AS (
    SELECT i.cod AS canon, i.cod AS raw FROM inactivos i
    UNION
    SELECT i.cod, g.cod_cliente
    FROM inactivos i
    JOIN customer_grupos gv ON gv.cod_cliente = i.cod AND gv.es_vigente
    JOIN customer_grupos g ON g.grupo_id = gv.grupo_id
  ),
  desc_web AS (
    SELECT COALESCE(
             (SELECT s.value FROM app_settings s WHERE s.key = 'web_order_discount'),
             0.02
           )::numeric AS d
  ),
  -- Factor por código CRUDO, no por el vigente: cada razón social valoriza su
  -- historia con su propio dto_vol, igual que en la RPC de pantalla.
  factor AS (
    SELECT DISTINCT m.raw AS cod,
           ((1 - COALESCE(c.dto_vol, 0)) * (1 - dw.d))::numeric AS f
    FROM miembros m
    CROSS JOIN desc_web dw
    LEFT JOIN customers c ON c.cod_cliente::text = m.raw
  ),
  erp_agg AS (
    SELECT m.canon AS cod,
           m.raw,
           substr(sl.invoice_date, 1, 4) AS anio,
           sl.item_code,
           SUM(sl.boxes) AS boxes
    FROM miembros m
    JOIN sales_lines sl ON sl.empresa = 'lk' AND sl.customer_code = m.raw
    WHERE sl.empresa = 'lk' AND sl.invoice_date IS NOT NULL
      AND sl.item_code <> ALL (ARRAY(SELECT item_code FROM sales_excluded_items))
    GROUP BY m.canon, m.raw, substr(sl.invoice_date, 1, 4), sl.item_code
  ),
  por_raw AS (
    SELECT e.cod, e.anio,
           (e.boxes * COALESCE(p.uxb, 0) * COALESCE(p.list_price, 0) * f.f)::numeric AS monto
    FROM erp_agg e
    JOIN products p ON p.cod = e.item_code AND p.active IS TRUE
    JOIN factor f ON f.cod = e.raw

    UNION ALL

    SELECT m.canon,
           to_char(o.created_at, 'YYYY'),
           (oi.cajas * COALESCE(NULLIF(oi.uxb, 0), p.uxb, 0) * COALESCE(p.list_price, 0) * f.f)::numeric
    FROM miembros m
    JOIN factor f ON f.cod = m.raw
    JOIN customers c ON c.cod_cliente::text = m.raw
    JOIN orders o ON o.customer_id = c.id
    JOIN order_items oi ON oi.order_id = o.id
    JOIN products p ON p.id = oi.product_id AND p.active IS TRUE
  ),
  por_anio AS (
    SELECT cod, anio, ROUND(SUM(monto))::numeric AS monto
    FROM por_raw GROUP BY cod, anio
  ),
  tot AS (
    SELECT cod, SUM(monto) AS total FROM por_anio GROUP BY cod
  ),
  ranked AS (
    SELECT i.cod, i.last_txt, COALESCE(t.total, 0)::numeric AS total,
           ROW_NUMBER() OVER (ORDER BY COALESCE(t.total, 0) DESC, i.cod ASC)::int AS pos
    FROM inactivos i
    LEFT JOIN tot t ON t.cod = i.cod
  ),
  -- Valor del último pedido. Sin el conteo de líneas discontinuadas: eso solo
  -- alimenta la aclaración en pantalla y no va al archivo.
  erp_ult AS (
    SELECT r.cod,
           SUM(sl.boxes * COALESCE(p.uxb, 0) * COALESCE(p.list_price, 0) * f.f)::numeric AS monto
    FROM ranked r
    JOIN miembros m ON m.canon = r.cod
    JOIN factor f ON f.cod = m.raw
    JOIN sales_lines sl ON sl.empresa = 'lk' AND sl.customer_code = m.raw
                       AND sl.invoice_date = r.last_txt
    JOIN products p ON p.cod = sl.item_code AND p.active IS TRUE
    WHERE sl.empresa = 'lk' AND sl.item_code <> ALL (ARRAY(SELECT item_code FROM sales_excluded_items))
    GROUP BY r.cod
  ),
  web_ult AS (
    SELECT r.cod,
           SUM(oi.cajas * COALESCE(NULLIF(oi.uxb, 0), p.uxb, 0) * COALESCE(p.list_price, 0) * f.f)::numeric AS monto
    FROM ranked r
    JOIN miembros m ON m.canon = r.cod
    JOIN factor f ON f.cod = m.raw
    JOIN customers c2 ON c2.cod_cliente::text = m.raw
    JOIN orders o ON o.customer_id = c2.id
                 AND to_char(o.created_at::date, 'YYYY-MM-DD') = r.last_txt
    JOIN order_items oi ON oi.order_id = o.id
    JOIN products p ON p.id = oi.product_id AND p.active IS TRUE
    GROUP BY r.cod
  ),
  desg AS (
    SELECT pa.cod, jsonb_object_agg(pa.anio, pa.monto) AS d
    FROM por_anio pa
    WHERE pa.monto > 0
    GROUP BY pa.cod
  )
  SELECT
    r.cod,
    nm.nom,
    to_date(r.last_txt, 'YYYY-MM-DD'),
    ROUND(r.total)::numeric,
    ROUND(COALESCE(eu.monto, 0) + COALESCE(wu.monto, 0))::numeric,
    COALESCE(d.d, '{}'::jsonb),
    r.pos
  FROM ranked r
  JOIN nombres nm ON nm.cod = r.cod
  LEFT JOIN erp_ult eu ON eu.cod = r.cod
  LEFT JOIN web_ult wu ON wu.cod = r.cod
  LEFT JOIN desg d ON d.cod = r.cod
  ORDER BY r.pos;
$function$;

GRANT EXECUTE ON FUNCTION public.get_ranking_inactivos_export(int, boolean) TO authenticated;
