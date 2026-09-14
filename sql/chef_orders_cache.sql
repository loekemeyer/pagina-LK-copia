-- =====================================================================================
-- chef_orders_cache — los pedidos de Chef dejan de leerse por FDW en el camino caliente
-- 2026-09-14 (pedido de Thomas). Baja `gv_pedidos_web_np_chef` de 7,03 s a 0,14 s.
-- =====================================================================================
-- EL PROBLEMA. `gv_pedidos_web_np_chef` es lo que le da a Gestion el feed de pedidos web
-- de Chef, y la llama el armado de tandas cada 15 minutos. Tardaba **7,03 s** contra un
-- `statement_timeout` de **8 s**: el **3,1 % de las corridas** moria con
-- `57014 canceling statement due to statement timeout` (14 de 446 en la semana del 08 al
-- 14/09, medido sobre `GV_Tandas_Auto_Log` de Virgilio). Cuando eso pasa, esa corrida
-- programa LK y **no** programa Chef.
--
-- ── ⚠ LA CAUSA NO ERA LA CONSULTA: ERA LA CONEXION ──────────────────────────────────
-- Medicion contra el Storage... no: contra las propias foreign tables, con EXPLAIN ANALYZE.
--
--   select count(*) from public.chef_customers;        -- lo resuelve el REMOTO, vuelve 1 numero
--     Foreign Scan  (actual time=388.773..388.775 rows=1)
--     Execution Time: **2879.413 ms**
--
--   select count(*) from virgilio.volumen_articulo;    -- mismo mecanismo, otro destino
--     Foreign Scan  (actual time=21.537..21.538 rows=1)
--     Execution Time: **69.892 ms**
--
-- Mismo `postgres_fdw`, misma configuracion de server en los dos (`port=5432`,
-- `sslmode=require`). La diferencia es a DONDE se conecta: LK y Virgilio estan en la misma
-- organizacion y region (`sa-east-1`); el proyecto de Chef esta en OTRA organizacion. Abrir
-- esa conexion cuesta **~2,4 s fijos**, se paguen 1 fila o 10.000. Ninguna optimizacion de
-- SQL baja ese numero.
--
-- El desarme de los 7,03 s:
--   ~2,4 s  abrir la conexion a Chef (piso, una vez por consulta)
--   ~0,8 s  `chef_orders`: el filtro de fecha NO SE EMPUJA. El plan decia textual
--           `Rows Removed by Filter: 45` sobre 72 filas — traia los 72 pedidos con el
--           `sheets_payload` ENTERO y filtraba aca. Causa: `current_date` es STABLE y
--           postgres_fdw solo manda expresiones inmutables.
--   ~0,7 s  `chef_customers` + `chef_customer_delivery_addresses`: padron y sucursales
--           completos, sin filtro.
--
-- ── LA SOLUCION: EL PATRON QUE ESTE REPO YA USA ─────────────────────────────────────
-- `chef_padron` existe exactamente por esto (ver el CLAUDE.md: *"Leerlas cuesta segundos:
-- 6.772 ms medidos... Nunca joinearlas en el camino caliente"*). Lo que faltaba es que la
-- funcion del feed lo aprovechara: iba a las foreign tables directas. Ahora hay copia local
-- de las tres, un cron que las refresca cada 5 min, y la funcion lee las copias.
--
-- **No se toca NADA del proyecto Supabase de Chef.** El unico que lo lee sigue siendo LK,
-- por el mismo FDW y el mismo rol, pero 288 veces por dia (el cron) en vez de en cada
-- corrida del armado.
--
-- ── ⚠ EL GUARD QUE NO SE PUEDE SACAR ────────────────────────────────────────────────
-- Si el remoto no contesta o devuelve el padron vacio, `sincronizar_chef_orders` **no pisa
-- nada** y lo deja anotado en `chef_cache_log`. Una copia vaciada saca de la PPP todos los
-- pedidos de Chef sin que nadie se entere — es mucho peor que trabajar con datos de hace
-- cinco minutos.
--
-- ── RESULTADO MEDIDO (14/09) ────────────────────────────────────────────────────────
--   gv_pedidos_web_np_chef(30):      7.030 ms  ->  **143 ms**   (49x)
--   corrida entera del armado:    16-25 s      ->  **8,0 s**
--   salida: **identica**. 36 filas = 36 filas, `except all` en los dos sentidos = 0, y
--           md5 del resultado completo igual: dffd1a383abfc4193654582c8055aa14
--
-- ── ROLLBACK ────────────────────────────────────────────────────────────────────────
-- `gv_pedidos_web_np_chef_fdw(integer)` es la COPIA EXACTA de la funcion vieja, la que lee
-- por FDW. Para volver atras:
--     select cron.unschedule('sincronizar-chef-orders');
--     -- y recrear gv_pedidos_web_np_chef con el cuerpo de gv_pedidos_web_np_chef_fdw:
--     -- select pg_get_functiondef('public.gv_pedidos_web_np_chef_fdw(integer)'::regprocedure);
--     -- (cambiandole el nombre) o correr el bloque "vuelta atras" del pie de este archivo.
-- Las tablas de cache pueden quedar: no las lee nadie mas.
--
-- ── QUEDA PENDIENTE ─────────────────────────────────────────────────────────────────
-- Otras cuatro funciones siguen leyendo el FDW de Chef y pagan los mismos ~2,4 s:
-- `get_pedidos_web_np_chef`, `oc_super_ya_cargada`, `refrescar_chef_padron` y
-- `costos_sync_razones`. Ninguna esta en el camino del armado, por eso no se tocaron.
-- =====================================================================================

-- ── 1) las tres copias locales ───────────────────────────────────────────────────────
create table if not exists public.chef_orders_cache (
  id                   bigint primary key,
  created_at           timestamptz,
  customer_id          uuid,
  status               text,
  sheets_payload       jsonb,
  payment_method       text,
  enviado_a_compras_at timestamptz,
  copiado_at           timestamptz not null default now()
);
create index if not exists chef_orders_cache_created_idx on public.chef_orders_cache (created_at);

