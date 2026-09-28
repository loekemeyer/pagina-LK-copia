-- 2026-09-28 (Luis) — CLIENTE NUEVO: su pedido NO se parte por artículos que esperan reingreso.
-- "Clientes nuevos que hacen uno de sus 3 primeros pedidos y piden un artículo que no tenemos en stock
--  pero que sabemos que reingresa: no se parte el pedido ni se programa la pierna a largo plazo. Se
--  programa todo en 1 solo pedido y lo que no hay figura como faltante. Les pido pago adelantado y no
--  puedo pedirles pago adelantado por algo que les puedo entregar en meses."
-- Cliente nuevo = el mismo criterio de Cuarentena / pipeline: gv_clientes_nuevos_calc.es_nuevo
-- (código alto y < 3 pedidos facturados, contando la identidad cruzada LK/CH).
-- Tres puertas, y las tres se cierran:
--   1) checkout de la página (script.js de LK y de Chef): no parte el carrito en dos pedidos.
--   2) marcar_pedido_diferido (LK, trigger al entrar el pedido): no marca diferido.
--   3) marcar_diferidos_chef_ids (pedidos de Chef): no marca diferido.
-- Sin marca de diferido, v_pedidos_web_np / gv_pedidos_web_np_chef dan UNA NP y Gestión la programa
-- como cualquier pedido; lo que no hay sale como faltante en el armado.

create or replace function public.es_cliente_nuevo(p_empresa text, p_cod text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select g.es_nuevo from public.gv_clientes_nuevos_calc g
                    where g.empresa = lower(btrim(p_empresa)) and g.cod = btrim(p_cod) limit 1), false);
$$;
revoke all on function public.es_cliente_nuevo(text, text) from public;
grant execute on function public.es_cliente_nuevo(text, text) to anon, authenticated, service_role;

create or replace function public.marcar_pedido_diferido(p_order_id bigint)
 returns integer language plpgsql security definer set search_path to 'public' as $function$
declare v_n int := 0;
begin
  if exists (select 1 from public.pedido_diferido where empresa='lk' and order_id = p_order_id) then
    return 0;
  end if;
  -- 2026-09-28 (Luis): el pedido de un cliente nuevo no se difiere: sale entero, con faltante.
  if public.es_cliente_nuevo('lk', (select o.customer_code from public.orders o where o.id = p_order_id)) then
    return 0;
  end if;
  insert into public.pedido_diferido (empresa, order_id, art, fecha_reingreso)
  select 'lk', p.order_id, p.art, r.fecha_reingreso
    from public.v_pedidos_web p
    join public.reingreso_cache r
      on r.sin_stock
     and (r.cod = upper(btrim(p.art))
          or (upper(btrim(p.art)) ~ 'L$' and r.cod = regexp_replace(upper(btrim(p.art)),'L$','')))
   where p.order_id = p_order_id
   group by p.order_id, p.art, r.fecha_reingreso
  on conflict do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end;
$function$;

create or replace function public.marcar_diferidos_chef_ids(p_ids bigint[], p_origen text DEFAULT 'sync'::text)
 returns integer language plpgsql security definer set search_path to 'public' as $function$
declare v_n int := 0;
begin
  -- v22.09 (Luis, 23/09): el corte se decide UNA vez, al entrar el pedido, y cada
  -- articulo se mira contra el cache de SU empresa:
  --   con L  (438EL) -> es de LK   -> reingreso_cache      (codigo sin la L)
  --   sin L  (438E)  -> es de Chef -> reingreso_cache_chef
  -- 2026-09-28 (Luis): el pedido de un cliente nuevo no se difiere (es_cliente_nuevo).
  if p_ids is null or cardinality(p_ids) = 0 then return 0; end if;
  insert into public.pedido_diferido (empresa, order_id, art, fecha_reingreso)
  select 'chef', f.order_id, x.art, coalesce(rl.fecha_reingreso, rc.fecha_reingreso)
    from public.gv_pedidos_web_np_chef(120) f
    cross join lateral jsonb_array_elements(f.items) it
    cross join lateral (select upper(btrim(it->>'art')) as art) x
    left join public.reingreso_cache rl
      on x.art ~ '[0-9E]L$' and rl.sin_stock and rl.cod = regexp_replace(x.art,'L$','')
    left join public.reingreso_cache_chef rc
      on x.art !~ '[0-9E]L$' and rc.sin_stock and rc.cod = x.art
   where f.order_id = any(p_ids)
     and (rl.cod is not null or rc.cod is not null)
     and not public.es_cliente_nuevo('chef', f.cod)
     and not exists (select 1 from public.chef_diferido_evaluado e where e.order_id = f.order_id)
     and not exists (select 1 from public.pedido_diferido d where d.empresa='chef' and d.order_id = f.order_id)
   group by f.order_id, x.art, coalesce(rl.fecha_reingreso, rc.fecha_reingreso)
  on conflict do nothing;
  get diagnostics v_n = row_count;
  insert into public.chef_diferido_evaluado (order_id, marcados, origen)
  select i, (select count(*) from public.pedido_diferido d where d.empresa='chef' and d.order_id=i), p_origen
    from unnest(p_ids) i
  on conflict do nothing;
  return v_n;
end;
$function$;

-- Rollback: volver a crear marcar_pedido_diferido y marcar_diferidos_chef_ids sin la línea de
-- es_cliente_nuevo (las dos definiciones anteriores están en el historial de git de este archivo),
-- y drop function public.es_cliente_nuevo(text, text).
