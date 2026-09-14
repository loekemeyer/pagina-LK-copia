-- =====================================================================================
-- gv_web_es_tdf_chef — el pedido de Tierra del Fuego ES un pedido de CHEF
-- 2026-09-14 (pedido de Thomas). Lado LK de la v17.80 de `Gestion-Virgilio`.
-- =====================================================================================
-- EL PEDIDO DEL DUEÑO, textual (14/09): *"esos pedidos se pasen como pedidos de CH y se
-- facturen como CH"*, y sobre la NP: *"¿lo programó como LK? porque debería estar como
-- NP de CH"*.
--
-- Hasta la v13.77 el pedido de un cliente de Tierra del Fuego entraba por la página de LK
-- y quedaba como NP de LK; sólo la FACTURA se enrutaba al ISIS de Chef. Ahora el pedido es
-- de Chef de punta a punta: NP del contador de Chef (`CH 0020`), tanda y remito de Chef, y
-- la Cuarentena contra el padrón de Chef (v17.75).
--
-- ── ⚠ DÓNDE SE CORTA: EN GESTIÓN, NO ACÁ ────────────────────────────────────────────
-- El primer intento fue cortar adentro de los dos feeds de este proyecto
-- (`gv_pedidos_web_np_lk` dejaba de devolver esos bloques y `gv_pedidos_web_np_chef` los
-- devolvía con el cod de Chef). **Se revirtió el mismo día:** `gv_pedidos_web_np_chef` ya
-- tarda **7,03 s** contra un `statement_timeout` de **8 s** —lee el padrón de Chef por
-- FDW— y el bloque agregado le sumaba ~600 ms; el job de Gestión empezó a contestar
-- `Chef RPC: HTTP 500 {"code":"57014", … statement timeout}`. **Las dos RPC quedaron
-- exactamente como estaban**, y este archivo NO las modifica.
--
-- Hoy el corte vive del lado de Gestión, en dos lugares con la misma condición:
--   · Edge Function `gv-ppp-web-tandas-diarias` (`cfgTdF()` + `_tdfParaChef`): `traerLk()`
--     aparta las filas y `traerChef()` las devuelve pegadas a los pedidos nativos de Chef.
--   · front de A Programar (`aprCfgTdF()` + `aprPartirTdF()` en `index.html`).
-- Los dos leen las MISMAS tres filas de `app_settings` de este proyecto (abajo), así que
-- la perilla los mueve juntos y no pueden decidir distinto sobre el mismo pedido — si lo
-- hicieran, el pedido saldría como pendiente en LK y como programado en Chef, o sea DOS
-- VECES en la PPP. Si la lectura de `app_settings` falla, los dos caen a APAGADO.
--
-- Las funciones `gv_web_tdf_*` / `gv_web_es_tdf_chef` de abajo quedan creadas: son la
-- forma canónica de la regla en SQL y sirven para medir, pero **hoy no las llama nadie**.
-- Vuelven a tener consumidor el día que `gv_pedidos_web_np_chef` deje de estar al borde
-- del timeout (la salida sería una copia local del padrón de Chef con su cron, el mismo
-- patrón que ya usa `chef_padron`).
--
-- La condición no inventa nada: `v_pedidos_web` ya marca `isis_empresa = 'chef'` y resuelve
-- `cod_isis` por CUIT contra `chef_padron` desde la v13.77 (sucursal de entrega en Tierra
-- del Fuego, o CUIT cargado a mano en `gv_isis_override`).
--
-- ── ⚠ EL `order_id` LLEVA OFFSET, Y NO ES OPCIONAL ───────────────────────────────────
-- La clave de `PPP_Web_NP` y de `PPP_Web_Programacion` es `(empresa, order_id, np_idx)`, y
-- el `order_id` es el número del pedido de la PÁGINA. Guardar el 1431 de la página LK como
-- `chef` lo pone a chocar con el 1431 de la página de Chef el día que ese portal llegue
-- (hoy va por 228). Se le suma `web_order_offset_lk` (1.000.000): `1431 → 1001431`. Nunca
-- puede chocar, el número original se lee a simple vista y volver atrás es restar.
--
-- **La NP no necesita nada de esto**: `gv_ppp_web_np_asignar` ya toma el próximo número
-- libre de cada empresa con un lock (`max(np)+1` sobre `PPP_Web_NP`, más índice único
-- `(empresa, np)`), que es exactamente lo que pidió el dueño — *"que tome el próximo número
-- de chef disponible … que chequee cuáles son los números que ya están generados"*.
--
-- ── ⚠ EL PISO DE FECHA TAMPOCO ES OPCIONAL ───────────────────────────────────────────
-- `tdf_como_chef_desde`. Un pedido ANTERIOR al piso no se mueve de empresa aunque cumpla
-- la regla: ya está programado (o entregado) como LK, y sacarlo del feed de LK para
-- meterlo en el de Chef lo haría entrar como pedido NUEVO — dos veces en la PPP. Medido el
-- 14/09 antes de prender: sin el piso, 4 pedidos (7 bloques) se habrían re-armado.
-- Lo de antes del piso se queda como está; lo que entra después nace bien.
--
-- ── SE PICKEA DE LA GÓNDOLA LOEKE IGUAL ──────────────────────────────────────────────
-- Y eso NO depende de la empresa de la NP: los artículos vienen con la L pegada (505L) y
-- `pkEmpresaArt` de Gestión fuerza góndola Loeke a todo código terminado en L. Es el mismo
-- camino que ya usan desde la v13.71 los pedidos de Chef con artículos de Loekemeyer.
-- O sea que la regla del dueño del 07/09 —*"el pedido se arma como Loeke, con una L al
-- final"*— se sigue cumpliendo con la NP en Chef.
--
-- ── PERILLAS (todas en `app_settings` de ESTE proyecto) ──────────────────────────────
--   tdf_como_chef        '1' / '0'      — el interruptor. En '0' todo vuelve al comportamiento viejo.
--   tdf_como_chef_desde  'YYYY-MM-DD'   — piso de fecha de recepción del pedido.
--   web_order_offset_lk  '1000000'      — el offset del order_id.
--
-- ROLLBACK: `update public.app_settings set value = '0' where key = 'tdf_como_chef';`
-- Con eso el job y la pantalla vuelven a tratarlos como pedidos de LK en la corrida
-- siguiente, sin redeployar nada (la Edge Function cachea la config por invocación, no
-- entre invocaciones; la pantalla, al recargar). Lo que ya se armó
-- como NP de Chef queda armado: para deshacerlo hay que borrar esas filas de
-- `PPP_Web_Programacion` / `PPP_Web_NP` / `PPP_Web_Base` en Virgilio (empresa 'chef',
-- order_id >= 1000000) y dejar que vuelva a entrar por LK.
-- =====================================================================================

