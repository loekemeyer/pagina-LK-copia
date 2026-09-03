-- ============================================================================
-- VIGILANCIA DEL SISTEMA  (proyecto Supabase LK kwkclwhmoygunqmlegrg)
-- ============================================================================
-- POR QUE EXISTE: `pg_cron` marca la corrida como `failed` y NO AVISA A NADIE.
-- Asi estuvieron cinco crons caidos entre 7 y 51 dias sin que nadie se enterara;
-- el sintoma visible fue el panel mostrando julio cuando `sales_lines` ya tenia
-- agosto, y el "por facturar" reportando un backlog de tres semanas atras.
-- Un reporte que miente en silencio es peor que no tener reporte.
--
-- `rep_salud()` devuelve UNA FILA POR PROBLEMA. Vacia = todo bien.
-- `rep_enviar_salud()` la manda por Telegram SOLO si hay algo: un aviso diario
-- de "todo bien" se deja de leer, y el dia que dice algo tampoco se lee.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- MEMORIA DE VERIFICACION MANUAL
-- ---------------------------------------------------------------------------
-- Un cron arreglado a la tarde sigue mostrando la corrida fallida de la mañana
-- hasta que le toque correr de nuevo. Sin esto la alerta grita por algo ya
-- resuelto — y una alerta que grita de mas se deja de leer, que es exactamente
-- lo que hay que evitar. Paso el primer dia: se arreglaron tres crons y la
-- alerta los siguio reportando como caidos.
--
-- Uso, despues de arreglar y VERIFICAR corriendo la funcion a mano:
--   select rep_cron_ok('sincronizar-ppp-diario', 'que se arreglo y como se verifico');
-- Si el cron vuelve a fallar en su proxima corrida real, el filtro ya no aplica
-- (la corrida nueva es posterior a la verificacion) y la alerta vuelve a salir.

create table if not exists public.rep_cron_verificado (
  jobname       text primary key,
  verificado_at timestamptz not null default now(),
  nota          text
);
alter table public.rep_cron_verificado enable row level security;
revoke all on table public.rep_cron_verificado from public, anon, authenticated;

create or replace function public.rep_cron_ok(p_jobname text, p_nota text default null)
returns void language sql security definer
set search_path to 'public','pg_temp'
as $$
  insert into public.rep_cron_verificado (jobname, verificado_at, nota)
  values (p_jobname, now(), p_nota)
  on conflict (jobname) do update set verificado_at = now(), nota = excluded.nota;
$$;
revoke all on function public.rep_cron_ok(text,text) from public, anon, authenticated;


