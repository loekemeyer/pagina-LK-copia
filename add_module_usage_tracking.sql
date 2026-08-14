-- Trackear DESDE QUÉ MÓDULO se agrega cada producto (catálogo normal,
-- carrusel de Novedades, módulo "no te falta esto de tu surtido", popup de
-- upsell antes de confirmar, línea Loke, modal "Sugerir productos" del
-- vendedor, página de Sugerencias, o Historial "Volver a pedir").
--
-- Correr una sola vez en el SQL editor de Supabase de este proyecto.
-- No es una migración versionada, es un alta de columnas/tablas como
-- fix_missing.sql / add_order_source_tracking.sql.

-- 1) order_items.source: qué módulo originó cada línea de un pedido
--    CONFIRMADO. Se completa desde ahora en adelante (script.js y las
--    herramientas admin que insertan pedidos); NULL en pedidos previos.
ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS source text;

COMMENT ON COLUMN order_items.source IS
  'Módulo desde el que se agregó este producto: catalogo, novedades, surtido_faltante, upsell_popup, loke, sugerencia_vendedor, sugerencias, historial. NULL en líneas anteriores a esta columna.';

-- 2) cart_add_events: un registro por cada click en "agregar" (o "volver a
--    pedir"), en CUALQUIER lado de la página — incluye intentos que después
--    no se terminan confirmando como pedido. Sirve para medir uso real de
--    cada módulo, no solo lo que termina en venta.
CREATE TABLE IF NOT EXISTS cart_add_events (
  id bigserial PRIMARY KEY,
  customer_id bigint,
  auth_user_id uuid REFERENCES auth.users(id),
  product_id bigint,
  product_cod text,
  source text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE cart_add_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY cart_add_events_insert_own ON cart_add_events
  FOR INSERT TO authenticated
  WITH CHECK (auth_user_id = auth.uid());

CREATE POLICY cart_add_events_select_admin ON cart_add_events
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM admins a WHERE a.auth_user_id = auth.uid()));

GRANT SELECT, INSERT ON cart_add_events TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE cart_add_events_id_seq TO authenticated;

-- 3) novedades_impressions: un registro cada vez que el carrusel de
--    Novedades se le mostró a un cliente con al menos un producto (una vez
--    por carga de página, no por cada re-render). Cruzado con
--    cart_add_events (source='novedades') da la tasa de conversión real
--    "vistas → agregados" del carrusel.
CREATE TABLE IF NOT EXISTS novedades_impressions (
  id bigserial PRIMARY KEY,
  customer_id bigint,
  auth_user_id uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE novedades_impressions ENABLE ROW LEVEL SECURITY;

CREATE POLICY novedades_impressions_insert_own ON novedades_impressions
  FOR INSERT TO authenticated
  WITH CHECK (auth_user_id = auth.uid());

CREATE POLICY novedades_impressions_select_admin ON novedades_impressions
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM admins a WHERE a.auth_user_id = auth.uid()));

GRANT SELECT, INSERT ON novedades_impressions TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE novedades_impressions_id_seq TO authenticated;

-- 4) Vista de order_items + fecha del pedido (order_items no tiene su
--    propio created_at), para poder filtrar por rango de fechas en el
--    reporte de "líneas vendidas por módulo".
CREATE OR REPLACE VIEW v_order_items_source
WITH (security_invoker = true) AS
SELECT
  oi.id AS order_item_id,
  oi.order_id,
  oi.source,
  oi.cajas,
  oi.uxb,
  o.created_at,
  o.customer_id
FROM order_items oi
JOIN orders o ON o.id = oi.order_id;

GRANT SELECT ON v_order_items_source TO authenticated;

-- Nota: customer_id/product_id se declararon como bigint (el tipo más común
-- para PKs autogenerados en Supabase). Si en tu base customers.id o
-- products.id son de otro tipo (uuid, integer, etc), las columnas de acá
-- van a quedar sin uso real (los inserts van a fallar en silencio, atajados
-- en el JS para no romper la compra) — avisame y te paso el ALTER
-- corregido. auth_user_id sí está garantizado uuid (mismo patrón que
-- add_order_source_tracking.sql, que ya corriste sin problema).

-- Todo esto se puede ver desde el panel admin: sidebar → Carga Pedidos →
-- Uso de Módulos.
