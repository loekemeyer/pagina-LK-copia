-- ============================================================================
-- REPORTES DE GERENCIA POR TELEGRAM  (proyecto Supabase LK kwkclwhmoygunqmlegrg)
-- ============================================================================
-- Desplegado 2026-09-03. La fuente de verdad es la BASE; este archivo se corre
-- a mano en el SQL editor. Para volcar la definicion real:
--   select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n
--     on n.oid = p.pronamespace where n.nspname='public' and p.proname='<nombre>';
--
-- QUE MANDA Y DE DONDE SALE
--   Diario   (L-S 08:00 ART) -> pedido del portal (`orders`, EN VIVO) + backlog PPP.
--   Semanal  (Lun 08:15 ART) -> misma fuente, agregada por semana + top 5 clientes.
--   Mensual  (dias 3/5/8/12) -> facturado real del ERP (`sales_lines`) via gv_dash_cache
--                               + alerta de clientes que compran menos.
--
-- POR QUE EL DIARIO NO MIDE FACTURACION REAL
--   `sales_lines` se carga POR LOTE MENSUAL y a mano (un `import_batch` por mes,
--   subido a principios del mes siguiente). Tiene fecha diaria adentro, pero la
--   facturacion de hoy no existe en la base hasta el mes que viene. Un diario de
--   facturacion en vivo es imposible sin cambiar la cadencia de carga.
--   Lo que SI esta en vivo es `orders` (portal) y el backlog PPP.
--
-- TRANSPORTE
--   Patron `telegram_outbox` portado de Produccion Virgilio: pg_net + pg_cron +
--   Vault, sin Edge Function y sin n8n. `sendMessage` es un POST JSON y pg_net
--   ya estaba instalado. Bot: @Lk_gerencia_bot. Token en Vault (`telegram_bot_token`).
--   El chat_id NO es secreto y va como DEFAULT de tg_enqueue.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. TRANSPORTE
-- ---------------------------------------------------------------------------

create table if not exists public.telegram_outbox (
  id           bigserial primary key,
  chat_id      text        not null,
  text         text        not null,
  parse_mode   text,
  status       text        not null default 'pending',
  req_id       bigint,
  attempts     int         not null default 0,
  dedup_key    text unique,
  created_at   timestamptz not null default now(),
  last_attempt timestamptz,
  sent_at      timestamptz
);

create index if not exists telegram_outbox_pend_idx
  on public.telegram_outbox (id) where status = 'pending';

alter table public.telegram_outbox enable row level security;
revoke all on table public.telegram_outbox from public, anon, authenticated;


-- Encola un mensaje. Es la unica API que usan los reportes.
-- p_chat por defecto = chat privado de gerencia (no es secreto).
create or replace function public.tg_enqueue(
  p_text       text,
  p_dedup      text default null,
  p_chat       text default '6282395816',
  p_parse_mode text default null
) returns void
language sql
security definer
set search_path to 'public','pg_temp'
as $$
  insert into public.telegram_outbox (chat_id, text, dedup_key, parse_mode)
  values (p_chat, p_text, p_dedup, p_parse_mode)
  on conflict (dedup_key) do nothing;
$$;


-- Telegram corta en 4096 chars y tg_enqueue NO parte mensajes: un texto mas
-- largo entra a la tabla sin quejarse, Telegram lo rechaza con 400 y el flush lo
-- reintenta 60 veces antes de marcarlo failed. Este wrapper parte por LINEAS y
-- encola N mensajes numerados, con el dedup sufijado para seguir siendo idempotente.
create or replace function public.tg_enqueue_largo(
  p_text       text,
  p_dedup      text default null,
  p_chat       text default '6282395816',
  p_parse_mode text default null,
  p_limite     int  default 3900
) returns int
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $$
declare
  linea  text;
  buf    text := '';
  n      int  := 0;
  partes text[] := '{}';
begin
  foreach linea in array string_to_array(p_text, E'\n') loop
    -- una linea sola mas larga que el limite: se manda cortada, no se pierde
    if length(linea) > p_limite then
      if buf <> '' then partes := partes || buf; buf := ''; end if;
      while length(linea) > p_limite loop
        partes := partes || left(linea, p_limite);
        linea  := substr(linea, p_limite + 1);
      end loop;
    end if;
    if length(buf) + length(linea) + 1 > p_limite then
      partes := partes || buf;
      buf := linea;
    else
      buf := case when buf = '' then linea else buf || E'\n' || linea end;
    end if;
  end loop;
  if buf <> '' then partes := partes || buf; end if;

  for n in 1 .. coalesce(array_length(partes,1), 0) loop
    perform public.tg_enqueue(
      case when array_length(partes,1) > 1
           then partes[n] || E'\n\n(' || n || '/' || array_length(partes,1) || ')'
           else partes[n] end,
      case when p_dedup is null then null else p_dedup || '_' || n end,
      p_chat, p_parse_mode);
  end loop;

  return coalesce(array_length(partes,1), 0);
