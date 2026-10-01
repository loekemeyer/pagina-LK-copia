-- ROLLBACK de sql/reporte_diario_hoy_chef.sql
-- Definiciones VIVAS de rep_texto_diario y rep_texto_hoy en LK (kwkclwhmoygunqmlegrg), traídas con
-- pg_get_functiondef el 2026-10-01 antes de sumarles Chef (sólo LK). md5 del cuerpo normalizado
-- verificado contra la base: diario 785a2817…, hoy 0b25934f…. Para volver atrás: correr este archivo.

CREATE OR REPLACE FUNCTION public.rep_texto_diario(p_fecha date DEFAULT NULL::date)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  f     date := coalesce(p_fecha, (now() at time zone 'America/Argentina/Buenos_Aires')::date - 1);
  ayer  record;
  mes   record;
  desp  record;
  ppp   jsonb;
  dash  jsonb;
  linea_mes text;
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
  where l.d >= date_trunc('month', f) - interval '1 month';

  linea_mes := '  Mes: ' || rep_plata(mes.actual)
    || case when extract(day from f) >= 5
            then rep_var(mes.actual, nullif(mes.ant_tramo,0)) || ' vs mismo tramo mes ant.'
            else ' (día ' || extract(day from f)::int || ', muy temprano para comparar)' end;

  -- DESPACHADO: sale de Virgilio (ppp_np_feed), que es donde vive lo que
  -- realmente salio. Es el unico numero de plata que existe al dia siguiente.
  -- plata_neto es el neto que calcula Gestion; `plata` (la vieja reconstruccion
  -- de LK) queda de respaldo para los dias que todavia no tienen neto.
  select coalesce(d.nps,0) as nps,
         coalesce(d.plata_neto, d.plata, 0) as plata,
         coalesce(d.cajas_entregadas,0) as cajas, coalesce(d.m3,0) as m3,
         (select coalesce(sum(coalesce(x.plata_neto, x.plata)),0) from rep_despacho_diario x
           where x.fecha >= date_trunc('month', f)::date and x.fecha <= f) as plata_mes
    into desp
  from rep_despacho_diario d where d.fecha = f;

  ppp := rep_ppp();
  select d.data into dash from gv_dash_cache d where d.id = 1;

  return '📊 DIARIO · ' || to_char(f,'DD/MM/YYYY') || E'\n'
    || '━━━━━━━━━━━━━━━━━━' || E'\n\n'
    || '🚚 DESPACHADO (depósito, ayer)' || E'\n'
    || '  ' || rep_plata(coalesce(desp.plata,0))
       || '  ·  ' || coalesce(desp.nps,0) || ' NP  ·  ' || round(coalesce(desp.cajas,0)) || ' cajas' || E'\n'
    || '  Mes a la fecha: ' || rep_plata(coalesce(desp.plata_mes,0)) || E'\n\n'
    || '🛒 PEDIDO (portal, en vivo)' || E'\n'
    || '  Ayer: ' || rep_plata(ayer.monto) || '  ·  ' || ayer.pedidos || ' ped  ·  ' || ayer.clientes || ' cli' || E'\n'
    || linea_mes || E'\n\n'
    || '📦 POR FACTURAR (PPP en curso)' || E'\n'
    || '  ' || rep_plata((ppp->>'plata')::numeric)
       || '  ·  ' || (ppp->>'nps') || ' NP  ·  ' || (ppp->>'m3') || ' m³' || E'\n'
    || '  Ritmo ' || (ppp->>'m3_dia') || ' m³/día → ' || (ppp->>'dias_ppp') || ' días de cola' || E'\n\n'
    || '🧾 FACTURADO (ERP, último mes cerrado)' || E'\n'
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
  f    date := coalesce(p_fecha, (now() at time zone 'America/Argentina/Buenos_Aires')::date);
  hoy  record;
  ref  record;
  dia_nombre text;
  dia_plural text;
  txt  text;
begin
  -- El nombre del día se arma a mano: `to_char(f,'Day')` sale en el locale de la base y devuelve
  -- "Monday". No se toca el lc_time del server por un texto de Telegram.
  -- El plural va aparte porque lunes..viernes son invariables y sólo sábado/domingo llevan -s.
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
