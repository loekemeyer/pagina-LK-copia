-- Proyección / estadística madre: excluir ventas entre empresas (Luis, 25/09/2026)
-- Aplicado en LK (kwkclwhmoygunqmlegrg) sobre la definición VIVA de cada función.
-- Backup de las 6 definiciones previas: zz_backups."LK_Backup_funcdef_proy_interco_20260925".
--
-- Cómo viaja el dato:
--   ISIS -> virgilio.isis_ventas -> sales_lines (gv_sales_lines_auto_sync, lote isis_auto)
--   -> _fn_proy_window        -> fn_proyeccion_madre -> estadistica_madre_cache (panel, portal)
--   -> _fn_proy_window_split  -> fn_proyeccion_oc_virgilio -> virgilio.proyeccion_madre
--        (generador de OC, gv_importados_ordenes, v_importados_ordenes, "E. Madre LK", ...)
--   -> fn_ventas_6m_avg, fn_ventas_mensuales_virgilio, get_estadistica_madre_detail
--
-- NO se borra nada de sales_lines: son facturas reales y la sync con ISIS las vuelve a traer.
-- La exclusión vive en UNA tabla. Agregar un cliente interno = un insert, no código.

create table if not exists public.ventas_clientes_internos (
  empresa text not null check (empresa in ('lk','chef')),
  cod_cliente text not null,
  razon_social text,
  motivo text not null,
  creado_at timestamptz not null default now(),
  primary key (empresa, cod_cliente));
alter table public.ventas_clientes_internos enable row level security;
revoke all on public.ventas_clientes_internos from anon, authenticated;
insert into public.ventas_clientes_internos (empresa, cod_cliente, razon_social, motivo) values
 ('chef','1434','Loekemeyer Hnos S.R.L.','Chef le vende a Loekemeyer: venta intercompania, no es demanda (Luis 25/09/2026)'),
 ('lk','411','Chef S.R.L.','Loekemeyer le vende a Chef: venta intercompania, no es demanda (Luis 25/09/2026)'),
 ('lk','1','Loekemeyer SRL','La propia empresa (ya se excluia como ''1'')'),
 ('lk','3878','Tierra Nativa SA','Ya se excluia como ''3878'''),
 ('chef','1','Tierra Nativa SA','Mismo criterio que lk 3878 (ya se excluia como ''1'')')
on conflict do nothing;

-- Parche (aplicado con un DO sobre pg_get_functiondef, idempotente):
-- * En las 5 funciones sobre sales_lines, `sl.customer_code not in ('1','3878')` (no distinguía
--   empresa: '1' es Loekemeyer en LK y Tierra Nativa en Chef) pasa a
--     not exists (select 1 from public.ventas_clientes_internos vi
--                  where vi.empresa = sl.empresa and vi.cod_cliente = sl.customer_code::text)
-- * get_estadistica_madre_detail: la rama de Chef (mv_chef_sales_loke) filtra empresa 'chef'.
-- * refresh_estadistica_madre_cache: la historia mensual deja de leer mv_loke_sales_agg (no tiene
--   columna empresa) y agrega sales_lines directo con el mismo filtro; la rama de Chef filtra 'chef'.
--
-- Chequeo:
--   select item, proy_cajas from public._fn_proy_window_split(6) where item in ('437E','438E'); -- 23,00 / 52,67
--   select cod, proy_cajas_mes from virgilio.proyeccion_madre where cod in ('437E','438E');
--
-- Movimientos identificados:
--   select s.empresa, s.customer_code, s.item_code, s.invoice_date, sum(s.boxes)
--     from sales_lines s join ventas_clientes_internos vi
--       on vi.empresa = s.empresa and vi.cod_cliente = s.customer_code
--    group by 1,2,3,4 order by 4;
--
-- Rollback: recrear las 6 funciones desde zz_backups."LK_Backup_funcdef_proy_interco_20260925".def

-- ============================================================================
-- 25/09/2026 (Luis) — segunda etapa: REGLA L + parámetros configurables.
-- ============================================================================
-- cliente_isis_cache: copia local de gv_cliente_isis_calc (1,25 s por lectura); la llena
-- sync_cliente_isis_virgilio() antes de empujar a Virgilio.
--   (empresa, cod, isis_empresa, cod_isis, razon_social, cuit, motivo, actualizado_at)
--
-- ventas_proy_lineas: la ÚNICA fuente de ventas de proyección. Saca intercompañía
-- (ventas_clientes_internos), pela ceros y la L final (nitem) y reasigna a LK la venta de Chef con
-- código terminado en L a Cencosud (precios_super.cadena con usa_productos_chef=false) o a un
-- cliente de Tierra del Fuego (cliente_isis_cache isis_empresa='chef'). El resto de Chef queda en
-- Chef con el código base (437EL de Dorinka -> 437E de Chef).
create or replace view public.ventas_proy_lineas as
with cli_art_lk as (
  select c.cod_cliente_chef::text as cod from precios_super.cadena c
   where c.empresa='chef' and not coalesce(c.usa_productos_chef,false) and c.cod_cliente_chef is not null
  union select i.cod_isis::text from public.cliente_isis_cache i where i.isis_empresa='chef' and i.cod_isis is not null)
select sl.invoice_date, sl.customer_code, sl.item_code, sl.empresa as empresa_venta,
  case when sl.empresa='chef' and upper(btrim(sl.item_code)) ~ '[0-9E]L$' and sl.customer_code::text in (select cod from cli_art_lk)
       then 'lk' else sl.empresa end as empresa,
  regexp_replace(regexp_replace(upper(btrim(sl.item_code)),'^0+(?=.)',''),'([0-9E])L$','\1') as nitem, sl.boxes
from public.sales_lines sl where sl.empresa in ('lk','chef') and sl.customer_code is not null
  and not exists (select 1 from public.ventas_clientes_internos vi where vi.empresa=sl.empresa and vi.cod_cliente=sl.customer_code::text);

-- proy_cfg: parámetro de la proyección, leído de Gestión (Stock_Config por v_lk_config). Fail-open al default.
CREATE OR REPLACE FUNCTION public.proy_cfg(p_clave text, p_default numeric)
 RETURNS numeric LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare v numeric;
begin
  begin
    select nullif(btrim(c.valor), '')::numeric into v from virgilio.v_lk_config c where c.clave = p_clave;
  exception when others then v := null;
  end;
  return coalesce(v, p_default);
end $function$;
revoke execute on function public.proy_cfg(text,numeric) from public, anon, authenticated;

-- Motor: _fn_proy_window, _fn_proy_window_split, fn_ventas_6m_avg y fn_ventas_mensuales_virgilio
-- leen ventas_proy_lineas (sl.nitem). El piso (4.º mejor mes) y la ventana (6) salen de
-- proy_cfg('proy_piso_mejor_mes') / proy_cfg('proy_meses_ventana'); fn_proyeccion_oc_virgilio usa
-- además proy_meses_fallback (12). Efecto medido: 10.359 cajas (mar-sep) de Chef pasan a LK.
-- Backups: zz_backups."LK_Backup_funcdef_proy_interco_20260925", zz_backups."LK_Proy_Antes_Regla_L_20260925".