end $$;


-- El motor. Cada rama es una cicatriz de produccion heredada de Virgilio.
create or replace function public.tg_outbox_flush()
returns void
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $$
declare
  bot_token    text;
  max_attempts int := 60;
  r    record;
  resp record;
  v_hora_ar int;
begin
  select decrypted_secret into bot_token
    from vault.decrypted_secrets where name = 'telegram_bot_token' limit 1;

  -- 1) Resolver lo que ya salio y espera respuesta.
  for r in select * from public.telegram_outbox where status = 'pending' and req_id is not null loop
    select status_code, timed_out, error_msg into resp
      from net._http_response where id = r.req_id;

    if found then
      if resp.status_code = 200 then
        update public.telegram_outbox set status='sent', sent_at=now() where id = r.id;

      elsif coalesce(resp.timed_out, false) then
        -- pg_net marca timeout aunque Telegram SI entrego el mensaje. Reintentar
        -- duplicaba el aviso (en Virgilio se vieron 20+ envios del mismo).
        -- Se da por ENVIADO a proposito.
        update public.telegram_outbox set status='sent', sent_at=now() where id = r.id;

      else
        -- error HTTP real (4xx/5xx) o de conexion: reintentar.
        update public.telegram_outbox
           set req_id = null,
               status = case when r.attempts >= max_attempts then 'failed' else 'pending' end
         where id = r.id;
      end if;

    elsif r.last_attempt is null or r.last_attempt < now() - interval '2 minutes' then
      -- la respuesta ya no esta en el rolling window de net._http_response y pasaron
      -- >2 min: lo mas probable es que se entrego. Darlo por enviado en vez de duplicar.
      update public.telegram_outbox set status='sent', sent_at=now() where id = r.id;
    end if;
  end loop;

  if bot_token is null or bot_token = '' then return; end if;

  -- 2) Horario silencioso: solo manda 07:00-21:59 AR.
  v_hora_ar := extract(hour from (now() at time zone 'America/Argentina/Buenos_Aires'))::int;
  if v_hora_ar between 7 and 21 then
    for r in
      select * from public.telegram_outbox
       where status = 'pending' and req_id is null and attempts < max_attempts
       order by id limit 20 for update skip locked
    loop
      update public.telegram_outbox
         set req_id = (select net.http_post(
                         url := 'https://api.telegram.org/bot' || bot_token || '/sendMessage',
                         headers := '{"Content-Type":"application/json"}'::jsonb,
                         body := jsonb_build_object('chat_id', r.chat_id, 'text', r.text)
                                 || (case when coalesce(r.parse_mode,'') <> ''
                                          then jsonb_build_object('parse_mode', r.parse_mode)
                                          else '{}'::jsonb end),
                         timeout_milliseconds := 30000)),
             attempts     = r.attempts + 1,
             last_attempt = now()
       where id = r.id;
    end loop;
  end if;
end $$;

-- OBLIGATORIO: la anon key de LK es publica (va embebida en los .js servidos por
-- GitHub Pages) y estas funciones son SECURITY DEFINER. Sin el revoke, cualquiera
-- con la anon key puede inyectar mensajes al Telegram de gerencia.
revoke all on function public.tg_enqueue(text,text,text,text)           from public, anon, authenticated;
revoke all on function public.tg_enqueue_largo(text,text,text,text,int) from public, anon, authenticated;
revoke all on function public.tg_outbox_flush()                         from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 2. HELPERS DE FORMATO
-- ---------------------------------------------------------------------------

create or replace function public.rep_plata(p numeric)
returns text language sql immutable as $$
  select case
    when p is null then '—'
    when abs(p) >= 1000000000 then '$' || to_char(p/1000000000, 'FM999G990D0') || ' MM'
    when abs(p) >= 1000000    then '$' || to_char(p/1000000,    'FM999G990D0') || ' M'
    when abs(p) >= 1000       then '$' || to_char(p/1000,       'FM999G990')   || ' k'
    else '$' || to_char(p, 'FM999G990')
  end;
$$;

create or replace function public.rep_var(p_actual numeric, p_base numeric)
returns text language sql immutable as $$
  select case
    when p_base is null or p_base = 0 then ''
    else ' ' || case when p_actual >= p_base then '▲' else '▼' end
         || to_char(abs(round(100*(p_actual-p_base)/p_base)), 'FM990') || '%'
  end;
