-- ===========================================================================
-- GERENTE DE VENTAS
-- ===========================================================================
-- Módulo de acciones comerciales del panel. Dos mitades:
--
--   1. El AGENTE: analiza toda la clientela, arma 5 acciones por día y aprende
--      de lo que el equipo marca como útil (gv_senales.intentos/aciertos).
--   2. La COBERTURA GEOGRÁFICA: sucursales por localidad contra población, para
--      ver dónde estamos fríos y dónde calientes.
--
-- OJO — ESTE ARCHIVO ES LA FORMA CANÓNICA, NO UN VOLCADO.
-- Varias de estas funciones se desplegaron parcheando `prosrc` en la base (el
-- guard de admin y el score suave se insertaron sobre el cuerpo ya creado), así
-- que el md5 del cuerpo normalizado que describe CLAUDE.md NO va a coincidir
-- para este archivo hasta que se regeneren corriéndolo entero. Correr este
-- script de punta a punta deja la base en el mismo estado FUNCIONAL que hoy.
-- Para ver lo realmente desplegado:
--   select pg_get_functiondef(p.oid) from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' and p.proname like 'gv\_%';
--
-- PENDIENTE — SALIDA POR TELEGRAM (pedido del usuario, 3/8/2026)
-- Las 5 acciones del día tienen que poder llegar por Telegram. Falta SOLO el
-- transporte: gv_sugerencias ya las guarda y gv_agenda las devuelve armadas.
-- Hoy no hay nada de Telegram en el proyecto (ni tablas, ni Edge Functions, ni
-- secretos); si el bot existe está en n8n. Necesita TELEGRAM_BOT_TOKEN en los
-- secretos de Supabase —NUNCA en el repo, que es público— y el chat id.
-- El patrón a copiar es pg_cron -> net.http_post -> Edge Function, que ya se usa
-- en retry-sheets, asoc-timeout-cron, ig-token-refresh y notify-tracking.
-- Ver la sección "Pendientes" de CLAUDE.md para las decisiones abiertas.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- HELPERS
-- ---------------------------------------------------------------------------

