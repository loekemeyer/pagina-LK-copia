-- v_item_precio_calc v3 — el catálogo de Chef entra a la cadena de precios
-- Proyecto LK (kwkclwhmoygunqmlegrg) · 2026-09-08 · aplicado
--
-- EL PROBLEMA
-- ===========
-- El reporte de salud avisaba: *"🔴 maestro de artículos · 10.3% de las cajas del último mes
-- sin ficha (81 códigos) → la plata sale corta"*. Y era literal: sin ficha no hay precio, y sin
-- precio esas cajas valen **cero** en cualquier número de plata.
--
-- No eran 81 errores sueltos. **72 de los 81 son artículos VIVOS de Chef**: están en la página
-- de Chef, no en la de LK, y por eso no aparecían en `products`. El dueño lo dijo primero:
-- *"si los vendemos están en la página y si están en la página tiene precio"* — tenía razón,
-- sólo que la página era la otra.
--
-- LA SOLUCIÓN
-- ===========
-- Se agrega un cuarto nivel a la cascada de `v_item_precio_calc`, leyendo `chef_ext.products`
-- por el FDW que ya existía contra Chef. Queda **al día solo**: no hay nada que cargar a mano.
--
--   products  →  loke_products  →  **chef_ext.products**  →  item_precios
--
-- VERIFICADO CONTRA LAS FACTURAS PARSEADAS
-- ========================================
-- Idea del dueño: *"fijate en la tabla de las facturas parseadas, si aparece tenés ahí el
-- dato"*. Se cruzó `chef_ext.products` contra `isis_ch.documento_items` (los PDF de ISIS ya
-- parseados, en Virgilio) y los precios **coinciden exacto**:
--
--   cod   catálogo Chef   última factura
--   701       5915            5915
--   706       1305            1305
--   713       2520            2520
--   824       1265            1265
--   836        895             895
--   901       1635            1635
--
-- ⚠ Y de paso, una trampa que casi me lleva puesto: en `isis_*.documento_items`,
--   **`cantidad_caja` NO es unidades-por-bulto**, es la cantidad de la línea. Para el 55215 da
--   208, mientras el `uxb` real del catálogo es 12/6/24. Usarla como uxb habría corrompido
--   todos los precios. El uxb bueno sale del catálogo, no de la factura.
--
-- MEDIDO
-- ======
--                          antes    después
--   cajas sin ficha        2.322      480
--   % del mes              10.3%     2.1%
--   códigos                   81       10
--   item_precio_cache        317      415   (+98 de chef_products)
--
--   Y el 🔴 "maestro de artículos" desapareció de `rep_salud()`.
--
-- LO QUE QUEDA (9 códigos, 480 cajas, 2.1%)
-- =========================================
-- No están en el catálogo de Chef ni en el de LK. **Sí están en las facturas parseadas**, así
-- que el precio existe — lo que no existe es el `uxb`, y `v_item_precio_calc` lo exige.
-- Van a mano en `item_precios`, o hay que darlos de alta en alguna de las dos páginas:
--
--   55215 (208 cajas) · 838E (80) · 198E (70) · 193 (34) · 727EN (33)
--   865ED (17) · 120 (15) · 809 (8) · 599EZ (8)
--
-- ROLLBACK
-- ========
--   Sacar el bloque UNION ALL de `chef_ext.products` y la condición NOT EXISTS que se le
--   agregó al bloque de `item_precios`, y correr `select public.refrescar_item_precio_cache();`

create or replace view public.v_item_precio_calc as
 SELECT p.cod, p.description, p.uxb, p.list_price, p.category, 'products'::text AS fuente
   FROM products p
  WHERE COALESCE(p.uxb, 0) > 0 AND COALESCE(p.list_price, 0::numeric) > 0::numeric
UNION ALL
 SELECT lp.cod, lp.description, lp.uxb, lp.list_price, lp.category, 'loke_products'::text AS fuente
   FROM loke_products lp
  WHERE COALESCE(lp.uxb, 0) > 0 AND COALESCE(lp.list_price, 0::numeric) > 0::numeric
    AND NOT (EXISTS (SELECT 1 FROM products p2 WHERE p2.cod = lp.cod))
UNION ALL
 -- v3 (2026-09-08) — el catálogo de Chef, por el FDW que ya existía.
 SELECT cp.cod, cp.description, cp.uxb, cp.list_price, cp.category, 'chef_products'::text AS fuente
   FROM chef_ext.products cp
  WHERE COALESCE(cp.uxb, 0) > 0 AND COALESCE(cp.list_price, 0::numeric) > 0::numeric
    AND NOT (EXISTS (SELECT 1 FROM products p4 WHERE p4.cod = cp.cod))
    AND NOT (EXISTS (SELECT 1 FROM loke_products l4 WHERE l4.cod = cp.cod))
UNION ALL
 SELECT i.cod, i.description, i.uxb, i.list_price, i.category, 'item_precios:'::text || i.origen AS fuente
   FROM item_precios i
  WHERE NOT (EXISTS (SELECT 1 FROM products p3 WHERE p3.cod = i.cod))
    AND NOT (EXISTS (SELECT 1 FROM loke_products l3 WHERE l3.cod = i.cod))
    AND NOT (EXISTS (SELECT 1 FROM chef_ext.products c3 WHERE c3.cod = i.cod));

select public.refrescar_item_precio_cache();
