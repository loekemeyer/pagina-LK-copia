-- Corrige el tipo de las columnas de tracking del módulo "Uso de módulos"
-- (Carga Pedidos -> Uso de módulos, admin.js -> cargarUsoModulos).
--
-- EL PROBLEMA
-- Las columnas estaban declaradas bigint, pero customers.id y products.id son
-- uuid. Un id real es 'cc19fd61-0835-44d7-a5bd-b093af6cd5cd', que no entra en
-- un bigint, así que TODO insert desde el navegador fallaba con
-- "invalid input syntax for type bigint".
--
-- POR QUÉ NO SE NOTÓ
-- El cliente escribe la telemetría así (script.js, sugerencias.js, historial.js):
--
--     supabaseClient.from("cart_add_events").insert({...}).then(function () {});
--
-- Ese .then() vacío nunca mira resp.error, así que el fallo era silencioso.
-- Entre el 1/7/2026 (cuando se lanzó el tracking) y el 30/7/2026 hubo 208
-- pedidos web y 0 eventos registrados.
--
-- QUÉ ARREGLA Y QUÉ NO
-- Esto habilita el registro de "Clics" y "Vistas" de acá en adelante; lo que
-- no se registró en julio no se puede recuperar. La columna "Líneas de pedido"
-- del mismo panel sigue en cero por otro motivo independiente: el navegador
-- manda `source` por ítem, pero submit_order_fast no lo lee al insertar en
-- order_items, así que order_items.source queda NULL y el panel, que filtra
-- con .eq("source", clave), nunca matchea.
--
-- Las dos tablas estaban vacías, así que no hubo datos que convertir (el
-- USING NULL es inocuo). No se les agrega FK a customers/products a propósito:
-- es telemetría, y no conviene que borrar un producto viejo haga fallar el
-- registro de un evento.

ALTER TABLE public.cart_add_events
  ALTER COLUMN customer_id TYPE uuid USING NULL,
  ALTER COLUMN product_id  TYPE uuid USING NULL;

ALTER TABLE public.novedades_impressions
  ALTER COLUMN customer_id TYPE uuid USING NULL;

COMMENT ON COLUMN public.cart_add_events.customer_id IS 'customers.id (uuid)';
COMMENT ON COLUMN public.cart_add_events.product_id  IS 'products.id (uuid)';
COMMENT ON COLUMN public.novedades_impressions.customer_id IS 'customers.id (uuid)';
