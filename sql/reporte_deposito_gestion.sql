-- =============================================================================
-- reporte_deposito_gestion.sql — el depósito de Gestión Virgilio en el reporte
-- Proyecto LK (kwkclwhmoygunqmlegrg) · 2026-09-07
-- =============================================================================
-- CONTEXTO. El reporte que sale por Telegram (crons 29 diario, 30 semanal,
-- 31 mensual → `rep_enviar_*` → `rep_texto_*` → `tg_enqueue_largo`) ya traía dos
-- números de depósito: lo DESPACHADO por día y lo PENDIENTE de facturar. Los dos
-- estaban mal, por tres motivos distintos:
--
--   1. El espejo copiaba la tabla cruda `PPP_Programacion_Diaria` de Virgilio, así
--      que NO veía ninguna NP que Gestión arma desde la página (29 al 07/09) y sí
--      contaba las filas que el override de Gestión oculta (10 NP de ISIS que
--      duplican pedidos web).
--   2. El filtro de empresa era `left(np,1) = '9'`. La NP web de Gestión es un
--      contador propio con etiqueta `LK 0001`, así que la primera facturación web
--      se habría perdido sin avisar.
--   3. La plata se reconstruía acá, sobre lo PEDIDO, corregida por un ratio global
--      de cajas. Contra el neto que ya calcula Gestión daba de +0,5% a +14,5% de
--      más según el día (el 27/08: $19,2 M contra $16,8 M reales).
--
-- SOLUCIÓN. Gestión expone una vista nueva, `gv_lk_np_feed` (repo Gestion-Virgilio,
-- `sql/gv_lk_np_feed.sql`): una fila por NP, ISIS y web juntas, con el neto real de
-- lo facturado y el valor de lista de lo pendiente. Acá se espeja a `ppp_np_feed` y
-- las funciones del reporte pasan a leer de ahí.
--
-- LA PLATA VIEJA NO SE PISA: `rep_despacho_diario.plata` queda como estaba y el neto
-- entra en columnas nuevas (`plata_neto`, `np_neto`). Los textos leen
-- `coalesce(plata_neto, plata)`, así que los días viejos sin neto siguen mostrando
-- el número de antes en vez de un hueco.
-- =============================================================================

-- 1) Foreign table sobre el feed (server virgilio_db, rol lk_ppp_reader).
import foreign schema public limit to (gv_lk_np_feed) from server virgilio_db into virgilio;

-- 2) Espejo local. El FDW cuesta ~1 s y hay statement_timeout de ~8 s: nada de
--    joinearlo en el camino caliente (misma lección que el FDW de Chef).
create table if not exists public.ppp_np_feed (
  np                text primary key,
  empresa           text,
  es_web            boolean,
  cod_cliente       text,
  razon_social      text,
  tanda             text,
  zona              text,
  fecha_entrega     date,
  m3                numeric,
  facturada         boolean,
  fecha_salida      date,
  neto_facturado    numeric,
  neto_pedido       numeric,
  cajas_ped         numeric,
  cajas_ent         numeric,
  cajas_falto       numeric,
  valor_lista       numeric,
  cajas_prog        numeric,
  lineas_sin_precio bigint,
  sincronizado_at   timestamptz not null default now()
);
create index if not exists ppp_np_feed_salida_idx on public.ppp_np_feed (fecha_salida) where facturada;
create index if not exists ppp_np_feed_pend_idx   on public.ppp_np_feed (empresa)      where not facturada;
alter table public.ppp_np_feed enable row level security;
revoke all on public.ppp_np_feed from anon, authenticated;

-- 3) Columnas nuevas al lado de la plata vieja (no se pisa la historia).
alter table public.rep_despacho_diario
  add column if not exists plata_neto numeric,
  add column if not exists np_neto    integer;