-- Normaliza un nombre de localidad: saca acentos, puntuación y mayúsculas.
-- NO reusa norm_razon_social porque esa además borra sufijos societarios
-- (S.A., "sociedad anonima"), que en un topónimo no corresponde.
CREATE OR REPLACE FUNCTION public.gv_norm_loc(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT btrim(regexp_replace(
           lower(regexp_replace(
             translate(COALESCE(p, ''),
               'ÁÀÄÂÉÈËÊÍÌÏÎÓÒÖÔÚÙÜÛÑÇáàäâéèëêíìïîóòöôúùüûñç',
               'AAAAEEEEIIIIOOOOUUUUNCaaaaeeeeiiiioooouuuunc'),
             '[^A-Za-z0-9]+', ' ', 'g')),
           '\s+', ' ', 'g'));
$function$;

-- Peso de una señal: tasa de acierto suavizada (Laplace, +1/+2) para que una
-- señal nueva —o con dos intentos— no se dispare ni se hunda por azar. Arranca
-- en 0,5 y necesita evidencia para moverse.
CREATE OR REPLACE FUNCTION public.gv_peso(p_intentos integer, p_aciertos integer)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT round((COALESCE(p_aciertos, 0) + 1)::numeric
             / (COALESCE(p_intentos, 0) + 2)::numeric, 4);
$function$;

-- Score que crece con el exceso pero nunca llega a 1: x/(x+k).
--
-- Reemplaza a LEAST(1.0, x/k), que saturaba. Con el tope, un cliente 11,4× su
-- ritmo y otro 5,6× puntuaban IGUAL (1.0 los dos) y el orden dentro de la señal
-- se perdía: las 5 del día salían todas con score 0,5000.
CREATE OR REPLACE FUNCTION public.gv_score_suave(p_exceso numeric, p_k numeric)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT CASE WHEN COALESCE(p_exceso, 0) <= 0 THEN 0::numeric
              ELSE round(p_exceso / (p_exceso + p_k), 4) END;
$function$;

-- Guard de admin. Devuelve true o revienta; nunca false.
--
-- Hace falta porque toda RPC nueva nace SECURITY DEFINER y ejecutable por
-- authenticated: sin esto, un mayorista logueado podía leer la agenda con
-- nombres y WhatsApp de clientes, o el mapa de cobertura entero.
--
-- IMPORTANTE: tiene que invocarse con PERFORM desde plpgsql. Colgarlo del FROM
-- de una función SQL (`FROM (SELECT gv_es_admin()) _adm, ...`) NO funciona:
-- Postgres elimina una subconsulta de una fila cuyas columnas no se referencian
-- y el guard nunca se evalúa. Se probó y bloqueaba 0 de 5.
CREATE OR REPLACE FUNCTION public.gv_es_admin()
RETURNS boolean
LANGUAGE plpgsql
STABLE SECURITY DEFINER
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admins a WHERE a.auth_user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Solo un administrador puede usar Gerente de ventas';
  END IF;
  RETURN true;
END;
$function$;

-- Variante para lo que también corre el cron. gv_es_admin() a secas no sirve
-- ahí: el cron ejecuta como postgres, sin JWT, así que auth.uid() es NULL y la
-- generación diaria moriría todas las mañanas. Con sesión exige admin; sin
-- sesión es el cron o un service_role, y a anon ya se le revocó el EXECUTE.
CREATE OR REPLACE FUNCTION public.gv_es_admin_o_cron()
RETURNS boolean
LANGUAGE plpgsql
STABLE SECURITY DEFINER
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN true;
  END IF;
  RETURN gv_es_admin();
END;
$function$;


-- ---------------------------------------------------------------------------
-- TABLAS — BASE GEOGRÁFICA
--
-- La unidad geográfica es la LOCALIDAD, no la calle: customer_delivery_addresses
-- tiene cp cargado en 3 filas de 1583 y calle en 4, así que el domicilio fino no
-- existe. Lo que sí está es provincia (1566/1583) y localidad (1471/1583), que
-- además es la granularidad correcta para un ratio contra población.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.geo_provincias (
  provincia  text PRIMARY KEY,
  poblacion  integer NOT NULL,
  anio       integer,
  fuente     text
);

-- lat/lon las completa el navegador contra la API Georef; poblacion se importa.
CREATE TABLE IF NOT EXISTS public.geo_localidades (
  provincia   text NOT NULL,
  loc_norm    text NOT NULL,
  localidad   text NOT NULL,
  lat         double precision,
  lon         double precision,
  geo_fuente  text,
  geo_at      timestamptz,
  poblacion   integer,
  pob_fuente  text,
  pob_anio    integer,
  PRIMARY KEY (provincia, loc_norm)
);

-- Sinónimos de localidad. Editable a propósito, igual que tokens_no_distintivos:
-- el padrón trae "Tucuman" y "San Miguel de Tucuman" para la misma ciudad, y eso
-- se resuelve agregando una fila acá y no tocando código.
CREATE TABLE IF NOT EXISTS public.geo_localidad_alias (
  provincia    text NOT NULL,
  loc_norm     text NOT NULL,
  canon_norm   text NOT NULL,
  PRIMARY KEY (provincia, loc_norm)
);

INSERT INTO public.geo_localidad_alias (provincia, loc_norm, canon_norm)
VALUES ('Tucumán', 'tucuman', 'san miguel de tucuman')
ON CONFLICT DO NOTHING;


-- ---------------------------------------------------------------------------
-- TABLAS — EL AGENTE
-- ---------------------------------------------------------------------------

-- Catálogo de señales. El peso NO se escribe a mano: sale de la tasa de acierto
-- histórica de cada señal, y es lo que hace que el módulo se automejore.
CREATE TABLE IF NOT EXISTS public.gv_senales (
  tipo        text PRIMARY KEY,
  etiqueta    text NOT NULL,
  descripcion text,
  activa      boolean NOT NULL DEFAULT true,
  intentos    integer NOT NULL DEFAULT 0,
  aciertos    integer NOT NULL DEFAULT 0
);

INSERT INTO public.gv_senales (tipo, etiqueta, descripcion) VALUES
 ('reactivar',      'Reactivar cliente dormido',
  'Dejó de comprar hace más del período de corte y tiene valor histórico alto. Es el que más plata deja sobre la mesa.'),
 ('ritmo_caido',    'Se le cayó el ritmo',
  'Sigue activo pero hace más del doble de su intervalo habitual que no compra. Se agarra antes de que se enfríe.'),
 ('categoria_perdida', 'Dejó de comprar una categoría',
  'Compraba una categoría con regularidad y hace 6 meses que no la lleva, aunque sigue comprando otras cosas.'),
 ('chef_activo_lk_frio', 'Le compra a Chef y no a Loekemeyer',
  'Está activo en Chef y frío en Loekemeyer: el cliente existe y compra, solo que no nos elige a nosotros.'),
 ('sin_portal',     'Nunca usó el portal web',
  'Cliente activo que nunca hizo un pedido por la web. Engancharlo al portal sube la frecuencia sin costo de visita.'),
 ('zona_fria',      'Zona con poca cobertura',
  'Localidad o provincia con muchos habitantes por punto de venta comparada con el resto del país. Es prospección, no cartera.')
ON CONFLICT (tipo) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.gv_sugerencias (
  id          bigserial PRIMARY KEY,
  fecha       date NOT NULL DEFAULT CURRENT_DATE,
  tipo        text NOT NULL REFERENCES public.gv_senales(tipo),
  cod_cliente text,
  titulo      text NOT NULL,
  motivo      text NOT NULL,
  accion      text NOT NULL,
  score       numeric NOT NULL DEFAULT 0,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  estado      text NOT NULL DEFAULT 'pendiente',
  notas       text,
  resuelto_por uuid,
  resuelto_at  timestamptz,
  creado_at    timestamptz NOT NULL DEFAULT now()
);

-- Una misma acción no se puede proponer dos veces el mismo día.
CREATE UNIQUE INDEX IF NOT EXISTS gv_sugerencias_dia_uk
  ON public.gv_sugerencias (fecha, tipo, COALESCE(cod_cliente, ''));
CREATE INDEX IF NOT EXISTS gv_sugerencias_fecha_idx
  ON public.gv_sugerencias (fecha DESC);


-- ---------------------------------------------------------------------------
-- RLS — las cinco tablas son solo de admin
-- ---------------------------------------------------------------------------
ALTER TABLE public.geo_provincias       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.geo_localidades      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.geo_localidad_alias  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gv_senales           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gv_sugerencias       ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['geo_provincias','geo_localidades','geo_localidad_alias',
                           'gv_senales','gv_sugerencias']
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = t AND policyname = t || '_admin') THEN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR ALL '
        'USING (EXISTS (SELECT 1 FROM admins a WHERE a.auth_user_id = auth.uid())) '
        'WITH CHECK (EXISTS (SELECT 1 FROM admins a WHERE a.auth_user_id = auth.uid()))',
        t || '_admin', t);
    END IF;
  END LOOP;
END $$;


-- ---------------------------------------------------------------------------
-- COBERTURA
-- ---------------------------------------------------------------------------

