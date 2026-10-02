-- =====================================================================================
-- REPORTES DE GERENCIA v2 (Telegram, chat privado de gerencia) — pedido de Luis, 02/10/2026
-- =====================================================================================
-- Contenido pedido:
--   diario : pedidos que entraron (por canal) · pedidos despachados · m3 pendientes · $ facturado · $ cobrado
--   semanal: pedidos que entraron · despachados · m3 pendientes · unidades vendidas · $ facturado · $ cobrado
--   mensual: idem semanal
--   Cada numero: total y discriminado LK / Chef (Luis, 02/10). La plata va con todos los digitos,
--   redondeada al peso ("$ 36.812.345 + IVA" lo facturado; lo cobrado ya trae el IVA).
--   Al final de cada reporte: boton "📄 Si, mandame el formato antiguo" (seccion 9).
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
--                           los clientes internos. Va SOLO hasta el ultimo dia completo (las cuatro cuentas
--                           subidas, virgilio.gv_rep_gerencia_conc_cargas) y cubre lo que se completo desde el
--                           reporte anterior: nunca se pierde ni se repite un dia (seccion 7b). Una cuenta cuya
--                           linea quedo atras (Santander LK al 01/09) sale con aviso.
--
-- El lado Gestion esta en Gestion-Virgilio/sql/gv_rep_gerencia_np_v2608.sql, gv_rep_gerencia_cobrado_v2611.sql y
-- gv_rep_gerencia_conc_cargas_v2613.sql.
-- =====================================================================================

-- 0) tablas externas
--    Gestion (FDW virgilio_db, rol lk_ppp_reader)
import foreign schema public limit to (gv_rep_gerencia_np) from server virgilio_db into virgilio;
import foreign schema public limit to ("GV_Web_Cancelados") from server virgilio_db into virgilio;
import foreign schema public limit to (gv_rep_gerencia_cobrado, gv_rep_gerencia_conc_al) from server virgilio_db into virgilio;
revoke all on virgilio.gv_rep_gerencia_np from anon, authenticated;
revoke all on virgilio."GV_Web_Cancelados" from anon, authenticated;
revoke all on virgilio.gv_rep_gerencia_cobrado, virgilio.gv_rep_gerencia_conc_al from anon, authenticated;
--    v26.13 de Gestion: cuando se subio cada cuenta (cobrado del ultimo dia completo)
alter foreign table virgilio.gv_rep_gerencia_conc_al add column if not exists ultima_carga timestamptz;
import foreign schema public limit to (gv_rep_gerencia_conc_cargas) from server virgilio_db into virgilio;
revoke all on virgilio.gv_rep_gerencia_conc_cargas from anon, authenticated;
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

-- plata con todos los digitos, redondeada al peso (Luis, 02/10: "completos redondeando decimales")
create or replace function public.rep_ger_plata(p numeric)
returns text language sql immutable set search_path = public, pg_temp as $$
  select case when p is null then '—'
    when round(p) < 0 then '−$ ' || public.rep_ger_num(-p, 0)
    else '$ ' || public.rep_ger_num(p, 0) end
$$;

-- plata sin IVA (facturado): "$ 36.812.345 + IVA"
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

