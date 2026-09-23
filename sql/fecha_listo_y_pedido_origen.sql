-- Luis, 23/09/2026. Aplicado en kwkclwhmoygunqmlegrg el mismo día. La definición viva manda.
--
-- 1) "Tu pedido estará listo antes del dd/mm/aa" en la confirmación (LK y Chef):
--    14 días corridos desde el envío; si ese día no es hábil, el próximo hábil.
--    Hábil = criterio de Gestión (gv_es_dia_habil: finde, feriados y días no hábiles del
--    depósito), expuesto en Virgilio como v_lk_dias_habiles y copiado acá por el cron 39
--    (sync_reingresos_virgilio, bloque propio). Sin FDW en el camino de la página.
import foreign schema public limit to (v_lk_dias_habiles) from server virgilio_db into virgilio;
create table if not exists public.dias_habiles_cache (
  fecha date primary key, habil boolean not null, copiado_at timestamptz not null default now());
alter table public.dias_habiles_cache enable row level security;
revoke all on public.dias_habiles_cache from anon, authenticated;

create or replace function public.get_fecha_listo(p_desde date default null)
 returns date language plpgsql stable security definer set search_path to 'public'
as $$
declare
  v_desde date := coalesce(p_desde, (now() at time zone 'America/Argentina/Buenos_Aires')::date);
  v_obj date := v_desde + 14;
  v_res date;
begin
  select min(c.fecha) into v_res from public.dias_habiles_cache c where c.fecha >= v_obj and c.habil;
  if v_res is null or not exists (select 1 from public.dias_habiles_cache c where c.fecha = v_obj) then
    v_res := v_obj;
    while extract(dow from v_res) in (0, 6) loop v_res := v_res + 1; end loop;
  end if;
  return v_res;
end $$;
grant execute on function public.get_fecha_listo(date) to anon, authenticated;
-- Probado: 23/09 → 07/10 · 26/09 → 13/10 (sáb 10, lun 12 feriado) · 11/12 → 28/12 (Navidad).

-- 2) Pedido partido por reingreso: la página crea DOS pedidos; el segundo lleva
--    sheets_payload.pedido_origen. Viaja a Gestión en lk_pedidos_match.pedido_origen
--    (sync_pedidos_match_virgilio, LK y Chef) y la cuarentena los trata como UNO.
alter foreign table virgilio.lk_pedidos_match add column if not exists pedido_origen bigint;
