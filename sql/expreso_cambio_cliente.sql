-- ============================================================================
-- EXPRESO ELEGIDO POR EL CLIENTE  (pedido de Thomas, 2026-09-23)
-- ============================================================================
-- Que resuelve: hasta hoy el cliente NO veia con que expreso le entregamos, y
-- el unico lugar donde podia elegir uno era el alta de sucursal nueva. Si el
-- expreso de una sucursal YA CARGADA cambiaba, no habia forma de decirlo: se
-- avisaba por WhatsApp o no se avisaba.
--
-- Como queda:
--   1. El cliente ve el expreso de la sucursal que eligio, y puede cambiarlo.
--   2. El cambio se escribe en la FICHA (customer_delivery_addresses), asi el
--      pedido sale con el expreso nuevo SIN tocar el submit ni los feeds: todo
--      el pipeline (v_pedidos_web -> gv_pedidos_web_np_lk -> gv_np_destino ->
--      la PPP) ya lee de ahi, y el camion va al galpon correcto.
--   3. Queda una fila en `expreso_pendiente` con el ANTERIOR y el NUEVO, que es
--      la alerta para cargarlo a mano en ISIS.
--
-- ⚠ La ficha queda desincronizada de ISIS hasta que alguien lo carga. Es el
--   MISMO criterio que ya usa `pending_isis` para las sucursales nuevas: el
--   pedido del cliente nunca se frena por una carga administrativa.
--
-- ⚠ NUNCA se pisa `expreso_anterior` desde el front: lo lee la funcion de la
--   ficha antes de escribir. Si el cliente lo mandara, podria borrar el rastro
--   de que habia antes, que es justo lo que el modulo de ISIS necesita.
-- ============================================================================

create table if not exists public.expreso_pendiente (
  id              bigserial primary key,
  customer_id     uuid        not null,
  slot            smallint    not null,
  cod_cliente     text,                 -- desnormalizado: G-V lo lee sin joinear
  razon_social    text,
  sucursal_label  text,
  expreso_anterior    text,
  expreso_nuevo       text not null,
  direccion_anterior  text,
  direccion_nueva     text,
  localidad_nueva     text,
  provincia_nueva     text,
  expreso_id      bigint,               -- id en `expresos` si matcheo el padron
  del_padron      boolean not null default false,
  order_id        bigint,               -- el pedido en el que lo cambio, si hubo
  estado          text not null default 'pendiente'
                  check (estado in ('pendiente','cargado_isis','descartado')),
  nota_admin      text,
  creado_at       timestamptz not null default now(),
  resuelto_at     timestamptz,
  resuelto_por    text
);

comment on table public.expreso_pendiente is
  'Cambios de expreso hechos por el cliente desde el checkout que hay que cargar a mano en ISIS. La ficha ya quedo con el valor nuevo; aca vive el rastro de que habia antes.';

create index if not exists expreso_pendiente_estado_idx
  on public.expreso_pendiente (estado, creado_at desc);
create index if not exists expreso_pendiente_cliente_idx
  on public.expreso_pendiente (customer_id, slot);

alter table public.expreso_pendiente enable row level security;

-- El cliente ve SOLO lo suyo (para pintar el "pendiente de confirmacion").
drop policy if exists expreso_pend_select_propio on public.expreso_pendiente;
create policy expreso_pend_select_propio on public.expreso_pendiente
  for select using (
    exists (select 1 from public.customers c
             where c.id = expreso_pendiente.customer_id and c.auth_user_id = auth.uid())
    or exists (select 1 from public.user_customer_links l
             where l.customer_id = expreso_pendiente.customer_id and l.auth_user_id = auth.uid())
  );

drop policy if exists expreso_pend_admin on public.expreso_pendiente;
create policy expreso_pend_admin on public.expreso_pendiente
  for all using (exists (select 1 from public.admins a where a.auth_user_id = auth.uid()))
  with check (exists (select 1 from public.admins a where a.auth_user_id = auth.uid()));

