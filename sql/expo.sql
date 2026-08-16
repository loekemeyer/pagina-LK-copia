-- ============================================================================
-- EXPO — plataforma para tomar pedidos en exposición (copia pagina-LK-copia)
-- ============================================================================
-- Este archivo documenta las funciones/objetos del módulo Expo. La fuente de
-- verdad sigue siendo la base: correr esto a mano en el SQL editor.
--
-- Fase 1: buscar_cliente_expo — buscador único de la pantalla "Elegir cliente".
--   Matchea por cód, razón social, CUIT (solo dígitos, >=4 para búsqueda
--   incremental) o dirección de entrega / localidad. Gateada a admin. Solo lectura.
-- ----------------------------------------------------------------------------

create or replace function public.buscar_cliente_expo(p_q text)
returns table(
  id uuid,
  cod_cliente bigint,
  business_name text,
  cuit text,
  dto_vol numeric,
  vend text,
  direccion text,
  localidad text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_q      text := btrim(coalesce(p_q, ''));
  v_digits text := regexp_replace(coalesce(p_q, ''), '\D', '', 'g');
  v_isnum  boolean := v_q ~ '^\d+$';
  v_cod    bigint := null;
begin
  -- Gate admin (RPC solo para el panel expo)
  if not exists (select 1 from admins a where a.auth_user_id = auth.uid()) then
    raise exception 'no autorizado';
  end if;

  if length(v_q) < 2 then
    return;
  end if;

  -- Cast protegido a bigint: SOLO dígitos puros. Si se usa v_q::bigint directo
  -- en el WHERE, Postgres lo const-foldea y tira 22P02 con un CUIT con guiones
  -- (ej "30-68092135-7"), rompiendo la búsqueda por CUIT.
  if v_isnum and length(v_q) <= 18 then
    begin v_cod := v_q::bigint; exception when others then v_cod := null; end;
  end if;

  return query
  with matches as (
    select c.id
    from customers c
    where (v_cod is not null and c.cod_cliente = v_cod)
       or c.business_name ilike '%' || v_q || '%'
       -- CUIT por dígitos, min 4 (para búsqueda incremental; el resultado final
       -- se ordena por cod_cliente y se corta a 25 — ver el wrap de abajo).
       or (length(v_digits) >= 4
           and regexp_replace(coalesce(c.cuit, ''), '\D', '', 'g') like '%' || v_digits || '%')
    union
    select da.customer_id
    from customer_delivery_addresses da
    where length(v_q) >= 3
      and (da.direccion_entrega ilike '%' || v_q || '%'
           or da.localidad ilike '%' || v_q || '%')
  )
  select distinct on (c.id)
    c.id, c.cod_cliente, c.business_name, c.cuit, c.dto_vol, c.vend,
    coalesce(nullif(c.direccion_fiscal, ''), da.direccion_entrega) as direccion,
    coalesce(nullif(c.localidad, ''), da.localidad) as localidad
  from customers c
  join matches m on m.id = c.id
  left join customer_delivery_addresses da on da.customer_id = c.id
  order by c.id, da.slot nulls last
  limit 25;
end;
$$;

revoke execute on function public.buscar_cliente_expo(text) from public;
grant execute on function public.buscar_cliente_expo(text) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Fase 2: expo_clientes_pendientes — "otro módulo" que junta los clientes
--   nuevos cargados en la expo para levantarlos todos juntos al ERP. El cliente
--   igual se crea en customers+auth (para que el pedido/PIN/descarga funcionen);
--   esta tabla es el registro para el alta ERP posterior.
-- ----------------------------------------------------------------------------
create table if not exists public.expo_clientes_pendientes (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references public.customers(id) on delete set null,
  cod_cliente bigint,
  business_name text,
  cuit text,
  condicion_iva text,
  direccion text,
  numero text,
  cp text,
  localidad text,
  provincia text,
  telefono text,
  whatsapp text,
  mail text,
  vend text,
  dto_vol numeric,
  pin text,
  direcciones_entrega jsonb default '[]'::jsonb,  -- [{direccion,localidad,provincia,expreso}]
  estado text default 'pendiente',           -- pendiente | cargado_erp
  creado_por uuid default auth.uid(),
  creado_at timestamptz default now(),
  actualizado_at timestamptz default now()
);
-- Si la tabla ya existía, sumar las columnas nuevas:
alter table public.expo_clientes_pendientes
  add column if not exists condicion_iva text,
  add column if not exists numero text,
  add column if not exists cp text,
  add column if not exists telefono text;

alter table public.expo_clientes_pendientes enable row level security;

drop policy if exists expo_pend_admin_all on public.expo_clientes_pendientes;
create policy expo_pend_admin_all on public.expo_clientes_pendientes
  for all
  using (exists (select 1 from public.admins a where a.auth_user_id = auth.uid()))
  with check (exists (select 1 from public.admins a where a.auth_user_id = auth.uid()));

-- ----------------------------------------------------------------------------
-- Fase 3: expo_dto_escala — escala de descuento por volumen para clientes
--   nuevos de expo. El dto se aplica según el subtotal de LISTA del pedido
--   (antes del dto), en vivo. Editable (lectura abierta, escritura admin).
-- ----------------------------------------------------------------------------
create table if not exists public.expo_dto_escala (
  id uuid primary key default gen_random_uuid(),
  desde numeric not null,      -- subtotal de lista desde el cual aplica
  dto   numeric not null,      -- fracción 0..1
  creado_at timestamptz default now()
);

alter table public.expo_dto_escala enable row level security;

drop policy if exists expo_escala_read on public.expo_dto_escala;
create policy expo_escala_read on public.expo_dto_escala for select using (true);

drop policy if exists expo_escala_admin on public.expo_dto_escala;
create policy expo_escala_admin on public.expo_dto_escala
  for all
  using (exists (select 1 from public.admins a where a.auth_user_id = auth.uid()))
  with check (exists (select 1 from public.admins a where a.auth_user_id = auth.uid()));

-- ----------------------------------------------------------------------------
-- Código de cliente asignado por el sistema (contador propio). Arranca en 4272
-- (ISIS tenía max 4271). NO se deriva del padrón parcial de la página.
-- ----------------------------------------------------------------------------
create table if not exists public.expo_config (
  id int primary key default 1,
  next_cod bigint not null,
  constraint expo_config_singleton check (id = 1)
);
insert into public.expo_config (id, next_cod)
select 1, 4272 where not exists (select 1 from public.expo_config where id = 1);
alter table public.expo_config enable row level security;
drop policy if exists expo_config_admin on public.expo_config;
create policy expo_config_admin on public.expo_config for all
  using (exists (select 1 from public.admins a where a.auth_user_id = auth.uid()))
  with check (exists (select 1 from public.admins a where a.auth_user_id = auth.uid()));

create or replace function public.expo_peek_cod()
returns bigint language sql security definer set search_path=public as $$
  select next_cod from public.expo_config where id = 1;
$$;
create or replace function public.expo_reservar_cod()
returns bigint language plpgsql security definer set search_path=public as $$
declare v bigint;
begin
  if not exists (select 1 from admins a where a.auth_user_id = auth.uid()) then
    raise exception 'no autorizado';
  end if;
  update public.expo_config set next_cod = next_cod + 1 where id = 1
    returning next_cod - 1 into v;
  return v;
end; $$;
revoke execute on function public.expo_peek_cod() from public;
revoke execute on function public.expo_reservar_cod() from public;
grant execute on function public.expo_peek_cod() to authenticated, service_role;
grant execute on function public.expo_reservar_cod() to authenticated, service_role;

-- Semilla (tramos confirmados 15/8/2026).
insert into public.expo_dto_escala (desde, dto)
select * from (values
  (0::numeric, 0.00::numeric), (600000::numeric, 0.02::numeric),
  (1000000::numeric, 0.04::numeric), (1500000::numeric, 0.06::numeric),
  (2300000::numeric, 0.08::numeric), (4000000::numeric, 0.10::numeric),
  (6000000::numeric, 0.12::numeric)
) as t(desde, dto)
where not exists (select 1 from public.expo_dto_escala);
