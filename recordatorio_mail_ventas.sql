-- ============================================================================
-- recordatorio_mail_ventas.sql
-- Mail recordatorio de carga de ventas — 2 días antes del pedido programado.
--
-- Cada cliente del formato (Pedido Automático) carga SU mail en Configuración
-- (campo "Mail para el recordatorio de ventas" → pa_config.email_recordatorio).
-- Un cron diario calcula el vencimiento rodante de cada cliente (último pedido
-- + pedido_intervalo_dias) y, exactamente 2 días antes, dispara un mail
-- recordando cargar las unidades vendidas en la sección Ventas.
-- Ej.: pedido programado para el 15 → el mail sale el 13.
--
-- Diseño: pg_cron → fn_enviar_recordatorios_venta() → net.http_post → webhook
-- de n8n → n8n manda el mail (nodo Gmail/SMTP) al campo `to` del payload.
--
-- PENDIENTE antes de correr:
--   1. Crear en n8n un workflow Webhook → Gmail que tome el JSON de abajo y
--      mande el mail a {{to}} con {{asunto}} y {{mensaje}}.
--   2. Reemplazar N8N_WEBHOOK_URL por la URL real del webhook (aparece 1 vez).
--   3. Correr este script en el SQL editor (kwkclwhmoygunqmlegrg).
--      Requiere pg_cron y pg_net (ya habilitadas en el proyecto).
-- ============================================================================

-- 1) Columna para el mail del recordatorio (la escribe el formato)
alter table public.pa_config
  add column if not exists email_recordatorio text;

-- 2) Función que decide a quién avisar HOY y dispara el mail.
--    Un solo aviso por ciclo: solo dispara cuando hoy es EXACTAMENTE
--    (vencimiento - 2 días), en fecha argentina.
create or replace function public.fn_enviar_recordatorios_venta()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_hoy date := (now() at time zone 'America/Argentina/Buenos_Aires')::date;
  v_enviados integer := 0;
begin
  for r in
    select
      c.cod_cliente,
      c.cliente,
      c.email_recordatorio,
      (max((o.created_at at time zone 'America/Argentina/Buenos_Aires')::date)
        + coalesce(c.pedido_intervalo_dias, 15))::date as fecha_pedido
    from public.pa_config c
    join public.customers cu on cu.cod_cliente::text = c.cod_cliente::text
    join public.orders    o  on o.customer_id = cu.id
    where coalesce(c.recordatorio_pedido, true)
      and coalesce(c.email_recordatorio, '') <> ''
    group by c.cod_cliente, c.cliente, c.email_recordatorio, c.pedido_intervalo_dias
  loop
    if r.fecha_pedido - 2 = v_hoy then
      perform net.http_post(
        url     := 'N8N_WEBHOOK_URL',
        headers := '{"Content-Type": "application/json"}'::jsonb,
        body    := jsonb_build_object(
          'to',           r.email_recordatorio,
          'cliente',      r.cliente,
          'cod_cliente',  r.cod_cliente,
          'fecha_pedido', to_char(r.fecha_pedido, 'DD/MM/YYYY'),
          'asunto',       'Recordatorio: cargá tus ventas antes del pedido del ' || to_char(r.fecha_pedido, 'DD/MM'),
          'mensaje',      'En 2 días (' || to_char(r.fecha_pedido, 'DD/MM') || ') se arma tu Pedido Automático. ' ||
                          'Entrá a la sección ' ||
                          case when r.cod_cliente::text = '2533' then '"Ventas OSA"' else '"Ventas"' end ||
                          ' y cargá las unidades vendidas, así el pedido sale con las cantidades correctas.'
        )
      );
      v_enviados := v_enviados + 1;
    end if;
  end loop;
  return v_enviados;
end;
$$;

-- 3) Cron diario a las 09:00 de Argentina (12:00 UTC). La función decide sola
--    si a alguien le toca el aviso hoy; los demás días no hace nada.
select cron.schedule(
  'recordatorio_ventas_formato',
  '0 12 * * *',
  $$select public.fn_enviar_recordatorios_venta();$$
);

-- ---------------------------------------------------------------------------
-- Prueba SIN mandar mails (a quién le tocaría y cuándo):
--   select c.cod_cliente, c.cliente, c.email_recordatorio,
--          (max((o.created_at at time zone 'America/Argentina/Buenos_Aires')::date)
--            + coalesce(c.pedido_intervalo_dias, 15))::date       as fecha_pedido,
--          (max((o.created_at at time zone 'America/Argentina/Buenos_Aires')::date)
--            + coalesce(c.pedido_intervalo_dias, 15) - 2)::date   as dia_del_mail
--   from pa_config c
--   join customers cu on cu.cod_cliente::text = c.cod_cliente::text
--   join orders    o  on o.customer_id = cu.id
--   where coalesce(c.email_recordatorio, '') <> ''
--   group by c.cod_cliente, c.cliente, c.email_recordatorio, c.pedido_intervalo_dias;
--
-- Para desprogramar:  select cron.unschedule('recordatorio_ventas_formato');
-- ---------------------------------------------------------------------------