-- Nadie escribe la tabla directo: se entra por la RPC, que es la que calcula el
-- "anterior". Sin INSERT para anon/authenticated a proposito.
revoke insert, update, delete on public.expreso_pendiente from anon, authenticated;

-- ============================================================================
-- RPC: el cliente cambia el expreso de UNA sucursal suya
-- ============================================================================
-- SECURITY DEFINER porque escribe `expreso_pendiente`, que el cliente no puede
-- tocar. El guard de pertenencia repite la condicion de la policy de escritura
-- de customer_delivery_addresses (propio OR linkeado) — el "group" queda afuera
-- a proposito: ahi el permiso es de LECTURA, no de escritura.
--
-- Devuelve jsonb para que el front sepa si matcheo el padron sin un segundo viaje.
create or replace function public.expreso_cambiar(
  p_slot        smallint,
  p_nombre      text,
  p_direccion   text default null,
  p_localidad   text default null,
  p_provincia   text default null,
  p_order_id    bigint default null,
  p_customer_id uuid default null       -- para el vendedor que pide por un cliente suyo
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cid   uuid;
  v_nom   text := btrim(coalesce(p_nombre,''));
  v_row   public.customer_delivery_addresses%rowtype;
  v_exp   public.expresos%rowtype;
  v_dir   text;
  v_id    bigint;
begin
  if v_nom = '' then
    raise exception 'Falta el nombre del expreso.';
  end if;

  -- Cliente objetivo: el que pidieron, o el del usuario logueado.
  v_cid := coalesce(
    p_customer_id,
    (select c.id from public.customers c where c.auth_user_id = auth.uid() limit 1)
  );
  if v_cid is null then
    raise exception 'No se pudo identificar el cliente.';
  end if;

  -- Guard de pertenencia. Sin esto un cliente podria cambiarle el expreso a otro.
  if not (
       exists (select 1 from public.customers c
                where c.id = v_cid and c.auth_user_id = auth.uid())
    or exists (select 1 from public.user_customer_links l
                where l.customer_id = v_cid and l.auth_user_id = auth.uid())
  ) then
    raise exception 'No autorizado sobre ese cliente.';
  end if;

  select * into v_row from public.customer_delivery_addresses
   where customer_id = v_cid and slot = p_slot;
  if not found then
    raise exception 'La sucursal % no existe para ese cliente.', p_slot;
  end if;

  -- ¿Esta en el padron? Match exacto por razon social, sin acentos ni doble espacio.
  select * into v_exp from public.expresos e
   where upper(btrim(regexp_replace(e.razon_social,'\s+',' ','g')))
       = upper(btrim(regexp_replace(v_nom,'\s+',' ','g')))
   limit 1;

  -- La direccion: la que mando el cliente gana; si no mando, la del padron.
  v_dir := nullif(btrim(coalesce(p_direccion,'')),'');
  if v_dir is null and v_exp.id is not null then
    v_dir := nullif(btrim(concat_ws(', ',
              nullif(btrim(coalesce(v_exp.domicilio,'')),''),
              nullif(btrim(coalesce(v_exp.localidad,'')),''),
              nullif(btrim(coalesce(v_exp.provincia,'')),''))),'');
  end if;

  -- Nada que hacer si eligio exactamente lo que ya tenia.
  if upper(btrim(coalesce(v_row.nombre_expreso,''))) = upper(v_nom)
     and coalesce(v_dir,'') = coalesce(btrim(coalesce(v_row.direccion_expreso,'')),'') then
    return jsonb_build_object('ok',true,'sin_cambios',true,
                              'del_padron', v_exp.id is not null);
  end if;

  insert into public.expreso_pendiente (
    customer_id, slot, cod_cliente, razon_social, sucursal_label,
    expreso_anterior, expreso_nuevo, direccion_anterior, direccion_nueva,
    localidad_nueva, provincia_nueva, expreso_id, del_padron, order_id
  )
  select v_cid, p_slot, c.cod_cliente::text, c.business_name, v_row.label,
         nullif(btrim(coalesce(v_row.nombre_expreso,'')),''), v_nom,
         nullif(btrim(coalesce(v_row.direccion_expreso,'')),''), v_dir,
         nullif(btrim(coalesce(p_localidad, v_exp.localidad,'')),''),
         nullif(btrim(coalesce(p_provincia, v_exp.provincia,'')),''),
         v_exp.id, v_exp.id is not null, p_order_id
    from public.customers c where c.id = v_cid
  returning id into v_id;

  -- La ficha queda con el valor NUEVO: es lo que hace que el pedido salga bien
  -- sin tocar el submit ni ninguno de los feeds a Gestion.
  update public.customer_delivery_addresses
     set nombre_expreso    = v_nom,
         direccion_expreso = coalesce(v_dir, direccion_expreso)
   where customer_id = v_cid and slot = p_slot;

  return jsonb_build_object(
    'ok', true, 'id', v_id, 'del_padron', v_exp.id is not null,
    'expreso', v_nom, 'direccion', v_dir,
    'anterior', nullif(btrim(coalesce(v_row.nombre_expreso,'')),'')
  );
end $$;

-- ⚠ El revoke a `public` NO alcanza: `anon` quedaba con EXECUTE igual (medido).
--   El guard la frena (sin JWT no hay auth.uid() y no hay cliente), pero una
--   funcion que escribe la ficha no tiene por que estar abierta a la clave
--   publica. Va el revoke explicito a anon.
revoke execute on function public.expreso_cambiar(smallint,text,text,text,text,bigint,uuid) from public;
revoke execute on function public.expreso_cambiar(smallint,text,text,text,text,bigint,uuid) from anon;
grant  execute on function public.expreso_cambiar(smallint,text,text,text,text,bigint,uuid) to authenticated;

-- ============================================================================
-- PUENTE A GESTION VIRGILIO
-- ============================================================================
-- Mismo patron y mismo rol (lk_ppp_reader) que sync_cliente_isis_virgilio: LK
-- escribe por el FDW y Gestion lee una tabla local. La tabla del otro lado
-- (`GV_Expreso_Pendiente`) y el modulo "Agregar Expreso ISIS" estan en
-- Gestion-Virgilio/sql/gv_expreso_pendiente_v2194.sql.
--
-- ⚠ Es de DOS VIAS. La vuelta no es un extra: el supervisor marca "cargado en
--   ISIS" del lado de Gestion, y si esa marca no volviera, el reloj de
--   "pendiente" le quedaria prendido al cliente en la pagina para siempre.
--
-- Cron 56 de LK: '1-59/15 * * * *'. El minuto 1 se eligio midiendo la grilla —
-- 1/16/31/46 es el offset con menos jobs simultaneos (pico de 3 sobre los 6
-- worker slots de la instancia). Ver la regla de los crons escalonados.

create foreign table if not exists virgilio.gv_expreso_pendiente (
  id bigint, empresa text, cod_cliente text, razon_social text, sucursal_label text,
  slot smallint, expreso_anterior text, expreso_nuevo text, direccion_anterior text,
  direccion_nueva text, localidad_nueva text, provincia_nueva text, del_padron boolean,
  order_id bigint, estado text, nota_admin text, creado_at timestamptz,
  resuelto_at timestamptz, resuelto_por text, actualizado_at timestamptz
) server virgilio_db options (schema_name 'public', table_name 'GV_Expreso_Pendiente');

-- El cuerpo vivo de sync_expreso_pendiente_virgilio() esta aplicado en la base.
-- Para traerlo:
--   select pg_get_functiondef('public.sync_expreso_pendiente_virgilio()'::regprocedure);
--
-- select cron.schedule('sync-expreso-pendiente-virgilio', '1-59/15 * * * *',
--   'select public.sync_expreso_pendiente_virgilio()');
--
-- Rollback del cron, una linea:
--   select cron.unschedule('sync-expreso-pendiente-virgilio');
