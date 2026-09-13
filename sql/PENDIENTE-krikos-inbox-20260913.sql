-- =====================================================================
--  PENDIENTE — Bandeja Krikos: conteo por estado + cierre de las 6 OC en error
--  Proyecto: kwkclwhmoygunqmlegrg (web LK). Escrito el 13/9/2026 desde una
--  sesión de Claude; NO está aplicado. Se corre a mano en el SQL editor,
--  bloque por bloque y EN ESTE ORDEN, cuando Luis/Thomas digan "dale".
--
--  Qué hace:
--   (a) RPC nueva public.krikos_inbox_counts() — conteo por estado para el
--       badge de la Bandeja (admin-supercot.js ya la llama y tolera que no
--       exista: mientras no esté, el badge muestra el conteo de la lista).
--   (b) Backup de las 6 filas en 'error' (esquema zz_backups, cerrado).
--   (c) ROLLBACK listo (los 6 UPDATE inversos con los valores de hoy).
--   (d) Los UPDATE: 4 pasan a 'cargado' apuntando al pedido que YA existe en
--       orders (se cargaron a mano por el flujo viejo, antes de la bandeja);
--       2 pasan a 'descartado' (no hay pedido en orders; por cliente+fecha
--       ya se entregaron por ISIS).
--   (e) Verificación: 0 pendiente / 0 error.
--   (f) HALLAZGO: las OC 22784730 y 22784731 de La Anónima están DOS veces
--       en orders (807/814 y 808/815). Sólo se muestra; NO se borra nada.
--
--  Contexto de las 6 (medido el 13/9): todas con error_msg "el link no
--  devolvió un PDF (text/html, 9845 bytes)" — el link firmado de Planexware
--  vence, y el 11/9 se procesaron 45 días hacia atrás (ver CLAUDE.md, "El
--  link del mail VENCE"). No es un bug del ingest: son OC de junio/julio que
--  ya se habían cargado por el camino viejo (arrastrar el PDF) o por ISIS.
--
--  ⚠ resuelto_por es uuid (FK lógica a auth.users), NO texto: no se puede
--  escribir 'Luis (claude-remote)' ahí, y desde el SQL editor auth.uid() es
--  null. Queda NULL y el "quién/cuándo/por qué" va en error_msg, que es la
--  única columna de texto libre de la tabla (no hay nota/motivo). El front
--  sólo muestra error_msg cuando estado = 'error', así que no ensucia nada.
-- =====================================================================


-- ─────────────────────────────────────────────────────────────────────
-- (a) RPC krikos_inbox_counts() — conteo por estado
--     Mismo chequeo de admins que krikos_inbox_list (cuerpo sacado con
--     pg_get_functiondef el 13/9/2026). Devuelve SIEMPRE las 4 filas del
--     CHECK de la tabla, con 0 si no hay, así el front no tiene que rellenar.
-- ─────────────────────────────────────────────────────────────────────
create or replace function public.krikos_inbox_counts()
returns table (estado text, n bigint)
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.admins a where a.auth_user_id = auth.uid()) then
    raise exception 'solo admin';
  end if;
  return query
    select e.estado, count(k.id)::bigint
      from unnest(array['pendiente','cargado','descartado','error']) as e(estado)
      left join public.krikos_oc_inbox k on k.estado = e.estado
     group by e.estado
     order by array_position(array['pendiente','cargado','descartado','error'], e.estado);
end $$;

-- Toda función nueva nace ejecutable por PUBLIC/anon (ver CLAUDE.md).
revoke execute on function public.krikos_inbox_counts() from public, anon;
grant  execute on function public.krikos_inbox_counts() to authenticated, service_role;

-- Prueba (como postgres el chequeo de admins falla con 'solo admin' — es lo
-- esperado; probar desde el panel, o con: set role authenticated; select
-- set_config('request.jwt.claims', '{"sub":"<uuid de un admin>"}', true);).
-- select * from public.krikos_inbox_counts();


-- ─────────────────────────────────────────────────────────────────────
-- (b) Backup de las 6 filas en error — ANTES de tocar nada
--     LK no tiene zz_backups (Gestión sí): se crea con el mismo patrón,
--     cerrado para anon/authenticated. Un backup es una copia de datos
--     reales; nace con RLS y sin escritura para los roles de la API.
-- ─────────────────────────────────────────────────────────────────────
create schema if not exists zz_backups;
revoke all on schema zz_backups from public, anon, authenticated;

