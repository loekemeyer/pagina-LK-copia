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
--   'Web'       -> Mayorista web            (script.js)   si lo cargó cliente/vendedor
--   'Web' admin -> Pedidos Expo             si es del 19-22/8/2026, si no "Sin Cotizador"
--   'Cotizador' -> Cotizador                (admin.js)
--   'Krikos'    -> Cotizador Supermercados  (admin-supercot.js, PDF de super)
--   'Excel' admin -> Sin Cotizador          (plegado, ex "Excel Krikos", decisión Yanina 17/09)
--   'Excel'     -> Excels Megashops         (vendor-import-excel.js) si lo cargó un vendedor
--
-- La colisión de 'Excel' se desambigua por quién cargó el pedido: en los
-- pedidos previos al tracking no se puede saber, y quedan como "Excel (sin
-- identificar)".
--
-- RECLASIFICACIÓN DEL 17/09/2026 (pedido de Yanina): la herramienta ya NO es
-- una traducción pura de 'source'. Cuando un ADMIN carga por el catálogo web
-- ('Web') el pedido se cuenta como "Sin Cotizador" (mismo sentido que el módulo
-- "Pedidos sin cot"), salvo la ventana de la expo comercial (19-22/8/2026), que
-- va a "Pedidos Expo". Y lo que era "Excel Krikos" (admin + 'Excel') también se
-- pliega a "Sin Cotizador". Motivo: en la expo se atendía desde el panel, no es
-- venta web del cliente, y esas cargas de admin no usan cotizador.
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

-- CATEGORIA (col nueva, pedido de Yanina 17/09/2026): es la clasificacion que
-- muestra el panel. Son 6 categorias ACTIVAS —cliente, vendedor, admin, expo,
-- super, sin_cot— mas previo_tracking y desconocido, que quedan visibles pero
-- FUERA del %. El panel calcula el % de cada activa sobre la suma de las 6.
-- expo/super/sin_cot salen de adentro de admin (admin queda solo el Cotizador):
--   expo    <- herramienta 'Pedidos Expo'
--   super   <- herramienta 'Cotizador Supermercados'
--   sin_cot <- herramienta 'Sin Cotizador'
-- previo_tracking y desconocido se chequean PRIMERO en el CASE: un pedido
-- pre-tracking conserva su etiqueta vieja (aunque su herramienta sea, p.ej.,
-- 'Cotizador Supermercados') y NO entra al %.

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
),
etiquetado AS (
  SELECT c.*,
      CASE
         WHEN c.source_raw IS NULL          THEN 'Sin registro'
         -- Expo comercial 19-22/8/2026: se atendio desde el panel entrando por el
         -- catalogo web (origen admin, source 'Web'). No hay marcador propio en
         -- sheets_payload (mode=new/edit, cliente_nuevo vacio), asi que se
         -- identifica por ventana de fecha, igual que el corte de tracking.
         WHEN c.source_raw = 'Web' AND c.origen_pedido = 'admin'
              AND c.created_at >= '2026-08-19 00:00:00-03'::timestamptz
              AND c.created_at <  '2026-08-23 00:00:00-03'::timestamptz THEN 'Pedidos Expo'
         -- Resto de pedidos que un admin carga por el catalogo web = pedido sin
         -- cotizador (mismo significado que el modulo "Pedidos sin cot").
         WHEN c.source_raw = 'Web' AND c.origen_pedido = 'admin'      THEN 'Sin Cotizador'
         WHEN c.source_raw = 'Web'          THEN 'Mayorista web'
         WHEN c.source_raw = 'Cotizador'    THEN 'Cotizador'
         WHEN c.source_raw = 'Krikos'       THEN 'Cotizador Supermercados'
         -- "Excel Krikos" se pliega a "Sin Cotizador" por decision de Yanina (17/09).
         WHEN c.source_raw = 'Excel' AND c.origen_pedido = 'admin'    THEN 'Sin Cotizador'
         WHEN c.source_raw = 'Excel' AND c.origen_pedido = 'vendedor' THEN 'Excels Megashops'
         WHEN c.source_raw = 'Excel'        THEN 'Excel (sin identificar)'
         ELSE c.source_raw
       END AS herramienta,
       (c.por_respaldo AND c.origen_pedido NOT IN ('previo_tracking', 'desconocido')) AS origen_inferido
  FROM clasificado c
)
SELECT e.order_id,
       e.customer_id,
       e.created_at,
       e.placed_by_auth_user_id,
       e.customer_auth_user_id,
       e.origen_pedido,
       e.herramienta,
       e.origen_inferido,
       e.es_prueba,
       CASE
         WHEN e.origen_pedido IN ('previo_tracking','desconocido') THEN e.origen_pedido
         WHEN e.herramienta = 'Pedidos Expo'            THEN 'expo'
         WHEN e.herramienta = 'Cotizador Supermercados' THEN 'super'
         WHEN e.herramienta = 'Sin Cotizador'           THEN 'sin_cot'
         WHEN e.origen_pedido = 'admin'                 THEN 'admin'
         ELSE e.origen_pedido
       END AS categoria
