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
    where sl.empresa='lk' and sl.boxes is not null and sl.customer_code not in ('1','3878')
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
-- 4B. DESPACHADO POR DIA  (fuente: VIRGILIO, no LK)
-- ---------------------------------------------------------------------------
-- Lo que realmente SALIO del deposito NO esta en el Supabase de LK: vive en el
-- de Virgilio (`Facturacion_NP`, con fecha_salida al dia). Se espeja a LK con
-- sincronizar_ppp() -> public.ppp_facturacion.
--
-- Esto es lo que hace posible un numero de PLATA DIARIO. `sales_lines` (ERP)
-- entra por lote mensual, asi que no sirve; `Facturacion_NP` se actualiza todos
-- los dias. Verificado: fecha_salida llegaba a 2026-09-04 el 3/9.
--
-- POR QUE HACE FALTA UNA FOTO Y NO ALCANZA CON CONSULTAR
--   `ppp_base_pedidos` es AMNESICA: el sync la reemplaza entera desde Virgilio,
--   asi que las lineas de una NP vieja desaparecen y con ellas la posibilidad de
--   valorizarla. Medido el 3/9/2026, % de NP todavia valorizables:
--       septiembre 100%   agosto 95%   julio 66%   junio 0%
--   Sin la foto, el historico de plata despachada se borra solo.
--
-- COMO SE VALORIZA
--   Se valoriza sobre las cajas PEDIDAS (`ppp_base_pedidos`, unico detalle por
--   articulo que existe) y despues se ajusta por la proporcion realmente
--   entregada de esa NP: Virgilio despacha corto ~4,5% y sin el ajuste el numero
--   sobreestima. Ese dato sale de `vista_ppp_pedidos_entregados`, espejada como
--   `ppp_entregas_np`.
--
-- CONTRASTE CONTRA EL ERP (agosto 2026)
--   Virgilio (con ajuste)                         $538,9 M
--   ERP crudo (sales_lines)                       $477,0 M
--   ERP corregido por las cajas sin match         $586,0 M
--   Cajas: Virgilio 19.353 vs ERP 22.556 (86%)
--   Los dos metodos se corroboran. Las diferencias tienen causa conocida: el ERP
--   pierde el 18,6% de las cajas de agosto en el join a `products`, y no todo lo
--   que factura LK pasa por PPP. NO son el mismo numero y no hay que sumarlos.

create foreign table if not exists virgilio.entregas_np (
  np               text,
  tanda            text,
  cod_cliente      text,
  m3               numeric,
  fecha_salida     date,
  cajas_pedidas    numeric,
  cajas_entregadas numeric,
  cajas_falto      numeric
) server virgilio_db
  options (schema_name 'public', table_name 'vista_ppp_pedidos_entregados');
-- Del lado VIRGILIO hace falta:  grant select on public.vista_ppp_pedidos_entregados to lk_ppp_reader;

create table if not exists public.ppp_entregas_np (
  np               text primary key,
  cod_cliente      text,
  fecha_salida     date,
  cajas_pedidas    numeric,
  cajas_entregadas numeric,
  cajas_falto      numeric
);
alter table public.ppp_entregas_np enable row level security;
revoke all on table public.ppp_entregas_np from public, anon, authenticated;

create table if not exists public.rep_despacho_diario (
  fecha            date primary key,
  nps              int     not null,
  np_valorizadas   int     not null,
  m3               numeric,
  plata            numeric,
  cajas_pedidas    numeric,
  cajas_entregadas numeric,
  calculado_at     timestamptz not null default now()
);
alter table public.rep_despacho_diario enable row level security;
revoke all on table public.rep_despacho_diario from public, anon, authenticated;

