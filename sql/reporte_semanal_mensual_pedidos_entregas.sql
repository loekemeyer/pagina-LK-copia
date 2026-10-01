-- rep_texto_semanal / rep_texto_mensual — PEDIDOS Y ENTREGAS de LK Y CHEF (2026-10-01)
--
-- Proyecto LK (kwkclwhmoygunqmlegrg). Aplicado en produccion el 2026-10-01 desde Claude (MCP).
-- Rollbacks, de la última versión hacia atrás:
--   · sql/backups/rep_semanal_mensual_20261001_pre_chef.sql            → pedidos y entregas sólo LK
--   · sql/backups/rep_semanal_mensual_20261001_pre_pedidos_entregas.sql → como estaba antes del 01/10
--
-- QUÉ PIDIÓ THOMAS (01/10)
-- ========================
--     "entre las dos actualmente le envian a thomy un reporte de pedidos diario (o de entregas).
--      quiero que ademas se envie un reporte de pedidos Y entregas semanal y mensual"
--     … y después: "Chef también".
--
-- Los dos diarios que ya le llegan al chat de gerencia (6282395816) son sólo de LK:
--   · 📊 DIARIO (cron 29, 08:00 ART lun-sáb) → lo DESPACHADO ayer (entregas)
--   · 💰 HOY    (cron 36, 20:00 ART lun-sáb) → los PEDIDOS del portal del día
--
-- ANTES DE ESCRIBIR SE VERIFICÓ QUÉ YA EXISTÍA
-- ============================================
--   · SEMANAL (cron 30, lunes 08:15 ART): YA traía despachado + pedido + top 5 de LK. Se mandó los
--     lunes 07, 14, 21 y 28/09. No hacía falta un reporte nuevo: se le suma lo que faltaba.
--   · MENSUAL (cron 31, día 3 08:30 ART, reintenta 5/8/12 con dedup por mes): traía FACTURADO
--     del ERP y el despachado del depósito, pero NO los pedidos del portal.
--
-- QUÉ MANDAN AHORA LOS DOS
-- ========================
--   🚚 ENTREGAS: LK, Chef y "entre las dos" — despachado ($ neto de Gestión), variación contra
--      el período anterior, NP, cajas y FALTANTES (cajas pedidas − entregadas de lo que salió).
--   🛒 PEDIDOS del portal: LK, Chef y "entre las dos" — monto, variación, pedidos, clientes (y
--      ticket en el mensual), más el TOP 5 de los dos portales juntos, con "(Chef)" al lado.
--   El resto (por facturar, facturado ERP, acumulado, caídas) sigue siendo sólo LK y lo dice.
--
-- DE DÓNDE SALE CADA NÚMERO, Y POR QUÉ
-- ====================================
--   · ENTREGAS (las dos empresas): `ppp_np_feed` (copia diaria 07:00 del feed de Gestión), NO la
--     foto `rep_despacho_diario`. El neto de Gestión estuvo ~10× abajo desde mediados de agosto
--     hasta el 01/10 a la mañana (sep LK: $42,9 M en la foto contra $419,7 M que hoy devuelve el
--     feed; lo facturado en sales_lines con la cadena completa da $452,2 M; Chef igual: $7,9 M
--     contra $94,2 M). La foto sólo se re-escribe 30 días atrás y con la guarda
--     `np_neto >= anterior`, así que guarda valores viejos; leyendo el feed no hay que tocar ni
--     una fila de historia. La foto queda de respaldo sólo para LK (Chef no tiene foto).
--   · PEDIDOS LK: `orders.total`, por `created_at` en hora ART (mismo corte que el HOY).
--   · PEDIDOS CHEF: el portal de Chef vive en OTRO proyecto (nkhzocgdpwtgrmwleihr). Se lee EN VIVO
--     por FDW, con la foránea nueva `chef_ext.orders_total`, en UN solo viaje por reporte.
--       ✗ `chef_orders_cache` (la copia local) no tiene el total.
--       ✗ `sheets_payload->>'order_total'` falta en los pedidos de Krikos y Cotizador: sep daba
--         $26,6 M contra $63,0 M reales (6 de 29 pedidos sin total, y son los grandes).
--       ✗ Agregarle `total` a `public.chef_orders` toca el sync del armado de Gestión
--         (sincronizar_chef_orders, cada 10 min) y a `gv_clientes_nuevos_calc`, que lee `*`.
--     La foránea va en el schema `chef_ext`, que anon/authenticated no pueden usar: no queda
--     expuesta por la API.
--     ⚠ El FDW a Chef cuesta ~2,4 s por la conexión (otra organización): se paga una vez por
--     reporte, fuera de cualquier pantalla. Si Chef no contesta, el reporte sale IGUAL con la
--     línea "⚠ no se pudo leer el portal de Chef": no se pierde el de LK por eso.
--
-- CRON: no cambia ninguno. Próximo MENSUAL: sábado 03/10 08:30 ART (septiembre). Próximo
-- SEMANAL: lunes 05/10 08:15 ART (28/09 al 04/10).
--
-- CHEQUEO (lectura pura, no manda nada):
--   select rep_texto_semanal(current_date);
--   select rep_texto_mensual();

