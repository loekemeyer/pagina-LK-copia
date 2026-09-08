-- lk_refresh_mvs — v14.28 (2026-09-08)
--
-- Proyecto LK (kwkclwhmoygunqmlegrg). Ya aplicado en produccion el 2026-09-08.
-- Se escribio desde la sesion de Gestion Virgilio (por eso el numero de version v14.28 en el
-- nombre original); esta es su copia canonica, en el repo que le corresponde.
--
-- EL PROBLEMA
-- ===========
-- El reporte de salud avisaba: *"🔴 cron refresh-mvs-daily · falla desde hace 56 días"*. El
-- error real, que nadie había mirado:
--
--   ERROR:  permission denied for table sales_line
--   CONTEXT: remote SQL command: SELECT customer_code, item_code, invoice_date, boxes
--            FROM public.sales_lines WHERE ((invoice_date IS NOT NULL))
--
-- "remote SQL command" = va por `postgres_fdw` contra **Chef**. El usuario mapeado es
-- `loke_reader` y no tiene `SELECT` sobre `public.sales_line` del lado de Chef (sí sobre
-- `customers`: `mv_chef_customers_resolved` refresca bien).
--
-- Pero lo caro no era eso. El cron corría **los tres REFRESH en un solo comando**:
--
--   REFRESH MATERIALIZED VIEW public.mv_loke_sales_agg;
--   REFRESH MATERIALIZED VIEW public.mv_chef_sales_loke;      <-- falla
--   REFRESH MATERIALIZED VIEW public.mv_chef_customers_resolved;
--
-- Un comando de cron es UNA transacción: cuando el segundo falla, **se revierten los tres**.
-- Así que `mv_loke_sales_agg` —que es 100% local y no tiene nada que ver con Chef— quedó
-- congelada. Medido antes de tocar nada:
--
--   mv_loke_sales_agg   183.740 filas, hasta **2026-07**
--   sales_lines (viva)  233.898 filas, hasta **2026-08-31**
--
-- O sea que la **Estadística Madre venía calculando sin agosto** (`refresh_estadistica_madre_cache`
-- corre todos los días y lee esa MV; el cron 13 "andaba bien", sólo que sobre datos viejos).
--
-- LA SOLUCIÓN
-- ===========
-- Cada MV en su propio bloque con EXCEPTION. Si una falla, las otras igual se refrescan, y
-- queda anotado cuál falló y por qué en `lk_refresh_mvs_log`.
--
-- ⚠ EFECTO SECUNDARIO QUE HAY QUE COMPENSAR: con esto el cron **termina OK aunque una MV
--   falle**, así que el chequeo 1 de `rep_salud` (crons cuya última corrida falló) deja de
--   verlo. Sin hacer nada más, el problema de Chef se volvería INVISIBLE. Por eso va también
--   la rama 1b de `rep_salud` (abajo), que además dice *cuál* MV y *por qué* — mejor que el
--   "cron falla desde hace 56 días" de antes.
--
-- LO QUE FALTABA, Y SE HIZO EL MISMO DIA
-- =====================================
--   En el proyecto de **Chef** (nkhzocgdpwtgrmwleihr), que esta sesión no puede tocar (está en
--   otra organización de Supabase), lo corrió el dueño:
--
--     grant usage  on schema public to loke_reader;
--     grant select on public.sales_line  to loke_reader;
--     grant select on public.sales_lines to loke_reader;
--
--   Verificado desde LK: las tres MV en ok = true, y `mv_chef_sales_loke` pasó de fallar en 6 s
--   (permission denied) a 17,5 s de trabajo real.
--
--   ⚠ PERO EL NÚMERO NO SE MOVIÓ: quedó en 2.227 filas, hasta 2026-02-23. No es que la MV siga
--   rota —ahora lee bien—, es que no hay dato nuevo del otro lado:
--
--     select count(*), min(invoice_date), max(invoice_date)
--       from public.chef_sales_lines where invoice_date is not null;
--     -- 36.770 filas · 2020-01-02 -> 2026-02-23
--
--   Las ventas de Chef no se cargan desde el 23/02: seis meses y medio. Es el lote mensual del
--   ERP que se sube a mano entre el 2 y el 14; para LK se viene subiendo, para Chef no.
--   Pasó desapercibido porque el chequeo 4 de rep_salud mira SOLO `empresa='lk'`.
--
-- MEDIDO DESPUÉS DE APLICAR
-- =========================
--   select * from public.lk_refresh_mvs();
--   -- mv_loke_sales_agg           ok=true   9.696 ms
--   -- mv_chef_sales_loke          ok=false  6.065 ms  permission denied for table sales_line
--   -- mv_chef_customers_resolved  ok=true  26.187 ms
--
--   mv_loke_sales_agg          183.740 -> 187.779 filas, jul -> **ago**
--   mv_chef_customers_resolved     757 ->     762 filas
--   refresh_estadistica_madre_cache() -> 537   (ya con agosto adentro)
--
-- ROLLBACK
-- ========
--   select cron.alter_job(9, command := E'\r\n    REFRESH MATERIALIZED VIEW public.mv_loke_sales_agg;\r\n'
--     '    REFRESH MATERIALIZED VIEW public.mv_chef_sales_loke;\r\n'
--     '    REFRESH MATERIALIZED VIEW public.mv_chef_customers_resolved;\r\n  ');
--   drop function if exists public.lk_refresh_mvs();
--   drop table if exists public.lk_refresh_mvs_log;
--   delete from public.rep_cron_verificado where jobname = 'refresh-mvs-daily';
--   (y sacar la rama 1b de rep_salud)

