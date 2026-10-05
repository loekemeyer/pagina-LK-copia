-- D8/D10 (Thomas, 05/10/2026): el dashboard de ventas cuenta como LK lo que Chef le factura a
-- Cencosud con artículos de Loekemeyer, valorizado con la lista propia de Cencosud.
-- APLICADO en LK (kwkclwhmoygunqmlegrg) el 05/10/2026.

-- 1) Precio por unidad (bruto) que la lista de Cencosud no tiene, tomado de las facturas ISIS
--    parseadas (Gestión, isis_ch, cliente 2444). Ojo: ISIS a veces trae el precio por CAJA
--    (123: 15180 = 1265 x 12); acá va siempre por UNIDAD.
create table if not exists public.super_precio_isis (
  super_key text not null, cod_base text not null, precio_unit numeric not null,
  fecha date, fuente text, creado_at timestamptz default now(), primary key (super_key, cod_base));
alter table public.super_precio_isis enable row level security;
revoke all on public.super_precio_isis from anon, authenticated;
insert into public.super_precio_isis (super_key, cod_base, precio_unit, fecha, fuente) values
 ('cencosud','31',765,'2026-09-16','isis_ch FC 2444'),
 ('cencosud','123',1265,'2026-09-14','isis_ch FC 2444'),
 ('cencosud','224',1330,'2026-09-16','isis_ch FC 2444'),
 ('cencosud','248',1665,'2026-09-16','isis_ch FC 2444'),
 ('cencosud','280',2420,'2026-09-14','isis_ch FC 2444'),
 ('cencosud','315',2735,'2026-09-16','isis_ch FC 2444')
on conflict do nothing;

-- 2) sales_lines con Cencosud (súper de Chef con artículos LK) reasignado a LK.
create or replace view public.ventas_dash_lineas as
with sup as (
  select c.super_key, c.cod_cliente_chef cod, coalesce(nullif(c.pdf_ratio,0),1) ratio
  from precios_super.cadena c
  where c.empresa='chef' and c.usa_productos_chef = false and c.cod_cliente_chef is not null),
cod_lk as (select upper(btrim(cod)) cod from products union select upper(btrim(cod)) from loke_products),
lst as (select super_key, regexp_replace(upper(btrim(cod)),'^0+','') base, max(price) price from precios_super.precio group by 1,2)
select sl.invoice_date, sl.item_code, sl.boxes,
       case when s.cod is not null then 'lk' else sl.empresa end as empresa,
       case when s.cod is not null then 'CH '||sl.customer_code else sl.customer_code end as customer_code,
       case when s.cod is not null then coalesce(l.price, i.precio_unit) / s.ratio end as precio_neto_unit
from sales_lines sl
left join sup s on sl.empresa='chef' and sl.customer_code = s.cod
     and regexp_replace(upper(btrim(sl.item_code)),'L$','') in (select cod from cod_lk)
left join lst l on l.super_key = s.super_key
     and l.base = regexp_replace(regexp_replace(regexp_replace(upper(btrim(sl.item_code)),'L$',''),'E$',''),'^0+','')
left join super_precio_isis i on i.super_key = s.super_key
     and i.cod_base = regexp_replace(regexp_replace(regexp_replace(upper(btrim(sl.item_code)),'L$',''),'E$',''),'^0+','');
revoke all on public.ventas_dash_lineas from anon, authenticated;

-- 3) Las tres funciones se parchearon sobre pg_get_functiondef (definición viva):
--    gv_dashboard_calcular / _calcular2:  FROM sales_lines sl -> FROM ventas_dash_lineas sl
--        COALESCE(p.list_price,0) -> COALESCE(sl.precio_neto_unit / (1 - wd.d), p.list_price, 0)
--    gv_dashboard_extra:  idem, con / 0.98
--    gv_dashboard_calcular2.nom: + UNION ALL de datos_cliente_empresa('chef', <códigos CH>)
--    (dividir por el descuento web compensa la cadena * (1-dto_vol) * (1-wd); 'CH 2444' no matchea
--     customers, así que dto_vol queda en 0).
-- Rollback: replace inverso de los tres textos sobre pg_get_functiondef, y
--   drop view public.ventas_dash_lineas; drop table public.super_precio_isis;
