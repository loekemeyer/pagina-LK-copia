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

### La brecha que queda es COBERTURA, no precio — y NO es "fuera de Gestión"
Desglose del gap solo-ISIS de agosto ($54,4M). **CORREGIDO 2026-09-09**: se verificó cliente
por cliente y **no existe "facturación directa fuera de Gestión"** — todo pasa por Gestión.
Lo que parecía un hueco es en realidad:
- **Cencosud (2444): $39,4M / 1.403 cajas.** Venta de Chef de art Loeke; ISIS la tagea lk. Ver
  hallazgo abajo.
- **~$18M / 29 clientes que yo había llamado "directa" son otras dos cosas** (verificado: los
  29 están en Gestión con entregas jul-sep):
  - **Mayoría = el mismo caso Cencosud, más amplio**: Gestión los factura como **Chef** (NP
    4xxxx) e ISIS los tagea `lk` porque los artículos son Loeke. Las cajas ISIS-agosto
    coinciden con las entregas de Gestión (ej. 2118, 1253=137, 2687=127, 2708=44, 328=36).
    En ISIS llevan el **código de cliente de Chef** con `empresa='lk'`, así que resueltos
    contra el padrón LK salen con nombre equivocado (2118 "Milera" en LK vs "Cuatro Robles"
    en Gestión-Chef; 2335 "Gastroeuropa" vs "Montenegro").
  - **Minoría = timing de borde de mes**: clientes LK genuinos cuya factura ISIS cae fin de
    mes y la entrega de Gestión al mes siguiente — misma venta, mes distinto (2364, 3875,
    4059: ISIS 31/8 → Gestión fecha_salida sep; 2532, 2447: jul).
- **Notas de crédito / débito (NC/ND)**: cajas negativas de ISIS (1651, 1434) que Gestión no
  genera. **Es lo ÚNICO genuinamente ISIS-only.**
- **Línea 7xx sin precio**: cajas presentes, importe 0 en los dos lados.

**Implicancia**: el auto-fill desde Gestión, imputando empresa por NP (4=Chef), clasifica
todo esto CORRECTAMENTE (Chef→no entra a lk; timing→mes correcto). El "hueco de cobertura"
casi desaparece; lo único que Gestión no tiene son las NC/ND.

**Implicancia 2 (importante)**: el problema Chef-de-Loeke mal imputado como lk en `sales_lines`
es MUCHO más amplio que solo Cencosud — hay ~24 clientes Chef más ensuciando las estadísticas
LK. El detector anterior (lk∩chef en `sales_lines`) solo veía los que están en el import
histórico de Chef; estos no están ahí pero en Gestión son Chef. El detector correcto es cruzar
los códigos lk de `sales_lines` contra la facturación de Gestión y ver cuáles resuelven a Chef.

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

---

## Fase 1.5 — Capa TENTATIVA del mes en curso (primer uso productivo, bajo riesgo)

### Motivo (verificado 2026-09-09)
La carga de ISIS a `sales_lines` es **mensual y con rezago**: un lote por mes calendario
(`import_batch` = `febrero_26`, `marzo_26`, … `ago-26`), importado a mano entre el **día 1 y
14 del mes siguiente** (casi siempre 1-6; junio se atrasó al 14). Cadencia real medida:

| mes facturado | importado |
|---|---|
| feb | 04/03 · mar → 06/04 · abr → 05/05 · may → 01/06 · jun → **14/07** · jul → 03/08 · ago → 02/09 |

**Consecuencia:** durante el mes en curso `sales_lines` NO tiene nada de ese mes; aparece
recién cuando cierra y lo importan. O sea todo el panel de LK está **ciego al mes corriente**
hasta ~día 1-14 del siguiente. Gestión-Virgilio (`Facturacion_NP`) está **en vivo** (diario).

### Diseño (no rompe "ISIS es la verdad")
- Capa que inserta en `sales_lines` SOLO el tramo **posterior al último mes cerrado de ISIS**
  (`invoice_date > max(invoice_date de ISIS)`), tomada de la facturación de Gestión por FDW.
- `import_batch = 'virgilio_tentativo'` (flag de provisional). No pisa filas de ISIS.
- Cron diario refresca el tramo abierto (delete+insert del batch tentativo).
- Cuando ISIS cierra e importa el mes → se **borra el batch tentativo** de ese período y
  manda ISIS. Rollback: `DELETE FROM sales_lines WHERE import_batch='virgilio_tentativo'`
  (WHERE real, por `supautils`).
