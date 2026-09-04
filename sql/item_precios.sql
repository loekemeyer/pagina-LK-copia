-- ============================================================================
-- PRECIOS PARA VALORIZAR, SEPARADOS DEL CATALOGO WEB
-- (proyecto Supabase LK kwkclwhmoygunqmlegrg · 2026-09-04)
-- ============================================================================
-- EL PROBLEMA
-- `products` hace dos trabajos que no son el mismo:
--   1. Es el CATALOGO que ven los mayoristas en el portal. Por eso filtra
--      `active`, y por eso tiene 199 filas activas: es lo que se publica.
--   2. Es de donde sale el PRECIO para valorizar ventas historicas.
--
-- Como catalogo esta bien. Como fuente de precios deja afuera todo lo que se
-- vendio y no esta publicado: en 12 meses se vendieron 390 codigos distintos y
-- products tiene 199 activos. El 1/7/2026 empezo a venderse una linea entera que
-- nunca se cargo y la cobertura se desplomo del 98,9% de las cajas en mayo al
-- 81,4% en agosto — o sea que todo monto de plata salia ~16% corto.
--
-- Meter esos codigos en `products` no sirve: con `active = true` aparecen en la
-- tienda web (y son variantes de 5 clientes puntuales, no productos publicables),
-- y con `active = false` no se valorizan igual, porque todas las funciones de
-- plata joinean `and p.active is true`.
--
-- LA SEPARACION
-- `item_precios` es el SUPLEMENTO: solo los codigos que se venden y NO estan en
-- products ni en loke_products. No duplica el maestro, lo completa.
-- `v_item_precio` los une con precedencia y es lo que tienen que usar las
-- funciones de valorizacion en vez de joinear `products` directo.
--
-- La vista NO filtra `active` a proposito: para valorizar una venta historica
-- interesa el precio del articulo que se vendio, este publicado hoy o no. Ese
-- filtro pertenece al catalogo, no a la valorizacion.
--
-- EFECTO MEDIDO (cajas con precio / monto del mes)
--   mes      products activo   v_item_precio    monto antes -> despues
--   2026-05      98,9%            99,8%         $617,9 M -> $622,9 M  (+0,8%)
--   2026-06      91,5%            97,2%         $396,4 M -> $407,5 M  (+2,8%)
--   2026-07      82,4%            89,6%         $405,8 M -> $438,8 M  (+8,1%)
--   2026-08      81,4%            89,7%         $477,0 M -> $522,1 M  (+9,5%)
--
-- Contraste independiente: el despacho valorizado desde Virgilio da $538,9 M para
-- agosto. Antes el ERP daba 119% de eso; ahora da 97%. Los dos caminos convergen.
-- ============================================================================

create table if not exists public.item_precios (
  cod          text primary key,
  description  text,
  uxb          integer not null check (uxb > 0),
  list_price   numeric not null check (list_price >= 0),
  category     text,
  origen       text not null,      -- 'variante_L' | 'chef' | 'manual'
  base_cod     text,               -- de donde se derivo, si aplica
  nota         text,
  actualizado_at timestamptz not null default now()
);
alter table public.item_precios enable row level security;
revoke all on table public.item_precios from public, anon, authenticated;

create or replace view public.v_item_precio as
select p.cod, p.description, p.uxb, p.list_price, p.category, 'products'::text as fuente
from products p
where coalesce(p.uxb,0) > 0 and coalesce(p.list_price,0) > 0
union all
select lp.cod, lp.description, lp.uxb, lp.list_price, null, 'loke_products'
from loke_products lp
where coalesce(lp.uxb,0) > 0 and coalesce(lp.list_price,0) > 0
  and not exists (select 1 from products p2 where p2.cod = lp.cod)
union all
select i.cod, i.description, i.uxb, i.list_price, i.category, 'item_precios:'||i.origen
from item_precios i
where not exists (select 1 from products p3 where p3.cod = i.cod)
  and not exists (select 1 from loke_products l3 where l3.cod = i.cod);

revoke all on public.v_item_precio from anon, authenticated;


-- ---------------------------------------------------------------------------
-- CARGA 1: las 78 variantes con sufijo L
-- ---------------------------------------------------------------------------
-- El sufijo L es una variante del mismo articulo para un cliente puntual: las
-- compran solo 5 codigos de cliente (1434, 2444, 2460, 2686, 2714). El usuario
-- confirmo el 4/9/2026 que **valen lo mismo que el articulo sin la L**, asi que
-- precio, uxb y descripcion se derivan del codigo base.
-- 75 salen de products y 3 de loke_products (123L, 102EL, 106EL, cuyas bases son
-- de la linea Loke). Son 2.616 cajas en 12 meses.

insert into public.item_precios (cod, description, uxb, list_price, category, origen, base_cod, nota)
select e.item_code,
       coalesce(b.description, lb.description),
       coalesce(b.uxb, lb.uxb),
       coalesce(b.list_price, lb.list_price),
       b.category,
       'variante_L',
       e.base,
       'Variante para cliente puntual. Mismo precio que el codigo base (confirmado por el usuario, 4/9/2026). Base tomada de '
         || case when b.cod is not null then 'products' else 'loke_products' end || '.'
from (
  select distinct sl.item_code, regexp_replace(sl.item_code,'L$','') as base
  from sales_lines sl
  left join products p  on p.cod  = sl.item_code
  left join loke_products lp on lp.cod = sl.item_code
  where sl.empresa='lk' and sl.boxes is not null
    and sl.invoice_date >= to_char(current_date - interval '12 months','YYYY-MM-DD')
    and p.cod is null and lp.cod is null
    and sl.item_code ~ 'L$'
    and sl.item_code <> all (array(select item_code from sales_excluded_items))
) e
left join products b       on b.cod  = e.base
left join loke_products lb on lb.cod = e.base
where coalesce(b.list_price, lb.list_price) > 0
  and coalesce(b.uxb, lb.uxb) > 0
on conflict (cod) do nothing;


-- ---------------------------------------------------------------------------
-- PENDIENTE
-- ---------------------------------------------------------------------------
-- 1. Faltan ~89 codigos de la linea que empezo a venderse el 1/7/2026 (706, 713,
--    099, 701, 836, 702E, 097, 824...) mas el 574, que vende a 41 clientes desde
--    2023. De 81 de ellos hay descripcion, uxb y categoria en el catalogo de CHEF
--    (chef_ext.products, por FDW); lo unico que falta es el PRECIO DE LISTA DE LK,
--    que no existe en ninguna tabla del proyecto (se busco en products,
--    loke_products, milver_products, estadistica_madre_cache, pa/osa/tyl_articulos,
--    precios_super y order_items).
-- 2. Migrar las funciones de valorizacion para que usen `v_item_precio` en vez de
--    joinear `products` con `active is true`. Sube el monto reportado ~9,5% en
--    agosto, asi que conviene hacerlo de una sola vez y avisando.
--    Afectadas: gv_dashboard_calcular, gv_dashboard_calcular2, gv_dashboard_extra,
--    gv_drill, get_ranking_inactivos, get_ranking_inactivos_export, rep_caidas,
--    datos_cliente_empresa, ppp_valor_linea.