-- La llama sincronizar_ppp() apenas termina de refrescar el espejo.
create or replace function public.rep_snapshot_despacho(p_dias int default 30)
returns int language plpgsql security definer
set search_path to 'public','pg_temp'
as $$
declare n int;
begin
  with calc as (
    select f.fecha_salida as fecha,
           count(distinct f.np)::int as nps,
           count(distinct f.np) filter (
             where exists (select 1 from ppp_base_pedidos b where b.pedido = f.np))::int as np_val,
           round(sum(f.m3)::numeric,2) as m3,
           round(sum(v.plata * coalesce(e.ratio,1))) as plata,
           round(sum(coalesce(e.cajas_pedidas,0))) as cj_ped,
           round(sum(coalesce(e.cajas_entregadas,0))) as cj_ent
    from ppp_facturacion f
    join lateral (
      select coalesce(sum(ppp_valor_linea(pr.cod, b.articulo, b.cajas)),0) as plata
      from ppp_base_pedidos b
      left join ppp_programacion pr on pr.np = f.np
      where b.pedido = f.np
    ) v on true
    left join lateral (
      select en.cajas_pedidas, en.cajas_entregadas,
             case when coalesce(en.cajas_pedidas,0) > 0
                  then en.cajas_entregadas / en.cajas_pedidas end as ratio
      from ppp_entregas_np en where en.np = f.np
    ) e on true
    where left(f.np,1) = '9'
      and f.fecha_salida is not null
      and f.fecha_salida >= current_date - p_dias
    group by 1
  ),
  ins as (
    insert into public.rep_despacho_diario
      (fecha, nps, np_valorizadas, m3, plata, cajas_pedidas, cajas_entregadas, calculado_at)
    select fecha, nps, np_val, m3, plata, cj_ped, cj_ent, now() from calc
    -- Solo pisa un dia si la foto nueva tiene AL MENOS tantas NP valorizadas como
    -- la guardada: si no, una corrida tardia con las lineas ya perdidas
    -- degradaria un dato que estaba bien.
    on conflict (fecha) do update
      set nps              = excluded.nps,
          np_valorizadas   = excluded.np_valorizadas,
          m3               = excluded.m3,
          plata            = excluded.plata,
          cajas_pedidas    = excluded.cajas_pedidas,
          cajas_entregadas = excluded.cajas_entregadas,
          calculado_at     = now()
      where excluded.np_valorizadas >= public.rep_despacho_diario.np_valorizadas
    returning 1
  )
  select count(*) into n from ins;
  return n;
end $$;

revoke all on function public.rep_snapshot_despacho(int) from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 5. TEXTOS DE LOS REPORTES
-- ---------------------------------------------------------------------------

-- DIARIO. Cuatro numeros y cada uno mide otra cosa; ver cabecera del archivo.
--   DESPACHADO -> Virgilio, lo unico que da plata al dia siguiente.
--   PEDIDO     -> orders, portal, en vivo.
--   POR FACTURAR -> backlog PPP.
--   FACTURADO  -> ERP, ultimo mes cerrado, del mismo cache que el panel.
create or replace function public.rep_texto_diario(p_fecha date default null)
returns text language plpgsql stable security definer
set search_path to 'public','pg_temp'
as $$
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

  -- Con pocos dias corridos el % contra el mismo tramo es ruido puro (un finde
  -- al principio del mes anterior da variaciones de 400%). Se omite hasta el dia 5.
  linea_mes := '  Mes: ' || rep_plata(mes.actual)
    || case when extract(day from f) >= 5
            then rep_var(mes.actual, nullif(mes.ant_tramo,0)) || ' vs mismo tramo mes ant.'
            else ' (día ' || extract(day from f)::int || ', muy temprano para comparar)' end;

  -- DESPACHADO: sale de Virgilio (Facturacion_NP), que es donde vive lo que
  -- realmente salio. Es el unico numero de plata que existe al dia siguiente.
  select coalesce(d.nps,0) as nps, coalesce(d.plata,0) as plata,
         coalesce(d.cajas_entregadas,0) as cajas, coalesce(d.m3,0) as m3,
         (select coalesce(sum(x.plata),0) from rep_despacho_diario x
           where x.fecha >= date_trunc('month', f)::date and x.fecha <= f) as plata_mes
    into desp
  from rep_despacho_diario d where d.fecha = f;

  ppp := rep_ppp();
  -- El facturado sale del MISMO cache que el panel, para que no den numeros distintos.
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

  select coalesce(sum(plata) filter (where fecha between ini and fin),0)      as plata,
         coalesce(sum(nps)   filter (where fecha between ini and fin),0)      as nps,
         coalesce(sum(cajas_entregadas) filter (where fecha between ini and fin),0) as cajas,
         coalesce(sum(plata) filter (where fecha between ini-7 and fin-7),0)  as plata_ant
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
  -- Red de seguridad: sincronizar_ppp() ya la corre, pero si ese cron fallo el
  -- reporte igual sale con la foto mas fresca que se pueda.
  perform rep_snapshot_despacho(30);
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


