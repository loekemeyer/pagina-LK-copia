-- ============================================================================
-- GUARD SIN STOCK EN EL BACKEND  ·  2026-09-21  ·  pedido de Thomas
-- Proyecto Supabase LK: kwkclwhmoygunqmlegrg
-- ============================================================================
-- QUE RESUELVE
-- El badge `products.badge_status = 'SIN STOCK'` pinta el cartel y deshabilita el
-- boton, pero frenaba SOLO en el front: el guard vive en `agregarAlCarrito`
-- (script.js ~7375) y hay unos 10 lugares que meten lineas al carrito sin pasar
-- por ahi -- carrito de localStorage (hydrateCartFromLS), carritos guardados en
-- la DB (saved_carts), pedido en edicion, sugerencias del vendedor, el Excel de
-- vendedores. `submit_order_fast` y `edit_order_fast` NO miraban ni `active` ni
-- `badge_status`, asi que por cualquiera de esos caminos el pedido entraba igual.
--
-- Medido el 21/09/2026: el 573 (Bombilla Colores Metalizados), marcado SIN STOCK
-- y con 0 cajas en el libro de stock de Gestion, entro igual -- pedido 1507,
-- 3 cajas, 10:43 ART, ya enviado al Sheet. (No se puede probar la cronologia del
-- badge: `products` no tiene `updated_at`.)
--
-- Va en el BACKEND porque es UNA sola puerta en vez de diez, y porque es la regla
-- del repo: la logica de negocio que afecta datos persistidos va en Supabase y el
-- front la duplica como optimizacion de UX, nunca al reves.
--
-- ROLLBACK: las definiciones previas de las dos funciones quedaron en
--   zz_backups."LK_Backup_funcdef_pedidos_20260921"  (firma, def, backup_ts)
-- Para volver atras: ejecutar el `def` de la fila que corresponda, y
--   drop function public.pedido_items_sin_stock(jsonb);
--
-- QUE NO HACE
--   · NO frena al admin. `admin.js`, `admin-supercot.js`, `admin-excel-krikos.js`
--     y `vendor-import-excel.js` cargan OC de supermercados en rafaga, y el super
--     pide lo que pide: frenarlos dejaria una OC de Coto sin poder cargarse.
--     Misma excepcion que ya usa el guard anti-reintento.
--   · NO avisa temprano en el carrito. El cliente se entera al confirmar, con el
--     mensaje de la RPC. El aviso en la pantalla del carrito es un cambio de front
--     aparte, y tiene una trampa: si se saca la linea sin stock de un carrito que
--     esta EN EDICION, el guard de "al pedido solo se le puede AGREGAR" frena la
--     confirmacion, o sea que el pedido queda intrabajable.
-- ============================================================================

-- 1) EL HELPER -------------------------------------------------------------
-- Devuelve los codigos del payload que no se pueden pedir (separados por coma)
-- o NULL si estan todos bien.
create or replace function public.pedido_items_sin_stock(p_items jsonb)
returns text
language sql
stable
security definer
set search_path to 'public'
as $$
  -- El cast a uuid va DENTRO de un CASE a proposito: un regex puesto en el mismo
  -- WHERE no protege nada, Postgres evalua el cast primero y un product_id con
  -- basura tiraria 22P02 y la RPC entera devolveria 400 (problema 358).
  select string_agg(distinct cod, ', ')
    from (
      select coalesce(p.cod, lp.cod) as cod
        from (
          select case when it->>'product_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                      then (it->>'product_id')::uuid end as pid,
                 coalesce((it->>'is_loke')::boolean, false) as il
            from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) it
        ) q
        left join products      p  on not q.il and p.id  = q.pid
        left join loke_products lp on     q.il and lp.id = q.pid
       where (p.id is not null and (p.active is not true
               or upper(btrim(coalesce(p.badge_status,''))) in ('SIN STOCK','PROXIMAMENTE','PRÓXIMAMENTE')))
          or (lp.id is not null and lp.active is not true)
    ) z;
