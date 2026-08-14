-- =====================================================================
--  precios_super — precios negociados por CADENA DE SUPERMERCADO y la
--  configuración de cada cadena.
--
--  Proyecto: kwkclwhmoygunqmlegrg (web LK). Ejecutar en el SQL Editor.
--
--  POR QUÉ ES UN ESQUEMA APARTE Y NO TABLAS EN `public`: son precios
--  negociados, el dato comercialmente más sensible del padrón. Viviendo
--  fuera de `public` no los alcanza PostgREST (que solo expone `public`),
--  así que NO hay forma de leerlos con la anon key ni con una sesión de
--  mayorista, ni siquiera por error de RLS. El único acceso es por las RPC
--  de abajo, que son `SECURITY DEFINER` + `is_admin()`.
--  ⚠ Buscarlos con `information_schema.tables where table_schema='public'`
--  no los encuentra. Es a propósito.
--
--  Un supermercado NO se pricea como el resto de los clientes:
--    cliente normal → list_price × uxb × (1 − dto_vol) × (1 − web_order_discount)
--    cadena         → precios_super.precio.price × uxb        ← SIN NINGÚN DESCUENTO
--  El precio de la cadena es final negociado. Un `customers.dto_vol = 0` en
--  Coto NO significa "Coto paga lista": significa que su condición no está
--  en `customers`, está acá. Valorizar una cadena con la fórmula del cliente
--  normal la sobreestima (medido en La Anónima: +12,9%).
--  La única excepción es `item_discount` (hoy solo Diarco, 0,10): esa cadena
--  compra al 90% de la lista de la cadena.
-- =====================================================================

create schema if not exists precios_super;

-- ── 1) Listas (una fila por cadena) ──────────────────────────────────
--  `lista_fecha` es la fecha de la NEGOCIACIÓN, no la de la carga.
--  `updated_at` es la de la carga. Confundirlas hace ver como fresca una
--  lista de hace un año: al migrar del xlsx todas quedaron con updated_at
--  2026-07-14 y lista_fecha de 2025 (o null).
create table if not exists precios_super.lista (
  super_key   text primary key,
  lista_fecha date,
  updated_at  timestamptz not null default now()
);

-- ── 2) Precios (una fila por cadena × artículo) ──────────────────────
--  `price` es POR UNIDAD, igual que products.list_price → para valorizar
--  una caja hay que multiplicar por products.uxb. `cod` matchea contra
--  products.cod / loke_products.cod por código canónico (ver norm_cod).
create table if not exists precios_super.precio (
  super_key text not null,
  cod       text not null,
  price     numeric not null,
  primary key (super_key, cod)
);

-- ── 2b) Histórico de precios (un snapshot por cadena × artículo × fecha) ─
--  `precios_super.precio` es solo la lista VIGENTE (set_super_prices la
--  reemplaza entera en cada carga). Para poder responder "¿cuánto subió tal
--  artículo en el año?" hace falta guardar cada lista con su fecha: eso es
--  esta tabla. La llena set_super_prices en cada carga; una fila por
--  (cadena, código, lista_fecha), así dos cargas del mismo día pisan (última
--  gana) y una por mes/negociación queda registrada. `lista_fecha` es la de
--  la lista (negociación, o la de carga si la hoja no trae fecha).
create table if not exists precios_super.precio_hist (
  super_key   text not null,
  cod         text not null,
  price       numeric not null,
  lista_fecha date not null,
  snapshot_at timestamptz not null default now(),
  primary key (super_key, cod, lista_fecha)
);

