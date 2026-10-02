-- =====================================================================================
-- REPORTES DE GERENCIA v2 (Telegram, chat privado de gerencia) — pedido de Luis, 02/10/2026
-- =====================================================================================
-- Contenido pedido:
--   diario : pedidos que entraron (por canal) · pedidos despachados · m3 pendientes · $ facturado · $ cobrado
--   semanal: pedidos que entraron · despachados · m3 pendientes · unidades vendidas · $ facturado · $ cobrado
--   mensual: idem semanal
--   Cada numero: total y discriminado LK / Chef (Luis, 02/10). La plata facturada va "$ X + IVA".
--
-- De donde sale cada numero:
--   pedidos que entraron -> orders (LK, canal de v_orders_origen) + chef_orders_cache (Chef). El canal de Chef
--                           se arma igual que el de LK: el source del pedido + QUIEN lo cargo, que sale del
--                           usuario de sesion del pedido en la base de Chef (chef_ext.orders_quien) cruzado con
--                           el padron (chef_ext.customers_quien): el propio cliente / un perfil de vendedor
--                           (cod 10000-19999) / administracion (cuenta Chef S.R.L. o usuario sin cliente).
--                           Si Chef no contesta, esos pedidos salen "Sin identificar" y el reporte igual sale.
--                           Fuera: clientes de prueba (1, 3878, 99862), pedidos sin sheets_payload (los
--                           reintentos del 11-14/09 que nunca llegaron a Gestion) y la parte diferida de un
--                           pedido partido viejo (ya no se parten, 30/09). Un presupuesto de exportacion va aparte.
--   despachados          -> virgilio.gv_rep_gerencia_np (vista de Gestion): pedidos con alguna NP cuya
--                           PRIMERA Carga Camion (CCN) cae en el periodo. Cuenta PEDIDOS, no NP
--                           (septiembre: 347 NP = 220 pedidos). NP web -> su order_id; NP de ISIS -> cliente+tanda.
--   m3 pendientes        -> foto al momento del envio: programado en la PPP sin CCN + pedidos web desde el
--                           05/09 que todavia no se programaron (ni cancelados).
--   unidades vendidas    -> cajas facturadas (FC - NC) x unidades por caja (vista_uxb_articulo de Gestion).
--   $ facturado          -> comprobantes de ISIS parseados: FC + ND - NC, SIN IVA (se muestra "+ IVA").
--   Fuera de las dos ultimas: ventas entre empresas (ventas_clientes_internos) y codigos administrativos.
--   $ cobrado            -> conciliacion bancaria de Gestion (virgilio.gv_rep_gerencia_cobrado): lo que se
--                           ACREDITO en el banco (con IVA) arriba de la linea amarilla de cada cuenta: depositos y
--                           transferencias de clientes, cheques acreditados y lo "No identificado" (cliente sin
--                           imputar). Fuera: transferencias propias, venta de cheques, inversiones, devoluciones y
--                           los clientes internos. Si una cuenta no esta conciliada hasta el fin del periodo, el
--                           texto lo avisa (virgilio.gv_rep_gerencia_conc_al).
--
-- El lado Gestion esta en Gestion-Virgilio/sql/gv_rep_gerencia_np_v2608.sql y gv_rep_gerencia_cobrado_v2611.sql.
-- =====================================================================================

-- 0) tablas externas
--    Gestion (FDW virgilio_db, rol lk_ppp_reader)
import foreign schema public limit to (gv_rep_gerencia_np) from server virgilio_db into virgilio;
import foreign schema public limit to ("GV_Web_Cancelados") from server virgilio_db into virgilio;
import foreign schema public limit to (gv_rep_gerencia_cobrado, gv_rep_gerencia_conc_al) from server virgilio_db into virgilio;
revoke all on virgilio.gv_rep_gerencia_np from anon, authenticated;
revoke all on virgilio."GV_Web_Cancelados" from anon, authenticated;
revoke all on virgilio.gv_rep_gerencia_cobrado, virgilio.gv_rep_gerencia_conc_al from anon, authenticated;
--    Chef (FDW chef_db): quien cargo cada pedido. Foraneas propias, aisladas de public.chef_orders (sync del armado).
create foreign table if not exists chef_ext.orders_quien (
  id bigint, created_at timestamptz, customer_id uuid, auth_user_id uuid)
  server chef_db options (schema_name 'public', table_name 'orders');
