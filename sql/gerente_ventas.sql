-- ============================================================================
-- MODULO GERENTE DE VENTAS  ·  proyecto LK (kwkclwhmoygunqmlegrg)
-- ============================================================================
-- REGENERADO EL 4/9/2026 DIRECTAMENTE DESDE LA BASE con pg_get_functiondef y
-- el DDL de pg_catalog. La version anterior de este archivo se habia escrito
-- ANTES de la segunda tanda de trabajo y le faltaban por completo el esquema de
-- los dos ejes (resultado/utilidad, util_si/util_no/acc_*, tope_dia),
-- gv_marcar_resultado, gv_marcar_utilidad, gv_preguntas + gv_generar_preguntas +
-- gv_responder_pregunta + gv_preguntas_abiertas, gv_silenciados, gv_rendimiento,
-- gv_agenda_rango, gv_vendedor_de, gv_completar_vendedores y las tres senales
-- nuevas de gv_candidatos. Tampoco daba md5 identico para lo que si tenia,
-- porque varias funciones se habian desplegado parcheando prosrc.
--
-- LA BASE SIGUE SIENDO LA FUENTE DE VERDAD. Este archivo no se ejecuta solo: se
-- corre a mano en el SQL editor, asi que un cambio hecho ahi y no volcado aca
-- lo vuelve a desfasar. Para regenerarlo:
--
--   select pg_get_functiondef(p.oid)
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public'
--     and (p.proname like 'gv\_%' or p.proname like 'geo\_%')
--   order by p.proname;
--
-- Contenido: 8 tablas, 33 funciones.
--
-- El modulo tiene DOS MITADES INDEPENDIENTES:
--   * el AGENTE (gv_*): 5 acciones por dia, nueve senales con score 0..1 y un
--     peso que aprende del feedback. No es un LLM: es SQL deterministico.
--   * la COBERTURA GEOGRAFICA (geo_*): mapa y ratio habitantes/punto.
-- La unica atadura entre las dos es la senal `zona_fria`, que sale de
-- gv_cobertura_provincia.
--
-- Notas que NO estan en el codigo y conviene no volver a aprender a los golpes:
--   * El guard de admin NO puede colgarse del FROM de una funcion SQL: Postgres
--     elimina una subconsulta de una fila cuyas columnas no se referencian y el
--     guard nunca se evalua (bloqueaba 0 de 5). La forma que anda es
--     `perform gv_es_admin();` en plpgsql, que no es optimizable.
--   * Lo que corre por cron usa gv_es_admin_o_cron(), no gv_es_admin(): el cron
--     ejecuta como postgres sin JWT, asi que auth.uid() es NULL y el guard
--     estricto mataria la generacion de todas las mananas.
--   * No meter sales_lines en un CTE compartido entre senales: se materializa
--     (189k filas) y cada uso pasa a seq scan.
--   * Los scores usan gv_score_suave(x,k) = x/(x+k), NO LEAST(1, x/k): el tope
--     saturaba y el orden dentro de la senal se perdia.
-- ============================================================================


-- ============================================================================
-- 1 · TABLAS
-- ============================================================================

create table if not exists public.geo_localidad_alias (
  provincia text not null,
  loc_norm text not null,
  canon_norm text not null
);

create table if not exists public.geo_localidades (
  provincia text not null,
  loc_norm text not null,
  localidad text not null,
  lat double precision,
  lon double precision,
  geo_fuente text,
  geo_at timestamp with time zone,
  poblacion integer,
  pob_fuente text,
  pob_anio integer
);

create table if not exists public.geo_provincias (
  provincia text not null,
  poblacion integer not null,
  anio integer,
  fuente text
);

create table if not exists public.gv_dash_cache (
  id integer not null default 1,
  data jsonb not null,
  generado_at timestamp with time zone not null default now()
);

create table if not exists public.gv_preguntas (
  id bigint not null default nextval('gv_preguntas_id_seq'::regclass),
  clave text not null,
  tipo text not null,
  pregunta text not null,
  detalle text,
  opciones jsonb not null,
  contexto jsonb not null default '{}'::jsonb,
  estado text not null default 'abierta'::text,
  respuesta text,
  respondida_at timestamp with time zone,
  respondida_por uuid,
  creado_at timestamp with time zone not null default now()
);

create table if not exists public.gv_senales (
  tipo text not null,
  etiqueta text not null,
  descripcion text,
  activa boolean not null default true,
  util_si integer not null default 0,
  util_no integer not null default 0,
  acc_ganadas integer not null default 0,
  acc_trab integer not null default 0,
  tope_dia integer not null default 2
);

create table if not exists public.gv_silenciados (
  cod_cliente text not null,
  tipo text,
  hasta date,
  motivo text,
  creado_por uuid default auth.uid(),
  creado_at timestamp with time zone not null default now()
);

create table if not exists public.gv_sugerencias (
  id bigint not null default nextval('gv_sugerencias_id_seq'::regclass),
  fecha date not null default CURRENT_DATE,
  tipo text not null,
  cod_cliente text,
  titulo text not null,
  motivo text not null,
  accion text not null,
  score numeric not null default 0,
  payload jsonb not null default '{}'::jsonb,
  estado text not null default 'pendiente'::text,
  notas text,
  resuelto_por uuid,
  resuelto_at timestamp with time zone,
  creado_at timestamp with time zone not null default now(),
  resultado text not null default 'pendiente'::text,
  utilidad text not null default 'sin_opinion'::text,
  resultado_at timestamp with time zone,
  utilidad_at timestamp with time zone,
  vendedor text
);


-- ============================================================================
-- 2 · CLAVES, CHECKS E INDICES
-- ============================================================================

alter table public.geo_localidad_alias add constraint geo_localidad_alias_pkey PRIMARY KEY (provincia, loc_norm);
alter table public.geo_localidades    add constraint geo_localidades_pkey    PRIMARY KEY (provincia, loc_norm);
alter table public.geo_provincias     add constraint geo_provincias_pkey     PRIMARY KEY (provincia);
alter table public.gv_dash_cache      add constraint gv_dash_cache_pkey      PRIMARY KEY (id);
alter table public.gv_dash_cache      add constraint gv_dash_cache_una_fila  CHECK ((id = 1));
alter table public.gv_preguntas       add constraint gv_preguntas_pkey       PRIMARY KEY (id);
alter table public.gv_senales         add constraint gv_senales_pkey         PRIMARY KEY (tipo);
alter table public.gv_sugerencias     add constraint gv_sugerencias_pkey     PRIMARY KEY (id);
alter table public.gv_sugerencias     add constraint gv_sugerencias_tipo_fkey FOREIGN KEY (tipo) REFERENCES gv_senales(tipo);

-- los dos ejes del feedback, separados a proposito: `resultado` es que paso con
-- el cliente y alimenta la conversion; `utilidad` es si el usuario quiere seguir
-- viendo esa clase de sugerencia y es lo UNICO que mueve el peso.
alter table public.gv_sugerencias add constraint gv_sug_resultado_ck CHECK ((resultado = ANY (ARRAY['pendiente'::text, 'en_curso'::text, 'gano'::text, 'perdio'::text, 'no_aplica'::text])));
alter table public.gv_sugerencias add constraint gv_sug_utilidad_ck  CHECK ((utilidad  = ANY (ARRAY['sin_opinion'::text, 'util'::text, 'no_util'::text])));

CREATE INDEX gv_preguntas_abiertas_idx ON public.gv_preguntas USING btree (estado) WHERE (estado = 'abierta'::text);
CREATE INDEX gv_sugerencias_fecha_idx  ON public.gv_sugerencias USING btree (fecha DESC);
CREATE INDEX gv_sugerencias_vendedor_idx ON public.gv_sugerencias USING btree (vendedor);
CREATE UNIQUE INDEX gv_preguntas_clave_uk ON public.gv_preguntas USING btree (clave);
CREATE UNIQUE INDEX gv_silenciados_uk    ON public.gv_silenciados USING btree (cod_cliente, COALESCE(tipo, '*'::text));
-- una sugerencia por dia, senal y cliente
CREATE UNIQUE INDEX gv_sugerencias_dia_uk ON public.gv_sugerencias USING btree (fecha, tipo, COALESCE(cod_cliente, ''::text));


-- ============================================================================
-- 3 · FUNCIONES
-- ============================================================================

-- ---------------------------------------------------------------- guards ----
-- gv_es_admin NO se puede colgar del FROM de una funcion SQL: Postgres elimina
-- la subconsulta y el guard nunca se evalua. Va por PERFORM en plpgsql.

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
$function$
;

-- el cron corre como postgres sin JWT: auth.uid() es NULL y el guard estricto
-- mataria la generacion de todas las mananas.
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
$function$
;

-- --------------------------------------------------------------- scoring ----
-- tasa de acierto suavizada (Laplace +1/+2): arranca en 0,50 y solo la mueve
-- gv_registrar_resultado / gv_marcar_utilidad. Ahi esta la automejora: no hay
-- constantes escritas a mano que alguien tenga que ir a tocar.
CREATE OR REPLACE FUNCTION public.gv_peso(p_intentos integer, p_aciertos integer)
 RETURNS numeric
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT round((COALESCE(p_aciertos, 0) + 1)::numeric
             / (COALESCE(p_intentos, 0) + 2)::numeric, 4);
$function$
;

-- x/(x+k) y NO least(1, x/k): el tope saturaba (un cliente a 11,4x su ritmo y
-- otro a 5,6x puntuaban 1.0 los dos) y el orden dentro de la senal se perdia.
CREATE OR REPLACE FUNCTION public.gv_score_suave(p_exceso numeric, p_k numeric)
 RETURNS numeric
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT CASE WHEN COALESCE(p_exceso, 0) <= 0 THEN 0::numeric
              ELSE round(p_exceso / (p_exceso + p_k), 4) END;
$function$
;

-- ------------------------------------------------------------- geografia ----
-- NO es norm_razon_social: esa ademas borra sufijos societarios, que en un
-- toponimo no corresponde.
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
$function$
;