-- ── 3) Configuración por cadena (v2.x — antes hardcodeada en el JS) ──
--  Estaba en `admin-supercot.js` como siete objetos literales (SUPERS,
--  LK_CUSTOMER_COD, CHEF_CUSTOMER_COD, SUPER_PAYMENT_CODE, SUPER_PDF_RATIO,
--  SUPER_ITEM_DISCOUNT, SHEET_CONFIG) más dos funciones (isChefSuper,
--  usesChefProducts). Agregar una cadena o corregir un código de cliente
--  exigía tocar el archivo y desplegar. Ahora es una fila.
create table if not exists precios_super.cadena (
  super_key          text primary key,
  label              text not null,              -- nombre para pantalla
  empresa            text not null default 'lk'  -- contra qué proyecto va el pedido
                     check (empresa in ('lk','chef')),
  cod_cliente_lk     text,                       -- ex LK_CUSTOMER_COD
  cod_cliente_chef   text,                       -- ex CHEF_CUSTOMER_COD
  usa_productos_chef boolean not null default false,  -- ex usesChefProducts
  payment_code       integer,                    -- ex SUPER_PAYMENT_CODE (col I del sheet)
  pdf_ratio          numeric not null default 1  -- ex SUPER_PDF_RATIO
                     check (pdf_ratio > 0),
  item_discount      numeric not null default 0  -- ex SUPER_ITEM_DISCOUNT
                     check (item_discount >= 0 and item_discount < 1),
  hoja_nombre        text,                       -- ex SHEET_CONFIG (import del xlsx)
  -- hoja_cod_col / hoja_price_col son el FALLBACK del importador: primero
  -- detecta las columnas por encabezado ("Cod" / "Lista Vigente"), y solo si no
  -- las encuentra usa estos índices. Los índices se corren cuando se agrega una
  -- columna al Excel, y ahí apuntaban a "Costo sin aportes" en vez de a la lista.
  hoja_cod_col       integer,
  hoja_price_col     integer,
  hoja_start_row     integer,
  -- true = se valoriza con products.list_price y el dto del cliente, como un
  -- cliente normal (Messina). false = tiene lista propia en precios_super.precio
  -- (precio final, sin descuento). Agregada 4/8/2026.
  usa_lista_general  boolean not null default false,
  activo             boolean not null default true,
  orden              integer not null default 100,
  nota               text,
  updated_at         timestamptz not null default now(),
  -- Una cadena tiene que tener el código de cliente de SU empresa: sin eso
  -- el flujo no puede armar el pedido y falla recién al confirmarlo.
  constraint cadena_cliente_de_su_empresa check (
    (empresa = 'lk'   and coalesce(cod_cliente_lk,'')   <> '') or
    (empresa = 'chef' and coalesce(cod_cliente_chef,'') <> '')
  )
);

-- Seed: los valores que estaban hardcodeados, uno a uno (sin cambios de
-- comportamiento salvo `toledo`, que es nuevo).
insert into precios_super.cadena
  (super_key, label, empresa, cod_cliente_lk, cod_cliente_chef, usa_productos_chef,
   payment_code, pdf_ratio, item_discount, hoja_nombre, hoja_cod_col, hoja_price_col,
   hoja_start_row, activo, orden, nota)
values
  -- hoja_cod_col / hoja_price_col son el FALLBACK: el importador detecta las
  -- columnas por encabezado ("Cod" / "Lista Vigente"). Valores verificados
  -- contra A_Costos_VIGENTES el 4/8/2026, columna a columna vs los precios ya
  -- cargados. Antes apuntaban a "Costo sin aportes" (col 2) → un re-upload
  -- cargaba costos como precios.
  ('coto','Coto','lk','801',null,false,3,1,0,'COTO',0,6,6,true,10,null),
  ('inc','Carrefour (INC)','lk','1651',null,false,14,1,0,'INC',0,5,6,true,20,null),
  ('laanonima','La Anónima','lk','771',null,false,3,1,0,'La Anonima',1,6,7,true,30,null),
  ('dia','Día','lk','3947',null,false,2,1,0,'DIA',0,6,6,true,40,null),
  ('diarco','Diarco','lk','4112',null,false,2,1/1.21,0.10,'DIARCO',1,7,6,true,50,
     'PDF "Total OC" incluye IVA 21% → pdf_ratio 1/1,21. Compra al 90% de la lista de la cadena → item_discount 0,10.'),
  ('libertad','Libertad','lk','325',null,false,2,1,0,'Libertad',0,4,2,true,60,null),
  ('alberdi','Alberdi','lk','2320',null,false,1,1/0.8075,0,'Alberdi',0,5,6,true,70,
     'Aplica -15% -5% (= 19,25% off) sobre el total del PDF.'),
  ('abastecedor','El Abastecedor (Tecnolar)','lk','4051',null,false,1,1,0,'Abastecedor',0,5,2,true,80,null),
  ('messina','Messina Hnos','lk','1573',null,false,9,1,0,null,null,null,null,true,90,
     'Cuenta corriente 15 días FF → payment_code 9. Va con LISTA GENERAL: usa_lista_general=true (se setea aparte, columna agregada por ALTER). Decisión del usuario 4/8/2026.'),
  ('toledo','Supermercados Toledo','lk','1947',null,false,1,1,0,'Toledo Loeke',0,4,7,true,100,
     'Lista cargada 4/8/2026 desde A_Costos_VIGENTES (hoja Toledo Loeke, 33 precios). Falta payment_code definitivo y regex de deteccion de PDF.'),
  ('dorinka','Dorinka (Walmart)','chef',null,'2686',true,3,1/0.835,0,'WMart Chef',0,3,7,true,110,
     'Va contra el proyecto Supabase de Chef y matchea productos del catalogo de Chef. Aplica 16,5% por volumen.'),
  ('cencosud','Cencosud (Jumbo/Disco/Vea)','chef',null,'2444',false,2,1/0.84,0,'Jumbo Krea T',0,2,6,true,120,
     'Cliente/RPC/Sheets de Chef, pero matchea productos de LK + loke_products. Aplica 16% de bonificacion.')
