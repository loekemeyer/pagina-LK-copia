-- ============================================================================
-- sql/facturacion_live.sql — idea 4856, FASE 1 (SOLO LECTURA)
-- Facturación EN VIVO desde el parser de ISIS (comprobantes_venta, proyecto Virgilio)
--
-- Qué hace: espeja por FDW los comprobantes ya facturados (FC/NC/ND) que el parser
-- de ISIS deja en Virgilio, a una tabla local `fact_live`, y expone una RPC de admin
-- para leer facturación por cliente/mes EN VIVO (mes en curso incluido).
--
-- Qué NO hace: NO toca `sales_lines`. Es una fuente paralela de solo lectura para ver
-- el mes en curso mientras el Excel de ISIS todavía no se cargó. El Excel mensual sigue
-- siendo la verdad final (condición del dueño: no auto-rellenar sales_lines hasta que
-- haya coincidencia 100% con la Facturación de ISIS).
--
-- Cencosud / Chef-de-Loeke: se resuelven SOLOS por `marca` (el comprobante de Cencosud
-- es marca='CH'); acá caen en empresa='chef' y nunca ensucian LK. Sin regla especial.
--
-- Verdad de la valorización (medido ago-2026, idea 4856): net = subtotal × 0,98
-- (el subtotal de factura ya trae dto_vol; el único factor extra es el 2% web).
-- Súper: idealmente iría sin el 2%, pero comprobantes_venta no trae un flag es_super
-- ni existe mapeo cod_cliente→súper; por ahora se expone `subtotal` y `total` crudos
-- además del `neto` (×0,98) para que el consumidor elija. Súper ~9,5% del volumen.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- (0) PRERREQUISITO — correr UNA VEZ en el proyecto VIRGILIO (hrxfctzncixxqmpfhskv):
--     grant select on public.comprobantes_venta to lk_ppp_reader;
--     (mismo rol de solo-lectura que ya usa el FDW de PPP; ver CLAUDE.md § PPP)
-- ----------------------------------------------------------------------------

-- (1) LK: foreign table al parser de Virgilio (server virgilio_db ya existe)
create foreign table if not exists virgilio.comprobantes_venta (
  marca               text,
  tipo                text,
  signo               integer,
  familia             text,
  contraparte_codigo  text,
  contraparte_cuit    text,
  contraparte_nombre  text,
  fecha               date,
  total               numeric,
  subtotal            numeric,
  total_cajas         numeric
) server virgilio_db options (schema_name 'public', table_name 'comprobantes_venta');

-- (2) LK: espejo local (para NO leer el FDW en el camino caliente — lección Chef/PPP)
create table if not exists public.fact_live (
  empresa       text        not null,             -- 'lk' | 'chef'  (por prefijo de marca)
  cod_cliente   text        not null,
  ym            text        not null,             -- 'YYYY-MM'
  fecha         date        not null,
  clase         text        not null,             -- 'FC' | 'NC' | 'ND'
  cajas         numeric     not null,             -- CON signo (NC negativo)
  subtotal      numeric     not null,             -- CON signo, sin IVA
  total         numeric     not null,             -- CON signo, con IVA
  refrescado_at timestamptz not null default now()
);
alter table public.fact_live enable row level security;   -- sin policies => solo definer/service_role
create index if not exists fact_live_emp_fecha_idx on public.fact_live (empresa, fecha);
create index if not exists fact_live_emp_cod_idx   on public.fact_live (empresa, cod_cliente);

-- (3) LK: sync (reemplazo total; la fuente es viva). WHERE real por supautils.
create or replace function public.sincronizar_fact_live()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare n integer;
begin
  delete from public.fact_live where empresa is not null;   -- WHERE real (supautils)

  insert into public.fact_live (empresa, cod_cliente, ym, fecha, clase, cajas, subtotal, total)
  select case when v.marca = 'CH' then 'chef' else 'lk' end                 as empresa,
         v.contraparte_codigo                                               as cod_cliente,
         to_char(v.fecha, 'YYYY-MM')                                        as ym,
         v.fecha,
         case when v.tipo ~* 'ND' then 'ND'
              when v.tipo ~* 'NC' then 'NC'
              else 'FC' end                                                 as clase,
         coalesce(v.total_cajas, 0) * v.signo                               as cajas,
         coalesce(v.subtotal,    0) * v.signo                               as subtotal,
         coalesce(v.total,       0) * v.signo                               as total
  from virgilio.comprobantes_venta v
  where v.contraparte_codigo is not null
    and v.fecha is not null;

  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.sincronizar_fact_live() from public, anon, authenticated;

-- (4) LK: RPC de lectura para el panel — neto por cliente/mes, con guard de admin.
create or replace function public.get_facturacion_live(
  p_desde   date,
  p_hasta   date,
  p_empresa text default 'lk'
)
returns table (
  cod_cliente text,
  ym          text,
  cajas_netas numeric,   -- FC − NC (cajas)
  neto        numeric,   -- convención módulos: subtotal × 0,98  (ver nota súper arriba)
  subtotal    numeric,   -- real sin IVA
  total       numeric    -- real con IVA
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from admins a where a.auth_user_id = auth.uid()) then
    raise exception 'solo admin';
  end if;

  return query
  select f.cod_cliente,
         f.ym,
         sum(f.cajas)                    as cajas_netas,
         round(sum(f.subtotal) * 0.98)   as neto,
         round(sum(f.subtotal))          as subtotal,
         round(sum(f.total))             as total
  from public.fact_live f
  where f.empresa = p_empresa
    and f.fecha >= p_desde
    and f.fecha <= p_hasta
  group by f.cod_cliente, f.ym;
end $$;
revoke execute on function public.get_facturacion_live(date, date, text) from public, anon;
-- `authenticated` conserva EXECUTE (lo llama el panel logueado); el guard de admin adentro protege.

-- ----------------------------------------------------------------------------
-- (5) REFRESCO — dos opciones (elegir una):
--   a) plegar `perform public.sincronizar_fact_live();` dentro de sincronizar_ppp()
--      (ya corre diario y ya toca el FDW), o
--   b) cron propio más frecuente si se quiere el mes en curso más "al minuto":
--      select cron.schedule('sincronizar-fact-live', '*/30 * * * *',
--                            $$select public.sincronizar_fact_live();$$);
--   Primera carga manual:  select public.sincronizar_fact_live();
-- ----------------------------------------------------------------------------

-- VERIFICACIÓN (mes cerrado, debe casar con el Excel a nivel cliente salvo Chef-de-Loeke):
--   select empresa, count(*), round(sum(subtotal)) from fact_live
--   where fecha between '2026-08-01' and '2026-08-31' group by 1;
-- Mes en curso (lo que hoy sales_lines no ve todavía):
--   select round(sum(subtotal*0.98)) neto, round(sum(cajas)) cajas
--   from fact_live where empresa='lk' and fecha >= date_trunc('month', now());
