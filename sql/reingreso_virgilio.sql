-- =============================================================================
-- reingreso_virgilio.sql — Fecha estimada de entrega (global) + Reingreso de
-- importados (artículos E) desde Gestión Virgilio. (2026-09-09)
-- =============================================================================
-- QUÉ HACE
--   1) El portal muestra en el CARRITO (antes de confirmar) una "Fecha estimada
--      de entrega" global. La setea el dueño en Gestión Virgilio → módulo
--      Importación (Stock_Config['entrega_estimada_global']).
--   2) En el CATÁLOGO, para los importados (cod termina en E) que están SIN STOCK
--      en Virgilio, muestra "Reingreso Est dd/mm". La fecha la carga el dueño a
--      mano en el mismo módulo (Importados.reingreso_est).
--
-- "SIN STOCK" NO es stock=0: es stock < cajas pedidas (falta>0). Los artículos
-- que se arman con partes importadas (94xE, 584E, 522S…) cuentan el stock de
-- parte como stock (disponible = terminado + parte, con parte convertida de
-- UNIDADES a CAJAS dividiendo por uni_x_caja). Toda esa lógica vive en la vista
-- de Virgilio v_lk_reingresos (ver más abajo).
--
-- ARQUITECTURA (nada de FDW en el camino caliente — regla del repo):
--   Virgilio: Importados.reingreso_est + vista v_lk_reingresos + Stock_Config
--             + lk_config_feed()/v_lk_config  →  grants a lk_ppp_reader
--   LK:  foreign tables virgilio.v_lk_reingresos / virgilio.v_lk_config
--        → cron sync_reingresos_virgilio() espeja a reingreso_cache (local)
--          y a app_settings['fecha_estimada_entrega']
--        → RPC get_reingresos() (lee SOLO la tabla local; la llama el portal)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- LADO VIRGILIO (proyecto hrxfctzncixxqmpfhskv) — se corre en SU SQL editor
-- -----------------------------------------------------------------------------
-- alter table public."Importados" add column if not exists reingreso_est date;
--
-- -- vista que consume LK, envuelta en función SECURITY DEFINER porque las vistas
-- -- de stock son security_invoker y lk_ppp_reader no tiene SELECT sobre las bases.
-- create or replace function public.lk_reingresos_feed()
-- returns table(cod text, reingreso_est date, sin_stock boolean)
-- language sql stable security definer set search_path = public as $$
--   with imp as (
--     select gv_cod_stock(cod_art) as cod, max(reingreso_est) as reingreso_est,
--            max(nullif(uni_x_caja,0)) as uxc
--     from public."Importados"
--     where coalesce(activo,true) and reingreso_est is not null
--     group by gv_cod_stock(cod_art)
--   ),
--   parte as (
--     select gv_cod_stock(cod) as cod, sum(coalesce(stock_parte,0)) as stock_parte
--     from public.vista_importados_stock_parte group by gv_cod_stock(cod)
--   )
--   select i.cod, i.reingreso_est,
--          ( coalesce(svp.pedidos_ped,0)
--            > coalesce(svp.stock_total,0)
--              + coalesce(floor(coalesce(pt.stock_parte,0)/nullif(i.uxc,0)),0) ) as sin_stock
--   from imp i
--   left join public.vista_stock_vs_pedidos svp on svp.cod = i.cod
--   left join parte pt on pt.cod = i.cod;
-- $$;
-- revoke all on function public.lk_reingresos_feed() from public;
-- grant execute on function public.lk_reingresos_feed() to lk_ppp_reader;
-- create view public.v_lk_reingresos as select * from public.lk_reingresos_feed();
-- grant select on public.v_lk_reingresos to lk_ppp_reader;
--
-- create or replace function public.lk_config_feed()
-- returns table(clave text, valor text)
-- language sql stable security definer set search_path = public as $$
--   select clave, valor from public."Stock_Config" where clave in ('entrega_estimada_global');
-- $$;
-- revoke all on function public.lk_config_feed() from public;
-- grant execute on function public.lk_config_feed() to lk_ppp_reader;
-- create view public.v_lk_config as select * from public.lk_config_feed();
-- grant select on public.v_lk_config to lk_ppp_reader;
-- (la fecha global se guarda en Stock_Config['entrega_estimada_global']; la
--  escribe el módulo Importación de Virgilio con el upsert on_conflict=clave.)

-- -----------------------------------------------------------------------------
-- LADO LK (proyecto kwkclwhmoygunqmlegrg)
-- -----------------------------------------------------------------------------
create foreign table if not exists virgilio.v_lk_reingresos (
  cod text, reingreso_est date, sin_stock boolean
) server virgilio_db options (schema_name 'public', table_name 'v_lk_reingresos');

create foreign table if not exists virgilio.v_lk_config (
  clave text, valor text
) server virgilio_db options (schema_name 'public', table_name 'v_lk_config');

create table if not exists public.reingreso_cache (
  cod             text primary key,
  sin_stock       boolean not null default false,
  fecha_reingreso date,
  updated_at      timestamptz not null default now()
);
alter table public.reingreso_cache enable row level security;
-- sin policies: solo funciones SECURITY DEFINER la leen; anon queda afuera.

-- Cron espejo (patrón sincronizar_chef): tolera Virgilio caído.
create or replace function public.sync_reingresos_virgilio()
returns void language plpgsql security definer set search_path = public as $$
declare
  v_fecha text;
begin
  delete from public.reingreso_cache where cod is not null;
  insert into public.reingreso_cache (cod, sin_stock, fecha_reingreso)
  select cod, coalesce(sin_stock, false), reingreso_est
  from virgilio.v_lk_reingresos where cod is not null;

  select nullif(btrim(vc.valor), '') into v_fecha
  from virgilio.v_lk_config vc where vc.clave = 'entrega_estimada_global' limit 1;

  if v_fecha is null then
    delete from public.app_settings where key = 'fecha_estimada_entrega';
  else
    insert into public.app_settings (key, value) values ('fecha_estimada_entrega', v_fecha)
    on conflict (key) do update set value = excluded.value;
  end if;
exception when others then
  raise notice 'sync_reingresos_virgilio: Virgilio no disponible (%)', sqlerrm;
end;
$$;
revoke all on function public.sync_reingresos_virgilio() from public;

-- RPC del portal: lee SOLO la tabla local (rápida, cero FDW en vivo).
create or replace function public.get_reingresos()
returns table(cod text, fecha date) language sql stable security definer
set search_path = public as $$
  select cod, fecha_reingreso from public.reingreso_cache
  where sin_stock and fecha_reingreso is not null;
$$;
grant execute on function public.get_reingresos() to anon, authenticated;

-- Cron cada 30 min.
-- select cron.schedule('sync-reingresos-virgilio', '*/30 * * * *',
--                      'select public.sync_reingresos_virgilio();');
