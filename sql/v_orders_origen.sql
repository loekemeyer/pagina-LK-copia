-- Vista: v_orders_origen
-- Alimenta el módulo "Origen de Pedidos" (Carga Pedidos -> Origen de Pedidos,
-- admin.js -> cargarOrigenPedidos).
--
-- Clasifica cada pedido web según quién lo cargó, leyendo
-- orders.placed_by_auth_user_id:
--
--   cliente         el propio cliente desde el mayorista
--   vendedor        un usuario vinculado al cliente que no es admin
--   admin           alguien presente en la tabla admins (incluye las cargas
--                   por Cotizador, Excel Krikos, Supercot y OSA, porque esas
--                   herramientas viven en el panel admin)
--   desconocido     el pedido es POSTERIOR al inicio del tracking y aun así
--                   no registró quién lo cargó -> ES UNA ANOMALÍA: alguna vía
--                   de carga dejó de guardar placed_by_auth_user_id
--   previo_tracking el pedido es anterior al tracking. Esperable, no hay nada
--                   que arreglar.
--
-- La columna `herramienta` traduce sheets_payload->>'source' al nombre real
-- del módulo. Hace falta traducir porque las etiquetas guardadas no coinciden
-- con los módulos, y una colisiona:
--
--   'Web'       -> Mayorista web            (script.js)
--   'Cotizador' -> Cotizador                (admin.js)
--   'Krikos'    -> Cotizador Supermercados  (admin-supercot.js, PDF de super)
--   'Excel'     -> Excel Krikos             (admin-excel-krikos.js)  si lo cargó un admin
--   'Excel'     -> Excels Megashops         (vendor-import-excel.js) si lo cargó un vendedor
--
-- La colisión de 'Excel' se desambigua por quién cargó el pedido: el módulo
-- Krikos vive en el panel admin y el de Megashops en el mayorista. En los
-- pedidos previos al tracking no se puede saber, y quedan como "Excel (sin
-- identificar)".
--
-- Se traduce acá y NO se corrigen las etiquetas en el código a propósito:
-- sheets_payload->>'source' también viaja a Google Sheets y cambiarlo
-- alteraría lo que ve el equipo de compras. Además el histórico ya está
-- guardado con las etiquetas viejas, así que la traducción hace falta igual.
--
-- POR QUÉ SE SEPARARON LAS DOS ÚLTIMAS
-- Antes ambas caían en "desconocido", lo que escondía problemas reales: el
-- Cotizador dejó de guardar el origen (se perdió la línea en el commit 58c40a9
-- del 20/7/2026, "Add files via upload") y sus 37 pedidos quedaban mezclados
-- con 882 pedidos viejos, sin forma de notar la diferencia.
--
-- RESPALDO POR auth_user_id
-- submit_order_fast siempre recibe el uid del usuario logueado y lo guarda en
-- orders.auth_user_id. Es el mismo dato que placed_by_auth_user_id: en los 55
-- pedidos donde existen ambos coinciden, sin una sola diferencia. Por eso,
-- cuando placed_by falta, el dato no se perdió: está al lado. La vista cae a
-- auth_user_id y así los 67 que figuraban como "desconocido" quedaron
-- atribuidos (37 del Cotizador a admin —un único usuario, verificado—, 29 de
-- la web a cliente/vendedor y 1 a cliente).
--
-- El respaldo se aplica SOLO a los pedidos posteriores al inicio del tracking.
-- Los anteriores siguen en 'previo_tracking' aunque también tengan
-- auth_user_id: esa categoría existe para no atribuir hacia atrás un período
-- en el que el módulo no existía.
--
-- origen_inferido marca las filas resueltas por el respaldo. Es lo que
-- conserva la alarma: si una vía de carga deja de registrar el origen, el
-- pedido igual queda bien atribuido, pero el contador de inferidos sube y se
-- ve desde el panel. Sin esa marca, una falla como la del Cotizador —un mes
-- sin registrar— volvería a pasar desapercibida.
--
-- PEDIDOS DE PRUEBA
-- `es_prueba` marca los pedidos de los dos clientes internos:
--   3878 Tierra Nativa SA  (181 pedidos)
--   1    Loekemeyer SRL    (121 pedidos)
-- Son los mismos códigos que ya excluyen las RPCs de estadística. Acá NO se
-- excluyen sino que se marcan, para que el panel muestre el total y el
-- desglose al lado: en los primeros meses las pruebas fueron mayoría (febrero
-- 46 de 46, marzo 144 de 204) y sin separarlas el volumen real queda inflado.
--
--
-- LA FECHA DE CORTE
-- 2026-07-15 15:34:07 UTC es el timestamp del primer pedido que efectivamente
-- registró origen en producción. Va como constante y NO como
-- (SELECT min(created_at) FROM orders WHERE placed_by_auth_user_id IS NOT NULL)
-- a propósito: si algún día se rellenan los pedidos viejos con auth_user_id,
-- ese MIN saltaría a febrero y reclasificaría todo el histórico como
-- "desconocido", que es justo lo contrario de lo que se busca.

