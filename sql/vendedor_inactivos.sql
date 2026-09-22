-- ============================================================================
-- Clientes que no están comprando — card del perfil del VENDEDOR
-- (mayorista.html → Perfil, visible sólo con isVendorOwnMode())
--
-- Contexto: el rol vendedor YA EXISTÍA antes de esto. Un vendedor es una fila
-- de `customers` con cod_cliente = 10000 + vend y CUIT sintético 99xxxxxxxxx;
-- entra con usuario + PIN como cualquier cliente y su cartera son las filas de
-- `user_customer_links` (el trigger fn_autolink_vendor engancha los clientes
-- nuevos que comparten su `vend`). Lo único que faltaba era esta pantalla.
--
-- ⚠ El filtro de "yo soy vendedor" NO es decorativo. La primera versión armaba
-- la cartera con `user_customer_links OR mismo vend`, sin exigir que quien
-- llama fuera un vendedor: medido, un cliente mayorista común logueado recibía
-- 37 clientes de su propio vendedor (razón social, localidad, última compra e
-- importe). El `cod_cliente between 10000 and 10999 or cod_cliente = 1`
-- replica isActualVendor() de script.js y lo cierra.
--
-- Verificado el 18/09/2026:
--   vendedor Andrés (10001)  6 meses → 97 filas   · 12 meses → 79
--   vendedor Cagnolo (10003) 6 meses → 37 filas
--   cliente común con vend        → 0   (antes del fix: 37)
--   sin sesión                    → 0
--   147 ms con la cartera más grande (160 clientes), contra ~8 s de timeout.
--
-- Valorización: la misma cadena que el resto de estadística —
-- cajas × uxb × list_price × (1-dto_vol) × (1-web_order_discount)— con
-- `v_item_precio` y NO `products` (ver el checklist de reportes del CLAUDE.md).
-- La última compra exige cajas POSITIVAS: una nota de crédito no es una compra.
--
-- EXECUTE revocado a PUBLIC/anon: es SECURITY DEFINER y la anon key es pública.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_mis_clientes_inactivos(p_meses integer DEFAULT 6)
 RETURNS TABLE(cod_cliente text, razon_social text, ultima_compra text, dias integer,
               importe_ultima numeric, localidad text, whatsapp text, chef_ultima text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- Solo un VENDEDOR ve cartera. Mismo criterio que isActualVendor() en script.js:
-- perfil sintetico 100XX, o Loekemeyer SRL (cod 1), que vende a cartera propia.
-- Sin este filtro un cliente mayorista comun veia los clientes de su vendedor.
with yo as (
  select c.id, c.auth_user_id, c.vend
  from public.customers c
  where c.auth_user_id = auth.uid()
    and (c.cod_cliente between 10000 and 10999 or c.cod_cliente = 1)
  limit 1
),
cartera as (
  select distinct c.id, c.cod_cliente::text cod, c.business_name nom,
         coalesce(c.dto_vol,0) dto, c.cuit, c.whatsapp
  from public.customers c, yo
  where c.id <> yo.id
    and c.cod_cliente < 10000
    and ( exists (select 1 from public.user_customer_links l
                   where l.auth_user_id = yo.auth_user_id and l.customer_id = c.id)
          or (yo.vend is not null and btrim(c.vend) = btrim(yo.vend)) )
),
wd as (select coalesce((select (value)::numeric from public.app_settings
                         where key='web_order_discount'),0.02) d),
dias_c as (
  select s.customer_code cod, s.invoice_date f
  from public.sales_lines s
  where s.empresa = 'lk'
    and s.customer_code in (select cod from cartera)
    and s.item_code not in (select item_code from public.sales_excluded_items)
  group by 1,2
  having sum(s.boxes) > 0
),
ult as (select distinct on (cod) cod, f from dias_c order by cod, f desc),
imp as (
  select u.cod,
         round(sum(s.boxes * coalesce(v.uxb,1) * coalesce(v.list_price,0))
               * (1 - ca.dto) * (1 - (select d from wd))) monto
  from ult u
  join cartera ca on ca.cod = u.cod
  join public.sales_lines s on s.empresa='lk' and s.customer_code = u.cod
       and s.invoice_date = u.f
       and s.item_code not in (select item_code from public.sales_excluded_items)
  left join public.v_item_precio v on v.cod = s.item_code
  group by 1, ca.dto
),
chef as (
  select p.cuit, max(s.invoice_date) f
  from public.sales_lines s
  join public.chef_padron p on p.cod_cliente::text = s.customer_code
  where s.empresa = 'chef' and p.cuit is not null
  group by 1
)
select ca.cod, ca.nom, u.f,
       case when u.f is null then null else (current_date - u.f::date)::int end,
       i.monto,
       (select d.localidad || coalesce(', ' || d.provincia, '')
          from public.customer_delivery_addresses d
         where d.customer_id = ca.id and d.localidad is not null
         order by d.slot limit 1),
       ca.whatsapp,
       ch.f
from cartera ca
left join ult u on u.cod = ca.cod
left join imp i on i.cod = ca.cod
left join chef ch on ch.cuit = regexp_replace(coalesce(ca.cuit,''), '\D', '', 'g')
where u.f is null
   or u.f < to_char(current_date - make_interval(months => greatest(p_meses,1)), 'YYYY-MM-DD')
order by u.f desc nulls last;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_mis_clientes_inactivos(integer) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.get_mis_clientes_inactivos(integer) TO authenticated;

-- Prueba (la que vale: contra la base real, no leyendo el código).
-- select set_config('request.jwt.claims', json_build_object('sub',
--    (select auth_user_id::text from public.customers where cod_cliente=10001))::text, true);
-- select count(*) from public.get_mis_clientes_inactivos(6);