-- ---------------------------------------------------------------------------
-- 8. CODIGO CANONICO DE ARTICULO  (evita falsas alarmas de "articulo perdido")
-- ---------------------------------------------------------------------------
-- Un cambio de codigo se veia como una perdida. Relca (2444) figuraba perdiendo
-- 22 articulos; perdio 6. Los otros 16 cambiaron de codigo: `031` deja de
-- venderse el 28/02 y `031L` arranca el 08/07, y lo mismo con 123/123L,
-- 102E/102EL, 315/315L, 544/544L.
--
-- OJO, el sufijo L NO es un renombre global: en 72 de los 75 pares el codigo
-- base LE SIGUE VENDIENDO a otros clientes, y los 75 codigos con L tienen <=3
-- clientes. Es una variante para un cliente puntual. Pero para responder "este
-- cliente dejo de comprar este producto", base y variante son lo mismo.
--
-- Se usa SOLO para detectar caidas. NO para valorizar: el precio de la variante
-- puede no ser el del base, y eso lo decide una persona.
create or replace view public.v_item_canon as
select i.item_code,
       coalesce(
         r.to_code,
         case when i.item_code ~ 'L$'
                   and not exists (select 1 from products px where px.cod = i.item_code)
                   and exists (select 1 from products pb where pb.cod = regexp_replace(i.item_code,'L$',''))
              then regexp_replace(i.item_code,'L$','')
         end,
         i.item_code) as canon
from (select distinct item_code from sales_lines where item_code is not null) i
left join sales_item_remap r on r.from_code = i.item_code;

revoke all on public.v_item_canon from anon, authenticated;


-- ---------------------------------------------------------------------------
-- 9. TOP CLIENTES: volumen, surtido y abandono son TRES cosas distintas
-- ---------------------------------------------------------------------------
-- Medido sobre el top 20, perder articulos avisa ANTES que caer en volumen:
-- Extralimp mantiene el volumen (-18%) concentrandose de 16 articulos a 4, que
-- es el patron que Coto tuvo seis meses antes de desplomarse.
-- Por eso el diagnostico no colapsa todo en un solo %.

-- OJO CON DOS COSAS, las dos costaron un reporte mal mandado:
--   `boxes` puede venir NULL (122 lineas del cliente 5000, con import_batch y
--   row_hash tambien NULL: no vinieron del lote mensual del ERP). Hay que
--   descartarlas: no suman a ningun total.
--   Y `ORDER BY sum(boxes) DESC` en Postgres pone los NULL PRIMERO, asi que ese
--   cliente sin una sola caja contable encabezaba el top 20 de "principales".
--   Por eso va `nulls last`.
create or replace function public.rep_top_clientes(p_top int default 20)
returns table(cod text, cliente text, cj_base numeric, cj_rec numeric, var_vol int,
              arts_base int, arts_rec int, arts_perdidos int, cajas_perdidas numeric,
              perdidos text, ultima text, dias_sin_comprar int, diagnostico text)