CREATE OR REPLACE VIEW public.v_orders_origen AS
WITH base AS (
  SELECT o.id AS order_id,
      o.customer_id,
      o.created_at,
      o.placed_by_auth_user_id,
      c.auth_user_id AS customer_auth_user_id,
      o.sheets_payload->>'source' AS source_raw,
      (c.cod_cliente::text IN ('1', '3878')) AS es_prueba,
      -- Quién cargó el pedido: el registro directo, o el respaldo
      COALESCE(o.placed_by_auth_user_id, o.auth_user_id) AS quien,
      (o.placed_by_auth_user_id IS NULL AND o.auth_user_id IS NOT NULL) AS por_respaldo
     FROM orders o
       JOIN customers c ON c.id = o.customer_id
),
clasificado AS (
  SELECT b.*,
      CASE
          WHEN b.quien IS NULL
               AND b.created_at < '2026-07-15 15:34:07+00'::timestamptz
              THEN 'previo_tracking'::text
          WHEN b.placed_by_auth_user_id IS NULL
               AND b.created_at < '2026-07-15 15:34:07+00'::timestamptz
              THEN 'previo_tracking'::text
          WHEN b.quien IS NULL THEN 'desconocido'::text
          WHEN b.quien = b.customer_auth_user_id THEN 'cliente'::text
          WHEN (EXISTS ( SELECT 1
             FROM admins a
            WHERE a.auth_user_id = b.quien)) THEN 'admin'::text
          ELSE 'vendedor'::text
      END AS origen_pedido
  FROM base b
)
SELECT c.order_id,
       c.customer_id,
       c.created_at,
       c.placed_by_auth_user_id,
       c.customer_auth_user_id,
       c.origen_pedido,
       CASE
         WHEN c.source_raw IS NULL          THEN 'Sin registro'
         WHEN c.source_raw = 'Web'          THEN 'Mayorista web'
         WHEN c.source_raw = 'Cotizador'    THEN 'Cotizador'
         WHEN c.source_raw = 'Krikos'       THEN 'Cotizador Supermercados'
         WHEN c.source_raw = 'Excel' AND c.origen_pedido = 'admin'    THEN 'Excel Krikos'
         WHEN c.source_raw = 'Excel' AND c.origen_pedido = 'vendedor' THEN 'Excels Megashops'
         WHEN c.source_raw = 'Excel'        THEN 'Excel (sin identificar)'
         ELSE c.source_raw
       END AS herramienta,
       (c.por_respaldo AND c.origen_pedido NOT IN ('previo_tracking', 'desconocido')) AS origen_inferido,
       c.es_prueba
FROM clasificado c;


-- Resumen que consume el panel: una fila por (origen, herramienta), con el
-- conteo de cuántas se resolvieron por el respaldo y cuántas son de prueba.
-- Reemplaza las N consultas .eq("origen_pedido", k) que hacía el front: con
-- subcategorías serían ~15 round-trips, y encima habría que conocer de
-- antemano la lista de herramientas. Así pide una sola vez y descubre las
-- combinaciones que existen.
-- Las fechas van como texto 'YYYY-MM-DD' (lo que emiten los <input type=date>);
-- NULL = sin límite por ese lado.
DROP FUNCTION IF EXISTS public.get_origen_pedidos_resumen(text, text);

CREATE OR REPLACE FUNCTION public.get_origen_pedidos_resumen(
  p_desde text DEFAULT NULL,
  p_hasta text DEFAULT NULL
)
RETURNS TABLE(
  origen_pedido text,
  herramienta text,
  pedidos bigint,
  inferidos bigint,
  de_prueba bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $function$
  SELECT v.origen_pedido,
         v.herramienta,
         count(*)::bigint AS pedidos,
         count(*) FILTER (WHERE v.origen_inferido)::bigint AS inferidos,
         count(*) FILTER (WHERE v.es_prueba)::bigint AS de_prueba
  FROM v_orders_origen v
  WHERE (p_desde IS NULL OR v.created_at >= (p_desde || ' 00:00:00')::timestamptz)
    AND (p_hasta IS NULL OR v.created_at <= (p_hasta || ' 23:59:59.999')::timestamptz)
  GROUP BY v.origen_pedido, v.herramienta
  ORDER BY v.origen_pedido, count(*) DESC;
$function$;

GRANT EXECUTE ON FUNCTION public.get_origen_pedidos_resumen(text, text) TO authenticated;
