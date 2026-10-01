-- rep_texto_diario / rep_texto_hoy — suman CHEF (2026-10-01)
--
-- Proyecto LK (kwkclwhmoygunqmlegrg). Aplicado en produccion el 2026-10-01 desde Claude (MCP).
-- Rollback: sql/backups/rep_diario_hoy_20261001_pre_chef.sql (las versiones sólo LK; md5 del
-- cuerpo normalizado verificado contra la base antes de pisarlas: diario 785a2817…, hoy 0b25934f…).
-- Reemplaza la definición de rep_texto_hoy de sql/reporte_hoy_plata.sql (que queda como historia).
--
-- QUÉ PIDIÓ THOMAS (01/10): que los dos diarios que le llegan al chat de gerencia también traigan
-- Chef, igual que el semanal y el mensual (sql/reporte_semanal_mensual_pedidos_entregas.sql).
--
--   · 📊 DIARIO (cron 29, 08:00 ART lun-sáb), del día anterior:
--       🚚 DESPACHADO: LK, Chef y entre las dos, con el mes a la fecha.
--       🛒 PEDIDO del portal: LK, Chef y entre las dos, con el mes contra el mismo tramo del mes ant.
--       📦 Por facturar y 🧾 facturado ERP siguen siendo sólo LK y lo dicen en el título.
--   · 💰 HOY (cron 36, 20:00 ART lun-sáb), del día en curso:
--       🛒 PEDIDOS del portal: LK, Chef y entre las dos, contra el promedio de los últimos 4 días
--       iguales (4 lunes, 4 martes…), y el mes a la fecha.
--
-- DE DÓNDE SALE CADA NÚMERO
--   · DESPACHADO LK: la foto `rep_despacho_diario` del día anterior, como antes (la recalcula el
--     cron 19 a las 07:00 desde el feed, así que para ayer está fresca).
--   · DESPACHADO CHEF: `ppp_np_feed` (Chef no tiene foto diaria), mismo feed de Gestión.
--   · PEDIDOS CHEF: en vivo por FDW con `chef_ext.orders_total`, en UN viaje por reporte (ver
--     sql/reporte_semanal_mensual_pedidos_entregas.sql: la copia local no tiene el total). Si Chef
--     no contesta, el reporte sale igual con "⚠ no se pudo leer el portal de Chef".
--
-- TRES CAMBIOS CHICOS DE CRITERIO, A PROPÓSITO
--   · DIARIO, "Mes a la fecha" del despachado LK: antes salía de la fila de AYER de la foto, así
--     que un día sin despacho (el lunes, que reporta el domingo) decía "$0" para el mes entero.
--     Ahora el mes se suma aparte y no depende de que ayer haya habido despacho.
--   · DIARIO, "Mes" de pedidos LK: antes sumaba el mes calendario ENTERO de la fecha del reporte,
--     o sea que incluía lo pedido HOY entre las 00:00 y las 08:00 (y, corrido para una fecha vieja,
--     el mes completo). Ahora corta en el día del reporte, igual que Chef.
--   · HOY, "promedio de los últimos 4 <día>": antes promediaba sólo los días que tuvieron pedidos;
--     ahora suma los 4 y divide por 4 (un día sin pedidos cuenta 0). En LK casi no cambia nada
--     (todos los días hábiles tienen pedidos); en Chef, con 1 pedido por día, el criterio viejo
--     daba un promedio inflado.
--
-- CHEQUEO (lectura pura, no manda nada):
--   select rep_texto_diario();
--   select rep_texto_hoy();

CREATE OR REPLACE FUNCTION public.rep_texto_diario(p_fecha date DEFAULT NULL::date)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  f      date := coalesce(p_fecha, (now() at time zone 'America/Argentina/Buenos_Aires')::date - 1);
  m_ini  date := date_trunc('month', coalesce(p_fecha, (now() at time zone 'America/Argentina/Buenos_Aires')::date - 1))::date;
  ayer   record;
  mes    record;
  desp   record;
  dch    record;
  cha    record;
  v_ch   jsonb;
  ppp    jsonb;
  dash   jsonb;
  mes_lk text;
  mes_ch text;
