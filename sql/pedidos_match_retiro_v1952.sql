-- =====================================================================================
-- v19.52 (Luis, 2026-09-17) — RETIRA: el día y la franja que eligió el cliente viajan a
--                              Gestión con el pedido. Y el turno del súper, con la HORA.
-- =====================================================================================
--
-- Desde la v17.74 (14/09) el checkout le pide el DÍA (mínimo +3 días hábiles, lun-vie) y
-- la FRANJA a quien marca "Retira", y los guarda en `orders.sheets_payload`
-- (`retiro_fecha` / `retiro_franja`). Hasta hoy Gestión sólo los leía por HTTP contra la
-- REST de LK (vista `gv_pedidos_web_retiro`) para pintar un badge: su BACKEND no los veía,
-- así que ningún pase del armado automático podía programar un Retira.
--
-- Ahora viajan por el mismo camino que todo lo demás — `v_pedidos_match` →
-- `sync_pedidos_match_virgilio()` → `virgilio.lk_pedidos_match`, cron cada 15 min — y del
-- otro lado los lee `gv_web_retiro_pactado` (pase (a4) de `gv_ppp_web_armar_pendientes`).
-- Lado Virgilio: `sql/gv_retira_dia_elegido_v1945.sql` del repo `Gestion-Virgilio`.
--
-- ⚠ LA FECHA NO SE CASTEA CON `::date` CRUDO. `sheets_payload->>'retiro_fecha'` es TEXTO
-- del proveedor/cliente: el 16/09 un `"29/09/2026 14:00"` en `fecha_entrega` tiró
-- `22008 date/time field value out of range` y dejó al cron de Gestión sin leer NINGUNA NP
-- de LK durante dos horas (problema 357). Acá se castea sólo lo que matchea
-- `^\d{4}-\d{2}-\d{2}$`; cualquier otra cosa devuelve NULL, nunca un error.
--
-- ANTES DE CORRER ESTO, del lado Virgilio tienen que existir las 3 columnas nuevas de
-- `public.lk_pedidos_match` y sus GRANT por columna para `lk_ppp_reader`; y acá, las 3
-- columnas en la tabla foránea:
--   alter foreign table virgilio.lk_pedidos_match add column retiro_fecha  date;
--   alter foreign table virgilio.lk_pedidos_match add column retiro_franja text;
--   alter foreign table virgilio.lk_pedidos_match add column hora_entrega  text;
-- =====================================================================================

