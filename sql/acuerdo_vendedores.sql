-- ============================================================================
-- Acuerdo por vendedor  (módulo admin "Acuerdo x Vendedor")
-- ----------------------------------------------------------------------------
-- Cuánto queda de cada $151 facturado después de dtos + comisión + flete,
-- ponderado EN PLATA (venta a precio de lista = boxes * uxb * list_price) por
-- vendedor. Objetivo: netear 100 (markup 1,51 => lista 151 para ingresar 100).
--
-- Cadena:  lista(151) × (1 − dto_vol) × (1 − 0,25 contado) × (1 − 0,02 web)
--                     × (1 − comisión) × (1 − 0,01 flete)
-- Si el factor necesario ( = 1 / [(1−dto)(0,75)(0,98)(1−com)(0,99)] ) supera
-- 1,51, facturar a 151 no alcanza y el acuerdo queda negativo.
--
-- "NOSOTROS" (sin comisión de vendedor): vend 7 (fábrica directa), 20 (súper),
-- 18/80 (fábrica). El resto son vendedores con comisión (customer_commissions).
--
-- SOLO ADMIN (guard adentro) + revoke a public/anon. Todo mide empresa='lk'.
-- ============================================================================

create or replace function public.get_acuerdo_vendedores(p_meses int default 12)
returns table(
  vend text,
  nombre text,
  es_nosotros boolean,
  clientes int,
  plata numeric,
  dto_pond numeric,
  com_pond numeric,
  factor_nec numeric,
  neto_151 numeric,
  acuerdo numeric
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cut text;
begin
  if not exists (select 1 from admins a where a.auth_user_id = auth.uid()) then
    raise exception 'no autorizado';
  end if;

  -- p_meses NULL => todo el histórico
  v_cut := case when p_meses is null then '1900-01-01'
                else to_char((now() - (p_meses || ' months')::interval), 'YYYY-MM-DD') end;

  return query
  with base as (
    select coalesce(nullif(c.vend,''),'(vacio)') as vend,
           c.cod_cliente,
           coalesce(c.dto_vol,0) as dto,
           coalesce(cc.rate,0)   as com,
           s.boxes * p.uxb * p.list_price as plata
    from sales_lines s
    join products p  on p.cod = s.item_code
    join customers c on c.cod_cliente::text = s.customer_code
    left join customer_commissions cc on cc.cod_cliente = c.cod_cliente
    where s.empresa = 'lk'
      and s.item_code not in (select item_code from sales_excluded_items)
      and s.invoice_date >= v_cut
  ),
  nm as (
    -- nombre dominante del vendedor por código de vend
    select coalesce(nullif(c.vend,''),'(vacio)') as vend, cc.vendor_label,
           row_number() over (partition by coalesce(nullif(c.vend,''),'(vacio)')
                              order by count(*) desc) as rk
    from customers c
    join customer_commissions cc on cc.cod_cliente = c.cod_cliente
    where cc.vendor_label is not null and cc.vendor_label <> ''
    group by 1,2
  ),
  g as (
    select b.vend,
           count(distinct b.cod_cliente)::int as clientes,
           sum(b.plata) as plata,
           sum(b.dto * b.plata) / nullif(sum(b.plata),0) as dto,
           sum(b.com * b.plata) / nullif(sum(b.plata),0) as com
    from base b
    group by b.vend
    having sum(b.plata) > 0
  )
  select g.vend,
         case when g.vend in ('7','18','20','80') then 'NOSOTROS'
              else coalesce(n.vendor_label, g.vend) end as nombre,
         (g.vend in ('7','18','20','80')) as es_nosotros,
         g.clientes,
         round(g.plata, 0) as plata,
         round((g.dto * 100)::numeric, 2) as dto_pond,
         round((g.com * 100)::numeric, 2) as com_pond,
         round((1 / ((1 - g.dto) * 0.75 * 0.98 * (1 - g.com) * 0.99))::numeric, 3) as factor_nec,
         round((151 * (1 - g.dto) * 0.75 * 0.98 * (1 - g.com) * 0.99)::numeric, 1) as neto_151,
         round((151 * (1 - g.dto) * 0.75 * 0.98 * (1 - g.com) * 0.99 - 100)::numeric, 1) as acuerdo
  from g
  left join nm n on n.vend = g.vend and n.rk = 1
  order by g.plata desc;
end;
$$;

revoke execute on function public.get_acuerdo_vendedores(int) from public, anon;
grant  execute on function public.get_acuerdo_vendedores(int) to authenticated, service_role;
