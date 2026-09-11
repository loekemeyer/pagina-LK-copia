-- =====================================================================
--  krikos_oc_inbox — bandeja de órdenes de compra recibidas por Krikos360
--  (Planexware).
--
--  Proyecto: kwkclwhmoygunqmlegrg (web LK). Aplicado el 3/9/2026 como
--  migración `krikos_oc_inbox`; este archivo es la copia versionada.
--
--  CÓMO LLEGA UNA OC. Las cadenas (Coto, Carrefour/INC, Día, Diarco, La
--  Anónima, …) cargan la orden en Krikos360 y Planexware manda a
--  ventas@loekemeyer.com un mail de `noreply@planexware.com` con asunto
--  "Notificación de recepción de Orden de Compra". El mail NO trae el PDF:
--  trae un link firmado (`krikos360.planexware.net/Documentos/api/documento
--  ?token=<JWT>`) que devuelve el PDF SIN login. Verificado el 3/9/2026 desde
--  una Edge Function: `application/pdf`, 181 KB, `%PDF-1.7`. Ese PDF es el
--  mismo que ya parsea `admin-supercot.js` (los parsers detectan
--  `OrdCotoPlx`, `OrdIncPlx`, `OrdJumboPlx`… — "Plx" es Planexware).
--
--  FLUJO. La Edge Function `krikos-ingest` (cron, service_role) lee la
--  casilla por IMAP, parsea el mail, baja el PDF al bucket privado
--  `krikos-oc` e inserta una fila acá con estado 'pendiente'. El panel admin
--  (PDF Krikos → "Bandeja Krikos") la lista con `krikos_inbox_list`, baja el
--  PDF del bucket y lo mete en una card como si se hubiera arrastrado; al
--  subir el pedido marca 'cargado' con `krikos_inbox_resolver`.
--
--  El JWT del link lleva `{"id": "39897459", "fechaGeneracion": "..."}`;
--  ese `id` es `doc_id` y es la clave de deduplicación (UNIQUE). El UID IMAP
--  también es único: un mismo mail nunca se procesa dos veces.
-- =====================================================================

create table if not exists public.krikos_oc_inbox (
  id                bigserial primary key,
  doc_id            text unique,                 -- id del JWT del link ("39897459")
  nro_documento     text,
  emisor_raw        text,                        -- línea "Emisor" completa del mail
  cadena            text,                        -- "COTO", "INC S.A. (CARREFOUR)", ...
  gln_emisor        text,
  sucursal          text,
  gln_sucursal      text,
  direccion         text,
  fecha_emision     date,
  fecha_entrega     text,                        -- a veces trae hora ("08/09/2026 14:00")
  fecha_cancelacion date,
  link              text not null,
  mail_uid          text,                        -- UID IMAP del mail origen
  mail_fecha        timestamptz,
  mail_subject      text,
  storage_path      text,                        -- bucket krikos-oc
  pdf_bytes         integer,
  estado            text not null default 'pendiente'
                    check (estado in ('pendiente','cargado','descartado','error')),
  error_msg         text,
  order_id          bigint,                      -- orders.id una vez cargado
  resuelto_por      uuid,
  resuelto_at       timestamptz,
  created_at        timestamptz not null default now()
);

create unique index if not exists krikos_oc_inbox_mail_uid_uidx
  on public.krikos_oc_inbox (mail_uid) where mail_uid is not null;
create index if not exists krikos_oc_inbox_estado_idx
  on public.krikos_oc_inbox (estado, created_at desc);

alter table public.krikos_oc_inbox enable row level security;

-- Solo lectura para admins. Escribe únicamente la Edge Function (service_role,
-- que saltea RLS) y las RPC de abajo (SECURITY DEFINER con chequeo de admin).
drop policy if exists krikos_oc_inbox_admin_select on public.krikos_oc_inbox;
create policy krikos_oc_inbox_admin_select on public.krikos_oc_inbox
  for select to authenticated
  using (exists (select 1 from public.admins a where a.auth_user_id = auth.uid()));

