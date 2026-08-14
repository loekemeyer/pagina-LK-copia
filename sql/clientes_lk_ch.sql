-- ===========================================================================
-- Clientes vinculados  (Loekemeyer <-> Chef)
-- ===========================================================================
-- Hay clientes que le compran a las dos empresas del grupo. Cuando uno deja de
-- comprarle a Loekemeyer pero sigue comprando en Chef, Ranking Inactivos lo
-- muestra como perdido: no lo es, el cliente sigue activo en la casa y solo
-- cambió de línea. Reclamarlo por inactivo es un falso positivo.
--
-- AGRUPAR NO ES VINCULAR. Este archivo tiene lo de CRUZAR empresas. Juntar
-- razones sociales DENTRO de una empresa es otra cosa y vive en
-- sql/customer_grupos.sql. En el panel están separados a propósito, como dos
-- módulos distintos de ABM Clientes -> Clientes agrupados.
--
-- LAS NUMERACIONES SON INDEPENDIENTES
-- Es lo primero que hay que entender antes de tocar cualquier cosa que cruce
-- las dos empresas: el mismo número es un negocio distinto en cada una. El
-- código 2502 es "Filippi Navier (Ex Jauregui)" en Loekemeyer y "Gonzagerodia
-- S.A." en Chef. Verificado sobre los 69 códigos que aparecen con las dos
-- empresas: 61 tienen razón social distinta en cada padrón, y el solape
-- observado (69) es el que se espera por puro azar (~62).
-- O sea: COINCIDIR DE NÚMERO NO VINCULA NADA. El vínculo va por CUIT, por
-- razón social o a mano.
--
-- Por eso el módulo agrupa por CLIENTE REAL y no por código, y la tabla en
-- pantalla muestra siempre el código de LOEKEMEYER: es con el que se lo busca
-- en el ranking y en el resto del panel.
--
-- CÓMO SE VINCULA (los tres orígenes, en get_clientes_lk_ch -> par)
--   1. CUIT igual        188 de los 312 códigos de Chef con ventas
--   2. Razón social       171
--   3. A mano             clientes_lk_ch_links
--
-- 18 códigos matchean SOLO por CUIT: son los que cambiaron de razón social al
-- pasar a Chef, que es justamente el caso que el nombre no puede ver. El CUIT
-- de Chef sale de chef_padron; estuvo invisible un tiempo porque la tabla
-- foránea no declaraba esa columna, aunque la remota la tenía con 755 de 757
-- cargados.
--
-- EL PADRÓN DE CHEF VIVE EN OTRO PROYECTO DE SUPABASE (nkhzocgdpwtgrmwleihr).
-- chef_customers, chef_customer_delivery_addresses y chef_sales_lines son
-- tablas FORÁNEAS (postgres_fdw). Leerlas cuesta segundos de latencia de red:
-- 6.772 ms medidos para resolver 312 clientes, contra un statement_timeout de
-- ~8 s. NUNCA joinearlas en el camino caliente, y menos con LATERAL: dispara
-- una consulta remota por fila y la función se cuelga.
-- Por eso existe chef_padron, la copia LOCAL, que baja el costo a 234 ms.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- chef_padron: copia local del padrón de Chef (razón social, CUIT y dirección
-- de entrega). Todo lo que necesita saber este módulo del cliente de Chef sale
-- de acá y nunca del FDW.
--
-- La refresca el cron `sincronizar-chef-diario` (03:20 UTC) vía
-- sincronizar_chef(). A mano: select public.sincronizar_chef();
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.chef_padron (
  cod_cliente    text PRIMARY KEY,
  business_name  text,
  cuit           text,
  direccion      text,
  actualizado_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.chef_padron IS
  'Copia LOCAL del padrón de Chef (proyecto nkhzocgdpwtgrmwleihr). Evita joinear las tablas foráneas en el camino caliente. La refresca el cron sincronizar-chef-diario.';

ALTER TABLE public.chef_padron ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS chef_padron_lectura ON public.chef_padron;
CREATE POLICY chef_padron_lectura
  ON public.chef_padron
  FOR SELECT
  TO authenticated
  USING (EXISTS (SELECT 1 FROM admins a WHERE a.auth_user_id = auth.uid()));

GRANT SELECT ON public.chef_padron TO authenticated;


-- ---------------------------------------------------------------------------
-- Vínculo manual entre códigos que son el MISMO cliente real y que ningún
-- automatismo puede detectar: razón social distinta en cada empresa y sin CUIT
-- cargado que los una.
--
-- Por qué una tabla propia y no customer_grupos: aquello agrupa DENTRO de una
-- empresa y su código vigente se vuelve canónico en el ranking. Un código de
-- Chef no puede ser canónico de nada del lado de Loekemeyer, así que mezclarlos
-- ahí rompería el ranking. Acá el vínculo solo sirve para saber que el cliente
-- sigue comprando en la casa.
--
-- Lleva `empresa` en la clave primaria por la misma razón que customer_grupos:
-- el mismo número existe en las dos y es otro cliente en cada una.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.clientes_lk_ch_links (
  cod_cliente text NOT NULL,
  empresa     text NOT NULL CHECK (empresa IN ('lk', 'chef')),
  link_id     uuid NOT NULL,
  creado_por  uuid DEFAULT auth.uid(),
  creado_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cod_cliente, empresa)
);

