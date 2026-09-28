-- Estadistica madre en CAJAS ENTERAS (Luis, 28/09/2026).
-- Mismo criterio que gv_proyeccion_articulo de Gestion Virgilio (v22.84 / v22.86):
--   proy_lk y proy_chef se redondean al entero mas cercano y se suman;
--   si el redondeo da 0 y el articulo vende algo, va 1 caja.
--   Las unidades salen de cajas enteras x uxb (multiplo exacto de la caja).
-- Motor: _fn_proy_window_split, el mismo que alimenta OCs/Importados de Virgilio
--   (verificado 28/09: identico a _fn_proy_window salvo DTOXERROR, que es negativo y queda afuera).
-- Rollback: el CREATE anterior esta en zz_backups."LK_Backup_funcdef_estmadre_20260928".
CREATE OR REPLACE FUNCTION public.refresh_estadistica_madre_cache()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_rows integer;
begin
  delete from public.estadistica_madre_cache where cod is not null;

  insert into public.estadistica_madre_cache
    (cod, descripcion, familia, uxb, proy_uni_mes, proy_cajas_mes, total_unidades, meses, calculado_at)
  with
  src as (
    select mv.customer_code::text cc, mv.item_code::text ic, mv.ym::text ym, mv.boxes::numeric bx
    from (select s.customer_code, s.item_code, to_char(s.invoice_date::date, 'YYYY-MM') ym, sum(coalesce(s.boxes,0))::bigint boxes from public.sales_lines s where s.invoice_date is not null and not exists (select 1 from public.ventas_clientes_internos vi where vi.empresa = s.empresa and vi.cod_cliente = s.customer_code::text) group by 1,2,3) mv /* interco Luis 25/09/2026: antes mv_loke_sales_agg, sin empresa */
    union all
    select 'C_' || mv.customer_code::text, mv.item_code::text,
           to_char(mv.invoice_date::date, 'YYYY-MM'), sum(coalesce(mv.boxes, 0))::numeric
    from public.mv_chef_sales_loke mv
    where mv.invoice_date is not null and not exists (select 1 from public.ventas_clientes_internos vi where vi.empresa = 'chef' and vi.cod_cliente = mv.customer_code::text)
    group by mv.customer_code, mv.item_code, to_char(mv.invoice_date::date, 'YYYY-MM')
  ),
  prod  as (select upper(trim(cod)) k, max(coalesce(nullif(uxb, 0), 1)) uxb from public.products      group by 1),
  lokep as (select upper(trim(cod)) k, max(coalesce(nullif(uxb, 0), 1)) uxb from public.loke_products group by 1),
  excl  as (select distinct upper(trim(item_code)) k from public.sales_excluded_items),
  rmp   as (select upper(trim(from_code)) k, max(upper(trim(to_code))) v from public.sales_item_remap group by 1),
  x as (select upper(trim(s.ic)) item_up, nullif(trim(s.cc), '') cust, s.ym, s.bx from src s),
  kept as (
    select coalesce(rmp.v, x.item_up) item, x.cust, x.ym,
           x.bx * coalesce(prod.uxb, lokep.uxb, 1) unidades
    from x
    left join prod  on prod.k  = x.item_up
    left join lokep on lokep.k = x.item_up
    left join rmp   on rmp.k   = x.item_up
    where not exists (select 1 from excl e where e.k = x.item_up)
      and x.ym ~ '^\d{4}-\d{2}$'
      and x.bx * coalesce(prod.uxb, lokep.uxb, 1) > 0
      and (x.cust is null or x.cust not in ('1', '3878'))
  ),
  -- LA proyeccion, en CAJAS ENTERAS (Luis 28/09/2026, criterio v22.84/86 de Gestion):
  -- lk y chef redondeados por separado y sumados; minimo 1 caja si vende algo.
  proj as (
    select regexp_replace(upper(trim(w.item)), '^0+(?=.)', '') item,
           case when round(w.proy_lk) + round(w.proy_chef) <= 0 then 1
                else round(w.proy_lk) + round(w.proy_chef) end as proy_cajas_mes /* cajas enteras v28-09 */
    from public._fn_proy_window_split(public.proy_cfg('proy_meses_ventana',6)::int) w
    where w.proy_cajas > 0
  ),
  mensual as (select item, ym, sum(unidades) u from kept group by 1, 2),
  meses   as (select item, jsonb_object_agg(ym, u) meses, sum(u) total from mensual group by 1)
  select
    m.item,
    coalesce(p.description, lp.description, m.item),
    coalesce(p.category, case when lp.cod is not null then 'Loke' end, '—'),
    coalesce(pu.uxb, lu.uxb, 1)::integer,
    coalesce(pr.proy_cajas_mes, 0) * coalesce(pu.uxb, lu.uxb, 1),
    coalesce(pr.proy_cajas_mes, 0),
    m.total,
    m.meses,
    now()
  from meses m
  left join prod  pu on pu.k = m.item
  left join lokep lu on lu.k = m.item
  left join lateral (select p.description, p.category, p.cod from public.products p
                      where upper(trim(p.cod)) = m.item limit 1) p on true
  left join lateral (select lp.description, lp.cod from public.loke_products lp
                      where upper(trim(lp.cod)) = m.item limit 1) lp on true
  left join proj pr on pr.item = regexp_replace(upper(trim(m.item)), '^0+(?=.)', '');

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$function$;