create table zz_backups."krikos_oc_inbox_20260913_pre_cierre_error" as
  select * from public.krikos_oc_inbox where estado = 'error' order by id;
-- ⬇ las dos líneas que NO hay que olvidarse
alter table zz_backups."krikos_oc_inbox_20260913_pre_cierre_error" enable row level security;
revoke insert, update, delete, truncate on zz_backups."krikos_oc_inbox_20260913_pre_cierre_error"
  from anon, authenticated;

-- Tiene que dar 6 (ids 11, 12, 13, 14, 17, 18):
select id, nro_documento, cadena, estado from zz_backups."krikos_oc_inbox_20260913_pre_cierre_error" order by id;


-- ─────────────────────────────────────────────────────────────────────
-- (c) ROLLBACK — NO correr ahora. Guardado ANTES del cambio con los valores
--     que tienen hoy las 6 filas (medido el 13/9/2026: estado 'error',
--     order_id NULL, resuelto_por NULL, resuelto_at NULL, error_msg
--     'el link no devolvió un PDF (text/html, 9845 bytes)').
-- ─────────────────────────────────────────────────────────────────────
-- update public.krikos_oc_inbox set estado = 'error', order_id = null, resuelto_por = null, resuelto_at = null, error_msg = 'el link no devolvió un PDF (text/html, 9845 bytes)' where id = 11 and doc_id = '38753242';
-- update public.krikos_oc_inbox set estado = 'error', order_id = null, resuelto_por = null, resuelto_at = null, error_msg = 'el link no devolvió un PDF (text/html, 9845 bytes)' where id = 12 and doc_id = '38753243';
-- update public.krikos_oc_inbox set estado = 'error', order_id = null, resuelto_por = null, resuelto_at = null, error_msg = 'el link no devolvió un PDF (text/html, 9845 bytes)' where id = 13 and doc_id = '38753960';
-- update public.krikos_oc_inbox set estado = 'error', order_id = null, resuelto_por = null, resuelto_at = null, error_msg = 'el link no devolvió un PDF (text/html, 9845 bytes)' where id = 14 and doc_id = '38886090';
-- update public.krikos_oc_inbox set estado = 'error', order_id = null, resuelto_por = null, resuelto_at = null, error_msg = 'el link no devolvió un PDF (text/html, 9845 bytes)' where id = 17 and doc_id = '38982878';
-- update public.krikos_oc_inbox set estado = 'error', order_id = null, resuelto_por = null, resuelto_at = null, error_msg = 'el link no devolvió un PDF (text/html, 9845 bytes)' where id = 18 and doc_id = '39149521';
-- Rollback total alternativo (pisa las 6 con la copia):
-- update public.krikos_oc_inbox k set estado = b.estado, order_id = b.order_id, resuelto_por = b.resuelto_por, resuelto_at = b.resuelto_at, error_msg = b.error_msg
--   from zz_backups."krikos_oc_inbox_20260913_pre_cierre_error" b where b.id = k.id;


-- ─────────────────────────────────────────────────────────────────────
-- (d) Los UPDATE. Se hacen directo y no por krikos_inbox_resolver porque
--     esa RPC exige auth.uid() en admins (desde el SQL editor es null).
--     Cada UPDATE lleva id + doc_id + estado = 'error' en el WHERE: si una
--     fila ya cambió, ese UPDATE toca 0 filas y no pisa nada.
--
--     Cruce OC → pedido (orders.sheets_payload->>'pdf_oc', medido el 13/9):
--       id 18  OC 21774931093  Coto        → order 959 (14/07, 5 renglones, $13.016.280)
--       id 13  OC 21723590093  Coto        → order 806 (17/06, 9 renglones, $12.724.320)
--       id 12  OC 22784730     La Anónima  → order 807 (17/06; el 814 del 18/06 es el duplicado)
--       id 11  OC 22784731     La Anónima  → order 808 (17/06; el 815 del 18/06 es el duplicado)
--       id 17  OC 40881981093  Coto        → sin pedido en orders. Entrega 09/07; en Gestión
--                                            (GV_PPP_Entregados_Historico) Coto cod 801 tiene
--                                            NP entregadas el 03/07 y el 23/07 → se cargó por ISIS.
--       id 14  OC 0958095800239507 Carrefour → sin pedido en orders. Entrega 07/07; Carrefour
--                                            cod 1651 tiene NP entregada el 06/07 → ídem.
--     Los dos "sin pedido" son inferencia por cliente + fecha, NO por número
--     de OC (ISIS no guarda el nro de OC). Por eso van a 'descartado', no a
--     'cargado' con un order_id inventado.
-- ─────────────────────────────────────────────────────────────────────
begin;