-- 7b) hasta que dia esta COMPLETO lo cobrado, visto desde un momento dado (el envio del reporte).
--     Completo = TODAS las cuentas tienen una carga de la conciliacion posterior a ese dia: el extracto de
--     ayer se sube hoy a la manana, asi que una carga del dia X deja completo hasta X-1 [Probable: lo hace
--     la persona que concilia, no un proceso]. Una cuenta sin cargas en 7 dias no frena a las demas: sale aparte.
create or replace function public.rep_ger_cobrado_completo(p_corte timestamptz, p_hasta date default null)
returns table(completo_al date, sin_cargar text, falta text, n_falta int, n_activas int)
language sql stable security definer set search_path = public, pg_temp as $$
  with k as materialized (
    select g.banco, g.empresa, max(g.cargado_en) carga
      from virgilio.gv_rep_gerencia_conc_cargas g where g.cargado_en < p_corte group by 1, 2),
  a as (
    select initcap(l.banco) || ' ' || case l.empresa when 'lk' then 'LK' else 'Chef' end cuenta, l.empresa, l.banco, k.carga,
           (k.carga at time zone 'America/Argentina/Buenos_Aires')::date - 1 completo_al,
           coalesce(k.carga >= p_corte - interval '7 days', false) activa
      from virgilio.gv_rep_gerencia_conc_al l left join k on k.banco = l.banco and k.empresa = l.empresa)
  select min(completo_al) filter (where activa),
         string_agg(cuenta || ' (última carga ' || coalesce(to_char(carga at time zone 'America/Argentina/Buenos_Aires', 'DD/MM'), '—') || ')',
                    ', ' order by empresa, banco) filter (where not activa),
         -- las cuentas activas que todavia no tienen subido p_hasta
         string_agg(cuenta, ', ' order by empresa, banco) filter (where activa and completo_al < p_hasta),
         (count(*) filter (where activa and completo_al < p_hasta))::int,
         (count(*) filter (where activa))::int
    from a
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
  cc record; hh interval; c_desde date; c_hasta date; pv_d date; pv_h date; viejas text;
  dias text[] := array['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
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

  -- 6) $ cobrado (acreditado en el banco, IVA incluido). Luis, 02/10: "se sigue mandando a las 8 con lo que
  --    haya y se avisa de lo cobrado el ultimo plazo completo". Se informa lo que se COMPLETO desde el reporte
  --    anterior (ver rep_ger_cobrado_completo): si a las 08:00 ninguna cuenta subio el extracto de ayer, ese dia
  --    va en el reporte siguiente, nunca se pierde ni se repite. Los dos cortes son el horario del envio
  --    (08:00 el diario, 08:15 el semanal), asi la vista previa de un dia pasado da lo mismo que se mando.
  --    El mensual (dia 3) mira el mes entero con lo cargado hasta ahora.
  if p_tipo = 'mensual' then
    select * into cc from public.rep_ger_cobrado_completo(now(), p_hasta);
    c_desde := p_desde;
  else
    hh := case p_tipo when 'diario' then interval '8 hours' else interval '8 hours 15 minutes' end;
    select * into cc from public.rep_ger_cobrado_completo(
      least(now(), ((p_hasta + 1)::timestamp + hh) at time zone 'America/Argentina/Buenos_Aires'), p_hasta);
    -- el reporte anterior salio el dia p_desde a la misma hora (el lunes del diario: el sabado)
    select coalesce(least(x.completo_al, p_desde - 1), p_desde - 1) + 1 into c_desde
      from public.rep_ger_cobrado_completo((p_desde::timestamp + hh) at time zone 'America/Argentina/Buenos_Aires') x;
  end if;
  c_hasta := least(p_hasta, cc.completo_al);

  if c_desde > c_hasta then
    t := t || E'\n\n💰 COBRADO: sin días nuevos completos desde el reporte anterior (último completo: '
           || to_char(c_hasta, 'DD/MM') || ').';
  else
    select coalesce(sum(cliente + sin_identificar) filter (where empresa = 'lk'), 0),
           coalesce(sum(cliente + sin_identificar) filter (where empresa = 'chef'), 0),
           coalesce(sum(sin_identificar), 0)
      into c_lk, c_ch, c_sin from public.rep_ger_cobrado(c_desde, c_hasta);
    t := t || E'\n\n💰 COBRADO'
           || case when c_desde = p_desde and c_hasta = p_hasta then ''
                   when c_desde = c_hasta then ' del ' || dias[extract(dow from c_hasta)::int + 1] || ' ' || to_char(c_hasta, 'DD/MM')
                   else ' del ' || to_char(c_desde, 'DD/MM') || ' al ' || to_char(c_hasta, 'DD/MM') end
           || ' (acreditado en banco, IVA incluido): ' || public.rep_ger_plata(c_lk + c_ch);
    if cmp then
      if p_tipo = 'mensual' then
        pv_d := p_prev_desde;
        pv_h := case when c_hasta >= p_hasta then p_prev_hasta else least(p_prev_hasta, p_prev_desde + (c_hasta - c_desde)) end;
      else
        pv_d := c_desde - (p_desde - p_prev_desde);
        pv_h := c_hasta - (p_desde - p_prev_desde);
      end if;
      select coalesce(sum(cliente + sin_identificar), 0) into c_prev from public.rep_ger_cobrado(pv_d, pv_h);
      t := t || public.rep_ger_var(c_lk + c_ch, c_prev,
                  p_cmp || case when c_desde = p_desde and c_hasta = p_hasta then '' else ', mismos días' end);
    end if;
    t := t || E'\n   LK ' || public.rep_ger_plata(c_lk)
           || E'\n   Chef ' || public.rep_ger_plata(c_ch);
    if c_sin > 0 then t := t || E'\n   (' || public.rep_ger_plata(c_sin) || ' todavía sin imputar a un cliente)'; end if;
  end if;
  if c_hasta < p_hasta then
    t := t || E'\n   Lo del ' || to_char(c_hasta + 1, 'DD/MM') || ' en adelante va en el próximo reporte ('
           || case when cc.n_falta = cc.n_activas then 'ninguna cuenta lo subió todavía'
                   else 'falta ' || cc.falta end || ').';
  end if;
  if cc.sin_cargar is not null then t := t || E'\n   ⚠ Sin cargar hace más de 7 días (no suma): ' || cc.sin_cargar; end if;
  -- una cuenta cuya linea amarilla quedo atras (Santander LK al 01/09): lo de despues no suma. Luis, D6: "dejalo".
  select string_agg(initcap(a.banco) || ' ' || case a.empresa when 'lk' then 'LK' else 'Chef' end
                    || ' (al ' || to_char(a.conciliado_al, 'DD/MM') || ')', ', ' order by a.empresa, a.banco)
    into viejas from virgilio.gv_rep_gerencia_conc_al a where a.conciliado_al < c_hasta - 7;
  if viejas is not null then t := t || E'\n   ⚠ Conciliada sólo hasta (lo de después no suma): ' || viejas; end if;
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
-- 9) EL PASE (Luis, 02/10: "que mande estos y al final le pregunte al chat «queres que envie tambien el
--    formato antiguo» y que si dice algo en el chat el usuario lo mande"). Los crons 29/30/31 no cambian.
--    * Al final del reporte va la pregunta con un BOTON. El bot hoy solo escucha botones (setWebhook con
--      allowed_updates = callback_query): un "si" escrito no le llega. Abrirlo a mensajes le haria recibir
--      tambien lo que se escribe en los grupos donde esta el bot, por eso se resuelve con el boton.
--    * El texto antiguo se arma en el MISMO momento que el nuevo (misma foto) y queda guardado: el boton
--      solo lo encola, asi el webhook no corre 3 a 6 s de consultas (el mensual viejo tarda 6,3 s y
--      authenticator corta a los 8 s).
--    * Claves de dedup nuevas (ger_*): no chocan con las de los reportes viejos.
-- =====================================================================================
create table if not exists public.rep_ger_formato_viejo (
  id bigserial primary key,
  tipo text not null,                 -- diario | semanal | mensual
  ref text not null unique,           -- diario_20261001, semanal_2026_39, mensual_2026_09
  chat_id text not null,
  texto text not null,
  creado_en timestamptz not null default now(),
  enviado_en timestamptz);
alter table public.rep_ger_formato_viejo enable row level security;
revoke all on public.rep_ger_formato_viejo from anon, authenticated;
revoke all on sequence public.rep_ger_formato_viejo_id_seq from anon, authenticated;

create or replace function public.rep_ger_ya_encolado(p_key text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.telegram_outbox where left(dedup_key, length(p_key) + 1) = p_key || '_')
$$;

-- encola el reporte nuevo; si hay texto antiguo, lo guarda y pone la pregunta + boton en la ULTIMA parte
create or replace function public.rep_ger_enviar(p_nuevo text, p_key text, p_tipo text,
  p_viejo_ref text, p_viejo text, p_chat text default '6282395816')
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare n int; v_id bigint;
begin
  if public.rep_ger_ya_encolado(p_key) then return; end if;
  if p_viejo is not null and btrim(p_viejo) <> '' then
    insert into public.rep_ger_formato_viejo (tipo, ref, chat_id, texto)
    values (p_tipo, p_viejo_ref, p_chat, p_viejo)
    on conflict (ref) do update set texto = excluded.texto, chat_id = excluded.chat_id
    returning id into v_id;
  end if;
  n := public.tg_enqueue_largo(p_nuevo || case when v_id is not null
                                 then E'\n\n❓ ¿Querés que te mande también el formato antiguo?' else '' end,
                               p_key, p_chat);
  if v_id is not null and n > 0 then
    update public.telegram_outbox
       set reply_markup = jsonb_build_object('inline_keyboard', jsonb_build_array(jsonb_build_array(
             jsonb_build_object('text', '📄 Sí, mandame el formato antiguo', 'callback_data', 'rv:' || v_id))))
     where dedup_key = p_key || '_' || n and status = 'pending' and req_id is null;
  end if;
end $$;

-- el boton: encola el texto antiguo guardado (rapido: no recalcula nada)
create or replace function public.rep_ger_viejo_callback(p_data text)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id bigint; r record;
begin
  v_id := nullif(split_part(p_data, ':', 2), '')::bigint;
  select * into r from public.rep_ger_formato_viejo where id = v_id;
  if not found then return 'ese reporte ya no está guardado'; end if;
  if r.enviado_en is not null then return '📄 El formato antiguo ya se mandó'; end if;
  perform public.tg_enqueue_largo(r.texto, 'ger_viejo_' || r.ref, r.chat_id);
  update public.rep_ger_formato_viejo set enviado_en = now() where id = v_id;
  perform public.tg_outbox_flush();
  return '📄 Formato antiguo enviado';
exception when others then
  raise notice 'rep_ger_viejo_callback: %', sqlerrm;
  return 'no pude mandarlo, probá de nuevo';
end $$;

-- el webhook del bot ya existe (gerente-ventas-telegram-webhook -> gv_telegram_webhook -> gv_telegram_callback);
-- se le agrega UNA rama al principio. Sin ella "rv:12" buscaria la sugerencia 12 del gerente de ventas.
create or replace function public.gv_telegram_callback(p_data text)
 returns text
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_eje  text; v_id bigint; v_val text; v_tit text;
begin
  -- reportes de gerencia: "📄 Sí, mandame el formato antiguo" (Luis, 02/10/2026)
  if p_data like 'rv:%' then return public.rep_ger_viejo_callback(p_data); end if;

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
end $function$;

create or replace function public.rep_enviar_diario() returns void language plpgsql security definer
set search_path to 'public', 'pg_temp' as $function$
declare
  hoy date := (now() at time zone 'America/Argentina/Buenos_Aires')::date;
  f date := hoy - 1;
  k text := 'ger_diario_' || to_char(f, 'YYYYMMDD');
  v text;
begin
  perform rep_snapshot_despacho(30);
  if rep_ger_ya_encolado(k) then return; end if;
  begin v := rep_texto_diario(f);
  exception when others then raise notice 'formato antiguo diario: %', sqlerrm; v := null; end;
  perform rep_ger_enviar(rep_ger_texto_diario(hoy), k, 'diario', 'diario_' || to_char(f, 'YYYYMMDD'), v);
end $function$;

create or replace function public.rep_enviar_semanal() returns void language plpgsql security definer
set search_path to 'public', 'pg_temp' as $function$
declare
  hoy date := (now() at time zone 'America/Argentina/Buenos_Aires')::date;
  sem text := to_char(date_trunc('week', hoy)::date - 7, 'IYYY_IW');
  k text := 'ger_semanal_' || sem;
  v text;
begin
  if rep_ger_ya_encolado(k) then return; end if;
  begin v := rep_texto_semanal(hoy);
  exception when others then raise notice 'formato antiguo semanal: %', sqlerrm; v := null; end;
  perform rep_ger_enviar(rep_ger_texto_semanal(hoy), k, 'semanal', 'semanal_' || sem, v);
end $function$;

-- el mensual sale el dia 3 (el cron 31 corre 3, 5, 8 y 12: los otros dias el dedup lo saltea)
create or replace function public.rep_enviar_mensual() returns void language plpgsql security definer
set search_path to 'public', 'pg_temp' as $function$
declare
  hoy date := (now() at time zone 'America/Argentina/Buenos_Aires')::date;
  m text := to_char(date_trunc('month', hoy) - interval '1 month', 'YYYY_MM');
  k text := 'ger_mensual_' || m;
  mes text; v text;
begin
  if rep_ger_ya_encolado(k) then return; end if;
  begin
    select data#>>'{resumen,mes}' into mes from gv_dash_cache where id = 1;
    if mes is not null then v := rep_texto_mensual(); end if;
  exception when others then raise notice 'formato antiguo mensual: %', sqlerrm; v := null; end;
  perform rep_ger_enviar(rep_ger_texto_mensual(hoy), k, 'mensual', 'mensual_' || m, v);
end $function$;

revoke execute on function public.rep_ger_cobrado_completo(timestamptz, date), public.rep_ger_ya_encolado(text),
  public.rep_ger_enviar(text,text,text,text,text,text), public.rep_ger_viejo_callback(text),
  public.rep_enviar_diario(), public.rep_enviar_semanal(), public.rep_enviar_mensual()
  from public, anon, authenticated;

-- ROLLBACK del pase (definiciones vivas al 02/10/2026, antes de tocarlas; la rama 'rv:' de
-- gv_telegram_callback se puede dejar, no molesta):
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