language sql stable security definer
set search_path to 'public','pg_temp'
as $$
  with lim as (select left(max(invoice_date),7) as ult from sales_lines where empresa='lk'),
  corte as (select ult, to_char((ult||'-01')::date - interval '3 months','YYYY-MM')  as c3,
                   to_char((ult||'-01')::date - interval '15 months','YYYY-MM') as c15 from lim),
  mov as (
    select sl.customer_code as cod, ic.canon as item_code,
           left(sl.invoice_date,7) as mes, sl.boxes, sl.invoice_date
    from sales_lines sl
    join v_item_canon ic on ic.item_code = sl.item_code
    cross join corte
    where sl.empresa='lk' and sl.boxes is not null and sl.customer_code not in ('1','3878')
      and sl.item_code <> all (array(select item_code from sales_excluded_items))
      and left(sl.invoice_date,7) > corte.c15 and left(sl.invoice_date,7) <= corte.ult
  ),
  top as (select m.cod, sum(m.boxes) as t from mov m group by 1 order by 2 desc nulls last limit p_top),
  art as (
    select v.cod, v.item_code,
           coalesce(sum(v.boxes) filter (where v.mes >  c.c3),0)/3.0  as cj_rec,
           coalesce(sum(v.boxes) filter (where v.mes <= c.c3),0)/12.0 as cj_base,
           count(distinct v.mes) filter (where v.mes <= c.c3) as meses_hist
    from top t join mov v on v.cod = t.cod cross join corte c group by 1,2
  ),
  cli as (
    select a.cod,
           sum(a.cj_base) as cj_base, sum(a.cj_rec) as cj_rec,
           count(*) filter (where a.cj_base > 0) as arts_base,
           count(*) filter (where a.cj_rec  > 0) as arts_rec,
           count(*) filter (where a.cj_rec = 0 and a.meses_hist >= 4 and a.cj_base >= 3) as arts_perd,
           coalesce(sum(a.cj_base) filter (where a.cj_rec = 0 and a.meses_hist >= 4 and a.cj_base >= 3),0) as cj_perd,
           string_agg(a.item_code || '(' || round(a.cj_base) || ')', ' ' order by a.cj_base desc)
             filter (where a.cj_rec = 0 and a.meses_hist >= 4 and a.cj_base >= 3) as perdidos
    from art a group by a.cod
  )
  select c.cod,
         coalesce(nullif(btrim(cu.business_name),''), 'Cliente '||c.cod),
         round(c.cj_base), round(c.cj_rec),
         round(100*(c.cj_rec/nullif(c.cj_base,0) - 1))::int,
         c.arts_base::int, c.arts_rec::int, c.arts_perd::int, round(c.cj_perd),
         c.perdidos, u.ultima, (current_date - u.ultima::date)::int,
         case
           when c.cj_rec = 0                    then '🔴 DEJÓ DE COMPRAR'
           when c.cj_rec < 0.5 * c.cj_base      then '🔴 volumen −' || round(100*(1-c.cj_rec/c.cj_base)) || '%'
           when c.arts_perd >= 3                then '🟠 perdió ' || c.arts_perd || ' artículos'
           when c.cj_rec < 0.8 * c.cj_base      then '🟠 volumen −' || round(100*(1-c.cj_rec/c.cj_base)) || '%'
           when c.arts_rec < 0.75 * c.arts_base then '🟡 surtido −' || round(100*(1-c.arts_rec::numeric/c.arts_base)) || '%'
           when c.cj_rec > 1.2 * c.cj_base      then '🟢 crece +' || round(100*(c.cj_rec/c.cj_base-1)) || '%'
           else '⚪ estable' end
  from cli c
  left join customers cu on cu.cod_cliente::text = c.cod
  left join lateral (select max(m2.invoice_date) as ultima from mov m2 where m2.cod = c.cod) u on true
  order by c.cj_rec/nullif(c.cj_base,0) asc nulls first;
$$;

-- Detalle articulo por articulo de UN cliente, con nombre de producto.
create or replace function public.rep_articulos_cliente(p_cod text)
returns table(item_code text, descripcion text, cj_base numeric, cj_rec numeric,
              var_pct int, meses_hist int, estado text)