insert into public.app_settings (key, value) values
  ('tdf_como_chef',       '1'),
  ('tdf_como_chef_desde', '2026-09-14'),
  ('web_order_offset_lk', '1000000')
on conflict (key) do nothing;

-- ── las tres piezas de configuración, envueltas para poder usarlas en SQL ────────────
create or replace function public.gv_web_tdf_on()
returns boolean language sql stable set search_path to 'public' as $$
  select coalesce((select nullif(btrim(value),'') from public.app_settings where key = 'tdf_como_chef'), '0') = '1';
$$;

create or replace function public.gv_web_tdf_offset()
returns bigint language sql stable set search_path to 'public' as $$
  select coalesce((select nullif(btrim(value),'')::bigint from public.app_settings where key = 'web_order_offset_lk'), 1000000);
$$;

create or replace function public.gv_web_tdf_desde()
returns date language sql stable set search_path to 'public' as $$
  -- Piso de fecha del corte. Sin fila configurada devuelve 9999-12-31, o sea: no corta
  -- nada. Falla cerrado a propósito.
  select coalesce((select nullif(btrim(value),'')::date from public.app_settings where key = 'tdf_como_chef_desde'),
                  date '9999-12-31');
$$;

-- ── LA REGLA, en un solo lugar ───────────────────────────────────────────────────────
create or replace function public.gv_web_es_tdf_chef(p_isis_empresa text, p_cod_isis text, p_fecha date)
returns boolean language sql stable set search_path to 'public' as $$
  -- v17.80 (Thomas, 14/09) — ¿este bloque de un pedido de la página LK es de CHEF?
  -- Lo es cuando la vista v_pedidos_web ya lo marcó para el ISIS de Chef (sucursal de
  -- entrega en Tierra del Fuego, o CUIT en gv_isis_override), tiene código de cliente en
  -- el padrón de Chef, la perilla está prendida y el pedido entró a partir del piso de
  -- fecha. Si alguna falla, el pedido sigue siendo de LK: el comportamiento viejo.
  select public.gv_web_tdf_on()
     and lower(coalesce(p_isis_empresa, 'lk')) = 'chef'
     and nullif(btrim(coalesce(p_cod_isis, '')), '') is not null
     and p_fecha is not null
     and p_fecha >= public.gv_web_tdf_desde();