create foreign table if not exists chef_ext.customers_quien (
  id uuid, auth_user_id uuid, cod_cliente bigint)
  server chef_db options (schema_name 'public', table_name 'customers');
revoke all on chef_ext.orders_quien, chef_ext.customers_quien from anon, authenticated;

-- 1) formato: coma decimal, punto de miles
create or replace function public.rep_ger_num(p numeric, p_dec int default 0)
returns text language sql immutable set search_path = public, pg_temp as $$
  select case when p is null then '—' else
    translate(to_char(round(p, p_dec),
      'FM999,999,999,990' || case when p_dec > 0 then '.' || repeat('0', p_dec) else '' end), ',.', '.,') end
$$;

create or replace function public.rep_ger_plata(p numeric)
returns text language sql immutable set search_path = public, pg_temp as $$
  select case when p is null then '—'
    when abs(p) >= 1e6 then '$ ' || public.rep_ger_num(p / 1e6, 1) || ' M'
    when abs(p) >= 1e3 then '$ ' || public.rep_ger_num(p / 1e3, 0) || ' k'
    else '$ ' || public.rep_ger_num(p, 0) end
$$;

-- plata sin IVA (facturado): "$ 36,8 M + IVA"
create or replace function public.rep_ger_plata_iva(p numeric)
returns text language sql immutable set search_path = public, pg_temp as $$
  select public.rep_ger_plata(p) || case when p is null then '' else ' + IVA' end
$$;

create or replace function public.rep_ger_var(p_act numeric, p_prev numeric, p_txt text)
returns text language sql immutable set search_path = public, pg_temp as $$
  select case when coalesce(p_prev, 0) = 0 then ''
    when round((p_act / p_prev - 1) * 100) = 0 then '  (= ' || p_txt || ')'
    when p_act > p_prev then '  (▲' || round((p_act / p_prev - 1) * 100) || '% ' || p_txt || ')'
    else '  (▼' || abs(round((p_act / p_prev - 1) * 100)) || '% ' || p_txt || ')' end
$$;

create or replace function public.rep_ger_m3(p numeric)
returns text language sql immutable set search_path = public, pg_temp as $$
  select public.rep_ger_num(p, case when abs(coalesce(p, 0)) < 1 and coalesce(p, 0) <> 0 then 3 else 1 end) || ' m³'
$$;

