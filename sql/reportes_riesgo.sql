-- ============================================================================
-- CLIENTES EN RIESGO  (proyecto Supabase LK kwkclwhmoygunqmlegrg)
-- ============================================================================
-- Dos preguntas que el tablero no podia responder, y que son las que motivaron
-- todo el modulo cuando Coto paso de 4.214 cajas/mes a 435 sin que nada avisara.
--
--   1. Quien se esta cayendo AHORA (no quien ya se fue: eso es Ranking Inactivos).
--   2. A quien le pedimos y no le facturamos.
--
-- Se manda por Telegram los lunes 08:25 ART. Todo en cajas: la valorizacion
-- pierde hoy el 16% de las cajas en el join a `products` (ver sql/vigilancia.sql).
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. DRAWDOWN: trimestre movil actual contra el MEJOR trimestre movil de 15 meses
-- ---------------------------------------------------------------------------
-- Reemplaza al criterio "3 meses vs el promedio de los 12 previos", que es un
-- promedio contra un promedio y por eso llega tarde. Simulado mes a mes sobre
-- Coto (cliente 801):
--
--   mes   cajas  trim   pico   drawdown   criterio viejo
--   abr   1972   8727   9516     -8%          no cruza
--   may   1544   6057   9516    -36% ⚠        no cruza
--   jun   1029   4545   9516    -52% ⚠        no cruza
--   jul    651   3224   9516    -66% ⚠        ⚠ cruza
--   ago    435   2115   9516    -78% ⚠        ⚠ cruza
--
-- El drawdown cruza con datos de MAYO (alerta a principios de junio, cuando
-- entra el lote); el criterio viejo con datos de JULIO (alerta en agosto). Dos
-- meses, y en esos dos meses Coto paso de 1.544 cajas/mes a 435.
--
-- Umbral mas exigente para el top 20 (25% contra 35%): ahi un punto vale mucha
-- mas plata, y una cuenta grande no deberia tener que caer un tercio para que
-- alguien la mire.

create or replace function public.rep_drawdown(p_umbral numeric default 0.35,
                                               p_umbral_top numeric default 0.25,
                                               p_min_cajas_trim numeric default 150,
                                               p_limit int default 15)
returns table(cod text, cliente text, trim_actual numeric, mejor_trim numeric,
              caida_pct int, mes_pico text, es_top20 boolean, ultima text)
language sql stable security definer
set search_path to 'public','pg_temp'
as $$
  with lim as (select left(max(invoice_date),7) as ult from sales_lines where empresa='lk'),
  meses as (
    select sl.customer_code as cod, left(sl.invoice_date,7) as mes, sum(sl.boxes) as cajas
    from sales_lines sl cross join lim
    where sl.empresa='lk' and sl.boxes is not null and sl.customer_code not in ('1','3878')
      and sl.item_code <> all (array(select item_code from sales_excluded_items))
      and left(sl.invoice_date,7) > to_char((lim.ult||'-01')::date - interval '15 months','YYYY-MM')
    group by 1,2
  ),
  -- Rejilla completa de meses: un mes SIN compra tiene que valer 0. Sin esto el
  -- trimestre movil saltea los huecos y el cliente que dejo de comprar se ve
  -- igual que el que compra todos los meses.
  grid as (
    select c.cod, to_char(g.m,'YYYY-MM') as mes, coalesce(x.cajas,0) as cajas
    from (select distinct cod from meses) c
    cross join lateral (
      select generate_series((select (ult||'-01')::date - interval '14 months' from lim),
                             (select (ult||'-01')::date from lim), interval '1 month') as m) g
    left join meses x on x.cod = c.cod and x.mes = to_char(g.m,'YYYY-MM')
  ),
  rol as (
    select cod, mes,
           sum(cajas) over (partition by cod order by mes rows between 2 preceding and current row) as trim,
           row_number() over (partition by cod order by mes desc) as rn,
           count(*)     over (partition by cod) as n
    from grid
  ),
  val as (select * from rol where n - rn >= 2),   -- el trimestre movil vale desde el 3er mes
  agg as (
    select v.cod,
           max(v.trim) filter (where v.rn = 1) as trim_actual,
           max(v.trim) as mejor,
           (array_agg(v.mes order by v.trim desc))[1] as mes_pico
    from val v group by v.cod
  ),
  top20 as (select cod from meses group by cod order by sum(cajas) desc nulls last limit 20)
  select a.cod,
         coalesce(nullif(btrim(c.business_name),''),'Cliente '||a.cod),
         a.trim_actual, a.mejor,
         round(100*(1 - a.trim_actual/nullif(a.mejor,0)))::int,
         a.mes_pico, (t.cod is not null),
         (select max(sl.invoice_date) from sales_lines sl
           where sl.empresa='lk' and sl.customer_code = a.cod and sl.boxes is not null)
  from agg a
  left join customers c on c.cod_cliente::text = a.cod
  left join top20 t on t.cod = a.cod
  where a.mejor >= p_min_cajas_trim
    and a.trim_actual < (1 - case when t.cod is not null then p_umbral_top else p_umbral end) * a.mejor
    -- El que YA se fue es del Ranking Inactivos, no de esta lista: aca va el que
    -- todavia compra y se esta cayendo, que es sobre el que se puede actuar.
    and exists (select 1 from sales_lines s2
                 where s2.empresa='lk' and s2.customer_code = a.cod and s2.boxes is not null
                   and s2.invoice_date >= to_char(current_date - interval '90 days','YYYY-MM-DD'))
  order by (a.mejor - a.trim_actual) desc
  limit p_limit;
