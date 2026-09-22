-- ============================================================================
-- Acuerdo por cliente — tarjeta "Acuerdo" de la Ficha de Cliente (admin)
--
-- Qué contesta: cuánto deja este cliente hoy, y cuánto descuento le puedo dar
-- sin que el recibo baje de 100.
--
-- ⚠ EL ORDEN DE LOS DESCUENTOS NO ES LIBRE (Thomas, 18/09/2026). Es:
--     1. dto de volumen  sobre la LISTA
--     2. pago (25%)      sobre ese saldo
--     3. cotizador (2%)  sobre el saldo anterior   → esto es el CHEQUE
--     4. flete (1%) y comisión se restan LOS DOS SOBRE EL CHEQUE, no
--        encadenados entre sí.
--
--   California (cod 588, dto 3%, comisión 7%), contra su planilla:
--     cheque 107,66 · flete −1,08 · comisión −7,54 · recibo 99,04
--     acuerdo −0,96 · factor 1,525
--   Encadenar flete y comisión da 99,12 (−0,88): 0,08 de más, y siempre a favor.
--   `get_acuerdo_vendedores` usa esa otra forma, así que no da idéntico.
--
-- ⚠ LOS DESCUENTOS SE DAN SIN COMA (Thomas, mismo día): `dto_max` viene
--   redondeado hacia ABAJO al entero (2,06% → 2%). `dto_max_exacto` queda
--   al lado sólo para poder auditar el redondeo.
--
-- El 25% de pago contado ANTES ERA 8% (`dto_pago_anterior`). Para un cliente
-- dormido eso es argumento de venta y no un detalle contable: el precio de
-- contado quedó 18,5% mejor que cuando él compraba. Va en `mejora_pago`.
--
-- Los cinco parámetros viven en `acuerdo_parametros` (una fila) para poder
-- cambiar el índice o el 25% sin tocar código.
--
-- La función lleva el chequeo de `admins` adentro y el EXECUTE revocado a
-- PUBLIC/anon: es SECURITY DEFINER y la anon key es pública. Verificado el
-- 18/09/2026: un cliente mayorista logueado recibe "no autorizado".
--
-- NO toca `get_ficha_cliente` (8.900 caracteres): el frontend llama a las dos
-- en paralelo y, si ésta falla, la ficha se muestra igual.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.acuerdo_parametros (
  id                smallint PRIMARY KEY DEFAULT 1,
  indice_lista      numeric NOT NULL DEFAULT 151,   -- lista contra base 100
  dto_pago          numeric NOT NULL DEFAULT 0.25,  -- pago contado vigente
  dto_cot           numeric NOT NULL DEFAULT 0.02,  -- cotizador / web
  flete             numeric NOT NULL DEFAULT 0.01,
  piso              numeric NOT NULL DEFAULT 100,
  dto_pago_anterior numeric NOT NULL DEFAULT 0.08,  -- el que regía antes
  actualizado_at    timestamptz NOT NULL DEFAULT now(),
  actualizado_por   uuid,
  CONSTRAINT acuerdo_parametros_una_fila CHECK (id = 1)
);
ALTER TABLE public.acuerdo_parametros ENABLE ROW LEVEL SECURITY;
INSERT INTO public.acuerdo_parametros (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS acuerdo_parametros_admin_lee ON public.acuerdo_parametros;
CREATE POLICY acuerdo_parametros_admin_lee ON public.acuerdo_parametros
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.admins a WHERE a.auth_user_id = auth.uid()));

-- La definición viva de get_acuerdo_cliente(text) se saca con:
--   select pg_get_functiondef('public.get_acuerdo_cliente(text)'::regprocedure);
-- Devuelve un jsonb con: cheque, recibo, acuerdo, factor, dto_max (entero),
-- dto_max_exacto, margen_dto, mejora_pago, dto_pago_hoy/antes y `simulacion`,
-- que es la misma cuenta para comisiones de 0 a 7 por ciento — es lo que deja
-- ver que bajando la comisión de 7 a 4 el tope de descuento del cliente sube
-- de 2% a 5% (y California, con su 3%, pasaría de −0,96 a +2,27).

REVOKE EXECUTE ON FUNCTION public.get_acuerdo_cliente(text) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.get_acuerdo_cliente(text) TO authenticated;