create or replace view public.v_pedidos_match as
 WITH base AS (
         SELECT o.id AS order_id,
            o.customer_code AS cod_cliente,
            o.status,
            o.created_at,
            o.payment_method AS metodo_pago,
            (o.created_at AT TIME ZONE 'America/Argentina/Buenos_Aires'::text)::date AS fecha_pedido,
            to_char((o.created_at AT TIME ZONE 'America/Argentina/Buenos_Aires'::text), 'HH24:MI:SS'::text) AS hora_pedido,
            NULLIF(o.sheets_payload ->> 'sucursal_entrega'::text, ''::text) AS sucursal_entrega,
            NULLIF(o.sheets_payload ->> 'fecha_entrega'::text, ''::text) AS fecha_entrega_txt,
            NULLIF(btrim(COALESCE(o.sheets_payload ->> 'retiro_fecha'::text, ''::text)), ''::text) AS retiro_fecha_txt,
            NULLIF(btrim(COALESCE(o.sheets_payload ->> 'retiro_franja'::text, ''::text)), ''::text) AS retiro_franja,
            ( SELECT string_agg((t.cod || 'x'::text) ||
                        CASE
                            WHEN t.suma = trunc(t.suma) THEN trunc(t.suma)::bigint::text
                            ELSE t.suma::text
                        END, ','::text ORDER BY t.cod) AS string_agg
                   FROM ( SELECT i.value ->> 'cod_art'::text AS cod,
                            sum((i.value ->> 'cajas'::text)::numeric) AS suma
                           FROM jsonb_array_elements(o.sheets_payload -> 'items'::text) i(value)
                          GROUP BY (i.value ->> 'cod_art'::text)) t) AS items_string
           FROM orders o
          WHERE jsonb_typeof(o.sheets_payload -> 'items'::text) = 'array'::text
        )
 SELECT 'lk'::text AS empresa,
    order_id,
    cod_cliente,
    status,
    fecha_pedido,
    hora_pedido,
    created_at,
    sucursal_entrega,
    metodo_pago,
    items_string,
    (((cod_cliente || '|'::text) || to_char(fecha_pedido::timestamp with time zone, 'YYYY-MM-DD'::text)) || '|'::text) || items_string AS match_string,
    count(*) OVER w > 1 AND min(COALESCE(sucursal_entrega, '~'::text)) OVER w <> max(COALESCE(sucursal_entrega, '~'::text)) OVER w AS ambiguo,
    row_number() OVER (PARTITION BY cod_cliente, fecha_pedido, items_string ORDER BY created_at, order_id) AS orden_en_dia,
    fecha_entrega_txt,
        CASE
            WHEN fecha_entrega_txt ~ '\d{1,2}[/.-]\d{1,2}[/.-]\d{4}'::text THEN to_date(translate("substring"(fecha_entrega_txt, '\d{1,2}[/.-]\d{1,2}[/.-]\d{4}'::text), '.-'::text, '//'::text), 'DD/MM/YYYY'::text)
            ELSE NULL::date
        END AS fecha_entrega,
    -- v19.52: día y franja de RETIRA, elegidos por el cliente en la página.
        CASE
            WHEN retiro_fecha_txt ~ '^\d{4}-\d{2}-\d{2}$'::text THEN retiro_fecha_txt::date
            ELSE NULL::date
        END AS retiro_fecha,
    retiro_franja,
    -- v19.52: la HORA del turno del súper, que hasta hoy sólo viajaba embebida en
    -- fecha_entrega_txt ("29/09/2026 14:00" → "14:00").
    NULLIF("substring"(COALESCE(fecha_entrega_txt, ''::text), '(\d{1,2}:\d{2})'::text), ''::text) AS hora_entrega
   FROM base
  WINDOW w AS (PARTITION BY cod_cliente, fecha_pedido, items_string);

create or replace view public.v_pedidos_match_chef as
 WITH base AS (
         SELECT o.id AS order_id,
            COALESCE(NULLIF(o.sheets_payload ->> 'cod_cliente'::text, ''::text), c.cod_cliente::text) AS cod_cliente,
            o.status,
            o.created_at,
            o.payment_method AS metodo_pago,
            (o.created_at AT TIME ZONE 'America/Argentina/Buenos_Aires'::text)::date AS fecha_pedido,
            to_char((o.created_at AT TIME ZONE 'America/Argentina/Buenos_Aires'::text), 'HH24:MI:SS'::text) AS hora_pedido,
            NULLIF(o.sheets_payload ->> 'sucursal_entrega'::text, ''::text) AS sucursal_entrega,
            NULLIF(btrim(COALESCE(o.sheets_payload ->> 'retiro_fecha'::text, ''::text)), ''::text) AS retiro_fecha_txt,
            NULLIF(btrim(COALESCE(o.sheets_payload ->> 'retiro_franja'::text, ''::text)), ''::text) AS retiro_franja,
            ( SELECT string_agg((t.cod || 'x'::text) ||
                        CASE
                            WHEN t.suma = trunc(t.suma) THEN trunc(t.suma)::bigint::text
                            ELSE t.suma::text
                        END, ','::text ORDER BY t.cod) AS string_agg
                   FROM ( SELECT i.value ->> 'cod_art'::text AS cod,
                            sum((i.value ->> 'cajas'::text)::numeric) AS suma
                           FROM jsonb_array_elements(o.sheets_payload -> 'items'::text) i(value)
                          GROUP BY (i.value ->> 'cod_art'::text)) t) AS items_string
           FROM chef_orders o
             LEFT JOIN chef_customers c ON c.id = o.customer_id
          WHERE jsonb_typeof(o.sheets_payload -> 'items'::text) = 'array'::text
        )
 SELECT 'chef'::text AS empresa,
    order_id,
    cod_cliente,
    status,
    fecha_pedido,
    hora_pedido,
    created_at,
    sucursal_entrega,
    metodo_pago,
    items_string,
    (((cod_cliente || '|'::text) || to_char(fecha_pedido::timestamp with time zone, 'YYYY-MM-DD'::text)) || '|'::text) || items_string AS match_string,
    count(*) OVER w > 1 AND min(COALESCE(sucursal_entrega, '~'::text)) OVER w <> max(COALESCE(sucursal_entrega, '~'::text)) OVER w AS ambiguo,
    row_number() OVER (PARTITION BY cod_cliente, fecha_pedido, items_string ORDER BY created_at, order_id) AS orden_en_dia,
    -- v19.52: mismo día/franja de RETIRA que LK. La página de Chef ya los captura (el
    -- pedido 230 del 16/09 ya trae la clave), sólo que todavía no hubo un Retira desde
    -- que se deployó.
        CASE
            WHEN retiro_fecha_txt ~ '^\d{4}-\d{2}-\d{2}$'::text THEN retiro_fecha_txt::date
            ELSE NULL::date
        END AS retiro_fecha,
    retiro_franja
   FROM base
  WHERE cod_cliente IS NOT NULL
  WINDOW w AS (PARTITION BY cod_cliente, fecha_pedido, items_string);

