-- ============================================================================
-- EXPO — plataforma para tomar pedidos en exposición (copia pagina-LK-copia)
-- ============================================================================
-- Este archivo documenta las funciones/objetos del módulo Expo. La fuente de
-- verdad sigue siendo la base: correr esto a mano en el SQL editor.
--
-- Fase 1: buscar_cliente_expo — buscador único de la pantalla "Elegir cliente".
--   Matchea por cód, razón social, CUIT (solo dígitos, >=6) o dirección de
--   entrega / localidad. Gateada a admin. Solo lectura.
-- ----------------------------------------------------------------------------

create or replace function public.buscar_cliente_expo(p_q text)
returns table(
  id uuid,
  cod_cliente bigint,
  business_name text,
  cuit text,
  dto_vol numeric,
  vend text,
  direccion text,
  localidad text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_q      text := btrim(coalesce(p_q, ''));
  v_digits text := regexp_replace(coalesce(p_q, ''), '\D', '', 'g');
  v_isnum  boolean := v_q ~ '^\d+$';
begin
  -- Gate admin (RPC solo para el panel expo)
  if not exists (select 1 from admins a where a.auth_user_id = auth.uid()) then
    raise exception 'no autorizado';
  end if;

  if length(v_q) < 2 then
    return;
  end if;

  return query
  with matches as (
    select c.id
    from customers c
    where (v_isnum and c.cod_cliente = v_q::bigint)
       or c.business_name ilike '%' || v_q || '%'
       or (length(v_digits) >= 6
           and regexp_replace(coalesce(c.cuit, ''), '\D', '', 'g') like '%' || v_digits || '%')
    union
    select da.customer_id
    from customer_delivery_addresses da
    where length(v_q) >= 3
      and (da.direccion_entrega ilike '%' || v_q || '%'
           or da.localidad ilike '%' || v_q || '%')
  )
  select distinct on (c.id)
    c.id, c.cod_cliente, c.business_name, c.cuit, c.dto_vol, c.vend,
    coalesce(nullif(c.direccion_fiscal, ''), da.direccion_entrega) as direccion,
    coalesce(nullif(c.localidad, ''), da.localidad) as localidad
  from customers c
  join matches m on m.id = c.id
  left join customer_delivery_addresses da on da.customer_id = c.id
  order by c.id, da.slot nulls last
  limit 25;
end;
$$;

revoke execute on function public.buscar_cliente_expo(text) from public;
grant execute on function public.buscar_cliente_expo(text) to authenticated, service_role;