-- Da de alta en geo_localidades toda localidad que aparezca en las sucursales.
-- Solo INSERTA: nunca pisa lat/lon ni población ya cargadas. El nombre canónico
-- es la grafía más frecuente del padrón.
CREATE OR REPLACE FUNCTION public.gv_refrescar_localidades()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_nuevas integer;
BEGIN
  PERFORM gv_es_admin_o_cron();

  WITH crudo AS (
    SELECT btrim(d.provincia) AS provincia,
           gv_norm_loc(d.localidad) AS loc_norm,
           btrim(d.localidad) AS localidad
    FROM customer_delivery_addresses d
    WHERE NULLIF(btrim(d.provincia), '') IS NOT NULL
      AND NULLIF(gv_norm_loc(d.localidad), '') IS NOT NULL
  ),
  -- El alias manda: si "tucuman" apunta a "san miguel de tucuman", las
  -- sucursales de las dos grafías caen en la misma fila.
  canon AS (
    SELECT c.provincia,
           COALESCE(a.canon_norm, c.loc_norm) AS loc_norm,
           c.localidad
    FROM crudo c
    LEFT JOIN geo_localidad_alias a
      ON a.provincia = c.provincia AND a.loc_norm = c.loc_norm
  ),
  elegido AS (
    SELECT provincia, loc_norm, localidad,
           ROW_NUMBER() OVER (PARTITION BY provincia, loc_norm
                              ORDER BY count(*) DESC, localidad) AS rn
    FROM canon
    GROUP BY provincia, loc_norm, localidad
  ),
  ins AS (
    INSERT INTO geo_localidades (provincia, loc_norm, localidad)
    SELECT provincia, loc_norm, localidad FROM elegido WHERE rn = 1
    ON CONFLICT (provincia, loc_norm) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_nuevas FROM ins;

  RETURN v_nuevas;
END;
$function$;

-- Cobertura por localidad: sucursales, clientes, activos, población y el ratio
-- habitantes por punto de venta. Es el insumo del mapa y de la tabla comparativa.
--
-- Mide SOLO Loekemeyer, igual que el resto de Estadística Clientes.
CREATE OR REPLACE FUNCTION public.gv_cobertura(p_meses integer DEFAULT 12)
RETURNS TABLE(
  provincia text, localidad text, loc_norm text,
  lat double precision, lon double precision,
  sucursales bigint, clientes bigint, activos bigint,
  poblacion integer, hab_por_punto numeric
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
AS $function$
BEGIN
  PERFORM gv_es_admin();
  RETURN QUERY
  WITH cutoff AS (
    SELECT to_char(CURRENT_DATE - (p_meses || ' months')::interval, 'YYYY-MM-DD') AS c
  ),
  -- Última compra por código, mismo criterio que el Ranking Inactivos:
  -- empresa lk, sin los ítems administrativos y sin los códigos de prueba.
  ult AS (
    SELECT sl.customer_code AS cod, MAX(sl.invoice_date) AS last_txt
    FROM sales_lines sl
    WHERE sl.empresa = 'lk' AND sl.customer_code IS NOT NULL
      AND sl.customer_code NOT IN ('1', '3878')
      AND sl.invoice_date IS NOT NULL
      AND sl.item_code <> ALL (ARRAY(SELECT item_code FROM sales_excluded_items))
    GROUP BY 1
  ),
  suc AS (
    SELECT btrim(d.provincia) AS provincia,
           COALESCE(al.canon_norm, gv_norm_loc(d.localidad)) AS loc_norm,
           c.cod_cliente::text AS cod
    FROM customer_delivery_addresses d
    JOIN customers c ON c.id = d.customer_id
    LEFT JOIN geo_localidad_alias al
      ON al.provincia = btrim(d.provincia) AND al.loc_norm = gv_norm_loc(d.localidad)
    WHERE NULLIF(btrim(d.provincia), '') IS NOT NULL
      AND NULLIF(gv_norm_loc(d.localidad), '') IS NOT NULL
      AND c.cod_cliente::text NOT IN ('1', '3878')
  ),
  agg AS (
    SELECT s.provincia, s.loc_norm,
           count(*)::bigint AS sucursales,
           count(DISTINCT s.cod)::bigint AS clientes,
           count(DISTINCT s.cod) FILTER (WHERE u.last_txt >= (SELECT c FROM cutoff))::bigint AS activos
    FROM suc s
    LEFT JOIN ult u ON u.cod = s.cod
    GROUP BY 1, 2
  )
  SELECT g.provincia, g.localidad, g.loc_norm, g.lat, g.lon,
         a.sucursales, a.clientes, a.activos,
         g.poblacion,
         CASE WHEN g.poblacion IS NOT NULL AND a.sucursales > 0
              THEN round(g.poblacion::numeric / a.sucursales, 0) END AS hab_por_punto
  FROM agg a
  JOIN geo_localidades g ON g.provincia = a.provincia AND g.loc_norm = a.loc_norm
  ORDER BY a.sucursales DESC, g.provincia, g.localidad;
END;
$function$;

-- Mismo corte a nivel provincia. Acá la población SÍ está cargada para las 24,
-- así que el ratio comparativo funciona desde el día uno.
--
-- El rollup NO se hace sobre gv_cobertura: esa función exige localidad y 112 de
-- las 1583 sucursales no la tienen (92 solo en CABA), así que sumar por ahí
-- subestimaba el denominador y hacía ver más "caliente" a CABA de lo que está.
-- Se cuenta contra el padrón crudo y se expone sin_localidad para que el
-- faltante se vea en pantalla en vez de desaparecer.
CREATE OR REPLACE FUNCTION public.gv_cobertura_provincia(p_meses integer DEFAULT 12)
RETURNS TABLE(
  provincia text, sucursales bigint, clientes bigint, activos bigint,
  localidades bigint, sin_localidad bigint, poblacion integer, hab_por_punto numeric
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
AS $function$
BEGIN
  PERFORM gv_es_admin();
  RETURN QUERY
  WITH cutoff AS (
    SELECT to_char(CURRENT_DATE - (p_meses || ' months')::interval, 'YYYY-MM-DD') AS c
  ),
  ult AS (
    SELECT sl.customer_code AS cod, MAX(sl.invoice_date) AS last_txt
    FROM sales_lines sl
    WHERE sl.empresa = 'lk' AND sl.customer_code IS NOT NULL
      AND sl.customer_code NOT IN ('1', '3878')
      AND sl.invoice_date IS NOT NULL
      AND sl.item_code <> ALL (ARRAY(SELECT item_code FROM sales_excluded_items))
    GROUP BY 1
  ),
  suc AS (
    SELECT btrim(d.provincia) AS provincia,
           NULLIF(gv_norm_loc(d.localidad), '') AS loc_norm,
           c.cod_cliente::text AS cod
    FROM customer_delivery_addresses d
    JOIN customers c ON c.id = d.customer_id
    WHERE NULLIF(btrim(d.provincia), '') IS NOT NULL
      AND c.cod_cliente::text NOT IN ('1', '3878')
  ),
  agg AS (
    SELECT s.provincia,
           count(*)::bigint AS sucursales,
           count(DISTINCT s.cod)::bigint AS clientes,
           count(DISTINCT s.cod) FILTER (WHERE u.last_txt >= (SELECT c FROM cutoff))::bigint AS activos,
           count(DISTINCT s.loc_norm)::bigint AS localidades,
           count(*) FILTER (WHERE s.loc_norm IS NULL)::bigint AS sin_localidad
    FROM suc s
    LEFT JOIN ult u ON u.cod = s.cod
    GROUP BY 1
  )
  SELECT COALESCE(a.provincia, p.provincia),
         COALESCE(a.sucursales, 0), COALESCE(a.clientes, 0), COALESCE(a.activos, 0),
         COALESCE(a.localidades, 0), COALESCE(a.sin_localidad, 0),
         p.poblacion,
         CASE WHEN p.poblacion IS NOT NULL AND COALESCE(a.sucursales, 0) > 0
              THEN round(p.poblacion::numeric / a.sucursales, 0) END
  FROM geo_provincias p
  FULL JOIN agg a ON a.provincia = p.provincia
  ORDER BY 2 DESC;
END;
$function$;


-- ---------------------------------------------------------------------------
-- GEOCODIFICACIÓN
--
-- La hace el NAVEGADOR contra la API Georef de datos.gob.ar, que es pública,
-- sin autenticación y manda CORS — el mismo caso que la del BCRA y el opuesto
-- al de ARCA (que necesita certificado y por eso necesita un worker). Por eso
-- gv_geo_registrar lleva el chequeo de admins adentro: la invoca el browser con
-- el usuario logueado, no un service_role.
-- ---------------------------------------------------------------------------

-- Cola ordenada por peso comercial: primero las localidades donde más
-- sucursales tenemos, así el mapa sirve desde la primera tanda.
CREATE OR REPLACE FUNCTION public.gv_geo_pendientes(p_limite integer DEFAULT 500)
RETURNS TABLE(provincia text, loc_norm text, localidad text, sucursales bigint)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
AS $function$
BEGIN
  PERFORM gv_es_admin();
  RETURN QUERY
  SELECT g.provincia, g.loc_norm, g.localidad, COALESCE(c.sucursales, 0)
  FROM geo_localidades g
  LEFT JOIN (
    SELECT btrim(d.provincia) AS provincia,
           COALESCE(al.canon_norm, gv_norm_loc(d.localidad)) AS loc_norm,
           count(*)::bigint AS sucursales
    FROM customer_delivery_addresses d
    LEFT JOIN geo_localidad_alias al
      ON al.provincia = btrim(d.provincia) AND al.loc_norm = gv_norm_loc(d.localidad)
    WHERE NULLIF(btrim(d.provincia), '') IS NOT NULL
    GROUP BY 1, 2
  ) c ON c.provincia = g.provincia AND c.loc_norm = g.loc_norm
  WHERE g.lat IS NULL OR g.lon IS NULL
  ORDER BY COALESCE(c.sucursales, 0) DESC, g.provincia, g.localidad
  LIMIT GREATEST(1, p_limite);
END;
$function$;

CREATE OR REPLACE FUNCTION public.gv_geo_registrar(
  p_provincia text, p_loc_norm text,
  p_lat double precision, p_lon double precision,
  p_fuente text DEFAULT 'georef'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admins a WHERE a.auth_user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Solo un administrador puede geocodificar';
  END IF;

  -- Argentina continental + islas: fuera de esta caja el dato está mal y meterlo
  -- descoloca el encuadre del mapa entero.
  IF p_lat IS NOT NULL AND (p_lat < -56 OR p_lat > -21 OR p_lon < -74 OR p_lon > -53) THEN
    RAISE EXCEPTION 'Coordenada fuera de Argentina: %, %', p_lat, p_lon;
  END IF;

  UPDATE geo_localidades
     SET lat = p_lat, lon = p_lon, geo_fuente = p_fuente, geo_at = now()
   WHERE provincia = p_provincia AND loc_norm = p_loc_norm;
END;
$function$;

-- Carga de población. loc_norm vacío o NULL = la fila es de provincia.
CREATE OR REPLACE FUNCTION public.gv_set_poblacion(
  p_provincia text, p_loc_norm text, p_poblacion integer,
  p_fuente text DEFAULT NULL, p_anio integer DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admins a WHERE a.auth_user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Solo un administrador puede cargar población';
  END IF;

  IF p_loc_norm IS NULL OR btrim(p_loc_norm) = '' THEN
    UPDATE geo_provincias
       SET poblacion = p_poblacion, fuente = COALESCE(p_fuente, fuente), anio = COALESCE(p_anio, anio)
     WHERE provincia = p_provincia;
  ELSE
    UPDATE geo_localidades
       SET poblacion = p_poblacion, pob_fuente = COALESCE(p_fuente, pob_fuente),
           pob_anio = COALESCE(p_anio, pob_anio)
     WHERE provincia = p_provincia AND loc_norm = p_loc_norm;
  END IF;
END;
$function$;


-- ---------------------------------------------------------------------------
-- EL AGENTE
-- ---------------------------------------------------------------------------

-- Todas las acciones posibles de hoy, con su score crudo (0..1 dentro de cada
-- señal). NO decide nada: elegir las 5 es tarea de gv_generar_dia, que es quien
-- aplica los pesos aprendidos.
--
-- OJO: sales_lines NO va en un CTE compartido. Se referenciaría desde varias
-- señales, Postgres lo materializaría (189k filas) y cada uso pasaría a seq
-- scan — el mismo problema documentado para get_ranking_inactivos. Cada señal
-- repite el filtro inline y sale por sales_lines_lk_cliente_idx.
--
-- Los ::numeric no son decorativos: percentile_cont devuelve double precision y
-- round(double, int) no existe en Postgres.
--
-- No lleva guard de admin: se le revocó EXECUTE a authenticated. La llama solo
-- gv_generar_dia, que es SECURITY DEFINER y corre como postgres.
CREATE OR REPLACE FUNCTION public.gv_candidatos(p_meses integer DEFAULT 12)
RETURNS TABLE(tipo text, cod_cliente text, motivo text, accion text,
              score_base numeric, payload jsonb)
LANGUAGE sql
STABLE SECURITY DEFINER
AS $function$
WITH
corte AS (
  SELECT to_char(CURRENT_DATE - (p_meses || ' months')::interval, 'YYYY-MM-DD') AS c
),

-- 1) REACTIVAR. Sale del Ranking Inactivos ya valorizado en neto, así que
-- respeta grupos, exclusiones por Chef y ocultos sin reimplementarlos.
react AS (
  SELECT e.cod_cliente, e.last_date, e.total_historico
  FROM get_ranking_inactivos_export(p_meses, false) e
  WHERE e.total_historico > 0
  ORDER BY e.total_historico DESC
  LIMIT 20
),
react_c AS (
  SELECT 'reactivar'::text AS tipo,
         r.cod_cliente,
         'Dejó de comprar el ' || to_char(r.last_date, 'DD/MM/YYYY') ||
           ' (' || (CURRENT_DATE - r.last_date) || ' días) y venía dejando $' ||
           to_char(round(r.total_historico), 'FM999G999G999') || ' de valor histórico.' AS motivo,
         'Llamarlo para entender por qué se fue y ofrecerle una recompra con el descuento web.'::text AS accion,
         round(r.total_historico / NULLIF(max(r.total_historico) OVER (), 0), 4) AS score_base,
         jsonb_build_object('ultima_compra', r.last_date,
                            'valor_historico', round(r.total_historico),
                            'dias', CURRENT_DATE - r.last_date) AS payload
  FROM react r
),

-- 2) RITMO CAÍDO. Cliente que SIGUE activo pero se pasó del doble de su
-- intervalo habitual. Se piden al menos 3 brechas para que la mediana signifique
-- algo.
fechas AS (
  SELECT sl.customer_code AS cod, sl.invoice_date::date AS d
  FROM sales_lines sl
  WHERE sl.empresa = 'lk' AND sl.customer_code IS NOT NULL
    AND sl.customer_code NOT IN ('1', '3878')
    AND sl.invoice_date IS NOT NULL
    AND sl.invoice_date >= to_char(CURRENT_DATE - interval '30 months', 'YYYY-MM-DD')
    AND sl.item_code <> ALL (ARRAY(SELECT item_code FROM sales_excluded_items))
  GROUP BY 1, 2
),
brechas AS (
  SELECT cod, d - lag(d) OVER (PARTITION BY cod ORDER BY d) AS dias
  FROM fechas
),
ritmo AS (
  SELECT b.cod,
         (percentile_cont(0.5) WITHIN GROUP (ORDER BY b.dias))::numeric AS mediana,
         max(f.ult) AS ult
  FROM brechas b
  JOIN (SELECT cod, max(d) AS ult FROM fechas GROUP BY 1) f ON f.cod = b.cod
  WHERE b.dias IS NOT NULL
  GROUP BY b.cod
  HAVING count(*) >= 3
),
ritmo_c AS (
  SELECT 'ritmo_caido'::text AS tipo,
         r.cod AS cod_cliente,
         'Compraba cada ' || round(r.mediana)::text || ' días y hace ' ||
           (CURRENT_DATE - r.ult) || ' que no aparece: va ' ||
           round((CURRENT_DATE - r.ult) / NULLIF(r.mediana, 0), 1)::text || '× su ritmo normal.' AS motivo,
         'Contactarlo ahora, antes de que se enfríe del todo. Todavía está en carrera.'::text AS accion,
         gv_score_suave((CURRENT_DATE - r.ult) / NULLIF(r.mediana, 0) - 2, 4) AS score_base,
         jsonb_build_object('mediana_dias', round(r.mediana),
                            'dias_sin_comprar', CURRENT_DATE - r.ult,
                            'ultima_compra', r.ult) AS payload
  FROM ritmo r, corte
  WHERE r.mediana >= 15
    AND (CURRENT_DATE - r.ult) > 2 * r.mediana
    AND to_char(r.ult, 'YYYY-MM-DD') >= corte.c
  ORDER BY ((CURRENT_DATE - r.ult) / NULLIF(r.mediana, 0)) DESC
  LIMIT 20
),

-- 3) CATEGORÍA PERDIDA. Sigue comprando, pero soltó una categoría que llevaba
-- con regularidad.
cat_prev AS (
  SELECT sl.customer_code AS cod, p.category AS cat,
         count(DISTINCT sl.invoice_date) AS veces, sum(sl.boxes) AS cajas
  FROM sales_lines sl
  JOIN products p ON p.cod = sl.item_code
  WHERE sl.empresa = 'lk' AND sl.customer_code NOT IN ('1', '3878')
    AND sl.invoice_date >= to_char(CURRENT_DATE - interval '30 months', 'YYYY-MM-DD')
    AND sl.invoice_date <  to_char(CURRENT_DATE - interval '6 months', 'YYYY-MM-DD')
    AND NULLIF(btrim(p.category), '') IS NOT NULL
    AND sl.item_code <> ALL (ARRAY(SELECT item_code FROM sales_excluded_items))
  GROUP BY 1, 2
  HAVING count(DISTINCT sl.invoice_date) >= 3
),
cat_reciente AS (
  SELECT DISTINCT sl.customer_code AS cod, p.category AS cat
  FROM sales_lines sl
  JOIN products p ON p.cod = sl.item_code
  WHERE sl.empresa = 'lk' AND sl.customer_code NOT IN ('1', '3878')
    AND sl.invoice_date >= to_char(CURRENT_DATE - interval '6 months', 'YYYY-MM-DD')
    AND sl.item_code <> ALL (ARRAY(SELECT item_code FROM sales_excluded_items))
),
-- Solo los que siguen comprando algo: si dejó de comprar TODO, es un reactivar,
-- no una categoría perdida.
vivos AS (
  SELECT DISTINCT customer_code AS cod FROM sales_lines
  WHERE empresa = 'lk' AND customer_code NOT IN ('1', '3878')
    AND invoice_date >= to_char(CURRENT_DATE - interval '6 months', 'YYYY-MM-DD')
    AND item_code <> ALL (ARRAY(SELECT item_code FROM sales_excluded_items))
),
cat_c AS (
  SELECT 'categoria_perdida'::text AS tipo,
         cp.cod AS cod_cliente,
         'Llevaba "' || cp.cat || '" en ' || cp.veces || ' pedidos (' || cp.cajas ||
           ' cajas) y hace 6 meses que no la compra, aunque sigue comprando otras cosas.' AS motivo,
         'Preguntar si cambió de proveedor en esa línea. Es la venta más fácil: ya la usaba.'::text AS accion,
         round(cp.cajas::numeric / NULLIF(max(cp.cajas) OVER (), 0), 4) AS score_base,
         jsonb_build_object('categoria', cp.cat, 'pedidos_previos', cp.veces,
                            'cajas_previas', cp.cajas) AS payload
  FROM cat_prev cp
  JOIN vivos v ON v.cod = cp.cod
  LEFT JOIN cat_reciente cr ON cr.cod = cp.cod AND cr.cat = cp.cat
  WHERE cr.cod IS NULL
  ORDER BY cp.cajas DESC
  LIMIT 20
),

-- 4) COMPRA EN CHEF Y NO EN LOEKEMEYER
chef_c AS (
  SELECT 'chef_activo_lk_frio'::text AS tipo,
         l.cod_lk AS cod_cliente,
         'Está activo en Chef (última compra ' || to_char(l.ult_chef, 'DD/MM/YYYY') ||
           ') y frío en Loekemeyer desde ' || COALESCE(to_char(l.ult_lk, 'DD/MM/YYYY'), 'siempre') ||
           '. El cliente compra, solo que no a nosotros.' AS motivo,
         'Cruzarlo con el vendedor de Chef y ofrecerle la línea Loekemeyer que hoy le compra a otro.'::text AS accion,
         round(COALESCE(l.valor_chef, 0) / NULLIF(max(COALESCE(l.valor_chef, 0)) OVER (), 0), 4) AS score_base,
         jsonb_build_object('ult_chef', l.ult_chef, 'ult_lk', l.ult_lk,
                            'valor_chef', round(COALESCE(l.valor_chef, 0)),
                            'nombre_chef', l.nombre_chef) AS payload
  FROM get_clientes_lk_ch(p_meses) l
  WHERE l.situacion = 'lk_frio_chef_activo'
  ORDER BY COALESCE(l.valor_chef, 0) DESC
  LIMIT 10
),

-- 5) NUNCA USÓ EL PORTAL
portal_c AS (
  SELECT 'sin_portal'::text AS tipo,
         c.cod_cliente::text AS cod_cliente,
         'Cliente activo que nunca hizo un pedido por la web: todos sus pedidos entran por teléfono o vendedor.'::text AS motivo,
         'Darle de alta el usuario del portal y mostrarle el catálogo. Sube la frecuencia sin costo de visita.'::text AS accion,
         0.5::numeric AS score_base,
         jsonb_build_object('tiene_usuario', (c.username IS NOT NULL),
                            'ultima_compra', u.ult) AS payload
  FROM customers c
  JOIN (
    SELECT sl.customer_code AS cod, max(sl.invoice_date) AS ult
    FROM sales_lines sl
    WHERE sl.empresa = 'lk' AND sl.customer_code NOT IN ('1', '3878')
      AND sl.item_code <> ALL (ARRAY(SELECT item_code FROM sales_excluded_items))
    GROUP BY 1
  ) u ON u.cod = c.cod_cliente::text
  CROSS JOIN corte
  WHERE u.ult >= corte.c
    AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id)
  ORDER BY u.ult DESC
  LIMIT 10
),