CREATE OR REPLACE FUNCTION public.gv_geo_pendientes(p_limite integer DEFAULT 500)
 RETURNS TABLE(provincia text, loc_norm text, localidad text, sucursales bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
AS $function$BEGIN PERFORM gv_es_admin(); RETURN QUERY SELECT g.provincia, g.loc_norm, g.localidad, COALESCE(c.sucursales, 0)
  FROM  geo_localidades g
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
  LIMIT GREATEST(1, p_limite); END;$function$
;

CREATE OR REPLACE FUNCTION public.gv_geo_registrar(p_provincia text, p_loc_norm text, p_lat double precision, p_lon double precision, p_fuente text DEFAULT 'georef'::text)
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
$function$
;

CREATE OR REPLACE FUNCTION public.gv_set_poblacion(p_provincia text, p_loc_norm text, p_poblacion integer, p_fuente text DEFAULT NULL::text, p_anio integer DEFAULT NULL::integer)
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
$function$
;

-- --------------------------------------------------------------- agenda -----
CREATE OR REPLACE FUNCTION public.gv_agenda(p_fecha date DEFAULT CURRENT_DATE)
 RETURNS TABLE(id bigint, tipo text, etiqueta text, cod_cliente text, titulo text, motivo text, accion text, score numeric, resultado text, utilidad text, notas text, payload jsonb, whatsapp text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
AS $function$
BEGIN
  PERFORM gv_es_admin();
  RETURN QUERY
  SELECT g.id, g.tipo, s.etiqueta, g.cod_cliente, g.titulo, g.motivo, g.accion,
         g.score, g.resultado, g.utilidad, g.notas, g.payload,
         NULLIF(btrim(COALESCE(c.whatsapp, '')), '')
  FROM gv_sugerencias g
  JOIN gv_senales s ON s.tipo = g.tipo
  LEFT JOIN customers c ON c.cod_cliente::text = g.cod_cliente
  WHERE g.fecha = p_fecha
  ORDER BY g.score DESC, g.id;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.gv_agenda_rango(p_desde date DEFAULT (CURRENT_DATE - 6), p_hasta date DEFAULT CURRENT_DATE)
 RETURNS TABLE(id bigint, fecha date, tipo text, etiqueta text, cod_cliente text, titulo text, motivo text, accion text, score numeric, resultado text, utilidad text, notas text, payload jsonb, whatsapp text, vendedor text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
AS $function$
BEGIN
  PERFORM gv_es_admin();
  RETURN QUERY
  SELECT g.id, g.fecha, g.tipo, s.etiqueta, g.cod_cliente, g.titulo, g.motivo,
         g.accion, g.score, g.resultado, g.utilidad, g.notas, g.payload,
         NULLIF(btrim(COALESCE(c.whatsapp,'')),''), g.vendedor
  FROM gv_sugerencias g
  JOIN gv_senales s ON s.tipo = g.tipo
  LEFT JOIN customers c ON c.cod_cliente::text = g.cod_cliente
  WHERE g.fecha BETWEEN p_desde AND p_hasta
  ORDER BY g.fecha DESC, g.score DESC, g.id;
END;
$function$
;

-- el nombre del vendedor sale de customer_commissions.vendor_label, NO de
-- customers.vend (que es el codigo del ERP). Para los que no tienen fila se cae
-- al nombre dominante del codigo, derivado en vivo en vend_nom.
CREATE OR REPLACE FUNCTION public.gv_vendedor_de(p_cod text)
 RETURNS text
 LANGUAGE sql
 STABLE
AS $function$
  WITH vend_nom AS (
    SELECT cod, lab FROM (
      SELECT btrim(c2.vend) AS cod, cc.vendor_label AS lab,
             ROW_NUMBER() OVER (PARTITION BY btrim(c2.vend)
                                ORDER BY count(*) DESC, cc.vendor_label) AS rn
      FROM customer_commissions cc
      JOIN customers c2 ON c2.cod_cliente = cc.cod_cliente
      WHERE NULLIF(btrim(c2.vend),'') IS NOT NULL
        AND NULLIF(btrim(cc.vendor_label),'') IS NOT NULL
      GROUP BY btrim(c2.vend), cc.vendor_label
    ) t WHERE rn = 1
  )
  SELECT COALESCE(NULLIF(btrim(cm.vendor_label),''), vn.lab)
  FROM customers c
  LEFT JOIN customer_commissions cm ON cm.cod_cliente::text = p_cod
  LEFT JOIN vend_nom vn ON vn.cod = btrim(c.vend)
  WHERE c.cod_cliente::text = p_cod
  LIMIT 1;
$function$
;

CREATE OR REPLACE FUNCTION public.gv_completar_vendedores(p_fecha date DEFAULT NULL::date)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE v_n integer;
BEGIN
  PERFORM gv_es_admin_o_cron();
  UPDATE gv_sugerencias g
     SET vendedor = gv_vendedor_de(g.cod_cliente)
   WHERE g.cod_cliente IS NOT NULL AND g.vendedor IS NULL
     AND (p_fecha IS NULL OR g.fecha = p_fecha);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$function$
;

-- ------------------------------------------------------------- lecturas -----
CREATE OR REPLACE FUNCTION public.gv_dashboard()
 RETURNS TABLE(data jsonb, generado_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
AS $function$
BEGIN
  PERFORM gv_es_admin();
  RETURN QUERY SELECT d.data, d.generado_at FROM gv_dash_cache d WHERE d.id = 1;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.gv_estado_senales()
 RETURNS TABLE(tipo text, etiqueta text, descripcion text, activa boolean, util_si integer, util_no integer, peso numeric, acc_ganadas integer, acc_trab integer, conversion numeric, propuestas bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
AS $function$
BEGIN
  PERFORM gv_es_admin();
  RETURN QUERY
  SELECT s.tipo, s.etiqueta, s.descripcion, s.activa,
         s.util_si, s.util_no,
         gv_peso(s.util_si + s.util_no, s.util_si),
         s.acc_ganadas, s.acc_trab,
         CASE WHEN s.acc_trab > 0
              THEN round(s.acc_ganadas::numeric / s.acc_trab, 4) END,
         (SELECT count(*) FROM gv_sugerencias g WHERE g.tipo = s.tipo)
  FROM gv_senales s
  ORDER BY gv_peso(s.util_si + s.util_no, s.util_si) DESC, s.etiqueta;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.gv_preguntas_abiertas()
 RETURNS TABLE(id bigint, tipo text, pregunta text, detalle text, opciones jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
AS $function$
BEGIN
  PERFORM gv_es_admin();
  RETURN QUERY
  SELECT p.id, p.tipo, p.pregunta, p.detalle, p.opciones
  FROM gv_preguntas p WHERE p.estado = 'abierta'
  ORDER BY p.creado_at, p.id;
END;
$function$
;

-- ------------------------------------------------------------- feedback -----
-- DOS EJES SEPARADOS, y confundirlos fue un error de diseño real: antes un solo
-- `estado` hacia las dos cosas y una venta perdida bajaba el peso de una senal
-- bien pensada.
--   * resultado -> que paso con el cliente. Alimenta la conversion.
--   * utilidad  -> si el usuario quiere seguir viendo esa clase de sugerencia.
--                  Es lo UNICO que mueve el peso.

CREATE OR REPLACE FUNCTION public.gv_marcar_resultado(p_id bigint, p_resultado text, p_notas text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_tipo text; v_previo text;
BEGIN
  PERFORM gv_es_admin();
  IF p_resultado NOT IN ('pendiente','en_curso','gano','perdio','no_aplica') THEN
    RAISE EXCEPTION 'Resultado inválido: %', p_resultado;
  END IF;

  SELECT tipo, resultado INTO v_tipo, v_previo FROM gv_sugerencias WHERE id = p_id;
  IF v_tipo IS NULL THEN RAISE EXCEPTION 'No existe la sugerencia %', p_id; END IF;

  -- Deshacer el conteo anterior antes de aplicar el nuevo: cambiar de opinión no
  -- puede sumar dos acciones trabajadas.
  IF v_previo IN ('gano','perdio') THEN
    UPDATE gv_senales
       SET acc_trab    = GREATEST(0, acc_trab - 1),
           acc_ganadas = GREATEST(0, acc_ganadas - (CASE WHEN v_previo = 'gano' THEN 1 ELSE 0 END))
     WHERE tipo = v_tipo;
  END IF;
  IF p_resultado IN ('gano','perdio') THEN
    UPDATE gv_senales
       SET acc_trab    = acc_trab + 1,
           acc_ganadas = acc_ganadas + (CASE WHEN p_resultado = 'gano' THEN 1 ELSE 0 END)
     WHERE tipo = v_tipo;
  END IF;

  UPDATE gv_sugerencias
     SET resultado = p_resultado,
         notas = COALESCE(p_notas, notas),
         resultado_at = now(), resuelto_por = auth.uid(), resuelto_at = now()
   WHERE id = p_id;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.gv_marcar_utilidad(p_id bigint, p_utilidad text, p_silenciar_cliente boolean DEFAULT false)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_tipo text; v_previo text; v_cod text;
BEGIN
  PERFORM gv_es_admin();
  IF p_utilidad NOT IN ('sin_opinion','util','no_util') THEN
    RAISE EXCEPTION 'Utilidad inválida: %', p_utilidad;
  END IF;

  SELECT tipo, utilidad, cod_cliente INTO v_tipo, v_previo, v_cod
  FROM gv_sugerencias WHERE id = p_id;
  IF v_tipo IS NULL THEN RAISE EXCEPTION 'No existe la sugerencia %', p_id; END IF;

  IF v_previo = 'util'    THEN UPDATE gv_senales SET util_si = GREATEST(0, util_si - 1) WHERE tipo = v_tipo; END IF;
  IF v_previo = 'no_util' THEN UPDATE gv_senales SET util_no = GREATEST(0, util_no - 1) WHERE tipo = v_tipo; END IF;
  IF p_utilidad = 'util'    THEN UPDATE gv_senales SET util_si = util_si + 1 WHERE tipo = v_tipo; END IF;
  IF p_utilidad = 'no_util' THEN UPDATE gv_senales SET util_no = util_no + 1 WHERE tipo = v_tipo; END IF;

  -- "No me lo traigas más" para ESTE cliente, sin apagar la señal entera.
  IF p_silenciar_cliente AND v_cod IS NOT NULL THEN
    INSERT INTO gv_silenciados (cod_cliente, tipo, motivo)
    VALUES (v_cod, v_tipo, 'marcado no útil desde la agenda')
    ON CONFLICT (cod_cliente, COALESCE(tipo, '*')) DO NOTHING;
  END IF;

  UPDATE gv_sugerencias
     SET utilidad = p_utilidad, utilidad_at = now()
   WHERE id = p_id;
END;
$function$
;

-- El agente pregunta sobre SU PROPIO comportamiento, no propone acciones
-- comerciales. Responder tiene efecto real: apaga la senal, sube su tope_dia o
-- inserta en gv_silenciados.
CREATE OR REPLACE FUNCTION public.gv_responder_pregunta(p_id bigint, p_respuesta text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE r record;
BEGIN
  PERFORM gv_es_admin();
  SELECT * INTO r FROM gv_preguntas WHERE id = p_id;
  IF r.id IS NULL THEN RAISE EXCEPTION 'No existe la pregunta %', p_id; END IF;

  IF r.tipo = 'apagar_senal' AND p_respuesta = 'apagar' THEN
    UPDATE gv_senales SET activa = false WHERE tipo = r.contexto->>'tipo_senal';

  ELSIF r.tipo = 'pedir_opinion' AND p_respuesta IN ('util','no_util') THEN
    -- Cuenta como un voto de utilidad sobre la señal, igual que marcarlo en la agenda.
    UPDATE gv_senales
       SET util_si = util_si + (CASE WHEN p_respuesta = 'util' THEN 1 ELSE 0 END),
           util_no = util_no + (CASE WHEN p_respuesta = 'no_util' THEN 1 ELSE 0 END)
     WHERE tipo = r.contexto->>'tipo_senal';

  ELSIF r.tipo = 'subir_tope' AND p_respuesta = 'subir' THEN
    UPDATE gv_senales SET tope_dia = LEAST(4, tope_dia + 1) WHERE tipo = r.contexto->>'tipo_senal';

  ELSIF r.tipo = 'silenciar_cliente' AND p_respuesta = 'silenciar' THEN
    INSERT INTO gv_silenciados (cod_cliente, tipo, motivo)
    VALUES (r.contexto->>'cod_cliente', NULL, 'respondido desde Preguntas')
    ON CONFLICT (cod_cliente, COALESCE(tipo, '*')) DO NOTHING;
  END IF;

  UPDATE gv_preguntas
     SET estado = 'respondida', respuesta = p_respuesta,
         respondida_at = now(), respondida_por = auth.uid()
   WHERE id = p_id;
END;
$function$
;

-- ------------------------------------------------------------------ PPP -----
-- El universo "en curso" es ppp_programacion (NP 9xxxx = Loekemeyer) MENOS las
-- NP que ya estan en ppp_facturacion.
CREATE OR REPLACE FUNCTION public.gv_ppp_resumen()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
AS $function$
declare v jsonb; v_rate numeric;
begin
  perform gv_es_admin();
  select sum(m3) / nullif(count(distinct fecha_salida),0) into v_rate
  from ppp_facturacion where left(np,1)='9' and fecha_salida >= current_date - 60 and m3 > 0;
  with backlog as (
    select pr.np, pr.cod, pr.m3, nullif(btrim(pr.tanda),'') tanda
    from ppp_programacion pr
    where pr.empresa='lk' and not exists (select 1 from ppp_facturacion f where f.np = pr.np)
  ),
  plata as (
    select sum(ppp_valor_linea(bk.cod, b.articulo, b.cajas)) monto
    from ppp_base_pedidos b join backlog bk on bk.np = b.pedido
  )
  select jsonb_build_object(
    'nps', (select count(*) from backlog),
    'm3', (select round(sum(m3),1) from backlog),
    'plata', (select round(monto) from plata),
    'm3_por_dia', round(coalesce(v_rate,0),2),
    'dias_ppp', case when v_rate > 0 then round((select sum(m3) from backlog)/v_rate,1) end,
    'con_tanda', (select count(*) from backlog where tanda is not null),
    'sin_tanda', (select count(*) from backlog where tanda is null),
    'plata_sin_tanda', (select round(sum(ppp_valor_linea(bk.cod, b.articulo, b.cajas)))
                        from ppp_base_pedidos b join backlog bk on bk.np=b.pedido where bk.tanda is null),
    'ultima_salida', (select max(fecha_salida)::text from ppp_facturacion)
  ) into v;
  return v;
end; $function$
;

CREATE OR REPLACE FUNCTION public.gv_ppp_detalle()
 RETURNS TABLE(np text, cod text, razon_social text, tanda text, m3 numeric, zona text, fecha_entrega text, plata numeric, arts bigint, etapa text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
AS $function$
begin
  perform gv_es_admin();
  return query
  select pr.np, pr.cod, pr.razon_social, nullif(btrim(pr.tanda),''), pr.m3, pr.zona, pr.fecha_entrega,
         (select round(sum(ppp_valor_linea(pr.cod, b.articulo, b.cajas))) from ppp_base_pedidos b where b.pedido = pr.np),
         (select count(*) from ppp_base_pedidos b where b.pedido = pr.np),
         coalesce((select case
            when e.carga then 'Cargado a camión'
            when e.armado_fin then 'Armado terminado'
            when e.armado_ini then 'En armado'
            when e.picking_fin then 'Picking terminado'
            when e.picking_ini then 'En picking'
            else 'Sin iniciar' end
          from ppp_etapa e where e.tanda = nullif(btrim(pr.tanda),'')), 'Sin iniciar')
  from ppp_programacion pr
  where pr.empresa='lk' and not exists (select 1 from ppp_facturacion f where f.np = pr.np)
  order by (select sum(ppp_valor_linea(pr.cod, b.articulo, b.cajas)) from ppp_base_pedidos b where b.pedido = pr.np) desc nulls last;
end; $function$
;

-- --------------------------------------------------- refresco geografico ----
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
$function$
;

-- --------------------------------------------------- generacion del dia -----
-- El tope de 2 por senal (gv_senales.tope_dia) NO es cosmetico: sin el,
-- `reactivar` se lleva las 5 todos los dias —es la senal con los montos mas
-- grandes— y el mensaje diario se vuelve una lista de morosos.
CREATE OR REPLACE FUNCTION public.gv_generar_dia(p_fecha date DEFAULT CURRENT_DATE, p_meses integer DEFAULT 12, p_forzar boolean DEFAULT false)
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
    -- Solo se rehacen las que nadie tocó por NINGUNO de los dos ejes: una
    -- opinión ya dada no se pisa.
    DELETE FROM gv_sugerencias
     WHERE fecha = p_fecha AND resultado = 'pendiente' AND utilidad = 'sin_opinion';
  END IF;

  WITH cand AS (
    -- El peso sale del eje UTILIDAD, no del resultado comercial: lo que decide
    -- qué se propone es si el usuario quiere seguir viéndolo.
    SELECT c.*, gv_peso(s.util_si + s.util_no, s.util_si) AS peso, s.tope_dia
    FROM gv_candidatos(p_meses) c
    JOIN gv_senales s ON s.tipo = c.tipo
    WHERE s.activa
  ),
  -- Silenciados: el usuario dijo explícitamente "esto no me lo traigas más",
  -- para una señal puntual (tipo) o para el cliente entero (tipo NULL).
  sin_silencio AS (
    SELECT c.* FROM cand c
    WHERE c.cod_cliente IS NULL
       OR NOT EXISTS (
            SELECT 1 FROM gv_silenciados x
            WHERE x.cod_cliente = c.cod_cliente
              AND (x.tipo IS NULL OR x.tipo = c.tipo)
              AND (x.hasta IS NULL OR x.hasta >= p_fecha)
          )
  ),
  -- No repetir la misma acción sobre el mismo cliente dentro de 30 días.
  frescos AS (
    SELECT c.* FROM sin_silencio c
    WHERE NOT EXISTS (
      SELECT 1 FROM gv_sugerencias g
      WHERE g.tipo = c.tipo
        AND COALESCE(g.cod_cliente, '') = COALESCE(c.cod_cliente, '')
        AND g.fecha > p_fecha - 30
        AND g.fecha <> p_fecha
    )
  ),
  scored AS (
    SELECT f.*, round(f.score_base * f.peso, 6) AS score_final FROM frescos f
  ),
  ranked AS (
    SELECT s.*, ROW_NUMBER() OVER (PARTITION BY s.tipo ORDER BY s.score_final DESC) AS rn
    FROM scored s
  ),
  elegidos AS (
    SELECT * FROM ranked r WHERE r.rn <= r.tope_dia ORDER BY score_final DESC LIMIT 5
  ),
  nombres AS (
    SELECT d.cod, d.nom
    FROM datos_cliente_empresa('lk', ARRAY(SELECT DISTINCT cod_cliente FROM elegidos WHERE cod_cliente IS NOT NULL)) d
  ),
  ins AS (
    INSERT INTO gv_sugerencias (fecha, tipo, cod_cliente, titulo, motivo, accion, score, payload)
    SELECT p_fecha, e.tipo, e.cod_cliente,
           CASE WHEN e.cod_cliente IS NULL THEN s.etiqueta
                ELSE COALESCE(n.nom, 'Cliente ' || e.cod_cliente) || ' (' || e.cod_cliente || ')' END,
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
$function$
;

-- ------------------------------------------------ cobertura geografica -----
-- La unidad es la LOCALIDAD, no la calle: customer_delivery_addresses tiene cp
-- cargado en 3 filas de 1583 y calle en 4.
CREATE OR REPLACE FUNCTION public.gv_cobertura(p_meses integer DEFAULT 12)
 RETURNS TABLE(provincia text, localidad text, loc_norm text, lat double precision, lon double precision, sucursales bigint, clientes bigint, activos bigint, poblacion integer, hab_por_punto numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
AS $function$BEGIN PERFORM gv_es_admin(); RETURN QUERY WITH cutoff AS (
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
  FROM  agg a
  JOIN geo_localidades g ON g.provincia = a.provincia AND g.loc_norm = a.loc_norm
  ORDER BY a.sucursales DESC, g.provincia, g.localidad; END;$function$
;

-- NO se calcula sobre gv_cobertura: esa exige localidad y 112 sucursales no la
-- tienen (92 solo en CABA), asi que el rollup subestimaba el denominador y hacia
-- ver a CABA como 1 punto cada 9.514 habitantes cuando son 7.430. Cuenta contra
-- el padron crudo y expone sin_localidad para que el faltante se vea.
-- Guard gv_es_admin_o_cron y NO gv_es_admin: la llama gv_candidatos (senal
-- zona_fria), que corre desde el cron sin JWT.
CREATE OR REPLACE FUNCTION public.gv_cobertura_provincia(p_meses integer DEFAULT 12)
 RETURNS TABLE(provincia text, sucursales bigint, clientes bigint, activos bigint, localidades bigint, sin_localidad bigint, poblacion integer, hab_por_punto numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
AS $function$BEGIN PERFORM gv_es_admin_o_cron(); RETURN QUERY WITH cutoff AS (
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
  FROM  geo_provincias p
  FULL JOIN agg a ON a.provincia = p.provincia
  ORDER BY 2 DESC; END;$function$
;

-- ------------------------------------------------------------ preguntas -----
-- El segundo canal: el agente pregunta sobre SU PROPIO comportamiento. Las
-- preguntas NO estan escritas a mano: se derivan de patrones del feedback. La
-- clave es unica para no repreguntar lo mismo todos los dias.
CREATE OR REPLACE FUNCTION public.gv_generar_preguntas()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE v_n integer;
BEGIN
  PERFORM gv_es_admin_o_cron();

  WITH nuevas AS (
    -- 1) Señal que el usuario viene marcando como no útil.
    SELECT 'apagar:' || s.tipo AS clave, 'apagar_senal' AS tipo,
           '¿Apago la señal "' || s.etiqueta || '"?' AS pregunta,
           'La marcaste como no útil ' || s.util_no || ' veces y útil ' || s.util_si ||
           '. Su peso bajó a ' || gv_peso(s.util_si + s.util_no, s.util_si) ||
           ', así que casi no aparece. Apagarla libera lugar para las otras.' AS detalle,
           jsonb_build_array(
             jsonb_build_object('valor','apagar','texto','Apagala'),
             jsonb_build_object('valor','dejar','texto','Dejala como está')) AS opciones,
           jsonb_build_object('tipo_senal', s.tipo) AS contexto
    FROM gv_senales s
    WHERE s.activa AND s.util_no >= 3
      AND gv_peso(s.util_si + s.util_no, s.util_si) < 0.35

    UNION ALL
    -- 2) Señal propuesta varias veces sobre la que nunca opinó.
    SELECT 'opinar:' || s.tipo, 'pedir_opinion',
           '¿Te sirve la señal "' || s.etiqueta || '"?',
           'Te la propuse ' || (SELECT count(*) FROM gv_sugerencias g WHERE g.tipo = s.tipo) ||
           ' veces y nunca me dijiste si te sirve, así que sigue en el peso inicial de 0,50. ' ||
           'Con una respuesta puedo priorizarla mejor.',
           jsonb_build_array(
             jsonb_build_object('valor','util','texto','Me sirve'),
             jsonb_build_object('valor','no_util','texto','No me sirve'),
             jsonb_build_object('valor','dejar','texto','Después veo')),
           jsonb_build_object('tipo_senal', s.tipo)
    FROM gv_senales s
    WHERE s.activa AND s.util_si + s.util_no = 0
      AND (SELECT count(*) FROM gv_sugerencias g WHERE g.tipo = s.tipo) >= 5

    UNION ALL
    -- 3) Señal que viene convirtiendo bien: ofrecer traer más por día.
    SELECT 'mas:' || s.tipo, 'subir_tope',
           '"' || s.etiqueta || '" viene convirtiendo bien. ¿Traigo más por día?',
           'De ' || s.acc_trab || ' acciones trabajadas se concretaron ' || s.acc_ganadas ||
           '. Hoy te traigo hasta ' || s.tope_dia || ' por día de esta señal.',
           jsonb_build_array(
             jsonb_build_object('valor','subir','texto','Sí, traeme más'),
             jsonb_build_object('valor','dejar','texto','Así está bien')),
           jsonb_build_object('tipo_senal', s.tipo)
    FROM gv_senales s
    WHERE s.activa AND s.acc_trab >= 4 AND s.tope_dia < 4
      AND s.acc_ganadas::numeric / NULLIF(s.acc_trab, 0) >= 0.5

    UNION ALL
    -- 4) Cliente que ya descartaste más de una vez.
    SELECT 'silenciar:' || g.cod_cliente, 'silenciar_cliente',
           '¿Saco a ' || max(g.titulo) || ' del radar?',
           'Marcaste como "no me sirve" ' || count(*) ||
           ' sugerencias sobre este cliente. Puedo dejar de proponerlo.',
           jsonb_build_array(
             jsonb_build_object('valor','silenciar','texto','Sacalo del radar'),
             jsonb_build_object('valor','dejar','texto','Seguí proponiéndolo')),
           jsonb_build_object('cod_cliente', g.cod_cliente)
    FROM gv_sugerencias g
    WHERE g.utilidad = 'no_util' AND g.cod_cliente IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM gv_silenciados x WHERE x.cod_cliente = g.cod_cliente AND x.tipo IS NULL)
    GROUP BY g.cod_cliente
    HAVING count(*) >= 2
  ),
  ins AS (
    INSERT INTO gv_preguntas (clave, tipo, pregunta, detalle, opciones, contexto)
    SELECT clave, tipo, pregunta, detalle, opciones, contexto FROM nuevas
    ON CONFLICT (clave) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_n FROM ins;

  RETURN v_n;
END;
$function$
;

-- ----------------------------------------------------------- rendimiento ----
-- Compara TRABAJADAS contra NO TRABAJADAS. No es un experimento controlado
-- —nadie asigno al azar— pero es la referencia honesta: si los clientes
-- trabajados no compran mas que los ignorados, el modulo no aporta.
CREATE OR REPLACE FUNCTION public.gv_rendimiento(p_dias integer DEFAULT 90)
 RETURNS TABLE(tipo text, etiqueta text, propuestas bigint, trabajadas bigint, ganadas bigint, compraron_trab bigint, compraron_no_trab bigint, no_trabajadas bigint, monto_post numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
AS $function$
BEGIN
  PERFORM gv_es_admin();
  RETURN QUERY
  WITH wd AS (
    SELECT COALESCE((SELECT (value)::numeric FROM app_settings WHERE key = 'web_order_discount'), 0.02) AS d
  ),
  base AS (
    SELECT g.id, g.tipo, g.fecha, g.cod_cliente,
           (g.resultado <> 'pendiente') AS trabajada,
           (g.resultado = 'gano') AS ganada
    FROM gv_sugerencias g
    WHERE g.cod_cliente IS NOT NULL AND g.fecha >= CURRENT_DATE - p_dias
  ),
  post AS (
    SELECT b.id, b.tipo, b.trabajada, b.ganada,
           sum(sl.boxes * COALESCE(p.uxb, 0) * COALESCE(p.list_price, 0)
               * (1 - COALESCE(c.dto_vol, 0)) * (1 - wd.d)) AS monto
    FROM base b
    LEFT JOIN sales_lines sl
      ON sl.customer_code = b.cod_cliente AND sl.empresa = 'lk'
     AND sl.invoice_date >  to_char(b.fecha, 'YYYY-MM-DD')
     AND sl.invoice_date <= to_char(b.fecha + 30, 'YYYY-MM-DD')
     AND sl.item_code <> ALL (ARRAY(SELECT item_code FROM sales_excluded_items))
    LEFT JOIN v_item_precio p on p.cod = sl.item_code
    LEFT JOIN customers c ON c.cod_cliente::text = b.cod_cliente
    CROSS JOIN wd
    GROUP BY b.id, b.tipo, b.trabajada, b.ganada
  )
  SELECT s.tipo, s.etiqueta,
         count(po.id)::bigint,
         count(*) FILTER (WHERE po.trabajada)::bigint,
         count(*) FILTER (WHERE po.ganada)::bigint,
         count(*) FILTER (WHERE po.trabajada AND COALESCE(po.monto,0) > 0)::bigint,
         count(*) FILTER (WHERE NOT po.trabajada AND COALESCE(po.monto,0) > 0)::bigint,
         count(*) FILTER (WHERE NOT po.trabajada)::bigint,
         round(COALESCE(sum(po.monto) FILTER (WHERE po.trabajada), 0))
  FROM gv_senales s
  LEFT JOIN post po ON po.tipo = s.tipo
  GROUP BY s.tipo, s.etiqueta
  HAVING count(po.id) > 0
  ORDER BY 8 DESC;
END;
$function$
;

-- --------------------------------------------------- listas de super --------
-- precios_super.cadena.usa_lista_general separa dos casos que antes se
-- confundian: una cadena sin lista propia caia en la lista general EN SILENCIO,
-- y eso mezclaba "esta bien asi" con "le falta la lista".
CREATE OR REPLACE FUNCTION public.gv_cadenas_sin_lista()
 RETURNS TABLE(super_key text, label text, cod_cliente_lk text, precios_cargados bigint, lista_fecha date, venta_12m numeric, motivo text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
AS $function$
BEGIN
  PERFORM gv_es_admin();
  RETURN QUERY
  SELECT ca.super_key, ca.label, ca.cod_cliente_lk::text,
         (SELECT count(*) FROM precios_super.precio p WHERE p.super_key = ca.super_key),
         (SELECT l.lista_fecha FROM precios_super.lista l WHERE l.super_key = ca.super_key),
         COALESCE((
           SELECT round(sum(sl.boxes * COALESCE(pr.uxb,0) * COALESCE(pr.list_price,0)
                            * (1 - COALESCE(c.dto_vol,0)) * 0.98))
           FROM sales_lines sl
           JOIN v_item_precio pr on pr.cod = sl.item_code
           LEFT JOIN customers c ON c.cod_cliente::text = ca.cod_cliente_lk::text
           WHERE sl.empresa = 'lk' AND sl.customer_code = ca.cod_cliente_lk::text
             AND sl.invoice_date > to_char(CURRENT_DATE - interval '12 months','YYYY-MM-DD')
             AND sl.item_code <> ALL (ARRAY(SELECT item_code FROM sales_excluded_items))
         ), 0),
         CASE
           WHEN (SELECT count(*) FROM precios_super.precio p WHERE p.super_key = ca.super_key) = 0
             THEN 'Necesita lista propia y no tiene ninguna cargada: se está valorizando con la lista general, que no es su precio.'
           WHEN (SELECT l.lista_fecha FROM precios_super.lista l WHERE l.super_key = ca.super_key) IS NULL
             THEN 'Tiene lista pero SIN FECHA: no se sabe de cuándo es ni si sigue vigente.'
           ELSE 'Lista con más de 10 meses.'
         END
  FROM precios_super.cadena ca
  WHERE ca.activo AND NOT ca.usa_lista_general
    AND ca.cod_cliente_lk IS NOT NULL
    AND (
      (SELECT count(*) FROM precios_super.precio p WHERE p.super_key = ca.super_key) = 0
      OR (SELECT l.lista_fecha FROM precios_super.lista l WHERE l.super_key = ca.super_key) IS NULL
      OR (SELECT l.lista_fecha FROM precios_super.lista l WHERE l.super_key = ca.super_key)
           < CURRENT_DATE - interval '10 months'
    )
  ORDER BY 6 DESC;
END;
$function$
;

-- ============================================================================
-- DASHBOARD
-- ============================================================================
-- Se calcula en TRES funciones (calcular, calcular2, extra: 4,7 + 4,6 + 2,5 s)
-- y se guarda en gv_dash_cache. Van separadas porque juntas pasarian el
-- statement_timeout de ~8 s. La pantalla lee gv_dashboard(), que solo toca el
-- cache. Las refresca el cron gerente-ventas-diario.

CREATE OR REPLACE FUNCTION public.gv_dashboard_calcular()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v jsonb;
  v_ult text;   -- último mes cerrado con datos (lk)
BEGIN
  PERFORM gv_es_admin_o_cron();

  SELECT left(max(invoice_date), 7) INTO v_ult
  FROM sales_lines WHERE empresa = 'lk';

  WITH wd AS (
    SELECT COALESCE((SELECT value::numeric FROM app_settings WHERE key='web_order_discount'), 0.02) d
  ),
  -- UNA pasada. Se agrega enseguida para que todo lo de abajo trabaje sobre
  -- pocas filas en vez de sobre las 225k.
  agg AS MATERIALIZED (
    SELECT left(sl.invoice_date,7) AS mes,
           sl.customer_code AS cod,
           COALESCE(NULLIF(btrim(p.category),''),'(sin categoría)') AS cat,
           sl.empresa,
           sum(sl.boxes * COALESCE(p.uxb,0) * COALESCE(p.list_price,0)
               * (1 - COALESCE(c.dto_vol,0)) * (1 - wd.d)) AS monto,
           count(DISTINCT sl.invoice_date) AS pedidos
    FROM sales_lines sl
    JOIN v_item_precio p ON p.cod = sl.item_code
    LEFT JOIN customers c ON c.cod_cliente::text = sl.customer_code
    CROSS JOIN wd
    WHERE sl.invoice_date >= to_char(CURRENT_DATE - interval '72 months','YYYY-MM-DD')
      AND sl.customer_code NOT IN ('1','3878')
      AND sl.item_code <> ALL (ARRAY(SELECT item_code FROM sales_excluded_items))
    GROUP BY 1,2,3,4
  ),
  -- Los pedidos NO se pueden sumar desde agg: está abierto por categoría, así
  -- que un pedido con 5 categorías contaría 5 veces y el ticket promedio saldría
  -- dividido. Se cuentan aparte, en una pasada liviana sin joins.
  ped AS MATERIALIZED (
    SELECT left(sl.invoice_date,7) AS mes, sl.empresa,
           count(DISTINCT sl.customer_code || '|' || sl.invoice_date) AS pedidos
    FROM sales_lines sl
    WHERE sl.invoice_date >= to_char(CURRENT_DATE - interval '72 months','YYYY-MM-DD')
      AND sl.customer_code NOT IN ('1','3878')
      AND sl.item_code <> ALL (ARRAY(SELECT item_code FROM sales_excluded_items))
    GROUP BY 1,2
  ),
  mes_lk AS (
    SELECT a.mes, sum(a.monto) monto, count(DISTINCT a.cod) clientes,
           max(pd.pedidos) pedidos
    FROM agg a
    LEFT JOIN ped pd ON pd.mes = a.mes AND pd.empresa = 'lk'
    WHERE a.empresa='lk' GROUP BY a.mes
  ),
  mes_ch AS (SELECT mes, sum(monto) monto FROM agg WHERE empresa='chef' GROUP BY 1),
  web_mes AS (
    SELECT to_char(created_at,'YYYY-MM') mes, sum(total) monto,
           count(*) pedidos, count(DISTINCT customer_id) clientes
    FROM orders GROUP BY 1
  ),
  -- 1+2+3+4) Tarjetas del último mes cerrado
  resumen AS (
    SELECT jsonb_build_object(
      'mes', v_ult,
      'facturado',      (SELECT monto    FROM mes_lk WHERE mes = v_ult),
      'facturado_ant',  (SELECT monto    FROM mes_lk WHERE mes = to_char((v_ult||'-01')::date - interval '1 month','YYYY-MM')),
      'facturado_aa',   (SELECT monto    FROM mes_lk WHERE mes = to_char((v_ult||'-01')::date - interval '12 months','YYYY-MM')),
      'clientes',       (SELECT clientes FROM mes_lk WHERE mes = v_ult),
      'clientes_prom12',(SELECT round(avg(clientes)) FROM mes_lk WHERE mes < v_ult AND mes >= to_char((v_ult||'-01')::date - interval '12 months','YYYY-MM')),
      'pedidos',        (SELECT pedidos  FROM mes_lk WHERE mes = v_ult),
      'ticket',         (SELECT round(monto/NULLIF(pedidos,0)) FROM mes_lk WHERE mes = v_ult),
      'ticket_aa',      (SELECT round(monto/NULLIF(pedidos,0)) FROM mes_lk WHERE mes = to_char((v_ult||'-01')::date - interval '12 months','YYYY-MM')),
      'acum_anio',      (SELECT sum(monto) FROM mes_lk WHERE left(mes,4) = left(v_ult,4)),
      'acum_anio_ant',  (SELECT sum(monto) FROM mes_lk WHERE left(mes,4) = (left(v_ult,4)::int - 1)::text AND mes <= to_char((v_ult||'-01')::date - interval '12 months','YYYY-MM'))
    ) j
  ),
  -- 5) Pulso del mes en curso, del portal (en vivo)
  curso AS (
    SELECT jsonb_build_object(
      'mes', to_char(CURRENT_DATE,'YYYY-MM'),
      'dia', extract(day FROM CURRENT_DATE)::int,
      'monto',    (SELECT monto    FROM web_mes WHERE mes = to_char(CURRENT_DATE,'YYYY-MM')),
      'pedidos',  (SELECT pedidos  FROM web_mes WHERE mes = to_char(CURRENT_DATE,'YYYY-MM')),
      'clientes', (SELECT clientes FROM web_mes WHERE mes = to_char(CURRENT_DATE,'YYYY-MM')),
      -- Mismo tramo del mes anterior, para que la comparación sea justa
      'monto_ant_mismo_tramo', (
        SELECT sum(total) FROM orders
        WHERE to_char(created_at,'YYYY-MM') = to_char(CURRENT_DATE - interval '1 month','YYYY-MM')
          AND extract(day FROM created_at) <= extract(day FROM CURRENT_DATE))
    ) j
  ),
  -- 6) Serie mensual 36 meses, las tres métricas juntas
  serie AS (
    SELECT jsonb_agg(jsonb_build_object(
             'mes', m.mes, 'lk', round(COALESCE(l.monto,0)),
             'chef', round(COALESCE(c.monto,0)), 'web', round(COALESCE(w.monto,0))
           ) ORDER BY m.mes) j
    FROM (SELECT DISTINCT mes FROM agg
          WHERE mes >= to_char(CURRENT_DATE - interval '36 months','YYYY-MM')) m
    LEFT JOIN mes_lk l ON l.mes = m.mes
    LEFT JOIN mes_ch c ON c.mes = m.mes
    LEFT JOIN web_mes w ON w.mes = m.mes
  ),
  -- 7) Estacionalidad: el mismo mes calendario en los últimos 6 años
  estac AS (
    SELECT jsonb_agg(jsonb_build_object('mes', mes, 'monto', round(monto)) ORDER BY mes) j
    FROM mes_lk WHERE right(mes,2) = right(v_ult,2)
  ),
  -- 8) Altas y bajas. Alta = primera compra de su historia en ese mes.
  --    Baja = su ÚLTIMA compra cayó en ese mes y ya pasaron 6 meses.
  primera AS (SELECT cod, min(mes) mes FROM agg WHERE empresa='lk' GROUP BY 1),
  ultima  AS (SELECT cod, max(mes) mes FROM agg WHERE empresa='lk' GROUP BY 1),
  altas_bajas AS (
    SELECT jsonb_agg(jsonb_build_object('mes', m.mes,
             'altas', COALESCE(a.n,0), 'bajas', COALESCE(b.n,0)) ORDER BY m.mes) j
    FROM (SELECT DISTINCT mes FROM mes_lk
          WHERE mes >= to_char(CURRENT_DATE - interval '24 months','YYYY-MM')) m
    LEFT JOIN (SELECT mes, count(*) n FROM primera GROUP BY 1) a ON a.mes = m.mes
    LEFT JOIN (SELECT mes, count(*) n FROM ultima
               WHERE mes <= to_char(CURRENT_DATE - interval '6 months','YYYY-MM')
               GROUP BY 1) b ON b.mes = m.mes
  ),
  -- 9) Concentración de la cartera (últimos 12 meses)
  cli12 AS (
    SELECT cod, sum(monto) monto FROM agg
    WHERE empresa='lk' AND mes > to_char(CURRENT_DATE - interval '12 months','YYYY-MM')
    GROUP BY 1
  ),
  conc AS (
    SELECT jsonb_build_object(
      'clientes', (SELECT count(*) FROM cli12),
      'total',    (SELECT round(sum(monto)) FROM cli12),
      'top10',    (SELECT round(sum(monto)) FROM (SELECT monto FROM cli12 ORDER BY monto DESC LIMIT 10) t),
      'top20',    (SELECT round(sum(monto)) FROM (SELECT monto FROM cli12 ORDER BY monto DESC LIMIT 20) t)
    ) j
  )
  SELECT jsonb_build_object(
    'resumen', (SELECT j FROM resumen),
    'curso',   (SELECT j FROM curso),
    'serie',   (SELECT j FROM serie),
    'estacionalidad', (SELECT j FROM estac),
    'altas_bajas', (SELECT j FROM altas_bajas),
    'concentracion', (SELECT j FROM conc)
  ) INTO v;

  INSERT INTO gv_dash_cache (id, data, generado_at) VALUES (1, v, now())
  ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, generado_at = EXCLUDED.generado_at;

  RETURN v;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.gv_dashboard_calcular2()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE v jsonb;
BEGIN
  PERFORM gv_es_admin_o_cron();

  WITH wd AS (
    SELECT COALESCE((SELECT value::numeric FROM app_settings WHERE key='web_order_discount'),0.02) d
  ),
  -- Últimos 24 meses partidos en dos ventanas de 12, para el interanual.
  agg AS MATERIALIZED (
    SELECT sl.customer_code AS cod,
           COALESCE(NULLIF(btrim(p.category),''),'(sin categoría)') AS cat,
           (sl.invoice_date > to_char(CURRENT_DATE - interval '12 months','YYYY-MM-DD')) AS reciente,
           sum(sl.boxes * COALESCE(p.uxb,0) * COALESCE(p.list_price,0)
               * (1 - COALESCE(c.dto_vol,0)) * (1 - wd.d)) AS monto
    FROM sales_lines sl
    JOIN v_item_precio p ON p.cod = sl.item_code
    LEFT JOIN customers c ON c.cod_cliente::text = sl.customer_code
    CROSS JOIN wd
    WHERE sl.empresa='lk'
      AND sl.invoice_date > to_char(CURRENT_DATE - interval '24 months','YYYY-MM-DD')
      AND sl.customer_code NOT IN ('1','3878')
      AND sl.item_code <> ALL (ARRAY(SELECT item_code FROM sales_excluded_items))
    GROUP BY 1,2,3
  ),
  -- 10) Mix por categoría e interanual
  cats AS (
    SELECT jsonb_agg(x ORDER BY (x->>'ahora')::numeric DESC) j FROM (
      SELECT jsonb_build_object('cat', cat,
               'ahora', round(sum(monto) FILTER (WHERE reciente)),
               'antes', round(sum(monto) FILTER (WHERE NOT reciente))) x
      FROM agg GROUP BY cat
      HAVING sum(monto) FILTER (WHERE reciente) > 0
    ) t
  ),
  -- 13) Los que más crecieron y los que más cayeron, en pesos
  porcli AS (
    SELECT cod, sum(monto) FILTER (WHERE reciente) ahora,
                sum(monto) FILTER (WHERE NOT reciente) antes
    FROM agg GROUP BY cod
  ),
  nom AS (SELECT d.cod, d.nom FROM datos_cliente_empresa('lk') d),
  var AS (
    SELECT p.cod, COALESCE(n.nom, 'Cliente '||p.cod) nom,
           COALESCE(p.ahora,0) - COALESCE(p.antes,0) dif,
           COALESCE(p.ahora,0) ahora, COALESCE(p.antes,0) antes
    FROM porcli p LEFT JOIN nom n ON n.cod = p.cod
    WHERE COALESCE(p.ahora,0) + COALESCE(p.antes,0) > 0
  ),
  top_var AS (
    SELECT jsonb_build_object(
      'suben', (SELECT jsonb_agg(jsonb_build_object('cod',cod,'nom',nom,'dif',round(dif),
                        'ahora',round(ahora),'antes',round(antes)) ORDER BY dif DESC)
                FROM (SELECT * FROM var ORDER BY dif DESC LIMIT 10) t),
      'bajan', (SELECT jsonb_agg(jsonb_build_object('cod',cod,'nom',nom,'dif',round(dif),
                        'ahora',round(ahora),'antes',round(antes)) ORDER BY dif ASC)
                FROM (SELECT * FROM var ORDER BY dif ASC LIMIT 10) t)
    ) j
  ),
  -- 12) Por vendedor
  vend AS (
    SELECT jsonb_agg(x ORDER BY (x->>'ahora')::numeric DESC) j FROM (
      SELECT jsonb_build_object('vendedor', v.vendedor,
               'clientes', count(*), 'activos', count(*) FILTER (WHERE v.ahora > 0),
               'ahora', round(sum(v.ahora)), 'antes', round(sum(v.antes))) x
      FROM (SELECT var.*, gv_vendedor_de(var.cod) vendedor FROM var) v
      WHERE v.vendedor IS NOT NULL
      GROUP BY v.vendedor
    ) t
  ),
  -- 14) Medio de pago y descuento resignado (plata real del portal).
  --     Los medios vienen sucios del ERP: las filas tipo "075 - 075 DIAS SIN DPP
  --     NRO EXPEDICIÓN: 45438726" llevan el numero adentro, asi que son UNA POR
  --     PEDIDO y ensuciaban el mix con decenas de categorias de un pedido cada
  --     una. Se agrupan con el ~ 'NRO EXPEDICI' (de 38 etiquetas a 23).
  pagos AS (
    SELECT jsonb_agg(jsonb_build_object('medio', COALESCE(payment_method,'(sin dato)'),
             'pedidos', n, 'monto', round(monto), 'dto_medio', round(dto)) ORDER BY monto DESC) j
    FROM (
      SELECT CASE
               WHEN payment_method ~ 'NRO EXPEDICI' THEN 'Condición ERP (a plazo)'
               WHEN btrim(COALESCE(payment_method,'')) IN ('', ':', 'TEST') THEN '(sin dato)'
               ELSE payment_method END AS payment_method,
             count(*) n, sum(total) monto,
             sum(COALESCE(subtotal,0) - COALESCE(total,0)) dto
      FROM orders WHERE created_at >= CURRENT_DATE - 365
      GROUP BY 1
    ) t
  ),
  -- 15) Clientes que compran pero están mal en el BCRA (situación 3 o peor)
  riesgo AS (
    SELECT jsonb_build_object(
      'clientes', count(*), 'monto', round(sum(v.ahora))
    ) j
    FROM var v
    JOIN customers c ON c.cod_cliente::text = v.cod
    JOIN bcra_situacion b ON regexp_replace(COALESCE(c.cuit,''),'[^0-9]','','g') = regexp_replace(b.cuit,'[^0-9]','','g')
    WHERE v.ahora > 0 AND b.situacion IS NOT NULL AND b.situacion::int >= 3
  ),
  -- 11) Resumen geográfico (el mapa detallado ya vive en su propia tarjeta)
  geo AS (
    SELECT jsonb_build_object(
      'provincias', (SELECT count(DISTINCT btrim(provincia)) FROM customer_delivery_addresses WHERE NULLIF(btrim(provincia),'') IS NOT NULL),
      'sucursales', (SELECT count(*) FROM customer_delivery_addresses),
      'localidades',(SELECT count(*) FROM geo_localidades)
    ) j
  )
  SELECT jsonb_build_object(
    'categorias', (SELECT j FROM cats),
    'top_var',    (SELECT j FROM top_var),
    'vendedores', (SELECT j FROM vend),
    'medios_pago',(SELECT j FROM pagos),
    'riesgo',     (SELECT j FROM riesgo),
    'geo',        (SELECT j FROM geo)
  ) INTO v;

  UPDATE gv_dash_cache SET data = data || v, generado_at = now() WHERE id = 1;
  RETURN v;