language sql stable security definer
set search_path to 'public','pg_temp'
as $$
  with lim as (select left(max(invoice_date),7) as ult from sales_lines where empresa='lk'),
  corte as (select ult, to_char((ult||'-01')::date - interval '3 months','YYYY-MM')  as c3,
                   to_char((ult||'-01')::date - interval '15 months','YYYY-MM') as c15 from lim),
  mov as (
    select ic.canon as item_code, left(sl.invoice_date,7) as mes, sl.boxes
    from sales_lines sl
    join v_item_canon ic on ic.item_code = sl.item_code
    cross join corte
    where sl.empresa='lk' and sl.boxes is not null and sl.customer_code = p_cod
      and sl.item_code <> all (array(select item_code from sales_excluded_items))
      and left(sl.invoice_date,7) > corte.c15 and left(sl.invoice_date,7) <= corte.ult
  ),
  agg as (
    select m.item_code,
           coalesce(sum(m.boxes) filter (where m.mes <= c.c3),0)/12.0 as cj_base,
           coalesce(sum(m.boxes) filter (where m.mes >  c.c3),0)/3.0  as cj_rec,
           count(distinct m.mes) filter (where m.mes <= c.c3) as meses_hist
    from mov m cross join corte c group by m.item_code
  )
  select a.item_code,
         left(coalesce(p.description, lp.description, '(sin ficha)'), 34),
         round(a.cj_base,1), round(a.cj_rec,1),
         round(100*(a.cj_rec/nullif(a.cj_base,0) - 1))::int,
         a.meses_hist::int,
         case when a.cj_base = 0                       then 'NUEVO'
              when a.cj_rec  = 0 and a.meses_hist >= 4 then 'PERDIDO'
              when a.cj_rec  = 0                       then 'esporádico, sin compra'
              when a.cj_rec  < 0.5 * a.cj_base         then 'CAE FUERTE'
              when a.cj_rec  < 0.8 * a.cj_base         then 'baja'
              when a.cj_rec  > 1.2 * a.cj_base         then 'sube'
              else 'estable' end
  from agg a
  left join products p       on p.cod  = a.item_code
  left join loke_products lp on lp.cod = a.item_code
  order by (a.cj_base - a.cj_rec) desc;
$$;

create or replace function public.rep_texto_top20(p_top int default 20)
returns text language plpgsql stable security definer
set search_path to 'public','pg_temp'
as $$
declare alerta text; ok text; n_ok int;
begin
  -- Solo se detalla lo que necesita atencion. Un reporte de 20 fichas no lo lee nadie.
  select string_agg(
    '▸ ' || left(t.cliente,30) || '  ' || t.diagnostico || E'\n'
    || '   ' || t.cj_rec || ' cj/mes vs ' || t.cj_base || ' hist.  ·  '
    || t.arts_rec || ' arts vs ' || t.arts_base || E'\n'
    || case when t.arts_perdidos > 0
            then '   Dejó de comprar: ' || left(t.perdidos, 90) || E'\n' else '' end
    || '   Última compra hace ' || t.dias_sin_comprar || ' días',
    E'\n' order by t.cj_rec/nullif(t.cj_base,0) asc nulls first)
  into alerta
  from public.rep_top_clientes(p_top) t where t.diagnostico !~ '^(🟢|⚪)';

  select count(*), string_agg(left(t.cliente,18) || ' ' ||
           case when t.var_vol is null then ''
                else (case when t.var_vol >= 0 then '+' else '' end) || t.var_vol || '%' end, ' · ')
    into n_ok, ok
  from public.rep_top_clientes(p_top) t where t.diagnostico ~ '^(🟢|⚪)';

  return '👥 TOP ' || p_top || ' CLIENTES · revisión' || E'\n'
    || '━━━━━━━━━━━━━━━━━━' || E'\n'
    || '_Últimos 3 meses vs promedio de los 12 previos._' || E'\n\n'
    || coalesce(alerta, 'Ninguno del top ' || p_top || ' necesita atención.') || E'\n\n'
    || '✅ SIN PROBLEMA (' || n_ok || ')' || E'\n' || coalesce(ok,'—');
end $$;

create or replace function public.rep_enviar_top20()
returns void language plpgsql security definer
set search_path to 'public','pg_temp'
as $$
declare hoy date := (now() at time zone 'America/Argentina/Buenos_Aires')::date;
begin
  perform tg_enqueue_largo(rep_texto_top20(20), 'top20_' || to_char(hoy,'IYYY_IW'));
end $$;

revoke all on function public.rep_top_clientes(int)        from public, anon, authenticated;
revoke all on function public.rep_articulos_cliente(text)  from public, anon, authenticated;
revoke all on function public.rep_texto_top20(int)         from public, anon, authenticated;
revoke all on function public.rep_enviar_top20()           from public, anon, authenticated;

select cron.schedule('reporte-top20-telegram', '20 11 * * 1', 'select public.rep_enviar_top20()');