-- 2a) Chef: quien cargo cada pedido (usuario de sesion del pedido contra el padron de Chef).
--     El padron se trae UNA vez (materialized): un exists contra la foranea por fila haria una consulta remota
--     por pedido. Si Chef no contesta devuelve vacio y los pedidos salen "Sin identificar".
create or replace function public.rep_ger_chef_quien(p_desde date, p_hasta date)
returns table(id bigint, quien text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  return query
    with cu as materialized (select c.id, c.auth_user_id, c.cod_cliente from chef_ext.customers_quien c),
    o as materialized (
      select o.id, o.customer_id, o.auth_user_id from chef_ext.orders_quien o
       where o.created_at >= (p_desde::timestamp at time zone 'America/Argentina/Buenos_Aires')
         and o.created_at <  ((p_hasta + 1)::timestamp at time zone 'America/Argentina/Buenos_Aires'))
    select o.id,
           case when o.auth_user_id is null then null
                when o.auth_user_id = c.auth_user_id then 'cliente'
                when exists (select 1 from cu v where v.auth_user_id = o.auth_user_id
                                and v.cod_cliente between 10000 and 19999) then 'vendedor'
                when exists (select 1 from cu v where v.auth_user_id = o.auth_user_id
                                and v.cod_cliente not in (1, 2)) then 'vendedor'
                else 'admin' end
      from o left join cu c on c.id = o.customer_id;
exception when others then
  raise notice 'rep_ger_chef_quien: Chef no contesta (%)', sqlerrm;
  return;
end $$;

-- 2b) pedidos que ENTRARON por canal (mismas etiquetas en LK y Chef)
create or replace function public.rep_ger_pedidos(p_desde date, p_hasta date)
returns table(empresa text, canal text, n bigint)
language sql stable security definer set search_path = public, pg_temp as $$
  with lk as (
    select 'lk'::text as empresa,
      case when coalesce(o.sheets_payload->>'tipo_documento', '') = 'presupuesto' then 'Presupuesto (no se despacha)'
           when v.origen_pedido in ('previo_tracking', 'desconocido') then 'Sin identificar'
           when v.herramienta = 'Mayorista web' and v.origen_pedido = 'cliente' then 'Web del cliente'
           when v.herramienta = 'Mayorista web' then 'Vendedor (web)'
           when v.herramienta = 'Excels Megashops' then 'Vendedor (Excel)'
           when v.herramienta = 'Cotizador' then 'Cotizador'
           when v.herramienta = 'Cotizador Supermercados' then 'Supermercados (OC)'
           when v.herramienta = 'Sin Cotizador' then 'Carga manual admin'
           when v.herramienta = 'Pedidos Expo' then 'Expo'
           else coalesce(v.herramienta, 'Sin identificar') end as canal
      from public.orders o
      join public.v_orders_origen v on v.order_id = o.id
      join public.customers c on c.id = o.customer_id
     where (o.created_at at time zone 'America/Argentina/Buenos_Aires')::date between p_desde and p_hasta
       and o.sheets_payload is not null
       and not v.es_prueba
       and c.cod_cliente::text <> '99862'                       -- cliente de prueba (GV_Clientes_Prueba)
       and nullif(o.sheets_payload->>'pedido_origen', '') is null),
  q as materialized (select * from public.rep_ger_chef_quien(p_desde, p_hasta)),
  ch as (
    select 'chef'::text,
      case when coalesce(o.sheets_payload->>'tipo_documento', '') = 'presupuesto' then 'Presupuesto (no se despacha)'
           when src = 'Krikos' then 'Supermercados (OC)'
           when src = 'Cotizador' then 'Cotizador'
           when src in ('Web', 'Excel', 'Sin Cotizador') and q.quien is null then 'Sin identificar'
           when src = 'Web' and q.quien = 'cliente' then 'Web del cliente'
           when src = 'Web' and q.quien = 'vendedor' then 'Vendedor (web)'
           when src = 'Excel' and q.quien = 'vendedor' then 'Vendedor (Excel)'
           when src in ('Web', 'Excel', 'Sin Cotizador') then 'Carga manual admin'
           else src end
      from public.chef_orders_cache o
      cross join lateral (select coalesce(nullif(o.sheets_payload->>'source', ''), 'Web') as src) s
      left join q on q.id = o.id
     where (o.created_at at time zone 'America/Argentina/Buenos_Aires')::date between p_desde and p_hasta
       and coalesce(o.sheets_payload->>'cod_cliente', o.sheets_payload->>'codCliente', '') <> '1'
       and nullif(o.sheets_payload->>'pedido_origen', '') is null)
  select empresa, canal, count(*) from (select * from lk union all select * from ch) x group by 1, 2
$$;

-- 3) pedidos DESPACHADOS (primera CCN de alguna NP del pedido en el periodo)
create or replace function public.rep_ger_despachos(p_desde date, p_hasta date)
returns table(empresa text, pedidos bigint, nps bigint, m3 numeric)
language sql stable security definer set search_path = public, pg_temp as $$
  select g.empresa, count(distinct g.pedido_key), count(*), coalesce(sum(g.m3), 0)
    from virgilio.gv_rep_gerencia_np g
   where g.salio_el between p_desde and p_hasta
     and not (g.empresa = 'lk' and coalesce(g.cod_cliente, '') = '99862')
   group by 1
$$;