END;
$function$
;

-- Trae proyeccion de cierre de año (con estacionalidad), ranking de productos
-- que crecen/caen, y fuga temprana (cliente a 1,2x-2x su ritmo, ANTES del
-- umbral de ritmo_caido).
CREATE OR REPLACE FUNCTION public.gv_dashboard_extra()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE v jsonb; v_ult text;
BEGIN
  PERFORM gv_es_admin_o_cron();
  SELECT left(max(invoice_date),7) INTO v_ult FROM sales_lines WHERE empresa='lk';

  WITH wd AS (SELECT 0.98 f),
  -- Serie mensual lk para la proyección.
  mes_lk AS (
    SELECT left(sl.invoice_date,7) mes,
           sum(sl.boxes*COALESCE(p.uxb,0)*COALESCE(p.list_price,0)*(1-COALESCE(c.dto_vol,0))*wd.f) monto
    FROM sales_lines sl JOIN v_item_precio p ON p.cod=sl.item_code
    LEFT JOIN customers c ON c.cod_cliente::text=sl.customer_code CROSS JOIN wd
    WHERE sl.empresa='lk' AND sl.invoice_date >= to_char(CURRENT_DATE - interval '24 months','YYYY-MM-DD')
      AND sl.customer_code NOT IN ('1','3878')
      AND sl.item_code <> ALL (ARRAY(SELECT item_code FROM sales_excluded_items))
    GROUP BY 1
  ),
  proy AS (
    SELECT jsonb_build_object(
      'anio', left(v_ult,4),
      'meses_cerrados', (SELECT count(*) FROM mes_lk WHERE left(mes,4)=left(v_ult,4)),
      'acum', (SELECT round(sum(monto)) FROM mes_lk WHERE left(mes,4)=left(v_ult,4)),
      -- Proyección: lo que va del año, escalado por cómo cerró el año pasado el
      -- mismo tramo vs su total. Respeta la estacionalidad en vez de multiplicar
      -- por 12/meses (que asume ventas planas).
      'proyeccion', (
        SELECT round(
          (SELECT sum(monto) FROM mes_lk WHERE left(mes,4)=left(v_ult,4))
          / NULLIF((SELECT sum(monto) FROM mes_lk
                    WHERE left(mes,4)=(left(v_ult,4)::int-1)::text
                      AND right(mes,2) <= right(v_ult,2)),0)
          * (SELECT sum(monto) FROM mes_lk WHERE left(mes,4)=(left(v_ult,4)::int-1)::text))),
      'total_anio_ant', (SELECT round(sum(monto)) FROM mes_lk WHERE left(mes,4)=(left(v_ult,4)::int-1)::text)
    ) j
  ),
  -- Productos: últimos 12m vs los 12 previos, por pesos.
  prod AS (
    SELECT sl.item_code cod, COALESCE(p.description,sl.item_code) desc_,
           (sl.invoice_date > to_char(CURRENT_DATE - interval '12 months','YYYY-MM-DD')) reciente,
           sum(sl.boxes*COALESCE(p.uxb,0)*COALESCE(p.list_price,0)*wd.f) monto
    FROM sales_lines sl JOIN v_item_precio p ON p.cod=sl.item_code CROSS JOIN wd
    WHERE sl.empresa='lk' AND sl.invoice_date > to_char(CURRENT_DATE - interval '24 months','YYYY-MM-DD')
      AND sl.customer_code NOT IN ('1','3878')
      AND sl.item_code <> ALL (ARRAY(SELECT item_code FROM sales_excluded_items))
    GROUP BY 1,2,3
  ),
  prod_var AS (
    SELECT cod, max(desc_) desc_,
           sum(monto) FILTER (WHERE reciente) ahora,
           sum(monto) FILTER (WHERE NOT reciente) antes
    FROM prod GROUP BY cod
  ),
  productos AS (
    SELECT jsonb_build_object(
      'suben', (SELECT jsonb_agg(jsonb_build_object('cod',cod,'desc',desc_,
                  'dif',round(COALESCE(ahora,0)-COALESCE(antes,0)),
                  'ahora',round(COALESCE(ahora,0)),'antes',round(COALESCE(antes,0))) ORDER BY COALESCE(ahora,0)-COALESCE(antes,0) DESC)
                FROM (SELECT * FROM prod_var ORDER BY COALESCE(ahora,0)-COALESCE(antes,0) DESC LIMIT 10) t),
      'bajan', (SELECT jsonb_agg(jsonb_build_object('cod',cod,'desc',desc_,
                  'dif',round(COALESCE(ahora,0)-COALESCE(antes,0)),
                  'ahora',round(COALESCE(ahora,0)),'antes',round(COALESCE(antes,0))) ORDER BY COALESCE(ahora,0)-COALESCE(antes,0) ASC)
                FROM (SELECT * FROM prod_var WHERE antes > 0 ORDER BY COALESCE(ahora,0)-COALESCE(antes,0) ASC LIMIT 10) t)
    ) j
  ),
  -- Fuga temprana: cliente que se pasó 1,2×-2× su intervalo habitual (antes del
  -- umbral 2× que dispara ritmo_caido). Es el aviso ANTES de que se enfríe.
  fechas AS (
    SELECT sl.customer_code cod, sl.invoice_date::date d
    FROM sales_lines sl
    WHERE sl.empresa='lk' AND sl.customer_code NOT IN ('1','3878')
      AND sl.invoice_date >= to_char(CURRENT_DATE - interval '24 months','YYYY-MM-DD')
      AND sl.item_code <> ALL (ARRAY(SELECT item_code FROM sales_excluded_items))
    GROUP BY 1,2
  ),
  brechas AS (SELECT cod, d - lag(d) OVER (PARTITION BY cod ORDER BY d) dias FROM fechas),
  ritmo AS (
    SELECT b.cod, (percentile_cont(0.5) WITHIN GROUP (ORDER BY b.dias))::numeric mediana, max(f.ult) ult
    FROM brechas b JOIN (SELECT cod, max(d) ult FROM fechas GROUP BY 1) f ON f.cod=b.cod
    WHERE b.dias IS NOT NULL GROUP BY b.cod HAVING count(*) >= 3
  ),
  fuga AS (
    SELECT jsonb_build_object(
      'clientes', count(*),
      'lista', (SELECT jsonb_agg(jsonb_build_object('cod',cod,'nom',nom,'mediana',md,'dias',dd) ORDER BY dd DESC)
                FROM (
                  SELECT r.cod, COALESCE(c.business_name,'Cliente '||r.cod) nom,
                         round(r.mediana) md, (CURRENT_DATE - r.ult) dd
                  FROM ritmo r LEFT JOIN customers c ON c.cod_cliente::text=r.cod
                  WHERE r.mediana >= 15
                    AND (CURRENT_DATE - r.ult) BETWEEN (1.2*r.mediana)::int AND (2*r.mediana)::int
                  ORDER BY (CURRENT_DATE - r.ult) DESC LIMIT 15) t)
    ) j
    FROM ritmo r WHERE r.mediana >= 15
      AND (CURRENT_DATE - r.ult) BETWEEN (1.2*r.mediana)::int AND (2*r.mediana)::int
  )
  SELECT jsonb_build_object(
    'proyeccion', (SELECT j FROM proy),
    'productos',  (SELECT j FROM productos),
    'fuga',       (SELECT j FROM fuga)
  ) INTO v;

  UPDATE gv_dash_cache SET data = data || v, generado_at = now() WHERE id = 1;
  RETURN v;
