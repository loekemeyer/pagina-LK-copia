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

-- ─── 2. Dar de alta a los clientes y prenderles la bandera ─────────────────
--
-- Clientes de exportación (Paraguay) con este modo, al 23/09/2026:
--
--     Razón social      RUC          cod LK   cod Chef
--     ----------------  -----------  -------  --------
--     CLASSIC S.A.      800130570      4284      1362
--     GIMENEZ CALVO SA  800015924      4285      (sin código: no opera en Chef)
--
-- ⚠ El RUC va en `cuit` SIN guiones ni puntos: 80013057-0 → 800130570. Son 9
-- dígitos (8 + verificador) y el login los acepta desde que se bajó el piso de
-- `looksLikeCUIT` a 8. `dto_vol` va en 0: no ven descuentos de ningún tipo.
--
-- ⚠ Las numeraciones de las dos empresas son INDEPENDIENTES: 4284 en Chef y
-- 1362 en Loekemeyer son OTROS negocios. No cruzar los números.
--
-- ⚠ EL ALTA DEL CLIENTE VA POR EL PANEL (ABM Clientes), NO POR SQL. No es un
-- capricho: el panel además crea el usuario de `auth` con el mail sintético
-- <dígitos>@cuit.loekemeyer (llama a la Edge Function `crear-cliente-auth`).
-- Un INSERT a mano en `customers` deja al cliente SIN poder entrar a la página.
-- El panel NO valida el largo del CUIT, así que el RUC de 9 dígitos entra bien.
--
-- Los dos códigos se verificaron libres antes de asignarlos (23/09/2026): sin
-- ficha en `customers` y sin una sola línea en `sales_lines`. El 4283 (Cardye
-- S.R.L.) era el último cargado. El código lo asigna ISIS; acá sólo se asienta.

-- ── 2.a) Prender la bandera, una vez que el cliente ya está cargado ─────────

-- LOEKEMEYER (proyecto kwkclwhmoygunqmlegrg):
--   update public.customers set modo_presupuesto = true
--    where cod_cliente in (4284, 4285);

-- CHEF (proyecto nkhzocgdpwtgrmwleihr) — sólo Classic:
--   update public.customers set modo_presupuesto = true where cod_cliente = 1362;

-- ─── 3. Verificación (correr SIEMPRE después de prender la bandera) ─────────
-- select cod_cliente, business_name, cuit, dto_vol, modo_presupuesto
--   from public.customers
--  where modo_presupuesto
--  order by cod_cliente;

-- ─── 4. Apagarlo ────────────────────────────────────────────────────────────
-- update public.customers set modo_presupuesto = false where cod_cliente = <cod>;