-- ============================================================================
-- SECCION 10 · AVISO POR ARTICULO  (4/9/2026)
-- ============================================================================
-- Motivo: Coto dejo de comprar el 505 (su articulo mas fuerte) y el reporte lo
-- mostraba como "CAE FUERTE -52%", no como un corte. La causa es que
-- rep_articulos_cliente compara el promedio de los ULTIMOS 3 MESES contra el de
-- los 12 previos, y la ventana jun-jul-ago todavia contenia junio (332 cj):
-- 332/3 = 110,7 contra una base de 228,3 da -52%. O sea que un articulo que se
-- corto DEL TODO se lee como media caida. Es la misma leccion del drawdown que
-- ya se habia aprendido para clientes, ahora a nivel articulo.
--
-- La correccion es agregar los MESES CONSECUTIVOS EN CERO como senal propia
-- (`meses_sin_compra`), que es justo lo que el promedio tapa. Con eso el 505 de
-- Coto pasa a "SE CORTO · hace 2 meses (ult. 2026-06)" y ademas aparece el 529E,
-- que estaba tapado igual.
--
-- Se calcula como la distancia en meses entre la ultima compra y el ultimo mes
-- cerrado del ERP, que por construccion ES la racha de ceros del final. No hace
-- falta armar la rejilla de meses.
--
-- Umbral: >= 2 meses en cero y >= 6 meses de historia. Con 1 mes solo, el ritmo
-- normal de reposicion de un supermercado ya da falsos positivos.
--
-- rep_articulos_cortados() barre los clientes VIVOS del top (los que compraron
-- en los ultimos 2 meses) y devuelve sus articulos cortados valorizados: el que
-- dejo de comprar del todo es otro reporte, no este. Llama a
-- rep_articulos_cliente por LATERAL a proposito, para que el criterio este
-- definido UNA sola vez y las dos vistas no puedan divergir.
--
-- Al 4/9/2026: 20 articulos, $35,4 M/mes en juego. Los tres primeros son
-- 505 en Coto ($4,3 M/mes), 504 en Coto ($3,5 M) y 505 en OSA ($3,3 M).
--
-- Cron: reporte-articulos-telegram, lunes 11:30 UTC (08:30 ART).

-- ============================================================================
-- SECCION 11 · BOTONES INLINE  (fase 2, 4/9/2026)
-- ============================================================================
-- gv_senales aprende de UN solo eje: `utilidad`. Hasta ahora solo se podia
-- cargar desde el panel admin, asi que en la practica el peso de casi todas las
-- senales seguia en el 0,50 inicial y la priorizacion no mejoraba nunca. Estos
-- botones son lo que hace arrancar la automejora.
--
-- Mandarlos era la parte facil (reply_markup). Lo que faltaba era RECIBIR el
-- click, que necesita un endpoint publico: la Edge Function
-- `gv-telegram-webhook` (verify_jwt=off), en supabase/functions/, con su README
-- de deploy.
--
-- UN MENSAJE POR SUGERENCIA y no uno solo con todo: el callback_data tiene que
-- llevar el id de la sugerencia y Telegram lo topea en 64 bytes. Ademas asi
-- cada respuesta edita su propio mensaje y en el historial queda que se
-- contesto y con que.

alter table public.telegram_outbox add column if not exists reply_markup jsonb;
-- tg_outbox_flush agrega reply_markup al body del sendMessage cuando no es null.

create or replace function public.tg_enqueue_botones(
  p_text text, p_dedup text, p_markup jsonb,
  p_chat text default '6282395816', p_parse_mode text default null)
returns void language sql security definer set search_path to 'public','pg_temp'
as $$
  insert into public.telegram_outbox (chat_id, text, dedup_key, parse_mode, reply_markup)
  values (p_chat, p_text, p_dedup, p_parse_mode, p_markup)
  on conflict (dedup_key) do nothing;
$$;

