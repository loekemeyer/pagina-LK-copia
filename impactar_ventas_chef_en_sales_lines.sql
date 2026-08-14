-- ============================================================================
-- impactar_ventas_chef_en_sales_lines.sql   ·   PASO 3 de 3
-- Pasa las ventas Chef del staging (ventas_chef) a la tabla madre sales_lines.
--
-- Correr DESPUÉS de crear_ventas_chef.sql (paso 1) y de importar el CSV en
-- ventas_chef (paso 2). Es idempotente: si se corre dos veces no duplica
-- (chequea el import_batch).
--
-- Decisiones (confirmadas):
--   * TODO entra marcado con la columna nueva empresa='chef'; lo existente
--     queda empresa='lk'. Reversible: delete from sales_lines where
--     import_batch = 'chef_hist_xlsx_202607'.
--   * item_code = columna `cod` del staging (ya normalizada por la planilla):
--     los artículos Loeke vendidos vía Chef impactan directo con su código
--     de catálogo Loeke, y los artículos Chef con el suyo.
--   * Quedan afuera las filas 'NO CONSIDERAR' (1.740: descuentos/servicios) y
--     las ~15 que redondean a 0 cajas (boxes es bigint; hay 23 filas con cajas
--     fraccionarias, se redondean).
--   * Las cajas negativas (3.342 devoluciones) entran tal cual: netean la venta.
--
-- Efecto aguas abajo (automático, sin tocar funciones):
--   * fn_proyeccion_madre y la Estadística Madre leen sales_lines completo →
--     pasan a incluir las ventas Chef (artículos Loeke Y artículos Chef, como
--     pediste). Virgilio va a empezar a recibir códigos Chef en la proyección.
--   * OJO uxb: los artículos propios de Chef (701, 706, …) no están en
--     products/loke_products → uxb queda 1 y proy_uni_mes = proy_cajas_mes.
--     Si Chef necesita UxB reales hay que cargar sus artículos a un catálogo.
--   * Si ya existe estadistica_madre_cache, correr después:
--     select refresh_estadistica_madre_cache();
-- ============================================================================

-- 1) Columna empresa en sales_lines ('lk' = histórico Loekemeyer)
alter table public.sales_lines
  add column if not exists empresa text not null default 'lk';
create index if not exists idx_sales_lines_empresa on public.sales_lines (empresa);

-- 2) Insertar desde staging
insert into public.sales_lines
      (invoice_date, customer_code, item_code, boxes, empresa, import_batch, imported_at, row_hash)
select
  v.fecha::text,
  v.cod_cliente,
  upper(trim(v.cod)),
  round(v.cajas)::bigint,
  'chef',
  'chef_hist_xlsx_202607',
  now(),
  md5('chef|' || v.id::text || '|' || v.fecha::text || '|' || v.cod_cliente || '|' || v.cod || '|' || v.cajas::text)
from public.ventas_chef v
where coalesce(v.estado, '') <> 'NO CONSIDERAR'
  and round(v.cajas) <> 0
  and not exists (
    select 1 from public.sales_lines s
    where s.import_batch = 'chef_hist_xlsx_202607'
  );

-- 3) Verificación — esperado para empresa='chef':
--    35.793 filas · 2021-05-03 → 2026-06-30 · 312 clientes · 389 códigos
select empresa,
       count(*)                        as filas,
       min(invoice_date)               as desde,
       max(invoice_date)               as hasta,
       count(distinct customer_code)   as clientes,
       count(distinct item_code)       as codigos
from public.sales_lines
group by empresa
order by empresa;

-- 4) Control cruzado: la proyección ya debería traer códigos Chef.
--    (Correr aparte si se quiere ver.)
-- select * from fn_proyeccion_madre()
-- where upper(cod) in ('706','713','701','702E') order by cod;
