-- rep_texto_hoy / rep_enviar_hoy — v14.24 (2026-09-07)
--
-- Proyecto LK (kwkclwhmoygunqmlegrg). Ya aplicado en produccion el 2026-09-07 (cron 36).
-- Se escribio desde la sesion de Gestion Virgilio (de ahi el v14.24 del nombre original);
-- esta es su copia canonica, junto a los demas `rep_*`.
--
-- QUÉ PIDIÓ EL DUEÑO (07/09)
-- ==========================
--     "Necesito que me llegue por Telegram al chat de LK gerencia: ¿cuánta plata llegó hoy de
--      pedidos de clientes? Tiene que ser un aviso diario."
--
-- ANTES DE ESCRIBIR NADA SE VERIFICÓ QUE NO ESTUVIERA YA
-- ======================================================
-- Y en parte estaba: `rep_texto_diario` (cron 29, 08:00 ART, lun-sáb) ya manda al mismo chat
-- un bloque "🛒 PEDIDO (portal, en vivo)" con monto, pedidos y clientes. **Pero es de AYER**,
-- y llega a la mañana siguiente. Lo que faltaba era el número del día en curso, al cierre.
-- Se le ofrecieron las dos opciones al dueño y eligió el mensaje nuevo al cierre del día.
--
-- QUÉ MANDA
-- =========
--     💰 HOY · lunes 07/09
--     ━━━━━━━━━━━━━━━━━━
--
--     🛒 PEDIDOS DE CLIENTES (portal)
--       $4.1 M  ·  4 ped  ·  4 cli
--        ▼81% vs promedio de los últimos 4 lunes
--
--       Mes a la fecha: $58.1 M
--
-- DOS DECISIONES DE DISEÑO
--   · **Se compara contra el mismo día de la semana**, promediando las 4 semanas anteriores.
--     Comparar contra "ayer" mezclaría un lunes con un sábado y el número no diría nada.
--   · **El nombre del día se arma a mano.** `to_char(f,'Day')` sale en el locale de la base y
--     devuelve "Monday"; no se toca el `lc_time` del server por un texto de Telegram. El plural
--     va en su propio array porque lunes..viernes son invariables y sólo sábado/domingo llevan -s.
--
-- Un día sin pedidos igual manda el aviso, con la aclaración: que un día hábil cierre en cero es
-- justamente lo que gerencia quiere ver.
--
-- CRON: jobid 36 `reporte-hoy-plata-telegram`, `0 23 * * 1-6` = **20:00 ART, lunes a sábado**,
-- los mismos días que el reporte diario. Va al chat por defecto de `tg_enqueue` (6282395816),
-- que es donde caen todos los `rep_*`.
--
-- PROBADO DE PUNTA A PUNTA el 07/09: se encoló y salió `sent` a las 23:06 UTC, un intento.
--
-- ROLLBACK
--   select cron.unschedule('reporte-hoy-plata-telegram');
--   drop function if exists public.rep_enviar_hoy();
--   drop function if exists public.rep_texto_hoy(date);

create or replace function public.rep_texto_hoy(p_fecha date default null)
returns text
language plpgsql
stable
security definer
set search_path to 'public','pg_temp'
as $function$
declare
  f    date := coalesce(p_fecha, (now() at time zone 'America/Argentina/Buenos_Aires')::date);
  hoy  record;
  ref  record;
  dia_nombre text;
  dia_plural text;
  txt  text;
begin
  dia_nombre := (array['domingo','lunes','martes','miércoles','jueves','viernes','sábado'])
                [extract(dow from f)::int + 1];
  dia_plural := (array['domingos','lunes','martes','miércoles','jueves','viernes','sábados'])
                [extract(dow from f)::int + 1];

  select coalesce(sum(o.total),0) monto, count(*) pedidos, count(distinct o.customer_id) clientes
    into hoy
    from orders o
   where (o.created_at at time zone 'America/Argentina/Buenos_Aires')::date = f;

  select coalesce(avg(d.monto),0) prom_dia,
         coalesce((select sum(o2.total) from orders o2
                    where (o2.created_at at time zone 'America/Argentina/Buenos_Aires')::date
                          between date_trunc('month', f)::date and f),0) mes
    into ref
    from (
      select (o.created_at at time zone 'America/Argentina/Buenos_Aires')::date d, sum(o.total) monto
        from orders o
       where (o.created_at at time zone 'America/Argentina/Buenos_Aires')::date in (f-7, f-14, f-21, f-28)
       group by 1
    ) d;

  txt := '💰 HOY · ' || dia_nombre || ' ' || to_char(f,'DD/MM') || E'\n━━━━━━━━━━━━━━━━━━\n\n'
      || '🛒 PEDIDOS DE CLIENTES (portal)' || E'\n'
      || '  ' || rep_plata(hoy.monto) || '  ·  ' || hoy.pedidos || ' ped  ·  ' || hoy.clientes || ' cli' || E'\n';

  if ref.prom_dia > 0 then
    txt := txt || '  ' || rep_var(hoy.monto, ref.prom_dia)
                || ' vs promedio de los últimos 4 ' || dia_plural || E'\n';
  end if;

  txt := txt || E'\n  Mes a la fecha: ' || rep_plata(ref.mes);

  if hoy.pedidos = 0 then
    txt := txt || E'\n\n(Sin pedidos cargados en el portal en todo el día.)';
  end if;

  return txt;
end $function$;

create or replace function public.rep_enviar_hoy()
returns void
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $function$
declare f date := (now() at time zone 'America/Argentina/Buenos_Aires')::date;
begin
  perform tg_enqueue(rep_texto_hoy(f), 'hoy_' || to_char(f,'YYYYMMDD'));
end $function$;

select cron.schedule('reporte-hoy-plata-telegram', '0 23 * * 1-6', $$select public.rep_enviar_hoy()$$);
