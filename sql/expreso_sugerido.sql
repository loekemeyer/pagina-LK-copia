-- ============================================================================
-- expreso_sugerido() — de qué expreso es un galpón, para las DOS páginas
-- (Tomás, 24/09/2026: "solo resta que integres esa información para que
--  aparezca en ambas webs")
-- ============================================================================
-- YA APLICADO en el proyecto de LK (kwkclwhmoygunqmlegrg). Este archivo es la
-- copia de referencia: los .sql del repo no se ejecutan solos.
--
-- POR QUÉ EXISTE. Chef tiene 0 de 713 sucursales con `nombre_expreso`, pero SÍ
-- tiene la dirección del galpón en `direccion_entrega`. LK, en cambio, lo tiene
-- cargado en 804 fichas. Esta función traslada ese conocimiento a las dos
-- páginas sin exponer el padrón de clientes.
--
-- TRES VÍAS, en orden de confianza, y la primera NO es una deducción:
--   cliente = mismo CUIT y mismo galpón en LK -> es el expreso de ESE cliente.
--             Es la única que desambigua un galpón compartido: con el CUIT,
--             Pergamino 3751 (44 expresos) resuelve a Brinati; sin él, nada.
--   fichas  = ese galpón tiene un solo expreso en las fichas de LK
--   padron  = ese domicilio es de un solo expreso en `expresos`
--
-- MEDIDO el 24/09 contra las 328 sucursales del interior de Chef:
--   83 (cliente) + 52 (fichas) + 26 (padron) = 161, el 49 %.
--   Antes el padrón solo resolvía 123. Sin resolver quedan 167.
--   Control: de 91 galpones comparables por dos vías, sólo 2 se contradicen
--   (Luna 358: las fichas dicen Snaider, el padrón CIRO). 98 % de acuerdo.
--
-- ⚠ NO VUELCA NADA: el que llama tiene que decir QUÉ direcciones pregunta
--   (tope 50) y sólo recibe lo que se resuelve. No devuelve datos del cliente.
-- ⚠ El galpón se compara por CALLE + ALTURA: "Pergamino 3751 Nave 3 Box 89" y
--   "Pergamino 3751" son el mismo lugar.
-- ⚠ La llaman las DOS páginas con la anon key de LK (Chef por
--   `supabaseLoekemeyer`), así que es SECURITY DEFINER a propósito y no se le
--   revoca el EXECUTE. Es segura por construcción: sólo lee y está acotada.
--
-- Rollback:
--   drop function public.expreso_sugerido(text, text[]);
--   drop function public._exp_gal_key(text);
-- ============================================================================

create or replace function public._exp_gal_key(p text)
returns text language sql immutable parallel safe as $$
  select btrim(coalesce(substring(
           btrim(regexp_replace(upper(translate(coalesce(p,''),
             'ÁÉÍÓÚÜÑáéíóúüñ','AEIOUUNAEIOUUN')),'[^A-Z0-9]+',' ','g'))
           from '^[^0-9]*[0-9]+'),''));
$$;

create or replace function public.expreso_sugerido(p_cuit text, p_dirs text[])
returns table (dir text, expreso text, fuente text, apoyo int)
language sql stable security definer set search_path = public as $$
with pedido as (
  select distinct d as dir, public._exp_gal_key(d) gal
    from unnest(coalesce(p_dirs, '{}'::text[])) d
   where public._exp_gal_key(d) <> ''
), lkd as (
  select regexp_replace(coalesce(c.cuit,''),'\D','','g') cuit,
         public._exp_gal_key(a.direccion_entrega) gal,
         btrim(a.nombre_expreso) exp
    from public.customer_delivery_addresses a
    join public.customers c on c.id = a.customer_id
   where nullif(btrim(coalesce(a.nombre_expreso,'')),'') is not null
     and lower(btrim(a.nombre_expreso)) <> 'retira'
     and public._exp_gal_key(a.direccion_entrega) in (select gal from pedido)
), por_cliente as (
  select gal, count(distinct upper(exp)) n, (array_agg(exp order by exp))[1] uno, count(*)::int apoyo
    from lkd where cuit = regexp_replace(coalesce(p_cuit,''),'\D','','g')
     and regexp_replace(coalesce(p_cuit,''),'\D','','g') <> '' group by gal
), por_ficha as (
  select gal, count(distinct upper(exp)) n, (array_agg(exp order by exp))[1] uno, count(*)::int apoyo
    from lkd group by gal
), por_padron as (
  select public._exp_gal_key(e.domicilio) gal,
         count(distinct upper(e.razon_social)) n,
         (array_agg(e.razon_social order by e.razon_social))[1] uno, count(*)::int apoyo
    from public.expresos e
   where e.domicilio is not null and public._exp_gal_key(e.domicilio) in (select gal from pedido)
   group by 1
)
select p.dir,
       coalesce(pc.uno, pf.uno, pp.uno)                                   as expreso,
       case when pc.n = 1 then 'cliente' when pf.n = 1 then 'fichas'
            when pp.n = 1 then 'padron' end                               as fuente,
       coalesce(pc.apoyo, pf.apoyo, pp.apoyo)                             as apoyo
  from pedido p
  left join por_cliente pc on pc.gal = p.gal and pc.n = 1
  left join por_ficha   pf on pf.gal = p.gal and pf.n = 1
  left join por_padron  pp on pp.gal = p.gal and pp.n = 1
 where cardinality(coalesce(p_dirs,'{}'::text[])) <= 50
   and coalesce(pc.uno, pf.uno, pp.uno) is not null;
$$;

-- Prueba (como anon, que es la identidad de las dos páginas):
--   set local role anon;
--   select * from public.expreso_sugerido(null, array['Riestra 1655']);
--     -> Sudamericano [fichas]
--   select * from public.expreso_sugerido(null, array['Pergamino 3751']);
--     -> (nada: 44 expresos ahí)
--   select * from public.expreso_sugerido('30534456898', array['Pergamino 3751']);
--     -> Brinati [cliente]
