-- ROLLBACK de sql/reporte_semanal_mensual_pedidos_entregas.sql
-- Definiciones VIVAS de rep_texto_semanal y rep_texto_mensual en LK (kwkclwhmoygunqmlegrg),
-- traidas con pg_get_functiondef el 2026-10-01, antes de agregarles el bloque de pedidos del
-- portal y de pasar el despachado a leer ppp_np_feed. Para volver atras: correr este archivo.

CREATE OR REPLACE FUNCTION public.rep_texto_semanal(p_fecha date DEFAULT NULL::date)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  hoy date := coalesce(p_fecha, (now() at time zone 'America/Argentina/Buenos_Aires')::date);
  ini date := date_trunc('week', hoy)::date - 7;
  fin date := date_trunc('week', hoy)::date - 1;
  sem  record;
  desp record;
  ppp  jsonb;
  top  text;
begin
  select coalesce(sum(o.total) filter (where l.d between ini and fin),0)      as monto,
         count(*) filter (where l.d between ini and fin)                      as pedidos,
         count(distinct o.customer_id) filter (where l.d between ini and fin) as clientes,
         coalesce(sum(o.total) filter (where l.d between ini-7 and fin-7),0)  as monto_ant
    into sem
  from orders o
  cross join lateral (select (o.created_at at time zone 'America/Argentina/Buenos_Aires')::date as d) l
  where l.d between ini-7 and fin;

  -- Neto de Gestion, con la plata vieja de respaldo para los dias sin neto.
  select coalesce(sum(coalesce(plata_neto, plata)) filter (where fecha between ini and fin),0)     as plata,
         coalesce(sum(nps)   filter (where fecha between ini and fin),0)                            as nps,
         coalesce(sum(cajas_entregadas) filter (where fecha between ini and fin),0)                 as cajas,
         coalesce(sum(coalesce(plata_neto, plata)) filter (where fecha between ini-7 and fin-7),0)  as plata_ant
    into desp
  from rep_despacho_diario where fecha between ini-7 and fin;

  select string_agg('  ' || row_number || '. ' || cliente || ' — ' || plata, E'\n' order by row_number)
    into top
  from (
    select row_number() over (order by sum(o.total) desc) as row_number,
           left(coalesce(nullif(btrim(c.business_name),''), 'Cliente '||c.cod_cliente), 26) as cliente,
           rep_plata(sum(o.total)) as plata
    from orders o
    join customers c on c.id = o.customer_id
    cross join lateral (select (o.created_at at time zone 'America/Argentina/Buenos_Aires')::date as d) l
    where l.d between ini and fin
    group by c.cod_cliente, c.business_name
    order by sum(o.total) desc limit 5
  ) x;

  ppp := rep_ppp();

  return '📈 SEMANAL · ' || to_char(ini,'DD/MM') || ' al ' || to_char(fin,'DD/MM/YYYY') || E'\n'
    || '━━━━━━━━━━━━━━━━━━' || E'\n\n'
    || '🚚 DESPACHADO EN LA SEMANA' || E'\n'
    || '  ' || rep_plata(desp.plata) || rep_var(desp.plata, nullif(desp.plata_ant,0)) || ' vs semana previa' || E'\n'
    || '  ' || desp.nps || ' NP  ·  ' || round(desp.cajas) || ' cajas' || E'\n\n'
    || '🛒 PEDIDO EN LA SEMANA' || E'\n'
    || '  ' || rep_plata(sem.monto) || rep_var(sem.monto, nullif(sem.monto_ant,0)) || ' vs semana previa' || E'\n'
    || '  ' || sem.pedidos || ' pedidos  ·  ' || sem.clientes || ' clientes' || E'\n\n'
    || '🏆 TOP 5 DE LA SEMANA (pedido)' || E'\n' || coalesce(top,'  (sin pedidos)') || E'\n\n'
    || '📦 POR FACTURAR (PPP en curso)' || E'\n'
    || '  ' || rep_plata((ppp->>'plata')::numeric)
       || '  ·  ' || (ppp->>'nps') || ' NP  ·  ' || (ppp->>'m3') || ' m³' || E'\n'
    || '  Ritmo ' || (ppp->>'m3_dia') || ' m³/día → ' || (ppp->>'dias_ppp') || ' días de cola';
end $function$;

CREATE OR REPLACE FUNCTION public.rep_texto_mensual()
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  d      jsonb;
  gen    timestamptz;
  t      text;
  bloque text;
  hoy    date := (now() at time zone 'America/Argentina/Buenos_Aires')::date;
  m_ini  date := (date_trunc('month', (now() at time zone 'America/Argentina/Buenos_Aires')::date) - interval '1 month')::date;
  m_fin  date := (date_trunc('month', (now() at time zone 'America/Argentina/Buenos_Aires')::date) - interval '1 day')::date;
  desp   record;
  ppp    jsonb;
