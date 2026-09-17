-- Vista pública del catálogo, para que productos/ se actualice al instante.
--
-- POR QUÉ UNA VISTA Y NO LA TABLA
-- Existe la política `anon_select_products` (SELECT donde active = true), pero
-- al rol `anon` nunca se le dio el GRANT de tabla, así que nunca tuvo efecto:
-- una política sin GRANT devuelve "permission denied". Y darle ese GRANT sobre
-- public.products publicaría `list_price`, que está cargado en las 199 filas
-- activas (de 430 a 30.690 ARS al 17/09/2026): la lista mayorista entera.
--
-- Esta vista expone SÓLO las columnas que la página ya muestra en el HTML.
-- No agrega información pública nueva: lo mismo que hoy está escrito en
-- productos/*.html, servido en vivo.
--
-- Aplicar con el MCP de Supabase (apply_migration) o desde el SQL Editor del
-- proyecto kwkclwhmoygunqmlegrg.

create or replace view public.v_catalogo_publico
with (security_invoker = false) as
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
  'Catálogo público sin precios. La lee js/catalogo-vivo.js desde el navegador con la clave publishable. NO agregar columnas de precio ni de costo.';

grant select on public.v_catalogo_publico to anon;
grant select on public.v_catalogo_publico to authenticated;

-- Control posterior:
--   select has_table_privilege('anon', 'public.v_catalogo_publico', 'SELECT');  -- true
--   select has_table_privilege('anon', 'public.products', 'SELECT');            -- false
