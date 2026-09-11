-- =============================================================================
-- pedido_diferido.sql — Partir el pedido web en DOS cuando hay artículos que
-- todavía no llegaron. (2026-09-11, pedido del dueño)
-- =============================================================================
-- Regla del dueño (Thomas, 11/09/2026): *"si un cliente igualmente me pide un
-- item que no voy a tener hasta xx/xx, quiero separar el pedido de ese cliente:
-- 1) lo que va normal, con las condiciones normales de programación;
-- 2) lo que se programa para entregar recién a partir de que llega esa
-- mercadería"*.
--
-- CÓMO: el corte se hace donde ya se cortan las NP — `v_pedidos_web_np`, que
-- parte el pedido en bloques de 18 líneas (15 en Chef). Ahora las líneas se
-- separan PRIMERO en dos grupos: disponible y diferido; cada grupo se corta en
-- bloques por su cuenta y el diferido va después en la numeración. Un pedido de
-- 4 líneas con 1 sin stock deja de ser una NP y pasa a ser dos: 3 + 1.
--
-- ⚠ POR QUÉ NO SE MIRA `reingreso_cache` EN VIVO PARA DECIDIR EL CORTE.
--   `reingreso_cache.sin_stock` cambia todos los días (lo espeja el cron desde
--   Virgilio). Si el corte dependiera de eso, la identidad de una NP
--   —(order_id, np_idx), que es la PK de `PPP_Web_Programacion` en Virgilio—
--   se movería sola cuando llega la mercadería: lo ya programado quedaría
--   apuntando a un bloque que cambió de contenido. Medido el 11/09/2026: de
--   212 pedidos de los últimos 30 días, **83 (39%)** tienen hoy alguna línea de
--   un artículo sin stock; casi todos ya entregados. Mirar el estado en vivo
--   los partiría a todos, retroactivamente.
--   Por eso la decisión se CONGELA al recibir el pedido en `pedido_diferido`,
--   y de ahí en más el corte no se mueve. Lo que sí se lee en vivo es la FECHA
--   (el piso de entrega): si la mercadería se adelanta, el bloque se puede
--   programar antes sin cambiar de bloque.
--
-- Efecto sobre lo viejo: NINGUNO. Los pedidos que ya existen no tienen filas en
-- `pedido_diferido`, así que salen con el mismo corte de siempre.
-- =============================================================================

-- 1) La decisión congelada: qué línea de qué pedido espera mercadería.
create table if not exists public.pedido_diferido (
  order_id        bigint      not null,
  art             text        not null,
  fecha_reingreso date,                       -- la estimada AL MOMENTO del pedido
  creado_at       timestamptz not null default now(),
  primary key (order_id, art)
);
alter table public.pedido_diferido enable row level security;
revoke all on public.pedido_diferido from anon, authenticated;
-- La escribe el trigger (definer) y la leen las vistas del feed; nadie más.

comment on table public.pedido_diferido is
  'Líneas de un pedido web que al recibirse no tenían stock (importados con reingreso estimado). Congela el corte de la NP: v_pedidos_web_np las manda a un bloque aparte. No se borra ni se recalcula cuando llega la mercadería.';

-- 2) Se marca UNA sola vez por pedido, cuando aparecen los ítems.
--    `orders.sheets_payload` se escribe después del push a Sheets, así que el
--    disparo real es el UPDATE, no el INSERT.
create or replace function public.marcar_pedido_diferido(p_order_id bigint)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_n int := 0;
begin
  if exists (select 1 from public.pedido_diferido where order_id = p_order_id) then
    return 0;                                   -- ya congelado: no se recalcula
  end if;

  insert into public.pedido_diferido (order_id, art, fecha_reingreso)
  select p.order_id, p.art, r.fecha_reingreso
    from public.v_pedidos_web p
    join public.reingreso_cache r
      on r.cod = upper(btrim(p.art)) and r.sin_stock
   where p.order_id = p_order_id
   group by p.order_id, p.art, r.fecha_reingreso
  on conflict (order_id, art) do nothing;

  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke all on function public.marcar_pedido_diferido(bigint) from public, anon, authenticated;

create or replace function public.trg_marcar_pedido_diferido()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.sheets_payload is not null
     and jsonb_typeof(new.sheets_payload -> 'items') = 'array' then
    perform public.marcar_pedido_diferido(new.id);
  end if;
  return null;
end;
$$;

drop trigger if exists marcar_pedido_diferido on public.orders;
create trigger marcar_pedido_diferido
  after insert or update of sheets_payload on public.orders
  for each row execute function public.trg_marcar_pedido_diferido();

-- 3) El feed por línea expone si esa línea espera mercadería.
--    (se agrega la columna al final; los consumidores que ya existen no cambian)
create or replace view public.v_pedidos_web_dif
with (security_invoker = true) as
  select v.*,
         (d.order_id is not null) as diferido,
         d.fecha_reingreso        as diferido_hasta_orig
    from public.v_pedidos_web v
    left join public.pedido_diferido d
      on d.order_id = v.order_id and d.art = v.art;
revoke all on public.v_pedidos_web_dif from anon;
grant select on public.v_pedidos_web_dif to authenticated;