$$;


-- ---------------------------------------------------------------------------
-- 3. BACKLOG PPP (lo que esta adentro y todavia no facturo)
-- ---------------------------------------------------------------------------
-- Mismo universo y misma valorizacion que gv_ppp_resumen(), pero sin el guard
-- estricto de admin, para que lo pueda llamar el cron.

create or replace function public.rep_ppp()
returns jsonb language sql stable security definer
set search_path to 'public','pg_temp'
as $$
  with backlog as (
    select pr.np, pr.cod, pr.m3
    from ppp_programacion pr
    where pr.empresa = 'lk'
      and not exists (select 1 from ppp_facturacion f where f.np = pr.np)
  ),
  ritmo as (
    select sum(m3) / nullif(count(distinct fecha_salida),0) as m3_dia
    from ppp_facturacion
    where left(np,1)='9' and fecha_salida >= current_date - 60 and m3 > 0
  ),
  plata as (
    select sum(ppp_valor_linea(bk.cod, b.articulo, b.cajas)) as total
    from backlog bk join ppp_base_pedidos b on b.pedido = bk.np
  )
  select jsonb_build_object(
    'nps',      (select count(*) from backlog),
    'm3',       (select round(sum(m3)::numeric,1) from backlog),
    'plata',    (select round(total) from plata),
    'm3_dia',   (select round(m3_dia::numeric,2) from ritmo),
    'dias_ppp', (select round((select sum(m3) from backlog)::numeric
                              / nullif((select m3_dia from ritmo),0), 1)),
    'ultima_salida', (select max(fecha_salida) from ppp_facturacion)
  );
$$;

revoke all on function public.rep_ppp() from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 4. CLIENTES QUE COMPRAN MENOS  (el caso Coto)
-- ---------------------------------------------------------------------------
-- Se mide en CAJAS y no en unidades a proposito: unidades exige joinear
-- `products`, y el % de cajas sin match viene creciendo (1,6% en abril 2026,
-- 18,5% en agosto). Con unidades, una caida podria ser solo un articulo dado de
-- baja del maestro. Cajas es el dato completo; las unidades se informan aparte
-- y marcadas como aproximadas.
--
-- Ventana: promedio mensual de los ULTIMOS 3 meses contra el promedio mensual de
-- los 12 previos. Umbral: caida >= 40% y base >= p_min_cajas_mes cajas/mes.

create or replace function public.rep_caidas(p_top int default 8, p_min_cajas_mes numeric default 40)
returns table(cod text, cliente text, cj_rec numeric, cj_base numeric, caida_pct int,
              un_rec numeric, un_base numeric, arts_rec int, arts_base int, ult_compra text)
language sql stable security definer
set search_path to 'public','pg_temp'
as $$
  with lim as (select left(max(invoice_date),7) as ult from sales_lines where empresa='lk'),
  corte as (select ult, to_char((ult||'-01')::date - interval '3 months','YYYY-MM') as c3,
                   to_char((ult||'-01')::date - interval '15 months','YYYY-MM') as c15 from lim),
  base as (
    select sl.customer_code as cod, left(sl.invoice_date,7) as mes,
           sl.item_code, sl.boxes,
           sl.boxes * coalesce(p.uxb,0) as unid
    from sales_lines sl
    cross join corte
    left join products p on p.cod = sl.item_code and p.active is true
    where sl.empresa='lk' and sl.customer_code not in ('1','3878')
      and sl.item_code <> all (array(select item_code from sales_excluded_items))
      and left(sl.invoice_date,7) > corte.c15 and left(sl.invoice_date,7) <= corte.ult
  ),
  part as (
    select b.cod,
           sum(b.boxes) filter (where b.mes >  corte.c3) / 3.0  as cj_rec,
           sum(b.boxes) filter (where b.mes <= corte.c3) / 12.0 as cj_base,
           sum(b.unid)  filter (where b.mes >  corte.c3) / 3.0  as un_rec,
           sum(b.unid)  filter (where b.mes <= corte.c3) / 12.0 as un_base,
           count(distinct b.item_code) filter (where b.mes >  corte.c3) as arts_rec,
           count(distinct b.item_code) filter (where b.mes <= corte.c3) as arts_base
    from base b cross join corte group by b.cod
  )
  select p.cod,
         coalesce(nullif(btrim(c.business_name),''),'Cliente '||p.cod) as cliente,
         round(coalesce(p.cj_rec,0))  as cj_rec,
         round(coalesce(p.cj_base,0)) as cj_base,
         round(100*(1 - coalesce(p.cj_rec,0)/nullif(p.cj_base,0)))::int as caida_pct,
         round(coalesce(p.un_rec,0))  as un_rec,
         round(coalesce(p.un_base,0)) as un_base,
         coalesce(p.arts_rec,0)::int, coalesce(p.arts_base,0)::int,
         (select max(sl.invoice_date) from sales_lines sl
           where sl.empresa='lk' and sl.customer_code = p.cod
             and sl.item_code <> all (array(select item_code from sales_excluded_items))) as ult_compra
  from part p
  left join customers c on c.cod_cliente::text = p.cod
  where coalesce(p.cj_base,0) >= p_min_cajas_mes
    and coalesce(p.cj_rec,0) < 0.6 * p.cj_base
  order by (p.cj_base - coalesce(p.cj_rec,0)) desc
  limit p_top;
