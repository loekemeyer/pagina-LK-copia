-- =====================================================================
-- scot_chef_cliente_super — PDF Krikos del admin de LK: cliente de CHEF de
-- una cadena que factura por Chef (Cencosud 2444, Dorinka 2686).
--
-- POR QUÉ (Tomás Gonzalez, 02/10/2026): la clave pública de Chef no lee
-- `customers` (RLS: 0 filas SIN error). La card decía "CLIENTE ⚠ no encontrado
-- (esperaba cod 2444)" y "SUCURSAL 221 — sin mapear" y no dejaba subir el
-- pedido. Las sucursales (customer_delivery_addresses + super_branch_id) SÍ se
-- leen con la clave pública; sólo faltaba el id del cliente.
--
-- Aplicado en LK (kwkclwhmoygunqmlegrg) el 02/10/2026. Medido como admin:
-- 3.244 ms (FDW a Chef, otra organización: ~2,4 s fijos de conexión), contra
-- el statement_timeout de 8 s de authenticated. Otro authenticated → "no
-- autorizado"; anon → permission denied. Un cod que no es de una cadena → null.
--
-- ROLLBACK:
--   drop function if exists public.scot_chef_cliente_super(text);
--   drop foreign table if exists chef_ext.customers_super;
-- =====================================================================

-- Foránea PROPIA, aislada de public.chef_customers (que usan los syncs): si
-- alguien le cambia columnas a ésta, no rompe sincronizar_chef_orders.
create foreign table if not exists chef_ext.customers_super (
  id uuid, cod_cliente bigint, business_name text, cuit text,
  vend text, debt numeric, credit_limit numeric, payment_term numeric
) server chef_db options (schema_name 'public', table_name 'customers');
revoke all on chef_ext.customers_super from public, anon, authenticated;

create or replace function public.scot_chef_cliente_super(p_cod text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
-- PDF Krikos del admin de LK: cliente de CHEF de una cadena que factura por Chef
-- (Cencosud 2444, Dorinka 2686). La clave publica de Chef no lee `customers` (RLS:
-- 0 filas sin error), y por eso la card decia "CLIENTE no encontrado (esperaba cod
-- 2444)" y no dejaba subir el pedido. Se lee por el FDW (2-3 s, datos vivos: vend,
-- deuda, limite, plazo) y, si Chef no contesta, de la copia local chef_customers_cache
-- (id, cod y razon social; parcial=true). Solo admins y solo codigos de
-- precios_super.cadena.cod_cliente_chef. Tomas Gonzalez, 02/10/2026.
declare
  v jsonb;
begin
  if not exists (select 1 from admins a where a.auth_user_id = auth.uid()) then
    raise exception 'no autorizado';
  end if;
  if not exists (select 1 from precios_super.cadena c
                  where btrim(c.cod_cliente_chef) = btrim(p_cod)) then
    return null;
  end if;
  begin
    select jsonb_build_object(
             'id', s.id, 'cod_cliente', s.cod_cliente::text,
             'business_name', s.business_name, 'cuit', s.cuit,
             'vend', s.vend, 'debt', s.debt, 'credit_limit', s.credit_limit,
             'payment_term', s.payment_term, 'origen', 'chef_vivo', 'parcial', false)
      into v
      from chef_ext.customers_super s
     where s.cod_cliente = btrim(p_cod)::bigint
     limit 1;
  exception when others then
    v := null;
  end;
  if v is null then
    select jsonb_build_object(
             'id', c.id, 'cod_cliente', c.cod_cliente::text,
             'business_name', c.business_name, 'cuit', c.cuit,
             'vend', null, 'debt', null, 'credit_limit', null, 'payment_term', null,
             'origen', 'chef_customers_cache', 'parcial', true)
      into v
      from chef_customers_cache c
     where c.cod_cliente::text = btrim(p_cod)
     limit 1;
  end if;
  return v;
end
$$;
revoke execute on function public.scot_chef_cliente_super(text) from public, anon;
grant execute on function public.scot_chef_cliente_super(text) to authenticated;
