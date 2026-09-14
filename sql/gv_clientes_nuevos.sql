-- ============================================================================
-- gv_clientes_nuevos — quién es CLIENTE NUEVO, y el empuje a Gestión Virgilio
-- 2026-09-14 (pedido de Luis, Gestión Virgilio v17.12)
-- ============================================================================
-- POR QUÉ ESTÁ ACÁ Y NO EN VIRGILIO: el cálculo necesita `sales_lines` (260k líneas de
-- historia real), el padrón de las DOS empresas (`customers` + `chef_padron`) y los vínculos
-- (`customer_grupos`, `clientes_lk_ch_links`). Todo eso vive en LK. Gestión no tiene con qué:
-- su historia propia arranca en 2026, y ahí "sin entregas en 2026" no es "cliente nuevo".
--
-- LA REGLA (del dueño, 2026-09-10; ver docs/PLAN-BADGE-CLIENTE-NUEVO.md del repo Gestion-Virgilio):
--   es NUEVO el cliente que cumple LAS DOS:
--     (a) código alto: cod >= 3800 en LK  /  cod >= 2300 en CH
--     (b) menos de 3 pedidos facturados en TODA su historia
--   y (b) se cuenta sobre el CLIENTE REAL, no sobre el código: se unen por CUIT, por
--   `customer_grupos` (cambió de razón social) y por `clientes_lk_ch_links` (LK↔CH), con cierre
--   transitivo. Un código nuevo del mismo CUIT que uno viejo con historia NO es nuevo.
--
-- "PAGADO Y ENTREGADO" SE APROXIMA POR FACTURADO (opción 1 del Hueco A del plan): no existe una
-- marca de pagado por pedido. Y "un pedido" se cuenta como una FECHA DE FACTURA distinta, porque
-- `sales_lines` no guarda número de comprobante. Se excluyen los códigos administrativos
-- (`sales_excluded_items`) y las devoluciones (`boxes <= 0`), como el resto de los reportes.
--
-- QUIÉN LO CONSUME: Gestión Virgilio. `sync_clientes_nuevos_virgilio()` empuja la lista por el
-- FDW `virgilio_db` (rol `lk_ppp_reader`) a `public."GV_Clientes_Nuevos"` de allá, y su
-- `gv_cuarentena_marcar` retiene en Cuarentena los pedidos de esos clientes con el motivo
-- `cliente_nuevo`. Mismo patrón que `sync_pedidos_match_virgilio` / `lk_pedidos_match`.
--
-- MEDIDO EL 2026-09-14: 1.275 clientes LK + 765 Chef; con código alto 492 + 311; NUEVOS 228 + 140
-- = 368. La vista tarda 693 ms. Pedidos web de esos clientes en los últimos 30 días: 12.
-- ============================================================================