-- 4) m3 PENDIENTES (foto al momento)
-- Por empresa (LK / Chef). Nombre nuevo a proposito: un DROP de la vieja se cuelga desde el MCP de la sesion.
-- La vieja public.rep_ger_pendientes() (sin empresa) queda sin uso; se borra a mano en el SQL editor:
--   drop function if exists public.rep_ger_pendientes();
create or replace function public.rep_ger_pendientes_emp()
returns table(empresa text, tipo text, pedidos bigint, m3 numeric)
language sql stable security definer set search_path = public, pg_temp as $$
  with g as (select * from virgilio.gv_rep_gerencia_np),
  prog as (
    select g.empresa, g.pedido_key, g.m3 from g
     where g.salio_el is null and not g.cancelado
       and (g.es_web or g.fecha_entrega is not null)
       and not (g.empresa = 'lk' and coalesce(g.cod_cliente, '') = '99862')),
  conocidos as (select distinct g.empresa, g.order_id from g where g.es_web
                union select lower(c.empresa), c.order_id from virgilio."GV_Web_Cancelados" c),
  feed as (
    select 'lk'::text as empresa, f.order_id, f.m3, f.cod, f.observaciones from public.gv_pedidos_web_np_lk(date '2026-09-05') f
    union all
    select 'chef', f.order_id, f.m3, f.cod, f.observaciones from public.gv_pedidos_web_np_chef(60) f where f.fecha_recep >= date '2026-09-05'),
  sinprog as (
    select f.empresa, f.empresa || ':' || f.order_id as pedido_key, f.m3 from feed f
     where not exists (select 1 from conocidos k where k.empresa = f.empresa and k.order_id = f.order_id)
       and coalesce(f.observaciones, '') not ilike 'PRESUPUESTO%'
       and not (f.empresa = 'lk' and coalesce(f.cod, '') = '99862'))
  select empresa, 'programado', count(distinct pedido_key), coalesce(sum(m3), 0) from prog group by 1
  union all
  select empresa, 'sin_programar', count(distinct pedido_key), coalesce(sum(m3), 0) from sinprog group by 1
$$;

-- 5) $ FACTURADO sin IVA (FC + ND - NC), sin ventas entre empresas
create or replace function public.rep_ger_facturado(p_desde date, p_hasta date)
returns table(empresa text, fc numeric, nc numeric, neto numeric)
language sql stable security definer set search_path = public, pg_temp as $$
  select case v.marca when 'CH' then 'chef' else 'lk' end,
         coalesce(sum(v.subtotal) filter (where v.signo > 0), 0),
         coalesce(sum(v.subtotal) filter (where v.signo < 0), 0),
         coalesce(sum(v.signo * v.subtotal), 0)
    from virgilio.comprobantes_venta v
   where v.fecha between p_desde and p_hasta
     and v.familia in ('factura_venta', 'nc_venta', 'nd_venta')
     and not exists (select 1 from public.ventas_clientes_internos i
                      where i.empresa = case v.marca when 'CH' then 'chef' else 'lk' end
                        and ltrim(i.cod_cliente, '0') = ltrim(coalesce(v.contraparte_codigo, ''), '0'))
   group by 1
$$;

-- 6) UNIDADES VENDIDAS = cajas facturadas (FC - NC) x UxB
create or replace function public.rep_ger_unidades(p_desde date, p_hasta date)
returns table(empresa text, cajas numeric, unidades numeric, cajas_sin_uxb numeric)
language sql stable security definer set search_path = public, pg_temp as $$
  with u as (select upper(btrim(cod)) as cod, max(uxb) as uxb from virgilio.vista_uxb_articulo where uxb > 0 group by 1),
  v as (
    select v.empresa, upper(btrim(v.cod_articulo)) as cod_raw,
           regexp_replace(upper(btrim(v.cod_articulo)), '([0-9E])L$', '\1') as cod, v.cajas
      from virgilio.isis_ventas v
     where v.fecha between p_desde and p_hasta
       and not exists (select 1 from public.sales_excluded_items x where x.item_code = v.cod_articulo)
       and upper(v.cod_articulo) !~ '^(PAGO|DTO|DEV|P[0-9])'
       and not exists (select 1 from public.ventas_clientes_internos i
                        where i.empresa = v.empresa and ltrim(i.cod_cliente, '0') = ltrim(coalesce(v.cod_cliente, ''), '0'))),
  j as (select v.empresa, v.cajas, coalesce(u1.uxb, u2.uxb, u3.uxb) as uxb
          from v left join u u1 on u1.cod = v.cod_raw left join u u2 on u2.cod = v.cod
                 left join u u3 on u3.cod = ltrim(v.cod, '0'))
  select empresa, coalesce(sum(cajas), 0), coalesce(sum(cajas * uxb), 0),
         coalesce(sum(cajas) filter (where uxb is null), 0)
    from j group by 1
$$;