$$;


-- ---------------------------------------------------------------------------
-- 2. FILL RATE: pedido por el portal vs facturado por el ERP
-- ---------------------------------------------------------------------------
-- Tres cuidados; sin ellos el numero miente y manda a llamar al cliente equivocado:
--
--  1. RESUBMITS. El portal deja mandar dos veces el mismo pedido (Coto tiene dos
--     identicos de 853 cajas el 28/04). Se deduplica por cliente+total dentro de
--     15 dias. Sin dedup Coto daba 66%; con dedup da 82%.
--  2. DESFASAJE. Se pide en mayo y se factura en junio. Por eso se compara
--     ACUMULADO sobre una ventana larga, nunca mes a mes.
--  3. LA NORMA NO ES 100%. La cartera entera da ~102-108%: no todo lo facturado
--     entra por el portal (hay pedidos por telefono y por vendedor). El texto del
--     reporte informa la norma al lado del dato, para que el desvio se lea contra
--     algo y no contra una expectativa inventada.

create or replace function public.rep_fill_rate(p_meses int default 5, p_min_cajas numeric default 300)
returns table(cod text, cliente text, pedidas numeric, facturadas numeric, pct int,
              pedidos int, resubmits int, ultimo_pedido text)
language sql stable security definer
set search_path to 'public','pg_temp'
as $$
  with lim as (select left(max(invoice_date),7) as ult from sales_lines where empresa='lk'),
  vent as (select to_char((ult||'-01')::date - ((p_meses-1)||' months')::interval,'YYYY-MM') as desde,
                  ult as hasta from lim),
  ped_raw as (
    select o.id, c.cod_cliente::text as cod, o.total,
           (o.created_at at time zone 'America/Argentina/Buenos_Aires')::date as f,
           (select sum(oi.cajas) from order_items oi where oi.order_id = o.id) as cajas
    from orders o join customers c on c.id = o.customer_id
    cross join vent
    where to_char(o.created_at at time zone 'America/Argentina/Buenos_Aires','YYYY-MM')
          between vent.desde and vent.hasta
  ),
  marcado as (
    select p.*,
           lag(p.f)     over (partition by p.cod, p.total order by p.f) as f_prev,
           lag(p.cajas) over (partition by p.cod, p.total order by p.f) as cj_prev
    from ped_raw p
  ),
  ped as (
    select cod,
           sum(cajas) filter (where not es_dup) as pedidas,
           count(*)   filter (where not es_dup) as pedidos,
           count(*)   filter (where es_dup)     as resubmits,
           max(f)::text as ultimo
    from (select m.*, (m.f_prev is not null and (m.f - m.f_prev) <= 15 and m.cajas = m.cj_prev) as es_dup
          from marcado m) x
    group by cod
  ),
  fac as (
    select sl.customer_code as cod, sum(sl.boxes) as facturadas
    from sales_lines sl cross join vent
    where sl.empresa='lk' and sl.boxes is not null
      and left(sl.invoice_date,7) between vent.desde and vent.hasta
      and sl.item_code <> all (array(select item_code from sales_excluded_items))
    group by 1
  )
  select p.cod,
         coalesce(nullif(btrim(c.business_name),''), 'Cliente '||p.cod),
         p.pedidas, coalesce(f.facturadas,0),
         round(100.0*coalesce(f.facturadas,0)/nullif(p.pedidas,0))::int,
         p.pedidos::int, p.resubmits::int, p.ultimo
  from ped p
  left join fac f on f.cod = p.cod
  left join customers c on c.cod_cliente::text = p.cod
  where p.pedidas >= p_min_cajas
  order by 5 asc nulls first;