create or replace function public.rep_salud()
returns table(severidad text, area text, detalle text)
language sql stable security definer
set search_path to 'public','pg_temp'
as $$
  -- 1. Crons cuya ULTIMA corrida fallo. Se limita a los que corrieron en los
  --    ultimos 3 dias: un job semanal o mensual que todavia no le toco no es una
  --    falla, y `cron.job_run_details` se purga, asi que "sin corridas" no
  --    distingue "nunca corrio" de "la corrida vieja ya no esta guardada".
  select '🔴', 'cron ' || j.jobname,
         case when ok.ultimo_ok is null then 'nunca terminó bien'
              else 'falla desde hace ' || (current_date - ok.ultimo_ok)::text || ' días' end
  from cron.job j
  join lateral (select r.status, r.start_time from cron.job_run_details r
                 where r.jobid = j.jobid order by r.start_time desc limit 1) ult on true
  left join lateral (select max(r2.start_time)::date as ultimo_ok from cron.job_run_details r2
                      where r2.jobid = j.jobid and r2.status = 'succeeded') ok on true
  left join public.rep_cron_verificado v on v.jobname = j.jobname
  where j.active and ult.status = 'failed'
    and ult.start_time >= now() - interval '3 days'
    -- Silencia lo arreglado y verificado a mano DESPUES de la corrida fallida.
    and (v.verificado_at is null or v.verificado_at < ult.start_time)

  union all
  -- 2. Cache del dashboard viejo. Lo refresca gerente-ventas-diario.
  select case when age > 3 then '🔴' else '🟠' end, 'dashboard',
         'gv_dash_cache tiene ' || age || ' días'
  from (select (current_date - generado_at::date) as age from gv_dash_cache where id = 1) x
  where age > 1

  union all
  -- 3. Espejo PPP viejo -> el "por facturar" seria de otra semana.
  select case when age > 3 then '🔴' else '🟠' end, 'PPP',
         'última salida registrada hace ' || age || ' días'
  from (select (current_date - max(fecha_salida)) as age from ppp_facturacion) x
  where age > 2

  union all
  -- 4. El lote mensual del ERP no llego. Se carga a mano entre el 2 y el 14.
  select case when extract(day from current_date) > 14 then '🔴' else '🟠' end, 'ERP',
         'sales_lines llega hasta ' || ult || ', ya estamos en ' || to_char(current_date,'YYYY-MM')
  from (select left(max(invoice_date),7) as ult from sales_lines where empresa='lk') x
  where ult < to_char(current_date - interval '1 month','YYYY-MM')
    and extract(day from current_date) >= 5

  union all
  -- 5. Cajas que no se pueden valorizar. Si sube, TODO numero de plata sale corto.
  --    Paso de 0,1% en mayo a 16% en agosto: una linea entera de productos
  --    empezo a venderse el 1/7 y nunca se cargo en `products`.
  select case when pct >= 10 then '🔴' when pct >= 5 then '🟠' else '🟡' end, 'maestro de artículos',
         pct || '% de las cajas del último mes sin ficha (' || codigos || ' códigos) → la plata sale corta'
  from (
    select round(100.0*sum(sl.boxes) filter (where p.cod is null and lp.cod is null)/nullif(sum(sl.boxes),0),1) as pct,
           count(distinct sl.item_code) filter (where p.cod is null and lp.cod is null) as codigos
    from sales_lines sl
    left join products p on p.cod = sl.item_code
    left join loke_products lp on lp.cod = sl.item_code
    where sl.empresa='lk'
      and left(sl.invoice_date,7) = (select left(max(invoice_date),7) from sales_lines where empresa='lk')
      and sl.item_code <> all (array(select item_code from sales_excluded_items))
  ) x where pct >= 3

  union all
  -- 6. Lineas de venta sin cantidad. No suman a ningun total y, peor, en un
  --    ranking `ORDER BY sum(boxes) DESC` los NULL van PRIMEROS: un cliente sin
  --    una sola caja contable encabezaba el top 20 de "principales".
  select '🟠', 'datos', lineas || ' líneas de sales_lines con boxes NULL (' ||
         clientes || ' cliente/s, desde ' || desde || ')'
  from (
    select count(*) as lineas, count(distinct customer_code) as clientes,
           min(invoice_date) as desde
    from sales_lines where empresa='lk' and boxes is null
  ) x where lineas > 0

  union all
  -- 7. Mensajes de Telegram que se rindieron despues de 60 intentos.
  select '🟠', 'telegram', count(*) || ' mensajes fallidos en la cola'
  from telegram_outbox where status = 'failed'
  having count(*) > 0;
$$;

create or replace function public.rep_enviar_salud()
returns void language plpgsql security definer
set search_path to 'public','pg_temp'
as $$
declare
  filas text; n int;
  hoy date := (now() at time zone 'America/Argentina/Buenos_Aires')::date;
begin
  select count(*), string_agg(s.severidad || ' ' || s.area || E'\n   ' || s.detalle, E'\n')
    into n, filas from public.rep_salud() s;

  if n = 0 then return; end if;   -- silencio cuando todo anda

  perform tg_enqueue_largo(
    '⚠️ SALUD DEL SISTEMA · ' || to_char(hoy,'DD/MM') || E'\n'
    || '━━━━━━━━━━━━━━━━━━' || E'\n\n' || filas || E'\n\n'
    || '_Mientras esto figure, los números de los reportes pueden estar viejos o cortos._',
    'salud_' || to_char(hoy,'YYYYMMDD'));
end $$;

revoke all on function public.rep_salud()        from public, anon, authenticated;
revoke all on function public.rep_enviar_salud() from public, anon, authenticated;

-- 08:05 ART, ANTES del reporte diario: si algo esta roto, que se sepa primero.
select cron.schedule('salud-sistema-telegram', '5 11 * * *', 'select public.rep_enviar_salud()');