-- 7) $ COBRADO (acreditado en banco, con IVA) desde la conciliacion de Gestion, sin clientes internos
create or replace function public.rep_ger_cobrado(p_desde date, p_hasta date)
returns table(empresa text, cliente numeric, sin_identificar numeric)
language sql stable security definer set search_path = public, pg_temp as $$
  select c.empresa,
         coalesce(sum(c.monto) filter (where c.clase = 'cliente'), 0),
         coalesce(sum(c.monto) filter (where c.clase = 'sin_identificar'), 0)
    from virgilio.gv_rep_gerencia_cobrado c
   where c.fecha between p_desde and p_hasta
     and not exists (select 1 from public.ventas_clientes_internos i
                      where i.empresa = c.empresa and ltrim(i.cod_cliente, '0') = ltrim(coalesce(c.cod_cliente, ''), '0'))
   group by 1
$$;

-- 8) textos
create or replace function public.rep_ger_texto(p_tipo text, p_titulo text, p_desde date, p_hasta date,
  p_prev_desde date default null, p_prev_hasta date default null, p_cmp text default null)
returns text language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  t text; canales text; falta text;
  ped_lk bigint; ped_ch bigint; presup bigint; ped_prev bigint;
  des_lk bigint; des_ch bigint; m3_lk numeric; m3_ch numeric; des_prev bigint;
  pp_n bigint; pp_m3 numeric; ps_n bigint; ps_m3 numeric;
  pe_lk_n bigint; pe_lk_m3 numeric; pe_ch_n bigint; pe_ch_m3 numeric;
  f_lk numeric; f_ch numeric; f_fc numeric; f_nc numeric; f_prev numeric;
  u_lk numeric; u_ch numeric; cj numeric; cj_sin numeric; u_prev numeric;
  c_lk numeric; c_ch numeric; c_sin numeric; c_prev numeric;
  cmp boolean := p_prev_desde is not null;
  ahora text := to_char(now() at time zone 'America/Argentina/Buenos_Aires', 'DD/MM HH24:MI');