$$;
-- `loke_products` NO tiene `badge_status`, solo `active`: para la linea Loke el
-- guard mira eso y nada mas.
revoke execute on function public.pedido_items_sin_stock(jsonb) from public, anon, authenticated;

-- 2) submit_order_fast -----------------------------------------------------
-- Se parchea sobre la definicion VIVA (nunca sobre una copia del repo: varias
-- sesiones tocan los mismos objetos y un CREATE OR REPLACE pisa el cuerpo entero
-- sin decir nada). Si un ancla no matchea, aborta y no aplica nada. Idempotente.
do $do$
declare v_def text; v_blk text;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'submit_order_fast';
  if v_def is null then raise exception 'no encontre submit_order_fast'; end if;
  if position('pedido_items_sin_stock' in v_def) > 0 then
    raise notice 'ya tenia el guard, no toco nada'; return; end if;

  v_blk := $blk$  -- GUARD SIN STOCK (Thomas, 21/09/2026). El badge SIN STOCK del catalogo
  -- frenaba SOLO en el front, y hay ~10 lugares que meten lineas al carrito sin
  -- pasar por agregarAlCarrito (carrito guardado de la DB, carrito de
  -- localStorage, pedido en edicion, sugerencias, Excel de vendedores). Aca es
  -- UNA sola puerta. Medido el 21/09: el 573, marcado SIN STOCK y con 0 cajas en
  -- Gestion, entro igual (pedido 1507, 3 cajas, ya enviado al Sheet).
  -- NO aplica al admin, igual que el guard anti-reintento de abajo: carga OC de
  -- supermercados en rafaga y el super pide lo que pide.
  IF NOT v_es_admin THEN
    v_sin_stock := public.pedido_items_sin_stock(p_items);
    IF v_sin_stock IS NOT NULL THEN
      RAISE EXCEPTION 'Sin stock: %. Sacá esos artículos del carrito para poder confirmar el pedido.', v_sin_stock
        USING errcode = 'check_violation';
    END IF;
  END IF;

$blk$;

  v_def := replace(v_def, 'v_payload  jsonb;', 'v_payload  jsonb;' || chr(10) || '  v_sin_stock text;');
  if position('v_sin_stock text;' in v_def) = 0 then raise exception 'ancla 1 (declare) no matcheo'; end if;

  v_def := replace(v_def, '  -- GUARD ANTI-REINTENTO', v_blk || '  -- GUARD ANTI-REINTENTO');
  if position('GUARD SIN STOCK' in v_def) = 0 then raise exception 'ancla 2 (guard) no matcheo'; end if;

  execute v_def;
  raise notice 'submit_order_fast actualizada';
end $do$;

