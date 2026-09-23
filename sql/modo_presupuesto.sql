-- ============================================================================
-- MODO PRESUPUESTO — cliente de exportación que pide cotización, no pedido
-- ============================================================================
-- Pedido de Thomas (23/09/2026), caso Classic S.A. (Paraguay, RUC 80013057-0).
--
-- QUÉ HACE. Un cliente marcado con `customers.modo_presupuesto = true` entra a
-- la página como cualquier otro, arma su lista y la envía — pero:
--   · NO ve precios: ni lista, ni "tu precio", ni subtotales, ni total.
--   · NO ve descuentos de ningún tipo: ni dto x volumen, ni el 2% web, ni el
--     método de pago (el bloque entero no se dibuja).
--   · Lo que manda entra a `orders` con subtotal y total en 0, y viaja a la PPP
--     de Gestión por el camino de siempre (v_pedidos_web → v_pedidos_web_np),
--     que nunca llevó precios: sólo artículo, cajas, uxb y unidades.
--
-- ⚠ QUE NO VEA PRECIOS NO ES CSS. En este modo `loadProductsFromDB` de
-- script.js directamente NO pide la columna `list_price`, así que el precio no
-- baja al navegador. Esconderlo por estilos lo habría dejado a un clic de
-- distancia en las herramientas del navegador.
--
-- ⚠ LA BANDERA ES DEL CLIENTE, NO DE QUIEN ESTÁ LOGUEADO. Si un vendedor o un
-- admin carga el pedido POR él, sigue siendo un presupuesto: lo que se cotiza
-- es la operación del cliente, no la pantalla del que tipea.
--
-- ⚠ CÓMO SE ENTERA LA PPP. No hay columna nueva en el feed (eso obligaría a
-- tocar también Gestión-Virgilio, que es otro repo). El aviso viaja por
-- `observaciones`, que ya llega entero a `v_pedidos_web_np.observaciones`:
-- cada pedido de un cliente en este modo arranca con
--     "PRESUPUESTO — NO DESPACHAR, COTIZAR"
-- y además la condición de pago dice "PRESUPUESTO A COTIZAR".
-- Si algún día se quiere un badge propio en "A Programar", eso se agrega del
-- lado de Gestión leyendo `sheets_payload->>'tipo_documento' = 'presupuesto'`,
-- que la ficha del pedido ya trae.
--
-- CORRER A MANO en el SQL editor del proyecto (los .sql de este repo no se
-- ejecutan solos). Es idempotente.
-- ============================================================================

-- ─── 1. La bandera ──────────────────────────────────────────────────────────
alter table public.customers
  add column if not exists modo_presupuesto boolean not null default false;

comment on column public.customers.modo_presupuesto is
  'true = el cliente arma PRESUPUESTOS, no pedidos: no ve precios ni descuentos '
  'y lo que envía entra con total 0 para que lo coticemos. Caso de uso: '
  'exportación (Classic S.A., Paraguay). Ver sql/modo_presupuesto.sql.';

-- ─── 2. Dar de alta a Classic S.A. y prenderle la bandera ──────────────────
--
--     Razón social : CLASSIC S.A.
--     CUIT/RUC     : 800130570     ← el RUC paraguayo 80013057-0, SIN guiones
--     Dto x volumen: 0             ← no ve descuentos, pero que quede en 0
--     Código       : 4284 en LOEKEMEYER · 1362 en CHEF
--
-- ⚠ Las numeraciones de las dos empresas son INDEPENDIENTES: 4284 en Chef y
-- 1362 en Loekemeyer son OTROS negocios. No cruzar los números.
--
-- ⚠ EL ALTA DEL CLIENTE VA POR EL PANEL (ABM Clientes), NO POR SQL. No es un
-- capricho: el panel además crea el usuario de `auth` con el mail sintético
-- <dígitos>@cuit.loekemeyer (llama a la Edge Function `crear-cliente-auth`).
-- Un INSERT a mano en `customers` deja al cliente SIN poder entrar a la página.
--
-- El 4284 se verificó libre el 23/09/2026: sin ficha en `customers`, sin una
-- sola línea en `sales_lines`, y es el siguiente al 4283 (Cardye S.R.L.), que
-- era el último cargado. El código lo asigna ISIS; acá sólo se deja asentado.

-- ── 2.a) Prender la bandera, una vez que el cliente ya está cargado ─────────

-- CHEF (proyecto nkhzocgdpwtgrmwleihr):
--   update public.customers set modo_presupuesto = true where cod_cliente = 1362;

-- LOEKEMEYER (proyecto kwkclwhmoygunqmlegrg):
--   update public.customers set modo_presupuesto = true where cod_cliente = 4284;

-- ─── 3. Verificación (correr SIEMPRE después de prender la bandera) ─────────
-- select cod_cliente, business_name, cuit, dto_vol, modo_presupuesto
--   from public.customers
--  where modo_presupuesto
--  order by cod_cliente;

-- ─── 4. Apagarlo ────────────────────────────────────────────────────────────
-- update public.customers set modo_presupuesto = false where cod_cliente = <cod>;