-- 4) La fecha piso, EN VIVO: la de hoy si sigue sin stock, la congelada si no
--    hay dato nuevo. Si el artículo ya entró, no hay piso (null) y el bloque se
--    programa normal, aunque siga siendo un bloque aparte.
create or replace function public.pedido_diferido_piso(p_order_id bigint, p_art text)
returns date
language sql
stable
as $$
  select case when coalesce(r.sin_stock, false)
              then greatest(coalesce(r.fecha_reingreso, d.fecha_reingreso), current_date)
         end
    from public.pedido_diferido d
    left join public.reingreso_cache r on r.cod = upper(btrim(d.art))
   where d.order_id = p_order_id and d.art = upper(btrim(p_art));
$$;

-- =============================================================================
-- CONTROLES (correr a mano, ANTES y DESPUÉS de aplicar)
-- =============================================================================
--   -- a) nada viejo se parte: tiene que dar 0
--   select count(*) from public.pedido_diferido;
--
--   -- b) el corte de NP no cambió para lo ya programado (comparar antes/después)
--   select empresa, order_id, count(*) as bloques, max(lineas) as max_lineas
--     from public.v_pedidos_web_np group by 1,2 having count(*) > 1 order by 2 desc limit 20;
--
--   -- c) un pedido nuevo con faltante tiene que dar 2 grupos
--   select order_id, np_idx, diferido, diferido_hasta, lineas
--     from public.v_pedidos_web_np where order_id = <id> order by np_idx;
-- =============================================================================

-- =============================================================================
-- 5) EL CORTE. `v_pedidos_web_np` reemplazada: las líneas se separan en dos
--    grupos (disponible / diferido) ANTES de cortar de a 18 (15 en Chef), y el
--    grupo diferido se numera DESPUÉS del disponible. Se agregan dos columnas al
--    final —`diferido` y `no_antes_de`—; ninguna columna existente se mueve, así
--    que los consumidores actuales (Gestión Virgilio, `sincronizar_ppp`) siguen
--    leyendo lo mismo.
--
--    `no_antes_de` se resuelve EN VIVO contra `reingreso_cache`: si el artículo
--    ya entró, queda NULL y el bloque se programa como cualquier otro (pero
--    sigue siendo un bloque aparte: el corte no se deshace).
-- =============================================================================
create or replace view public.v_pedidos_web_np
with (security_invoker = true) as
with vol as materialized (
  -- ⚠ El MATERIALIZED no es decorativo: sin él el planner mete el salto FDW a
  --   Virgilio adentro del nested loop y lo ejecuta una vez por pedido.
  select codigo, m3 from public.virgilio_volumen_map()
),
cap as (
  select 'lk'::text as empresa, 18 as cap_lineas
  union all
  select 'chef',                15
),
lin as (
  select i.*,
         c.cap_lineas,
         v.m3 as m3_unit,
         coalesce(i.cajas, 0) * coalesce(v.m3, 0) as linea_m3,
         (d.order_id is not null) as es_diferido,
         case
           when d.order_id is null then null::date
           when r.cod is not null and not r.sin_stock then null::date   -- ya llegó
           else greatest(coalesce(r.fecha_reingreso, d.fecha_reingreso), current_date)
         end as linea_no_antes_de
    from public.v_pedidos_web i
    join cap c on c.empresa = i.empresa
    left join vol v on v.codigo = upper(btrim(i.art))
    left join public.pedido_diferido d
           on d.order_id = i.order_id and d.art = i.art
    left join public.reingreso_cache r on r.cod = upper(btrim(i.art))
),
orden as (
  select l.*,
         row_number() over (partition by l.empresa, l.order_id, l.es_diferido
                            order by l.linea_rn) as rk,
         count(*) filter (where not l.es_diferido)
           over (partition by l.empresa, l.order_id) as n_disp
    from lin l
),
part as (
  select o.*,
         case when o.es_diferido
              then ceil(o.n_disp::numeric / o.cap_lineas::numeric)::int
                 + ceil(o.rk::numeric    / o.cap_lineas::numeric)::int
              else ceil(o.rk::numeric    / o.cap_lineas::numeric)::int
         end as np_idx
    from orden o
)
select
  empresa,
  order_id,
  np_idx,
  min(cod_cliente)                             as cod,
  min(razon_social)                            as razon_social,
  min(fecha_pedido)                            as fecha_recep,
  min(hora_pedido)                             as hora_recep,
  min(sucursal_entrega)                        as direccion,
  min(vend)                                    as v,
  min(condicion_pago_code)                     as condicion_pago_code,
  min(numero_oc)                               as numero_oc,
  bool_and(enviado_a_compras_at is not null)   as enviado_a_compras,
  count(*)                                     as lineas,
  sum(cajas)                                   as cajas,
  jsonb_agg(jsonb_build_object('art', art, 'cajas', cajas, 'uxb', uxb, 'uni', uni)
            order by linea_rn)                 as items,
  string_agg(art, ',' order by linea_rn)       as arts,
  min(localidad)                               as localidad,
  min(provincia)                               as provincia,
  min(zona_expreso)                            as zona_expreso,
  min(nombre_expreso)                          as nombre_expreso,
  min(direccion_expreso)                       as direccion_expreso,
  round(sum(linea_m3), 3)                      as m3,
  bool_or(m3_unit is null)                     as m3_parcial,
  min(isis_empresa)                            as isis_empresa,
  min(cod_isis)                                as cod_isis,
  -- NUEVAS, al final:
  bool_or(es_diferido)                         as diferido,
  max(linea_no_antes_de)                       as no_antes_de
from part p
group by empresa, order_id, np_idx;

revoke all on public.v_pedidos_web_np from anon;
grant select on public.v_pedidos_web_np to authenticated;