$$;

revoke all on function public.rep_caidas(int, numeric) from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 5. TEXTOS DE LOS REPORTES
-- ---------------------------------------------------------------------------

-- DIARIO. Mide pedido + backlog, NO facturado (ver cabecera del archivo).
create or replace function public.rep_texto_diario(p_fecha date default null)
returns text language plpgsql stable security definer
set search_path to 'public','pg_temp'
as $$
declare
  f     date := coalesce(p_fecha, (now() at time zone 'America/Argentina/Buenos_Aires')::date - 1);
  ayer  record;
  mes   record;
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

  -- Con pocos dias corridos el % contra el mismo tramo es ruido puro (un finde
  -- al principio del mes anterior da variaciones de 400%). Se omite hasta el dia 5.
  linea_mes := '  Mes: ' || rep_plata(mes.actual)
    || case when extract(day from f) >= 5
            then rep_var(mes.actual, nullif(mes.ant_tramo,0)) || ' vs mismo tramo mes ant.'
            else ' (día ' || extract(day from f)::int || ', muy temprano para comparar)' end;

  ppp := rep_ppp();
  -- El facturado sale del MISMO cache que el panel, para que no den numeros distintos.
  select d.data into dash from gv_dash_cache d where d.id = 1;

  return '📊 DIARIO · ' || to_char(f,'DD/MM/YYYY') || E'\n'
    || '━━━━━━━━━━━━━━━━━━' || E'\n\n'
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
end $$;


-- SEMANAL. Lunes a domingo de la semana cerrada.
create or replace function public.rep_texto_semanal(p_fecha date default null)
returns text language plpgsql stable security definer
set search_path to 'public','pg_temp'
as $$
declare
  hoy date := coalesce(p_fecha, (now() at time zone 'America/Argentina/Buenos_Aires')::date);
  ini date := date_trunc('week', hoy)::date - 7;   -- lunes de la semana pasada
  fin date := date_trunc('week', hoy)::date - 1;   -- domingo
  sem record;
  ppp jsonb;
  top text;
begin
  select coalesce(sum(o.total) filter (where l.d between ini and fin),0)          as monto,
         count(*) filter (where l.d between ini and fin)                          as pedidos,
         count(distinct o.customer_id) filter (where l.d between ini and fin)     as clientes,
         coalesce(sum(o.total) filter (where l.d between ini-7 and fin-7),0)      as monto_ant
    into sem
  from orders o
  cross join lateral (select (o.created_at at time zone 'America/Argentina/Buenos_Aires')::date as d) l
  where l.d between ini-7 and fin;

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
    order by sum(o.total) desc
    limit 5
  ) x;

  ppp := rep_ppp();

  return '📈 SEMANAL · ' || to_char(ini,'DD/MM') || ' al ' || to_char(fin,'DD/MM/YYYY') || E'\n'
    || '━━━━━━━━━━━━━━━━━━' || E'\n\n'
    || '🛒 PEDIDO EN LA SEMANA' || E'\n'
    || '  ' || rep_plata(sem.monto) || rep_var(sem.monto, nullif(sem.monto_ant,0)) || ' vs semana previa' || E'\n'
    || '  ' || sem.pedidos || ' pedidos  ·  ' || sem.clientes || ' clientes' || E'\n\n'
    || '🏆 TOP 5 DE LA SEMANA' || E'\n' || coalesce(top,'  (sin pedidos)') || E'\n\n'
    || '📦 POR FACTURAR (PPP en curso)' || E'\n'
    || '  ' || rep_plata((ppp->>'plata')::numeric)
       || '  ·  ' || (ppp->>'nps') || ' NP  ·  ' || (ppp->>'m3') || ' m³' || E'\n'
    || '  Ritmo ' || (ppp->>'m3_dia') || ' m³/día → ' || (ppp->>'dias_ppp') || ' días de cola' || E'\n'
    || '  Última salida: ' || coalesce(ppp->>'ultima_salida','—');