$$;

revoke all on function public.gv_web_tdf_on()     from public;
revoke all on function public.gv_web_tdf_offset() from public;
revoke all on function public.gv_web_tdf_desde()  from public;
revoke all on function public.gv_web_es_tdf_chef(text, text, date) from public;
grant execute on function public.gv_web_tdf_on()     to anon, authenticated, service_role, gv_reader;
grant execute on function public.gv_web_tdf_offset() to anon, authenticated, service_role, gv_reader;
grant execute on function public.gv_web_tdf_desde()  to anon, authenticated, service_role, gv_reader;
grant execute on function public.gv_web_es_tdf_chef(text, text, date) to anon, authenticated, service_role, gv_reader;

-- ── LOS DOS FEEDS NO SE TOCARON ──────────────────────────────────────────────────────
-- `gv_pedidos_web_np_lk(date)` y `gv_pedidos_web_np_chef(integer)` siguen siendo las de
-- antes de la v17.80: devuelven TODO, sin filtrar ni agregar nada por Tierra del Fuego.
-- El reparto lo hace Gestión (ver el bloque de arriba). Para verlas:
--   select pg_get_functiondef('public.gv_pedidos_web_np_lk(date)'::regprocedure);
--   select pg_get_functiondef('public.gv_pedidos_web_np_chef(integer)'::regprocedure);
--
-- ⚠ Antes de agregarles UNA sola línea, medirlas. El 14/09:
--   gv_pedidos_web_np_lk(current_date - 30)  ->  328 bloques,  ~0,9 s
--   gv_pedidos_web_np_chef(30)               ->   36 bloques,  **7,03 s**  (timeout: 8 s)
--
-- ── QUÉ MIRA GESTIÓN, Y CÓMO SE REPRODUCE ACÁ ───────────────────────────────────────
-- Un bloque va a Chef cuando, en el feed de LK, `isis_empresa = 'chef'`, `cod_isis` está
-- cargado y `fecha_recep >= tdf_como_chef_desde`. Eso es exactamente `gv_web_es_tdf_chef`:
--
--   select f.order_id, f.np_idx, f.cod, f.cod_isis, f.fecha_recep
--     from public.gv_pedidos_web_np_lk(current_date - 30) f
--    where public.gv_web_es_tdf_chef(f.isis_empresa, f.cod_isis, f.fecha_recep);
--
-- Al 14/09 son 7 bloques de 3 pedidos: 2465 Il Cheff, 2643 El Martillo (x2), 2600 Alesso.
-- Gestión los guarda como `empresa = 'chef'`, `order_id + gv_web_tdf_offset()` y
-- `cod = cod_isis`; la razón social la resuelve contra `chef_padron`.
--
-- ── RESULTADO (corrida intradía del 14/09 16:35, GV_Tandas_Auto_Log id 514) ──────────
--   LK 1430 (El Martillo, 2 bloques) -> order_id 1001430 -> CH 0020 / CH 0021 -> E12H
--   LK 1431 (Il Cheff,     2 bloques) -> order_id 1001431 -> CH 0022 / CH 0023 -> E12P
--   LK 1432 (El Martillo,  1 bloque)  -> order_id 1001432 -> CH 0024            -> E12H
-- Los tres con entrega 21/09 y 60 filas en PPP_Web_Base, las mismas que tenían en LK.