-- 3) edit_order_fast -------------------------------------------------------
-- ⚠ Al editar, el guard va SOLO sobre lo que se AGREGA. Mirar el pedido entero
-- dejaria intrabajable a cualquier pedido viejo que ya tenga adentro un codigo
-- que despues quedo sin stock: arriba esta prohibido QUITAR lineas, asi que no
-- habria forma de confirmar la edicion ni de sacar el codigo.
do $do$
declare v_def text; v_blk text; v_anchor text;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'edit_order_fast';
  if v_def is null then raise exception 'no encontre edit_order_fast'; end if;
  if position('GUARD SIN STOCK' in v_def) > 0 then
    raise notice 'ya tenia el guard, no toco nada'; return; end if;

  v_blk := $blk$  -- GUARD SIN STOCK AL EDITAR (Thomas, 21/09/2026). Va SOLO sobre lo que se
  -- AGREGA, nunca sobre lo que el pedido ya tenia: arriba esta prohibido QUITAR
  -- lineas, asi que mirar el pedido entero dejaria sin editar para siempre a
  -- cualquier pedido viejo que ya tenga un codigo que despues quedo sin stock.
  if not v_es_admin then
    select string_agg(distinct coalesce(p.cod, lp.cod), ', ') into v_sin_stock
      from (select case when i->>'product_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                        then (i->>'product_id')::uuid end as pid,
                   coalesce((i->>'is_loke')::boolean, false) as il,
                   sum((i->>'cajas')::int) as cajas
              from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) i group by 1, 2) nuevo
      left join (select coalesce(oi.product_id, oi.loke_product_id) as pid,
                        coalesce(oi.is_loke, false) as il, sum(oi.cajas)::int as cajas
                   from order_items oi where oi.order_id = p_order_id group by 1, 2) viejo
        on viejo.pid = nuevo.pid and viejo.il = nuevo.il
      left join products      p  on not nuevo.il and p.id  = nuevo.pid
      left join loke_products lp on     nuevo.il and lp.id = nuevo.pid
     where nuevo.cajas > coalesce(viejo.cajas, 0)
       and ((p.id is not null and (p.active is not true
              or upper(btrim(coalesce(p.badge_status,''))) in ('SIN STOCK','PROXIMAMENTE','PRÓXIMAMENTE')))
         or (lp.id is not null and lp.active is not true));
    if v_sin_stock is not null then
      raise exception 'Sin stock: %. No se puede agregar eso al pedido.', v_sin_stock
        using errcode = 'check_violation';
    end if;
  end if;

$blk$;

  v_def := replace(v_def, 'v_quitado text;', 'v_quitado text; v_sin_stock text;');
  if position('v_sin_stock text;' in v_def) = 0 then raise exception 'ancla 1 (declare) no matcheo'; end if;

  v_anchor := '  update orders' || chr(10) || '     set payment_method = p_payment_method';
  if position(v_anchor in v_def) = 0 then raise exception 'ancla 2 (update orders) no matcheo'; end if;
  v_def := replace(v_def, v_anchor, v_blk || v_anchor);

  execute v_def;
  raise notice 'edit_order_fast actualizada';
end $do$;

-- ============================================================================
-- COMO SE PROBO (21/09/2026) -- no alcanza con leer la funcion: se llamo de
-- verdad, con `set_config('request.jwt.claims', ...)` para que auth.uid() sea el
-- del cliente, y un `raise exception` al final para revertir TODO.
--
--   submit_order_fast, como CLIENTE
--     solo 573 .................. FRENADO: "Sin stock: 573. Sacá esos artículos…"
--     332 (con stock) + 336 ..... FRENADO: "Sin stock: 336…"  (el bueno no salva al malo)
--     solo 332 .................. PASO
--   edit_order_fast, como CLIENTE, sobre un pedido que YA tenia 573 adentro
--     agregarle 332 ............. PASO      (el pedido no queda trabado)
--     subirle las cajas del 573 .. FRENADO: "Sin stock: 573. No se puede agregar…"
--   submit_order_fast, como ADMIN
--     9 cajas del 573 ........... PASO      (la carga de OC de super sigue andando)
--
-- Verificado despues: 0 pedidos creados, max(orders.id) intacto. Los ids de la
-- secuencia que consumieron las pruebas (1516-1518) quedan sin usar: una secuencia
-- no se revierte, y no hay nada que valide que los numeros de pedido sean seguidos.
--
-- CHEQUEO, para volver a medirlo:
--   -- OJO: se busca 'GUARD SIN STOCK', que esta en las dos. Buscar el nombre del
--   -- helper da FALSO NEGATIVO en edit_order_fast, que lo lleva inline (necesita
--   -- comparar viejo vs nuevo y el helper no sabe de eso).
--   select p.proname,
--          position('GUARD SIN STOCK' in pg_get_functiondef(p.oid)) > 0 as tiene_guard
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and p.proname in ('submit_order_fast','edit_order_fast');
--   -- al 21/09: las dos en true
-- ============================================================================
