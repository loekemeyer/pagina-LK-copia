-- =============================================================================
-- pedidos_match_virgilio.sql — String identificador de pedido web para cruzar
-- con Producción Virgilio, LK + CHEF, con MÉTODO DE PAGO (2026-08-28)
-- =============================================================================
-- PROBLEMA: Virgilio no tiene la SUCURSAL DE ENTREGA de cada pedido; los
-- portales web sí (sheets_payload.sucursal_entrega). Para cruzar sin número de
-- NP se arma un string determinístico por pedido:
--
--   match_string = cod_cliente | fecha (ART, YYYY-MM-DD) | items
--   items        = cod_art x cajas, ordenado por cod_art, con cajas SUMADAS
--                  por código repetido (ej: "026x1,027x10,315x2")
--
-- Sale de sheets_payload.items (cod_art/cajas) — exactamente lo que viajó al
-- Sheet/ERP — así el mismo string se puede reconstruir desde producción.
--
-- DOS EMPRESAS: los pedidos de LK están acá (orders); los de CHEF viven en el
-- proyecto Supabase de Chef (nkhzocgdpwtgrmwleihr, portal gemelo, misma
-- estructura de orders/sheets_payload) y se leen por el FDW chef_db ya
-- existente. La columna `empresa` ('lk'/'chef') discrimina — las numeraciones
-- de cliente son INDEPENDIENTES (mismo cod = otro cliente) y los order_id
-- también pueden chocar. En producción la empresa se deduce del NP:
-- 9xxxx = lk, 4xxxx = chef.
--
-- ⚠ PASO PENDIENTE DEL LADO CHEF (una sola vez, en su SQL editor):
--    grant select on public.orders to loke_reader;
-- Hasta entonces sync_pedidos_match_virgilio() saltea Chef con un NOTICE y
-- sigue sincronizando LK normalmente.
--
-- COLISIÓN CONOCIDA (la excepción que anticipó el usuario): mismo cliente,
-- mismo día, mismos ítems, DISTINTA sucursal. Histórico LK al 2026-08-28: 977
-- pedidos, 30 grupos de strings repetidos, solo 6 grupos (17 pedidos) con
-- sucursales distintas → flag `ambiguo`. `orden_en_dia` (por hora de alta)
-- permite desempatar si producción conserva el orden.
--
-- TRANSPORTE — LK EMPUJA, Virgilio no tira: se reusa el FDW existente
-- server `virgilio_db` / rol `lk_ppp_reader` (el mismo del espejo PPP), que
-- tiene escritura SOLO sobre la tabla espejo `lk_pedidos_match` de Virgilio.
-- Virgilio consulta su tabla LOCAL: cero FDW en el camino caliente.
-- DDL del lado Virgilio: sql/lk_pedidos_match.sql del repo Produccion-Virgilio.
--
-- Cron: `sync-pedidos-match-virgilio` cada 15 min (ventana móvil de 14 días
-- POR EMPRESA, delete+insert; los pedidos viejos no cambian y la ambigüedad es
-- siempre dentro de un mismo día, así que la ventana nunca deja vieja una fila
-- anterior al corte).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Foreign table a los pedidos web de Chef (server chef_db ya existe)
-- -----------------------------------------------------------------------------
create foreign table if not exists public.chef_orders (
  id             bigint,
  created_at     timestamptz,
  customer_id    uuid,
  status         text,
  sheets_payload jsonb,
  payment_method text
) server chef_db options (schema_name 'public', table_name 'orders');

-- -----------------------------------------------------------------------------
-- Vista fuente LK (revocada de anon/authenticated)
-- -----------------------------------------------------------------------------
drop view if exists public.v_pedidos_match;
create view public.v_pedidos_match as
with base as (
  select o.id                as order_id,
         o.customer_code     as cod_cliente,
         o.status,
         o.created_at,
         (o.created_at at time zone 'America/Argentina/Buenos_Aires')::date as fecha_pedido,
         to_char(o.created_at at time zone 'America/Argentina/Buenos_Aires', 'HH24:MI:SS') as hora_pedido,
         nullif(o.sheets_payload->>'sucursal_entrega','') as sucursal_entrega,
         o.payment_method as metodo_pago,
         (select string_agg(t.cod || 'x' ||
                   (case when t.suma = trunc(t.suma) then trunc(t.suma)::bigint::text else t.suma::text end),
                   ',' order by t.cod)
          from (select i->>'cod_art' as cod, sum((i->>'cajas')::numeric) as suma
                from jsonb_array_elements(o.sheets_payload->'items') i
                group by 1) t) as items_string
  from public.orders o
  where jsonb_typeof(o.sheets_payload->'items') = 'array'
)
select 'lk'::text as empresa,
       order_id,
       cod_cliente,
       status,
       fecha_pedido,
       hora_pedido,
       created_at,
       sucursal_entrega,
       metodo_pago,
       items_string,
       cod_cliente || '|' || to_char(fecha_pedido,'YYYY-MM-DD') || '|' || items_string as match_string,
       count(*) over w > 1
         and min(coalesce(sucursal_entrega,'~')) over w <> max(coalesce(sucursal_entrega,'~')) over w as ambiguo,
       row_number() over (partition by cod_cliente, fecha_pedido, items_string order by created_at, order_id) as orden_en_dia
