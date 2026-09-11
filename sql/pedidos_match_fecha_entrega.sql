-- ============================================================================
-- Fecha de entrega del súper: LK -> Virgilio  (2026-09-07)
-- ============================================================================
-- Paso 2 de la integración Krikos (docs/PENDIENTES-PIPELINE-GESTION.md del repo
-- Gestión Virgilio). La columna del lado Virgilio ya existe desde el 2026-09-04
-- (`lk_pedidos_match.fecha_entrega` date + `fecha_entrega_txt` text, nullables);
-- lo que faltaba era exponerla en LK y empujarla por el FDW.
--
-- De dónde sale: `orders.sheets_payload->>'fecha_entrega'`, que escribe el
-- cotizador de PDF Krikos (`admin-supercot.js`) con la fecha que el súper exige
-- en el depósito. Es TEXTO `dd/mm/yyyy`, a veces con hora ("15/09/2026 08:00"),
-- así que viajan las dos: el texto crudo y la fecha parseada.
--
-- ⚠ No confundir con `due_date`, que es el VENCIMIENTO de cobro.
--
-- Rollback: `sql/backups/pedidos_match_20260907_pre_fecha_entrega.sql`.
-- ============================================================================

-- 1) La foreign table de LK tiene que declarar las columnas o el insert falla.
alter foreign table virgilio.lk_pedidos_match
  add column if not exists fecha_entrega date,
  add column if not exists fecha_entrega_txt text;

-- 2) La vista las expone (se agregan AL FINAL: `create or replace` exige que las
--    columnas previas no cambien de nombre ni de tipo).
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
    -- Primera fecha dd/mm/yyyy del texto (ignora la hora si vino pegada).
    -- Separador normalizado a '/' para que to_date no dependa de cómo lo mandó
    -- la cadena ("15.09.2026", "15-09-2026").
    CASE
        WHEN fecha_entrega_txt ~ '\d{1,2}[/.-]\d{1,2}[/.-]\d{4}'::text
        THEN to_date(translate(substring(fecha_entrega_txt from '\d{1,2}[/.-]\d{1,2}[/.-]\d{4}'::text), '.-', '//'), 'DD/MM/YYYY'::text)
        ELSE NULL::date
    END AS fecha_entrega
   FROM base
  WINDOW w AS (PARTITION BY cod_cliente, fecha_pedido, items_string);

-- 3) El push las copia. Chef no tiene Krikos (su portal no carga OC de súper),
--    así que va NULL explícito y `v_pedidos_match_chef` queda sin tocar.
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
     fecha_entrega, fecha_entrega_txt)
  select empresa, order_id, cod_cliente, status, fecha_pedido, hora_pedido, created_at,
         sucursal_entrega, metodo_pago, items_string, match_string, ambiguo, orden_en_dia,
         fecha_entrega, fecha_entrega_txt
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
       fecha_entrega, fecha_entrega_txt)
    select empresa, order_id, cod_cliente, status, fecha_pedido, hora_pedido, created_at,
           sucursal_entrega, metodo_pago, items_string, match_string, ambiguo, orden_en_dia,
           null::date, null::text
      from public.v_pedidos_match_chef
     where fecha_pedido >= v_corte;
  exception when others then
    raise notice 'sync_pedidos_match_virgilio: Chef salteado (%). ¿Falta "grant select on public.orders to loke_reader" en el proyecto Chef?', sqlerrm;
  end;
end;
$function$;

-- `v_pedidos_match` sigue revocada de anon/authenticated (no se toca acá: el
-- `create or replace` conserva los privilegios existentes).