create or replace function public.gv_enviar_agenda_telegram(p_fecha date default current_date)
returns int language plpgsql security definer set search_path to 'public','pg_temp'
as $$
declare r record; n int := 0; v_txt text;
begin
  perform gv_es_admin_o_cron();

  for r in
    select g.id, g.tipo, s.etiqueta, g.cod_cliente, g.titulo, g.motivo, g.accion,
           g.score, g.payload, g.vendedor
    from gv_sugerencias g
    join gv_senales s on s.tipo = g.tipo
    where g.fecha = p_fecha and g.utilidad = 'sin_opinion'
    order by g.score desc, g.id
  loop
    v_txt := '🎯 *' || replace(r.etiqueta,'*','') || '*' || E'\n' ||
             replace(coalesce(r.titulo,''),'*','') || E'\n\n' ||
             coalesce(r.motivo,'') || E'\n\n' ||
             '👉 ' || coalesce(r.accion,'');

    -- la evidencia son los 2-3 numeros crudos que dispararon la senal: sin
    -- ellos la sugerencia hay que creerla, con ellos se puede discutir.
    if r.payload ? 'evidencia' then
      v_txt := v_txt || E'\n';
      select v_txt || string_agg('   · ' || (e->>'k') || ': ' || (e->>'v'), E'\n')
        into v_txt
        from jsonb_array_elements(r.payload->'evidencia') e;
    end if;

    perform tg_enqueue_botones(
      v_txt,
      'gv_' || to_char(p_fecha,'YYYYMMDD') || '_' || r.id::text,
      jsonb_build_object('inline_keyboard', jsonb_build_array(
        jsonb_build_array(
          jsonb_build_object('text','👍 Sirvió',   'callback_data','u:'||r.id||':util'),
          jsonb_build_object('text','👎 No sirvió','callback_data','u:'||r.id||':no_util')),
        jsonb_build_array(
          jsonb_build_object('text','✅ Se concretó','callback_data','r:'||r.id||':gano'),
          jsonb_build_object('text','❌ Se perdió',  'callback_data','r:'||r.id||':perdio'))
      )),
      '6282395816', 'Markdown');
    n := n + 1;
  end loop;

  return n;
end $$;

-- El parseo del callback_data vive ACA y no en la Edge Function: asi el
-- criterio esta definido una sola vez y se puede re-escribir la funcion sin
-- tocar la logica.
create or replace function public.gv_telegram_callback(p_data text)
returns text language plpgsql security definer set search_path to 'public','pg_temp'
as $$
declare
  v_eje  text; v_id bigint; v_val text; v_tit text;
begin
  v_eje := split_part(p_data, ':', 1);
  v_id  := nullif(split_part(p_data, ':', 2), '')::bigint;
  v_val := split_part(p_data, ':', 3);
  if v_id is null then return 'callback inválido'; end if;

  select titulo into v_tit from gv_sugerencias where id = v_id;
  if v_tit is null then return 'esa sugerencia ya no existe'; end if;

  if v_eje = 'u' and v_val in ('util','no_util') then
    perform gv_marcar_utilidad(v_id, v_val, false);
    return case when v_val = 'util' then '👍 Anotado: te sirvió'
                else '👎 Anotado: no te sirvió' end;
  elsif v_eje = 'r' and v_val in ('gano','perdio') then
    perform gv_marcar_resultado(v_id, v_val, null);
    return case when v_val = 'gano' then '✅ Anotado: se concretó'
                else '❌ Anotado: se perdió' end;
  end if;
  return 'acción desconocida';
end $$;

revoke execute on function public.tg_enqueue_botones(text,text,jsonb,text,text) from public, anon, authenticated;
revoke execute on function public.gv_enviar_agenda_telegram(date)              from public, anon, authenticated;
revoke execute on function public.gv_telegram_callback(text)                   from public, anon, authenticated;
grant  execute on function public.gv_telegram_callback(text)                   to service_role;

-- gv_marcar_utilidad y gv_marcar_resultado pasaron de gv_es_admin() a
-- gv_es_admin_o_cron(): el webhook entra con service_role y sin JWT, asi que
-- auth.uid() es NULL y el guard estricto lo mataria. NO abre nada: anon ya
-- tenia el EXECUTE revocado, y un authenticated que no sea admin sigue
-- rechazado por gv_es_admin().
--
-- Verificado de punta a punta el 4/9/2026: gv_telegram_callback('u:27:util')
-- movio el peso de ticket_bajo de 0,5000 a 0,6667 y dejo acc_trab en 0 (los dos
-- ejes siguen separados). Se revirtio el voto de prueba.