end $$;


-- MENSUAL. Lee gv_dash_cache (lo refresca el cron gerente-ventas-diario) para no
-- recalcular y para que el panel y Telegram muestren el MISMO numero.
create or replace function public.rep_texto_mensual()
returns text language plpgsql stable security definer
set search_path to 'public','pg_temp'
as $$
declare
  d      jsonb;
  gen    timestamptz;
  t      text;
  bloque text;
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

  t := t || '🎯 CONCENTRACIÓN (12m)' || E'\n'
    || '  Top 10 = ' || round(100*(d#>>'{concentracion,top10}')::numeric
                              / nullif((d#>>'{concentracion,total}')::numeric,0)) || '% de la venta'
    || '  ·  Top 20 = ' || round(100*(d#>>'{concentracion,top20}')::numeric
                              / nullif((d#>>'{concentracion,total}')::numeric,0)) || '%' || E'\n\n';

  -- El bloque que motivo el reporte: el caso Coto.
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

  t := t || '⏱ FUGA TEMPRANA' || E'\n'
    || '  ' || coalesce(d#>>'{fuga,clientes}','0') || ' clientes atrasados respecto de su ritmo' || E'\n\n'
    || '_Datos al ' || to_char(gen at time zone 'America/Argentina/Buenos_Aires','DD/MM HH24:MI') || '._';

  return t;
end $$;

revoke all on function public.rep_texto_diario(date)  from public, anon, authenticated;
revoke all on function public.rep_texto_semanal(date) from public, anon, authenticated;
revoke all on function public.rep_texto_mensual()     from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 6. ENVIO
-- ---------------------------------------------------------------------------

create or replace function public.rep_enviar_diario()
returns void language plpgsql security definer
set search_path to 'public','pg_temp'
as $$
declare f date := (now() at time zone 'America/Argentina/Buenos_Aires')::date - 1;
begin
  perform tg_enqueue_largo(rep_texto_diario(f), 'diario_' || to_char(f,'YYYYMMDD'));
end $$;

create or replace function public.rep_enviar_semanal()
returns void language plpgsql security definer
set search_path to 'public','pg_temp'
as $$
declare hoy date := (now() at time zone 'America/Argentina/Buenos_Aires')::date;
begin
  perform tg_enqueue_largo(rep_texto_semanal(hoy),
                           'semanal_' || to_char(date_trunc('week',hoy)::date - 7,'IYYY_IW'));
end $$;

-- El dedup va por MES REPORTADO, no por fecha de envio. Asi el cron puede
-- intentar varios dias seguidos: mientras el ERP no haya cargado el lote nuevo,
-- el cache sigue mostrando el mes viejo y el `on conflict do nothing` lo frena.
-- El dia que entra el lote, el mes es nuevo y el reporte sale solo.
create or replace function public.rep_enviar_mensual()
returns void language plpgsql security definer
set search_path to 'public','pg_temp'
as $$
declare mes text;
begin
  select data#>>'{resumen,mes}' into mes from gv_dash_cache where id = 1;
  if mes is null then return; end if;
  perform tg_enqueue_largo(rep_texto_mensual(), 'mensual_' || mes);
end $$;

revoke all on function public.rep_enviar_diario()  from public, anon, authenticated;
revoke all on function public.rep_enviar_semanal() from public, anon, authenticated;
revoke all on function public.rep_enviar_mensual() from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 7. CRONS  (horarios en UTC; ART = UTC-3)
-- ---------------------------------------------------------------------------
-- El diario/semanal/mensual van DESPUES de gerente-ventas-diario (10:30 UTC),
-- que es quien refresca gv_dash_cache, y de sincronizar-ppp-diario (10:00 UTC).

select cron.schedule('telegram-outbox-flush',    '* * * * *',          'select public.tg_outbox_flush()');
select cron.schedule('reporte-diario-telegram',  '0 11 * * 1-6',       'select public.rep_enviar_diario()');
select cron.schedule('reporte-semanal-telegram', '15 11 * * 1',        'select public.rep_enviar_semanal()');
-- Varios intentos: el lote mensual del ERP llega entre el 2 y el 14.
-- El dedup por mes reportado hace que salga UNA sola vez.
select cron.schedule('reporte-mensual-telegram', '30 11 3,5,8,12 * *', 'select public.rep_enviar_mensual()');
