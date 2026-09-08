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