on conflict (super_key) do nothing;

-- ── 4) Normalización de códigos ──────────────────────────────────────
--  El import del xlsx dejaba el código tal cual venía de la celda, y las
--  hojas traen sufijos de anotación: `229(`, `321-`, `932E(`, `816E-`.
--  Ninguno matcheaba `products`, así que esos artículos caían al fallback
--  de precio de lista SIN que nada lo avisara — 77 de 453 precios (17%),
--  concentrados en INC (45 de 63) y Coto (28 de 66). Todos matchean
--  después de sacarles el sufijo (verificado 4/8/2026: 77 de 77).
--  Es la MISMA canonicalización que usa `codVariants` en el JS y
--  `canonCod` en la Edge Function arca-wsfe: mayúsculas y sin ceros a la
--  izquierda, más el recorte de la basura final.
create or replace function precios_super.norm_cod(p_cod text)
returns text language sql immutable as $$
  select upper(regexp_replace(
           regexp_replace(coalesce(trim(p_cod),''), '[^A-Za-z0-9]+$', ''),
           '^0+(?=.)', ''))
$$;

-- ── 5) Lectura (la usa admin-supercot.js) ────────────────────────────
--  `is_admin()` adentro: la RPC nace con EXECUTE para PUBLIC y `anon`
--  hereda de PUBLIC, así que sin el chequeo la lista de precios negociados
--  quedaría abierta con la anon key, que es pública (está en los .js).
create or replace function public.get_super_cadenas()
returns table (
  super_key text, label text, empresa text,
  cod_cliente_lk text, cod_cliente_chef text, usa_productos_chef boolean,
  payment_code integer, pdf_ratio numeric, item_discount numeric,
  hoja_nombre text, hoja_cod_col integer, hoja_price_col integer, hoja_start_row integer,
  activo boolean, orden integer, nota text
)
language sql stable security definer
set search_path to 'public', 'precios_super'
as $$
  select c.super_key, c.label, c.empresa,
         c.cod_cliente_lk, c.cod_cliente_chef, c.usa_productos_chef,
         c.payment_code, c.pdf_ratio, c.item_discount,
         c.hoja_nombre, c.hoja_cod_col, c.hoja_price_col, c.hoja_start_row,
         c.activo, c.orden, c.nota
  from precios_super.cadena c
  where public.is_admin() and c.activo
  order by c.orden, c.super_key;
$$;

-- `order by` explícito: el JS arma el diccionario de precios con
-- first-wins, así que sin orden estable la fila que gana ante un duplicado
-- dependía del orden físico de la tabla — o sea, del azar.
create or replace function public.get_super_prices()
returns table (super_key text, cod text, price numeric)
language sql stable security definer
set search_path to 'public', 'precios_super'
as $$
  select p.super_key, p.cod, p.price
  from precios_super.precio p
  where public.is_admin()
  order by p.super_key, p.cod;
$$;

-- Histórico de precios (admin). p_super_key null = todas las cadenas.
-- La usa un futuro reporte de "cuánto subió en el año": compara snapshots
-- fechados de precios_super.precio_hist.
create or replace function public.get_super_price_hist(p_super_key text default null)
returns table (super_key text, cod text, price numeric, lista_fecha date, snapshot_at timestamptz)
language sql stable security definer
set search_path to 'public', 'precios_super'
as $$
  select h.super_key, h.cod, h.price, h.lista_fecha, h.snapshot_at
  from precios_super.precio_hist h
  where public.is_admin()
    and (p_super_key is null or h.super_key = p_super_key)
  order by h.super_key, h.cod, h.lista_fecha;
$$;