create table if not exists public.chef_customers_cache (
  id            uuid primary key,
  cod_cliente   bigint,
  business_name text,
  cuit          text,
  copiado_at    timestamptz not null default now()
);
create index if not exists chef_customers_cache_cod_idx on public.chef_customers_cache (cod_cliente);

create table if not exists public.chef_dirs_cache (
  customer_id       uuid,
  slot              smallint,
  label             text,
  direccion_entrega text,
  zona_expreso      text,
  nombre_expreso    text,
  localidad         text,
  provincia         text,
  copiado_at        timestamptz not null default now(),
  primary key (customer_id, slot)
);
create index if not exists chef_dirs_cache_lab_idx on public.chef_dirs_cache (customer_id, (btrim(lower(label))));

create table if not exists public.chef_cache_log (
  id          bigserial primary key,
  corrida_en  timestamptz not null default now(),
  ok          boolean not null,
  motivo      text,
  n_orders    integer,
  n_customers integer,
  n_dirs      integer,
  ms          integer
);

-- Son datos de clientes de Chef: RLS prendida y sin policies, no los ve el navegador.
alter table public.chef_orders_cache    enable row level security;
alter table public.chef_customers_cache enable row level security;
alter table public.chef_dirs_cache      enable row level security;
alter table public.chef_cache_log       enable row level security;
revoke all on public.chef_orders_cache, public.chef_customers_cache,
              public.chef_dirs_cache, public.chef_cache_log from anon, authenticated;

-- ── 2) el copiador ───────────────────────────────────────────────────────────────────
-- (definicion viva: select pg_get_functiondef('public.sincronizar_chef_orders(integer)'::regprocedure);)
-- Ver el cuerpo completo mas abajo, en la seccion "definiciones vivas".

-- ── 3) el cron (jobid 48) ────────────────────────────────────────────────────────────
-- select cron.schedule('sincronizar-chef-orders', '*/5 * * * *',
--                      $$select public.sincronizar_chef_orders(90);$$);
-- Cada 5 min. La ventana del cache es de 90 dias: la funcion del feed pide 30, asi que
-- sobra margen si alguien sube `ventana_dias` en Virgilio.

-- ── 4) el centinela ──────────────────────────────────────────────────────────────────
-- `select * from public.chef_cache_salud();` — VACIO = todo bien. Avisa dos cosas: que el
-- cron dejo de correr (ultima corrida ok hace mas de 30 min) y que la copia no coincide con
-- Chef (conteos de pedidos, clientes y direcciones). Cuesta lo que cuesta el FDW (~7 s),
-- asi que NO se llama desde ninguna pantalla: se mira a mano o desde un cron diario.
--
-- ⚠ Una tabla derivada se desincroniza de su madre EN SILENCIO. Ese es el riesgo que este
-- cambio agrega y el unico motivo por el que existe el centinela.

-- ── 5) vuelta atras ──────────────────────────────────────────────────────────────────
-- do $rb$
-- declare v text;
-- begin
--   v := pg_get_functiondef('public.gv_pedidos_web_np_chef_fdw(integer)'::regprocedure);
--   execute replace(v, 'FUNCTION public.gv_pedidos_web_np_chef_fdw(',
--                      'FUNCTION public.gv_pedidos_web_np_chef(');
-- end $rb$;
-- select cron.unschedule('sincronizar-chef-orders');

