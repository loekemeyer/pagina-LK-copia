-- ============================================================================
-- oc_super_ya_cargada(p_oc, p_chef) — guard contra cargar dos veces la misma OC
-- ============================================================================
-- Entre mayo y junio de 2026 cuatro órdenes de compra de súper se cargaron dos
-- veces cada una, duplicados exactos (misma firma de ítems, mismo total), y las
-- ocho copias salieron al Sheet y a ISIS: 22663852 La Anónima (pedidos 549/566,
-- $4.802.400), 58132128093 Coto (712/874, $18.203.280), 22784730 La Anónima
-- (807/814, $5.034.480) y 22784731 La Anónima (808/815, $56.617.680) —
-- $84.657.840 de valor de pedido repetido.
--
-- El único control que existía era `findDuplicateCardIdx` de admin-supercot.js,
-- que compara el hash del archivo ENTRE LAS 9 CARDS ABIERTAS. No ve el caso real,
-- que es la misma OC subida en dos sesiones distintas, con días de diferencia.
--
-- Esta RPC es la fuente de verdad: busca el número de OC en `orders` de LK y,
-- para los súper que facturan por Chef, también en `chef_orders` (FDW). El front
-- la llama antes de subir y pide confirmación; NO bloquea, porque re-subir a
-- propósito (un pedido borrado, una corrección) es una operación válida.
--
-- SECURITY DEFINER con chequeo de admin adentro y EXECUTE revocado a anon: la
-- anon key es pública y esto expone qué órdenes de compra existen.
-- ============================================================================

create or replace function public.oc_super_ya_cargada(p_oc text, p_chef boolean default false)
returns table(order_id bigint, creado timestamptz, empresa text)
language plpgsql security definer set search_path to 'public' as $$
begin
  if not exists (select 1 from public.admins a where a.auth_user_id = auth.uid()) then
    raise exception 'solo admin';
  end if;
  if coalesce(btrim(p_oc), '') = '' then return; end if;

  return query
    select o.id, o.created_at, 'lk'::text
    from public.orders o
    where o.sheets_payload->>'pdf_oc' = btrim(p_oc)
    order by o.id;

  if p_chef then
    return query
      select o.id, o.created_at, 'chef'::text
      from public.chef_orders o
      where o.sheets_payload->>'pdf_oc' = btrim(p_oc)
      order by o.id;
  end if;
end $$;

revoke execute on function public.oc_super_ya_cargada(text, boolean) from public, anon;
grant execute on function public.oc_super_ya_cargada(text, boolean) to authenticated, service_role;

-- Duplicados existentes (los 4 pares de arriba salen de acá):
-- select sheets_payload->>'pdf_oc' oc, count(*), string_agg(id::text, ', ' order by id)
-- from public.orders where sheets_payload->>'pdf_oc' is not null
-- group by 1 having count(*) > 1;