create foreign table if not exists chef_ext.orders_total (
  id bigint,
  created_at timestamptz,
  customer_id uuid,
  total numeric
) server chef_db options (schema_name 'public', table_name 'orders');
comment on foreign table chef_ext.orders_total is
  'Total de los pedidos del portal de Chef, sólo para los reportes semanal y mensual de Telegram (rep_texto_semanal/mensual). Aislada de public.chef_orders a propósito: no toca el sync del armado. Ver sql/reporte_semanal_mensual_pedidos_entregas.sql (pagina-LK-copia).';
revoke all on chef_ext.orders_total from public, anon, authenticated;

-- Entregas de una empresa en un período y en el período de comparación, del feed de Gestión.
CREATE OR REPLACE FUNCTION public.rep_entregas(p_empresa text, p_ini date, p_fin date, p_ant_ini date, p_ant_fin date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare r record;
begin
  select coalesce(sum(f.neto_facturado) filter (where f.fecha_salida between p_ini and p_fin),0)         as plata,
         count(*) filter (where f.fecha_salida between p_ini and p_fin)                                 as nps,
         coalesce(sum(f.cajas_ent) filter (where f.fecha_salida between p_ini and p_fin),0)              as cajas,
         coalesce(sum(f.cajas_ped) filter (where f.fecha_salida between p_ini and p_fin),0)              as cajas_ped,
         coalesce(sum(f.m3) filter (where f.fecha_salida between p_ini and p_fin),0)                     as m3,
         coalesce(sum(f.neto_facturado) filter (where f.fecha_salida between p_ant_ini and p_ant_fin),0) as plata_ant
    into r
  from ppp_np_feed f
  where f.empresa = p_empresa and f.facturada
    and f.fecha_salida between least(p_ini, p_ant_ini) and greatest(p_fin, p_ant_fin);

  -- La foto diaria sólo existe para LK: respaldo si el feed (amnésico) ya no trae el período.
  if r.nps = 0 and p_empresa = 'lk' then
    select coalesce(sum(coalesce(plata_neto, plata)) filter (where fecha between p_ini and p_fin),0)         as plata,
           coalesce(sum(nps) filter (where fecha between p_ini and p_fin),0)                                  as nps,
           coalesce(sum(cajas_entregadas) filter (where fecha between p_ini and p_fin),0)                     as cajas,
           coalesce(sum(cajas_pedidas) filter (where fecha between p_ini and p_fin),0)                        as cajas_ped,
           coalesce(sum(m3) filter (where fecha between p_ini and p_fin),0)                                   as m3,
           coalesce(sum(coalesce(plata_neto, plata)) filter (where fecha between p_ant_ini and p_ant_fin),0)  as plata_ant
      into r
    from rep_despacho_diario
    where fecha between least(p_ini, p_ant_ini) and greatest(p_fin, p_ant_fin);
  end if;

  return jsonb_build_object('plata', r.plata, 'nps', r.nps, 'cajas', r.cajas,
                            'cajas_ped', r.cajas_ped, 'm3', r.m3, 'plata_ant', r.plata_ant);
end $function$;

-- Dos renglones de entregas de una empresa: plata + variación, y NP · cajas · (m³) · faltantes.
CREATE OR REPLACE FUNCTION public.rep_txt_entregas(p_nombre text, e jsonb, p_cmp text, p_m3 boolean DEFAULT false)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case
    when coalesce((e->>'nps')::int, 0) = 0 then '  ' || p_nombre || ': sin entregas en el período'
    else '  ' || p_nombre || ': ' || rep_plata((e->>'plata')::numeric)
         || rep_var((e->>'plata')::numeric, nullif((e->>'plata_ant')::numeric, 0)) || ' vs ' || p_cmp || E'\n'
         || '    ' || (e->>'nps') || ' NP  ·  ' || round((e->>'cajas')::numeric) || ' cajas'
         || case when p_m3 then '  ·  ' || round((e->>'m3')::numeric, 1) || ' m³' else '' end
         || case
              when (e->>'cajas_ped')::numeric <= 0 then ''
              when (e->>'cajas_ped')::numeric <= (e->>'cajas')::numeric then '  ·  sin faltantes'
              else '  ·  faltó ' || round((e->>'cajas_ped')::numeric - (e->>'cajas')::numeric) || ' cj ('
                   || round(100 * ((e->>'cajas_ped')::numeric - (e->>'cajas')::numeric)
                                / (e->>'cajas_ped')::numeric) || '%)'
            end
  end;
$function$;

-- Dos renglones de pedidos de una empresa: plata + variación, y pedidos · clientes · (ticket).
CREATE OR REPLACE FUNCTION public.rep_txt_pedidos(p_nombre text, p_monto numeric, p_monto_ant numeric, p_pedidos bigint, p_clientes bigint, p_cmp text, p_ticket boolean DEFAULT false)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case
    when coalesce(p_pedidos, 0) = 0 and coalesce(p_monto_ant, 0) = 0 then '  ' || p_nombre || ': sin pedidos'
    else '  ' || p_nombre || ': ' || rep_plata(p_monto) || rep_var(p_monto, nullif(p_monto_ant, 0)) || ' vs ' || p_cmp || E'\n'
         || '    ' || p_pedidos || ' pedidos  ·  ' || p_clientes || ' clientes'
         || case when p_ticket and p_pedidos > 0 then '  ·  ticket ' || rep_plata(p_monto / p_pedidos) else '' end
  end;
$function$;

revoke execute on function public.rep_entregas(text, date, date, date, date) from public, anon, authenticated;
revoke execute on function public.rep_txt_entregas(text, jsonb, text, boolean) from public, anon, authenticated;
revoke execute on function public.rep_txt_pedidos(text, numeric, numeric, bigint, bigint, text, boolean) from public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.rep_texto_semanal(p_fecha date DEFAULT NULL::date)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  hoy  date := coalesce(p_fecha, (now() at time zone 'America/Argentina/Buenos_Aires')::date);
  ini  date := date_trunc('week', hoy)::date - 7;
  fin  date := date_trunc('week', hoy)::date - 1;
  sem  record;
  chs  record;
  v_ch jsonb;
  e_lk jsonb;
  e_ch jsonb;
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

  -- CHEF: el portal de Chef vive en otro proyecto; se lee EN VIVO por FDW, en UN viaje (ver
  -- cabecera de sql/reporte_semanal_mensual_pedidos_entregas.sql). Si no contesta, v_ch queda
  -- null y el reporte sale igual con el aviso.
  begin
    select coalesce(jsonb_agg(jsonb_build_object(
             'd', (t.created_at at time zone 'America/Argentina/Buenos_Aires')::date,
             'c', t.customer_id, 't', coalesce(t.total, 0))), '[]'::jsonb)
      into v_ch
      from chef_ext.orders_total t
     where t.created_at >= ((ini-7)::timestamp at time zone 'America/Argentina/Buenos_Aires')
       and t.created_at <  ((fin+1)::timestamp at time zone 'America/Argentina/Buenos_Aires');
  exception when others then
    v_ch := null;
  end;

  select coalesce(sum(x.t) filter (where x.d between ini and fin),0)      as monto,
         count(*) filter (where x.d between ini and fin)                  as pedidos,
         count(distinct x.c) filter (where x.d between ini and fin)       as clientes,
         coalesce(sum(x.t) filter (where x.d between ini-7 and fin-7),0)  as monto_ant
    into chs
  from jsonb_to_recordset(coalesce(v_ch, '[]'::jsonb)) as x(d date, c uuid, t numeric);

  e_lk := rep_entregas('lk',   ini, fin, ini-7, fin-7);
  e_ch := rep_entregas('chef', ini, fin, ini-7, fin-7);

  -- TOP 5 de los dos portales juntos; los de Chef llevan "(Chef)" al lado.
  select string_agg('  ' || rn || '. ' || cliente || ' — ' || rep_plata(monto), E'\n' order by rn)
    into top
  from (
    select row_number() over (order by monto desc) as rn, cliente, monto
    from (
      select left(coalesce(nullif(btrim(c.business_name),''), 'Cliente '||c.cod_cliente), 26) as cliente,
             sum(o.total) as monto
      from orders o
      join customers c on c.id = o.customer_id
      cross join lateral (select (o.created_at at time zone 'America/Argentina/Buenos_Aires')::date as d) l
      where l.d between ini and fin
      group by c.cod_cliente, c.business_name
      union all
      select left(coalesce(nullif(btrim(cc.business_name),''), 'Cliente '||coalesce(cc.cod_cliente::text,'?')), 21) || ' (Chef)',
             sum(x.t)
      from jsonb_to_recordset(coalesce(v_ch, '[]'::jsonb)) as x(d date, c uuid, t numeric)
      left join chef_customers_cache cc on cc.id = x.c
      where x.d between ini and fin
      group by cc.cod_cliente, cc.business_name
    ) u
  ) z
  where rn <= 5;

  ppp := rep_ppp();

  return '📈 SEMANAL · ' || to_char(ini,'DD/MM') || ' al ' || to_char(fin,'DD/MM/YYYY') || E'\n'
    || '━━━━━━━━━━━━━━━━━━' || E'\n\n'
    || '🚚 ENTREGAS DE LA SEMANA (despachado)' || E'\n'
    || rep_txt_entregas('LK',   e_lk, 'semana previa') || E'\n'
    || rep_txt_entregas('Chef', e_ch, 'semana previa') || E'\n'
    || '  Entre las dos: ' || rep_plata((e_lk->>'plata')::numeric + (e_ch->>'plata')::numeric)
       || rep_var((e_lk->>'plata')::numeric + (e_ch->>'plata')::numeric,
                  nullif((e_lk->>'plata_ant')::numeric + (e_ch->>'plata_ant')::numeric, 0)) || E'\n\n'
    || '🛒 PEDIDOS DE LA SEMANA (portal)' || E'\n'
    || rep_txt_pedidos('LK', sem.monto, sem.monto_ant, sem.pedidos, sem.clientes, 'semana previa') || E'\n'
    || case when v_ch is null
            then '  Chef: ⚠ no se pudo leer el portal de Chef' || E'\n'
            else rep_txt_pedidos('Chef', chs.monto, chs.monto_ant, chs.pedidos, chs.clientes, 'semana previa') || E'\n'
                 || '  Entre las dos: ' || rep_plata(sem.monto + chs.monto)
                 || rep_var(sem.monto + chs.monto, nullif(sem.monto_ant + chs.monto_ant, 0)) || E'\n'
       end || E'\n'
    || '🏆 TOP 5 DE LA SEMANA (pedido)' || E'\n' || coalesce(top,'  (sin pedidos)') || E'\n\n'
    || '📦 POR FACTURAR LK (PPP en curso)' || E'\n'
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
  top    text;
  m_ini  date := (date_trunc('month', (now() at time zone 'America/Argentina/Buenos_Aires')::date) - interval '1 month')::date;
  m_fin  date := (date_trunc('month', (now() at time zone 'America/Argentina/Buenos_Aires')::date) - interval '1 day')::date;
  a_ini  date := (date_trunc('month', (now() at time zone 'America/Argentina/Buenos_Aires')::date) - interval '2 month')::date;
  a_fin  date := (date_trunc('month', (now() at time zone 'America/Argentina/Buenos_Aires')::date) - interval '1 month' - interval '1 day')::date;
  ped    record;
  chs    record;
  v_ch   jsonb;
  e_lk   jsonb;
  e_ch   jsonb;
  ppp    jsonb;
begin
  select x.data, x.generado_at into d, gen from gv_dash_cache x where x.id = 1;
  if d is null then return '⚠ MENSUAL: el cache del dashboard está vacío. Corré gv_dashboard_calcular().'; end if;

  -- PEDIDOS LK del mes cerrado, contra el mes anterior. Mismo corte (created_at en hora ART)
  -- que el HOY y el SEMANAL, asi los tres suman lo mismo.
  select coalesce(sum(o.total) filter (where l.d between m_ini and m_fin),0)      as monto,
         count(*) filter (where l.d between m_ini and m_fin)                      as pedidos,
         count(distinct o.customer_id) filter (where l.d between m_ini and m_fin) as clientes,
         coalesce(sum(o.total) filter (where l.d between a_ini and a_fin),0)      as monto_ant
    into ped
  from orders o
  cross join lateral (select (o.created_at at time zone 'America/Argentina/Buenos_Aires')::date as d) l
  where l.d between a_ini and m_fin;

  -- PEDIDOS CHEF: en vivo por FDW, en UN viaje (ver cabecera del .sql). Si Chef no contesta,
  -- v_ch queda null y el mensual sale igual con el aviso.
  begin
    select coalesce(jsonb_agg(jsonb_build_object(
             'd', (t.created_at at time zone 'America/Argentina/Buenos_Aires')::date,
             'c', t.customer_id, 't', coalesce(t.total, 0))), '[]'::jsonb)
      into v_ch
      from chef_ext.orders_total t
     where t.created_at >= (a_ini::timestamp at time zone 'America/Argentina/Buenos_Aires')
       and t.created_at <  ((m_fin+1)::timestamp at time zone 'America/Argentina/Buenos_Aires');
  exception when others then
    v_ch := null;
  end;

  select coalesce(sum(x.t) filter (where x.d between m_ini and m_fin),0) as monto,
         count(*) filter (where x.d between m_ini and m_fin)             as pedidos,
         count(distinct x.c) filter (where x.d between m_ini and m_fin)  as clientes,
         coalesce(sum(x.t) filter (where x.d between a_ini and a_fin),0) as monto_ant
    into chs
  from jsonb_to_recordset(coalesce(v_ch, '[]'::jsonb)) as x(d date, c uuid, t numeric);

  -- TOP 5 de los dos portales juntos; los de Chef llevan "(Chef)" al lado.
  select string_agg('  ' || rn || '. ' || cliente || ' — ' || rep_plata(monto), E'\n' order by rn)
    into top
  from (
    select row_number() over (order by monto desc) as rn, cliente, monto
    from (
      select left(coalesce(nullif(btrim(c.business_name),''), 'Cliente '||c.cod_cliente), 26) as cliente,
             sum(o.total) as monto
      from orders o
      join customers c on c.id = o.customer_id
      cross join lateral (select (o.created_at at time zone 'America/Argentina/Buenos_Aires')::date as d) l
      where l.d between m_ini and m_fin
      group by c.cod_cliente, c.business_name
      union all
      select left(coalesce(nullif(btrim(cc.business_name),''), 'Cliente '||coalesce(cc.cod_cliente::text,'?')), 21) || ' (Chef)',
             sum(x.t)
      from jsonb_to_recordset(coalesce(v_ch, '[]'::jsonb)) as x(d date, c uuid, t numeric)
      left join chef_customers_cache cc on cc.id = x.c
      where x.d between m_ini and m_fin
      group by cc.cod_cliente, cc.business_name
    ) u
  ) z
  where rn <= 5;

  -- ENTREGAS: del feed de Gestión (ppp_np_feed), no de la foto rep_despacho_diario.
  e_lk := rep_entregas('lk',   m_ini, m_fin, a_ini, a_fin);
  e_ch := rep_entregas('chef', m_ini, m_fin, a_ini, a_fin);

  ppp := rep_ppp();

  t := '📅 MENSUAL · ' || coalesce(d#>>'{resumen,mes}','—') || E'\n'
    || '━━━━━━━━━━━━━━━━━━' || E'\n\n'
    || '🛒 PEDIDOS (portal) · ' || to_char(m_ini,'MM/YYYY') || E'\n'
    || rep_txt_pedidos('LK', ped.monto, ped.monto_ant, ped.pedidos, ped.clientes, 'mes ant.', true) || E'\n'
    || case when v_ch is null
            then '  Chef: ⚠ no se pudo leer el portal de Chef' || E'\n'
            else rep_txt_pedidos('Chef', chs.monto, chs.monto_ant, chs.pedidos, chs.clientes, 'mes ant.', true) || E'\n'
                 || '  Entre las dos: ' || rep_plata(ped.monto + chs.monto)
                 || rep_var(ped.monto + chs.monto, nullif(ped.monto_ant + chs.monto_ant, 0)) || E'\n'
       end
    || '  Top 5:' || E'\n' || coalesce(top,'  (sin pedidos)') || E'\n\n'
    || '🚚 ENTREGAS (despachado) · ' || to_char(m_ini,'MM/YYYY') || E'\n'
    || rep_txt_entregas('LK',   e_lk, 'mes ant.', true) || E'\n'
    || rep_txt_entregas('Chef', e_ch, 'mes ant.', true) || E'\n'
    || '  Entre las dos: ' || rep_plata((e_lk->>'plata')::numeric + (e_ch->>'plata')::numeric)
       || rep_var((e_lk->>'plata')::numeric + (e_ch->>'plata')::numeric,
                  nullif((e_lk->>'plata_ant')::numeric + (e_ch->>'plata_ant')::numeric, 0)) || E'\n'
    || '  Por facturar hoy (LK): ' || rep_plata((ppp->>'plata')::numeric)
       || '  ·  ' || (ppp->>'nps') || ' NP  ·  ' || (ppp->>'m3') || ' m³' || E'\n'
    || '  Ritmo ' || (ppp->>'m3_dia') || ' m³/día → ' || (ppp->>'dias_ppp') || ' días de cola' || E'\n\n'
    || '🧾 FACTURADO LK (ERP)' || E'\n'
    || '  ' || rep_plata((d#>>'{resumen,facturado}')::numeric) || E'\n'
    || '  vs mes ant.: ' || rep_plata((d#>>'{resumen,facturado_ant}')::numeric)
       || rep_var((d#>>'{resumen,facturado}')::numeric, (d#>>'{resumen,facturado_ant}')::numeric) || E'\n'
    || '  vs año ant.: ' || rep_plata((d#>>'{resumen,facturado_aa}')::numeric)
       || rep_var((d#>>'{resumen,facturado}')::numeric, (d#>>'{resumen,facturado_aa}')::numeric) || E'\n'
    || '  ' || coalesce(d#>>'{resumen,pedidos}','—') || ' pedidos  ·  '
       || coalesce(d#>>'{resumen,clientes}','—') || ' clientes' || E'\n'
    || '  Ticket: ' || rep_plata((d#>>'{resumen,ticket}')::numeric)
       || rep_var((d#>>'{resumen,ticket}')::numeric, (d#>>'{resumen,ticket_aa}')::numeric) || ' interanual' || E'\n\n'
    || '📆 ACUMULADO DEL AÑO LK' || E'\n'
    || '  ' || rep_plata((d#>>'{resumen,acum_anio}')::numeric)
       || rep_var((d#>>'{resumen,acum_anio}')::numeric, (d#>>'{resumen,acum_anio_ant}')::numeric)
       || ' vs mismo tramo ' || (extract(year from current_date)-1)::int || E'\n'
    || '  Proyección cierre: ' || rep_plata((d#>>'{proyeccion,proyeccion}')::numeric)
       || ' (cerró ' || rep_plata((d#>>'{proyeccion,total_anio_ant}')::numeric) || ' el año pasado)' || E'\n\n';

  -- Concentracion: cuanto pesan los 10 mas grandes.
  t := t || '🎯 CONCENTRACIÓN LK (12m)' || E'\n'
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

  t := t || '📉 CLIENTES LK QUE ESTÁN COMPRANDO MENOS' || E'\n'
    || '_(últimos 3 meses vs promedio de los 12 previos)_' || E'\n'
    || coalesce(bloque, '  Sin caídas relevantes.') || E'\n\n';

  -- Fuga temprana: todavia no cayeron, pero se estan atrasando.
  t := t || '⏱ FUGA TEMPRANA LK' || E'\n'
    || '  ' || coalesce(d#>>'{fuga,clientes}','0') || ' clientes atrasados respecto de su ritmo' || E'\n\n'
    || '_Datos al ' || to_char(gen at time zone 'America/Argentina/Buenos_Aires','DD/MM HH24:MI') || '._';

  return t;
end $function$;