update public.krikos_oc_inbox
   set estado = 'cargado', order_id = 959, resuelto_por = null, resuelto_at = now(),
       error_msg = 'resuelta a mano 13/09/2026 por Luis (claude-remote): el PDF ya se había cargado como pedido 959 el 14/07 (link vencido, ver sql/PENDIENTE-krikos-inbox-20260913.sql)'
 where id = 18 and doc_id = '39149521' and estado = 'error';

update public.krikos_oc_inbox
   set estado = 'cargado', order_id = 806, resuelto_por = null, resuelto_at = now(),
       error_msg = 'resuelta a mano 13/09/2026 por Luis (claude-remote): el PDF ya se había cargado como pedido 806 el 17/06 (link vencido, ver sql/PENDIENTE-krikos-inbox-20260913.sql)'
 where id = 13 and doc_id = '38753960' and estado = 'error';

update public.krikos_oc_inbox
   set estado = 'cargado', order_id = 807, resuelto_por = null, resuelto_at = now(),
       error_msg = 'resuelta a mano 13/09/2026 por Luis (claude-remote): el PDF ya se había cargado como pedido 807 el 17/06 (y otra vez como 814 el 18/06 — duplicado, ver HALLAZGO en sql/PENDIENTE-krikos-inbox-20260913.sql)'
 where id = 12 and doc_id = '38753243' and estado = 'error';

update public.krikos_oc_inbox
   set estado = 'cargado', order_id = 808, resuelto_por = null, resuelto_at = now(),
       error_msg = 'resuelta a mano 13/09/2026 por Luis (claude-remote): el PDF ya se había cargado como pedido 808 el 17/06 (y otra vez como 815 el 18/06 — duplicado, ver HALLAZGO en sql/PENDIENTE-krikos-inbox-20260913.sql)'
 where id = 11 and doc_id = '38753242' and estado = 'error';

-- No hay columna nota/motivo en krikos_oc_inbox: el motivo del descarte va en error_msg.
update public.krikos_oc_inbox
   set estado = 'descartado', order_id = null, resuelto_por = null, resuelto_at = now(),
       error_msg = 'descartada a mano 13/09/2026 por Luis (claude-remote): link vencido y sin pedido en orders; entrega 09/07 y Coto (cod 801) tiene NP entregadas por ISIS el 03/07 y el 23/07 — se cargó por ISIS, no por la web (inferencia por cliente+fecha)'
 where id = 17 and doc_id = '38982878' and estado = 'error';

update public.krikos_oc_inbox
   set estado = 'descartado', order_id = null, resuelto_por = null, resuelto_at = now(),
       error_msg = 'descartada a mano 13/09/2026 por Luis (claude-remote): link vencido y sin pedido en orders; entrega 07/07 y Carrefour (cod 1651) tiene NP entregada por ISIS el 06/07 — se cargó por ISIS, no por la web (inferencia por cliente+fecha)'
 where id = 14 and doc_id = '38886090' and estado = 'error';

-- Antes del commit: tiene que listar 6 filas, ninguna en 'error'.
select id, nro_documento, cadena, estado, order_id, resuelto_at from public.krikos_oc_inbox
 where id in (11, 12, 13, 14, 17, 18) order by id;

commit;
-- (si algo no cierra: rollback; y mirar (c))


-- ─────────────────────────────────────────────────────────────────────
-- (e) Verificación. Esperado (sobre las 21 filas del 13/9):
--       pendiente 0 · cargado 9 (5 + 4) · descartado 12 (10 + 2) · error 0
-- ─────────────────────────────────────────────────────────────────────
select e.estado, count(k.id) as n
  from unnest(array['pendiente','cargado','descartado','error']) as e(estado)
  left join public.krikos_oc_inbox k on k.estado = e.estado
 group by e.estado
 order by array_position(array['pendiente','cargado','descartado','error'], e.estado);