from base
window w as (partition by cod_cliente, fecha_pedido, items_string);

revoke all on public.v_pedidos_match from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Vista fuente CHEF (misma lógica sobre chef_orders; cod_cliente del payload
-- con fallback al padrón por customer_id)
-- -----------------------------------------------------------------------------
drop view if exists public.v_pedidos_match_chef;
create view public.v_pedidos_match_chef as
with base as (
  select o.id as order_id,
         coalesce(nullif(o.sheets_payload->>'cod_cliente',''), c.cod_cliente::text) as cod_cliente,
         o.status,
         o.created_at,
         (o.created_at at time zone 'America/Argentina/Buenos_Aires')::date as fecha_pedido,
         to_char(o.created_at at time zone 'America/Argentina/Buenos_Aires', 'HH24:MI:SS') as hora_pedido,
         nullif(o.sheets_payload->>'sucursal_entrega','') as sucursal_entrega,
         o.payment_method as metodo_pago,
         (select string_agg(t.cod || 'x' ||
                   (case when t.suma = trunc(t.suma) then trunc(t.suma)::bigint::text else t.suma::text end),
                   ',' order by t.cod)
          from (select i->>'cod_art' as cod, sum((i->>'cajas')::numeric) as suma
                from jsonb_array_elements(o.sheets_payload->'items') i
                group by 1) t) as items_string
  from public.chef_orders o
  left join public.chef_customers c on c.id = o.customer_id
  where jsonb_typeof(o.sheets_payload->'items') = 'array'
)
select 'chef'::text as empresa,
       order_id,
       cod_cliente,
       status,
       fecha_pedido,
       hora_pedido,
       created_at,
       sucursal_entrega,
       metodo_pago,
       items_string,
       cod_cliente || '|' || to_char(fecha_pedido,'YYYY-MM-DD') || '|' || items_string as match_string,
       count(*) over w > 1
         and min(coalesce(sucursal_entrega,'~')) over w <> max(coalesce(sucursal_entrega,'~')) over w as ambiguo,
       row_number() over (partition by cod_cliente, fecha_pedido, items_string order by created_at, order_id) as orden_en_dia
from base
where cod_cliente is not null
window w as (partition by cod_cliente, fecha_pedido, items_string);

revoke all on public.v_pedidos_match_chef from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Foreign table hacia la tabla espejo de Virgilio (server virgilio_db ya existe).
-- Sin `synced_at`: lo pone el default del lado Virgilio.
-- -----------------------------------------------------------------------------
drop foreign table if exists virgilio.lk_pedidos_match;
create foreign table virgilio.lk_pedidos_match (
  empresa          text,
  order_id         bigint,
  cod_cliente      text,
  status           text,
  fecha_pedido     date,
  hora_pedido      text,
  created_at       timestamptz,
  sucursal_entrega text,
  metodo_pago      text,
  items_string     text,
  match_string     text,
  ambiguo          boolean,
  orden_en_dia     bigint
) server virgilio_db options (schema_name 'public', table_name 'lk_pedidos_match');

-- -----------------------------------------------------------------------------
-- Sync (la corre el cron; revocada de anon/authenticated).
-- LK siempre; Chef best-effort: si falta el grant o Chef está caído, NOTICE y
-- sigue — mismo espíritu que sincronizar_chef().
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
$fn$;

revoke execute on function public.sync_pedidos_match_virgilio() from public, anon, authenticated;

-- Cron cada 15 minutos (ya programado)
-- select cron.schedule('sync-pedidos-match-virgilio', '*/15 * * * *',
--                      'select public.sync_pedidos_match_virgilio()');

-- Sync manual:
-- select public.sync_pedidos_match_virgilio();