END;
$function$
;

-- Drill-down del dashboard: de mes -> clientes -> pedidos -> lineas, mas los
-- cortes por categoria, vendedor y producto.
CREATE OR REPLACE FUNCTION public.gv_drill(p_nivel text, p_mes text DEFAULT NULL::text, p_cod text DEFAULT NULL::text, p_fecha text DEFAULT NULL::text)
 RETURNS TABLE(clave text, titulo text, subtitulo text, cajas numeric, unidades numeric, monto numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
AS $function$
DECLARE
  v_d numeric;
BEGIN
  PERFORM gv_es_admin();
  SELECT COALESCE((SELECT value::numeric FROM app_settings WHERE key='web_order_discount'),0.02)
    INTO v_d;

  IF p_nivel = 'clientes' THEN
    RETURN QUERY
    SELECT sl.customer_code,
           COALESCE(c.business_name, 'Cliente ' || sl.customer_code),
           count(DISTINCT sl.invoice_date)::text || ' pedidos · ' ||
             count(DISTINCT sl.item_code)::text || ' artículos',
           sum(sl.boxes)::numeric,
           sum(sl.boxes * COALESCE(p.uxb,0))::numeric,
           round(sum(sl.boxes * COALESCE(p.uxb,0) * COALESCE(p.list_price,0)
                     * (1 - COALESCE(c.dto_vol,0)) * (1 - v_d)))
    FROM sales_lines sl
    JOIN v_item_precio p ON p.cod = sl.item_code
    LEFT JOIN customers c ON c.cod_cliente::text = sl.customer_code
    WHERE sl.empresa='lk' AND left(sl.invoice_date,7) = p_mes
      AND sl.customer_code NOT IN ('1','3878')
      AND sl.item_code <> ALL (ARRAY(SELECT item_code FROM sales_excluded_items))
    GROUP BY sl.customer_code, c.business_name
    ORDER BY 6 DESC;

  ELSIF p_nivel = 'pedidos' THEN
    RETURN QUERY
    SELECT sl.invoice_date,
           'Pedido del ' || to_char(sl.invoice_date::date, 'DD/MM/YYYY'),
           count(DISTINCT sl.item_code)::text || ' artículos',
           sum(sl.boxes)::numeric,
           sum(sl.boxes * COALESCE(p.uxb,0))::numeric,
           round(sum(sl.boxes * COALESCE(p.uxb,0) * COALESCE(p.list_price,0)
                     * (1 - COALESCE(c.dto_vol,0)) * (1 - v_d)))
    FROM sales_lines sl
    JOIN v_item_precio p ON p.cod = sl.item_code
    LEFT JOIN customers c ON c.cod_cliente::text = sl.customer_code
    WHERE sl.empresa='lk' AND sl.customer_code = p_cod
      AND (p_mes IS NULL OR left(sl.invoice_date,7) = p_mes)
      AND sl.item_code <> ALL (ARRAY(SELECT item_code FROM sales_excluded_items))
    GROUP BY sl.invoice_date
    ORDER BY 1 DESC;

  ELSIF p_nivel = 'lineas' THEN
    RETURN QUERY
    SELECT sl.item_code,
           COALESCE(p.description, sl.item_code),
           sl.boxes::text || ' cajas × ' || COALESCE(p.uxb,0)::text || ' u/caja · $' ||
             to_char(round(COALESCE(p.list_price,0)), 'FM999G999') || '/u lista' ||
             CASE WHEN COALESCE(c.dto_vol,0) > 0
                  THEN ' · dto ' || round(100*c.dto_vol)::text || '%' ELSE '' END,
           sl.boxes::numeric,
           (sl.boxes * COALESCE(p.uxb,0))::numeric,
           round(sl.boxes * COALESCE(p.uxb,0) * COALESCE(p.list_price,0)
                 * (1 - COALESCE(c.dto_vol,0)) * (1 - v_d))
    FROM sales_lines sl
    JOIN v_item_precio p ON p.cod = sl.item_code
    LEFT JOIN customers c ON c.cod_cliente::text = sl.customer_code
    WHERE sl.empresa='lk' AND sl.customer_code = p_cod AND sl.invoice_date = p_fecha
      AND sl.item_code <> ALL (ARRAY(SELECT item_code FROM sales_excluded_items))
    ORDER BY 6 DESC;

  ELSIF p_nivel = 'nps' THEN
    -- CONTEXTO, no composición: las NP abiertas del cliente. No se pueden ligar
    -- a las líneas de arriba porque sales_lines no guarda el número de NP.
    RETURN QUERY
    SELECT ot.np_number, 'NP ' || ot.np_number,
           ot.status || COALESCE(' · entrega ' || to_char(ot.fecha_entrega,'DD/MM/YYYY'), ''),
           NULL::numeric, NULL::numeric, NULL::numeric
    FROM order_tracking ot
    WHERE ot.cod_cliente::text = p_cod
    ORDER BY ot.np_number DESC;

  ELSIF p_nivel IN ('categoria', 'vendedor') THEN
    -- Clientes que componen una categoría o la cartera de un vendedor, en los
    -- últimos 12 meses. p_mes lleva la clave (nombre de categoría o vendedor).
    RETURN QUERY
    SELECT sl.customer_code,
           COALESCE(c.business_name, 'Cliente ' || sl.customer_code),
           count(DISTINCT sl.invoice_date)::text || ' pedidos',
           sum(sl.boxes)::numeric,
           sum(sl.boxes * COALESCE(p.uxb,0))::numeric,
           round(sum(sl.boxes * COALESCE(p.uxb,0) * COALESCE(p.list_price,0)
                     * (1 - COALESCE(c.dto_vol,0)) * (1 - v_d)))
    FROM sales_lines sl
    JOIN v_item_precio p ON p.cod = sl.item_code
    LEFT JOIN customers c ON c.cod_cliente::text = sl.customer_code
    WHERE sl.empresa='lk'
      AND sl.invoice_date > to_char(CURRENT_DATE - interval '12 months','YYYY-MM-DD')
      AND sl.customer_code NOT IN ('1','3878')
      AND sl.item_code <> ALL (ARRAY(SELECT item_code FROM sales_excluded_items))
      AND ( p_nivel <> 'categoria'
            OR COALESCE(NULLIF(btrim(p.category),''),'(sin categoría)') = p_mes )
      AND ( p_nivel <> 'vendedor' OR sl.customer_code IN (
              SELECT c2.cod_cliente::text
              FROM customers c2
              LEFT JOIN customer_commissions cm ON cm.cod_cliente::text = c2.cod_cliente::text
              LEFT JOIN (
                SELECT cod, lab FROM (
                  SELECT btrim(x.vend) AS cod, cc.vendor_label AS lab,
                         ROW_NUMBER() OVER (PARTITION BY btrim(x.vend)
                                            ORDER BY count(*) DESC, cc.vendor_label) rn
                  FROM customer_commissions cc
                  JOIN customers x ON x.cod_cliente = cc.cod_cliente
                  WHERE NULLIF(btrim(x.vend),'') IS NOT NULL
                    AND NULLIF(btrim(cc.vendor_label),'') IS NOT NULL
                  GROUP BY btrim(x.vend), cc.vendor_label
                ) t WHERE rn = 1
              ) vn ON vn.cod = btrim(c2.vend)
              WHERE COALESCE(NULLIF(btrim(cm.vendor_label),''), vn.lab) = p_mes
            ) )
    GROUP BY sl.customer_code, c.business_name
    ORDER BY 6 DESC;

  ELSIF p_nivel = 'lineas_prod' THEN
    -- Qué clientes compran un producto (12 meses). p_mes lleva el código.
    RETURN QUERY
    SELECT sl.customer_code,
           COALESCE(c.business_name, 'Cliente ' || sl.customer_code),
           sum(sl.boxes)::text || ' cajas · ' || count(DISTINCT sl.invoice_date)::text || ' pedidos',
           sum(sl.boxes)::numeric,
           sum(sl.boxes * COALESCE(p.uxb,0))::numeric,
           round(sum(sl.boxes * COALESCE(p.uxb,0) * COALESCE(p.list_price,0)
                     * (1 - COALESCE(c.dto_vol,0)) * (1 - v_d)))
    FROM sales_lines sl
    JOIN v_item_precio p ON p.cod = sl.item_code
    LEFT JOIN customers c ON c.cod_cliente::text = sl.customer_code
    WHERE sl.empresa='lk' AND sl.item_code = p_mes
      AND sl.invoice_date > to_char(CURRENT_DATE - interval '12 months','YYYY-MM-DD')
      AND sl.customer_code NOT IN ('1','3878')
    GROUP BY sl.customer_code, c.business_name
    ORDER BY 6 DESC;

  ELSE
    RAISE EXCEPTION 'Nivel inválido: %', p_nivel;
  END IF;
END;
$function$
;

-- ------------------------------------------------- pedidos web de Chef -----
-- Parte los pedidos web de Chef en NP de hasta 15 lineas, repartiendo por m3
-- en serpentina para que las NP queden parejas.
CREATE OR REPLACE FUNCTION public.gv_pedidos_web_np_chef(p_dias integer DEFAULT 30)
 RETURNS TABLE(empresa text, order_id bigint, np_idx integer, cod text, razon_social text, fecha_recep date, hora_recep text, direccion text, v text, condicion_pago_code text, numero_oc text, enviado_a_compras boolean, lineas integer, cajas numeric, items jsonb, arts text, m3 numeric, m3_parcial boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- Sin chequeo de `admins`: el gate es el GRANT (solo service_role). Va
  -- SECURITY DEFINER porque el user mapping del FDW `chef_db` es para `postgres`.
  return query
  with li as (
    select
      o.id as l_order_id,
      it.ord::int as linea_rn,
      coalesce(o.sheets_payload->>'cod_cliente', o.sheets_payload->>'codCliente') as l_cod,
      (o.created_at at time zone 'America/Argentina/Buenos_Aires')::date as l_fecha,
      to_char(o.created_at at time zone 'America/Argentina/Buenos_Aires', 'HH24:MI:SS') as l_hora,
      coalesce(o.sheets_payload->>'sucursal_entrega', o.sheets_payload->>'sucursalEntrega') as l_dir,
      o.sheets_payload->>'vend' as l_vend,
      coalesce(o.sheets_payload->>'condicion_pago_code', o.sheets_payload->>'condicionPagoCode') as l_cond,
      coalesce(o.sheets_payload->>'numOC', o.sheets_payload->>'numero_oc') as l_oc,
      lpad((regexp_match(it.value->>'cod_art', '\d+'))[1], 3, '0')
        || coalesce((regexp_match(it.value->>'cod_art', '[a-zA-Z]+'))[1], '') as l_art,
      nullif(coalesce(it.value->>'cajas', it.value->>'Cajas'), '')::numeric as l_cajas,
      nullif(it.value->>'uxb', '')::numeric as l_uxb
    from public.chef_orders o
    cross join lateral jsonb_array_elements(o.sheets_payload->'items')
         with ordinality as it(value, ord)
    where o.sheets_payload is not null
      and jsonb_typeof(o.sheets_payload->'items') = 'array'
      and (it.value->>'cod_art') ~ '\d'
      and (o.created_at at time zone 'America/Argentina/Buenos_Aires')::date >= current_date - p_dias
  ),
  con_m3 as (
    select li.*, vv.m3 as m3_unit,
           coalesce(li.l_cajas, 0) * coalesce(vv.m3, 0) as linea_m3
      from li
      left join virgilio.volumen_articulo vv on vv.codigo = upper(btrim(li.l_art))
  ),
  tramos as (
    select c.*, ceil(count(*) over (partition by c.l_order_id)::numeric / 15)::int as n_tramos
      from con_m3 c
  ),
  orden as (
    select t.*, row_number() over (partition by t.l_order_id
                                   order by t.linea_m3 desc, t.linea_rn) as rk
      from tramos t
  ),
  part as (
    select o.*,
           (case when ((o.rk - 1) % (2 * o.n_tramos)) < o.n_tramos
                 then ((o.rk - 1) % (2 * o.n_tramos)) + 1
                 else 2 * o.n_tramos - ((o.rk - 1) % (2 * o.n_tramos))
            end)::int as l_np_idx
      from orden o
  )
  select
    'chef'::text, p.l_order_id, p.l_np_idx, min(p.l_cod), min(cp.business_name),
    min(p.l_fecha), min(p.l_hora), min(p.l_dir), min(p.l_vend), min(p.l_cond),
    min(p.l_oc), null::boolean, count(*)::int, sum(p.l_cajas),
    jsonb_agg(jsonb_build_object('art', p.l_art, 'cajas', p.l_cajas, 'uxb', p.l_uxb,
                                 'uni', coalesce(p.l_cajas,0) * coalesce(p.l_uxb,0))
              order by p.linea_rn),
    string_agg(p.l_art, ',' order by p.linea_rn),
    round(sum(p.linea_m3)::numeric, 3),
    bool_or(p.m3_unit is null)
  from part p
  left join public.chef_padron cp on cp.cod_cliente = p.l_cod
  group by p.l_order_id, p.l_np_idx;
end
$function$
;

-- ============================================================================
-- EL MOTOR DE SENALES
-- ============================================================================
-- NUEVE senales con score 0..1 dentro de cada una. Cuesta ~2.064 ms contra el
-- statement_timeout de ~8 s: es lo mas caro del modulo. Corre una vez por dia
-- desde el cron gerente-ventas-diario (10:30 UTC), despues de
-- sincronizar-chef-diario porque chef_activo_lk_frio lee el padron de Chef.
--
-- Bajo de 4.135 ms a 2.064 ms consolidando los escaneos de categorias en un
-- solo cat_rec que sirve a DOS senales (categoria_perdida y una_sola_linea).
--
-- NO meter sales_lines en un CTE compartido entre senales: se materializa
-- (189k filas) y cada uso pasa a seq scan. Mismo problema ya documentado para
-- get_ranking_inactivos.
--
-- Cada candidato devuelve `evidencia` en el payload: los 2-3 numeros crudos que
-- lo dispararon, para que la sugerencia se pueda DISCUTIR en vez de tener que
-- creerle a una frase.
--
-- cat_prev y cat_rec joinean `products` y NO v_item_precio a proposito: usan
-- `category`, que es catalogo, y no valorizan nada.

CREATE OR REPLACE FUNCTION public.gv_candidatos(p_meses integer DEFAULT 12)
 RETURNS TABLE(tipo text, cod_cliente text, motivo text, accion text, score_base numeric, payload jsonb)
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
WITH
corte AS (SELECT to_char(CURRENT_DATE - (p_meses || ' months')::interval, 'YYYY-MM-DD') AS c),

react AS (
  SELECT e.cod_cliente, e.last_date, e.total_historico
  FROM get_ranking_inactivos_export(p_meses, false) e
  WHERE e.total_historico > 0
  ORDER BY e.total_historico DESC LIMIT 20
),
react_c AS (
  SELECT 'reactivar'::text AS tipo, r.cod_cliente,
         'Dejó de comprar el ' || to_char(r.last_date, 'DD/MM/YYYY') ||
           ' (' || (CURRENT_DATE - r.last_date) || ' días) y venía dejando $' ||
           to_char(round(r.total_historico), 'FM999G999G999') || ' de valor histórico.' AS motivo,
         'Llamarlo para entender por qué se fue y ofrecerle una recompra con el descuento web.'::text AS accion,
         round(r.total_historico / NULLIF(max(r.total_historico) OVER (), 0), 4) AS score_base,
         jsonb_build_object('evidencia', jsonb_build_array(
             jsonb_build_object('k','Última compra','v', to_char(r.last_date,'DD/MM/YYYY')),
             jsonb_build_object('k','Días sin comprar','v', (CURRENT_DATE - r.last_date)::text),
             jsonb_build_object('k','Valor histórico','v','$' || to_char(round(r.total_historico),'FM999G999G999')))) AS payload
  FROM react r
),

-- Un solo escaneo de fechas alimenta ritmo_caido y sin_segunda.
fechas AS (
  SELECT sl.customer_code AS cod, sl.invoice_date::date AS d
  FROM sales_lines sl
  WHERE sl.empresa = 'lk' AND sl.customer_code IS NOT NULL
    AND sl.customer_code NOT IN ('1','3878') AND sl.invoice_date IS NOT NULL
    AND sl.invoice_date >= to_char(CURRENT_DATE - interval '30 months','YYYY-MM-DD')
    AND sl.item_code <> ALL (ARRAY(SELECT item_code FROM sales_excluded_items))
  GROUP BY 1,2
),
brechas AS (SELECT cod, d - lag(d) OVER (PARTITION BY cod ORDER BY d) AS dias FROM fechas),
ritmo AS (
  SELECT b.cod, (percentile_cont(0.5) WITHIN GROUP (ORDER BY b.dias))::numeric AS mediana,
         max(f.ult) AS ult
  FROM brechas b JOIN (SELECT cod, max(d) AS ult FROM fechas GROUP BY 1) f ON f.cod = b.cod
  WHERE b.dias IS NOT NULL GROUP BY b.cod HAVING count(*) >= 3
),
ritmo_c AS (
  SELECT 'ritmo_caido'::text, r.cod,
         'Compraba cada ' || round(r.mediana)::text || ' días y hace ' || (CURRENT_DATE - r.ult) ||
           ' que no aparece: va ' || round((CURRENT_DATE - r.ult)/NULLIF(r.mediana,0),1)::text || '× su ritmo normal.',
         'Contactarlo ahora, antes de que se enfríe del todo. Todavía está en carrera.'::text,
         gv_score_suave((CURRENT_DATE - r.ult)/NULLIF(r.mediana,0) - 2, 4),
         jsonb_build_object('evidencia', jsonb_build_array(
             jsonb_build_object('k','Compra cada','v', round(r.mediana)::text || ' días'),
             jsonb_build_object('k','Hace','v',(CURRENT_DATE - r.ult)::text || ' días'),
             jsonb_build_object('k','Última compra','v', to_char(r.ult,'DD/MM/YYYY'))))
  FROM ritmo r, corte
  WHERE r.mediana >= 15 AND (CURRENT_DATE - r.ult) > 2*r.mediana
    AND to_char(r.ult,'YYYY-MM-DD') >= corte.c
  ORDER BY ((CURRENT_DATE - r.ult)/NULLIF(r.mediana,0)) DESC LIMIT 20
),

-- NUEVA: compró una sola vez, hace entre 60 y 180 días.
sin_segunda_c AS (
  SELECT 'sin_segunda'::text, f.cod,
         'Compró una sola vez, el ' || to_char(min(f.d),'DD/MM/YYYY') || ' (hace ' ||
           (CURRENT_DATE - min(f.d)) || ' días), y no volvió.',
         'Llamarlo mientras todavía nos tiene presentes. Preguntar qué le faltó de la primera compra.'::text,
         -- Cuanto más reciente, más chance de recuperarlo: el score baja con los días.
         gv_score_suave(180 - (CURRENT_DATE - min(f.d)), 60),
         jsonb_build_object('evidencia', jsonb_build_array(
             jsonb_build_object('k','Única compra','v', to_char(min(f.d),'DD/MM/YYYY')),
             jsonb_build_object('k','Hace','v',(CURRENT_DATE - min(f.d))::text || ' días')))
  FROM fechas f
  GROUP BY f.cod
  HAVING count(*) = 1
     AND (CURRENT_DATE - min(f.d)) BETWEEN 60 AND 180
  ORDER BY min(f.d) DESC LIMIT 15
),

-- NUEVA: mismo ritmo, la mitad de volumen. Un solo escaneo con FILTER.
-- Es la fuga que no aparece en ningún ranking.
vol AS (
  SELECT sl.customer_code AS cod,
         sum(sl.boxes) FILTER (WHERE sl.invoice_date >= to_char(CURRENT_DATE - interval '6 months','YYYY-MM-DD'))::numeric AS cj_rec,
         count(DISTINCT sl.invoice_date) FILTER (WHERE sl.invoice_date >= to_char(CURRENT_DATE - interval '6 months','YYYY-MM-DD')) AS ped_rec,
         sum(sl.boxes) FILTER (WHERE sl.invoice_date < to_char(CURRENT_DATE - interval '6 months','YYYY-MM-DD'))::numeric AS cj_ant,
         count(DISTINCT sl.invoice_date) FILTER (WHERE sl.invoice_date < to_char(CURRENT_DATE - interval '6 months','YYYY-MM-DD')) AS ped_ant
  FROM sales_lines sl
  WHERE sl.empresa = 'lk' AND sl.customer_code NOT IN ('1','3878')
    AND sl.invoice_date >= to_char(CURRENT_DATE - interval '24 months','YYYY-MM-DD')
    AND sl.item_code <> ALL (ARRAY(SELECT item_code FROM sales_excluded_items))
  GROUP BY 1
),
ticket_c AS (
  SELECT 'ticket_bajo'::text, v.cod,
         'Su pedido promedio pasó de ' || round(v.cj_ant/v.ped_ant)::text || ' a ' ||
           round(v.cj_rec/v.ped_rec)::text || ' cajas (-' ||
           round(100*(1 - (v.cj_rec/v.ped_rec)/(v.cj_ant/v.ped_ant)))::text ||
           '%), pero sigue comprando igual de seguido.',
         'Preguntar qué dejó de llevar. Está comprando parte del surtido en otro lado.'::text,
         gv_score_suave(1 - (v.cj_rec/v.ped_rec)/(v.cj_ant/v.ped_ant), 0.6),
         jsonb_build_object('evidencia', jsonb_build_array(
             jsonb_build_object('k','Pedido promedio antes','v', round(v.cj_ant/v.ped_ant)::text || ' cajas'),
             jsonb_build_object('k','Pedido promedio ahora','v', round(v.cj_rec/v.ped_rec)::text || ' cajas'),
             jsonb_build_object('k','Pedidos (6m / previos)','v', v.ped_rec::text || ' / ' || v.ped_ant::text)))
  FROM vol v
  WHERE v.ped_rec >= 2 AND v.ped_ant >= 3
    AND v.cj_ant > 0 AND v.cj_rec > 0
    AND (v.cj_rec/v.ped_rec) < 0.6 * (v.cj_ant/v.ped_ant)
  ORDER BY (1 - (v.cj_rec/v.ped_rec)/(v.cj_ant/v.ped_ant)) * v.cj_ant DESC
  LIMIT 15
),

-- Un solo escaneo de categorías alimenta categoria_perdida y una_sola_linea.
cat_prev AS (
  SELECT sl.customer_code AS cod, p.category AS cat,
         count(DISTINCT sl.invoice_date) AS veces, sum(sl.boxes) AS cajas
  FROM sales_lines sl JOIN products p ON p.cod = sl.item_code
  WHERE sl.empresa = 'lk' AND sl.customer_code NOT IN ('1','3878')
    AND sl.invoice_date >= to_char(CURRENT_DATE - interval '30 months','YYYY-MM-DD')
    AND sl.invoice_date <  to_char(CURRENT_DATE - interval '6 months','YYYY-MM-DD')
    AND NULLIF(btrim(p.category),'') IS NOT NULL
    AND sl.item_code <> ALL (ARRAY(SELECT item_code FROM sales_excluded_items))
  GROUP BY 1,2 HAVING count(DISTINCT sl.invoice_date) >= 3
),
cat_rec AS (
  SELECT sl.customer_code AS cod, p.category AS cat, sum(sl.boxes)::numeric AS cajas
  FROM sales_lines sl JOIN products p ON p.cod = sl.item_code
  WHERE sl.empresa = 'lk' AND sl.customer_code NOT IN ('1','3878')
    AND sl.invoice_date >= to_char(CURRENT_DATE - interval '12 months','YYYY-MM-DD')
    AND NULLIF(btrim(p.category),'') IS NOT NULL
    AND sl.item_code <> ALL (ARRAY(SELECT item_code FROM sales_excluded_items))
  GROUP BY 1,2
),
vivos AS (
  SELECT DISTINCT customer_code AS cod FROM sales_lines
  WHERE empresa='lk' AND customer_code NOT IN ('1','3878')
    AND invoice_date >= to_char(CURRENT_DATE - interval '6 months','YYYY-MM-DD')
    AND item_code <> ALL (ARRAY(SELECT item_code FROM sales_excluded_items))
),
cat_c AS (
  SELECT 'categoria_perdida'::text, cp.cod,
         'Llevaba "' || cp.cat || '" en ' || cp.veces || ' pedidos (' || cp.cajas ||
           ' cajas) y hace 6 meses que no la compra, aunque sigue comprando otras cosas.',
         'Preguntar si cambió de proveedor en esa línea. Es la venta más fácil: ya la usaba.'::text,
         round(cp.cajas::numeric / NULLIF(max(cp.cajas) OVER (),0), 4),
         jsonb_build_object('evidencia', jsonb_build_array(
             jsonb_build_object('k','Categoría','v', cp.cat),
             jsonb_build_object('k','Pedidos con esa línea','v', cp.veces::text),
             jsonb_build_object('k','Cajas que llevaba','v', cp.cajas::text)))
  FROM cat_prev cp
  JOIN vivos v ON v.cod = cp.cod
  LEFT JOIN cat_rec cr ON cr.cod = cp.cod AND cr.cat = cp.cat
  WHERE cr.cod IS NULL
  ORDER BY cp.cajas DESC LIMIT 20
),
-- NUEVA: concentra casi todo en una categoría.
conc AS (
  SELECT cod, sum(cajas) AS total, max(cajas) AS top_cajas,
         (array_agg(cat ORDER BY cajas DESC))[1] AS top_cat,
         count(*) AS cats
  FROM cat_rec GROUP BY cod
),
linea_c AS (
  SELECT 'una_sola_linea'::text, c.cod,
         'El ' || round(100*c.top_cajas/c.total)::text || '% de lo que compra es "' || c.top_cat ||
           '" (' || c.top_cajas::text || ' de ' || c.total::text || ' cajas en 12 meses), sobre ' ||
           c.cats || ' categoría(s).',
         'Mostrarle el resto del catálogo. Ya compra volumen: el cruce a otra línea es venta incremental.'::text,
         gv_score_suave(c.total / 100, 3),
         jsonb_build_object('evidencia', jsonb_build_array(
             jsonb_build_object('k','Categoría dominante','v', c.top_cat),
             jsonb_build_object('k','Concentración','v', round(100*c.top_cajas/c.total)::text || '%'),
             jsonb_build_object('k','Cajas 12 meses','v', c.total::text)))
  FROM conc c
  WHERE c.total >= 40 AND c.top_cajas/c.total >= 0.85 AND c.cats <= 2
  ORDER BY c.total DESC LIMIT 15
),

chef_c AS (
  SELECT 'chef_activo_lk_frio'::text, l.cod_lk,
         'Está activo en Chef (última compra ' || to_char(l.ult_chef,'DD/MM/YYYY') ||
           ') y frío en Loekemeyer desde ' || COALESCE(to_char(l.ult_lk,'DD/MM/YYYY'),'siempre') ||
           '. El cliente compra, solo que no a nosotros.',
         'Cruzarlo con el vendedor de Chef y ofrecerle la línea Loekemeyer que hoy le compra a otro.'::text,
         round(COALESCE(l.valor_chef,0)/NULLIF(max(COALESCE(l.valor_chef,0)) OVER (),0),4),
         jsonb_build_object('evidencia', jsonb_build_array(
             jsonb_build_object('k','Última compra en Chef','v', to_char(l.ult_chef,'DD/MM/YYYY')),
             jsonb_build_object('k','Última en Loekemeyer','v', COALESCE(to_char(l.ult_lk,'DD/MM/YYYY'),'nunca')),
             jsonb_build_object('k','Valor en Chef','v','$' || to_char(round(COALESCE(l.valor_chef,0)),'FM999G999G999'))))
  FROM get_clientes_lk_ch(p_meses) l
  WHERE l.situacion = 'lk_frio_chef_activo'
  ORDER BY COALESCE(l.valor_chef,0) DESC LIMIT 10
),
portal_c AS (
  SELECT 'sin_portal'::text, c.cod_cliente::text,
         'Cliente activo que nunca hizo un pedido por la web: todos sus pedidos entran por teléfono o vendedor.'::text,
         'Darle de alta el usuario del portal y mostrarle el catálogo. Sube la frecuencia sin costo de visita.'::text,
         0.5::numeric,
         jsonb_build_object('evidencia', jsonb_build_array(
             jsonb_build_object('k','Última compra','v', u.ult),
             jsonb_build_object('k','Usuario web','v', CASE WHEN c.username IS NOT NULL THEN 'ya tiene' ELSE 'no tiene' END)))
  FROM customers c
  JOIN (SELECT sl.customer_code AS cod, max(sl.invoice_date) AS ult FROM sales_lines sl
        WHERE sl.empresa='lk' AND sl.customer_code NOT IN ('1','3878')
          AND sl.item_code <> ALL (ARRAY(SELECT item_code FROM sales_excluded_items))
        GROUP BY 1) u ON u.cod = c.cod_cliente::text
  CROSS JOIN corte
  WHERE u.ult >= corte.c AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id)
  ORDER BY u.ult DESC LIMIT 10
),
-- La UNICA atadura entre el agente y la mitad geografica del modulo.
cob AS (SELECT * FROM gv_cobertura_provincia(p_meses) WHERE hab_por_punto IS NOT NULL),
med AS (SELECT (percentile_cont(0.5) WITHIN GROUP (ORDER BY hab_por_punto))::numeric AS m FROM cob),
zona_c AS (
  SELECT 'zona_fria'::text, NULL::text,
         cob.provincia || ' tiene 1 punto de venta cada ' || to_char(cob.hab_por_punto,'FM999G999') ||
           ' habitantes, contra ' || to_char(round(med.m),'FM999G999') || ' de la mediana del país: ' ||
           round(cob.hab_por_punto/NULLIF(med.m,0),1)::text || '× más flojo.',
         'Buscar distribuidores o puntos nuevos en ' || cob.provincia || '. Hoy hay ' ||
           cob.sucursales || ' sucursales y ' || cob.activos || ' clientes activos.',
         gv_score_suave(cob.hab_por_punto/NULLIF(med.m,0) - 1.5, 3),
         jsonb_build_object('evidencia', jsonb_build_array(
             jsonb_build_object('k','Hab. por punto','v', to_char(cob.hab_por_punto,'FM999G999')),
             jsonb_build_object('k','Mediana del país','v', to_char(round(med.m),'FM999G999')),
             jsonb_build_object('k','Sucursales hoy','v', cob.sucursales::text)))
  FROM cob, med
  WHERE cob.hab_por_punto > med.m * 1.5
  ORDER BY cob.hab_por_punto DESC LIMIT 5
)
SELECT * FROM react_c
UNION ALL SELECT * FROM ritmo_c
UNION ALL SELECT * FROM sin_segunda_c
UNION ALL SELECT * FROM ticket_c
UNION ALL SELECT * FROM cat_c
UNION ALL SELECT * FROM linea_c
UNION ALL SELECT * FROM chef_c
UNION ALL SELECT * FROM portal_c
UNION ALL SELECT * FROM zona_c;
$function$
;