-- =====================================================================================
-- DEFINICIONES VIVAS (volcadas de la base el 2026-09-14, despues de aplicar)
-- =====================================================================================

create or replace function public.sincronizar_chef_orders(p_dias integer default 90)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_t0 timestamptz := clock_timestamp();
  v_no integer; v_nc integer; v_nd integer;
  v_desde timestamptz;
begin
  -- 2026-09-14 (Thomas) — copia local de lo que gv_pedidos_web_np_chef leia por FDW.
  --
  -- POR QUE: leer el proyecto de Chef por postgres_fdw cuesta ~2,4 s SOLO de abrir la
  -- conexion (medido: un count(*) que el remoto resuelve entero tarda 2.879 ms contra los
  -- 70 ms del mismo count contra Virgilio, que esta en la misma org y region). Con eso mas
  -- lo que se transfiere, gv_pedidos_web_np_chef quedaba en 7,03 s contra un
  -- statement_timeout de 8 s, y el 3,1% de las corridas del armado de Gestion moria con
  -- 57014. Es el mismo patron que ya usa chef_padron / sincronizar_chef() por el mismo
  -- motivo, extendido a los pedidos y al uuid del cliente.
  --
  -- ⚠ SI EL REMOTO NO CONTESTA O VIENE VACIO, NO SE PISA NADA. Una copia vaciada saca de la
  -- PPP todos los pedidos de Chef sin que nadie se entere: es peor que quedarse con datos
  -- de hace 5 minutos.
  v_desde := (current_date - p_dias)::timestamp at time zone 'America/Argentina/Buenos_Aires';

  create temp table _co on commit drop as
    select o.id, o.created_at, o.customer_id, o.status, o.sheets_payload,
           o.payment_method, o.enviado_a_compras_at
      from public.chef_orders o
     where o.created_at >= v_desde;      -- parametro: postgres_fdw SI lo manda al remoto
  get diagnostics v_no = row_count;

  create temp table _cc on commit drop as
    select c.id, c.cod_cliente, c.business_name, c.cuit from public.chef_customers c;
  get diagnostics v_nc = row_count;

  create temp table _cd on commit drop as
    select d.customer_id, d.slot, d.label, d.direccion_entrega, d.zona_expreso,
           d.nombre_expreso, d.localidad, d.provincia
      from public.chef_customer_delivery_addresses d;
  get diagnostics v_nd = row_count;

  if v_nc = 0 or v_nd = 0 then
    insert into public.chef_cache_log (ok, motivo, n_orders, n_customers, n_dirs, ms)
    values (false, 'el padron de Chef vino vacio: no se pisa nada', v_no, v_nc, v_nd,
            extract(milliseconds from clock_timestamp() - v_t0)::int);
    return jsonb_build_object('ok', false, 'motivo', 'padron vacio');
  end if;

  delete from public.chef_orders_cache where created_at >= v_desde or created_at is null;
  insert into public.chef_orders_cache
        (id, created_at, customer_id, status, sheets_payload, payment_method, enviado_a_compras_at)
  select id, created_at, customer_id, status, sheets_payload, payment_method, enviado_a_compras_at
    from _co
      on conflict (id) do update set
         created_at = excluded.created_at, customer_id = excluded.customer_id,
         status = excluded.status, sheets_payload = excluded.sheets_payload,
         payment_method = excluded.payment_method,
         enviado_a_compras_at = excluded.enviado_a_compras_at, copiado_at = now();

  delete from public.chef_customers_cache where id is not null;
  insert into public.chef_customers_cache (id, cod_cliente, business_name, cuit)
  select id, cod_cliente, business_name, cuit from _cc;

  delete from public.chef_dirs_cache where customer_id is not null;
  insert into public.chef_dirs_cache
        (customer_id, slot, label, direccion_entrega, zona_expreso, nombre_expreso, localidad, provincia)
  select customer_id, slot, label, direccion_entrega, zona_expreso, nombre_expreso, localidad, provincia
    from _cd;

  insert into public.chef_cache_log (ok, motivo, n_orders, n_customers, n_dirs, ms)
  values (true, null, v_no, v_nc, v_nd, extract(milliseconds from clock_timestamp() - v_t0)::int);

  return jsonb_build_object('ok', true, 'orders', v_no, 'customers', v_nc, 'dirs', v_nd,
                            'ms', extract(milliseconds from clock_timestamp() - v_t0)::int);
end;
$function$;

revoke all on function public.sincronizar_chef_orders(integer) from public, anon, authenticated;
grant execute on function public.sincronizar_chef_orders(integer) to service_role;

