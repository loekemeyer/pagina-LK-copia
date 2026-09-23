-- v22.09 (Luis, 23/09) — pedido de CHEF con importado sin stock: se parte AL ENTRAR,
-- mirando el cache de SU empresa. Aplicado en kwkclwhmoygunqmlegrg el 23/09.
--
-- Antes: marcar_diferidos_chef miraba SIEMPRE reingreso_cache (LK). Un 438E de Chef sin
-- stock no partía el pedido (el 438E de LK sí tiene), y los que sólo existen en Chef
-- (729E, 733E, 838E, 868E, 877E...) no partían nunca.
--   con L (438EL) -> artículo de LK   -> reingreso_cache, código sin la L
--   sin L (438E)  -> artículo de Chef -> reingreso_cache_chef
--
-- Y la carrera: el pedido entraba a chef_orders_cache (cron 48, :02) y se marcaba en otra
-- corrida (cron 41, :04). Si la copia tardaba, el armado de Gestión podía programarlo
-- ENTERO y la marca llegar después (caso Chef 231 / Dorinka, 24 cajas duplicadas).
-- Ahora sincronizar_chef_orders evalúa cada pedido nuevo EN LA MISMA transacción en que
-- aparece en la copia y empuja el diferido a Gestión en la misma corrida. Si la marca
-- falla, el pedido entra entero (no se traba) y el motivo queda en chef_cache_log.
-- chef_diferido_evaluado = "este pedido ya se decidió": nunca se re-evalúa (regla de
-- Luis: el corte se decide UNA vez).
--
-- Probado en transacción abortada: 221 (729E) y 226 (438E) se marcan · segunda pasada 0 ·
-- sincronizar_chef_orders con el 221 entrando: marcado 729E, origen 'sync', sin error.
--
-- La definición viva manda: pg_get_functiondef('public.marcar_diferidos_chef_ids(bigint[],text)').
-- El parche de sincronizar_chef_orders se aplicó por reemplazo de texto sobre la viva.

create table if not exists public.chef_diferido_evaluado (
  order_id bigint primary key, evaluado_at timestamptz not null default now(),
  marcados integer not null default 0, origen text);
alter table public.chef_diferido_evaluado enable row level security;
revoke all on public.chef_diferido_evaluado from anon, authenticated;

-- marcar_diferidos_chef_ids(p_ids bigint[], p_origen text): marca y registra evaluados.
-- marcar_diferidos_chef(p_dias): red — sólo pedidos de 30 min nunca evaluados.
-- sincronizar_chef_orders(90): llama a la primera con los pedidos que ENTRAN y, si marcó
--   algo, sync_diferido_virgilio(45).