CREATE INDEX IF NOT EXISTS clientes_lk_ch_links_link_idx
  ON public.clientes_lk_ch_links (link_id);

COMMENT ON TABLE public.clientes_lk_ch_links IS
  'Vincula a mano códigos de Loekemeyer y de Chef que son el mismo cliente real con razón social distinta en cada empresa.';

ALTER TABLE public.clientes_lk_ch_links ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS clientes_lk_ch_links_admin_all ON public.clientes_lk_ch_links;
CREATE POLICY clientes_lk_ch_links_admin_all
  ON public.clientes_lk_ch_links
  FOR ALL
  TO authenticated
  USING (EXISTS (SELECT 1 FROM admins a WHERE a.auth_user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM admins a WHERE a.auth_user_id = auth.uid()));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.clientes_lk_ch_links TO authenticated;


-- ---------------------------------------------------------------------------
-- El switch "sacar del ranking" tiene un valor AUTOMÁTICO —prendido si el
-- cliente dejó de comprarle a Loekemeyer pero le compró a Chef dentro del
-- período— que la persona puede pisar en los dos sentidos. Por eso esta tabla
-- no es una lista de exclusiones sino la DECISIÓN explícita: sin fila para el
-- código manda el automático; con fila manda lo que diga `excluir`.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.clientes_chef_excluidos (
  cod_cliente  text PRIMARY KEY,
  excluido_por uuid DEFAULT auth.uid(),
  excluido_at  timestamptz NOT NULL DEFAULT now(),
  excluir      boolean NOT NULL DEFAULT true
);

COMMENT ON TABLE public.clientes_chef_excluidos IS
  'Override manual del switch "sacar del ranking" de Clientes vinculados. Una fila por código de Loekemeyer.';
COMMENT ON COLUMN public.clientes_chef_excluidos.excluir IS
  'Decisión manual que pisa el automático. Sin fila para el código, manda el automático (LK frío + Chef activo).';

ALTER TABLE public.clientes_chef_excluidos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS clientes_chef_excluidos_admin_all ON public.clientes_chef_excluidos;
CREATE POLICY clientes_chef_excluidos_admin_all
  ON public.clientes_chef_excluidos
  FOR ALL
  USING (EXISTS (SELECT 1 FROM admins a WHERE a.auth_user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM admins a WHERE a.auth_user_id = auth.uid()));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.clientes_chef_excluidos TO authenticated;


