-- rep_despacho_diario — corrección del DESPACHADO ~10× abajo del 18/08 al 01/10/2026 (problema 669)
--
-- Proyecto LK (kwkclwhmoygunqmlegrg). YA CORRIDO el 2026-10-01 a la noche desde Claude (MCP), con
-- el "sí" de Thomas. Queda como documentación y rollback; NO volver a correrlo.
--
-- QUÉ PASÓ
-- ========
-- El neto facturado que calcula Gestión Virgilio (gv_vista_facturacion_neto → gv_lk_np_feed)
-- salió ~10× abajo desde el 18/08 hasta el 01/10 a la mañana. LK lo copia todos los días a las
-- 07:00 (sincronizar_ppp → ppp_np_feed) y guarda la foto diaria en rep_despacho_diario, que es
-- lo que leen los reportes de Telegram. Medido por día, foto ÷ feed corregido:
--   · 10/08 al 14/08: 0,95 a 1,00  → bien
--   · 18/08 al 01/10: 0,08 a 0,14  → mal (32 días; el 16/09 dio 0,29)
-- Septiembre entero: $42,9 M en la foto contra $419,7 M reales. El DIARIO del 01/10 dijo
-- "despachado ayer $2,7 M" cuando salieron $30,7 M.
--
-- [Probable] Causa: el neto se valorizaba con el precio por UNIDAD sin multiplicar por las
-- unidades por caja (uxb): lo facturado de septiembre en sales_lines con la cadena completa da
-- $452,2 M y sin el uxb $49,9 M, la misma huella. Gestión lo corrigió el 01/10 a la mañana; no
-- quedó registrado quién.
--
-- POR QUÉ NO SE ARREGLABA SOLO
-- ============================
-- rep_snapshot_despacho(30) sólo reescribe 30 días hacia atrás, y con la guarda
-- `np_neto >= anterior`: el 28/08 y el 17/09 (una NP menos en el feed que en la foto) y todo lo
-- anterior al 02/09 quedaban con el valor malo para siempre.
--
-- QUÉ SE HIZO (en este orden)
-- ===========================
--   1. Backup: zz_backups."LK_Backup_rep_despacho_diario_20261001" (RLS activa).
--   2. UPDATE de plata_neto y np_neto desde el feed VIVO de Gestión (virgilio.gv_lk_np_feed),
--      sólo en las filas con plata_neto cargado y por debajo de la mitad del feed: 32 filas,
--      del 18/08 al 01/10, $701,1 M en total.
--   3. select public.sincronizar_ppp(): refresca ppp_np_feed (LK y Chef) con el feed corregido,
--      que es lo que leen el DIARIO (Chef), el SEMANAL y el MENSUAL. Es la misma corrida que el
--      cron 19 hace a las 07:00.
--
-- Lo que NO se tocó: `plata` (la reconstrucción vieja, historia), nps, cajas y m³ (coincidían
-- con el feed), y las filas con plata_neto NULL (anteriores al neto de Gestión).

-- ---------------------------------------------------------------------------------------------
-- 1) backup
create table zz_backups."LK_Backup_rep_despacho_diario_20261001" as select * from public.rep_despacho_diario;
alter table zz_backups."LK_Backup_rep_despacho_diario_20261001" enable row level security;

-- 2) corrección
with f as (
  select fecha_salida fecha,
         count(*) filter (where neto_facturado is not null) np_neto,
         round(sum(coalesce(neto_facturado,0))) neto
  from virgilio.gv_lk_np_feed
  where empresa = 'lk' and facturada and fecha_salida between '2026-08-18' and '2026-10-01'
  group by 1),
u as (
  update public.rep_despacho_diario d
     set plata_neto = f.neto, np_neto = f.np_neto, calculado_at = now()
    from f
   where d.fecha = f.fecha
     and d.plata_neto is not null
     and d.plata_neto < 0.5 * f.neto
  returning d.fecha, d.plata_neto)
select count(*) filas, min(fecha) desde, max(fecha) hasta, round(sum(plata_neto)) neto_nuevo from u;
-- → 32 filas · 2026-08-18 · 2026-10-01 · 701.079.328

-- 3) refresco de la copia del feed
select public.sincronizar_ppp();

-- ---------------------------------------------------------------------------------------------
-- VERIFICACIÓN (lectura)
select date_trunc('month', fecha)::date mes, count(*) dias, sum(nps) nps, round(sum(plata_neto)) neto
  from public.rep_despacho_diario where fecha >= '2026-08-01' group by 1 order by 1;
-- → ago 382,1 M (plata_neto; del 01 al 07/08 no hay neto y siguen con `plata`) · sep 419,7 M ·
--   oct 52,1 M (01 y 02/10). Medido después de correrlo: la foto y ppp_np_feed coinciden al peso.
-- ⚠ El "POR FACTURAR" de los reportes también estaba ~4,5× abajo (valor_lista de las NP web
--   venía del mismo feed): pasó de $44,4 M a $201,7 M con el refresco, sin tocar nada más.

-- ---------------------------------------------------------------------------------------------
-- ROLLBACK (deja la foto exactamente como estaba antes del UPDATE)
-- update public.rep_despacho_diario d
--    set plata_neto = b.plata_neto, np_neto = b.np_neto, calculado_at = b.calculado_at
--   from zz_backups."LK_Backup_rep_despacho_diario_20261001" b
--  where b.fecha = d.fecha and d.fecha between '2026-08-18' and '2026-10-01';
