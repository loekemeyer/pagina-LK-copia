-- Vista pública del catálogo: es lo que lee js/catalogo-vivo.js desde el
-- navegador del visitante para que productos/ se actualice al instante.
--
-- APLICADA EL 17/09/2026 en el proyecto kwkclwhmoygunqmlegrg, con autorización
-- de Tomás. Este archivo queda como registro de qué se hizo y por qué.
--
-- EL PROBLEMA QUE RESOLVIÓ
-- Existía la política `anon_select_products` (SELECT donde active = true) pero
-- al rol `anon` nunca se le había dado permiso sobre la tabla. Una política sin
-- GRANT no hace nada: devuelve "permission denied". Por eso mayorista.html
-- funciona —el cliente está logueado, o sea `authenticated`— y una página
-- pública no habría funcionado nunca.
--
-- POR QUÉ NO SE LE DIO EL PERMISO A LA TABLA ENTERA
-- `products.list_price` está cargado en las 199 filas activas, de 430 a 30.690
-- ARS: sería publicar la lista mayorista completa en la página que justamente
-- no muestra precios.
--
-- POR QUÉ security_invoker = true Y GRANT POR COLUMNA
-- La primera versión usaba `security_invoker = false`, que hace correr la vista
-- con los permisos del dueño y saltea la RLS de products. Funcionaba, pero el
-- chequeo de seguridad de Supabase lo marca como ERROR `security_definer_view`.
-- La versión final invierte el enfoque: la vista corre con los permisos de
-- quien consulta, la RLS de products se aplica normalmente, y el acceso se
-- limita con un GRANT POR COLUMNA que deja `list_price` fuera de alcance.
-- Más seguro y sin advertencia.

create or replace view public.v_catalogo_publico
with (security_invoker = true) as
select cod,
       description,
       category,
       subcategory,
       uxb,
       images,
       badge_status,
       orden_catalogo
  from public.products
 where active;

comment on view public.v_catalogo_publico is
  'Catalogo publico sin precios. La lee js/catalogo-vivo.js desde el navegador con la clave publishable. NO agregar columnas de precio ni de costo.';

grant select on public.v_catalogo_publico to anon, authenticated;

-- Sólo las columnas públicas. list_price y id quedan afuera a propósito.
grant select (cod, description, category, subcategory, uxb, images, badge_status, orden_catalogo)
  on public.products to anon;

-- CONTROLES, verificados el 17/09/2026:
--   has_column_privilege('anon','public.products','list_price','SELECT')  -> false
--   has_column_privilege('anon','public.products','cod','SELECT')         -> true
--   has_table_privilege ('anon','public.products','SELECT')               -> false
--   has_table_privilege ('anon','public.v_catalogo_publico','SELECT')     -> true
--   select count(*) from public.v_catalogo_publico                        -> 199
--
-- PARA REVERTIR TODO:
--   revoke select (cod, description, category, subcategory, uxb, images, badge_status, orden_catalogo)
--     on public.products from anon;
--   drop view public.v_catalogo_publico;