create table if not exists public.lk_refresh_mvs_log (
  id           bigserial primary key,
  corrida_en   timestamptz not null default now(),
  mv           text not null,
  ok           boolean not null,
  ms           integer,
  error        text
);
alter table public.lk_refresh_mvs_log enable row level security;

comment on table public.lk_refresh_mvs_log is
  'Resultado de cada REFRESH de lk_refresh_mvs(). Antes los tres corrian en un solo comando del '
  'cron: cuando el de Chef fallaba (permission denied en loke_reader) arrastraba a los otros dos y '
  'nadie sabia cual habia fallado. 2026-09-08.';

create or replace function public.lk_refresh_mvs()
returns table(mv text, ok boolean, ms integer, error text)
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $$
declare
  v_mv text;
  v_t0 timestamptz;
  v_ms integer;
  v_err text;
begin
  -- Cada MV en su propio bloque: si una falla, las otras igual se refrescan.
  -- El de Chef depende del FDW (loke_reader tiene que poder leer public.sales_line
  -- del lado de Chef); el de Loke es 100% local y no tiene por que caerse con el.
  foreach v_mv in array array[
    'public.mv_loke_sales_agg',
    'public.mv_chef_sales_loke',
    'public.mv_chef_customers_resolved'
  ] loop
    v_t0 := clock_timestamp();
    v_err := null;
    begin
      execute 'refresh materialized view ' || v_mv;
    exception when others then
      v_err := left(sqlerrm, 500);
    end;
    v_ms := extract(milliseconds from (clock_timestamp() - v_t0))::integer
          + 1000 * extract(seconds from (clock_timestamp() - v_t0))::integer;
    insert into public.lk_refresh_mvs_log (mv, ok, ms, error)
      values (v_mv, v_err is null, v_ms, v_err);
    mv := v_mv; ok := v_err is null; ms := v_ms; error := v_err;
    return next;
  end loop;
end
$$;
revoke all on function public.lk_refresh_mvs() from public, anon;

select cron.alter_job(9, command := 'select public.lk_refresh_mvs()');

-- ── La rama 1b de rep_salud ────────────────────────────────────────────────────────────────
-- Se inyecta sobre la definición VIVA en vez de retipear la función entera: `rep_salud` tiene
-- siete chequeos que hoy funcionan y un error de transcripción se llevaría alguno puesto sin
-- que se note (devuelve filas, no falla). El DO aborta si no encuentra el ancla.

do $do$
declare
  v_def  text;
  v_nueva text := $rama$
  union all
  -- 1b. Que MATERIALIZED VIEW no se pudo refrescar (2026-09-08).
  --     Antes los tres REFRESH iban en un solo comando del cron: el de Chef fallaba
  --     ("permission denied for table sales_line": loke_reader no puede leer esa tabla
  --     del lado de Chef por el FDW) y arrastraba a los otros dos, que no tenian nada
  --     malo. Resultado: mv_loke_sales_agg se quedo en julio y la Estadistica Madre
  --     venia calculando sin agosto.
  --     Ahora `lk_refresh_mvs()` refresca cada una en su propio bloque, asi que el cron
  --     termina OK aunque una falle — y el chequeo 1 (cron fallado) ya no lo veria.
  --     Este chequeo es el que lo mantiene visible, y ademas dice CUAL y POR QUE.
  select '🔴', 'materialized view ' || split_part(l.mv, '.', 2),
         'falló al refrescar → ' || coalesce(l.error, 'sin detalle')
  from (select distinct on (mv) mv, ok, error
          from public.lk_refresh_mvs_log order by mv, corrida_en desc) l
  where not l.ok
$rama$;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'rep_salud';

  if position('lk_refresh_mvs_log' in v_def) > 0 then
    raise notice 'la rama ya estaba; no se toca';
    return;
  end if;

  v_def := replace(v_def,
    '  union all' || chr(10) || '  -- 7. Mensajes de Telegram',
    v_nueva || chr(10) || '  union all' || chr(10) || '  -- 7. Mensajes de Telegram');

  if position('lk_refresh_mvs_log' in v_def) = 0 then
    raise exception 'no encontre el ancla de la rama 7: no se toca rep_salud';
  end if;

  execute v_def;
end
$do$;

-- El chequeo 1 mira la ÚLTIMA corrida del cron, que sigue siendo la fallida hasta que le toque
-- correr de nuevo (03:00). Se marca verificado para que no repita "falla desde hace 56 días",
-- que ya no es cierto: ahora el que grita es el chequeo 1b, con el nombre de la MV.
insert into public.rep_cron_verificado (jobname, verificado_at, nota)
values ('refresh-mvs-daily', now(),
  'partido en lk_refresh_mvs(): cada MV en su bloque, el job ya no se cae entero por Chef. '
  'mv_loke_sales_agg (jul -> ago, 183.740 -> 187.779 filas) y mv_chef_customers_resolved (757 -> 762) '
  'refrescadas a mano OK. mv_chef_sales_loke SIGUE fallando (loke_reader sin SELECT sobre public.sales_line '
  'del lado de Chef) y ahora lo reporta la rama nueva de rep_salud, con el nombre de la MV y el motivo.')
on conflict (jobname) do update
  set verificado_at = excluded.verificado_at, nota = excluded.nota;

-- Y se recalcula la Estadística Madre, que venía sobre la MV vieja.
select public.refresh_estadistica_madre_cache();
