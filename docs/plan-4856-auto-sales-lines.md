# Plan idea 4856 — Auto-rellenar `sales_lines` desde lo facturado + cruce `order_items`↔`sales_lines`

Estado: **anotado, sin implementar** (decisión del dueño, 2026-09-08). Idea `4856` en
`agente_propuestas` (Supabase Virgilio) y en `Gestion-Virgilio/docs/IDEAS-USUARIO.md`.
Repo afectado: **este** (`pagina-LK-copia`, proyecto Supabase LK `kwkclwhmoygunqmlegrg`).

## Problema
Hoy `sales_lines` (~260k filas, la fuente de casi toda la Estadística de Clientes,
el Ranking Inactivos, la Estadística Madre, el Dashboard y los reportes `rep_*`) se
llena **100% a mano**: el Excel de facturación de ISIS se sube al Table Editor, un
lote por mes (`import_batch` tipeado, `ago-26`…). El dueño quiere (1) rellenarla
automático desde lo que ya se factura, y (2) una aptitud que apenas se carga un
pedido verifique que lo pedido (`order_items`) y lo facturado (`sales_lines`) no
queden cruzados — todo **sin romper ningún programa**.

## Hallazgos de la investigación (verificados en base viva, 2026-09-08)
- **La fuente para auto-rellenar YA EXISTE en Virgilio** y LK ya lo lee por `postgres_fdw`
  (patrón `ppp_*`): `vista_facturacion_neto_items` (np, cod_cliente, `cod`, `cajas_ent`,
  uxb, precio_lista, dto_vol, `importe_ent`, `es_super`), con el hecho "facturada" en
  `Facturacion_NP` (`fecha_salida`, `facturado_at`). Cobertura desde **2026-06-30**; lo
  anterior sigue siendo Excel ISIS.
- **Código**: LK `item_code` está zero-padded (`031`, `522E`) = `products.cod`. En Virgilio
  usar **`cod` (zero-padded), NO `cod_canon`** (este quita ceros y rompe el join).
- **Empresa**: por prefijo de NP — regla robusta `left(np,1)='4' ⇒ chef, si no ⇒ lk`
  (hay `9xxxx`=lk, `4xxxx`=chef y `L`/`LK` del contador web). A confirmar.
- **`row_hash` NO sirve como guard de dedup** (incluye batch/timestamp; Chef ya se
  duplicó a 71.574 filas). Dedup real solo por `(customer_code,item_code,invoice_date,boxes,empresa)`.
- **Gap ISIS↔Virgilio medido (ago-26, lk)**: Virgilio cubre ~86% de las cajas, ~85% de
  los clientes, ~60% de los artículos. NO son intercambiables (ISIS factura NC, artículos
  fuera del catálogo Virgilio y facturación directa; las fechas difieren).
- **NO hay vínculo hoy** entre `order_items` (usa `product_id` uuid) y `sales_lines`.
  `v_pedidos_match`/`lk_pedidos_match` cruzan pedido web ↔ producción Virgilio, no facturación.

## FASE 1 — Cruce/consistencia pedido↔facturación (solo lectura, riesgo casi cero)
Archivo nuevo: `sql/cruce_pedido_factura.sql`.
- Foreign table `virgilio.facturacion_neto_items` → `vista_facturacion_neto_items`
  (prerrequisito lado Virgilio: `grant select on public.vista_facturacion_neto_items to lk_ppp_reader;`).
- RPC `get_cruce_pedido_factura(p_desde, p_hasta, p_empresa='lk', p_ventana_dias=10)` con
  **guard admin** + `revoke execute from public, anon, authenticated`. Solo lectura, no
  toca `orders`/`order_items`/`sales_lines`.
- Casa por `match_string` de `v_pedidos_match` (cajas pedidas por cliente+cod) contra
  `cajas_ent` facturadas dentro de **ventana de fecha** `[fecha_pedido, +N días]`
  (la fecha de factura ≠ la de pedido). Suma todas las NP de la ventana → resuelve el
  split de facturas. Semáforo por pedido: `completo/parcial/nada/exceso` (tolerancia 1 caja),
  `faltante = ped − fact`. Hereda `ambiguo` (sucursal) y `resubmit` de `v_pedidos_match`.
  `evaluable=false` para pedidos demasiado nuevos para estar facturados (no se pintan "nada").
- Pantalla: pestaña en Gerente de ventas o ítem de sidebar en `admin.html`/`admin.js`.
  **Espejar el cambio del admin al repo `Produccion-Virgilio` bajo `/admin/`** (regla CLAUDE.md).
