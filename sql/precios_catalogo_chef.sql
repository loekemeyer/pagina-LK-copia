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

-- ══════════════════════════════════════════════════════════════════════════════════════════
-- SEGUNDA PASADA — v4, el mismo día
-- ══════════════════════════════════════════════════════════════════════════════════════════
--
-- 1. LOS 8 QUE FALTABAN, A MANO EN `item_precios`
--    El dueño pasó el uxb de 7 (838E, 198E, 193, 727EN, 120, 809, 599EZ) y el precio salió de
--    la última factura parseada de cada uno. El octavo (865ED) lleva uxb **deducido**: su
--    propia descripción en la factura dice "x12". Está anotado en la columna `nota` de cada
--    fila, con la fecha de la factura de donde salió el precio.
--    ⚠ Escribió "727" y "599"; los códigos reales son 727EN y 599EZ. Mapeado y anotado.
--
-- 2. UN BUG DE LA CASCADA, ANTERIOR A TODO ESTO
--    Después de cargar los 8, DOS seguían sin ficha: 193 y 120. El motivo:
--
--      193 → está en loke_products con uxb=12 y **precio 0**
--      120 → está en loke_products con uxb=24 y **precio 0**
--      877E → está en chef_ext.products con uxb=12 y **precio 0**
--
--    Cada rama de la cascada exige `list_price > 0` para USAR una fuente, pero el `NOT EXISTS`
--    que la protege sólo miraba si el código **existía** en la fuente de más arriba. O sea que
--    un artículo cargado con precio 0 arriba bloqueaba a todas las de abajo **sin aportar
--    nada él mismo**: caía por todos los agujeros y quedaba sin ficha para siempre, aunque
--    `item_precios` lo tuviera bien.
--
--    Arreglo: los `NOT EXISTS` ahora exigen que la fuente de arriba tenga un precio USABLE
--    (`uxb > 0 and list_price > 0`), no que simplemente exista. Es la semántica que la cascada
--    siempre quiso tener.
--
-- MEDIDO, LAS TRES PASADAS
-- ========================
--                              cajas sin ficha    %      códigos
--   al empezar                     2.322        10.3%       81
--   + catálogo de Chef               480         2.1%       10
--   + los 8 a mano                   264         1.2%        4
--   + el arreglo de la cascada       215         1.0%        2
--
-- LO QUE QUEDA (2 códigos, 215 cajas, 1.0%)
--   55215 (208 cajas) "Palo de Amasar 40 cm" — no está en ningún catálogo. Precio $1.990 en la
--         factura del 26/08, pero falta el uxb; el dueño no lo pasó.
--   877E  (7 cajas) — está en el catálogo de Chef con uxb 12 pero **precio 0** del lado de Chef.
--         Se arregla cargándole el precio allá, o a mano acá.

insert into public.item_precios (cod, description, uxb, list_price, category, origen, nota, actualizado_at)
values
  ('838E',  'Rallador Cilíndrico Mini',      12, 1175, null, 'manual', 'uxb del dueño (08/09). Precio: última factura Chef 14/08/2026.', now()),
  ('198E',  'Pelador Negro Dentado Loke',    12, 1110, null, 'manual', 'uxb del dueño (08/09). Precio: última factura Loeke 07/08/2026.', now()),
  ('193',   'Tostador Enlozado Loke',        12, 4950, null, 'manual', 'uxb del dueño (08/09). Precio: última factura Loeke 25/08/2026.', now()),
  ('727EN', 'Sacacorcho Doble Imp.',         12, 3360, null, 'manual', 'uxb del dueño (08/09), que escribió "727" — se mapeó a 727EN. Precio: última factura Chef 02/09/2026.', now()),
  ('120',   'Filtros de Café Loke',          24, 1040, null, 'manual', 'uxb del dueño (08/09). Precio: última factura Loeke 25/08/2026.', now()),
  ('809',   'Corta Queso',                   12, 2755, null, 'manual', 'uxb del dueño (08/09). Precio: última factura Chef 06/08/2026.', now()),
  ('599EZ', 'Pelador Mad Verde',             12, 2990, null, 'manual', 'uxb del dueño (08/09), que escribió "599" — se mapeó a 599EZ. Precio: última factura Loeke 28/08/2026.', now()),
  ('865ED', 'Rallador Plano Ac. Inox 3 usos',12, 2980, null, 'manual', 'uxb DEDUCIDO: la descripción de la factura dice "x12". NO lo confirmó el dueño. Precio: última factura Chef 02/09/2026.', now())
on conflict (cod) do update
  set description = excluded.description, uxb = excluded.uxb, list_price = excluded.list_price,
      origen = excluded.origen, nota = excluded.nota, actualizado_at = now();

-- La cascada, con los NOT EXISTS mirando si la fuente de arriba es USABLE y no si existe.
create or replace view public.v_item_precio_calc as
 SELECT p.cod, p.description, p.uxb, p.list_price, p.category, 'products'::text AS fuente
   FROM products p
  WHERE COALESCE(p.uxb, 0) > 0 AND COALESCE(p.list_price, 0::numeric) > 0::numeric
UNION ALL
 SELECT lp.cod, lp.description, lp.uxb, lp.list_price, lp.category, 'loke_products'::text AS fuente
   FROM loke_products lp
  WHERE COALESCE(lp.uxb, 0) > 0 AND COALESCE(lp.list_price, 0::numeric) > 0::numeric
    AND NOT (EXISTS (SELECT 1 FROM products p2
                      WHERE p2.cod = lp.cod AND COALESCE(p2.uxb,0) > 0 AND COALESCE(p2.list_price,0) > 0))
UNION ALL
 SELECT cp.cod, cp.description, cp.uxb, cp.list_price, cp.category, 'chef_products'::text AS fuente
   FROM chef_ext.products cp
  WHERE COALESCE(cp.uxb, 0) > 0 AND COALESCE(cp.list_price, 0::numeric) > 0::numeric
    AND NOT (EXISTS (SELECT 1 FROM products p4
                      WHERE p4.cod = cp.cod AND COALESCE(p4.uxb,0) > 0 AND COALESCE(p4.list_price,0) > 0))
    AND NOT (EXISTS (SELECT 1 FROM loke_products l4
                      WHERE l4.cod = cp.cod AND COALESCE(l4.uxb,0) > 0 AND COALESCE(l4.list_price,0) > 0))
UNION ALL
 SELECT i.cod, i.description, i.uxb, i.list_price, i.category, 'item_precios:'::text || i.origen AS fuente
   FROM item_precios i
  WHERE NOT (EXISTS (SELECT 1 FROM products p3
                      WHERE p3.cod = i.cod AND COALESCE(p3.uxb,0) > 0 AND COALESCE(p3.list_price,0) > 0))
    AND NOT (EXISTS (SELECT 1 FROM loke_products l3
                      WHERE l3.cod = i.cod AND COALESCE(l3.uxb,0) > 0 AND COALESCE(l3.list_price,0) > 0))
    AND NOT (EXISTS (SELECT 1 FROM chef_ext.products c3
                      WHERE c3.cod = i.cod AND COALESCE(c3.uxb,0) > 0 AND COALESCE(c3.list_price,0) > 0));

select public.refrescar_item_precio_cache();