FROM etiquetado e;


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
  categoria text,
  herramienta text,
  pedidos bigint,
  inferidos bigint,
  de_prueba bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $function$
  SELECT v.categoria,
         v.herramienta,
         count(*)::bigint AS pedidos,
         count(*) FILTER (WHERE v.origen_inferido)::bigint AS inferidos,
         count(*) FILTER (WHERE v.es_prueba)::bigint AS de_prueba
  FROM v_orders_origen v
  WHERE (p_desde IS NULL OR v.created_at >= (p_desde || ' 00:00:00')::timestamptz)
    AND (p_hasta IS NULL OR v.created_at <= (p_hasta || ' 23:59:59.999')::timestamptz)
  GROUP BY v.categoria, v.herramienta
  ORDER BY v.categoria, count(*) DESC;
$function$;

GRANT EXECUTE ON FUNCTION public.get_origen_pedidos_resumen(text, text) TO authenticated;


-- Desglose por CLIENTE detrás de una celda del resumen. El panel lo llama al
-- tocar el número de "Pedidos" de una fila (origen x herramienta): devuelve qué
-- clientes componen ese número, con su conteo de pedidos y cuántos se
-- atribuyeron por el respaldo de auth_user_id.
--
-- Resuelve la razón social contra customers.business_name y, si está vacía,
-- contra Wpp_Clientes filtrando marca='LK' (63 códigos figuran con las dos
-- marcas y 62 con razón social distinta: sin el filtro se mezclan empresas).
--
-- Lleva el chequeo de admin ADENTRO (es SECURITY DEFINER y saltea RLS) y el
-- EXECUTE revocado a PUBLIC/anon: es un módulo de admin y anon hereda de PUBLIC.
DROP FUNCTION IF EXISTS public.get_origen_pedidos_clientes(text, text, text, text);

CREATE OR REPLACE FUNCTION public.get_origen_pedidos_clientes(
  p_categoria text,
  p_herramienta text,
  p_desde text DEFAULT NULL,
  p_hasta text DEFAULT NULL
)
RETURNS TABLE(
  cod_cliente text,
  razon_social text,
  pedidos bigint,
  inferidos bigint,
  de_prueba bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $function$
  WITH filtrado AS (
    SELECT v.customer_id,
           c.cod_cliente::text AS cod_cliente,
           COALESCE(NULLIF(btrim(c.business_name), ''), w.nombre, '(sin razón social)') AS razon_social,
           v.origen_inferido,
           v.es_prueba
    FROM v_orders_origen v
    JOIN customers c ON c.id = v.customer_id
    LEFT JOIN "Wpp_Clientes" w ON w.cod_cli = c.cod_cliente AND w.marca = 'LK'
    WHERE v.categoria = p_categoria
      AND v.herramienta = p_herramienta
      AND (p_desde IS NULL OR v.created_at >= (p_desde || ' 00:00:00')::timestamptz)
      AND (p_hasta IS NULL OR v.created_at <= (p_hasta || ' 23:59:59.999')::timestamptz)
      AND EXISTS (SELECT 1 FROM admins a WHERE a.auth_user_id = auth.uid())
  )
  SELECT cod_cliente,
         min(razon_social) AS razon_social,
         count(*)::bigint AS pedidos,
         count(*) FILTER (WHERE origen_inferido)::bigint AS inferidos,
         count(*) FILTER (WHERE es_prueba)::bigint AS de_prueba
  FROM filtrado
  GROUP BY cod_cliente
  ORDER BY count(*) DESC, cod_cliente;
$function$;

REVOKE ALL ON FUNCTION public.get_origen_pedidos_clientes(text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_origen_pedidos_clientes(text, text, text, text) TO authenticated;