$$;


-- ---------------------------------------------------------------------------
-- 3. TEXTO Y ENVIO
-- ---------------------------------------------------------------------------

create or replace function public.rep_texto_riesgo()
returns text language plpgsql stable security definer
set search_path to 'public','pg_temp'
as $$
declare dd text; fr text; norma int;
begin
  select string_agg(
    '▸ ' || left(d.cliente,30) || case when d.es_top20 then ' ⭐' else '' end || E'\n'
    || '   ' || d.trim_actual || ' cj/trim vs ' || d.mejor_trim || ' en su pico ('
    || d.mes_pico || ') → −' || d.caida_pct || '%' || E'\n'
    || '   última compra ' || d.ultima,
    E'\n' order by (d.mejor_trim - d.trim_actual) desc)
  into dd from public.rep_drawdown() d;

  -- Sin la norma al lado, un 82% parece malo y puede ser perfectamente normal.
  select round(100.0*sum(facturadas)/nullif(sum(pedidas),0))::int into norma
  from public.rep_fill_rate(5, 0);

  select string_agg(
    '▸ ' || left(f.cliente,30) || '  ' || f.pct || '%' || E'\n'
    || '   pidió ' || f.pedidas || ' cj, se facturaron ' || f.facturadas
    || case when f.resubmits > 0 then '  (' || f.resubmits || ' resubmit)' else '' end,
    E'\n' order by f.pct asc)
  into fr from public.rep_fill_rate(5, 300) f where f.pct < 75;

  return '🚨 CLIENTES EN RIESGO' || E'\n'
    || '━━━━━━━━━━━━━━━━━━' || E'\n\n'
    || '📉 SE ESTÁN CAYENDO (trimestre actual vs su propio pico)' || E'\n'
    || '_Solo los que todavía compran. El que ya se fue está en Ranking Inactivos._' || E'\n'
    || coalesce(dd, '  Ninguno.') || E'\n\n'
    || '📦 PIDIERON Y NO SE LES FACTURÓ' || E'\n'
    || '_Últimos 5 meses. La cartera entera está en ' || norma || '%: no todo lo'
    || ' facturado entra por el portal, así que la norma no es 100._' || E'\n'
    || coalesce(fr, '  Ninguno por debajo del 75%.') || E'\n\n'
    || '_Deduplicado de resubmits (mismo cliente, mismo monto, 15 días)._';
end $$;

create or replace function public.rep_enviar_riesgo()
returns void language plpgsql security definer
set search_path to 'public','pg_temp'
as $$
declare hoy date := (now() at time zone 'America/Argentina/Buenos_Aires')::date;
begin
  perform tg_enqueue_largo(rep_texto_riesgo(), 'riesgo_' || to_char(hoy,'IYYY_IW'));
end $$;

revoke all on function public.rep_drawdown(numeric,numeric,numeric,int) from public, anon, authenticated;
revoke all on function public.rep_fill_rate(int,numeric)                from public, anon, authenticated;
revoke all on function public.rep_texto_riesgo()                        from public, anon, authenticated;
revoke all on function public.rep_enviar_riesgo()                       from public, anon, authenticated;

select cron.schedule('reporte-riesgo-telegram','25 11 * * 1','select public.rep_enviar_riesgo()');
