-- =============================================================================
-- gv_estado_mis_pedidos.sql — el estado del pedido en Gestión Virgilio, para "Mis pedidos"
-- Proyecto LK (kwkclwhmoygunqmlegrg) · idea 8743 · 2026-09-05
-- =============================================================================
-- Dueño: "cuando un pedido queda facturado debería mostrarlo en la página y decir que
-- ya no se puede modificar".
--
-- 1) Se importa por FDW (server virgilio_db, rol lk_ppp_reader) la vista de Virgilio
--    gv_pedido_web_estado_pagina: un estado por (empresa, order_id) —
--    sin_programar / programado / en_picking / pickeado / en_armado / armado /
--    facturado / entregado— con fecha_entrega, tanda, facturado y entregado.
-- 2) RPC gv_estado_mis_pedidos(p_ids): devuelve ese estado SÓLO para los pedidos del
--    usuario logueado (dueño, link o admin: mismas reglas que orders_select_own).
-- 3) edit_order_fast suma el candado: facturado o entregado en Gestión → no editable
--    (además del de enviado_a_compras_at, que queda). El mail de las 12:30 está apagado
--    desde el 2026-09-05, así que el corte de las 12:30 del front dejó de existir.
--
-- ROLLBACK: drop function gv_estado_mis_pedidos(bigint[]); drop foreign table
--   virgilio.gv_pedido_web_estado_pagina; edit_order_fast sin el bloque 8743
--   (sql/backups/edit_order_fast_20260905_pre_gate_facturado.sql).
-- =============================================================================

import foreign schema public limit to (gv_pedido_web_estado_pagina) from server virgilio_db into virgilio;

create or replace function public.gv_estado_mis_pedidos(p_ids bigint[])
returns table(order_id bigint, estado text, rango integer, bloques integer, fecha_entrega date, tanda text, estado_desde timestamptz, entregado_at timestamptz, facturado boolean, entregado boolean)
language plpgsql security definer set search_path to 'public' as $$
begin
  if auth.uid() is null then return; end if;
  return query
    select g.order_id, g.estado, g.rango, g.bloques, g.fecha_entrega, g.tanda, g.estado_desde, g.entregado_at, g.facturado, g.entregado
      from virgilio.gv_pedido_web_estado_pagina g
      join orders o on o.id = g.order_id
     where g.empresa = 'lk'
       and g.order_id = any(coalesce(p_ids, '{}'))
       and (o.auth_user_id = auth.uid()
            or exists (select 1 from user_customer_links ucl where ucl.auth_user_id = auth.uid() and ucl.customer_id = o.customer_id)
            or exists (select 1 from admins a where a.auth_user_id = auth.uid()));
end $$;
revoke all on function public.gv_estado_mis_pedidos(bigint[]) from public, anon;
grant execute on function public.gv_estado_mis_pedidos(bigint[]) to authenticated, service_role;

-- edit_order_fast: bloque agregado después del chequeo de enviado_a_compras_at
-- (la función completa está en la base; acá sólo el candado nuevo):
--
--   if exists (
--     select 1 from virgilio.gv_pedido_web_estado_pagina g
--      where g.empresa = 'lk' and g.order_id = p_order_id and (g.facturado or g.entregado)
--   ) then
--     raise exception 'Pedido ya facturado: no se puede modificar.' using errcode = 'check_violation';
--   end if;