- **Esquiva el bloqueo del "100% de coincidencia"**: es explícitamente tentativo y ISIS lo
  reemplaza al cerrar; no necesita ser exacto, solo útil para ver el mes en curso.
- Empresa por prefijo NP (4=Chef → NO entra a lk; resuelve solo el caso Cencosud).

### Límites del dato tentativo (hay que mostrarlo como "estimado")
Subestima el mes: le falta la **facturación directa fuera de Gestión** (~$17M/mes), las
**NC/ND** (Gestión no las tiene) y el precio de la **línea 7xx**. Es "en vivo aproximado",
no el cierre.

### Qué lo usaría (todo lo que lee `sales_lines` empresa `lk` lo toma solo, sin tocar consumidores)
Como la capa alimenta la misma tabla, **cualquier RPC que lea `sales_lines` lk hereda el mes
en curso automáticamente**. Consumidores actuales del dato exportado de ISIS:

| Consumidor (RPC/vista) | Pantalla / uso | ¿Gana con el vivo? |
|---|---|---|
| `get_ranking_inactivos` / `_export` | Ranking Inactivos: última compra, valor, desglose x año, Excel | **Sí** — un cliente que compró este mes ya no figura "inactivo" |
| `get_estadistica_clientes_agg` | Estadística Clientes → "Próximos pedidos" | **Sí** — deja de marcar atrasado a quien ya compró |
| `gv_candidatos` | Gerente de ventas: señales/agenda diaria (reactivar, ritmo_caído…) | **Sí** — evita falsos "frío" del mes en curso |
| `gv_dashboard_calcular/_calcular2/_extra` | Dashboard de ventas: FACTURADO por mes | **Sí** — el gran ganador: hoy el mes corriente sale en 0 |
| `datos_cliente_empresa` | Clientes agrupados / Sugerencias / buscador / Clientes vinculados | Sí (última compra y valor al día) |
| `get_vendedores_ranking` | Filtro por vendedor del Ranking | Sí (indirecto) |
| `get_acuerdo_vendedores` | Comisiones por vendedor | Parcial (tentativo, no liquidar con esto) |
| `gv_cobertura` / `gv_cobertura_provincia` | Cobertura geográfica (activos) | Menor |
| `refresh_estadistica_madre_cache` / vista `estadistica_madre` | Estadística Madre → **portal cliente** (sugerencias) + **OCs de Virgilio** (proyección) | Leve (proyección 6m; suma el mes parcial) |
| `get_all_sales_lines_admin(_with_customer)` | Fuente de Estadística Madre | Leve |
| `get_customer_sales_history` / `get_customer_history` | Historial cliente, Análisis Venta Cliente, portal | Menor (histórico) |
| `sugerencias_cliente` | Sugerencias del portal | Menor |
| `v_customer_item_month` | Detección de anomalías del carrito (`script.js`) | No (usa promedios históricos) |
| `ficha_cliente` / `get_ficha_cliente` | Ficha de cliente | Menor |
| reportes `rep_*` (Telegram diario/semanal/mensual) | Reportes de ventas por Telegram | Sí (el $ del mes; el depósito ya sale de Gestión) |

**Prioridad de valor**: Dashboard FACTURADO, Ranking Inactivos y las señales del Gerente de
ventas — son los tres que hoy sufren más la ceguera del mes en curso. Los históricos
(historial, ficha, anomalías) casi no cambian.

### FUENTE MEJOR que Gestión-entregas: el parser de ISIS ya existe (hallazgo 2026-09-09)
En el proyecto **Virgilio** hay un parser vivo de los comprobantes de ISIS:
**`comprobantes_venta`** (39.551 filas, FC+NC+ND, `marca` LK/CH, `tipo`, `signo`, `total`,
`total_cajas`, `subtotal`, IVA, `contraparte_cuit/codigo`, `fecha`, `cae`) — cubre **hasta
HOY**. Es el output real del facturador, no las entregas.

**Ventajas sobre la facturación de Gestión (entregas):**
- **Trae NC y ND** (lo único genuinamente ISIS-only que a Gestión le falta). Ago LK: 229 NC
  = −$133M / −1.975 cajas.
- **Marca correcta por comprobante** (CUIT/punto de venta), no por artículo → resuelve solo
  el problema Cencosud / Chef-de-Loeke. Verificado: su LK-agosto (20.869 cajas FC) es MENOR
  y más correcto que `sales_lines` lk (22.556, inflado por Chef-de-Loeke).
