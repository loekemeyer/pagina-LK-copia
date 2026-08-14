-- Módulo: Estado de clientes (Estadística Clientes -> Estado de clientes)
--
-- Reúne el estado del cliente desde fuentes externas. Hoy son dos:
--
--   ARCA (padrón fiscal)  -> ¿se dio de baja?, ¿falleció?, ¿sigue activo?
--                            Requiere certificado y worker externo. NO andando.
--   BCRA (Central de      -> situación 1..6 por deuda con entidades
--   Deudores)                financieras. API pública con CORS, la consulta el
--                            propio navegador. Ver bcra_situacion más abajo.
--
-- Son INDEPENDIENTES entre sí: ARCA mide estado fiscal y el BCRA deuda
-- bancaria. Un cliente puede estar impecable en una y mal en la otra, y
-- ninguna de las dos sabe nada de lo que nos debe a nosotros.
--
-- Lo que sigue es la parte de ARCA. El bloque del BCRA está al final.
--
-- ARQUITECTURA — por qué hay un worker externo
-- El padrón NO tiene una API pública abierta: se consulta por web service con
-- autenticación WSAA, que exige un certificado X.509 con su clave privada y
-- firmar un ticket en CMS/PKCS#7. Esa clave no puede vivir en el navegador
-- (el repo es público y se sirve por GitHub Pages) y ARCA tampoco manda CORS.
-- Así que la consulta la hace un worker externo —n8n o una Edge Function, sin
-- definir al 3/8/2026— que corre con la service key.
--
-- El contrato con ese worker son DOS funciones, a propósito, para que no
-- dependa de la forma de la tabla y se pueda cambiar de n8n a Edge Function
-- sin tocar nada de acá:
--     arca_padron_pendientes(p_limit)   -> qué CUITs consultar
--     arca_padron_registrar(...)        -> dejar el resultado
--
-- El servicio a usar es ws_sr_padron_a5, que por CUIT devuelve estadoClave
-- (ACTIVO/INACTIVO), fechaFallecimiento (solo personas físicas) y la lista de
-- impuestos/regímenes con su fecha de baja. El PARSEO de esa respuesta vive en
-- el worker y no acá: si mañana cambia la forma del XML no hay que migrar la
-- tabla. `raw` guarda la respuesta completa para poder re-derivar el estado sin
-- volver a consultar.
--
-- LA CLAVE ES EL CUIT, no el código de cliente: varios códigos pueden compartir
-- CUIT (es el caso de los grupos de razones sociales) y no tiene sentido gastar
-- dos consultas en el mismo contribuyente.
--
-- CALIDAD DE LOS CUIT (medido el 3/8/2026 sobre las 1.245 fichas de customers):
--   1.229 con dígito verificador válido  -> consultables
--      16 placeholder con prefijo 99     -> quedan afuera por decisión de producto
--       0 malformados o vacíos
-- De los consultables, 711 son personas físicas (57%), o sea que el caso
-- "falleció" aplica a la mayoría.

-- ---------------------------------------------------------------------------
-- TABLA
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.arca_padron (
  cuit                    text PRIMARY KEY,
  estado_clave            text,        -- ACTIVO / INACTIVO, tal cual lo devuelve ARCA
  tipo_persona            text,        -- FISICA / JURIDICA
  razon_social_arca       text,        -- para contrastar contra customers.business_name
  fecha_fallecimiento     date,        -- solo personas físicas
  tiene_impuestos_activos boolean,
  fecha_baja              date,        -- la baja más reciente entre sus impuestos
  raw                     jsonb,
  error                   text,        -- si la consulta falló o el CUIT no existe
  consultado_at           timestamptz,
  proxima_revision        timestamptz NOT NULL DEFAULT now()
);

-- La cola sale por acá: los vencidos primero.
CREATE INDEX IF NOT EXISTS arca_padron_proxima_revision_idx
  ON public.arca_padron (proxima_revision);

ALTER TABLE public.arca_padron ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS arca_padron_admin_all ON public.arca_padron;
CREATE POLICY arca_padron_admin_all ON public.arca_padron
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM admins a WHERE a.auth_user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM admins a WHERE a.auth_user_id = auth.uid()));


