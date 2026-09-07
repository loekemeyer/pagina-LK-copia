-- Backup de las funciones del reporte ANTES de enchufar ppp_np_feed (2026-09-07).
-- Sacadas con pg_get_functiondef. Para volver atrás: correr este archivo entero
-- y después el rollback de sql/reporte_deposito_gestion.sql.

CREATE OR REPLACE FUNCTION public.rep_ppp()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.rep_snapshot_despacho(p_dias integer DEFAULT 30)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
end $function$;

-- rep_texto_diario / rep_texto_semanal: idénticas a las de hoy salvo que leían
--   `d.plata` y `sum(x.plata)` en vez de `coalesce(plata_neto, plata)`.
-- rep_texto_mensual: idéntica salvo que NO tenía el bloque "🚚 DEPÓSITO".
-- sincronizar_ppp: idéntica salvo el bloque `np_feed` y su entrada en el jsonb final.