create or replace function public.chef_cache_salud()
returns table (problema text, detalle text)
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  -- 2026-09-14 — una copia se desincroniza en silencio, y este es el unico modo de
  -- enterarse. Cuesta lo que cuesta el FDW (~7 s), asi que NO se llama desde el camino
  -- caliente. Vacio = todo bien.
  return query
  select 'el cron no corre'::text,
         'ultima corrida ok: ' || coalesce(max(corrida_en)::text, 'NUNCA')
    from public.chef_cache_log where ok
   having max(corrida_en) is null or max(corrida_en) < now() - interval '30 minutes';

  return query
  select 'la copia no coincide con Chef'::text,
         format('pedidos cache=%s vivo=%s · clientes cache=%s vivo=%s · dirs cache=%s vivo=%s',
                c_o, v_o, c_c, v_c, c_d, v_d)
    from (select (select count(*) from public.chef_orders_cache)    c_o,
                 (select count(*) from public.chef_orders o
                   where o.created_at >= (current_date - 90)::timestamp
                         at time zone 'America/Argentina/Buenos_Aires') v_o,
                 (select count(*) from public.chef_customers_cache) c_c,
                 (select count(*) from public.chef_customers)       v_c,
                 (select count(*) from public.chef_dirs_cache)      c_d,
                 (select count(*) from public.chef_customer_delivery_addresses) v_d) t
   where c_o <> v_o or c_c <> v_c or c_d <> v_d;
end;
$function$;

revoke all on function public.chef_cache_salud() from public, anon, authenticated;
grant execute on function public.chef_cache_salud() to service_role;

-- ── gv_pedidos_web_np_chef: el cambio es de TRES LINEAS ──────────────────────────────
-- El cuerpo es el mismo de siempre; lo unico que cambio son las tres fuentes. Se aplico
-- con este bloque, que ademas dejo la copia _fdw (el rollback) y fallaba si no reemplazaba
-- todo. Es reproducible tal cual:
--
-- do $do$
-- declare v_def text; v_fdw text; v_new text;
-- begin
--   v_def := pg_get_functiondef('public.gv_pedidos_web_np_chef(integer)'::regprocedure);
--   v_fdw := replace(v_def, 'FUNCTION public.gv_pedidos_web_np_chef(',
--                           'FUNCTION public.gv_pedidos_web_np_chef_fdw(');
--   if v_fdw = v_def then raise exception 'no se pudo renombrar la copia _fdw'; end if;
--   execute v_fdw;
--   v_new := replace(v_def, 'public.chef_orders o',    'public.chef_orders_cache o');
--   v_new := replace(v_new, 'public.chef_customers c', 'public.chef_customers_cache c');
--   v_new := replace(v_new, 'public.chef_customer_delivery_addresses d', 'public.chef_dirs_cache d');
--   if v_new = v_def then raise exception 'no se reemplazo ninguna foreign table'; end if;
--   if v_new like '%public.chef_orders o%' or v_new like '%public.chef_customers c%'
--      or v_new like '%public.chef_customer_delivery_addresses d%' then
--     raise exception 'quedo alguna foreign table sin reemplazar';
--   end if;
--   execute v_new;
-- end $do$;
--
-- Las tres lineas, para leerlas de un vistazo:
--   from public.chef_orders o                          ->  from public.chef_orders_cache o
--   from public.chef_customers c                       ->  from public.chef_customers_cache c
--   from public.chef_customer_delivery_addresses d     ->  from public.chef_dirs_cache d
--
-- La definicion completa y viva de las dos (la de produccion y la _fdw de rollback):
--   select pg_get_functiondef('public.gv_pedidos_web_np_chef(integer)'::regprocedure);
--   select pg_get_functiondef('public.gv_pedidos_web_np_chef_fdw(integer)'::regprocedure);

-- ── COMO SE VERIFICO (correr esto despues de cualquier cambio en cualquiera de las dos) ──
-- with a as (select * from public.gv_pedidos_web_np_chef(30)),
--      b as (select * from public.gv_pedidos_web_np_chef_fdw(30))
-- select (select count(*) from a) cache_filas, (select count(*) from b) fdw_filas,
--        (select count(*) from (select * from a except all select * from b) x) en_cache_no_en_fdw,
--        (select count(*) from (select * from b except all select * from a) y) en_fdw_no_en_cache,
--        (select md5(string_agg(t::text,'|' order by t::text)) from a t) md5_cache,
--        (select md5(string_agg(t::text,'|' order by t::text)) from b t) md5_fdw;
--
-- 14/09: 36 = 36, 0 y 0, y los dos md5 en dffd1a383abfc4193654582c8055aa14.
