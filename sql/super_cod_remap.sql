-- Luis 24/09/2026: el código que trae la OC de un súper (Ref.Prov) se traduce al real.
-- Caso: Dorinka manda "838" y el artículo es 838E (el 838 no existe como producto).
--
-- 1) precios_super.cadena.cod_remap jsonb  — {"COD_OC":"COD_REAL"}. Agregar uno = update, sin deploy:
--      update precios_super.cadena set cod_remap = coalesce(cod_remap,'{}') || '{"XXX":"YYYE"}' where super_key='dorinka';
-- 2) get_super_cadenas() devuelve cod_remap (DROP+CREATE: cambió el RETURNS TABLE; EXECUTE sólo authenticated/service_role).
-- 3) admin-supercot.js aplica la traducción al leer el PDF, antes de matchear (remapCodSuper).
--    En paginach es la constante SUPER_COD_REMAP (ese admin corre contra la base de Chef).
-- 4) gv_pedidos_web_np_chef(integer) — el FEED de pedidos de Chef que lee Gestión — corrige lo mismo
--    en los pedidos YA cargados, así REPROGRAMAR en Gestión vuelve a copiar el código bueno
--    (gv_ppp_web_tanda_programar re-inserta los ítems del pedido):
--      · súper con usa_productos_chef (Dorinka): se saca la L (nunca le corresponde);
--      · cod_remap de la cadena.
--    Parche sobre pg_get_functiondef: el CTE `li` pasó a `li0` y el nuevo `li` lee `sup`.
--    Medido 24/09: 83 = 83 tramos; cambian sólo los pedidos 215, 229 y 231 (Dorinka), cajas iguales.

alter table precios_super.cadena add column if not exists cod_remap jsonb;
update precios_super.cadena set cod_remap = '{"838":"838E"}'::jsonb where super_key = 'dorinka';