- **NO viable**: reconciliar precio contra `sales_lines` (no guarda importe). Se puede
  mostrar `importe_ent` de Virgilio como dato informativo del lado factura.

## FASE 2 — Auto-rellenado de `sales_lines`
Archivo nuevo: `sql/sales_lines_auto_virgilio.sql`.
- **Arquitectura recomendada**: insertar en `sales_lines` con `import_batch='virgilio_auto'`
  (NO tabla puente + vista `UNION`, que perdería el índice parcial `sales_lines_lk_cliente_idx`
  y degradaría el camino caliente de los 8 módulos). Rollback trivial por lote.
- Espejo local `public.fact_virgilio_lineas` (como `ppp_np_feed`, RLS on, revoke anon/auth,
  índice `(empresa, fecha_salida)`) poblado desde el FDW en un bloque dentro de
  `sincronizar_ppp()` (ya corre diario y ya toca el FDW).
- Config de corte `public.sales_lines_auto_corte(empresa, desde_fecha)` — auto solo inserta
  `invoice_date >= desde_fecha`. Editable por el dueño.
- **INSERT idempotente**: `row_hash = md5(clave natural de 5 columnas)` (así el UNIQUE sí
  actúa de guard) + `NOT EXISTS` contra `sales_lines` por la clave natural (cubre choque
  con filas manuales) + agregación por clave natural (resuelve el split de NP).
- **Convivencia**: el dedup NO alcanza en un mes de transición (los totales difieren ~14%
  → doble conteo parcial). **Una sola fuente por mes**: fijar `desde_fecha` y **dejar de
  subir el Excel** para meses ≥ corte.
- **Validación en modo sombra** antes de cortar: poblar `fact_virgilio_lineas` sin insertar
  a `sales_lines`, y RPC `verif_auto_vs_manual(p_mes, p_empresa)` que compare por clave
  natural (solo-manual / solo-auto / coincidentes) + totales de cajas y valorización.
  Chequear artículos de Virgilio sin ficha en `products` (uxb=1 subvalúa, como los Chef 701/706).
- **Backup** de `sales_lines` antes del primer insert. Rollback: `DELETE FROM sales_lines
  WHERE import_batch='virgilio_auto';` (WHERE real por `supautils`).

## Secuenciación
1. Fase 1 (read-only): entrega valor y **muestra el gap ISIS↔Virgilio en pantalla**, que es
   lo que el dueño necesita para decidir (a) y (b).
2. Fase 2 en modo sombra: foreign table + `fact_virgilio_lineas` + `verif_auto_vs_manual`,
   sin insertar. Validar jul-26/ago-26.
3. Con la decisión del dueño: fijar corte, backup, habilitar INSERT, cortar el Excel.

## Decisiones a confirmar con el dueño ANTES de tocar nada
- **(a)** ¿`sales_lines` = lo **entregado** (Virgilio `cajas_ent`) o la **factura ISIS real**?
  Difieren ~14% cajas / ~40% artículos (ago-26). Recomendado: entregado.
- **(b)** ¿Desde qué mes pasa a auto y desde cuándo se deja de subir el Excel? Recomendado:
  fijar corte recién tras validar en sombra; una sola fuente por mes.
- **(c)** Imputación de empresa para art LK vendido por Chef/TdF. Recomendado: por prefijo
  de NP (`4`=chef, resto=lk); confirmar que `L`/`LK` = lk.
- **(d)** Equivalencia de código: verificado `cod` (zero-padded) de Virgilio = `item_code`
  de LK; **no usar `cod_canon`**.
- Prerrequisito de permisos lado Virgilio: `grant select on public.vista_facturacion_neto_items to lk_ppp_reader;`

## Archivos de referencia (patrones a reusar)
- `sql/reporte_deposito_gestion.sql` — `import foreign schema` + espejo + bloque en `sincronizar_ppp()`.
- `sql/pedidos_match_virgilio.sql` — FDW + `v_pedidos_match`/`match_string`.
- `impactar_ventas_chef_en_sales_lines.sql` — INSERT idempotente a `sales_lines` por `import_batch` + rollback por lote.

---

## Validación de datos (2026-09-08/09) — solo lectura, nada tocado en producción

Se comparó, para agosto-2026 (y jun/jul como control), lo facturado en **ISIS**
(`sales_lines` empresa `lk`, valorizado con la cadena LK: `list_price·uxb·(1−dto_vol)·0,98`,
usando `products ∪ loke_products` y quitando el sufijo "L") contra la **facturación de
Gestión-Virgilio** (`vista_facturacion_neto_items` + `Facturacion_NP`, lado lk = NP no
empieza en 4).

