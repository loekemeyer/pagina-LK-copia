-- ============================================================================
-- estadistica_madre_cache.sql
--
-- Objetivo: que el módulo "Estadística Madre" (admin) NO recalcule la proyección
-- en el navegador cada vez que se abre. Mismo enfoque que se aplicó en producción
-- Virgilio: materializar el resultado en una tabla, refrescada por pg_cron, y que
-- la página solo LEA la caché (instantáneo).
--
-- Hoy el módulo baja las ventas por-cliente (RPC) y corre la lógica de proyección
-- en JS (_computeEstMadreProjections) en cada apertura → lento. Con esto:
--   * la proyección sale de fn_proyeccion_madre()  (única fuente de verdad, ya validada)
--   * el agregado mensual sale de get_all_sales_lines_admin_with_customer()
--   * ambos se precomputan y se guardan en estadistica_madre_cache
--   * admin.js lee get_estadistica_madre_cache() y renderiza sin recalcular nada.
--
-- El fast-path en admin.js YA está deployado con fallback: si estos objetos no
-- existen todavía, el módulo funciona exactamente como antes (cascade en vivo).
-- Así que crear esto es puramente aditivo y no puede romper la página.
--
-- ⚠️  BORRADOR — VALIDAR CONTRA EL ESQUEMA REAL ANTES DE EJECUTAR.
--     No pudo probarse desde acá porque el MCP de Supabase quedó apuntando a otra
--     cuenta ("Pagina Web LK", sin proyectos) en vez de "Gestion Productiva".
--     Antes de correrlo en kwkclwhmoygunqmlegrg:
--       1) confirmar que get_all_sales_lines_admin_with_customer() devuelve
--          (customer_code, item_code, ym, boxes) y que fn_proyeccion_madre()
--          devuelve (cod, proy_cajas_mes, uxb, proy_uni_mes);
--       2) comparar el proy_uni_mes de la caché contra el que hoy calcula el JS
--          para 2-3 códigos (ej. 505) — deben coincidir;
--       3) recién ahí, programar el cron.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Tabla caché: una fila por código, con la proyección + el histórico mensual
--    embebido como jsonb { "2025-01": unidades, ... } (lo que dibuja las columnas).
-- ---------------------------------------------------------------------------
create table if not exists public.estadistica_madre_cache (
  cod             text primary key,
  descripcion     text,
  familia         text,
  uxb             integer,
  proy_cajas_mes  numeric,
  proy_uni_mes    numeric,
  meses           jsonb  not null default '{}'::jsonb,
  calculado_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 2) Función de refresco: recalcula TODO una sola vez y reescribe la caché.
--    SECURITY DEFINER para poder leer ventas por-cliente (bypass RLS controlado).
--    Reusa fn_proyeccion_madre() → NO reimplementa la lógica de proyección.
-- ---------------------------------------------------------------------------
create or replace function public.refresh_estadistica_madre_cache()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer;
begin
  -- Reescritura atómica: truncate + insert dentro de la misma transacción de la
  -- función. Los lectores de otras transacciones ven el estado anterior hasta el
  -- commit (nunca una caché a medio llenar).
  truncate public.estadistica_madre_cache;

  -- 2.a) Agregado mensual por código (unidades), aplicando las MISMAS reglas
  --      que el módulo JS: excluir cuentas internas (1, 3878), excluir descuentos
  --      (sales_excluded_items), consolidar remaps (sales_item_remap), uxb por el
  --      item CRUDO (products/loke_products) igual que hoy.
  with base as (
    select
      upper(trim(s.item_code)) as item_up,
      s.ym::text               as ym,
      s.boxes::numeric         as boxes,
      s.customer_code
    from public.get_all_sales_lines_admin_with_customer() s
    where s.customer_code is null
       or s.customer_code::text not in ('1', '3878')      -- EM_EXCLUDED_CUSTOMERS
  ),
  mapped as (
    select
      upper(trim(coalesce(nullif(rm.to_code, ''), b.item_up))) as cod,
      b.ym,
      b.boxes * coalesce(p.uxb, lp.uxb, 1) as unidades
    from base b
    left join public.sales_excluded_items ex on upper(trim(ex.item_code)) = b.item_up
    left join public.sales_item_remap      rm on upper(trim(rm.from_code)) = b.item_up
    left join public.products       p  on upper(trim(p.cod))  = b.item_up   -- uxb del item crudo
    left join public.loke_products  lp on upper(trim(lp.cod)) = b.item_up
    where ex.item_code is null
      and b.ym ~ '^\d{4}-\d{2}$'
  ),
  mensual as (
    select cod, ym, sum(unidades) as unidades
    from mapped
    group by cod, ym
  ),
  meses as (
    select cod, jsonb_object_agg(ym, unidades) as meses
    from mensual
    group by cod
  )
  -- 2.b) Reescribir la caché: histórico mensual (meses) + proyección (fn_proyeccion_madre).
  insert into public.estadistica_madre_cache
        (cod, descripcion, familia, uxb, proy_cajas_mes, proy_uni_mes, meses, calculado_at)
  select
    m.cod,
    coalesce(p.description, lp.description, m.cod)                              as descripcion,
    coalesce(p.category, case when lp.cod is not null then 'Loke' end, '—')    as familia,
    coalesce(pr.uxb, p.uxb, lp.uxb, 1)                                         as uxb,
    coalesce(pr.proy_cajas_mes, 0)                                             as proy_cajas_mes,
    coalesce(pr.proy_uni_mes, 0)                                               as proy_uni_mes,
    m.meses,
    now()
  from meses m
  left join public.products      p  on upper(trim(p.cod))  = m.cod
  left join public.loke_products lp on upper(trim(lp.cod)) = m.cod
  left join public.fn_proyeccion_madre() pr on upper(trim(pr.cod)) = m.cod;

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3) Lectura: lo único que llama la página. Devuelve la caché tal cual.
--    SECURITY DEFINER + chequeo de admin (mismo criterio que el resto del panel).
-- ---------------------------------------------------------------------------
create or replace function public.get_estadistica_madre_cache()
returns table (
  cod            text,
  descripcion    text,
  familia        text,
  uxb            integer,
  proy_cajas_mes numeric,
  proy_uni_mes   numeric,
  meses          jsonb,
  calculado_at   timestamptz
)
language sql
security definer
set search_path = public
as $$
  select cod, descripcion, familia, uxb, proy_cajas_mes, proy_uni_mes, meses, calculado_at
  from public.estadistica_madre_cache
  where exists (
    select 1 from public.admins a where a.auth_user_id = auth.uid()
  )
  order by proy_uni_mes desc nulls last;
$$;

grant execute on function public.get_estadistica_madre_cache()      to authenticated;
grant execute on function public.refresh_estadistica_madre_cache()  to service_role;

-- ---------------------------------------------------------------------------
-- 4) pg_cron: refresco diario (barato, corre en segundos). Ajustar horario.
--    Requiere extensión pg_cron habilitada.
-- ---------------------------------------------------------------------------
-- select cron.schedule(
--   'refresh_estadistica_madre_cache',
--   '0 5 * * *',                               -- 05:00 UTC todos los días
--   $$select public.refresh_estadistica_madre_cache();$$
-- );

-- ---------------------------------------------------------------------------
-- 5) Primer llenado manual (ejecutar una vez, tras validar):
-- ---------------------------------------------------------------------------
-- select public.refresh_estadistica_madre_cache();
