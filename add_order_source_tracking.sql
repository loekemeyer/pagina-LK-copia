-- Trackear quién cargó cada pedido: el propio cliente, o un vendedor
-- operando "Pedir para" en su nombre (o un admin, desde el panel).
--
-- Correr una sola vez en el SQL editor de Supabase (proyecto de este sitio).
-- No es una migración versionada: es un fix/alta de columna, igual que
-- fix_missing.sql.

-- 1) Nueva columna: auth_user_id de quien estaba logueado al confirmar el
--    pedido. Se completa desde ahora en adelante (script.js); los pedidos
--    ya existentes quedan en NULL porque nunca se guardó ese dato.
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS placed_by_auth_user_id uuid REFERENCES auth.users(id);

COMMENT ON COLUMN orders.placed_by_auth_user_id IS
  'auth.users.id de quien estaba logueado al confirmar el pedido (cliente dueño, vendedor vinculado via user_customer_links, o admin). NULL en pedidos anteriores a esta columna.';

-- 2) Vista que clasifica el origen de cada pedido comparando
--    placed_by_auth_user_id contra el auth_user_id dueño del customer_id.
--    security_invoker = true: la vista respeta el RLS de orders/customers
--    de quien consulta (admin ve todo, cliente solo lo suyo), en vez de
--    correr con los permisos de quien la creó.
CREATE OR REPLACE VIEW v_orders_origen
WITH (security_invoker = true) AS
SELECT
  o.id AS order_id,
  o.customer_id,
  o.created_at,
  o.placed_by_auth_user_id,
  c.auth_user_id AS customer_auth_user_id,
  CASE
    WHEN o.placed_by_auth_user_id IS NULL THEN 'desconocido'
    WHEN o.placed_by_auth_user_id = c.auth_user_id THEN 'cliente'
    WHEN EXISTS (
      SELECT 1 FROM admins a WHERE a.auth_user_id = o.placed_by_auth_user_id
    ) THEN 'admin'
    ELSE 'vendedor'
  END AS origen_pedido
FROM orders o
JOIN customers c ON c.id = o.customer_id;

GRANT SELECT ON v_orders_origen TO authenticated;

-- 3) Para ver los conteos pedidos (cliente vs vendedor vs admin vs
--    desconocido = pedidos viejos sin este dato):
--
--   SELECT origen_pedido, count(*)
--   FROM v_orders_origen
--   GROUP BY origen_pedido
--   ORDER BY count(*) DESC;
--
-- Esto mismo se puede ver desde el panel admin: sidebar → Carga Pedidos →
-- Origen de Pedidos.