-- Y que ninguna 'cargado' apunte a un pedido que no existe:
select k.id, k.nro_documento, k.order_id
  from public.krikos_oc_inbox k
  left join public.orders o on o.id = k.order_id
 where k.estado = 'cargado' and o.id is null;   -- esperado: 0 filas


-- ─────────────────────────────────────────────────────────────────────
-- (f) HALLAZGO: las OC 22784730 y 22784731 de La Anónima están cargadas DOS
--     veces en orders (807/814 y 808/815). NO SE BORRA NADA ACÁ.
--
--     Medido el 13/9/2026:
--       OC 22784730 → order 807 (17/06 13:05) y 814 (18/06 11:09): mismo cliente
--                     (771, S.A. Imp y Exp de la Patagonia), mismos 18 renglones,
--                     mismo total $5.034.480, misma sucursal "M. D Andrea
--                     E/Prevet-Comodoro", los dos con sheets_sent = true.
--       OC 22784731 → order 808 (17/06 13:05) y 815 (18/06 11:09): ídem, 20
--                     renglones, $56.617.680, sucursal "Buen Ayre Km 10 - C. de Mayo".
--     O sea: alguien arrastró los dos PDF el 17/06 y otra vez el 18/06, y las
--     cuatro veces el pedido salió al Sheet / mail de compras.
--
--     Qué se miró en Gestión (hrxfctzncixxqmpfhskv) antes de sugerir nada:
--       · PPP_Web_NP y PPP_Web_Programacion, empresa 'lk', order_id in
--         (807, 808, 814, 815): 0 filas. Ninguno tiene NP ni tanda web — son
--         de junio, anteriores a que Gestión numere (gestion_desde = 03/09).
--       · lk_pedidos_match: los 4 están, status 'pendiente', ambiguo = false
--         (el match_string cambia por la fecha: 17/06 vs 18/06).
--       · GV_PPP_Entregados_Historico, cod 771: el 26/06 se entregaron 4 NP de
--         ISIS (97847 0,818 m³ · 97848 8,46 m³ · 97849 0,99 m³ · 97859 0,04 m³,
--         tanda C57A). Son 4 NP para 2 OC: hay que mirar en ISIS si las dos
--         OC se facturaron una vez o dos (no se puede saber desde acá: ISIS no
--         guarda el nro de OC).
--
--     Antes de borrar el duplicado (814 y 815, los del 18/06):
--       1. Confirmar en ISIS que La Anónima recibió UNA sola vez cada OC (si se
--          facturó dos veces, el problema es otro y más grande que dos filas).
--       2. Mirar order_items de 814/815 y cualquier tabla que cuelgue de orders
--          (order_tracking, sales_lines por order_id si aplica) — borrar hijos
--          antes que padres, con backup, como dice la regla de "borrar un
--          pedido = borrarlo de todos lados" (también lk_pedidos_match en
--          Gestión se rearma sola en la próxima corrida del cron de 15 min).
--       3. Con la bandeja apuntando a 807/808 (punto d), borrar 814/815 no
--          deja ninguna fila de krikos_oc_inbox colgada.
-- ─────────────────────────────────────────────────────────────────────
select o.sheets_payload->>'pdf_oc' as oc, o.id, o.created_at, o.status, o.customer_code,
       o.sheets_payload->>'sucursal_entrega' as sucursal, o.total, o.sheets_sent,
       (select count(*) from public.order_items i where i.order_id = o.id) as renglones,
       count(*) over (partition by o.sheets_payload->>'pdf_oc') as veces
  from public.orders o
 where o.sheets_payload->>'pdf_oc' in ('22784730', '22784731')
 order by 1, o.id;

-- Todas las OC de Krikos cargadas más de una vez (por si hay más casos).
-- Corrido el 13/9/2026: además de las dos de La Anónima aparecen
--   22663852    → orders 549 (07/05) y 566 (11/05)
--   58132128093 → orders 712 (29/05) y 874 (30/06)
-- (y un grupo con pdf_oc = '' — 9 pedidos sin OC, es ruido, no duplicado).
-- No se investigaron: mismo tratamiento que el punto 1-3 de arriba si se
-- quiere limpiar.
select o.sheets_payload->>'pdf_oc' as oc, count(*) as veces, array_agg(o.id order by o.id) as orders,
       array_agg(o.created_at::date order by o.id) as fechas
  from public.orders o
 where o.sheets_payload->>'pdf_oc' is not null
 group by 1 having count(*) > 1
 order by 1;
