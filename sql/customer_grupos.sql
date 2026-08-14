-- Tabla: customer_grupos  (+ RPCs de la vista "Clientes agrupados")
--
-- Agrupa códigos de cliente que son el MISMO cliente real con distinta razón
-- social. Pasa seguido: el cliente cierra una sociedad y sigue comprando con
-- otra. Sin agrupar, el código viejo figura en Ranking Inactivos con todo su
-- histórico mientras el nuevo compra normalmente — o sea, aparece como una
-- oportunidad de reconquista que no existe.
--
-- Medido antes de construir esto: 44 inactivos tenían un cliente ACTIVO con la
-- razón social idéntica, arrastrando $32,8 millones mal atribuidos. Y no se
-- puede deducir solo: no hay CUITs repetidos (cada razón social tiene el suyo)
-- y la similitud de nombres da falsos positivos evidentes ("Distribuidora
-- Veneto" vs "Distribuidora Pezzali"). Por eso el alta la confirma una persona
-- y la similitud queda como sugerencia.
--
-- Alcance: los grupos son SOLO entre clientes. El vendedor no interviene.
--
-- MODELO
-- Una fila por código. Todos los del mismo grupo comparten grupo_id, y
-- exactamente uno lleva es_vigente = true: es la razón social con la que el
-- cliente compra hoy y la que absorbe el histórico en el ranking.
--
-- Se eligió grupo_id + flag y no una tabla de sucesión (viejo -> nuevo) para
-- que un cliente con tres o más razones sociales sea un solo grupo, y para que
-- cambiar cuál es la vigente no obligue a rehacer las relaciones.
--
-- UN GRUPO ES SIEMPRE DENTRO DE UNA EMPRESA
-- La clave primaria es (cod_cliente, empresa), no cod_cliente solo: las
-- numeraciones de Loekemeyer y de Chef son INDEPENDIENTES y el mismo número es
-- un negocio distinto en cada una (el código 2502 es "Filippi Navier (Ex
-- Jauregui)" en Loekemeyer y "Gonzagerodia S.A." en Chef). Agrupar mezclando
-- las dos juntaría clientes que no tienen nada que ver.
--
-- Los grupos de Chef todavía no tienen consecuencia propia —no hay ranking de
-- Chef— pero existen igual, porque hacen que vincular UNA razón social alcance
-- para todo el grupo (ver sql/clientes_lk_ch.sql).
--
-- AGRUPAR NO ES VINCULAR. Agrupar es juntar razones sociales DENTRO de una
-- empresa; vincular es decir que un cliente de Loekemeyer y uno de Chef son el
-- mismo. Son cosas distintas y viven en archivos distintos: lo de cruzar
-- empresas está en sql/clientes_lk_ch.sql.

CREATE TABLE IF NOT EXISTS public.customer_grupos (
  cod_cliente text NOT NULL,
  grupo_id uuid NOT NULL,
  es_vigente boolean NOT NULL DEFAULT false,
  nota text,
  creado_por uuid DEFAULT auth.uid(),
  creado_at timestamptz NOT NULL DEFAULT now(),
  empresa text NOT NULL DEFAULT 'lk' CHECK (empresa IN ('lk', 'chef')),
  PRIMARY KEY (cod_cliente, empresa)
);

COMMENT ON TABLE public.customer_grupos IS
  'Agrupa códigos de cliente que son el MISMO cliente real con distinta razón social. Uno por grupo lleva es_vigente=true y absorbe el histórico de los demás en Ranking Inactivos.';

CREATE INDEX IF NOT EXISTS customer_grupos_grupo_idx
  ON public.customer_grupos (grupo_id);

-- Un solo vigente por grupo. Si no, get_ranking_inactivos duplicaría el
-- histórico: cada miembro mapearía a dos canónicos y el join multiplicaría filas.
--
-- OJO al modificar a mano: es un índice único NO diferible, así que un
-- `UPDATE ... SET es_vigente = (cod_cliente = 'X')` sobre todo el grupo falla —
-- durante la sentencia hay dos filas en true. Hay que hacerlo en dos pasos
-- (apagar todas, prender una). guardar_customer_grupo no tiene el problema
-- porque borra e inserta.
CREATE UNIQUE INDEX IF NOT EXISTS customer_grupos_un_vigente_idx
  ON public.customer_grupos (grupo_id)
  WHERE es_vigente;

ALTER TABLE public.customer_grupos ENABLE ROW LEVEL SECURITY;

-- Solo admins, mismo criterio que el resto del panel
DROP POLICY IF EXISTS customer_grupos_admin_all ON public.customer_grupos;
CREATE POLICY customer_grupos_admin_all
  ON public.customer_grupos
  FOR ALL
  TO authenticated
  USING (EXISTS (SELECT 1 FROM admins a WHERE a.auth_user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM admins a WHERE a.auth_user_id = auth.uid()));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.customer_grupos TO authenticated;


-- ---------------------------------------------------------------------------
-- Guardar (crear o ampliar) un grupo.
-- Si alguno de los códigos ya pertenece a un grupo, se FUSIONAN todos en uno
-- solo: así marcar A→B y después B→C deja {A,B,C} y no dos grupos sueltos que
-- se pisarían entre sí en el ranking.
--
-- SECURITY DEFINER saltea RLS, así que el chequeo de admin va explícito adentro.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guardar_customer_grupo(p_cods text[], p_cod_vigente text, p_nota text DEFAULT NULL::text, p_empresa text DEFAULT 'lk'::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_grupo uuid; v_todos text[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admins a WHERE a.auth_user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Solo admins pueden administrar grupos de clientes';
  END IF;
  IF p_cods IS NULL OR array_length(p_cods,1) < 2 THEN
    RAISE EXCEPTION 'Un grupo necesita al menos 2 razones sociales';
  END IF;
  IF p_cod_vigente IS NULL OR NOT (p_cod_vigente = ANY (p_cods)) THEN
    RAISE EXCEPTION 'La razón social principal tiene que ser una de las del grupo';
  END IF;

  -- Arrastra a los miembros de cualquier grupo de la MISMA empresa que ya toque
  -- alguno de estos códigos, para no dejarlo partido a la mitad.
  SELECT array_agg(DISTINCT cod) INTO v_todos FROM (
    SELECT unnest(p_cods) AS cod
    UNION
    SELECT g.cod_cliente FROM customer_grupos g
    WHERE g.empresa = p_empresa AND g.grupo_id IN (
      SELECT g2.grupo_id FROM customer_grupos g2
      WHERE g2.empresa = p_empresa AND g2.cod_cliente = ANY (p_cods))
  ) t;

  SELECT g.grupo_id INTO v_grupo FROM customer_grupos g
  WHERE g.empresa = p_empresa AND g.cod_cliente = ANY (v_todos) LIMIT 1;
  IF v_grupo IS NULL THEN v_grupo := gen_random_uuid(); END IF;

  DELETE FROM customer_grupos WHERE empresa = p_empresa AND cod_cliente = ANY (v_todos);
  INSERT INTO customer_grupos (cod_cliente, empresa, grupo_id, es_vigente, nota)
  SELECT c, p_empresa, v_grupo, (c = p_cod_vigente), p_nota FROM unnest(v_todos) AS c;

  PERFORM refrescar_lk_ch_excluidos();
  RETURN v_grupo;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.guardar_customer_grupo(text[], text, text, text) TO authenticated;


-- ---------------------------------------------------------------------------
-- Sacar un código del grupo. Si quedan menos de 2 miembros, el grupo se
-- disuelve entero: un "grupo" de uno no agrupa nada.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.quitar_de_customer_grupo(p_cod text, p_empresa text DEFAULT 'lk'::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_grupo uuid; v_quedan int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admins a WHERE a.auth_user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Solo admins pueden administrar grupos de clientes';
  END IF;
  SELECT grupo_id INTO v_grupo FROM customer_grupos
  WHERE cod_cliente = p_cod AND empresa = p_empresa;
  -- Sin grupo no se tocó nada, así que tampoco hay cache que refrescar.
  IF v_grupo IS NULL THEN RETURN; END IF;

  DELETE FROM customer_grupos WHERE cod_cliente = p_cod AND empresa = p_empresa;
  SELECT count(*) INTO v_quedan FROM customer_grupos WHERE grupo_id = v_grupo;

  -- Antes esta rama salía con un RETURN propio. Se pasó a ELSIF para que el
  -- refresco de abajo lo alcancen TODOS los caminos que modificaron algo.
  IF v_quedan < 2 THEN
    DELETE FROM customer_grupos WHERE grupo_id = v_grupo;

  -- Si se fue el principal, el grupo queda sin canónico: se promueve al de
  -- compra más reciente, que es el criterio con el que se arma el grupo.
  ELSIF NOT EXISTS (SELECT 1 FROM customer_grupos WHERE grupo_id = v_grupo AND es_vigente) THEN
    UPDATE customer_grupos g SET es_vigente = true
    WHERE g.grupo_id = v_grupo AND g.cod_cliente = (
      SELECT g2.cod_cliente FROM customer_grupos g2
      -- Un solo llamado a datos_cliente_empresa, acotado a los códigos del
      -- grupo. Antes era un LATERAL, o sea una invocación POR MIEMBRO: para un
      -- grupo de 5 eran 5 resoluciones del padrón entero.
      LEFT JOIN datos_cliente_empresa(p_empresa,
                  ARRAY(SELECT g3.cod_cliente FROM customer_grupos g3
                        WHERE g3.grupo_id = v_grupo)) d ON d.cod = g2.cod_cliente
      WHERE g2.grupo_id = v_grupo
      ORDER BY d.ult DESC NULLS LAST, g2.cod_cliente LIMIT 1);
  END IF;

  PERFORM refrescar_lk_ch_excluidos();
END;
$function$;

GRANT EXECUTE ON FUNCTION public.quitar_de_customer_grupo(text, text) TO authenticated;


-- ---------------------------------------------------------------------------
-- Los grupos ya armados, una fila por miembro, con lo necesario para decidir:
-- razón social, dirección de entrega, última compra y valor histórico neto a
-- precios de hoy (mismo criterio que Ranking Inactivos: solo artículos
-- vigentes, neto de dto_vol y del descuento web).
-- ---------------------------------------------------------------------------
-- El DROP hace falta porque se agregó `direccion` al RETURNS TABLE y Postgres
-- no deja cambiar el tipo de retorno con un CREATE OR REPLACE.
DROP FUNCTION IF EXISTS public.get_customer_grupos();
DROP FUNCTION IF EXISTS public.get_customer_grupos(text);

CREATE OR REPLACE FUNCTION public.get_customer_grupos(p_empresa text DEFAULT NULL::text)
 RETURNS TABLE(grupo_id uuid, empresa text, cod_cliente text, business_name text, cuit text, direccion text, es_vigente boolean, nota text, last_date date, valor_historico numeric, creado_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  -- Se le pasan a datos_cliente_empresa SOLO los códigos que están agrupados.
  -- Antes resolvía el padrón entero de las DOS empresas —1.302 clientes,
  -- agregando sobre sales_lines— para después quedarse con los 7 códigos que
  -- tienen grupo: 555 ms para devolver 7 filas, contra 91 ms así.
  WITH d AS (
    SELECT 'lk'::text AS empresa, *
    FROM datos_cliente_empresa('lk',
      ARRAY(SELECT g.cod_cliente FROM customer_grupos g WHERE g.empresa = 'lk'))
    UNION ALL
    SELECT 'chef'::text, *
    FROM datos_cliente_empresa('chef',
      ARRAY(SELECT g.cod_cliente FROM customer_grupos g WHERE g.empresa = 'chef'))
  )
  SELECT g.grupo_id, g.empresa, g.cod_cliente,
         COALESCE(d.nom,''), COALESCE(d.cuit,''), COALESCE(d.dir,''),
         g.es_vigente, g.nota,
         to_date(d.ult,'YYYY-MM-DD'), COALESCE(d.valor,0), g.creado_at
  FROM customer_grupos g
  LEFT JOIN d ON d.empresa = g.empresa AND d.cod = g.cod_cliente
  WHERE p_empresa IS NULL OR g.empresa = p_empresa
  ORDER BY g.empresa, g.grupo_id, g.es_vigente DESC, g.cod_cliente;
$function$;

GRANT EXECUTE ON FUNCTION public.get_customer_grupos(text) TO authenticated;


-- ---------------------------------------------------------------------------
-- Normaliza una razón social para comparar: sin acentos, sin puntuación, en
-- minúsculas y sin la forma jurídica del final (S.A., S.R.L., ...). Así
-- "Bazares Del Sur Srl" y "Bazares del Sur SRL" caen en la misma clave.
-- No usa unaccent (la extensión no está instalada) sino translate.
--
-- Saca tanto las abreviadas (S.A., S.R.L., SAS) como las escritas en palabras
-- ("Sociedad Anonima", "Sociedad De Responsabilidad Limitada"). Sin esto la
-- similitud las tomaba como parecido real: "Inc Sociedad Anonima" y "Sajel
-- Sociedad Anonima" daban 0,65 por compartir dos de tres palabras, y se
-- sugerían como el mismo cliente siendo empresas distintas. Normalizadas dan 0.
--
-- NO se sacan "hnos" ni "y cia": son parte del nombre y sacarlos fusionaría
-- empresas distintas.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.norm_razon_social(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT btrim(regexp_replace(
           regexp_replace(
             regexp_replace(
               lower(regexp_replace(
                 translate(COALESCE(p, ''),
                   'ÁÀÄÂÉÈËÊÍÌÏÎÓÒÖÔÚÙÜÛÑÇáàäâéèëêíìïîóòöôúùüûñç',
                   'AAAAEEEEIIIIOOOOUUUUNCaaaaeeeeiiiioooouuuunc'),
                 '[^A-Za-z0-9]+', ' ', 'g')),
               '\s+(sociedad de responsabilidad limitada|sociedad anonima|sociedad colectiva)\s*',
               ' ', 'g'),
             '\s+(s a s|s r l|s c a|s a|sas|srl|sca|scs|sa|ltda|cif)\s*$', '', 'g'),
           '\s+', ' ', 'g'));
$function$;

GRANT EXECUTE ON FUNCTION public.norm_razon_social(text) TO authenticated;


-- ---------------------------------------------------------------------------
-- Universo completo de códigos para el buscador de la vista.
--
-- POR QUÉ NO ALCANZA customers: 236 de los 1233 códigos del ERP no tienen
-- ficha, y son justamente los códigos viejos que se dieron de baja al cambiar
-- de razón social — la mitad interesante de cada par. La primera versión del
-- buscador leía un catálogo cacheado de customers y por eso no encontraba, por
-- ejemplo, el 1537 (218 líneas de venta, cero filas en customers): buscando
-- "1447" aparecía su par pero buscando "1537" no aparecía nada.
--
-- Hoy no lee sales_lines ni customers directo: sale todo de
-- datos_cliente_empresa(p_empresa), que es la fuente única de identidad y
-- métricas por cliente (código, razón social, CUIT, dirección de entrega,
-- última compra y valor histórico neto) resuelta contra el padrón que
-- corresponde — customers + Wpp_Clientes para lk, chef_padron para chef.
-- La usan también las sugerencias y get_customer_grupos, justamente para que
-- los tres no diverjan. Vive en sql/clientes_lk_ch.sql, que es donde está todo
-- lo que sabe de las dos empresas.
--
-- El buscador trabaja DENTRO de una empresa (p_empresa), y por eso la columna
-- `empresas` devuelve ese mismo valor y no una lista: no tiene sentido buscar
-- en las dos a la vez cuando un grupo nunca las cruza. Las numeraciones son
-- independientes, así que el mismo número en la otra empresa es otro negocio y
-- mostrarlo solo confundiría.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.buscar_clientes_para_grupo(p_q text DEFAULT ''::text, p_limit integer DEFAULT 30, p_empresa text DEFAULT 'lk'::text)
 RETURNS TABLE(cod_cliente text, business_name text, cuit text, last_date date, valor_historico numeric, empresas text, ya_agrupado boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  SELECT d.cod, d.nom, COALESCE(d.cuit,''), to_date(d.ult,'YYYY-MM-DD'), d.valor,
         p_empresa,
         EXISTS (SELECT 1 FROM customer_grupos g
                 WHERE g.cod_cliente = d.cod AND g.empresa = p_empresa)
  FROM datos_cliente_empresa(p_empresa) d
  WHERE COALESCE(btrim(p_q),'') = ''
     OR d.cod ILIKE '%'||btrim(p_q)||'%'
     OR d.nom ILIKE '%'||btrim(p_q)||'%'
     OR COALESCE(d.cuit,'') LIKE '%'||regexp_replace(COALESCE(p_q,''),'[^0-9]','','g')||'%'
  ORDER BY (d.cod = btrim(p_q)) DESC, d.ult DESC NULLS LAST, d.cod
  LIMIT GREATEST(p_limit,1);
$function$;

GRANT EXECUTE ON FUNCTION public.buscar_clientes_para_grupo(text, int, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- Palabras que NO sirven para deducir que dos razones sociales son el mismo
-- cliente, aunque aparezcan en pocas fichas. Las consume el origen 'apellido'
-- de sugerir_customer_grupos.
--
-- Son dos familias, y sin las dos la señal por apellido es inservible:
--   'rubro'  palabras del oficio (gastronomia, plastico, supermercado…). Que
--            aparezcan en 2 o 3 clientes no dice nada: son genéricas.
--   'nombre' nombres de pila. Medido: la mayoría de las palabras raras del
--            padrón son nombres, no apellidos, y emparejaban gente sin relación
--            ("Cequeira Agustin" con "Chemello Federico Agustin").
--
-- Es una tabla y no una lista fija en la función a propósito: cuando una
-- sugerencia salga mal por una palabra, se agrega acá y deja de proponerse, sin
-- tocar código. Al revés también: si bloquea un apellido real (hay apellidos
-- que son también nombres de pila, como Bruno o Celestino), se borra la fila.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tokens_no_distintivos (
  token  text PRIMARY KEY,
  motivo text NOT NULL DEFAULT 'rubro'
);

COMMENT ON TABLE public.tokens_no_distintivos IS
  'Palabras que el origen "apellido" de sugerir_customer_grupos ignora: genéricas del rubro y nombres de pila.';

ALTER TABLE public.tokens_no_distintivos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tokens_no_distintivos_lectura ON public.tokens_no_distintivos;
CREATE POLICY tokens_no_distintivos_lectura
  ON public.tokens_no_distintivos FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS tokens_no_distintivos_admin ON public.tokens_no_distintivos;
CREATE POLICY tokens_no_distintivos_admin
  ON public.tokens_no_distintivos FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM admins a WHERE a.auth_user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM admins a WHERE a.auth_user_id = auth.uid()));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.tokens_no_distintivos TO authenticated;

INSERT INTO public.tokens_no_distintivos (token, motivo)
SELECT t, 'rubro' FROM unnest(ARRAY[
  'bazar','bazares','gastronomia','gastronomico','gastronomica','gastronomicos',
  'comercial','comerciales','comercio','limpieza','plastico','plasticos','plastic',
  'plast','supermercado','supermercados','autoservicio','tienda','tiendas','mundo',
  'linea','lineas','hogar','grande','grandes','equipamiento','equipamientos',
  'distribuidora','distribuidor','distribuciones','import','importadora',
  'importaciones','mayorista','mayoristas','deposito','sucursal','central',
  'nuevo','nueva','santa','santo','buenos','aires','argentina','argentino',
  'hijos','hermanos','hermano','nietos','sucesion','sucesores','sociedad',
  'anonima','responsabilidad','limitada','colectiva','todo','todos','casa',
  'palacio','rincon','empresa','servicios','soluciones','productos','articulos',
  'descartables','embalajes','packaging','ferreteria','regalos','juguetes',
  'textil','hoteleria','catering','restaurant','restaurante','pizzeria',
  'panaderia','heladeria','confiteria','kiosco','almacen','minimercado',
  'express','center','market','shop','store','hiper','super','mega','global',
  'integral','universal','moderna','moderno','ideal','familia','amigos',
  'cocina','cocinas','mesa','utensilios','menaje','vajilla','blanco','blanca',
  'norte','sur','este','oeste','centro','ciudad','pueblo','villa','barrio'
]) AS t
ON CONFLICT (token) DO NOTHING;

INSERT INTO public.tokens_no_distintivos (token, motivo)
SELECT t, 'nombre' FROM unnest(ARRAY[
  'agustin','agustina','alejandra','alejandro','alberto','alfredo','alicia',
  'analia','andrea','andres','angela','angel','antonio','ariel','armando',
  'arturo','beatriz','benjamin','bernardo','carlos','carolina','carmen',
  'cecilia','cesar','cintia','claudia','claudio','cristian','cristina',
  'daniel','daniela','dario','david','debora','diego','edgardo','eduardo',
  'elena','elizabeth','emilia','emiliano','enrique','ernesto','esteban',
  'ezequiel','fabian','fabiana','facundo','federico','felipe','fernanda',
  'fernando','florencia','francisco','gabriel','gabriela','gaston','gerardo',
  'german','gisela','giselle','gonzalo','graciela','gregorio','guillermo',
  'gustavo','hector','helena','hernan','horacio','ignacio','isabel',
  'javier','jorge','josefina','juana','julian','juliana','julieta','laura',
  'leandro','leonardo','leticia','liliana','lorena','lucas','lucia','luciana',
  'luciano','mabel','marcela','marcelo','marcos','margarita','maria','mariana',
  'mariano','maricel','marina','mario','marta','martin','martina','matias',
  'mauricio','maximiliano','mercedes','miguel','mirta','moises','monica',
  'nadia','natalia','nelida','nestor','nicolas','noelia','noemi','norberto',
  'norma','olga','orlando','oscar','osvaldo','pablo','pamela','patricia',
  'patricio','paula','pedro','rafael','ramiro','ramon','raul','rebeca',
  'ricardo','roberto','rodolfo','rodrigo','rolando','romina','rosana',
  'rosario','ruben','sandra','santiago','sebastian','sergio','silvana',
  'silvia','simon','sofia','soledad','sonia','stella','susana','teresa',
  'tomas','valeria','vanesa','vanina','veronica','victor','victoria',
  'virginia','walter','ximena','yamila','zulema',
  -- agregados después de mirar las primeras sugerencias por apellido: estos
  -- estaban emparejando personas sin relación
  'jonatan','jonathan','dante','augusto','isaac','bruno','emmanuel','nahuel',
  'brian','kevin','jesus','joaquin','damian','adrian','franco','thiago',
  'lautaro','valentin','mateo','benicio','elias','ismael','celestino','ching',
  'jacqueline','venancio','vladimir','lisandro','jonas','ariadna','melina',
  'micaela','milagros','abigail','camila','catalina','delfina','guadalupe',
  'josue','leandra','lucila','magali','malena','morena','priscila','rocio',
  'selena','tatiana','yesica','yohana','denise','evelyn','ingrid','karina',
  'lourdes','marisa','miriam','nancy','paola','roxana','sabrina','vanessa',
  'viviana','osmar','ovidio','pascual','plinio','remigio','rufino',
  'salvador','samuel','saul','severino','teodoro','ubaldo','urbano','wenceslao'
]) AS t
ON CONFLICT (token) DO NOTHING;


-- ---------------------------------------------------------------------------
-- Sugerencias de agrupamiento, de CUALQUIER cantidad de razones sociales.
--
-- CAMBIO DE MODELO: antes cada origen armaba sus clusters por separado y con
-- prioridad entre sí, así que un código que ya había caído en un cluster
-- quedaba fuera de las demás pasadas. Eso hacía perder casos reales: los tres
-- Colucci se agrupaban por dirección compartida y, justamente por estar ya
-- agrupados, nunca se los comparaba con "Bazar Colucci S.A.", que está en la
-- misma familia pero tiene otra dirección registrada.
--
-- Ahora cada señal produce ARISTAS entre códigos y el cluster es la componente
-- conexa. Un mismo grupo puede llegar por varias señales a la vez y se arma
-- completo.
--
-- Señales (cada una genera aristas):
--   'cuit'       mismo CUIT. Es la más fuerte de todas: dentro de una MISMA
--                empresa, dos códigos con el mismo CUIT son la misma persona
--                jurídica, no un parecido. (Entre empresas distintas el CUIT
--                también vincula, pero eso es otra cosa y va por
--                sql/clientes_lk_ch.sql.)
--   'nombre'     misma razón social normalizada (norm_razon_social)
--   'direccion'  misma dirección de entrega, con tope de p_max_dir códigos:
--                los depósitos de expreso concentran más de cien clientes cada
--                uno (Pergamino 3751 tiene 135, Virgilio 2788 110) y sin el
--                tope el módulo se llena de clusters de cien.
--   'apellido'   comparten una palabra POCO común (hasta p_max_tok clientes).
--                Ignora las de tokens_no_distintivos: sin ese filtro la señal
--                es inservible, porque la mayoría de las palabras raras del
--                padrón son nombres de pila y palabras de rubro, no apellidos.
--   'similitud'  nombres parecidos por trigramas (>= p_min_sim), solo entre un
--                activo y un inactivo, que es el caso que interesa.
--
-- Un cluster se sugiere solo si tiene al menos un miembro INACTIVO: si todos
-- compran, agruparlos no cambia nada en el ranking. Y se descartan los de más
-- de p_max_grupo miembros: a esa altura es una cadena de coincidencias flojas
-- y no un cliente.
--
-- El `origen` que sale puede venir COMBINADO (`apellido+direccion`): como el
-- cluster es la componente conexa, se agregan todos los orígenes de sus
-- aristas separados por '+'. El frontend lo parte por ese carácter para
-- mostrar un chip por señal.
--
-- Sugiere DENTRO de una sola empresa (p_empresa), sobre
-- datos_cliente_empresa(p_empresa). Antes miraba solo Loekemeyer con un
-- `bool_or(sl.empresa = 'lk')` fijo. Un grupo nunca cruza empresas: las
-- numeraciones son independientes y el mismo número es otro negocio en la otra.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.sugerir_customer_grupos(int, real, int);
DROP FUNCTION IF EXISTS public.sugerir_customer_grupos(int, real, int, int);
DROP FUNCTION IF EXISTS public.sugerir_customer_grupos(int, real, int, int, int, int);

CREATE OR REPLACE FUNCTION public.sugerir_customer_grupos(p_meses integer DEFAULT 12, p_min_sim real DEFAULT 0.62, p_limit integer DEFAULT 60, p_max_dir integer DEFAULT 3, p_max_tok integer DEFAULT 3, p_max_grupo integer DEFAULT 5, p_empresa text DEFAULT 'lk'::text)
 RETURNS TABLE(clave text, empresa text, origen text, miembros jsonb, valor_en_juego numeric, sugerido_vigente text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  WITH RECURSIVE cutoff AS (
    SELECT to_char(CURRENT_DATE - (p_meses || ' months')::interval, 'YYYY-MM-DD') AS c
  ),
  det AS (
    SELECT d.*, NULLIF(norm_razon_social(d.nom),'') AS k,
           NULLIF(norm_razon_social(d.dir),'') AS k_dir,
           (d.ult >= (SELECT c FROM cutoff)) AS activo
    FROM datos_cliente_empresa(p_empresa) d
    WHERE btrim(COALESCE(d.nom,'')) <> ''
      AND NOT EXISTS (SELECT 1 FROM customer_grupos g
                      WHERE g.cod_cliente = d.cod AND g.empresa = p_empresa)
  ),
  ar_cuit AS (
    SELECT a.cod AS x, b.cod AS y, 'cuit'::text AS origen
    FROM det a JOIN det b ON b.cuit = a.cuit AND b.cod <> a.cod
    WHERE a.cuit IS NOT NULL
  ),
  ar_nombre AS (
    SELECT a.cod, b.cod, 'nombre'::text
    FROM det a JOIN det b ON b.k = a.k AND b.cod <> a.cod
    WHERE a.k IS NOT NULL
  ),
  claves_dir AS (
    SELECT k_dir FROM det WHERE k_dir IS NOT NULL
    GROUP BY k_dir HAVING count(*) > 1 AND count(*) <= GREATEST(p_max_dir,2)
  ),
  ar_dir AS (
    SELECT a.cod, b.cod, 'direccion'::text
    FROM det a JOIN claves_dir cd ON cd.k_dir = a.k_dir
    JOIN det b ON b.k_dir = a.k_dir AND b.cod <> a.cod
  ),
  tok AS (
    SELECT d.cod, t.token
    FROM det d, LATERAL unnest(string_to_array(d.k,' ')) AS t(token)
    WHERE d.k IS NOT NULL AND length(t.token) >= 5
      AND NOT EXISTS (SELECT 1 FROM tokens_no_distintivos tn WHERE tn.token = t.token)
  ),
  tok_raro AS (
    SELECT token FROM tok GROUP BY token
    HAVING count(DISTINCT cod) BETWEEN 2 AND GREATEST(p_max_tok,2)
  ),
  ar_tok AS (
    SELECT DISTINCT a.cod, b.cod, 'apellido'::text
    FROM tok a JOIN tok_raro r ON r.token = a.token
    JOIN tok b ON b.token = a.token AND b.cod <> a.cod
  ),
  -- SIMILITUD DE NOMBRES. Esta señal era el 97% del costo de la función: un
  -- nested loop de 971x971 = 942.841 llamadas a similarity() que producía 8
  -- aristas, y cuadrático en el tamaño del padrón. Se reemplazó por un índice
  -- invertido de trigramas:
  --   similarity() de pg_trgm ES el Jaccard sobre los trigramas de show_trgm(),
  --   o sea |A∩B| / (|A| + |B| - |A∩B|). Contando los trigramas compartidos con
  --   un JOIN por trigrama se obtiene el MISMO número sin llamar a la función.
  -- Verificado sobre los 102.215 pares que comparten al menos un trigrama:
  -- diferencia máxima 2,8e-8 (redondeo float4/float8), 0 pares por encima de
  -- 1e-6, y las dos vías devuelven los mismos 4 pares.
  -- Medido: 2.341 ms el nested loop contra ~290 ms por trigramas.
  simcand AS (
    SELECT cod, k, activo, COALESCE(array_length(show_trgm(k),1), 0) AS nt
    FROM det WHERE k IS NOT NULL
  ),
  trg AS MATERIALIZED (
    SELECT cod, activo, nt, unnest(show_trgm(k)) AS g FROM simcand
  ),
  -- Los pares que NO comparten ningún trigrama tienen similitud 0, así que no
  -- hace falta enumerarlos: quedan afuera del JOIN y no cuestan nada.
  comunes AS (
    SELECT a.cod AS ca, b.cod AS ci,
           count(*)::numeric AS comp, max(a.nt) AS na, max(b.nt) AS ni
    FROM trg a JOIN trg b ON b.g = a.g
    WHERE a.activo AND NOT b.activo
    GROUP BY a.cod, b.cod
  ),
  -- El CASE no es cosmético: fuerza el orden de evaluación. Postgres no sabe
  -- que similarity() es cara (procost 1) y si se la deja suelta en el WHERE la
  -- evalúa ANTES del prefiltro, sobre los 102k pares — que es justo lo que se
  -- quería evitar. El margen de 0,001 cubre el redondeo float4/float8; la
  -- definición que manda sigue siendo similarity().
  sim_par AS (
    SELECT c.ca, c.ci
    FROM comunes c
    JOIN simcand x ON x.cod = c.ca
    JOIN simcand y ON y.cod = c.ci
    WHERE CASE
            WHEN c.comp / (c.na + c.ni - c.comp) >= p_min_sim::numeric - 0.001
            THEN similarity(x.k, y.k) >= p_min_sim
            ELSE false
          END
  ),
  -- El grafo es no dirigido: se emiten las dos direcciones. Son 4 filas, así
  -- que recorrer sim_par dos veces no cuesta nada.
  ar_sim AS (
    SELECT ca, ci, 'similitud'::text FROM sim_par
    UNION ALL
    SELECT ci, ca, 'similitud'::text FROM sim_par
  ),
  -- MATERIALIZED no es opcional: `aristas` se referencia una sola vez (desde el
  -- término recursivo de `alcance`), así que Postgres la inlinearía y la
  -- recalcularía en CADA iteración.
  aristas AS MATERIALIZED (
    SELECT * FROM ar_cuit UNION ALL SELECT * FROM ar_nombre
    UNION ALL SELECT * FROM ar_dir UNION ALL SELECT * FROM ar_tok
    UNION ALL SELECT * FROM ar_sim
  ),
  -- Componentes conexas por alcance transitivo. Antes esto eran CUATRO pasadas
  -- fijas de propagación del código mínimo, y ahí había una bomba de tiempo: la
  -- propagación necesita tantas pasadas como el DIÁMETRO de la componente, y
  -- una cadena de 5 nodos ya tiene diámetro 4. O sea que el tope p_max_grupo=5
  -- y las 4 pasadas estaban empatados, sin margen.
  -- Si aparecía una componente grande con forma de cadena, las 4 pasadas no le
  -- alcanzaban y la partían en pedazos; cada pedazo de <= 5 pasaba el filtro de
  -- abajo y se mostraba como una sugerencia SEPARADA. Dos grupos que deberían
  -- ser uno, sin ningún código repetido entre ellos, o sea invisible para
  -- cualquier chequeo de duplicados.
  -- La versión recursiva converge siempre, sin importar la forma del grafo.
  alcance AS (
    SELECT d.cod AS raiz, d.cod AS cod FROM det d
    UNION
    SELECT r.raiz, a.y FROM alcance r JOIN aristas a ON a.x = r.cod
  ),
  -- Un código sale con UNA sola etiqueta (GROUP BY cod), que es lo que
  -- garantiza que no pueda caer en dos grupos sugeridos a la vez.
  comp AS (
    SELECT cod, MIN(raiz) AS lab FROM alcance GROUP BY cod
  ),
  orig AS (
    SELECT c.lab, string_agg(DISTINCT a.origen,'+' ORDER BY a.origen) AS origenes
    FROM comp c JOIN aristas a ON a.x = c.cod GROUP BY c.lab
  ),
  armado AS (
    SELECT c.lab AS clave, MIN(o.origenes) AS origen,
           jsonb_agg(jsonb_build_object(
             'cod', d.cod, 'nombre', d.nom, 'cuit', COALESCE(d.cuit,''),
             'last_date', d.ult, 'valor', d.valor, 'activo', d.activo,
             'direccion', COALESCE(d.dir,'')
           ) ORDER BY d.ult DESC NULLS LAST, d.cod) AS miembros,
           SUM(CASE WHEN d.activo THEN 0 ELSE d.valor END) AS valor_en_juego,
           count(*) AS n,
           count(*) FILTER (WHERE NOT d.activo) AS n_inactivos,
           string_agg(d.cod, ',' ORDER BY d.cod) AS codigos,
           (ARRAY_AGG(d.cod ORDER BY d.ult DESC NULLS LAST, d.cod))[1] AS sug_vigente
    FROM comp c JOIN det d ON d.cod = c.cod
    LEFT JOIN orig o ON o.lab = c.lab
    GROUP BY c.lab
  )
  SELECT a.clave, p_empresa, a.origen, a.miembros, a.valor_en_juego, a.sug_vigente
  FROM armado a
  WHERE a.n > 1 AND a.n <= GREATEST(p_max_grupo,2) AND a.n_inactivos > 0
    AND NOT EXISTS (
      SELECT 1 FROM sugerencias_rechazadas r
      WHERE r.empresa = p_empresa AND r.clave = a.codigos
    )
  ORDER BY a.valor_en_juego DESC, a.clave
  LIMIT GREATEST(p_limit,1);
$function$;

GRANT EXECUTE ON FUNCTION public.sugerir_customer_grupos(int, real, int, int, int, int, text) TO authenticated;


-- ---------------------------------------------------------------------------
-- Deshacer un grupo entero: borra todas sus filas y cada razón social vuelve a
-- contar por separado en Ranking Inactivos. Es totalmente reversible — no se
-- toca ningún dato de venta, solo el vínculo.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.deshacer_customer_grupo(p_grupo_id uuid)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_n int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admins a WHERE a.auth_user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Solo admins pueden administrar grupos de clientes';
  END IF;

  DELETE FROM customer_grupos WHERE grupo_id = p_grupo_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  PERFORM refrescar_lk_ch_excluidos();
  RETURN v_n;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.deshacer_customer_grupo(uuid) TO authenticated;


-- ---------------------------------------------------------------------------
-- Sugerencias descartadas a mano.
--
-- Se guardan para que no vuelvan a aparecer en cada carga; el botón "Refrescar"
-- del módulo borra las de esa empresa y las vuelve a proponer, por si cambiaron
-- los datos y ahora sí tienen sentido.
--
-- La clave es la LISTA DE CÓDIGOS ordenada, no el id del cluster: ese id se
-- deriva del código mínimo de la componente y cambiaría si el grupo gana o
-- pierde un miembro. Con la lista, rechazar {A,B,C} no silencia a {A,B,C,D},
-- que es una propuesta distinta y merece revisarse de nuevo.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.sugerencias_rechazadas (
  clave         text NOT NULL,
  empresa       text NOT NULL CHECK (empresa IN ('lk','chef')),
  rechazado_por uuid DEFAULT auth.uid(),
  rechazado_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (clave, empresa)
);

COMMENT ON TABLE public.sugerencias_rechazadas IS
  'Sugerencias de agrupamiento descartadas a mano. La clave es la lista de códigos ordenada y separada por comas.';

ALTER TABLE public.sugerencias_rechazadas ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sugerencias_rechazadas_admin ON public.sugerencias_rechazadas;
CREATE POLICY sugerencias_rechazadas_admin ON public.sugerencias_rechazadas
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM admins a WHERE a.auth_user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM admins a WHERE a.auth_user_id = auth.uid()));
GRANT SELECT, INSERT, DELETE ON public.sugerencias_rechazadas TO authenticated;


CREATE OR REPLACE FUNCTION public.rechazar_sugerencia_grupo(p_cods text[], p_empresa text DEFAULT 'lk'::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admins a WHERE a.auth_user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Solo admins pueden rechazar sugerencias';
  END IF;
  INSERT INTO sugerencias_rechazadas (clave, empresa)
  SELECT array_to_string(ARRAY(SELECT unnest(p_cods) ORDER BY 1), ','), p_empresa
  ON CONFLICT (clave, empresa) DO NOTHING;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.rechazar_sugerencia_grupo(text[], text) TO authenticated;


-- Vuelve a proponer todo lo descartado de una empresa.
CREATE OR REPLACE FUNCTION public.limpiar_sugerencias_rechazadas(p_empresa text DEFAULT 'lk'::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_n int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admins a WHERE a.auth_user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Solo admins pueden administrar sugerencias';
  END IF;
  DELETE FROM sugerencias_rechazadas WHERE empresa = p_empresa;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.limpiar_sugerencias_rechazadas(text) TO authenticated;
