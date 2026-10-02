-- 02/10/2026 · problema 679 (Tomás Gonzalez): el PIN de los clientes pasa a 8 dígitos.
-- Supabase Auth de LK tiene la protección de contraseñas filtradas (HIBP) y rechaza
-- TODO PIN de 6 dígitos (300 de 300 medidos). 8 dígitos: 33 de 150 filtrados.
-- YA APLICADO en kwkclwhmoygunqmlegrg. Este archivo es documentación + rollback.

-- 1) La columna acepta 6 a 8 dígitos (los clientes viejos siguen con 6).
alter table public.customers drop constraint customers_pin_6_digits;
alter table public.customers add constraint customers_pin_6a8_digits check (pin ~ '^\d{6,8}$');

-- 2) El cliente puede cambiar su PIN a uno de 6 a 8 dígitos (la página exige 8).
create or replace function public.set_my_pin(p_pin text) returns void
language plpgsql security definer set search_path to 'public'
as $function$ begin
  if auth.uid() is null then raise exception 'no auth'; end if;
  if p_pin is null or p_pin !~ '^\d{6,8}$' then raise exception 'pin invalido (6 a 8 digitos)'; end if;
  update customers set pin = p_pin where auth_user_id = auth.uid();
end; $function$;

-- 3) expo_guardar_cliente: en la rama UPDATE el PIN se actualiza mientras la fila NO
--    tiene login (antes no se tocaba nunca). Se aplicó sobre pg_get_functiondef, con
--    el marcador 'pin-sin-login-0210'. La línea agregada, antes de auth_user_id:
--      pin = case when auth_user_id is null then coalesce(nullif(p_cust->>'pin',''), pin) else pin end,
--    Probado en transacción abortada: alta 123456 → sin login 87654321 → al crear el
--    login 11112222 → con login, otro guardado no lo cambia (11112222).

-- 4) Los 25 clientes del problema 679 recibieron PIN nuevo de 8 dígitos. Backup del
--    PIN anterior: zz_backups."LK_Backup_customers_pin_20261002" (RLS prendida, sin
--    acceso para anon/authenticated). Los PINs NO van en este archivo.

-- ROLLBACK
-- a) PINs:   update public.customers c set pin = b.pin
--              from zz_backups."LK_Backup_customers_pin_20261002" b where c.id = b.id;
--            (ojo: después de «Reparar Auth» el login tiene el PIN nuevo; volver atrás
--             el de customers los desfasa otra vez)
-- b) constraint (sólo si ya no queda ningún PIN de 7-8 dígitos):
--    alter table public.customers drop constraint customers_pin_6a8_digits;
--    alter table public.customers add constraint customers_pin_6_digits check (pin ~ '^\d{6}$');
-- c) expo_guardar_cliente: quitar la línea del marcador 'pin-sin-login-0210'
--    (reemplazo sobre pg_get_functiondef, igual que se aplicó).