begin
  t := '📊 ' || p_titulo || E'\n━━━━━━━━━━━━━━━━━━\n';

  -- 1) pedidos que entraron (una sola llamada: la parte de Chef cruza la base de Chef)
  with p as materialized (select * from public.rep_ger_pedidos(p_desde, p_hasta)),
  c as (select canal, sum(n) tot, coalesce(sum(n) filter (where empresa = 'lk'), 0) lk,
               coalesce(sum(n) filter (where empresa = 'chef'), 0) ch
          from p where canal not like 'Presupuesto%' group by canal)
  select (select coalesce(sum(n), 0) from p where empresa = 'lk' and canal not like 'Presupuesto%'),
         (select coalesce(sum(n), 0) from p where empresa = 'chef' and canal not like 'Presupuesto%'),
         (select coalesce(sum(n), 0) from p where canal like 'Presupuesto%'),
         (select string_agg(E'\n   • ' || canal || ': ' || tot || ' ('
                   || case when lk > 0 and ch > 0 then 'LK ' || lk || ' · Chef ' || ch
                           when lk > 0 then 'LK ' || lk else 'Chef ' || ch end || ')', '' order by tot desc, canal) from c)
    into ped_lk, ped_ch, presup, canales;
  t := t || E'\n🛒 PEDIDOS QUE ENTRARON: ' || (ped_lk + ped_ch);
  if cmp then
    select coalesce(sum(n) filter (where canal not like 'Presupuesto%'), 0) into ped_prev
      from public.rep_ger_pedidos(p_prev_desde, p_prev_hasta);
    t := t || public.rep_ger_var(ped_lk + ped_ch, ped_prev, p_cmp);
  end if;
  t := t || E'\n   LK ' || ped_lk || ' · Chef ' || ped_ch;
  if p_tipo = 'diario' then t := t || coalesce(canales, ''); end if;
  if presup > 0 then t := t || E'\n   + ' || presup || ' presupuesto(s) de exportación (no se despachan)'; end if;

  -- 2) pedidos despachados (salieron en camion: primera CCN)
  select coalesce(sum(pedidos) filter (where empresa = 'lk'), 0), coalesce(sum(pedidos) filter (where empresa = 'chef'), 0),
         coalesce(sum(m3) filter (where empresa = 'lk'), 0), coalesce(sum(m3) filter (where empresa = 'chef'), 0)
    into des_lk, des_ch, m3_lk, m3_ch from public.rep_ger_despachos(p_desde, p_hasta);
  t := t || E'\n\n🚚 PEDIDOS DESPACHADOS: ' || (des_lk + des_ch) || ' · ' || public.rep_ger_m3(m3_lk + m3_ch);
  if cmp then
    select coalesce(sum(pedidos), 0) into des_prev from public.rep_ger_despachos(p_prev_desde, p_prev_hasta);
    t := t || public.rep_ger_var(des_lk + des_ch, des_prev, p_cmp);
  end if;
  t := t || E'\n   LK ' || des_lk || ' · ' || public.rep_ger_m3(m3_lk)
         || E'\n   Chef ' || des_ch || ' · ' || public.rep_ger_m3(m3_ch);

  -- 3) m3 pendientes (foto al momento del envio)
  select coalesce(sum(pedidos) filter (where tipo = 'programado'), 0), coalesce(sum(m3) filter (where tipo = 'programado'), 0),
         coalesce(sum(pedidos) filter (where tipo = 'sin_programar'), 0), coalesce(sum(m3) filter (where tipo = 'sin_programar'), 0),
         coalesce(sum(pedidos) filter (where empresa = 'lk'), 0), coalesce(sum(m3) filter (where empresa = 'lk'), 0),
         coalesce(sum(pedidos) filter (where empresa = 'chef'), 0), coalesce(sum(m3) filter (where empresa = 'chef'), 0)
    into pp_n, pp_m3, ps_n, ps_m3, pe_lk_n, pe_lk_m3, pe_ch_n, pe_ch_m3 from public.rep_ger_pendientes_emp();
  t := t || E'\n\n📦 M³ PENDIENTES (al ' || ahora || '): ' || public.rep_ger_m3(pp_m3 + ps_m3) || ' · ' || (pp_n + ps_n) || ' ped.'
         || E'\n   LK ' || public.rep_ger_m3(pe_lk_m3) || ' · ' || pe_lk_n || ' ped.'
         || E'\n   Chef ' || public.rep_ger_m3(pe_ch_m3) || ' · ' || pe_ch_n || ' ped.'
         || E'\n   Programados ' || public.rep_ger_m3(pp_m3) || ' (' || pp_n || ' ped.) · sin programar '
         || public.rep_ger_m3(ps_m3) || ' (' || ps_n || ' ped.)';

  -- 4) unidades vendidas (semanal y mensual)
  if p_tipo <> 'diario' then
    select coalesce(sum(unidades) filter (where empresa = 'lk'), 0), coalesce(sum(unidades) filter (where empresa = 'chef'), 0),
           coalesce(sum(cajas), 0), coalesce(sum(cajas_sin_uxb), 0)
      into u_lk, u_ch, cj, cj_sin from public.rep_ger_unidades(p_desde, p_hasta);
    t := t || E'\n\n🏷 UNIDADES VENDIDAS: ' || public.rep_ger_num(u_lk + u_ch) || ' u (' || public.rep_ger_num(cj) || ' cajas)';
    if cmp then
      select coalesce(sum(unidades), 0) into u_prev from public.rep_ger_unidades(p_prev_desde, p_prev_hasta);
      t := t || public.rep_ger_var(u_lk + u_ch, u_prev, p_cmp);
    end if;
    t := t || E'\n   LK ' || public.rep_ger_num(u_lk) || ' u'
           || E'\n   Chef ' || public.rep_ger_num(u_ch) || ' u';
    if cj_sin <> 0 then t := t || E'\n   (' || public.rep_ger_num(cj_sin) || ' cajas sin unidades por caja cargadas, no suman)'; end if;
  end if;

  -- 5) $ facturado (facturas - NC, neto: se muestra "+ IVA")
  select coalesce(sum(neto) filter (where empresa = 'lk'), 0), coalesce(sum(neto) filter (where empresa = 'chef'), 0),
         coalesce(sum(fc), 0), coalesce(sum(nc), 0)
    into f_lk, f_ch, f_fc, f_nc from public.rep_ger_facturado(p_desde, p_hasta);
  t := t || E'\n\n🧾 FACTURADO: ' || public.rep_ger_plata_iva(f_lk + f_ch);
  if cmp then
    select coalesce(sum(neto), 0) into f_prev from public.rep_ger_facturado(p_prev_desde, p_prev_hasta);
    t := t || public.rep_ger_var(f_lk + f_ch, f_prev, p_cmp);
  end if;
  t := t || E'\n   LK ' || public.rep_ger_plata_iva(f_lk)
         || E'\n   Chef ' || public.rep_ger_plata_iva(f_ch)
         || E'\n   Facturas ' || public.rep_ger_plata(f_fc) || ' · notas de crédito −' || public.rep_ger_plata(f_nc) || ' (+ IVA)';

  -- 6) $ cobrado (acreditado en el banco, IVA incluido)
  select coalesce(sum(cliente + sin_identificar) filter (where empresa = 'lk'), 0),
         coalesce(sum(cliente + sin_identificar) filter (where empresa = 'chef'), 0),
         coalesce(sum(sin_identificar), 0)
    into c_lk, c_ch, c_sin from public.rep_ger_cobrado(p_desde, p_hasta);
  t := t || E'\n\n💰 COBRADO (acreditado en banco, IVA incluido): ' || public.rep_ger_plata(c_lk + c_ch);
  if cmp then
    select coalesce(sum(cliente + sin_identificar), 0) into c_prev from public.rep_ger_cobrado(p_prev_desde, p_prev_hasta);
    t := t || public.rep_ger_var(c_lk + c_ch, c_prev, p_cmp);
  end if;
  t := t || E'\n   LK ' || public.rep_ger_plata(c_lk)
         || E'\n   Chef ' || public.rep_ger_plata(c_ch);
  if c_sin > 0 then t := t || E'\n   (' || public.rep_ger_plata(c_sin) || ' todavía sin imputar a un cliente)'; end if;
  select string_agg(initcap(a.banco) || ' ' || case a.empresa when 'lk' then 'LK' else 'Chef' end
                    || ' (al ' || to_char(a.conciliado_al, 'DD/MM') || ')', ', ' order by a.empresa, a.banco)
    into falta from virgilio.gv_rep_gerencia_conc_al a where a.conciliado_al < p_hasta;
  if falta is not null then t := t || E'\n   ⚠ Sin conciliar hasta el ' || to_char(p_hasta, 'DD/MM') || ': ' || falta; end if;
  return t;
