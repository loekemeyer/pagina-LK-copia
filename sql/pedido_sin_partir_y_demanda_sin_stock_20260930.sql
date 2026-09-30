-- =============================================================================
-- pedido_sin_partir_y_demanda_sin_stock_20260930.sql — proyecto LK (kwkclwhmoygunqmlegrg)
-- Luis, 30/09/2026: *"que deje de partir el pedido con importados sin stock:
-- programá el pedido completo (como antes del cambio)"* + *"que el sistema guarde
-- el dato de clientes que nos piden importados que no tenemos: qué cliente, cuándo
-- y cuánto"*.
--
-- QUÉ CAMBIA
--   1) marcar_pedido_diferido (LK, lo llama el trigger de orders) y
--      marcar_diferidos_chef_ids (Chef, lo llama sincronizar_chef_orders) dejan de
--      escribir `pedido_diferido`. Sin filas nuevas ahí, v_pedidos_web_np y
--      gv_pedidos_web_np_chef cortan el pedido como antes del 11/09 (bloques de
--      18 / 15 líneas) y Gestión lo programa entero. Nada de Gestión se toca: los
--      pases de diferido (b2, a0d2, gv_ppp_web_diferido_tarde) quedan sin trabajo.
--   2) En su lugar escriben `pedido_sin_stock`: una fila por (empresa, pedido,
--      artículo) que al entrar el pedido figuraba sin stock. Se anota SIEMPRE,
--      también para el cliente nuevo (antes quedaba afuera del diferido).
--   3) Backfill con lo que ya estaba en pedido_diferido (16 pedidos, 33 líneas).
--
-- LO QUE NO CAMBIA
--   * Las 33 líneas viejas de pedido_diferido quedan: esos pedidos siguen partidos
--     y esperando su reingreso (21 NP en GV_PPP_Web_Diferido al 30/09). Borrarlas
--     cambiaría el corte de NP ya programadas (la identidad (order_id, np_idx)).
--   * El cartel "Sin stock / hasta dd/mm" de las páginas (reingreso_cache).
--
-- ROLLBACK: volver a correr los bodies anteriores de las dos funciones (están en
-- sql/pedido_diferido.sql y sql/diferido_chef_entrada.sql + la regla de cliente
-- nuevo de sql/cliente_nuevo_sin_diferido_20260928.sql). La tabla nueva no molesta.
-- =============================================================================

-- 1) La tabla de demanda sin stock
create table if not exists public.pedido_sin_stock (
  empresa         text        not null,             -- 'lk' | 'chef'
  order_id        bigint      not null,             -- pedido de la página de esa empresa
  art             text        not null,             -- código tal cual el pedido (438EL con L)
  cod_cliente     text,
  razon_social    text,
  cajas           numeric,
  unidades        numeric,
  fecha_pedido    timestamptz,                      -- cuándo lo pidió
  fecha_reingreso date,                             -- la estimada AL MOMENTO del pedido (null = sin fecha)
  origen          text        not null default 'pedido',   -- 'pedido' | 'backfill'
  creado_at       timestamptz not null default now(),
  primary key (empresa, order_id, art)
);
alter table public.pedido_sin_stock enable row level security;
revoke all on public.pedido_sin_stock from anon, authenticated;
comment on table public.pedido_sin_stock is
  'Demanda de artículos que al entrar el pedido figuraban sin stock (reingreso_cache / reingreso_cache_chef). Luis 30/09/2026: se guarda qué cliente los pidió, cuándo y cuánto. NO parte el pedido.';
create index if not exists pedido_sin_stock_art_idx on public.pedido_sin_stock (art);

-- 2) LK: el trigger ya no parte, anota
create or replace function public.marcar_pedido_diferido(p_order_id bigint)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_n int := 0;
begin
  -- v2026-09-30 (Luis): el pedido YA NO se parte por reingreso (no se escribe
  -- pedido_diferido). Se anota la demanda sin stock en pedido_sin_stock, también
  -- para el cliente nuevo. Una fila por artículo; on conflict = se anota una vez.
  insert into public.pedido_sin_stock
    (empresa, order_id, art, cod_cliente, razon_social, cajas, unidades, fecha_pedido, fecha_reingreso, origen)
  select 'lk', p.order_id, upper(btrim(p.art)), max(p.cod_cliente), max(p.razon_social),
         sum(p.cajas), sum(p.uni), min(p.created_at), max(r.fecha_reingreso), 'pedido'
    from public.v_pedidos_web p
    join public.reingreso_cache r
      on r.sin_stock
     and (r.cod = upper(btrim(p.art))
          or (upper(btrim(p.art)) ~ 'L$' and r.cod = regexp_replace(upper(btrim(p.art)),'L$','')))
   where p.order_id = p_order_id
   group by p.order_id, upper(btrim(p.art))
  on conflict do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end;