### Totales agosto-2026 (lk)
| | ISIS | Gestión (ajust.) |
|---|--:|--:|
| cajas | 22.556 | 19.371 (85,9%) |
| importe $ | 522,1M | 492,4M (94,3%) |

### Cobertura por mes (rampa de adopción)
- may-26: 0% · jun-26: 0,3% · **jul-26: 84% cajas / 84% $** · **ago-26: 86% cajas / 94% $**.
- Gestión (Producción Virgilio) arranca ~30/6; may/jun no son comparables.

### Valorización: NO difiere (verificado componente a componente)
- **No-súper** (3.479 de 3.522 grupos coincidentes): lista, uxb y dto **idénticos**; el
  único desvío es un **+2,0% plano = el descuento web (0,98)** que la valorización de
  Gestión (`importe_ent`) no aplica. Aplicando `×0,98` al no-súper, coinciden (residuo 0,015%).
- **Súper** (43 grupos): lista propia del súper y factor 1,00 (sin 2%). Ahí **Gestión está
  bien** (lista real del súper) y la reconstrucción LK está mal (usa lista general ×0,98).
- **Regla del dueño (2026-09-09): el súper NUNCA lleva el 2% (salvo que ya esté en su precio)
  y tiene su propia lista.** Los datos lo confirman.

### La brecha que queda es COBERTURA, no precio
Desglose del gap solo-ISIS de agosto ($54,4M):
- **Cencosud (2444): $39,4M / 1.403 cajas.** Ver hallazgo abajo.
- **Facturación directa fuera de Gestión: ~$17M / ~35 clientes** (2686, 2532, 2364, 4059…).
  No pasan por la página ni por Gestión — hueco real que Gestión no cubre.
- **Notas de crédito / devoluciones**: cajas negativas de ISIS (1651, 1434) que Gestión no
  registra (Gestión tiene entregas, no NC/ND).
- **Línea 7xx sin precio**: cajas presentes, importe 0 en los dos lados.

### Pedidos web agosto
212 pedidos entraron por la página LK por $450,2M (total de pedido); **los 212 están
enganchados en Gestión** (`lk_pedidos_match`). Por canal: 174 clientes Web→Gestión, 79
"Gestión sin pedido web" (ISIS/teléfono producidos por Virgilio), 30 "ISIS directa".

### ⚠ Hallazgo: Cencosud (2444) mal imputado en `sales_lines`
- **2444 es venta de CHEF de artículos de Loeke** (confirmado por el dueño; regla v13.79 de
  Gestión: NP de Chef con artículos Loeke sin "L").
- En `sales_lines` figura como **`empresa='lk'` todos los meses desde 2024-03** (y además
  como `empresa='chef'` en el import histórico, con cajas que coinciden mes a mes → es la
  misma venta doble-etiquetada). Como los módulos filtran `empresa='lk'`, **cuentan a
  Cencosud como cliente de Loekemeyer**: infla el Ranking, el Dashboard y la Estadística
  Madre en **~$196,6M los últimos 12m** (~$574M histórico, 25.216 cajas).
- **Es el ÚNICO cliente con ese patrón** (detector lk∩chef con cajas coincidentes ≥60% de
  los meses: solo 2444). Salvedad: el detector solo ve clientes presentes en el import
  histórico de Chef; un chequeo completo cruzaría por CUIT contra la facturación Chef de
  Gestión.
- Consecuencia: el auto-fill por NP (4=Chef) lo clasificaría **bien** solo. Da vuelta la
  decisión (c): a Cencosud **no** hay que recuperarlo hacia lk, hay que **sacarlo**.
- Arreglo puntual pendiente (requiere OK del dueño, toca datos): excluir/re-etiquetar 2444
  del lado lk (filtro en las RPC de lk, o corregir `empresa` con backup previo).

## Condición de implementación (decisión del dueño, 2026-09-09)
**El norte es alimentar la info de ventas desde el pipeline de Gestión-Virgilio.** PERO hoy
**la verdad es ISIS**: es el facturador y el que genera las **NC y ND**. Gestión sólo tiene
entregas, no notas de crédito/débito.
**NO se implementa el auto-fill hasta que haya coincidencia 100% entre el módulo de
Facturación de Gestión-Virgilio e ISIS.** Mientras exista brecha (facturación directa fuera
de Gestión, NC/ND, precios faltantes, imputación de empresa), ISIS sigue siendo la fuente y
esto queda como validación/monitoreo, no como reemplazo. La Fase 1 (cruce/consistencia,
solo lectura) es lo que va midiendo esa convergencia mes a mes.
