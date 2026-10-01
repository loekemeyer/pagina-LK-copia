-- =====================================================================================
-- get_estadistica_madre_mensual() — LK (kwkclwhmoygunqmlegrg)
-- Tomás Beviglia, 01/10/2026: "es un solo cuadro que se imprime en dos lados distintos.
-- NUNCA puede un cuadro de est madre quedar mas actualizado que otro".
--
-- Ventas facturadas por mes, en CAJAS, por (artículo, empresa). La lee el módulo único de la
-- Estadística Madre (est-madre.js del repo Gestion-Virgilio, admin/), que lo cargan la página LK
-- y el espejo de Gestión desde el MISMO lugar. La lista de artículos y la Est Madre (caj/mes)
-- NO salen de acá: salen de stocks_carga_rapida de Gestión, que es lo que muestra Stocks.
--
-- Criterio = el del motor de la Est Madre (_fn_proy_window_split): ventas_proy_lineas (regla L,
-- sin ventas entre empresas), sales_item_remap, sin sales_excluded_items, neto por mes.
-- Se calcula EN VIVO (1,8 s medido el 01/10/2026, 611 filas): no hay tabla ni cron que se atrase.
--
-- Sólo admins de LK (la página) o service_role (la Edge Function gv-est-madre, que valida antes
-- que el JWT sea de un supervisor de Gestión). EXECUTE revocado a PUBLIC / anon.
-- Rollback: drop function if exists public.get_estadistica_madre_mensual();
-- =====================================================================================
create or replace function public.get_estadistica_madre_mensual()
returns table(item text, empresa text, meses jsonb)
language plpgsql stable security definer
set search_path to 'public'
set work_mem to '32MB'
as $function$
begin
  if not (exists (select 1 from public.admins a where a.auth_user_id = auth.uid())
          or coalesce(auth.role(), '') = 'service_role') then
    raise exception 'no autorizado' using errcode = '42501';
  end if;
  return query
  with _em_b as (
    select coalesce(r.to_code, v.nitem) as _it, v.empresa as _emp,
           left(v.invoice_date, 7) as _ym, sum(v.boxes)::numeric as _cj
      from public.ventas_proy_lineas v
      left join public.sales_item_remap r on r.from_code = v.nitem
     where v.invoice_date ~ '^\d{4}-\d{2}-\d{2}'
       and not exists (select 1 from public.sales_excluded_items e where e.item_code = v.nitem)
     group by 1, 2, 3)
  select x._it, x._emp, jsonb_object_agg(x._ym, x._cj order by x._ym)
    from _em_b x
   where x._cj <> 0
   group by x._it, x._emp
   order by x._it, x._emp;
end;
$function$;

revoke execute on function public.get_estadistica_madre_mensual() from public, anon;
grant execute on function public.get_estadistica_madre_mensual() to authenticated, service_role;
