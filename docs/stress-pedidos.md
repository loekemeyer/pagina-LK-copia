# ¿Aguanta el sitio 100 pedidos al mismo tiempo?

Medición hecha contra la base de producción el **24/09/2026**, antes de correr
ninguna prueba de carga. Herramienta: `tests/stress-pedidos.mjs`.

---

## 1. El número que importa no es 100. Es 2.000.

`submit_order_fast` es **una** llamada. Pero `script.js`, en el bloque
"EFECTOS SECUNDARIOS" (~línea 9510), dispara después de la RPC:

| Qué | Cuántos |
|---|---|
| `UPDATE orders` (is_promo, extra_discount, placed_by) | 1 |
| `UPDATE order_items` — **uno por línea del pedido** | 17,5 |
| `sheets-proxy` (Google Apps Script) | 1 |
| `sheets-entregas-proxy` | 1 |
| `UPDATE orders SET sheets_sent` | 1 |

Las 17,5 líneas son el promedio medido sobre **645 pedidos de 90 días**
(mediana 14, p95 44, máximo 93).

> **100 pedidos simultáneos ≈ 2.150 requests HTTP en ráfaga**, no 100.

Una prueba que mande 100 llamadas a la RPC y nada más da verde y no prueba nada.

## 2. Dónde se rompe primero: el pool de PostgREST, no la base

**La base no es el cuello.** Medido:

| Pieza | Costo |
|---|---|
| Guard SIN STOCK (17 líneas) | **7,1 ms** |
| Guard anti-reintento | **0,17 ms** |
| Índices de `orders` / `order_items` | todos presentes, los planes salen por índice |
| Triggers sobre `orders` | 3, los tres baratos (1 SELECT + 1 INSERT a `wa_outbox`) |

**PostgREST tiene 11 conexiones abiertas** a Postgres (`pg_stat_activity`,
`application_name = 'PostgREST 14.5'`). Ése es el pool de la instancia Micro.
`max_connections` es 60, pero el que reparte es PostgREST.

➜ **~2.150 requests compitiendo por ~12 slots.** Se serializan de a 12.

`max_worker_processes = 6` — el límite que tiró la base el 17/09 — **no aplica
acá**: ése es para background workers (pg_cron, pg_net), no para requests HTTP.

## 3. El modo de falla peligroso: el timeout de 15 s del navegador

`script.js` envuelve la RPC en `withTimeout(..., 15000)`. Si la cola del pool
hace que la RPC tarde más de 15 s:

1. El navegador tira `Timeout (15000ms) en submit_order_fast`.
2. **El pedido YA entró en la base.** La transacción del servidor no se cancela.
3. El cliente ve error y vuelve a apretar Confirmar.

Lo salva el guard anti-reintento (mismo cliente + mismo total + misma cantidad
de líneas, dentro de 2 minutos). Pero ese guard **hace SELECT y después INSERT
sin ningún lock**: dos requests simultáneos no ven la fila del otro (todavía no
está commiteada) y los dos insertan. Justo el caso que dice cubrir.

`--test-guard` mide exactamente eso: 10 pedidos idénticos lanzados juntos.
Si vuelven más de un `id` distinto, el guard pierde bajo concurrencia.

## 4. Los 17,5 updates por pedido están de más

La RPC **ya inserta `source`** en las dos ramas de `INSERT INTO order_items`
(`NULLIF(btrim(item->>'source'), '')`), y `rpcItems` en `script.js` ya lo manda.
El `UPDATE` posterior, línea por línea, es redundante.

Y además no funciona para la línea Loke: filtra por `.eq("product_id", …)`, pero
las líneas Loke guardan el uuid en `loke_product_id` y dejan `product_id` NULL.
Medido sobre 60 días: **41 líneas Loke, las 41 con `source` NULL**.

Sacar ese bloque **divide la carga por ~18** sin cambiar ningún comportamiento.
Es el primer arreglo, y es de dos líneas.

## 5. Contexto de escala: 100 no va a pasar

Pico real de `orders` en 180 días:

| Métrica | Valor |
|---|---|
| Pedidos en el minuto más cargado | **6** |
| Minutos con ≥ 10 pedidos | **0** |
| Pedidos en la hora más cargada | 31 |
| Pedidos últimos 30 días | 242 |

100 simultáneos es **17× el peor minuto que existió**, comprimido en un segundo.
Está bien medir el techo, pero el número que decide si hay que tocar algo es el
de **10–20**, que sí puede pasar un lunes a la mañana o en una promo.

Por eso `--rampa` corre 1 → 5 → 10 → 20 → 50 → 100: el dato útil no es
"100 rompe sí/no", es **en cuánto empieza a doler**.

---

## Cómo se corre

```bash
export LK_CUIT=30xxxxxxxxx      # cliente de prueba
export LK_PIN=123456

node tests/stress-pedidos.mjs --rampa              # NO escribe. Empezar por acá.
node tests/stress-pedidos.mjs --test-guard --si-escribir-en-produccion
node tests/stress-pedidos.mjs --modo carga --n 20 --si-escribir-en-produccion
node tests/stress-pedidos.mjs --limpiar
```

El modo por defecto (`simulacro`) **no escribe una sola fila**: repite el camino
de lectura que hace el navegador justo antes de confirmar. Ya estresa auth,
PostgREST y el pool, que es donde está la mitad del problema.

## ⚠ Los seis efectos colaterales de escribir en producción

Un pedido de prueba **no se queda quieto en `orders`**:

1. **Google Sheets de ventas** (`sheets-proxy`) — el script no lo llama, pero el
   sitio sí: son filas en la planilla del equipo.
2. **Sheet de entregas / Base Picking** — ídem.
3. **PPP de Gestión Virgilio** — `v_pedidos_web` los publica **en vivo**, y el
   cron `sync-pedidos-match-virgilio` corre **cada 15 minutos**. Salen en
   "A Programar" y alguien los arma. *Hay 15 minutos para borrarlos.*
4. **WhatsApp al cliente** — el trigger `orders_notify_whatsapp` encola una fila
   en `wa_outbox` por pedido. Si el cliente de prueba tiene WhatsApp cargado en
   `bot_customer_whatsapps`, son 100 mensajes reales.
5. **El numerador de pedidos salta N.** Las secuencias no se revierten ni
   borrando las filas: el próximo pedido real arranca 100 más arriba.
6. **Los reportes `rep_*` de Telegram** del día siguiente cuentan esa plata como
   venta del portal.

Mitigaciones que ya trae el script: no llama a ninguno de los dos proxies de
Sheets, marca cada pedido con `sheets_payload->>'stress_test' = true` y
`observaciones = 'STRESS TEST — NO DESPACHAR'`, y `--limpiar` los borra
(hijos antes que padres).

**Lo que hay que hacer a mano antes:** confirmar que el cliente de prueba **no
tiene fila en `bot_customer_whatsapps`**. Si la tiene, son 100 WhatsApps.