create or replace view public.gv_clientes_nuevos_calc
with (security_invoker = true) as
with recursive base as (
  select 'lk'::text empresa, c.cod_cliente::text cod,
         nullif(regexp_replace(coalesce(c.cuit,''),'\D','','g'),'') cuit, c.business_name rs
    from public.customers c
  union all
  select 'chef', btrim(p.cod_cliente),
         nullif(regexp_replace(coalesce(p.cuit,''),'\D','','g'),''), p.business_name
    from public.chef_padron p
),
nodo as (select empresa, cod, max(cuit) cuit, max(rs) rs from base where cod ~ '^\d+$' group by 1,2),
-- MATERIALIZED no es opcional: `arista` se referencia desde el término recursivo y sin eso
-- Postgres la inlinea y la recalcula en CADA iteración (misma lección que `sugerir_customer_grupos`).
arista as materialized (
  select a.empresa e1, a.cod c1, b.empresa e2, b.cod c2
    from nodo a join nodo b on a.cuit = b.cuit and length(a.cuit)=11 and (a.empresa,a.cod) <> (b.empresa,b.cod)
  union
  select g1.empresa, g1.cod_cliente, g2.empresa, g2.cod_cliente
    from public.customer_grupos g1 join public.customer_grupos g2
      on g1.grupo_id=g2.grupo_id and g1.empresa=g2.empresa and g1.cod_cliente <> g2.cod_cliente
  union
  select l1.empresa, l1.cod_cliente, l2.empresa, l2.cod_cliente
    from public.clientes_lk_ch_links l1 join public.clientes_lk_ch_links l2
      on l1.link_id=l2.link_id and (l1.empresa,l1.cod_cliente) <> (l2.empresa,l2.cod_cliente)
),
alto as (select empresa, cod, rs from nodo where cod::bigint >= case when empresa='lk' then 3800 else 2300 end),
alcance as (
  select a.empresa, a.cod, a.empresa m_emp, a.cod m_cod from alto a
  union
  select al.empresa, al.cod, ar.e2, ar.c2 from alcance al join arista ar on ar.e1 = al.m_emp and ar.c1 = al.m_cod
),
cnt as (
  select al.empresa, al.cod,
         count(distinct (s.empresa, s.invoice_date)) pedidos,
         count(*) filter (where s.customer_code is not null) lineas,
         count(distinct (al.m_emp, al.m_cod)) codigos
    from alcance al
    left join public.sales_lines s
      on s.customer_code = al.m_cod and lower(s.empresa) = al.m_emp
     and s.boxes > 0 and s.item_code not in (select item_code from public.sales_excluded_items)
   group by 1,2
)
select c.empresa, c.cod, a.rs as razon_social, c.pedidos, c.codigos, (c.pedidos < 3) as es_nuevo
  from cnt c join alto a on a.empresa = c.empresa and a.cod = c.cod;

revoke all on public.gv_clientes_nuevos_calc from anon, authenticated;


create foreign table if not exists virgilio.gv_clientes_nuevos (
  empresa        text,
  cod            text,
  razon_social   text,
  pedidos        integer,
  actualizado_at timestamptz
) server virgilio_db options (schema_name 'public', table_name 'GV_Clientes_Nuevos');


create or replace function public.sync_clientes_nuevos_virgilio()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_n integer;
begin
  create temp table _cn on commit drop as
    select empresa, cod, razon_social, pedidos
      from public.gv_clientes_nuevos_calc
     where es_nuevo;
  select count(*) into v_n from _cn;
  if v_n = 0 then
    raise notice 'sync_clientes_nuevos_virgilio: 0 filas, no se pisa nada';
    return 0;
  end if;
  -- Reemplazo total (la lista es chica, ~370 filas). Si el cálculo da 0 NO se pisa nada: una
  -- lista vacía por un error de datos dejaría a TODOS los clientes como "no nuevos", en silencio.
  -- Y ojo: en una tabla foránea NO se puede usar `insert ... on conflict do update`.
  delete from virgilio.gv_clientes_nuevos where empresa is not null;
  insert into virgilio.gv_clientes_nuevos (empresa, cod, razon_social, pedidos, actualizado_at)
  select empresa, cod, razon_social, pedidos, now() from _cn;
  return v_n;
end;
$function$;

revoke all on function public.sync_clientes_nuevos_virgilio() from public, anon, authenticated;

-- cron job 44 — cada hora al :40 (un cliente que se da de alta y pide el mismo día queda
-- marcado dentro de la hora, sin esperar al día siguiente). Cuesta ~700 ms por corrida.
-- select cron.schedule('sync-clientes-nuevos-virgilio', '40 * * * *',
--   $c$select public.sync_clientes_nuevos_virgilio();$c$);
-- Para apagarlo: select cron.alter_job(44, active := false);

-- Chequeos
--   select count(*) filter (where es_nuevo) nuevos, count(*) altos from public.gv_clientes_nuevos_calc;
--   select public.sync_clientes_nuevos_virgilio();
--   select empresa, count(*) from virgilio.gv_clientes_nuevos group by 1;
