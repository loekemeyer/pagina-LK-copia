-- =============================================================================
-- reingreso_chef.sql — cartel "Sin stock / hasta dd/mm" para la página de CHEF
-- (Luis, 2026-09-23). APLICADO en LK (kwkclwhmoygunqmlegrg) el 23/09.
-- =============================================================================
-- Chef no tiene FDW a Virgilio y su proyecto está en otra organización, así que
-- va por LK: Virgilio (v_ch_reingresos) → FDW → reingreso_cache_chef (cron 39,
-- sync_reingresos_virgilio) → RPC get_reingresos_chef(), que la página Chef llama
-- con su cliente supabaseLoekemeyer (clave publishable de LK).
-- La lógica (sin stock = disponible <= 0 O pedidos >= disponible, por empresa) vive
-- en Virgilio: Gestion-Virgilio/sql/gv_reingresos_feed_lk_chef.sql.
-- =============================================================================
create foreign table if not exists virgilio.v_ch_reingresos (
  cod text, reingreso_est date, sin_stock boolean
) server virgilio_db options (schema_name 'public', table_name 'v_ch_reingresos');

create table if not exists public.reingreso_cache_chef (
  cod             text primary key,
  sin_stock       boolean not null default false,
  fecha_reingreso date,
  updated_at      timestamptz not null default now()
);
alter table public.reingreso_cache_chef enable row level security;
revoke all on public.reingreso_cache_chef from anon, authenticated;

create or replace function public.sync_reingresos_virgilio()
 returns void language plpgsql security definer set search_path to 'public'
as $function$
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

  -- Chef, en bloque propio: si falla, lo de LK ya quedó escrito.
  begin
    delete from public.reingreso_cache_chef where cod is not null;
    insert into public.reingreso_cache_chef (cod, sin_stock, fecha_reingreso)
    select cod, coalesce(sin_stock, false), reingreso_est
    from virgilio.v_ch_reingresos where cod is not null;
  exception when others then
    raise notice 'sync_reingresos_virgilio (chef): %', sqlerrm;
  end;
exception when others then
  raise notice 'sync_reingresos_virgilio: Virgilio no disponible (%)', sqlerrm;
end;
$function$;

create or replace function public.get_reingresos_chef()
 returns table(cod text, fecha date)
 language sql stable security definer set search_path to 'public'
as $function$
  select cod, fecha_reingreso from public.reingreso_cache_chef where sin_stock;
$function$;
revoke all on function public.get_reingresos_chef() from public;
grant execute on function public.get_reingresos_chef() to anon, authenticated;