-- ---------------------------------------------------------------------------
-- lk_ch_excluidos_cache: los códigos de Loekemeyer que hoy quedan FUERA del
-- Ranking Inactivos por seguir comprando en Chef, ya resueltos.
--
-- POR QUÉ UNA CACHE. get_ranking_inactivos necesita esta lista en cada carga.
-- Calcularla en vivo con codigos_lk_excluidos_por_chef() cuesta 2.163 ms
-- contra 496 ms leyendo la tabla, porque obliga a armar los clusters de las dos
-- empresas y valorizarlos para devolver, al final, un puñado de códigos.
--
-- La refrescan las RPC que la pueden cambiar (set_lk_ch_excluido,
-- reset_lk_ch_excluido, vincular_lk_ch, desvincular_lk_ch) y el cron
-- sincronizar-chef-diario.
--
-- CUIDADO AL EDITAR ESAS CUATRO: el refresco es un PERFORM suelto al final del
-- cuerpo, y si queda DESPUÉS de un RETURN es código inalcanzable que el
-- planificador no marca como error. Así estuvieron vincular_lk_ch y
-- desvincular_lk_ch hasta el 31/7/2026: vincular no se veía en el ranking
-- hasta el cron del día siguiente. El PERFORM va SIEMPRE antes del RETURN.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.lk_ch_excluidos_cache (
  cod_cliente    text PRIMARY KEY,
  actualizado_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.lk_ch_excluidos_cache IS
  'Cache de los códigos LK que quedan fuera de Ranking Inactivos por comprar en Chef. La lee get_ranking_inactivos; la escribe refrescar_lk_ch_excluidos().';

ALTER TABLE public.lk_ch_excluidos_cache ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lk_ch_excluidos_cache_lectura ON public.lk_ch_excluidos_cache;
CREATE POLICY lk_ch_excluidos_cache_lectura
  ON public.lk_ch_excluidos_cache
  FOR SELECT
  TO authenticated
  USING (EXISTS (SELECT 1 FROM admins a WHERE a.auth_user_id = auth.uid()));

GRANT SELECT ON public.lk_ch_excluidos_cache TO authenticated;


-- ---------------------------------------------------------------------------
-- datos_cliente_empresa: la FUENTE ÚNICA de identidad y métricas por cliente.
--
-- Devuelve, para una empresa, una fila por código con: razón social, CUIT,
-- dirección de entrega, fecha de última compra y valor histórico neto. Resuelve
-- cada dato contra el padrón que corresponde:
--   lk    -> customers, cayendo a Wpp_Clientes cuando no hay ficha
--   chef  -> chef_padron (la copia local; nunca el FDW)
--
-- La usan agrupar, las sugerencias, el buscador y este módulo, justamente para
-- que no diverjan: antes cada uno resolvía el nombre y el valor por su cuenta y
-- el mismo cliente aparecía distinto según la pantalla.
--
-- El valor sale NETO, con la misma cadena multiplicativa que arma un pedido
-- real: list_price * (1 - dto_vol) * (1 - web_order_discount). El dto_vol solo
-- aplica a lk: los clientes de Chef no tienen ficha en customers.
--
-- Vive en este archivo y no en customer_grupos.sql porque es la pieza que
-- abstrae LAS DOS empresas; es lo que permite que el resto del código no sepa
-- de dónde sale cada padrón.
-- ---------------------------------------------------------------------------
-- p_cods acota el agregado a un puñado de códigos. La versión de UN argumento
-- queda como envoltorio al final, para no duplicar el cuerpo: esta función es
-- la fuente única de identidad y métricas por cliente.
CREATE OR REPLACE FUNCTION public.datos_cliente_empresa(p_empresa text, p_cods text[])
 RETURNS TABLE(cod text, nom text, cuit text, dir text, ult text, valor numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  WITH wd AS (
    SELECT COALESCE((SELECT s.value FROM app_settings s WHERE s.key='web_order_discount'),0.02)::numeric AS d
  ),
  lk_dir AS (
    SELECT DISTINCT ON (c.cod_cliente::text) c.cod_cliente::text AS cod,
           btrim(a.direccion_entrega) AS dir
    FROM customer_delivery_addresses a
    JOIN customers c ON c.id = a.customer_id
    WHERE p_empresa = 'lk' AND btrim(COALESCE(a.direccion_entrega,''))<>''
    ORDER BY c.cod_cliente::text, a.slot NULLS LAST
  ),
  v AS (
    SELECT sl.customer_code AS cod, MAX(sl.invoice_date) AS ult,
           SUM(sl.boxes * COALESCE(p.uxb,0) * COALESCE(p.list_price,0)
               * (1 - CASE WHEN p_empresa='lk' THEN COALESCE(c.dto_vol,0) ELSE 0 END)
               * (1-wd.d))::numeric AS valor
    FROM sales_lines sl
    CROSS JOIN wd
    LEFT JOIN products p ON p.cod = sl.item_code AND p.active IS TRUE
    LEFT JOIN customers c ON p_empresa='lk' AND c.cod_cliente::text = sl.customer_code
    WHERE sl.empresa = p_empresa
      AND sl.customer_code IS NOT NULL AND sl.customer_code NOT IN ('1','3878')
      -- Filtro opcional: con p_cods el agregado sale por el índice parcial
      -- sales_lines_lk_cliente_idx en vez de recorrer las 189k líneas de la
      -- empresa. Lo usa get_customer_grupos, que necesita datos de un puñado
      -- de códigos y pagaba el padrón entero de las dos empresas.
      AND (p_cods IS NULL OR sl.customer_code = ANY (p_cods))
      AND sl.item_code <> ALL (ARRAY(SELECT item_code FROM sales_excluded_items))
    GROUP BY sl.customer_code
  ),
  lk_nom AS (
    SELECT c.cod_cliente::text AS cod,
           COALESCE(NULLIF(btrim(c.business_name),''),'') AS nom,
           NULLIF(regexp_replace(COALESCE(c.cuit,''),'[^0-9]','','g'),'') AS cuit
    FROM customers c WHERE p_empresa='lk' AND c.cod_cliente IS NOT NULL
  ),
  wpp AS (
    SELECT w.cod_cli::text AS cod, MIN(btrim(w.nombre)) AS nom
    FROM "Wpp_Clientes" w
    WHERE p_empresa='lk' AND w.marca = 'LK' AND btrim(COALESCE(w.nombre,''))<>''
    GROUP BY w.cod_cli::text
    HAVING count(DISTINCT btrim(w.nombre)) = 1
  )
  -- chef_padron es la copia LOCAL; nunca se toca el FDW acá.
  SELECT v.cod,
         CASE WHEN p_empresa='chef' THEN COALESCE(cp.business_name,'')
              ELSE COALESCE(NULLIF(ln.nom,''), wp.nom, '') END,
         CASE WHEN p_empresa='chef' THEN cp.cuit ELSE ln.cuit END,
         CASE WHEN p_empresa='chef' THEN cp.direccion ELSE ld.dir END,
         v.ult,
         ROUND(COALESCE(v.valor,0))::numeric
  FROM v
  LEFT JOIN chef_padron cp ON p_empresa='chef' AND cp.cod_cliente = v.cod
  LEFT JOIN lk_nom ln ON ln.cod = v.cod
  LEFT JOIN wpp wp ON wp.cod = v.cod
  LEFT JOIN lk_dir ld ON ld.cod = v.cod;
$function$;

-- Envoltorio: el padrón entero de la empresa. La versión de DOS argumentos no
-- lleva DEFAULT a propósito — si lo llevara, una llamada de un solo argumento
-- sería ambigua entre las dos firmas y Postgres la rechazaría.
CREATE OR REPLACE FUNCTION public.datos_cliente_empresa(p_empresa text)
 RETURNS TABLE(cod text, nom text, cuit text, dir text, ult text, valor numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  SELECT * FROM datos_cliente_empresa(p_empresa, NULL::text[]);
$function$;

GRANT EXECUTE ON FUNCTION public.datos_cliente_empresa(text) TO authenticated;


-- ---------------------------------------------------------------------------
-- Una fila por CLIENTE REAL que opera en las dos empresas.
--
-- Arma los pares por CUIT, por razón social normalizada y por vínculo manual
-- (CTE `par`), y después los EXPANDE A LOS GRUPOS DE LOS DOS LADOS (CTE
-- `par_g`): vincular a cualquier miembro vincula al grupo entero, en las dos
-- empresas. Eso cubre los cuatro casos —cliente<->cliente, grupo<->grupo,
-- cliente suelto contra un grupo del otro lado— sin tener que enumerarlos.
--
-- La clave del cliente en cada empresa (CTE klk/kch) es, en orden: el grupo
-- armado si lo hay, si no el CUIT, si no la razón social normalizada, si no el
-- código solo.
--
-- `excluido` es lo que manda: COALESCE(override, automático). `decision_manual`
-- dice si hay override cargado, y `lk_frio_chef_activo` es el automático crudo,
-- para que la pantalla pueda mostrar los dos y explicar por qué está como está.
--
-- `situacion` NOMBRA LAS CUATRO COMBINACIONES, no solo la que saca del ranking:
--   activo_ambas          compra en las dos                      (34 clientes)
--   lk_frio_chef_activo   dejó Loekemeyer, sigue en Chef         (14)
--   lk_activo_chef_frio   sigue en Loekemeyer, dejó Chef         (79)
--   frio_ambas            dejó las dos                           (39)
--
-- Existe porque `lk_frio_chef_activo` es un booleano y su `false` tapaba tres
-- situaciones muy distintas. La más numerosa es justamente la que no se veía:
-- 79 clientes con $4.081 M de valor histórico en Loekemeyer que Chef perdió —
-- el espejo exacto del módulo. Hoy no tiene consecuencia (no hay ranking de
-- Chef); es un dato para leer, y por eso se calcula acá y no se guarda.
--
-- NO SE PERSISTE A PROPÓSITO: la situación es relativa a HOY (depende del corte
-- de p_meses), así que un cliente cambia de estado solo con que pase el tiempo
-- o vuelva a comprar. Guardarla obligaría a refrescarla, que es exactamente el
-- problema que ya resuelve lk_ch_excluidos_cache para el único estado que sí
-- tiene consecuencia. Lo que SÍ se guarda es la decisión manual, en
-- clientes_chef_excluidos.
--
-- El COALESCE a false de lk_activo/ch_activo es deliberado: un cliente sin
-- fecha resuelta cuenta como frío, igual que lo trataba el automático.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.get_clientes_lk_ch(int);

CREATE OR REPLACE FUNCTION public.get_clientes_lk_ch(p_meses integer DEFAULT 12)
 RETURNS TABLE(cod_lk text, cods_lk text[], cods_chef text[], business_name text, nombre_chef text, ult_lk date, ult_chef date, valor_lk numeric, valor_chef numeric, lk_frio_chef_activo boolean, excluido boolean, decision_manual boolean, vinculado_manual boolean, situacion text, cuit text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  WITH cutoff AS (
    SELECT to_char(CURRENT_DATE - (p_meses || ' months')::interval, 'YYYY-MM-DD') AS c
  ),
  lk AS (SELECT * FROM datos_cliente_empresa('lk')),
  ch AS (SELECT * FROM datos_cliente_empresa('chef')),
  -- Clave del cliente en cada empresa: el grupo armado si lo hay, si no el
  -- CUIT, si no la razón social, si no el código solo.
  klk AS (
    SELECT l.*, COALESCE('g:'||v.cod_cliente, l.cuit,
                         NULLIF(norm_razon_social(l.nom),''), 'c:'||l.cod) AS k
    FROM lk l
    LEFT JOIN customer_grupos g ON g.cod_cliente = l.cod AND g.empresa='lk'
    LEFT JOIN customer_grupos v ON v.grupo_id = g.grupo_id AND v.es_vigente
  ),
  kch AS (
    SELECT c.*, COALESCE('g:'||v.cod_cliente, c.cuit,
                         NULLIF(norm_razon_social(c.nom),''), 'c:'||c.cod) AS k
    FROM ch c
    LEFT JOIN customer_grupos g ON g.cod_cliente = c.cod AND g.empresa='chef'
    LEFT JOIN customer_grupos v ON v.grupo_id = g.grupo_id AND v.es_vigente
  ),
  par AS (
    SELECT l.cod AS cod_lk, c.cod AS cod_ch FROM klk l JOIN kch c ON c.cuit = l.cuit
    UNION
    SELECT l.cod, c.cod FROM klk l JOIN kch c
      ON NULLIF(norm_razon_social(l.nom),'') = NULLIF(norm_razon_social(c.nom),'')
    UNION
    SELECT ll.cod_cliente, lc.cod_cliente
    FROM clientes_lk_ch_links ll
    JOIN clientes_lk_ch_links lc ON lc.link_id = ll.link_id AND lc.empresa='chef'
    WHERE ll.empresa='lk'
  ),
  -- Se propaga el par a todos los miembros del grupo de cada lado.
  par_g AS (
    SELECT DISTINCT l2.cod AS cod_lk, c2.cod AS cod_ch
    FROM par p
    JOIN klk l ON l.cod = p.cod_lk
    JOIN klk l2 ON l2.k = l.k
    JOIN kch c ON c.cod = p.cod_ch
    JOIN kch c2 ON c2.k = c.k
  ),
  cl AS (
    SELECT l.k,
           (ARRAY_AGG(l.cod ORDER BY l.ult DESC NULLS LAST, l.cod))[1] AS cod_lk,
           ARRAY_AGG(l.cod ORDER BY l.cod) AS cods_lk,
           (ARRAY_AGG(NULLIF(btrim(l.nom),'') ORDER BY l.ult DESC NULLS LAST))[1] AS nom,
           -- CUIT del lado Loekemeyer, para que el buscador de la pantalla
           -- pueda filtrar por identidad fiscal y no solo por nombre/código.
           (ARRAY_AGG(l.cuit ORDER BY l.ult DESC NULLS LAST)
              FILTER (WHERE NULLIF(btrim(l.cuit),'') IS NOT NULL))[1] AS cuit,
           MAX(l.ult) AS ult_lk, SUM(COALESCE(l.valor,0)) AS v_lk
    FROM klk l
    WHERE EXISTS (SELECT 1 FROM par_g WHERE par_g.cod_lk = l.cod)
    GROUP BY l.k
  ),
  cl_ch AS (
    SELECT cl.k, ARRAY_AGG(DISTINCT c.cod) AS cods_chef,
           (ARRAY_AGG(c.nom ORDER BY c.ult DESC NULLS LAST))[1] AS nom_ch,
           (ARRAY_AGG(c.cuit ORDER BY c.ult DESC NULLS LAST)
              FILTER (WHERE NULLIF(btrim(c.cuit),'') IS NOT NULL))[1] AS cuit_ch,
           MAX(c.ult) AS ult_ch, SUM(COALESCE(c.valor,0)) AS v_ch
    FROM cl
    JOIN par_g ON par_g.cod_lk = ANY (cl.cods_lk)
    JOIN kch c ON c.cod = par_g.cod_ch
    GROUP BY cl.k
  ),
  fin AS (
    SELECT cl.*, cc.cods_chef, cc.nom_ch, cc.cuit_ch, cc.ult_ch, cc.v_ch,
           (cl.ult_lk < (SELECT c FROM cutoff) AND cc.ult_ch >= (SELECT c FROM cutoff)) AS auto_ex,
           -- Los dos lados por separado, para poder nombrar las CUATRO
           -- situaciones y no solo la que saca del ranking. COALESCE a false:
           -- un cliente sin fecha resuelta cuenta como frío.
           COALESCE(cl.ult_lk >= (SELECT c FROM cutoff), false) AS lk_activo,
           COALESCE(cc.ult_ch >= (SELECT c FROM cutoff), false) AS ch_activo,
           (SELECT bool_or(x.excluir) FROM clientes_chef_excluidos x
            WHERE x.cod_cliente = ANY (cl.cods_lk)) AS override,
           EXISTS (SELECT 1 FROM clientes_lk_ch_links ll
                   WHERE ll.empresa='lk' AND ll.cod_cliente = ANY (cl.cods_lk)) AS manual
    FROM cl JOIN cl_ch cc ON cc.k = cl.k
  )
  SELECT f.cod_lk, f.cods_lk, f.cods_chef, COALESCE(f.nom,''), COALESCE(f.nom_ch,''),
         to_date(f.ult_lk,'YYYY-MM-DD'), to_date(f.ult_ch,'YYYY-MM-DD'),
         ROUND(f.v_lk)::numeric, ROUND(f.v_ch)::numeric,
         f.auto_ex, COALESCE(f.override, f.auto_ex),
         f.override IS NOT NULL, f.manual,
         CASE
           WHEN f.lk_activo AND f.ch_activo THEN 'activo_ambas'
           WHEN f.ch_activo                 THEN 'lk_frio_chef_activo'
           WHEN f.lk_activo                 THEN 'lk_activo_chef_frio'
           ELSE                                  'frio_ambas'
         END,
         COALESCE(f.cuit, f.cuit_ch, '')
  FROM fin f
  ORDER BY f.auto_ex DESC, f.v_lk DESC;
$function$;

GRANT EXECUTE ON FUNCTION public.get_clientes_lk_ch(int) TO authenticated;


-- ---------------------------------------------------------------------------
-- Los códigos de Loekemeyer que hoy quedan fuera del ranking por seguir
-- comprando en Chef. Es la fuente única de esa decisión: la consumen la
-- pantalla del ranking y su Excel, así que no pueden discrepar.
--
-- Devuelve TODOS los códigos LK del cluster (unnest de cods_lk), no solo el que
-- se muestra: si un cliente tiene dos razones sociales en Loekemeyer, las dos
-- entran al ranking por separado y las dos tienen que salir juntas.
--
-- Es una vista finita sobre get_clientes_lk_ch, no una reimplementación. Antes
-- repetía el armado de clusters para ahorrarse la valorización; se unificó
-- cuando apareció lk_ch_excluidos_cache, porque el ranking ya no la llama en
-- vivo y el costo dejó de estar en el camino caliente. Tener una sola
-- definición del cluster vale más que esos milisegundos.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.codigos_lk_excluidos_por_chef(p_meses integer DEFAULT 12)
 RETURNS TABLE(cod_cliente text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  SELECT DISTINCT unnest(g.cods_lk)
  FROM get_clientes_lk_ch(p_meses) g
  WHERE g.excluido;
$function$;

GRANT EXECUTE ON FUNCTION public.codigos_lk_excluidos_por_chef(int) TO authenticated;


-- ---------------------------------------------------------------------------
-- Recalcula lk_ch_excluidos_cache de cero. Es el único que la escribe.
-- Se fija en 12 meses a propósito: es el período con el que corre el ranking.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.refrescar_lk_ch_excluidos()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_n int;
BEGIN
  -- El WHERE no es decorativo: supautils (session_preload_libraries) bloquea
  -- los DELETE sin WHERE para roles no superusuario, así que sin él el switch
  -- del módulo fallaba en el navegador con "DELETE requires a WHERE clause"
  -- aunque desde el SQL editor anduviera. SECURITY DEFINER no salva: cambia el
  -- usuario, no los parámetros de sesión.
  DELETE FROM lk_ch_excluidos_cache WHERE cod_cliente IS NOT NULL;
  INSERT INTO lk_ch_excluidos_cache (cod_cliente)
  SELECT cod_cliente FROM codigos_lk_excluidos_por_chef(12);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.refrescar_lk_ch_excluidos() TO authenticated;


-- ---------------------------------------------------------------------------
-- Trae el padrón de Chef desde las tablas foráneas a chef_padron.
-- Es el ÚNICO lugar del sistema que toca el FDW, y corre una vez por día desde
-- el cron, nunca desde una pantalla.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.refrescar_chef_padron()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_n int;
BEGIN
  WITH dir AS (
    SELECT DISTINCT ON (a.customer_id) a.customer_id, btrim(a.direccion_entrega) AS dir
    FROM chef_customer_delivery_addresses a
    WHERE btrim(COALESCE(a.direccion_entrega,'')) <> ''
    ORDER BY a.customer_id, a.slot NULLS LAST
  ),
  src AS (
    SELECT cc.cod_cliente::text AS cod,
           COALESCE(NULLIF(btrim(cc.business_name),''),'') AS nom,
           NULLIF(regexp_replace(COALESCE(cc.cuit,''),'[^0-9]','','g'),'') AS cuit,
           d.dir
    FROM chef_customers cc
    LEFT JOIN dir d ON d.customer_id = cc.id
    WHERE cc.cod_cliente IS NOT NULL
  )
  INSERT INTO chef_padron (cod_cliente, business_name, cuit, direccion, actualizado_at)
  SELECT cod, nom, cuit, dir, now() FROM src
  ON CONFLICT (cod_cliente) DO UPDATE
    SET business_name = EXCLUDED.business_name,
        cuit = EXCLUDED.cuit,
        direccion = EXCLUDED.direccion,
        actualizado_at = now();
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.refrescar_chef_padron() TO authenticated;


-- ---------------------------------------------------------------------------
-- Lo que corre el cron `sincronizar-chef-diario` (20 3 * * *, o sea 03:20 UTC):
--
--   SELECT cron.schedule('sincronizar-chef-diario', '20 3 * * *',
--                        $$select public.sincronizar_chef();$$);
--
-- Refresca el padrón y recalcula la cache de exclusiones, en ese orden.
--
-- AGUANTA QUE CHEF ESTÉ CAÍDO: el refresco del padrón va dentro de su propio
-- bloque BEGIN/EXCEPTION, así que si el FDW no responde se pierde la
-- actualización del padrón pero la cache se recalcula igual con la copia que ya
-- había. Sin eso, una caída de Chef dejaba el Ranking Inactivos sin exclusiones
-- y los clientes que se pasaron volvían a figurar como perdidos.
-- El texto que devuelve dice qué pasó con cada parte; queda en
-- cron.job_run_details.return_message.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sincronizar_chef()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_pad int := -1; v_exc int; v_err text := '';
BEGIN
  BEGIN
    v_pad := refrescar_chef_padron();
  EXCEPTION WHEN OTHERS THEN
    v_err := ' | padrón NO actualizado: ' || SQLERRM;
  END;

  v_exc := refrescar_lk_ch_excluidos();

  RETURN 'padrón=' || CASE WHEN v_pad < 0 THEN 'error' ELSE v_pad::text END
      || ' exclusiones=' || v_exc || v_err;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.sincronizar_chef() TO authenticated;


-- ---------------------------------------------------------------------------
-- Prende/apaga el switch de un cluster. Guarda la decisión para TODOS sus
-- códigos de Loekemeyer, porque el switch es del cliente y no del código.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.set_cliente_chef_excluido(text, boolean);

CREATE OR REPLACE FUNCTION public.set_lk_ch_excluido(p_cod_lk text, p_excluir boolean, p_meses integer DEFAULT 12)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cods text[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admins a WHERE a.auth_user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Solo admins pueden administrar esta lista';
  END IF;

  SELECT g.cods_lk INTO v_cods
  FROM get_clientes_lk_ch(p_meses) g
  WHERE g.cod_lk = p_cod_lk;

  IF v_cods IS NULL THEN
    v_cods := ARRAY[p_cod_lk];
  END IF;

  -- Se guarda siempre la decisión explícita, aunque coincida con el automático:
  -- así queda registrado que una persona la miró, y no se da vuelta sola cuando
  -- el cliente cruza el umbral de los 12 meses.
  DELETE FROM clientes_chef_excluidos WHERE cod_cliente = ANY (v_cods);

  INSERT INTO clientes_chef_excluidos (cod_cliente, excluir)
  SELECT c, p_excluir FROM unnest(v_cods) AS c;
PERFORM refrescar_lk_ch_excluidos();
END;
$function$;

GRANT EXECUTE ON FUNCTION public.set_lk_ch_excluido(text, boolean, int) TO authenticated;


-- Vuelve al automático: borra la decisión manual del cluster.
CREATE OR REPLACE FUNCTION public.reset_lk_ch_excluido(p_cod_lk text, p_meses integer DEFAULT 12)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cods text[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admins a WHERE a.auth_user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Solo admins pueden administrar esta lista';
  END IF;

  SELECT g.cods_lk INTO v_cods
  FROM get_clientes_lk_ch(p_meses) g
  WHERE g.cod_lk = p_cod_lk;

  DELETE FROM clientes_chef_excluidos
  WHERE cod_cliente = ANY (COALESCE(v_cods, ARRAY[p_cod_lk]));
PERFORM refrescar_lk_ch_excluidos();
END;
$function$;

GRANT EXECUTE ON FUNCTION public.reset_lk_ch_excluido(text, int) TO authenticated;


-- ---------------------------------------------------------------------------
-- Buscador de códigos de UNA empresa para armar el vínculo manual. Toma
-- p_empresa porque vincular es elegir un código de cada lado: la pantalla llama
-- dos veces, una por empresa.
--
-- Es parecido a buscar_clientes_para_grupo pero no el mismo: aquel devuelve
-- CUIT y valor histórico porque sirve para decidir un agrupamiento, y este solo
-- necesita código, nombre, última compra y si ya está vinculado.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.buscar_clientes_lk_ch(text, int);

CREATE OR REPLACE FUNCTION public.buscar_clientes_lk_ch(p_q text DEFAULT ''::text, p_empresa text DEFAULT 'lk'::text, p_limit integer DEFAULT 25)
 RETURNS TABLE(cod_cliente text, business_name text, last_date date, ya_vinculado boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  WITH v AS (
    SELECT sl.customer_code AS cod, MAX(sl.invoice_date) AS ult
    FROM sales_lines sl
    WHERE sl.empresa = p_empresa
      AND sl.customer_code IS NOT NULL AND sl.customer_code NOT IN ('1','3878')
      AND sl.item_code <> ALL (ARRAY(SELECT item_code FROM sales_excluded_items))
    GROUP BY sl.customer_code
  ),
  n AS (
    SELECT v.cod, v.ult,
           CASE WHEN p_empresa = 'chef'
                THEN COALESCE(NULLIF(btrim(cc.business_name),''),'')
                ELSE COALESCE(NULLIF(btrim(c.business_name),''), wn.nombre, '')
           END AS nom
    FROM v
    LEFT JOIN chef_padron cc ON p_empresa='chef' AND cc.cod_cliente = v.cod
    LEFT JOIN customers c ON p_empresa='lk' AND c.cod_cliente::text = v.cod
    LEFT JOIN LATERAL (
      SELECT MIN(btrim(w.nombre)) AS nombre FROM "Wpp_Clientes" w
      WHERE p_empresa='lk' AND w.marca = 'LK' AND w.cod_cli::text = v.cod AND btrim(COALESCE(w.nombre,''))<>''
      HAVING count(DISTINCT btrim(w.nombre))=1
    ) wn ON TRUE
  )
  SELECT n.cod, n.nom, to_date(n.ult,'YYYY-MM-DD'),
         EXISTS (SELECT 1 FROM clientes_lk_ch_links l
                 WHERE l.cod_cliente = n.cod AND l.empresa = p_empresa)
  FROM n
  WHERE COALESCE(btrim(p_q),'') = ''
     OR n.cod ILIKE '%'||btrim(p_q)||'%'
     OR n.nom ILIKE '%'||btrim(p_q)||'%'
  ORDER BY (n.cod = btrim(p_q)) DESC, n.ult DESC NULLS LAST, n.cod
  LIMIT GREATEST(p_limit,1);
$function$;

GRANT EXECUTE ON FUNCTION public.buscar_clientes_lk_ch(text, text, int) TO authenticated;


-- ---------------------------------------------------------------------------
-- Vincula un código de Loekemeyer con uno de Chef.
--
-- Si cualquiera de los dos ya estaba vinculado se REUSA ese link_id, así los
-- dos clusters quedan en uno y no se pisan. La expansión a los demás miembros
-- del grupo no se materializa acá: la hace get_clientes_lk_ch en cada consulta
-- (CTE par_g), así que basta con vincular una razón social de cada lado.
--
-- Refresca lk_ch_excluidos_cache antes de salir, así el cambio se ve en el
-- Ranking Inactivos en la misma carga. Hasta el 31/7/2026 ese PERFORM estaba
-- después del RETURN —código inalcanzable— y vincular no tenía efecto visible
-- hasta que corría el cron de las 03:20.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.vincular_lk_ch(text[]);

CREATE OR REPLACE FUNCTION public.vincular_lk_ch(p_cod_lk text, p_cod_chef text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_link uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admins a WHERE a.auth_user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Solo admins pueden vincular clientes';
  END IF;
  IF COALESCE(btrim(p_cod_lk),'')='' OR COALESCE(btrim(p_cod_chef),'')='' THEN
    RAISE EXCEPTION 'Hacen falta un código de Loekemeyer y uno de Chef';
  END IF;

  -- Si cualquiera de los dos ya estaba vinculado, se reusa ese link para que
  -- los dos grupos queden en uno y no se pisen.
  SELECT link_id INTO v_link FROM clientes_lk_ch_links
  WHERE (cod_cliente = p_cod_lk AND empresa='lk')
     OR (cod_cliente = p_cod_chef AND empresa='chef')
  LIMIT 1;
  IF v_link IS NULL THEN v_link := gen_random_uuid(); END IF;

  INSERT INTO clientes_lk_ch_links (cod_cliente, empresa, link_id)
  VALUES (p_cod_lk,'lk',v_link), (p_cod_chef,'chef',v_link)
  ON CONFLICT (cod_cliente, empresa) DO UPDATE SET link_id = EXCLUDED.link_id;

  -- ANTES del RETURN: acá vivía un PERFORM inalcanzable y la cache no se
  -- refrescaba nunca al vincular.
  PERFORM refrescar_lk_ch_excluidos();

  RETURN v_link;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.vincular_lk_ch(text, text) TO authenticated;


-- ---------------------------------------------------------------------------
-- Deshace el vínculo manual: borra las dos filas del link. Los códigos vuelven
-- a agruparse solos por CUIT o razón social, o a quedar sueltos.
--
-- Refresca la cache antes de salir, igual que vincular_lk_ch, y por el mismo
-- motivo: hasta el 31/7/2026 el PERFORM estaba después del RETURN.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.desvincular_lk_ch(text);

CREATE OR REPLACE FUNCTION public.desvincular_lk_ch(p_cod_lk text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_link uuid; v_n int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admins a WHERE a.auth_user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Solo admins pueden desvincular clientes';
  END IF;
  SELECT link_id INTO v_link FROM clientes_lk_ch_links
  WHERE cod_cliente = p_cod_lk AND empresa='lk';
  IF v_link IS NULL THEN RETURN 0; END IF;
  DELETE FROM clientes_lk_ch_links WHERE link_id = v_link;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  -- ANTES del RETURN: acá vivía un PERFORM inalcanzable y la cache no se
  -- refrescaba nunca al desvincular.
  PERFORM refrescar_lk_ch_excluidos();

  RETURN v_n;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.desvincular_lk_ch(text) TO authenticated;