begin
  select coalesce(sum(o.total),0) as monto, count(*) as pedidos,
         count(distinct o.customer_id) as clientes
    into ayer
  from orders o
  where (o.created_at at time zone 'America/Argentina/Buenos_Aires')::date = f;

  select coalesce(sum(o.total) filter (where date_trunc('month', l.d) = date_trunc('month', f)),0) as actual,
         coalesce(sum(o.total) filter (where date_trunc('month', l.d) = date_trunc('month', f) - interval '1 month'
                                         and extract(day from l.d) <= extract(day from f)),0)      as ant_tramo
    into mes
  from orders o
  cross join lateral (select (o.created_at at time zone 'America/Argentina/Buenos_Aires')::date as d) l
  where l.d >= date_trunc('month', f) - interval '1 month' and l.d <= f;

  -- DESPACHADO LK: la foto del dia (plata_neto de Gestion; `plata` vieja de respaldo). El mes se
  -- suma aparte: si ayer no hubo despacho no hay fila, y el mes no puede quedar en $0 por eso.
  select coalesce((select d.nps from rep_despacho_diario d where d.fecha = f),0)                     as nps,
         coalesce((select coalesce(d.plata_neto, d.plata) from rep_despacho_diario d where d.fecha = f),0) as plata,
         coalesce((select d.cajas_entregadas from rep_despacho_diario d where d.fecha = f),0)        as cajas,
         coalesce((select sum(coalesce(x.plata_neto, x.plata)) from rep_despacho_diario x
                    where x.fecha between m_ini and f),0)                                            as plata_mes
    into desp;

  -- DESPACHADO CHEF: del feed de Gestion (Chef no tiene foto diaria).
  select coalesce(sum(neto_facturado) filter (where fecha_salida = f),0) as plata,
         count(*) filter (where fecha_salida = f)                        as nps,
         coalesce(sum(cajas_ent) filter (where fecha_salida = f),0)      as cajas,
         coalesce(sum(neto_facturado),0)                                 as plata_mes
    into dch
  from ppp_np_feed
  where empresa = 'chef' and facturada and fecha_salida between m_ini and f;

  -- PEDIDOS CHEF: en vivo por FDW, en UN viaje (ver cabecera del .sql). Si Chef no contesta,
  -- v_ch queda null y el diario sale igual con el aviso.
  begin
    select coalesce(jsonb_agg(jsonb_build_object(
             'd', (t.created_at at time zone 'America/Argentina/Buenos_Aires')::date,
             'c', t.customer_id, 't', coalesce(t.total, 0))), '[]'::jsonb)
      into v_ch
      from chef_ext.orders_total t
     where t.created_at >= ((m_ini - interval '1 month')::timestamp at time zone 'America/Argentina/Buenos_Aires')
       and t.created_at <  ((f+1)::timestamp at time zone 'America/Argentina/Buenos_Aires');
  exception when others then
    v_ch := null;
  end;

  select coalesce(sum(x.t) filter (where x.d = f),0)                                                   as monto,
         count(*) filter (where x.d = f)                                                               as pedidos,
         count(distinct x.c) filter (where x.d = f)                                                    as clientes,
         coalesce(sum(x.t) filter (where x.d between m_ini and f),0)                                   as actual,
         coalesce(sum(x.t) filter (where date_trunc('month', x.d) = date_trunc('month', f) - interval '1 month'
                                     and extract(day from x.d) <= extract(day from f)),0)              as ant_tramo
    into cha
  from jsonb_to_recordset(coalesce(v_ch, '[]'::jsonb)) as x(d date, c uuid, t numeric);

  mes_lk := '    Mes: ' || rep_plata(mes.actual)
    || case when extract(day from f) >= 5
            then rep_var(mes.actual, nullif(mes.ant_tramo,0)) || ' vs mismo tramo mes ant.'
            else ' (día ' || extract(day from f)::int || ', muy temprano para comparar)' end;
  mes_ch := '    Mes: ' || rep_plata(cha.actual)
    || case when extract(day from f) >= 5
            then rep_var(cha.actual, nullif(cha.ant_tramo,0)) || ' vs mismo tramo mes ant.'
            else '' end;

  ppp := rep_ppp();
  select d.data into dash from gv_dash_cache d where d.id = 1;

  return '📊 DIARIO · ' || to_char(f,'DD/MM/YYYY') || E'\n'
    || '━━━━━━━━━━━━━━━━━━' || E'\n\n'
    || '🚚 DESPACHADO (depósito, ayer)' || E'\n'
    || '  LK: ' || rep_plata(desp.plata)
       || '  ·  ' || desp.nps || ' NP  ·  ' || round(desp.cajas) || ' cajas' || E'\n'
    || '    Mes a la fecha: ' || rep_plata(desp.plata_mes) || E'\n'
    || '  Chef: ' || rep_plata(dch.plata)
       || '  ·  ' || dch.nps || ' NP  ·  ' || round(dch.cajas) || ' cajas' || E'\n'
    || '    Mes a la fecha: ' || rep_plata(dch.plata_mes) || E'\n'
    || '  Entre las dos: ' || rep_plata(desp.plata + dch.plata)
       || '  ·  mes ' || rep_plata(desp.plata_mes + dch.plata_mes) || E'\n\n'
    || '🛒 PEDIDO (portal, en vivo)' || E'\n'
    || '  LK ayer: ' || rep_plata(ayer.monto) || '  ·  ' || ayer.pedidos || ' ped  ·  ' || ayer.clientes || ' cli' || E'\n'
    || mes_lk || E'\n'
    || case when v_ch is null
            then '  Chef: ⚠ no se pudo leer el portal de Chef' || E'\n'
            else '  Chef ayer: ' || rep_plata(cha.monto) || '  ·  ' || cha.pedidos || ' ped  ·  ' || cha.clientes || ' cli' || E'\n'
                 || mes_ch || E'\n'
                 || '  Entre las dos: ayer ' || rep_plata(ayer.monto + cha.monto)
                 || '  ·  mes ' || rep_plata(mes.actual + cha.actual) || E'\n'
       end || E'\n'
    || '📦 POR FACTURAR LK (PPP en curso)' || E'\n'
    || '  ' || rep_plata((ppp->>'plata')::numeric)
       || '  ·  ' || (ppp->>'nps') || ' NP  ·  ' || (ppp->>'m3') || ' m³' || E'\n'
    || '  Ritmo ' || (ppp->>'m3_dia') || ' m³/día → ' || (ppp->>'dias_ppp') || ' días de cola' || E'\n\n'
    || '🧾 FACTURADO LK (ERP, último mes cerrado)' || E'\n'
    || '  ' || coalesce(dash#>>'{resumen,mes}','—') || ': '
       || rep_plata((dash#>>'{resumen,facturado}')::numeric)
       || rep_var((dash#>>'{resumen,facturado}')::numeric, (dash#>>'{resumen,facturado_aa}')::numeric)
       || ' interanual';
end $function$;

CREATE OR REPLACE FUNCTION public.rep_texto_hoy(p_fecha date DEFAULT NULL::date)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  f     date := coalesce(p_fecha, (now() at time zone 'America/Argentina/Buenos_Aires')::date);
  m_ini date := date_trunc('month', coalesce(p_fecha, (now() at time zone 'America/Argentina/Buenos_Aires')::date))::date;
  lk    record;
  ch    record;
  v_ch  jsonb;
  dia_nombre text;
  dia_plural text;
  txt   text;
begin
  -- El nombre del día se arma a mano: `to_char(f,'Day')` sale en el locale de la base y devuelve
  -- "Monday". No se toca el lc_time del server por un texto de Telegram.
  -- El plural va aparte porque lunes..viernes son invariables y sólo sábado/domingo llevan -s.
  dia_nombre := (array['domingo','lunes','martes','miércoles','jueves','viernes','sábado'])
                [extract(dow from f)::int + 1];
  dia_plural := (array['domingos','lunes','martes','miércoles','jueves','viernes','sábados'])
                [extract(dow from f)::int + 1];

  -- El promedio de los 4 dias iguales anteriores cuenta como 0 el dia sin pedidos (suma / 4).
  select coalesce(sum(o.total) filter (where l.d = f),0)                               as monto,
         count(*) filter (where l.d = f)                                               as pedidos,
         count(distinct o.customer_id) filter (where l.d = f)                          as clientes,
         coalesce(sum(o.total) filter (where l.d in (f-7, f-14, f-21, f-28)),0) / 4.0  as prom_dia,
         coalesce(sum(o.total) filter (where l.d between m_ini and f),0)               as mes
    into lk
  from orders o
  cross join lateral (select (o.created_at at time zone 'America/Argentina/Buenos_Aires')::date as d) l
  where l.d between least(f-28, m_ini) and f;

  -- CHEF: en vivo por FDW, en UN viaje (ver sql/reporte_diario_hoy_chef.sql). Si Chef no
  -- contesta, v_ch queda null y el aviso sale igual.
  begin
    select coalesce(jsonb_agg(jsonb_build_object(
             'd', (t.created_at at time zone 'America/Argentina/Buenos_Aires')::date,
             'c', t.customer_id, 't', coalesce(t.total, 0))), '[]'::jsonb)
      into v_ch
      from chef_ext.orders_total t
     where t.created_at >= (least(f-28, m_ini)::timestamp at time zone 'America/Argentina/Buenos_Aires')
       and t.created_at <  ((f+1)::timestamp at time zone 'America/Argentina/Buenos_Aires');
  exception when others then
    v_ch := null;
  end;

  select coalesce(sum(x.t) filter (where x.d = f),0)                               as monto,
         count(*) filter (where x.d = f)                                           as pedidos,
         count(distinct x.c) filter (where x.d = f)                                as clientes,
         coalesce(sum(x.t) filter (where x.d in (f-7, f-14, f-21, f-28)),0) / 4.0  as prom_dia,
         coalesce(sum(x.t) filter (where x.d between m_ini and f),0)               as mes
    into ch
  from jsonb_to_recordset(coalesce(v_ch, '[]'::jsonb)) as x(d date, c uuid, t numeric);

  txt := '💰 HOY · ' || dia_nombre || ' ' || to_char(f,'DD/MM') || E'\n━━━━━━━━━━━━━━━━━━\n\n'
      || '🛒 PEDIDOS DE CLIENTES (portal)' || E'\n'
      || '  LK: ' || rep_plata(lk.monto) || '  ·  ' || lk.pedidos || ' ped  ·  ' || lk.clientes || ' cli' || E'\n'
      || case when lk.prom_dia > 0
              then '   ' || rep_var(lk.monto, lk.prom_dia) || ' vs promedio de los últimos 4 ' || dia_plural || E'\n'
              else '' end
      || '    Mes a la fecha: ' || rep_plata(lk.mes) || E'\n';

  if v_ch is null then
    txt := txt || '  Chef: ⚠ no se pudo leer el portal de Chef';
  else
    txt := txt
      || '  Chef: ' || rep_plata(ch.monto) || '  ·  ' || ch.pedidos || ' ped  ·  ' || ch.clientes || ' cli' || E'\n'
      || case when ch.prom_dia > 0
              then '   ' || rep_var(ch.monto, ch.prom_dia) || ' vs promedio de los últimos 4 ' || dia_plural || E'\n'
              else '' end
      || '    Mes a la fecha: ' || rep_plata(ch.mes) || E'\n'
      || '  Entre las dos: ' || rep_plata(lk.monto + ch.monto) || '  ·  mes ' || rep_plata(lk.mes + ch.mes);
  end if;

  if lk.pedidos = 0 and coalesce(ch.pedidos, 0) = 0 then
    txt := txt || E'\n\n(Sin pedidos cargados en los portales en todo el día.)';
  end if;

  return txt;
end $function$;
