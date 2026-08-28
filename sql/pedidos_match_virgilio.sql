-- =============================================================================
-- pedidos_match_virgilio.sql — String identificador de pedido web para cruzar
-- con Producción Virgilio (2026-08-28)
-- =============================================================================
-- PROBLEMA: Virgilio no tiene la SUCURSAL DE ENTREGA de cada pedido; LK sí
-- (sheets_payload.sucursal_entrega). Para cruzar sin número de NP se arma un
-- string determinístico por pedido:
--
--   match_string = cod_cliente | fecha (ART, YYYY-MM-DD) | items
--   items        = cod_art x cajas, ordenado por cod_art, con cajas SUMADAS
--                  por código repetido (ej: "026x1,027x10,315x2")
--
-- Sale de sheets_payload.items (cod_art/cajas) — exactamente lo que viajó al
-- Sheet/ERP — así el mismo string se puede reconstruir desde producción.
--
-- COLISIÓN CONOCIDA (la excepción que anticipó el usuario): mismo cliente,
-- mismo día, mismos ítems, DISTINTA sucursal. Histórico al 2026-08-28: 977
-- pedidos, 30 grupos de strings repetidos, de los cuales solo 6 grupos
-- (17 pedidos) tienen sucursales distintas → flag `ambiguo`. `orden_en_dia`
-- (por hora de alta) permite desempatar si producción conserva el orden.
--
-- TRANSPORTE — LK EMPUJA, Virgilio no tira: se reusa el FDW existente
-- server `virgilio_db` / rol `lk_ppp_reader` (el mismo del espejo PPP). A ese
-- rol se le dio permiso de escritura SOLO sobre la tabla espejo
-- `lk_pedidos_match` de Virgilio (sigue solo-lectura para todo lo demás).
-- Virgilio consulta su tabla LOCAL: cero FDW en el camino caliente.
-- El DDL del lado Virgilio está en sql/lk_pedidos_match.sql del repo
-- Produccion-Virgilio.
--
-- Cron: `sync-pedidos-match-virgilio` cada 15 min (ventana móvil de 14 días,
-- delete+insert; los pedidos viejos no cambian y la ambigüedad es siempre
-- dentro de un mismo día, así que la ventana nunca deja vieja una fila
-- anterior al corte).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Vista fuente (revocada de anon/authenticated; la lee sync_pedidos_match_virgilio)
-- -----------------------------------------------------------------------------
create or replace view public.v_pedidos_match as
with base as (
  select o.id                as order_id,
         o.customer_code     as cod_cliente,
         o.status,
         o.created_at,
         (o.created_at at time zone 'America/Argentina/Buenos_Aires')::date as fecha_pedido,
         to_char(o.created_at at time zone 'America/Argentina/Buenos_Aires', 'HH24:MI:SS') as hora_pedido,
         nullif(o.sheets_payload->>'sucursal_entrega','') as sucursal_entrega,
         (select string_agg(t.cod || 'x' ||
                   (case when t.suma = trunc(t.suma) then trunc(t.suma)::bigint::text else t.suma::text end),
                   ',' order by t.cod)
          from (select i->>'cod_art' as cod, sum((i->>'cajas')::numeric) as suma
                from jsonb_array_elements(o.sheets_payload->'items') i
                group by 1) t) as items_string
  from public.orders o
  where jsonb_typeof(o.sheets_payload->'items') = 'array'
)
select order_id,
       cod_cliente,
       status,
       fecha_pedido,
       hora_pedido,
       created_at,
       sucursal_entrega,
       items_string,
       cod_cliente || '|' || to_char(fecha_pedido,'YYYY-MM-DD') || '|' || items_string as match_string,
       count(*) over w > 1
         and min(coalesce(sucursal_entrega,'~')) over w <> max(coalesce(sucursal_entrega,'~')) over w as ambiguo,
       row_number() over (partition by cod_cliente, fecha_pedido, items_string order by created_at, order_id) as orden_en_dia
from base
window w as (partition by cod_cliente, fecha_pedido, items_string);

revoke all on public.v_pedidos_match from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Foreign table hacia la tabla espejo de Virgilio (server virgilio_db ya existe).
-- Sin `synced_at`: lo pone el default del lado Virgilio.
-- -----------------------------------------------------------------------------
create foreign table if not exists virgilio.lk_pedidos_match (
  order_id         bigint,
  cod_cliente      text,
  status           text,
  fecha_pedido     date,
  hora_pedido      text,
  created_at       timestamptz,
  sucursal_entrega text,
  items_string     text,
  match_string     text,
  ambiguo          boolean,
  orden_en_dia     bigint
) server virgilio_db options (schema_name 'public', table_name 'lk_pedidos_match');

-- -----------------------------------------------------------------------------
-- Sync (la corre el cron; revocada de anon/authenticated)
-- -----------------------------------------------------------------------------
create or replace function public.sync_pedidos_match_virgilio()
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_corte date;
begin
  select coalesce(max(fecha_pedido), date '2000-01-01') - 14
    into v_corte
    from virgilio.lk_pedidos_match;

  delete from virgilio.lk_pedidos_match where fecha_pedido >= v_corte;

  insert into virgilio.lk_pedidos_match
    (order_id, cod_cliente, status, fecha_pedido, hora_pedido, created_at,
     sucursal_entrega, items_string, match_string, ambiguo, orden_en_dia)
  select order_id, cod_cliente, status, fecha_pedido, hora_pedido, created_at,
         sucursal_entrega, items_string, match_string, ambiguo, orden_en_dia
    from public.v_pedidos_match
   where fecha_pedido >= v_corte;
end;
$fn$;

revoke execute on function public.sync_pedidos_match_virgilio() from public, anon, authenticated;

-- Cron cada 15 minutos
-- select cron.schedule('sync-pedidos-match-virgilio', '*/15 * * * *',
--                      'select public.sync_pedidos_match_virgilio()');

-- Sync manual:
-- select public.sync_pedidos_match_virgilio();