-- 4) `sincronizar_ppp()` gana un bloque más (con su propio EXCEPTION, como el resto)
--    que refresca `ppp_np_feed` ANTES de `rep_snapshot_despacho(30)`:
--
--    BEGIN
--      DELETE FROM public.ppp_np_feed WHERE np IS NOT NULL OR np IS NULL;
--      INSERT INTO public.ppp_np_feed (...) SELECT ... FROM virgilio.gv_lk_np_feed;
--      GET DIAGNOSTICS n_feed = ROW_COUNT;
--    EXCEPTION WHEN OTHERS THEN
--      n_feed := -1; errs := errs || jsonb_build_object('np_feed', SQLERRM);
--    END;
--
--    El cuerpo completo está aplicado en la base (migración
--    `sincronizar_ppp_con_np_feed`). Para sacarlo: pg_get_functiondef.

-- 5) `rep_snapshot_despacho(p_dias)` ahora lee `ppp_np_feed`:
--      * plata_neto = sum(neto_facturado)  (cajas ENTREGADAS, lista de súper, dto, 0,98)
--      * empresa = 'lk' por columna, no por left(np,1)='9'
--      * `plata` no se toca en el UPDATE
--    Migración `rep_snapshot_despacho_neto`.

-- 6) `rep_ppp()` ahora arma el backlog desde `ppp_np_feed` (no facturada, empresa lk):
--      * NP de ISIS  → se valoriza línea por línea con `ppp_valor_linea` (contempla
--                      la lista propia de los supermercados).
--      * NP web      → no tiene líneas acá (viven en `PPP_Web_Base` de Gestión), así
--                      que usa `valor_lista` del feed × (1 − dto_vol) × (1 − 0,02).
--    Devuelve además `nps_web`, que NO se imprime: por la regla del dueño (v13.64)
--    fuera de Facturación no se separa lo de ISIS de lo web.
--    Migración `rep_ppp_con_web_y_override`.

-- 7) Textos: `rep_texto_diario` y `rep_texto_semanal` pasan a `coalesce(plata_neto,
--    plata)`; `rep_texto_mensual` suma un bloque 🚚 DEPÓSITO con lo despachado del
--    mes cerrado y lo pendiente de hoy (antes el mensual no tenía nada de depósito).
--    Migraciones `rep_texto_diario_semanal_neto` y `rep_texto_mensual_bloque_deposito`.

-- =============================================================================
-- MEDICIÓN (2026-09-07, contra los datos del 04/09)
--
--   Pendiente de facturar:  antes 102 NP · 60,4 m³ · $192,0 M
--                           ahora 127 NP · 65,8 m³ · $221,1 M
--                           (+25 NP web = $29,0 M que no se veían; 0 NP perdidas)
--
--   Despachado por día (LK), plata vieja vs neto real:
--     04/09  $14,19 M → $13,96 M   (+2%)
--     03/09  $28,30 M → $28,16 M   (+1%)
--     02/09  $ 0,93 M → $ 1,15 M   (−19%)
--     01/09  $15,26 M → $14,61 M   (+4%)
--     31/08  $25,34 M → $21,74 M   (+17%, y además la foto vieja tenía 5 de 25 NP
--                                    valorizadas: quedó a medias y nunca se rehízo)
--     27/08  $19,21 M → $16,78 M   (+15%)
--
--   Control de coherencia: agosto despachado $510,6 M contra $522,4 M facturados en
--   el ERP = 98%.
--
-- QUEDA COJO (a propósito, documentado)
--   * El PENDIENTE de un supermercado con lista propia se valoriza a lista general
--     si la NP no tiene líneas acá. Lo FACTURADO no: ese ya sale bien.
--   * 15 de los 20 días de agosto tienen neto; los otros 5 caen al número viejo.
--   * El espejo corre 1×/día (cron 19, 07:00 ART). No hay nada intradía.
--
-- ROLLBACK
--   drop table public.ppp_np_feed;
--   drop foreign table virgilio.gv_lk_np_feed;
--   alter table public.rep_despacho_diario drop column plata_neto, drop column np_neto;
--   y restaurar las 4 funciones con la definición anterior (sql/backups/).
-- =============================================================================
