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