CREATE OR REPLACE FUNCTION public.sync_pedidos_match_virgilio()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_corte date;
begin
  select coalesce(max(fecha_pedido), date '2000-01-01') - 14
    into v_corte
    from virgilio.lk_pedidos_match
   where empresa = 'lk';

  delete from virgilio.lk_pedidos_match where empresa = 'lk' and fecha_pedido >= v_corte;

  insert into virgilio.lk_pedidos_match
    (empresa, order_id, cod_cliente, status, fecha_pedido, hora_pedido, created_at,
     sucursal_entrega, metodo_pago, items_string, match_string, ambiguo, orden_en_dia,
     fecha_entrega, fecha_entrega_txt, retiro_fecha, retiro_franja, hora_entrega)
  select empresa, order_id, cod_cliente, status, fecha_pedido, hora_pedido, created_at,
         sucursal_entrega, metodo_pago, items_string, match_string, ambiguo, orden_en_dia,
         fecha_entrega, fecha_entrega_txt, retiro_fecha, retiro_franja, hora_entrega
    from public.v_pedidos_match
   where fecha_pedido >= v_corte;

  begin
    select coalesce(max(fecha_pedido), date '2000-01-01') - 14
      into v_corte
      from virgilio.lk_pedidos_match
     where empresa = 'chef';

    delete from virgilio.lk_pedidos_match where empresa = 'chef' and fecha_pedido >= v_corte;

    insert into virgilio.lk_pedidos_match
      (empresa, order_id, cod_cliente, status, fecha_pedido, hora_pedido, created_at,
       sucursal_entrega, metodo_pago, items_string, match_string, ambiguo, orden_en_dia,
       fecha_entrega, fecha_entrega_txt, retiro_fecha, retiro_franja, hora_entrega)
    select empresa, order_id, cod_cliente, status, fecha_pedido, hora_pedido, created_at,
           sucursal_entrega, metodo_pago, items_string, match_string, ambiguo, orden_en_dia,
           null::date, null::text, retiro_fecha, retiro_franja, null::text
      from public.v_pedidos_match_chef
     where fecha_pedido >= v_corte;
  exception when others then
    raise notice 'sync_pedidos_match_virgilio: Chef salteado (%). ¿Falta "grant select on public.orders to loke_reader" en el proyecto Chef?', sqlerrm;
  end;
end;
$function$;

-- MEDIDO el 2026-09-17, después de correr `select public.sync_pedidos_match_virgilio();`
-- (en `lk_pedidos_match` de Virgilio):
--   1483 · Retira            · retiro 2026-09-22 · 9:00 a 12:00
--   1471 · "Convenir en Av. Panamericana" · retiro 2026-09-24 · 9:00 a 12:00
--          (⚠ NO es un bug: esa sucursal tiene zona_expreso = 'Retira' y
--           direccion_entrega = 'Virgilio 2788'. Es un Retira con apodo.)
--   1468 · INC               · fecha_entrega 2026-09-29 · hora_entrega 14:00
--   1466 · Retira            · sin fecha, franja 9:00 a 12:00   ← el bug del front, ver abajo
--   1449 · Retira            · retiro 2026-09-15, sin franja