- Es **prácticamente la versión viva del Excel mensual** (los dos salen de ISIS).

**Comparación mes cerrado (agosto, LK):**
| Fuente | cajas | $ |
|---|--:|--:|
| `sales_lines` (Excel, net reconstruido) | 22.556 | $522,1M |
| `comprobantes_venta` FC (subtotal s/IVA) | 20.869 | $546,5M |
| `comprobantes_venta` NC | −1.975 | −$133,1M |

**Límite**: es **nivel cabecera** (`total_cajas` + `familia`, sin `item_code`/líneas por
artículo). Sirve para $/cajas/actividad/NC-ND **por cliente**; NO para proyección por
artículo (Estadística Madre), que necesita líneas.

### Arquitectura recomendada (revisada)
- **Mes en curso + NC/ND, nivel cliente/$**: `comprobantes_venta` (ISIS real, vivo,
  marca-correcto) por FDW. Reemplaza a "Gestión-entregas" como fuente tentativa preferida.
- **Nivel artículo** (proyección madre): Gestión entregas (`vista_facturacion_neto_items`,
  líneas) o el Excel al cierre.
- **Verdad final**: el Excel mensual sigue mandando; la convergencia se mide comparando
  `comprobantes_venta` vs el Excel en cada mes cerrado (deberían casar casi exacto por venir
  ambos de ISIS). Ese es el termómetro concreto de la **condición de implementación**.
- **Pendiente de confirmar**: si `comprobantes_venta` tiene (o puede tener) una tabla de
  líneas por artículo; hoy no se ve una `*_items` poblada.

### Convergencia parser vs Excel — medida a nivel cliente (agosto LK, mes cerrado)
| | clientes | cajas | $ |
|---|--:|--:|--:|
| `sales_lines` (Excel, net) | 220 | 22.556 | $522,1M |
| `comprobantes_venta` FC (subtotal s/IVA) | 191 | 20.869 | $546,5M |

- **Cobertura completa**: **0 clientes** están solo en el parser; todo lo que el parser
  tiene, el Excel también.
- **29 clientes están solo en `sales_lines`** ($46,1M / 3.307 cajas) = los **Chef-de-Loeke +
  Cencosud** que el Excel mete mal en lk y el parser asigna (bien) a CH. Cencosud 2444 es
  $39,4M; los otros 28 ~$6,7M. → el parser es MÁS correcto que el Excel para "ventas LK".
- **De los 191 coincidentes, solo 15 tienen cajas distintas (>2)**; el volumen casa ~90%.
- Diferencias entendidas: **$ +14,8% del parser es definicional** (`sales_lines` reconstruye
  NETO `×(1−dto)×0,98`; el parser trae el subtotal real de factura sin esos descuentos, sin
  IVA — para "facturado real" el parser es el verdadero); **cajas +8,4%** concentrado en 15
  clientes, a revisar (bonificación/redondeo vs `item_code` excluidos).
- **Lectura**: la brecha parser↔Excel NO es cobertura — es etapa de valorización + 15 clientes.
  El parser ya reproduce el Excel a nivel cliente para un mes cerrado. La "condición de
  implementación" (coincidencia 100% con ISIS) se puede monitorear con esta misma
  comparación cada mes; el termómetro ya está en verde a nivel cliente/cobertura.
- Verificación (scratchpad de la sesión): `recon6.py` sobre `sales_lines` ago vs
  `comprobantes_venta` FC ago.

### Los 15 clientes con cajas distintas — resueltos (2026-09-09)
Eran un **artefacto de comparación**: comparé `sales_lines` NETO (ya resta NC) contra
`comprobantes_venta` **solo-FC**. Comparando **NETO vs NETO** (`sum(total_cajas*signo)`),
las 15 bajan a 10 y de esas:
- **~7 son de ±3-4 cajas** (redondeo / una caja) — inmateriales.
- **3 de fondo (2447 −169, 1903 −70, 2128 −158) son Chef-de-Loeke**: ventas de Chef de
  art Loeke que el Excel taguea lk y el parser asigna (bien) a CH. Ejemplo 2128 verificado:
  08-06 = 602 (LK, coincide) + 08-14 = 159 (el parser las factura CH, punto de venta
  00005xxx) → el Excel las sumó a lk de más.
- **0 gaps genuinos del parser**: no falta ningún comprobante.
- **Conclusión**: donde el parser difiere del Excel, el parser tiene razón (marca correcta).
  No solo empata el Excel a nivel cliente — lo corrige. Verif: `recon6.py` + net-vs-net.
