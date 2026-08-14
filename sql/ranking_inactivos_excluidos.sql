-- Tabla: ranking_inactivos_excluidos
--
-- Clientes que un admin sacó a mano del módulo "Ranking Inactivos"
-- (admin.html -> Estadística Clientes -> botón "✕ Quitar" de cada fila).
--
-- Es una lista COMPARTIDA, no por navegador: si un admin oculta un cliente
-- porque cerró, es un duplicado o ya lo contactó, el resto del equipo lo ve
-- igual. Por eso vive en la base y no en localStorage.
--
-- Totalmente reversible: borrar la fila devuelve el cliente al ranking. Desde
-- el panel se hace con el chip "Ver ocultos" -> "↩ Restaurar", que llama a
-- get_ranking_inactivos(..., p_solo_excluidos => true) para listar solo estos.
--
-- No se filtra por acá "De baja" ni "Próximos a comprar": la exclusión es
-- únicamente de la vista del ranking, no del análisis de fondo.

CREATE TABLE IF NOT EXISTS public.ranking_inactivos_excluidos (
  cod_cliente text PRIMARY KEY,
  motivo text,
  excluido_por uuid DEFAULT auth.uid(),
  excluido_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.ranking_inactivos_excluidos IS
  'Clientes ocultados manualmente del módulo Ranking Inactivos (admin.html). Borrar la fila los restaura.';

ALTER TABLE public.ranking_inactivos_excluidos ENABLE ROW LEVEL SECURITY;

-- Solo admins (presencia en la tabla admins, mismo criterio que el resto del panel)
DROP POLICY IF EXISTS ranking_inactivos_excluidos_admin_all ON public.ranking_inactivos_excluidos;
CREATE POLICY ranking_inactivos_excluidos_admin_all
  ON public.ranking_inactivos_excluidos
  FOR ALL
  TO authenticated
  USING (EXISTS (SELECT 1 FROM admins a WHERE a.auth_user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM admins a WHERE a.auth_user_id = auth.uid()));

GRANT SELECT, INSERT, DELETE ON public.ranking_inactivos_excluidos TO authenticated;