-- 6) ZONA FRÍA. No es cartera: es prospección. Compara contra la MEDIANA del
-- país, no contra el promedio, para que CABA no arrastre la referencia.
cob AS (SELECT * FROM gv_cobertura_provincia(p_meses) WHERE hab_por_punto IS NOT NULL),
med AS (SELECT (percentile_cont(0.5) WITHIN GROUP (ORDER BY hab_por_punto))::numeric AS m FROM cob),
zona_c AS (
  SELECT 'zona_fria'::text AS tipo,
         NULL::text AS cod_cliente,
         cob.provincia || ' tiene 1 punto de venta cada ' ||
           to_char(cob.hab_por_punto, 'FM999G999') || ' habitantes, contra ' ||
           to_char(round(med.m), 'FM999G999') || ' de la mediana del país: ' ||
           round(cob.hab_por_punto / NULLIF(med.m, 0), 1)::text || '× más flojo.' AS motivo,
         'Buscar distribuidores o puntos nuevos en ' || cob.provincia ||
           '. Hoy hay ' || cob.sucursales || ' sucursales y ' || cob.activos || ' clientes activos.' AS accion,
         gv_score_suave(cob.hab_por_punto / NULLIF(med.m, 0) - 1.5, 3) AS score_base,
         jsonb_build_object('provincia', cob.provincia,
                            'hab_por_punto', cob.hab_por_punto,
                            'mediana_pais', round(med.m),
                            'sucursales', cob.sucursales,
                            'activos', cob.activos) AS payload
  FROM cob, med
  WHERE cob.hab_por_punto > med.m * 1.5
  ORDER BY cob.hab_por_punto DESC
  LIMIT 5
)
SELECT * FROM react_c
UNION ALL SELECT * FROM ritmo_c
UNION ALL SELECT * FROM cat_c
UNION ALL SELECT * FROM chef_c
UNION ALL SELECT * FROM portal_c
UNION ALL SELECT * FROM zona_c;
$function$;

