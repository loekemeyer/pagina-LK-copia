-- ============================================================================
-- programar_pedido_automatico.sql
-- Configuración → "Programar pedido automático" (formato Pedido Automático).
--
-- Agrega a pa_config el intervalo (en días) del pedido programado. Son días
-- CORRIDOS Y EXACTOS contados desde el último pedido del cliente (intervalo
-- rodante, no anclado a días del mes): con 15, si pide el 1 el próximo queda
-- programado para el 16; con 27 son 27 días justos aunque cruce el mes.
-- El cliente lo cambia desde la pantalla de Configuración del formato.
--
-- Correr UNA vez en el SQL editor de Supabase (proyecto kwkclwhmoygunqmlegrg),
-- idealmente ANTES de subir por FTP el osa/js/store.js nuevo. Si se sube el JS
-- antes de correr esto, no se rompe nada: el guardado reintenta sin la columna
-- (el intervalo simplemente no persiste hasta que exista).
-- Si ya corriste la versión anterior de este script (tope 28), correlo de
-- nuevo: re-crea el constraint con el rango nuevo (1 a 90).
-- ============================================================================

alter table public.pa_config
  add column if not exists pedido_intervalo_dias integer not null default 15;

-- Sanidad: 1 a 90 días corridos.
alter table public.pa_config
  drop constraint if exists pa_config_pedido_intervalo_chk;
alter table public.pa_config
  add constraint pa_config_pedido_intervalo_chk
  check (pedido_intervalo_dias between 1 and 90);