-- ── 6) Escritura desde el importador de xlsx ─────────────────────────
--  Reemplazo total por cadena + normalización del código al insertar (para
--  que la basura del Excel no vuelva a entrar) + snapshot en precio_hist,
--  fechado por lista_fecha, para poder ver la evolución de precios.
create or replace function public.set_super_prices(p_lista jsonb, p_precios jsonb)
returns jsonb
language plpgsql security definer
set search_path to 'public', 'precios_super'
as $function$
declare v_supers text[]; v_count int;
begin
  if not public.is_admin() then raise exception 'no autorizado'; end if;
  select array_agg(distinct (e->>'super_key')) into v_supers
    from jsonb_array_elements(coalesce(p_lista,'[]'::jsonb)) e
    where coalesce(e->>'super_key','') <> '';
  if v_supers is null or array_length(v_supers,1) is null then
    return jsonb_build_object('ok', false, 'error', 'sin supers');
  end if;
  insert into precios_super.lista(super_key, lista_fecha, updated_at)
  select e->>'super_key', nullif(e->>'lista_fecha','')::date, now()
  from jsonb_array_elements(p_lista) e where coalesce(e->>'super_key','') <> ''
  on conflict (super_key) do update set lista_fecha = excluded.lista_fecha, updated_at = now();
  delete from precios_super.precio where super_key = any(v_supers);
  -- distinct on: si el Excel trae `507` y `507-`, normalizar los deja iguales.
  -- Gana el código que vino limpio (orden por longitud del original), que es
  -- el bloque principal de la hoja; el anotado solo llena huecos.
  insert into precios_super.precio(super_key, cod, price)
  select distinct on (e->>'super_key', precios_super.norm_cod(e->>'cod'))
         e->>'super_key', precios_super.norm_cod(e->>'cod'), (e->>'price')::numeric
  from jsonb_array_elements(coalesce(p_precios,'[]'::jsonb)) e
  where (e->>'super_key') = any(v_supers)
    and coalesce(precios_super.norm_cod(e->>'cod'),'') <> ''
    and (e->>'price') ~ '^[0-9]+(\.[0-9]+)?$'
  order by e->>'super_key', precios_super.norm_cod(e->>'cod'), length(trim(e->>'cod'))
  on conflict (super_key, cod) do update set price = excluded.price;

  -- Snapshot histórico: misma normalización y desduplicación, fechado por
  -- lista_fecha (o current_date si la hoja no trajo fecha). Dos cargas del
  -- mismo día pisan la fila (última gana).
  insert into precios_super.precio_hist(super_key, cod, price, lista_fecha)
  select distinct on (e->>'super_key', precios_super.norm_cod(e->>'cod'))
         e->>'super_key', precios_super.norm_cod(e->>'cod'), (e->>'price')::numeric,
         coalesce((select nullif(l->>'lista_fecha','')::date
                   from jsonb_array_elements(p_lista) l
                   where l->>'super_key' = e->>'super_key' limit 1), current_date)
  from jsonb_array_elements(coalesce(p_precios,'[]'::jsonb)) e
  where (e->>'super_key') = any(v_supers)
    and coalesce(precios_super.norm_cod(e->>'cod'),'') <> ''
    and (e->>'price') ~ '^[0-9]+(\.[0-9]+)?$'
  order by e->>'super_key', precios_super.norm_cod(e->>'cod'), length(trim(e->>'cod'))
  on conflict (super_key, cod, lista_fecha) do update set price = excluded.price, snapshot_at = now();

  select count(*) into v_count from precios_super.precio where super_key = any(v_supers);
  return jsonb_build_object('ok', true, 'supers', v_supers, 'precios_total', v_count);
end; $function$;

-- ── 7) Permisos ──────────────────────────────────────────────────────
--  El esquema no se expone por PostgREST y las tres RPC llevan is_admin()
--  adentro. Igual se revoca a anon/authenticated: defensa en profundidad,
--  por si alguna vez se le saca el chequeo a una de ellas.
revoke all on schema precios_super from anon, authenticated;
revoke all on all tables in schema precios_super from anon, authenticated;
revoke all on precios_super.precio_hist              from anon, authenticated;
revoke execute on function public.get_super_cadenas()                from public, anon;
revoke execute on function public.get_super_prices()                 from public, anon;
revoke execute on function public.get_super_price_hist(text)         from public, anon;
revoke execute on function public.set_super_prices(jsonb, jsonb)     from public, anon;
grant  execute on function public.get_super_cadenas()                to authenticated;
grant  execute on function public.get_super_prices()                 to authenticated;
grant  execute on function public.get_super_price_hist(text)         to authenticated;
grant  execute on function public.set_super_prices(jsonb, jsonb)     to authenticated;

-- =====================================================================
--  VERIFICACIÓN
--
--    -- códigos que no matchean ningún catálogo (deberían ser solo los de
--    -- líneas que LK no vende con ese código)
--    select p.super_key, p.cod, p.price
--    from precios_super.precio p
--    where not exists (select 1 from products      x where precios_super.norm_cod(x.cod) = p.cod)
--      and not exists (select 1 from loke_products x where precios_super.norm_cod(x.cod) = p.cod)
--    order by 1, 2;
--
--    -- antigüedad de cada lista (lo que hay que mirar antes de creerle a
--    -- una valorización de cadenas)
--    select c.super_key, c.label, l.lista_fecha,
--           (current_date - l.lista_fecha) as dias, count(p.*) as precios
--    from precios_super.cadena c
--    left join precios_super.lista  l on l.super_key = c.super_key
--    left join precios_super.precio p on p.super_key = c.super_key
--    group by 1,2,3 order by 3 nulls first;
-- =====================================================================