-- Arma las 5 acciones del día.
--
-- score_final = score_base × peso(señal). El peso sale de la tasa de acierto
-- histórica, así que una señal que el equipo marca "sirvió" seguido se propone
-- más y una que se descarta siempre se apaga sola. Eso es la automejora: no hay
-- números escritos a mano que alguien tenga que ir a tocar.
--
-- Tope de 2 por señal: sin eso "reactivar" se lleva las 5 todos los días (es la
-- que tiene los montos más grandes) y el mensaje diario se vuelve una sola lista
-- de morosos. Con el tope, el día mezcla cartera y prospección.
CREATE OR REPLACE FUNCTION public.gv_generar_dia(
  p_fecha date DEFAULT CURRENT_DATE,
  p_meses integer DEFAULT 12,
  p_forzar boolean DEFAULT false
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_ya integer;
  v_n  integer;
BEGIN
  PERFORM gv_es_admin_o_cron();

  SELECT count(*) INTO v_ya FROM gv_sugerencias WHERE fecha = p_fecha;
  IF v_ya > 0 AND NOT p_forzar THEN
    RETURN v_ya;
  END IF;

  IF p_forzar THEN
    -- Solo se rehacen las que nadie tocó: una decisión ya tomada no se pisa.
    DELETE FROM gv_sugerencias WHERE fecha = p_fecha AND estado = 'pendiente';
  END IF;

  WITH cand AS (
    SELECT c.*, gv_peso(s.intentos, s.aciertos) AS peso
    FROM gv_candidatos(p_meses) c
    JOIN gv_senales s ON s.tipo = c.tipo
    WHERE s.activa
  ),
  -- No repetir la misma acción sobre el mismo cliente dentro de 30 días: si ya
  -- se propuso y se resolvió, insistir es ruido; si sigue pendiente, ya está
  -- en la lista.
  frescos AS (
    SELECT c.* FROM cand c
    WHERE NOT EXISTS (
      SELECT 1 FROM gv_sugerencias g
      WHERE g.tipo = c.tipo
        AND COALESCE(g.cod_cliente, '') = COALESCE(c.cod_cliente, '')
        AND g.fecha > p_fecha - 30
        AND g.fecha <> p_fecha
    )
  ),
  scored AS (
    SELECT f.*, round(f.score_base * f.peso, 6) AS score_final
    FROM frescos f
  ),
  ranked AS (
    SELECT s.*, ROW_NUMBER() OVER (PARTITION BY s.tipo ORDER BY s.score_final DESC) AS rn
    FROM scored s
  ),
  elegidos AS (
    SELECT * FROM ranked WHERE rn <= 2 ORDER BY score_final DESC LIMIT 5
  ),
  nombres AS (
    SELECT d.cod, d.nom
    FROM datos_cliente_empresa('lk', ARRAY(SELECT DISTINCT cod_cliente FROM elegidos WHERE cod_cliente IS NOT NULL)) d
  ),
  ins AS (
    INSERT INTO gv_sugerencias (fecha, tipo, cod_cliente, titulo, motivo, accion, score, payload)
    SELECT p_fecha, e.tipo, e.cod_cliente,
           CASE WHEN e.cod_cliente IS NULL
                THEN s.etiqueta
                ELSE COALESCE(n.nom, 'Cliente ' || e.cod_cliente) || ' (' || e.cod_cliente || ')'
           END,
           e.motivo, e.accion, e.score_final,
           e.payload || jsonb_build_object('senal', s.etiqueta, 'peso', e.peso)
    FROM elegidos e
    JOIN gv_senales s ON s.tipo = e.tipo
    LEFT JOIN nombres n ON n.cod = e.cod_cliente
    ON CONFLICT (fecha, tipo, COALESCE(cod_cliente, '')) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_n FROM ins;

  RETURN v_n;
END;
$function$;

-- Registra el resultado y mueve el peso de la señal. Es el único lugar donde
-- gv_senales.intentos/aciertos cambian.
CREATE OR REPLACE FUNCTION public.gv_registrar_resultado(
  p_id bigint, p_resultado text, p_notas text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_tipo   text;
  v_previo text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admins a WHERE a.auth_user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Solo un administrador puede registrar resultados';
  END IF;
  IF p_resultado NOT IN ('pendiente', 'sirvio', 'no_sirvio', 'descartada') THEN
    RAISE EXCEPTION 'Resultado inválido: %', p_resultado;
  END IF;

  SELECT tipo, estado INTO v_tipo, v_previo FROM gv_sugerencias WHERE id = p_id;
  IF v_tipo IS NULL THEN
    RAISE EXCEPTION 'No existe la sugerencia %', p_id;
  END IF;

  -- Deshacer el conteo anterior antes de aplicar el nuevo, para que cambiar de
  -- opinión sobre una sugerencia no sume dos intentos.
  IF v_previo IN ('sirvio', 'no_sirvio') THEN
    UPDATE gv_senales
       SET intentos = GREATEST(0, intentos - 1),
           aciertos = GREATEST(0, aciertos - (CASE WHEN v_previo = 'sirvio' THEN 1 ELSE 0 END))
     WHERE tipo = v_tipo;
  END IF;

  IF p_resultado IN ('sirvio', 'no_sirvio') THEN
    UPDATE gv_senales
       SET intentos = intentos + 1,
           aciertos = aciertos + (CASE WHEN p_resultado = 'sirvio' THEN 1 ELSE 0 END)
     WHERE tipo = v_tipo;
  END IF;

  UPDATE gv_sugerencias
     SET estado = p_resultado,
         notas = COALESCE(p_notas, notas),
         resuelto_por = auth.uid(),
         resuelto_at = now()
   WHERE id = p_id;
END;
$function$;

-- La agenda de un día, ya lista para pintar.
CREATE OR REPLACE FUNCTION public.gv_agenda(p_fecha date DEFAULT CURRENT_DATE)
RETURNS TABLE(id bigint, tipo text, etiqueta text, cod_cliente text, titulo text,
              motivo text, accion text, score numeric, estado text, notas text,
              payload jsonb, whatsapp text)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
AS $function$
BEGIN
  PERFORM gv_es_admin();
  RETURN QUERY
  SELECT g.id, g.tipo, s.etiqueta, g.cod_cliente, g.titulo, g.motivo, g.accion,
         g.score, g.estado, g.notas, g.payload,
         NULLIF(btrim(COALESCE(c.whatsapp, '')), '')
  FROM gv_sugerencias g
  JOIN gv_senales s ON s.tipo = g.tipo
  LEFT JOIN customers c ON c.cod_cliente::text = g.cod_cliente
  WHERE g.fecha = p_fecha
  ORDER BY g.score DESC, g.id;
END;
$function$;

-- Estado del aprendizaje, para mostrar por qué el agente propone lo que propone.
CREATE OR REPLACE FUNCTION public.gv_estado_senales()
RETURNS TABLE(tipo text, etiqueta text, descripcion text, activa boolean,
              intentos integer, aciertos integer, peso numeric, propuestas bigint)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
AS $function$
BEGIN
  PERFORM gv_es_admin();
  RETURN QUERY
  SELECT s.tipo, s.etiqueta, s.descripcion, s.activa, s.intentos, s.aciertos,
         gv_peso(s.intentos, s.aciertos),
         (SELECT count(*) FROM gv_sugerencias g WHERE g.tipo = s.tipo)
  FROM gv_senales s
  ORDER BY gv_peso(s.intentos, s.aciertos) DESC, s.etiqueta;
END;
$function$;


-- ---------------------------------------------------------------------------
-- PERMISOS
--
-- Postgres otorga EXECUTE a PUBLIC en cada función nueva y anon hereda de
-- PUBLIC, así que sin estos REVOKE toda RPC nace ejecutable con la anon key,
-- que es pública porque está embebida en los .js.
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.gv_refrescar_localidades()                       FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.gv_cobertura(integer)                            FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.gv_cobertura_provincia(integer)                  FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.gv_geo_pendientes(integer)                       FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.gv_geo_registrar(text, text, double precision, double precision, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.gv_set_poblacion(text, text, integer, text, integer) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.gv_generar_dia(date, integer, boolean)           FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.gv_registrar_resultado(bigint, text, text)       FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.gv_agenda(date)                                  FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.gv_estado_senales()                              FROM PUBLIC, anon;

-- gv_candidatos se le revoca TAMBIÉN a authenticated: solo la llama
-- gv_generar_dia, que corre como postgres por ser SECURITY DEFINER.
REVOKE EXECUTE ON FUNCTION public.gv_candidatos(integer) FROM PUBLIC, anon, authenticated;


-- ---------------------------------------------------------------------------
-- CRON
--
-- 10:30 UTC = 07:30 ART: la agenda está lista antes de que arranque el día. Va
-- después de sincronizar-chef-diario (03:20 UTC) porque la señal
-- chef_activo_lk_frio depende de get_clientes_lk_ch, que lee el padrón de Chef
-- ya sincronizado.
-- ---------------------------------------------------------------------------
-- select cron.schedule('gerente-ventas-diario', '30 10 * * *',
--                      $$select public.gv_generar_dia(CURRENT_DATE, 12, false);$$);


-- ---------------------------------------------------------------------------
-- CARGA INICIAL
-- ---------------------------------------------------------------------------
-- select public.gv_refrescar_localidades();   -- da de alta las 439 localidades
--
-- POBLACIÓN POR PROVINCIA: la carga inicial que está en la base es PROVISORIA.
-- La suma de las 24 da 46.082.944 contra los 46.044.703 del Censo 2022, o sea
-- ~38.241 de más repartidos en alguna provincia. Reemplazar con el dato oficial
-- del INDEC vía gv_set_poblacion(provincia, NULL, poblacion, fuente, anio).
--
-- POBLACIÓN POR LOCALIDAD: no viene cargada. Sin ella el ratio por localidad
-- queda vacío y solo funciona el de provincia. Se carga con
-- gv_set_poblacion(provincia, loc_norm, poblacion, fuente, anio).
