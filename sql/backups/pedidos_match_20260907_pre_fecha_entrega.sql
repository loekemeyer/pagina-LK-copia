-- Backup previo a agregar fecha_entrega al push LK -> Virgilio (2026-09-07).
-- Rollback: correr este archivo tal cual + quitar las columnas de la foreign table:
--   alter foreign table virgilio.lk_pedidos_match
--     drop column fecha_entrega, drop column fecha_entrega_txt;
-- (la tabla real en Virgilio se deja como está: las columnas son nullable y no molestan)

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
    row_number() OVER (PARTITION BY cod_cliente, fecha_pedido, items_string ORDER BY created_at, order_id) AS orden_en_dia
   FROM base
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
     sucursal_entrega, metodo_pago, items_string, match_string, ambiguo, orden_en_dia)
  select empresa, order_id, cod_cliente, status, fecha_pedido, hora_pedido, created_at,
         sucursal_entrega, metodo_pago, items_string, match_string, ambiguo, orden_en_dia
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
       sucursal_entrega, metodo_pago, items_string, match_string, ambiguo, orden_en_dia)
    select empresa, order_id, cod_cliente, status, fecha_pedido, hora_pedido, created_at,
           sucursal_entrega, metodo_pago, items_string, match_string, ambiguo, orden_en_dia
      from public.v_pedidos_match_chef
     where fecha_pedido >= v_corte;
  exception when others then
    raise notice 'sync_pedidos_match_virgilio: Chef salteado (%). ¿Falta "grant select on public.orders to loke_reader" en el proyecto Chef?', sqlerrm;
  end;
end;
$function$;