$function$;

-- 3) Chef: idem (lo llama sincronizar_chef_orders al entrar el pedido a la copia)
create or replace function public.marcar_diferidos_chef_ids(p_ids bigint[], p_origen text default 'sync'::text)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_n int := 0;
begin
  -- v2026-09-30 (Luis): el pedido YA NO se parte (no se escribe pedido_diferido).
  -- Se anota la demanda sin stock, cada artículo contra el cache de SU empresa:
  --   con L  (438EL) -> es de LK   -> reingreso_cache      (código sin la L)
  --   sin L  (438E)  -> es de Chef -> reingreso_cache_chef
  if p_ids is null or cardinality(p_ids) = 0 then return 0; end if;
  insert into public.pedido_sin_stock
    (empresa, order_id, art, cod_cliente, razon_social, cajas, unidades, fecha_pedido, fecha_reingreso, origen)
  select 'chef', f.order_id, x.art, max(f.cod), max(f.razon_social),
         sum((it->>'cajas')::numeric), sum((it->>'uni')::numeric), min(f.fecha_recep)::timestamptz,
         max(coalesce(rl.fecha_reingreso, rc.fecha_reingreso)), 'pedido'
    from public.gv_pedidos_web_np_chef(120) f
    cross join lateral jsonb_array_elements(f.items) it
    cross join lateral (select upper(btrim(it->>'art')) as art) x
    left join public.reingreso_cache rl
      on x.art ~ '[0-9E]L$' and rl.sin_stock and rl.cod = regexp_replace(x.art,'L$','')
    left join public.reingreso_cache_chef rc
      on x.art !~ '[0-9E]L$' and rc.sin_stock and rc.cod = x.art
   where f.order_id = any(p_ids)
     and (rl.cod is not null or rc.cod is not null)
     and not exists (select 1 from public.chef_diferido_evaluado e where e.order_id = f.order_id)
   group by f.order_id, x.art
  on conflict do nothing;
  get diagnostics v_n = row_count;
  insert into public.chef_diferido_evaluado (order_id, marcados, origen)
  select i, (select count(*) from public.pedido_sin_stock d where d.empresa='chef' and d.order_id=i), p_origen
    from unnest(p_ids) i
  on conflict do nothing;
  return v_n;
end;
$function$;

-- 4) Backfill: lo que ya se había diferido desde el 11/09
insert into public.pedido_sin_stock
  (empresa, order_id, art, cod_cliente, razon_social, cajas, unidades, fecha_pedido, fecha_reingreso, origen, creado_at)
select d.empresa, d.order_id, upper(btrim(d.art)), max(p.cod_cliente), max(p.razon_social),
       sum(p.cajas), sum(p.uni), min(p.created_at), max(d.fecha_reingreso), 'backfill', min(d.creado_at)
  from public.pedido_diferido d
  left join public.v_pedidos_web p
    on d.empresa = 'lk' and p.order_id = d.order_id and upper(btrim(p.art)) = upper(btrim(d.art))
 group by d.empresa, d.order_id, upper(btrim(d.art))
on conflict do nothing;

-- Verificación
-- select empresa, origen, count(*), count(distinct order_id) from public.pedido_sin_stock group by 1,2;
-- select position('pedido_diferido (' in pg_get_functiondef('public.marcar_pedido_diferido(bigint)'::regprocedure)) = 0 as lk_ya_no_parte,
--        position('pedido_diferido (' in pg_get_functiondef('public.marcar_diferidos_chef_ids(bigint[],text)'::regprocedure)) = 0 as chef_ya_no_parte;
-- Publicación: con bump de version.js para que el navegador tome el script.js nuevo.