-- Bucket privado con los PDF bajados de Krikos. Escribe solo service_role
-- (la Edge Function); leen los admins.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('krikos-oc', 'krikos-oc', false, 10485760, array['application/pdf'])
on conflict (id) do nothing;

drop policy if exists "krikos-oc admin read" on storage.objects;
create policy "krikos-oc admin read" on storage.objects
  for select to authenticated
  using (bucket_id = 'krikos-oc'
         and exists (select 1 from public.admins a where a.auth_user_id = auth.uid()));

-- ── RPC: listar bandeja ──────────────────────────────────────────────
create or replace function public.krikos_inbox_list(p_estado text default 'pendiente')
returns setof public.krikos_oc_inbox
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.admins a where a.auth_user_id = auth.uid()) then
    raise exception 'solo admin';
  end if;
  return query
    select * from public.krikos_oc_inbox
    where (p_estado is null or p_estado = '' or estado = p_estado)
    order by created_at desc
    limit 200;
end $$;

-- ── RPC: marcar cargado / descartado / pendiente ─────────────────────
create or replace function public.krikos_inbox_resolver(
  p_id bigint, p_estado text, p_order_id bigint default null
) returns public.krikos_oc_inbox
language plpgsql security definer set search_path = public as $$
declare r public.krikos_oc_inbox;
begin
  if not exists (select 1 from public.admins a where a.auth_user_id = auth.uid()) then
    raise exception 'solo admin';
  end if;
  if p_estado not in ('pendiente','cargado','descartado') then
    raise exception 'estado inválido: %', p_estado;
  end if;
  update public.krikos_oc_inbox
     set estado = p_estado,
         order_id = case when p_estado = 'cargado' then coalesce(p_order_id, order_id) else order_id end,
         resuelto_por = case when p_estado = 'pendiente' then null else auth.uid() end,
         resuelto_at  = case when p_estado = 'pendiente' then null else now() end
   where id = p_id
   returning * into r;
  if r.id is null then raise exception 'no existe %', p_id; end if;
  return r;
end $$;

-- Toda función nueva nace ejecutable por PUBLIC/anon (ver CLAUDE.md).
revoke execute on function public.krikos_inbox_list(text) from public, anon;
revoke execute on function public.krikos_inbox_resolver(bigint, text, bigint) from public, anon;
grant execute on function public.krikos_inbox_list(text) to authenticated, service_role;
grant execute on function public.krikos_inbox_resolver(bigint, text, bigint) to authenticated, service_role;

-- ── Secretos desde el Vault (fallback del env de la Edge Function) ────
-- Permite cargar KRIKOS_IMAP_PASS / KRIKOS_INGEST_SECRET desde el SQL editor:
--   select vault.create_secret('<valor>', 'KRIKOS_IMAP_PASS');
-- La Edge Function prioriza la variable de entorno y cae acá si no existe.
-- Solo service_role puede llamarla. Aplicado el 4/9/2026 (migración
-- `krikos_secret_vault`).
create or replace function public.krikos_secret(p_name text)
returns text
language sql security definer set search_path = public, vault as $$
  select decrypted_secret from vault.decrypted_secrets
  where name = p_name
  order by created_at desc limit 1
$$;
revoke execute on function public.krikos_secret(text) from public, anon, authenticated;
grant execute on function public.krikos_secret(text) to service_role;

-- ── Cron: leer la casilla cada 10 minutos ─────────────────────────────
-- Requiere que la Edge Function tenga los secretos KRIKOS_IMAP_HOST/PORT/
-- USER/PASS y KRIKOS_INGEST_SECRET (el mismo valor va acá en el header).
-- select cron.schedule('krikos-ingest-10min', '*/10 * * * *', $cron$
--   select net.http_post(
--     url := 'https://kwkclwhmoygunqmlegrg.supabase.co/functions/v1/krikos-ingest',
--     headers := jsonb_build_object('Content-Type','application/json',
--                                   'x-krikos-secret','<KRIKOS_INGEST_SECRET>'),
--     body := '{"action":"sync"}'::jsonb,
--     timeout_milliseconds := 120000);
-- $cron$);