-- ---------------------------------------------------------------------------
-- Validación de CUIT: 11 dígitos, sin el prefijo 99 de los placeholder, y con
-- dígito verificador correcto (módulo 11 sobre los pesos 5432765432).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cuit_valido(p_cuit text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
AS $function$
  WITH d AS (SELECT regexp_replace(COALESCE(p_cuit, ''), '[^0-9]', '', 'g') AS c)
  SELECT length(d.c) = 11
     AND left(d.c, 2) <> '99'
     AND (
       SELECT (11 - (sum(substr(d.c, i::int, 1)::int * w) % 11)) % 11
       FROM unnest(ARRAY[5,4,3,2,7,6,5,4,3,2]) WITH ORDINALITY AS t(w, i)
     )::text = right(d.c, 1)
  FROM d;
$function$;

CREATE OR REPLACE FUNCTION public.arca_cuits_de_clientes()
 RETURNS TABLE(cuit text)
 LANGUAGE sql
 STABLE
AS $function$
  SELECT DISTINCT regexp_replace(c.cuit, '[^0-9]', '', 'g')
  FROM customers c
  WHERE cuit_valido(c.cuit);
$function$;


-- ---------------------------------------------------------------------------
-- CONTRATO CON EL WORKER — lectura de la cola.
-- Los que nunca se consultaron y los que ya vencieron, los nuevos primero.
-- NO hace falta un cron que "marque" nada: proxima_revision se setea a +1 mes
-- en cada escritura, así que la cola se rearma sola. El cron que hará falta es
-- el que DISPARE al worker, y ese vive del lado del worker.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.arca_padron_pendientes(p_limit integer DEFAULT 200)
 RETURNS TABLE(cuit text, consultado_at timestamptz)
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  SELECT q.cuit, p.consultado_at
  FROM arca_cuits_de_clientes() q
  LEFT JOIN arca_padron p ON p.cuit = q.cuit
  WHERE p.cuit IS NULL OR p.proxima_revision <= now()
  ORDER BY (p.consultado_at IS NOT NULL), p.proxima_revision NULLS FIRST, q.cuit
  LIMIT GREATEST(p_limit, 1);
$function$;


-- ---------------------------------------------------------------------------
-- CONTRATO CON EL WORKER — escritura del resultado.
-- Un error NO se reintenta en el acto: se reprograma a 7 días para no quedar
-- pegado consultando en cada corrida un CUIT que ARCA rechaza siempre.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.arca_padron_registrar(
  p_cuit                    text,
  p_estado_clave            text DEFAULT NULL,
  p_tipo_persona            text DEFAULT NULL,
  p_razon_social            text DEFAULT NULL,
  p_fecha_fallecimiento     date DEFAULT NULL,
  p_tiene_impuestos_activos boolean DEFAULT NULL,
  p_fecha_baja              date DEFAULT NULL,
  p_raw                     jsonb DEFAULT NULL,
  p_error                   text DEFAULT NULL,
  p_meses_revision          integer DEFAULT 1
)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
AS $function$
  INSERT INTO arca_padron AS a (
    cuit, estado_clave, tipo_persona, razon_social_arca, fecha_fallecimiento,
    tiene_impuestos_activos, fecha_baja, raw, error, consultado_at, proxima_revision
  ) VALUES (
    regexp_replace(p_cuit, '[^0-9]', '', 'g'),
    p_estado_clave, p_tipo_persona, p_razon_social, p_fecha_fallecimiento,
    p_tiene_impuestos_activos, p_fecha_baja, p_raw, p_error, now(),
    now() + (CASE WHEN p_error IS NOT NULL THEN '7 days'::interval
                  ELSE (GREATEST(p_meses_revision, 1) || ' months')::interval END)
  )
  ON CONFLICT (cuit) DO UPDATE SET
    estado_clave            = EXCLUDED.estado_clave,
    tipo_persona            = EXCLUDED.tipo_persona,
    razon_social_arca       = EXCLUDED.razon_social_arca,
    fecha_fallecimiento     = EXCLUDED.fecha_fallecimiento,
    tiene_impuestos_activos = EXCLUDED.tiene_impuestos_activos,
    fecha_baja              = EXCLUDED.fecha_baja,
    raw                     = EXCLUDED.raw,
    error                   = EXCLUDED.error,
    consultado_at           = EXCLUDED.consultado_at,
    proxima_revision        = EXCLUDED.proxima_revision;
$function$;

-- Las dos del worker corren con service key. Se les saca el EXECUTE a todo lo
-- demás: Postgres se lo da a PUBLIC por omisión y anon hereda de PUBLIC, o sea
-- que nacen ejecutables con la anon key, que es pública.
REVOKE ALL ON FUNCTION public.arca_padron_pendientes(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.arca_padron_registrar(text, text, text, text, date, boolean, date, jsonb, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.arca_padron_pendientes(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.arca_padron_registrar(text, text, text, text, date, boolean, date, jsonb, text, integer) TO service_role;


-- ---------------------------------------------------------------------------
-- ESTADO DERIVADO POR CLIENTE.
-- Es la interfaz que consumen los otros módulos: se lee de acá y no de
-- arca_padron directamente, así el criterio vive en un solo lugar.
--
-- El orden del CASE importa: el fallecimiento manda sobre cualquier otra cosa,
-- y la clave inactiva manda sobre los impuestos.
--
-- "activo_probable" y no "activo" a propósito: el padrón dice el estado FISCAL,
-- no si el negocio está operando.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_clientes_arca AS
SELECT c.cod_cliente::text AS cod_cliente,
       c.business_name,
       regexp_replace(COALESCE(c.cuit, ''), '[^0-9]', '', 'g') AS cuit,
       p.estado_clave,
       p.tipo_persona,
       p.razon_social_arca,
       p.fecha_fallecimiento,
       p.tiene_impuestos_activos,
       p.fecha_baja,
       p.error,
       p.consultado_at,
       CASE
         WHEN NOT cuit_valido(c.cuit)                THEN 'sin_cuit'
         WHEN p.cuit IS NULL                          THEN 'sin_consultar'
         WHEN p.error IS NOT NULL                     THEN 'error'
         WHEN p.fecha_fallecimiento IS NOT NULL       THEN 'fallecido'
         WHEN upper(COALESCE(p.estado_clave, '')) <> 'ACTIVO' THEN 'baja'
         WHEN p.tiene_impuestos_activos IS FALSE      THEN 'baja'
         ELSE 'activo_probable'
       END AS estado_arca,
       -- Central de Deudores del BCRA. Es una fuente INDEPENDIENTE de ARCA:
       -- mide deuda con entidades financieras, no estado fiscal. Un cliente
       -- puede estar impecable en una y mal en la otra.
       b.situacion     AS bcra_situacion,
       b.periodo       AS bcra_periodo,
       b.error         AS bcra_error,
       b.consultado_at AS bcra_consultado_at,
       -- Estado ÚNICO del lado BCRA, para que el filtro compare contra un solo
       -- campo y la pantalla no tenga que rearmar el criterio.
       --   '1'..'6'      la situación informada
       --   sin_deuda     el BCRA respondió y no informa deuda (404, o 200 sin
       --                 entidades). Es un RESULTADO, no un hueco.
       --   error         la consulta falló. Sí es un hueco: no sabemos.
       --   sin_consultar todavía no se preguntó
       -- El ELSE cubre el caso 200-sin-entidades, que no tiene situación ni
       -- error y sin esta rama quedaba mostrando "consultando…" para siempre.
       CASE
         WHEN b.cuit IS NULL              THEN 'sin_consultar'
         WHEN b.situacion IS NOT NULL     THEN b.situacion::text
         WHEN b.error IS NOT NULL
          AND b.error <> 'sin registros'  THEN 'error'
         ELSE 'sin_deuda'
       END AS bcra_estado
FROM customers c
LEFT JOIN arca_padron p
  ON p.cuit = regexp_replace(COALESCE(c.cuit, ''), '[^0-9]', '', 'g')
LEFT JOIN bcra_situacion b
  ON b.cuit = regexp_replace(COALESCE(c.cuit, ''), '[^0-9]', '', 'g');

REVOKE ALL ON public.v_clientes_arca FROM PUBLIC, anon;
GRANT SELECT ON public.v_clientes_arca TO authenticated, service_role;


-- ---------------------------------------------------------------------------
-- Resumen por estado, para las tarjetas del módulo.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_arca_resumen()
 RETURNS TABLE(estado_arca text, clientes bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  SELECT v.estado_arca, count(*)::bigint
  FROM v_clientes_arca v
  WHERE EXISTS (SELECT 1 FROM admins a WHERE a.auth_user_id = auth.uid())
  GROUP BY 1
  ORDER BY 1;
$function$;


-- ---------------------------------------------------------------------------
-- Tabla del módulo. Paginada server-side por lo mismo que el Ranking Inactivos:
-- son 1.245 clientes y el REST corta en 1000.
-- p_estados NULL o vacío = todos.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_arca_estado_clientes(
  p_limit    integer DEFAULT 25,
  p_offset   integer DEFAULT 0,
  p_q        text    DEFAULT NULL,
  p_estados  text[]  DEFAULT NULL,
  p_bcra     text[]  DEFAULT NULL
)
 RETURNS TABLE(
   cod_cliente text, business_name text, cuit text, estado_arca text,
   estado_clave text, tipo_persona text, razon_social_arca text,
   fecha_fallecimiento date, fecha_baja date, error text,
   consultado_at timestamptz,
   bcra_situacion smallint, bcra_periodo text, bcra_error text,
   bcra_consultado_at timestamptz, bcra_estado text,
   total_filas bigint
 )
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  WITH guard AS (
    SELECT 1 WHERE EXISTS (SELECT 1 FROM admins a WHERE a.auth_user_id = auth.uid())
  ),
  filtrado AS (
    SELECT v.*, COUNT(*) OVER ()::bigint AS n_total
    FROM v_clientes_arca v, guard
    WHERE (
        COALESCE(btrim(p_q), '') = ''
        OR v.cod_cliente ILIKE '%' || btrim(p_q) || '%'
        OR v.business_name ILIKE '%' || btrim(p_q) || '%'
        OR (
          length(regexp_replace(btrim(p_q), '[^0-9]', '', 'g')) >= 6
          AND v.cuit LIKE '%' || regexp_replace(btrim(p_q), '[^0-9]', '', 'g') || '%'
        )
      )
      AND (p_estados IS NULL OR cardinality(p_estados) = 0
           OR v.estado_arca = ANY (p_estados))
      -- Compara contra el estado derivado, así '1'..'6', 'sin_deuda', 'error' y
      -- 'sin_consultar' son opciones del mismo tipo y el filtro es una línea.
      AND (p_bcra IS NULL OR cardinality(p_bcra) = 0
           OR v.bcra_estado = ANY (p_bcra))
  )
  SELECT f.cod_cliente, f.business_name, f.cuit, f.estado_arca,
         f.estado_clave, f.tipo_persona, f.razon_social_arca,
         f.fecha_fallecimiento, f.fecha_baja, f.error,
         f.consultado_at,
         f.bcra_situacion, f.bcra_periodo, f.bcra_error, f.bcra_consultado_at,
         f.bcra_estado,
         f.n_total
  FROM filtrado f
  -- Orden fijo: primero lo que requiere acción.
  ORDER BY CASE f.estado_arca
             WHEN 'fallecido' THEN 1 WHEN 'baja' THEN 2 WHEN 'error' THEN 3
             WHEN 'sin_consultar' THEN 4 WHEN 'sin_cuit' THEN 5 ELSE 6 END,
           f.business_name, f.cod_cliente
  LIMIT GREATEST(p_limit, 1) OFFSET GREATEST(p_offset, 0);
$function$;


-- ---------------------------------------------------------------------------
-- Botón "revisar ahora". No consulta ARCA —eso lo hace el worker— sino que
-- adelanta la próxima revisión, así el CUIT entra primero en la cola.
-- Cuando el worker esté definido, el frontend puede además invocarlo para que
-- sea instantáneo; el efecto sobre la cola es el mismo.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.arca_marcar_para_revision(p_cuit text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_cuit text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admins a WHERE a.auth_user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Solo admins pueden pedir revisiones de padrón';
  END IF;

  v_cuit := regexp_replace(COALESCE(p_cuit, ''), '[^0-9]', '', 'g');
  IF NOT cuit_valido(v_cuit) THEN
    RAISE EXCEPTION 'CUIT inválido: %', p_cuit;
  END IF;

  -- Si nunca se consultó no hay fila, y no hace falta crearla: la cola sale de
  -- arca_cuits_de_clientes, así que ya está pendiente.
  UPDATE arca_padron SET proxima_revision = now() WHERE cuit = v_cuit;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_arca_resumen() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_arca_estado_clientes(integer, integer, text, text[], text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.arca_marcar_para_revision(text) TO authenticated;


-- ---------------------------------------------------------------------------
-- BCRA — Central de Deudores
--
-- A diferencia de ARCA, esta API es PÚBLICA y sin autenticación, y manda CORS
-- (verificado el 3/8/2026 desde el panel). O sea que la consulta la hace el
-- propio navegador: no hace falta worker ni certificado.
--
-- Igual se persiste para no pegarle al BCRA en cada carga de página por los
-- mismos clientes, y para que el dato quede disponible para otros módulos. El
-- dato del BCRA es MENSUAL y se publica con rezago, así que reconsultar seguido
-- no aporta nada: el frontend reconsulta recién a los 20 días.
--
-- `situacion` es el PEOR valor entre todas las entidades informadas, que es la
-- lectura estándar: 1 normal, 2 riesgo bajo, 3 riesgo medio, 4 riesgo alto,
-- 5 irrecuperable, 6 irrecuperable por disposición técnica.
--
-- `raw` guarda la respuesta completa. Al 3/8/2026 el mapeo de campos NO está
-- verificado contra una respuesta real (el entorno de desarrollo no llega al
-- BCRA), así que raw es lo que permite corregir el parseo sin reconsultar.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.bcra_situacion (
  cuit          text PRIMARY KEY,
  situacion     smallint,     -- 1..6, el peor entre las entidades
  denominacion  text,         -- como lo nombra el BCRA
  periodo       text,         -- 'AAAAMM' del último período informado
  entidades     jsonb,        -- detalle por entidad financiera
  raw           jsonb,
  error         text,         -- 404 = sin registros, u otro problema
  consultado_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.bcra_situacion ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bcra_situacion_admin_all ON public.bcra_situacion;
CREATE POLICY bcra_situacion_admin_all ON public.bcra_situacion
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM admins a WHERE a.auth_user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM admins a WHERE a.auth_user_id = auth.uid()));

-- La escribe el NAVEGADOR (a diferencia de ARCA, que la escribe un worker con
-- service key), así que lleva el chequeo de admin adentro.
CREATE OR REPLACE FUNCTION public.bcra_registrar(
  p_cuit         text,
  p_situacion    smallint DEFAULT NULL,
  p_denominacion text     DEFAULT NULL,
  p_periodo      text     DEFAULT NULL,
  p_entidades    jsonb    DEFAULT NULL,
  p_raw          jsonb    DEFAULT NULL,
  p_error        text     DEFAULT NULL
)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_cuit text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admins a WHERE a.auth_user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Solo admins pueden registrar consultas al BCRA';
  END IF;

  v_cuit := regexp_replace(COALESCE(p_cuit, ''), '[^0-9]', '', 'g');
  IF NOT cuit_valido(v_cuit) THEN
    RAISE EXCEPTION 'CUIT inválido: %', p_cuit;
  END IF;

  INSERT INTO bcra_situacion AS b (cuit, situacion, denominacion, periodo,
                                   entidades, raw, error, consultado_at)
  VALUES (v_cuit, p_situacion, p_denominacion, p_periodo,
          p_entidades, p_raw, p_error, now())
  ON CONFLICT (cuit) DO UPDATE SET
    situacion     = EXCLUDED.situacion,
    denominacion  = EXCLUDED.denominacion,
    periodo       = EXCLUDED.periodo,
    entidades     = EXCLUDED.entidades,
    raw           = EXCLUDED.raw,
    error         = EXCLUDED.error,
    consultado_at = EXCLUDED.consultado_at;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.bcra_registrar(text, smallint, text, text, jsonb, jsonb, text) TO authenticated;


-- ---------------------------------------------------------------------------
-- CUITs que le faltan consulta al BCRA. Lo usa el botón "Consultar todos" del
-- panel, que recorre el padrón entero en vez de solo la hoja visible: la
-- consulta automática cubre las 25 filas a la vista, así que llenar los 1.229
-- a fuerza de paginar son 50 pantallas.
--
-- Mismo criterio que aplica el frontend por fila:
--   sin fila             -> nunca se consultó
--   error                -> se reintenta siempre (suelen ser fallas de red)
--   más de p_dias        -> vencido; el dato del BCRA es mensual, no hace falta
--                           refrescarlo seguido
--
-- La llama el navegador con la sesión del admin, así que lleva el chequeo
-- adentro igual que bcra_registrar.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.bcra_pendientes(
  p_dias  integer DEFAULT 20,
  p_limit integer DEFAULT 2000
)
 RETURNS TABLE(cuit text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  SELECT q.cuit
  FROM arca_cuits_de_clientes() q
  LEFT JOIN bcra_situacion b ON b.cuit = q.cuit
  WHERE EXISTS (SELECT 1 FROM admins a WHERE a.auth_user_id = auth.uid())
    AND (
      b.cuit IS NULL
      OR (b.error IS NOT NULL AND b.error <> 'sin registros')
      OR b.consultado_at < now() - (GREATEST(p_dias, 1) || ' days')::interval
    )
  ORDER BY q.cuit
  LIMIT GREATEST(p_limit, 1);
$function$;

GRANT EXECUTE ON FUNCTION public.bcra_pendientes(integer, integer) TO authenticated;