end $$;

create or replace function public.rep_ger_texto_diario(p_fecha date default null)
returns text language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  hoy date := coalesce(p_fecha, (now() at time zone 'America/Argentina/Buenos_Aires')::date);
  dias text[] := array['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
  d1 date; d2 date := hoy - 1; tit text;
begin
  -- el lunes cubre sabado y domingo: el diario no sale el domingo y lo del fin de semana no se pierde
  d1 := case when extract(dow from hoy) = 1 then hoy - 2 else d2 end;
  tit := 'DIARIO · ' || case when d1 = d2
           then dias[extract(dow from d2)::int + 1] || ' ' || to_char(d2, 'DD/MM/YYYY')
           else dias[extract(dow from d1)::int + 1] || ' ' || to_char(d1, 'DD/MM') || ' y '
                || dias[extract(dow from d2)::int + 1] || ' ' || to_char(d2, 'DD/MM/YYYY') end;
  return public.rep_ger_texto('diario', tit, d1, d2);
end $$;

create or replace function public.rep_ger_texto_semanal(p_fecha date default null)
returns text language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  hoy date := coalesce(p_fecha, (now() at time zone 'America/Argentina/Buenos_Aires')::date);
  d2 date := hoy - extract(isodow from hoy)::int;   -- el domingo anterior
  d1 date := d2 - 6;
begin
  return public.rep_ger_texto('semanal', 'SEMANAL · ' || to_char(d1, 'DD/MM') || ' al ' || to_char(d2, 'DD/MM/YYYY'),
                              d1, d2, d1 - 7, d2 - 7, 'vs semana previa');
end $$;

create or replace function public.rep_ger_texto_mensual(p_fecha date default null)
returns text language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  hoy date := coalesce(p_fecha, (now() at time zone 'America/Argentina/Buenos_Aires')::date);
  meses text[] := array['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
  d1 date := (date_trunc('month', hoy) - interval '1 month')::date;
  d2 date := (date_trunc('month', hoy) - interval '1 day')::date;
  p1 date := (date_trunc('month', hoy) - interval '2 month')::date;
begin
  return public.rep_ger_texto('mensual', 'MENSUAL · ' || meses[extract(month from d1)::int] || ' ' || extract(year from d1),
                              d1, d2, p1, d1 - 1, 'vs ' || meses[extract(month from p1)::int]);
end $$;

revoke execute on function public.rep_ger_pedidos(date,date), public.rep_ger_despachos(date,date), public.rep_ger_pendientes_emp(),
  public.rep_ger_pendientes(), public.rep_ger_facturado(date,date), public.rep_ger_unidades(date,date),
  public.rep_ger_chef_quien(date,date), public.rep_ger_cobrado(date,date), public.rep_ger_plata_iva(numeric),
  public.rep_ger_texto(text,text,date,date,date,date,text), public.rep_ger_texto_diario(date),
  public.rep_ger_texto_semanal(date), public.rep_ger_texto_mensual(date) from public, anon, authenticated;

-- Vista previa (no manda nada):
--   select public.rep_ger_texto_diario();               -- lo que saldria hoy
--   select public.rep_ger_texto_semanal('2026-09-28');  -- semana 21/09 al 27/09
--   select public.rep_ger_texto_mensual('2026-10-03');  -- septiembre

-- =====================================================================================
-- 8) EL PASE (PENDIENTE del "si" de Luis): los crons 29/30/31 siguen igual, cambia el texto.
--    Claves de dedup nuevas (ger_*) para no chocar con las de los reportes viejos.
-- =====================================================================================
-- create or replace function public.rep_enviar_diario() returns void language plpgsql security definer
-- set search_path to 'public', 'pg_temp' as $function$
-- declare f date := (now() at time zone 'America/Argentina/Buenos_Aires')::date - 1;
-- begin
--   perform rep_snapshot_despacho(30);
--   perform tg_enqueue_largo(rep_ger_texto_diario(), 'ger_diario_' || to_char(f,'YYYYMMDD'));
-- end $function$;
--
-- create or replace function public.rep_enviar_semanal() returns void language plpgsql security definer
-- set search_path to 'public', 'pg_temp' as $function$
-- declare hoy date := (now() at time zone 'America/Argentina/Buenos_Aires')::date;
-- begin
--   perform tg_enqueue_largo(rep_ger_texto_semanal(hoy),
--                            'ger_semanal_' || to_char(date_trunc('week',hoy)::date - 7,'IYYY_IW'));
-- end $function$;
--
-- create or replace function public.rep_enviar_mensual() returns void language plpgsql security definer
-- set search_path to 'public', 'pg_temp' as $function$
-- declare hoy date := (now() at time zone 'America/Argentina/Buenos_Aires')::date;
-- begin
--   perform tg_enqueue_largo(rep_ger_texto_mensual(hoy),
--                            'ger_mensual_' || to_char(date_trunc('month',hoy) - interval '1 month','YYYY_MM'));
-- end $function$;

-- ROLLBACK del pase (definiciones vivas al 02/10/2026, antes de tocarlas):
-- create or replace function public.rep_enviar_diario() returns void language plpgsql security definer
-- set search_path to 'public', 'pg_temp' as $function$
-- declare f date := (now() at time zone 'America/Argentina/Buenos_Aires')::date - 1;
-- begin
--   perform rep_snapshot_despacho(30);
--   perform tg_enqueue_largo(rep_texto_diario(f), 'diario_' || to_char(f,'YYYYMMDD'));
-- end $function$;
-- create or replace function public.rep_enviar_semanal() returns void language plpgsql security definer
-- set search_path to 'public', 'pg_temp' as $function$
-- declare hoy date := (now() at time zone 'America/Argentina/Buenos_Aires')::date;
-- begin
--   perform tg_enqueue_largo(rep_texto_semanal(hoy),
--                            'semanal_' || to_char(date_trunc('week',hoy)::date - 7,'IYYY_IW'));
-- end $function$;
-- create or replace function public.rep_enviar_mensual() returns void language plpgsql security definer
-- set search_path to 'public', 'pg_temp' as $function$
-- declare mes text;
-- begin
--   select data#>>'{resumen,mes}' into mes from gv_dash_cache where id = 1;
--   if mes is null then return; end if;
--   perform tg_enqueue_largo(rep_texto_mensual(), 'mensual_' || mes);
-- end $function$;