begin
  select x.data, x.generado_at into d, gen from gv_dash_cache x where x.id = 1;
  if d is null then return '⚠ MENSUAL: el cache del dashboard está vacío. Corré gv_dashboard_calcular().'; end if;

  t := '📅 MENSUAL · ' || coalesce(d#>>'{resumen,mes}','—') || E'\n'
    || '━━━━━━━━━━━━━━━━━━' || E'\n\n'
    || '🧾 FACTURADO (ERP)' || E'\n'
    || '  ' || rep_plata((d#>>'{resumen,facturado}')::numeric) || E'\n'
    || '  vs mes ant.: ' || rep_plata((d#>>'{resumen,facturado_ant}')::numeric)
       || rep_var((d#>>'{resumen,facturado}')::numeric, (d#>>'{resumen,facturado_ant}')::numeric) || E'\n'
    || '  vs año ant.: ' || rep_plata((d#>>'{resumen,facturado_aa}')::numeric)
       || rep_var((d#>>'{resumen,facturado}')::numeric, (d#>>'{resumen,facturado_aa}')::numeric) || E'\n'
    || '  ' || coalesce(d#>>'{resumen,pedidos}','—') || ' pedidos  ·  '
       || coalesce(d#>>'{resumen,clientes}','—') || ' clientes' || E'\n'
    || '  Ticket: ' || rep_plata((d#>>'{resumen,ticket}')::numeric)
       || rep_var((d#>>'{resumen,ticket}')::numeric, (d#>>'{resumen,ticket_aa}')::numeric) || ' interanual' || E'\n\n'
    || '📆 ACUMULADO DEL AÑO' || E'\n'
    || '  ' || rep_plata((d#>>'{resumen,acum_anio}')::numeric)
       || rep_var((d#>>'{resumen,acum_anio}')::numeric, (d#>>'{resumen,acum_anio_ant}')::numeric)
       || ' vs mismo tramo ' || (extract(year from current_date)-1)::int || E'\n'
    || '  Proyección cierre: ' || rep_plata((d#>>'{proyeccion,proyeccion}')::numeric)
       || ' (cerró ' || rep_plata((d#>>'{proyeccion,total_anio_ant}')::numeric) || ' el año pasado)' || E'\n\n';

  -- DEPOSITO: lo que salio de verdad y lo que queda por salir. La plata de lo
  -- despachado es el neto que calcula Gestion Virgilio sobre las cajas
  -- ENTREGADAS; la del pendiente es la PPP en curso valorizada.
  select coalesce(sum(coalesce(plata_neto, plata)),0) as plata,
         coalesce(sum(nps),0)                          as nps,
         coalesce(sum(cajas_entregadas),0)             as cajas,
         coalesce(sum(m3),0)                           as m3,
         count(*)                                      as dias
    into desp
  from rep_despacho_diario where fecha between m_ini and m_fin;

  ppp := rep_ppp();

  t := t || '🚚 DEPÓSITO · ' || to_char(m_ini,'MM/YYYY') || E'\n'
    || '  Despachado: ' || rep_plata(desp.plata)
       || '  ·  ' || desp.nps || ' NP  ·  ' || round(desp.cajas) || ' cajas  ·  '
       || round(desp.m3::numeric,1) || ' m³' || E'\n'
    || case when desp.dias = 0
            then '  ⚠ Sin datos de despacho para ese mes.' || E'\n' else '' end
    || '  Por facturar hoy: ' || rep_plata((ppp->>'plata')::numeric)
       || '  ·  ' || (ppp->>'nps') || ' NP  ·  ' || (ppp->>'m3') || ' m³' || E'\n'
    || '  Ritmo ' || (ppp->>'m3_dia') || ' m³/día → ' || (ppp->>'dias_ppp') || ' días de cola' || E'\n\n';

  -- Concentracion: cuanto pesan los 10 mas grandes.
  t := t || '🎯 CONCENTRACIÓN (12m)' || E'\n'
    || '  Top 10 = ' || round(100*(d#>>'{concentracion,top10}')::numeric
                              / nullif((d#>>'{concentracion,total}')::numeric,0)) || '% de la venta'
    || '  ·  Top 20 = ' || round(100*(d#>>'{concentracion,top20}')::numeric
                              / nullif((d#>>'{concentracion,total}')::numeric,0)) || '%' || E'\n\n';

  -- CAIDAS: el caso Coto. Es el bloque que motivo el reporte.
  select string_agg(
           '  ⚠️ ' || left(cliente,28) || ' (' || cod || ')' || E'\n'
           || '     ' || cj_rec || ' cj/mes vs ' || cj_base || ' hist. → −' || caida_pct || '%' || E'\n'
           || '     ~' || un_rec || ' u/mes vs ~' || un_base || '  ·  ' || arts_rec || ' arts vs ' || arts_base || E'\n'
           || '     última compra ' || coalesce(ult_compra,'—'),
           E'\n' order by (cj_base - cj_rec) desc)
    into bloque
  from public.rep_caidas(6);

  t := t || '📉 CLIENTES QUE ESTÁN COMPRANDO MENOS' || E'\n'
    || '_(últimos 3 meses vs promedio de los 12 previos)_' || E'\n'
    || coalesce(bloque, '  Sin caídas relevantes.') || E'\n\n';

  -- Fuga temprana: todavia no cayeron, pero se estan atrasando.
  t := t || '⏱ FUGA TEMPRANA' || E'\n'
    || '  ' || coalesce(d#>>'{fuga,clientes}','0') || ' clientes atrasados respecto de su ritmo' || E'\n\n'
    || '_Datos al ' || to_char(gen at time zone 'America/Argentina/Buenos_Aires','DD/MM HH24:MI') || '._';

  return t;
end $function$;
