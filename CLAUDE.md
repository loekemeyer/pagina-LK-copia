# Configuraciones y comandos especiales

**Estado central:** `config-claude.json` — toggles y comandos que afectan CUALQUIER chat.

## Modos

- **caveman (SIEMPRE activo)**: Cada conversación abre con caveman activo por defecto. Responder en modo caveman — frases cortas, directas, mínimas palabras, sin artículos, sin fluff. Solo aplica al **chat** (no al código, comentarios ni mensajes de commit). **"desactiva caveman"** = responder solo el **próximo mensaje** normal/completo, y después **volver solo** a caveman. **"caveman desactivacion total"** = apagar caveman por completo (queda desactivado hasta que se reactive).
- **tablas_compactas**: Tablas con separación mínima, headers en double fila si hace falta, nombres abreviados, optimiza anchura. Siempre activo.

## Acuse de recibo

**OBLIGATORIO en TODA sesión.** Cada mensaje del usuario debe responderse empezando con
**"✅ Leído"** seguido de un resumen ultra-corto de lo que dijo (máx 10 palabras).
Ejemplo: `✅ Leído — sin cotizador sin método de pago, hardcodear "Prefiero no decidir"`.
Esto va ANTES de cualquier otra respuesta. Si hay un agente corriendo en background y no
puedo actuar todavía, igual poner el acuse. El usuario necesita saber que el mensaje
llegó y fue procesado, no que se quedó en cola.

## Comandos especiales

- **"resumen del día"**: Reporte del trabajo de hoy en bullet points. Estilo ejecutivo. Incluye: completadas, en progreso, bloqueeos, próximos pasos.

---

# CAVEMAN MODE
Respond like caveman. No articles, no filler words, no pleasantries.
Short. Direct. Code speaks for itself.
If asked for code, give code. No explain unless asked.
No sycophancy. No restating question. No sign-offs.
State: caveman-state.json (true/false). Say "activa caveman" or "desactiva caveman" to toggle.

---

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Configuraciones y comandos especiales

**Estado central:** `config-claude.json` — toggles y comandos que afectan CUALQUIER chat.

### Modos

- **caveman**: Responde sin artículos, sin fluff, directo.
  - Activar: "activa caveman" → ejecuta `./scripts/caveman-toggle.sh activa`
  - Desactivar: "desactiva caveman" → ejecuta `./scripts/caveman-toggle.sh desactiva`
  - Estado guardado en `caveman-state.json` y `config-claude.json`
- **tablas_compactas**: Tablas con separación mínima, headers en doble fila si hace falta, nombres abreviados, optimiza anchura. Siempre activo.

### Comandos especiales

- **resumen del día**: Reporte del trabajo de hoy en bullet points. Estilo ejecutivo. Include: completadas, en progreso, bloqueados, próximos pasos.

## Overview

Static multi-page site for **Loekemeyer SRL** (Argentine kitchen-utensil wholesaler). There is no build step, no package.json, no test harness — files are served as-is by IIS from this `wwwroot` directory. All JS runs in the browser and talks directly to Supabase.

**El `web.config` real vive SOLO en el servidor IIS, no en el repo.** Hace: redirección a HTTPS, compresión gzip (estática y dinámica), cache de un año para estáticos, tipos MIME de `.webp`/`.woff2`/`.avif` y headers de seguridad (`X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: SAMEORIGIN`).

El 25/6/2026 el commit `aeab082` agregó al repo un `web.config` con 3.191 líneas de JavaScript y cero XML — copiarlo al IIS devolvía HTTP 500 en todo el sitio. Se borró el 31/7. Quedó `web.config.ejemplo` como referencia de lo que debería tener, **sin verificar contra producción**. Para versionarlo bien hay que traer el del servidor, que es el que manda. Ojo si el despliegue usa espejo (`robocopy /MIR` o similar): borraría el del servidor. Con un copiado común no pasa nada.

## Copia del panel admin dentro de Producción Virgilio

Desde 2026-08-11 existe una **copia del panel admin** dentro del repo
[`loekemeyer/Produccion-Virgilio`](https://github.com/loekemeyer/Produccion-Virgilio),
bajo `/admin/`, servida por GitHub Pages junto con la PWA de producción. La
copia apunta al **mismo proyecto Supabase LK** que este repo (`kwkclwhmoygunqmlegrg`)
— no hay migración de datos, es coexistencia. El botón que la abre está en el
panel supervisor de Virgilio ("🌐 Panel Web LK").

### Consecuencia operativa: cambios en el admin van a DOS repos

**Cualquier cambio a los archivos del panel admin de este repo debe replicarse
al espejo bajo `/admin/` del repo Virgilio.** Archivos espejados:
`admin.html`, `admin.js`, `admin-supercot.js`, `admin-osa.js`,
`admin-excel-krikos.js`, `analisis-venta-cliente.js`, `analisis-cobranzas.*`,
`carga-pedidos.html`, `historial.html/.js`, `sugerencias.html/.js`,
`excel-parser-smart.js`, `argentina-map-data.js`, `argentina-provinces.json`,
`version.js`, `css/admin.css`, `css/analisis-venta-cliente.css`,
`css/analisis-cobranzas.css`, `css/historial.css`, `css/sugerencias.css`,
`css/productos.css`, `osa/`, `img/favicon.jpg`, `img/no-image.jpg`.

Si esto se vuelve tedioso, mover a un mecanismo real de sync (git submodule,
subtree, o un script `sync-admin-to-virgilio.sh`). Hasta entonces, es a mano.

### El espejo tiene ajustes propios que NO se deben pisar

Al re-copiar hay que preservar del lado del espejo (todos hechos porque el
admin se sirve desde otro dominio y sin la infraestructura del sitio LK):

- Redirects `location.href = "/mayorista"` en admin.js → `"../"`.
- Botón sidebar "Volver a Mayorista" → "Volver a Producción" con `href="../"`.
- `<meta name="robots" content="noindex,nofollow" />` en cada HTML.
- Handler de login OTP al final de admin.js (`lkSendOtp`, `lkVerifyOtp`,
  `lkResetOtp`, constantes `LK_ADMIN_EMAIL`, `LK_OTP_FN_URL`, helper `_lkOtpFn`)
  + form OTP dentro del `#loadingScreen` de admin.html.

El login del espejo no usa CUIT+PIN (no está `mayorista.html` en ese repo). Usa
código OTP de 6 dígitos al mail vía la Edge Function `admin-login-otp` en este
proyecto Supabase LK (verify_jwt=off, código fuente en el repo Virgilio bajo
`admin/supabase/admin-login-otp/index.ts`). Al verificar setea password
temporal aleatorio en el user con `admin.updateUserById` y devuelve para
`signInWithPassword`.

### Users nuevos en `auth.users` de LK (por el flujo OTP)

- `loekemeyer.n8n@gmail.com` (creado 2026-08-11) vinculado en `public.admins`
  como segundo admin (el otro sigue siendo `30515842450@cuit.loekemeyer` con
  su 2FA TOTP). Este user entra SOLO por OTP al mail, no tiene password real.
- Si se rota la política de admins o se agrega otro, replicar el mismo patrón
  (insertar en `auth.users` con `email_confirmed_at`, `email_change=''`,
  `confirmation_token=''`, `recovery_token=''` — NUNCA null, gotrue rompe con
  "Database error finding user" si esos campos son null) + fila en `admins`
  + editar `RECIPIENT_EMAIL` de la Edge Function y re-deployar.

## Backend (Supabase)

- Project URL `https://kwkclwhmoygunqmlegrg.supabase.co`, anon key is embedded in every JS file that creates a client. The key is re-declared at the top of `script.js`, `admin.js`, `historial.js`, and `sugerencias.js` — if rotated, it must be updated in all four places.
- Auth uses email/password with a synthetic email scheme `<cuit-digits>@cuit.loekemeyer` and a 6-digit PIN as the password. New auth users are created in `admin.js → createAuthUser` using a second Supabase client that has `persistSession: false` so the admin's own session is not overwritten.
- Admin role is gated by presence of the user's `auth_user_id` in the `admins` table; every admin page redirects to `mayorista.html` if that check fails.
- Key tables/views referenced from the frontend: `customers`, `customer_delivery_addresses`, `admins`, `user_customer_links`, `products`, `loke_products`, `item_groups`, `orders`, `order_items`, `order_tracking`, `app_settings`, `v_customer_item_month`, `sales_lines`, `sales_excluded_items`, `ranking_inactivos_excluidos`, `customer_grupos`, `clientes_chef_excluidos`, `clientes_lk_ch_links`, `tokens_no_distintivos`, `chef_padron`, `lk_ch_excluidos_cache`.
- **Las numeraciones de Loekemeyer y de Chef son INDEPENDIENTES.** Es lo más importante de entender antes de tocar nada que cruce las dos empresas: el mismo número es un negocio distinto en cada una. El código 2502 es "Filippi Navier (Ex Jauregui)" en Loekemeyer y "Gonzagerodia S.A." en Chef. Verificado sobre los 69 códigos que aparecían con ambas empresas: **61 tienen razón social distinta en cada padrón**, y el solape observado (69) es el que se espera por puro azar (~62). **Coincidir de número no vincula nada** — el vínculo va por CUIT, por razón social o a mano.
- **El padrón de Chef vive en OTRO proyecto de Supabase** (`nkhzocgdpwtgrmwleihr`). `chef_customers`, `chef_customer_delivery_addresses` y `chef_sales_lines` son **tablas foráneas** (`postgres_fdw`). Leerlas cuesta segundos: 6.772 ms medidos para resolver 312 clientes, contra un `statement_timeout` de ~8 s. **Nunca joinearlas en el camino caliente, y menos con `LATERAL`** (dispara una consulta remota por fila y la función se cuelga). Se usa **`chef_padron`**, copia local con razón social, CUIT y dirección de entrega, que baja el costo a 234 ms. La refresca el cron `sincronizar-chef-diario` (03:20 UTC) vía `sincronizar_chef()`, que además recalcula `lk_ch_excluidos_cache` y aguanta que Chef esté caído. A mano: `select public.sincronizar_chef();`.
- **`customer_grupos` agrupa códigos que son el mismo cliente real con distinta razón social** (cambió de sociedad y siguió comprando con otro código). Uno por grupo lleva `es_vigente = true` y absorbe el histórico de los demás en `get_ranking_inactivos`; las viejas dejan de figurar. La fecha de última compra también se calcula sobre el vigente, así un grupo que sigue comprando no aparece como inactivo. **El factor de descuento se aplica por código CRUDO, no por el vigente**: cada razón social valoriza su historia con su propio `dto_vol`, así el total del grupo no cambia según cuál esté marcada como vigente. Se administra desde ABM Clientes → Clientes agrupados (`admin.js → cargarGruposClientes`). El buscador y las sugerencias toman `p_empresa` y trabajan dentro de una sola. Las sugerencias (`sugerir_customer_grupos`) salen de cinco orígenes: **mismo CUIT** (la más fuerte: es identidad fiscal), misma razón social normalizada, **misma dirección de entrega** (tope `p_max_dir = 3` códigos por dirección — sin el tope los depósitos de expreso como Pergamino 3751 arman clusters de 135), **apellido en común** y similitud de nombres.
- **Las sugerencias se arman por COMPONENTE CONEXA, no por origen.** Cada señal produce aristas entre códigos y el cluster es la componente. El modelo anterior daba prioridad entre orígenes y sacaba de las pasadas siguientes a los códigos ya agrupados, lo que perdía casos reales: los tres Colucci se juntaban por dirección y, por estar ya juntos, nunca se los comparaba con "Bazar Colucci S.A.", que es de la misma familia pero tiene otro domicilio. El `origen` que devuelve la RPC puede venir combinado (`apellido+direccion`) y el frontend lo separa por `+`. Tope de `p_max_grupo = 5` miembros: más que eso es una cadena de coincidencias flojas.
- **Un código no puede aparecer en dos grupos sugeridos**, y la garantía es estructural: el CTE `comp` devuelve una fila por código, o sea una sola etiqueta de componente, y `armado` agrupa por esa etiqueta. Depende de dos cosas que conviene no romper: que `datos_cliente_empresa` no repita códigos (990 lk / 312 chef, uno por fila) y que `det` excluya lo que ya está en `customer_grupos`.
- **Las componentes se calculan con un `WITH RECURSIVE` (`alcance`), no con pasadas fijas.** Antes eran cuatro pasadas de propagación del código mínimo, y ahí había una bomba de tiempo: la propagación necesita tantas pasadas como el DIÁMETRO de la componente, y una cadena de 5 nodos ya tiene diámetro 4 — el tope `p_max_grupo = 5` y las 4 pasadas estaban empatados, sin margen. Una componente grande con forma de cadena se partía en pedazos, y cada pedazo de ≤5 pasaba el filtro y salía como una sugerencia SEPARADA: dos grupos que deberían ser uno, **sin ningún código repetido entre ellos**, o sea invisible para un chequeo de duplicados. Hay que compararlo contra la componente real. Cuando se cambió (3/8/2026) las 4 pasadas todavía convergían (759 componentes en lk y 248 en chef, idénticas a las reales, 0 códigos mal etiquetados), así que la salida no se movió: mismas 85 sugerencias en lk y 37 en chef, md5 idéntico. Y salió más rápido: **2.417 ms contra 3.750 ms**.
- **`aristas` lleva `MATERIALIZED` y no es opcional**: se referencia una sola vez, desde el término recursivo de `alcance`, así que sin la palabra Postgres la inlinea y la recalcula en CADA iteración — 10.539 ms contra 2.369 ms.
- **`ar_sim` NO llama a `similarity()` por par: usa un índice invertido de trigramas.** `similarity()` de pg_trgm *es* el Jaccard sobre los trigramas de `show_trgm()` —`|A∩B| / (|A| + |B| - |A∩B|)`— así que contando los trigramas compartidos con un JOIN por trigrama sale el mismo número sin llamar a la función, y los pares que no comparten ningún trigrama (similitud 0) ni se enumeran. Verificado sobre los 102.215 pares que comparten al menos un trigrama: diferencia máxima 2,8e-8 (redondeo float4/float8), 0 pares por encima de 1e-6, mismos 4 pares por las dos vías. El Jaccard se usa como PREFILTRO con margen de 0,001 y se confirma con `similarity()`, que sigue siendo la definición que manda. Antes era un nested loop de 971×971 = 942.841 llamadas que producía 8 aristas y se llevaba el **97% del costo de la función**: 2.341 ms de 2.417.
- **El `CASE` de `sim_par` no es cosmético, fuerza el orden de evaluación.** Postgres no sabe que `similarity()` es cara (`procost` 1) y si se la deja suelta en el `WHERE` la evalúa ANTES del prefiltro, sobre los 102k pares — o sea que el prefiltro no sirve de nada. Medido: 2.229 ms sin el `CASE` contra 1.395 ms con él.
- **Techo de escala de `sugerir_customer_grupos`**: hoy 1.395 ms con 971 clientes en el padrón (venía de 3.750). Lo que queda cuadrático es el join por trigramas y `ar_tok` (~72 ms), y lo lineal es `datos_cliente_empresa` (~400 ms, que lee `sales_lines`). Proyectado contra el `statement_timeout` de ~8 s, el módulo aguanta hasta unos **4.000 clientes** (antes ~1.800). Si alguna vez se acerca, el paso siguiente es materializar el padrón en una tabla real con índice GIN `gin_trgm_ops` —el patrón que ya usa `chef_padron`— para que el join por similitud lo resuelva el índice en vez de enumerar pares; cuesta una tabla más y su cron de refresco.
- **El origen `apellido` depende de `tokens_no_distintivos`.** Empareja razones sociales que comparten una palabra que aparece en pocos clientes (`p_max_tok = 3`). Sin el filtro la señal es inservible: la mayoría de las palabras raras del padrón son **nombres de pila** (`Cequeira Agustin` con `Chemello Federico Agustin`) y palabras de rubro (`gastronomia`, `plastico`). La tabla es editable a propósito — si una sugerencia sale mal por una palabra, se agrega ahí y deja de proponerse sin tocar código; si bloquea un apellido real (hay apellidos que también son nombres, como Bruno o Celestino), se borra la fila. El CUIT sí se usa, y como señal propia (`origen = 'cuit'`): dentro de una misma empresa, dos códigos con el mismo CUIT son la misma persona jurídica.
- **"Clientes vinculados" saca de `get_ranking_inactivos` a los que dejaron de comprarle a Loekemeyer pero le siguen comprando a Chef**: el cliente no se perdió, solo cambió de línea, así que reclamarlo por inactivo es un falso positivo. **El módulo agrupa por CLIENTE REAL, no por código**: el mismo cliente casi nunca usa el mismo código en las dos empresas y por eso la tabla muestra el **código de Loekemeyer**, que es con el que se lo busca en el ranking. El vínculo va por **CUIT** (188 de los 312 códigos de Chef con ventas), por **razón social** (171), o **a mano** (`clientes_lk_ch_links`). 18 códigos matchean SOLO por CUIT: son los que cambiaron de razón social al pasar a Chef, el caso que el nombre no puede ver. El CUIT de Chef sale de `chef_padron` — estuvo invisible un tiempo porque la tabla foránea no declaraba esa columna, aunque la remota la tenía con 755 de 757 cargados.
- **Todo lo que se arma en Clientes agrupados se guarda en Supabase; el frontend no tiene estado propio.** Cada acción del panel es una llamada `sb.rpc(...)` — no hay un solo `.from(tabla).insert()` directo en `admin.js` para estos módulos. Agrupar/desagrupar → `customer_grupos` (vía `guardar_customer_grupo`, `quitar_de_customer_grupo`, `deshacer_customer_grupo`); vincular entre empresas → `clientes_lk_ch_links` (`vincular_lk_ch`, `desvincular_lk_ch`); el switch del ranking → `clientes_chef_excluidos` (`set_lk_ch_excluido`, `reset_lk_ch_excluido`); ocultar una fila puntual → `ranking_inactivos_excluidos`. Las cuatro tablas tienen RLS de admin y columnas de auditoría (`creado_por`/`creado_at`, `excluido_por`/`excluido_at`) que se llenan solas con `auth.uid()`. Que `clientes_lk_ch_links` o `clientes_chef_excluidos` estén vacías no significa que no persistan: significa que todavía nadie usó esa acción y las 14 exclusiones vigentes son todas automáticas.
- **ABM Clientes → Clientes agrupados tiene cuatro módulos**: (1) *Agrupar manualmente* y (2) *Sugerencias*, ambos con selector de empresa — un grupo agrupa razones sociales **dentro** de una empresa; (3) *Grupos armados*; (4) *Clientes vinculados*, donde se establece que un cliente de Loekemeyer y uno de Chef son el mismo, con el switch que lo saca del Ranking Inactivos. **Agrupar y vincular son cosas distintas** y por eso están separadas: agrupar es misma empresa, vincular es cruzar empresas.
- `customer_grupos` lleva **`empresa` en la clave primaria** (`(cod_cliente, empresa)`): los grupos existen en las dos. Los de Chef todavía no tienen consecuencia propia —no hay ranking de Chef— pero hacen que vincular una razón social alcance para todo el grupo. `clientes_lk_ch_links` también lleva `empresa` en la clave, por la misma razón.
- **`Wpp_Clientes` guarda los DOS padrones, discriminados por la columna `marca`** (`LK` / `CH`): 902 códigos de Loekemeyer y 313 de Chef, una sola fila por código y marca. **Toda resolución de nombre desde ahí tiene que filtrar `w.marca = 'LK'`.** 63 códigos figuran con las dos marcas y 62 con razón social distinta —el 1621 es "Falabella S.A." en Loekemeyer y "Linea Ge Sa." en Chef— porque las numeraciones son independientes. Sin el filtro, el guard `HAVING count(DISTINCT nombre) = 1` los tomaba como ambiguos y los dejaba sin razón social: en pantalla salían como "(sin razón social)" aunque el dato estuviera bien cargado. Con el filtro el guard es redundante pero inocuo, y se conserva.
- **`datos_cliente_empresa(p_empresa)` es la fuente única de identidad y métricas** por cliente: código, razón social, CUIT, dirección de entrega, última compra y valor histórico neto, resueltos contra el padrón que corresponde (`customers`+`Wpp_Clientes` para lk, `chef_padron` para chef). La usan agrupar, sugerencias y el buscador para no divergir.
- **`datos_cliente_empresa` tiene dos firmas**: la de dos argumentos (`p_empresa, p_cods text[]`) es la implementación real y acota el agregado sobre `sales_lines` a un puñado de códigos, saliendo por el índice parcial `sales_lines_lk_cliente_idx`; la de un argumento es un envoltorio que pasa `NULL` y trae el padrón entero. **La de dos argumentos NO lleva `DEFAULT` a propósito**: si lo llevara, toda llamada de un solo argumento sería ambigua entre las dos firmas y Postgres la rechazaría. Con `p_cods` cuesta 72 ms contra ~400 ms.
- **`get_customer_grupos` pasa solo los códigos agrupados**: antes resolvía el padrón completo de las DOS empresas (1.302 clientes) para devolver las 7 filas que tienen grupo — 555 ms contra 91 ms ahora. Verificado fila a fila contra el camino sin filtro: 7 = 7, 0 de más y 0 de menos.
- **Las SIETE RPC que mutan grupos o vínculos refrescan `lk_ch_excluidos_cache`**, no solo las cuatro de vincular. `guardar_customer_grupo`, `quitar_de_customer_grupo` y `deshacer_customer_grupo` no lo hacían hasta el 3/8/2026, y sí pueden cambiarlo: `get_clientes_lk_ch` usa `customer_grupos` para armar la clave del cliente y para propagar el vínculo a todos los miembros, así que agrupar dos códigos fusiona sus filas y la última compra pasa a ser el `MAX` del grupo — que es justo lo que decide la exclusión automática. Sin el refresco, armar o deshacer un grupo dejaba el Ranking Inactivos con exclusiones viejas hasta el cron. **`quitar_de_customer_grupo` tenía un `RETURN` propio en la rama de "quedó uno solo"**; se pasó a `ELSIF` para que el `PERFORM` lo alcancen todos los caminos que modificaron algo. El único `RETURN` temprano que queda es el de "no había grupo", donde no se tocó nada.
- **`quitar_de_customer_grupo` ya no usa `LATERAL` contra `datos_cliente_empresa`**: lo invocaba UNA VEZ POR MIEMBRO del grupo para elegir el nuevo vigente. Ahora es un solo llamado acotado a los códigos del grupo. Es el mismo patrón que está prohibido para el FDW de Chef, y por el mismo motivo.
- **Tiempos de la pestaña Clientes agrupados** (medidos el 3/8/2026, contra un `statement_timeout` de ~8 s). Carga inicial, las tres en paralelo: `sugerir_customer_grupos` 1.440 ms, `get_clientes_lk_ch` 445 ms, `get_customer_grupos` 91 ms. Buscadores: `buscar_clientes_para_grupo` 316 ms, `buscar_clientes_lk_ch` 50 ms. Las cuatro RPC del switch/vínculo pagan `refrescar_lk_ch_excluidos` (449 ms), y ahora también las tres de agrupar. Nada cerca del límite.
- **Cambiar de empresa en Sugerencias, Rechazar y Refrescar recargan SOLO las sugerencias** (`_cargarSugerencias` en `admin.js`), no las tres RPC. No tocan ni los grupos armados ni los clientes vinculados, así que la recarga completa eran ~1,1 s de base y dos viajes al servidor al pedo. **Aceptar** una sugerencia sí recarga todo: crea un grupo, y un grupo cambia las otras dos tablas.
- **`get_clientes_lk_ch` expande los grupos de LOS DOS LADOS**: vincular a cualquier miembro vincula al grupo entero, en las dos empresas. Eso cubre cliente↔cliente, grupo↔grupo y cliente suelto contra un grupo del otro lado.
- **El nombre del vendedor sale de `customer_commissions.vendor_label`, NO de `customers.vend`** (que es el código del ERP, 24 valores en uso, el mismo que viaja a Sheets como `sheets_payload->>'vend'`). `customer_commissions` tiene **una fila por `cod_cliente`**, así que el vínculo directo por cliente manda; para los que no tienen fila se cae al **nombre dominante del código**, derivado en vivo en el CTE `vend_nom`. Las dos vías juntas cubren **356 de las 367 filas** del ranking a 12 meses (el total se mueve solo: es la cantidad de inactivos de hoy). El mapa código→nombre es sólido: 18 de los 22 códigos tienen 100% de concordancia y el resto va de 78% a 98%. No se materializa en una tabla a propósito: se deriva en cada consulta y no se puede desincronizar. **Ojo con `Wpp_Vendedor_Clientes_Estado`**, que parece la tabla obvia y no sirve: su `vendedor_id` no es el `vend` —el código va embebido en el texto (`"V.12 Tomas Schinder"`)—, resuelve solo 111 filas y tiene el código `1` compartido por dos personas. `Clientes_Wpp` está vacía.
- **El vendedor NO se busca desde el cuadro de texto: se filtra desde un menú en el encabezado de la columna** (`p_vendedores text[]` de `get_ranking_inactivos`, `NULL` o arreglo vacío = todos). Va server-side por lo mismo que el buscador: la tabla está paginada de a 25 sobre 368. Seleccionar TODOS manda `null` en vez del arreglo completo, así la RPC se ahorra el `= ANY`. La columna muestra el nombre y deja el código en el `title`.
- **La lista del menú de vendedores está acotada al ranking, no al padrón de comisiones.** `get_vendedores_ranking(p_meses, p_solo_excluidos)` recibe los MISMOS parámetros con que se cargó la tabla y devuelve solo los nombres que aparecen en ella: 17 a 12 meses, contra los 20 que salían de agrupar `customer_commissions` entera. Los tres de diferencia —`Fab.`, `La Bianca`, `Sphan`— tienen clientes en la tabla de comisiones y **cero en el ranking**, así que elegirlos vaciaba la tabla sin explicación. **La lista depende del período**: a 3 meses `La Bianca` y `Sphan` sí aparecen. Por eso `admin.js` invalida `_rankVendLista` en `cargarRankingInactivosDesdeCero` (que es por donde pasan el cambio de período, el switch de ocultos y la carga inicial) y poda `_rankingVendedores` de los nombres que ya no están.
- **`get_vendedores_ranking` DUPLICA a mano los CTE baratos de `get_ranking_inactivos`** (`cutoff`, `canon`, `ult_erp`, `ult_web`, `ult`, `inactivos`, `vend_nom`) y hay que mantenerlos alineados. No reusa la RPC de pantalla porque pedirle el ranking completo cuesta **8.466 ms**, por encima del `statement_timeout` de ~8 s — el mismo motivo por el que existe `get_ranking_inactivos_export`. Copiando solo los CTE baratos son **1.316 ms**, y la salida está verificada contra `get_ranking_inactivos(12, 5000, false, 0, null, null)`: mismos 17 nombres y mismas cuentas, 0 diferencias. Se le **revocó `EXECUTE` a `PUBLIC`/`anon`** (es `SECURITY DEFINER` y el módulo es solo de admin).
- **Los renombres de vendedor son SOLO de pantalla: `RANK_VEND_ALIAS` en `admin.js`.** `Fabrica P` se muestra como `Pablo B`. La clave del mapa es el `vendor_label` crudo, que es lo que viaja a la RPC en `p_vendedores` y lo que lleva el `data-vend` de cada ítem del menú; el alias solo toca el `<span>` del menú y la celda de la tabla. **No renombrar en `customer_commissions`**: esa columna la cruzan el ERP y otros consumidores. Como el alias rompe el orden alfabético que trae la RPC, el menú reordena por el nombre visible.
- **Al agregar el filtro por vendedor hubo que encerrar entre paréntesis la cadena de `OR` del buscador.** El `WHERE` de `filtrado` era `p_q = '' OR cod ILIKE … OR nom ILIKE …` sin paréntesis; colgarle un `AND` al final habría cambiado el significado, porque `AND` liga más fuerte que `OR` y el filtro de vendedor se habría pegado solo a la última alternativa.
- **El menú del filtro es `position: fixed` Y se cuelga de `<body>`**; las dos cosas hacen falta y por motivos distintos. `fixed` porque `.est-table-wrap` tiene `overflow` y `max-height`, así que un desplegable `absolute` queda recortado por el scroll de la tabla. Y colgarlo de `body` porque **los `th` de `.est-table` son `position: sticky` con `z-index: 2`**, o sea que cada uno abre su propio contexto de apilado: dejando el menú dentro del `th`, su `z-index` se resuelve DENTRO de ese contexto y el `th` de al lado —que viene después en el DOM— lo tapa, por más alto que sea el número. Lo mueve `_ubicarMenuVendedores()`, que también calcula las coordenadas contra el rect del botón; el menú se cierra al scrollear porque si no queda flotando en la posición vieja.
- **El mismo patrón de menú se usa en Estado de actividad de clientes** para filtrar por Estado y por Situación BCRA (`registrarFiltroMenu` / `toggleFiltroMenu` en `admin.js`, clases `.filtro-*` que comparten las reglas CSS de `.rank-vend-*`). Repite las tres correcciones de arriba porque son propiedades del contexto, no del filtro. **El de Vendedor conserva su implementación propia**: no se migró para no tocar algo ya validado en pantalla, así que hay dos copias de la misma lógica.
- **El `<button>` del encabezado NO hereda `text-transform`**, así que sin declararlo el título de esa columna sale en minúsculas mientras el resto de los `th` van en mayúsculas. Por eso `.rank-vend-btn` / `.filtro-btn` llevan `text-transform: inherit` y `letter-spacing: inherit`.
- **El menú resetea `color`, `font-weight`, `text-transform` y `letter-spacing`.** Nace dentro de un `th`, que tiene `color: #fff`: sin el reset los nombres salen blancos sobre fondo blanco. Los `<button>` no se ven afectados porque el navegador les da color propio — por eso en ese bug "Todos" se leía y los items no.
- **El período del Ranking Inactivos NO se aplica al elegirlo: hay que confirmarlo con "Cargar período"** (el botón va pegado al menú). Por eso existe `_rankingPeriodoCargado`, que es el período que la tabla está mostrando y puede diferir del que muestra el `<select>`. **Todo lo que dependa del período tiene que leer esa variable y no el `<select>`**: `cargarRankingInactivos` y `descargarRankingInactivosExcel` lo hacen. Si leyeran el menú, paginar u ocultar un cliente cambiaría el período sin que nadie lo confirmara, y el `.xlsx` saldría de un período distinto al de la pantalla. El botón se pinta naranja mientras haya diferencia, que es la única señal de que lo que se está leyendo no es el período elegido.
- **El buscador del Ranking Inactivos busca por código, razón social y CUIT, y filtra server-side** (`p_q` de `get_ranking_inactivos`): la tabla está paginada de a 25 sobre 531, así que filtrar en el navegador solo miraría la hoja visible. El CUIT se compara **solo por dígitos** —así `30-59036076-3` encuentra al que está cargado como `30590360763`— y **exige que la búsqueda tenga al menos 6 dígitos**: sin ese piso, buscar el código `996` devolvía además todos los clientes cuyo CUIT contiene "996" en algún lado. El CUIT sale de `customers.cuit` en el CTE `nombres`, junto con la razón social y por el mismo motivo (hay que resolverlo antes de paginar). 236 de los 1233 códigos del ERP no tienen ficha en `customers`, así que pueden salir sin CUIT. La RPC del Excel (`get_ranking_inactivos_export`) no lo devuelve: el archivo no lo lleva.
- **El buscador de Clientes vinculados filtra en el navegador, no en la base**, al revés que el del Ranking Inactivos: `get_clientes_lk_ch` trae las 165 filas de una y la tabla no está paginada, así que un `p_q` server-side sería un viaje por tecla al pedo. Busca sobre razón social (las dos empresas), código LK (el principal y los otros del grupo), código de Chef y CUIT. La comparación normaliza sin acentos ni puntuación, así `30-59036076-3` encuentra al que está cargado como `30590360763`. El resumen de arriba de la tabla y el contador del título siguen contando sobre el TOTAL —son los números del módulo, no del filtro— y las coincidencias se informan aparte.
- **`get_clientes_lk_ch` devuelve `cuit`**: el del lado Loekemeyer, con fallback al de Chef. Se agregó para el buscador y se muestra en la línea de detalle de cada fila (buscar por un campo invisible no deja controlar el resultado).
- **`get_clientes_lk_ch` devuelve `situacion`, que nombra las CUATRO combinaciones** de frío/activo entre las dos empresas: `activo_ambas` (34 clientes), `lk_frio_chef_activo` (14), `lk_activo_chef_frio` (79) y `frio_ambas` (39). Se agregó porque `lk_frio_chef_activo` es un booleano y su `false` tapaba tres situaciones distintas; la más numerosa era la que no se veía —79 clientes con $4.081 M de valor histórico en Loekemeyer que Chef perdió, el espejo del módulo—. Hoy no tiene consecuencia (no hay ranking de Chef) y la pantalla todavía no la usa. **No se persiste a propósito**: la situación es relativa a HOY (depende del corte de `p_meses`), así que guardarla obligaría a refrescarla, que es el problema que ya resuelve `lk_ch_excluidos_cache` para el único estado que sí tiene consecuencia.
- El switch tiene un **valor automático** —prendido si el cliente está frío en Loekemeyer y activo en Chef dentro del período— que se puede pisar en los dos sentidos. `clientes_chef_excluidos` no es una lista de exclusiones sino la decisión explícita: sin fila manda el automático, con fila manda `excluir`. Toda esa resolución vive en **`codigos_lk_excluidos_por_chef`**, que es la fuente única que consumen la pantalla y el Excel del ranking. **`lk_ch_excluidos_cache` se desincroniza si se cambia la LÓGICA de vinculación**, no solo los datos: lo refrescan las cuatro RPC de mutación y el cron, pero un cambio en cómo se resuelven nombres o se arman los clusters lo deja viejo sin que nada lo detecte, y un código que sobra ahí es un cliente escondido del ranking en silencio. **Después de tocar `get_clientes_lk_ch`, `datos_cliente_empresa` o la resolución de nombres, correr `select refrescar_lk_ch_excluidos();`.** Para chequear: comparar `lk_ch_excluidos_cache` contra `get_clientes_lk_ch(12) where excluido`. El ranking no la llama en vivo: lee **`lk_ch_excluidos_cache`**, que refrescan las RPC que lo pueden cambiar (`set_lk_ch_excluido`, `reset_lk_ch_excluido`, `vincular_lk_ch`, `desvincular_lk_ch`) y el cron. Recalcularlo en cada carga costaba 2.163 ms contra 496 ms. Es distinto de `ranking_inactivos_excluidos`, que es ocultar a mano una fila puntual.
- **Las ventas de Chef en `sales_lines` estuvieron DUPLICADAS y se desduplicaron el 31/7/2026.** El lote `chef_hist_xlsx_202607` se cargó dos veces en la misma corrida (todo con `imported_at` 2026-07-02 15:24): 71.574 filas para 35.787 reales. La firma era concluyente: las 34.483 combinaciones distintas de `(customer_code, item_code, invoice_date, boxes)` aparecían todas con multiplicidad PAR (2, 4, …, 14) y ninguna impar, y cada mitad física de la tabla tenía el juego completo. **`row_hash` no lo frenó porque es distinto en cada copia** — no se deriva solo de esas cuatro columnas, así que como guard de deduplicación no sirve; si se vuelve a importar Chef, hay que chequear a mano contra esas cuatro. Se borraron 35.787 filas quedándose con la mitad de cada grupo; el respaldo completo quedó en **`sales_lines_chef_backup_20260731`** (71.574 filas), que se puede borrar cuando se confirme que todo está bien. Efecto: el "Valor Chef" de Clientes vinculados bajó exactamente a la mitad ($2.602.404.116 → $1.301.202.062). El Ranking Inactivos no se movió (368 filas, filtra `empresa = 'lk'`) ni cambiaron los 14 excluidos, porque esa decisión mira `MAX(invoice_date)` y no montos.
- **La fuente ARCA de "Estado de actividad de clientes" la llena un worker EXTERNO, no el navegador.** El padrón de ARCA se consulta por web service con autenticación WSAA, que exige un certificado X.509 con su clave privada y firma CMS: esa clave no puede estar en `admin.js` porque el repo es público y se sirve por GitHub Pages, y ARCA tampoco manda CORS. Al 3/8/2026 **el worker todavía no existe** (falta decidir n8n vs Edge Function y conseguir el certificado), así que los 1.229 clientes consultables figuran "Sin consultar". Todo lo demás está hecho: tabla `arca_padron`, vista `v_clientes_arca` con el estado derivado, el módulo del panel y el contrato del worker. **El instructivo para terminarlo está en `sql/arca_padron.INSTRUCTIVO.md`.**
- **La columna "Situación BCRA" del mismo módulo NO usa worker: la consulta el navegador.** La API de la Central de Deudores (`api.bcra.gob.ar/CentralDeDeudores/v1.0/Deudas/<cuit>`) es **pública, sin autenticación y manda CORS** (verificado el 3/8/2026 desde el panel), o sea el caso opuesto a ARCA. Igual se persiste en `bcra_situacion` para no pegarle al BCRA en cada carga de página: el frontend reconsulta recién a los **20 días**, porque el dato del BCRA es mensual y sale con rezago. La escribe `bcra_registrar`, que lleva el chequeo de `admins` adentro **porque la llama el navegador** (a diferencia de las de ARCA, que son solo `service_role`). `situacion` es el **peor** valor entre las entidades informadas (1 normal … 6 irrecuperable por disposición técnica).
- **El parseo del BCRA quedó verificado contra datos reales** el 3/8/2026: sobre los primeros 77 CUITs consultados, los 54 con deuda trajeron `situacion`, `denominacion`, `periodo` y el detalle por entidad (nombre del banco, monto, días de atraso). `bcra_situacion.raw` guarda la respuesta completa igual, para poder re-derivar sin reconsultar.
- **`bcra_estado` es el estado ÚNICO del lado BCRA** y lo consumen tanto el filtro como la celda: `'1'..'6'` la situación informada, `sin_deuda` (el BCRA respondió y no informa deuda — un RESULTADO, no un hueco), `error` (la consulta falló: sí es un hueco) y `sin_consultar`. **El `ELSE` del `CASE` cubre el caso 200-sin-entidades**, que no tiene ni situación ni error y sin esa rama quedaba mostrando "consultando…" para siempre. `_bcraEstadoDe` en `admin.js` repite el mismo criterio para pintar la celda después de consultar sin volver a pedir la fila — si se cambia uno hay que cambiar el otro.
- **La consulta automática al BCRA cubre SOLO la hoja visible** (25 filas), así que a fuerza de paginar llenar los 1.229 son 50 pantallas — por eso después de un rato de uso solo había 115 consultados. Para eso está el botón **"Consultar todos en el BCRA"**, que arma la cola con `bcra_pendientes` y la recorre entera. Va con concurrencia 3 y una **pausa de 200 ms por pedido a propósito**: sin ella son ~10 req/s contra una API pública y gratuita. La tanda completa son unos 3 minutos y **hay que dejar la pestaña abierta**; se puede cortar y retomar, porque la cola se calcula contra la base y lo consultado ya quedó guardado. Mientras corre, `_bcraCompletarFilas` no dispara nada para no duplicar pedidos.
- **Las filas con `bcra_estado = 'error'` se reintentan en cada vista**, no a los 20 días como las buenas. Casi todos son fallos pasajeros de red (`Failed to fetch` durante la tanda) y la vigencia de 20 días está pensada para un dato válido, no para un hueco.
- **ARCA y BCRA miden cosas distintas y ninguna sabe de nuestra cuenta corriente.** ARCA es estado fiscal, el BCRA es deuda con entidades financieras. Un cliente puede estar en situación 1 e igual debernos plata.
- **El contrato con el worker son DOS funciones y no la tabla**, a propósito: `arca_padron_pendientes` (qué consultar) y `arca_padron_registrar` (dejar el resultado). Así se puede cambiar de n8n a Edge Function sin tocar el esquema. Las dos están **revocadas para `anon` y `authenticated`**: solo `service_role`. El parseo de la respuesta de ARCA vive en el worker, y `arca_padron.raw` guarda la respuesta completa para poder re-derivar el estado sin volver a consultar.
- **La cola de ARCA se rearma sola y NO necesita cron.** `arca_padron_registrar` deja `proxima_revision` en +1 mes (7 días si hubo error, para no reintentar en cada corrida un CUIT que ARCA rechaza siempre), así que `arca_padron_pendientes` siempre devuelve lo que toca. El único cron que hará falta es el que dispare al worker.
- **La clave de `arca_padron` es el CUIT, no el código de cliente**: varios códigos comparten CUIT (los grupos de razones sociales) y no tiene sentido gastar dos consultas en el mismo contribuyente. **1.229 de las 1.245 fichas tienen CUIT con dígito verificador válido**; las 16 restantes son placeholders con prefijo 99 y quedan afuera por decisión de producto. 711 son personas físicas, o sea que el caso "falleció" aplica a la mayoría.
- **El estado se llama `activo_probable` y no `activo` a propósito**: el padrón dice el estado FISCAL del CUIT, no si el negocio está operando. Un cliente puede estar impecable en ARCA y no comprar hace tres años.
- **Tiempos de la pestaña Estadística Clientes** (medidos el 3/8/2026, contra un `statement_timeout` de ~8 s). Carga inicial: `customers` vía REST (1.245 filas, 204 kB, 2 viajes por el tope de 1000) y `get_estadistica_clientes_agg` **605 ms** (venía de 2.773). Ranking: `get_ranking_inactivos` 671 ms la hoja 1, 544 ms la del fondo con período de 3 meses (590 inactivos, el peor caso). Excel: `get_ranking_inactivos_export` 454 ms a 12 meses, 658 ms a 3. Nada cerca del límite.
- **`get_estadistica_clientes_agg` se pagina de a 1000 desde el navegador y CADA página re-ejecuta la función entera** (PostgREST no guarda estado entre requests). Hoy devuelve 995 filas, así que entra en una sola llamada — pero está a **5 clientes** de cruzar el tope y pasar a dos ejecuciones por carga. Con los 605 ms de ahora eso son 1,2 s; con los 2.773 ms de antes habrían sido 5,5 s. Si molesta, la salida es agregar del lado del servidor: la pantalla solo usa estas filas para armar la tarjeta "Próximos pedidos".
- **`sales_lines` mezcla artículos reales con códigos administrativos** (descuentos por pago `PAGO-25%`, notas de crédito, agregados de ISIS). Están en `sales_excluded_items` y toda RPC que calcule fechas de compra debe filtrarlos — si no, una línea de descuento cuenta como compra y corre la fecha de última compra del cliente. La comparación va SIN `upper()` (aplicar una función a `item_code` sobre 260k filas rompe el plan): la tabla guarda las variantes de grafía tal cual vienen del ERP.
- **`estadistica_madre` es una VISTA, no una tabla, desde el 2/9/2026.** Antes era una tabla que se llenaba **a mano desde un Excel** (`Y:\AA VENTAS\A7 Estadistica MADRE`) con un importador en Análisis Venta Cliente; la última importación fue el **6/5/2026** (294 filas) y la leían `analisis-venta-cliente.js` **y `script.js`** — o sea, las sugerencias del **portal del cliente** se ordenaban con datos de mayo y 227 productos ni existían ahí. Decisión del usuario: el Excel no se usa más, la proyección sale de `sales_lines`. Ahora es una vista sobre **`estadistica_madre_cache`** (cron diario) con la **misma forma** que la tabla, así que los lectores no cambiaron: `e_madre_uni_mes = proy_uni_mes`, `categoria = familia`, `ranking = row_number() por proy_uni_mes desc`; `tendencia_uni` y `proveedor` salen `NULL` (ninguna pantalla las leía, solo el importador). **Sin `security_invoker` a propósito**: el caché tiene RLS sin policies y la vista debe seguir legible por `anon`/`authenticated` como lo era la tabla. El Excel histórico se **borró de la base** el mismo día (queda sólo en el repo Virgilio, `sql/backups/backup_estadistica_madre_import_20260506_LK.sql`); el importador se **retiró** de `admin.html` y `analisis-venta-cliente.js` (y del espejo en Virgilio).
- **La proyección tiene UN solo criterio y UNA sola función: `_fn_proy_window` (LK).** Decisión del usuario (2/9/2026): *"si está por abajo de 4 de los últimos 6 meses no es una proyección confiable; no puede ser diferente el criterio, es solo UNA estadística madre"*. Proyección = **promedio simple de cajas facturadas de los últimos 6 meses** (LK+Chef, meses sin venta cuentan 0) **con piso en el 4.º mejor mes**, así por construcción nunca queda por debajo de 4 de los 6. Medido sobre 385 artículos: 0 violaciones (el promedio pelado tenía 28, el criterio anterior con descarte de picos 70). El piso aplica sólo a la ventana de 6; en el fallback de 12 va el promedio pelado. **No hay descarte de picos** (`fn_proy_descarte` se eliminó): cualquier recorte de volumen que ocurrió empuja la proyección por debajo de la mayoría de los meses. `fn_proyeccion_madre_emp` y la firma con `p_emp` de `_fn_proy_window` se borraron (sin llamadores); el motor tiene **una sola firma**, `_fn_proy_window(p_meses)`. `refresh_estadistica_madre_cache` **ya no calcula su propia proyección**: la toma de `fn_proyeccion_madre()` → este motor, así el panel, la vista `estadistica_madre`, el portal y las OCs de Virgilio muestran **el mismo número** (505 = 2.348,7 caj/mes en los cuatro). `admin.js` **no calcula proyección en JS**: antes tenía tres fórmulas de fallback (por cliente con descarte de picos; "promedio de los últimos 3 meses") que daban números distintos; se eliminaron, y sin caché la columna queda vacía. Antes de esto la fórmula estaba copiada en 4 funciones SQL y 2 JS, con dos errores que se compensaban (el filtro anulaba por construcción a todo cliente con una sola compra; el divisor "meses desde la primera compra" inflaba +51%). Definición y backup en el repo Virgilio (`sql/fn_proyeccion_oc_virgilio.sql`, `sql/backups/`).
- **La proyección de las OCs de Virgilio ahora la EMPUJA LK** con `sync_proyeccion_madre_virgilio()` por el FDW `virgilio_db` (cron `sync-proyeccion-madre-virgilio`, miércoles 09:20 UTC), mismo patrón que `sync_pedidos_match_virgilio()`. Antes Virgilio tiraba por HTTP con la anon key, y un barrido de seguridad que le revocó `EXECUTE` a `anon` sobre `fn_proyeccion_oc_virgilio` la dejó **congelada 3 semanas en silencio** (la función devolvía −1 y el cron marcaba "succeeded"). **No volver a abrir esa función a `anon`.**
- Key RPCs: `submit_order_fast` (order submission), `get_my_assortment_18m`, `get_my_linked_customers`, `has_loke_access`, `get_customer_sales_history`, `sugerencias_cliente`, `novedades_marca`, `get_estadistica_clientes_agg`, `get_ranking_inactivos`, `get_customer_grupos`, `guardar_customer_grupo`, `quitar_de_customer_grupo`, `deshacer_customer_grupo`, `buscar_clientes_para_grupo`, `sugerir_customer_grupos`, `get_clientes_lk_ch`, `codigos_lk_excluidos_por_chef`, `set_lk_ch_excluido`, `reset_lk_ch_excluido`, `vincular_lk_ch`, `desvincular_lk_ch`, `buscar_clientes_lk_ch`, `get_ranking_inactivos_export`, `datos_cliente_empresa`, `refrescar_chef_padron`, `refrescar_lk_ch_excluidos`, `sincronizar_chef`.
- **Todo Estadística Clientes mide solo Loekemeyer**: tanto `get_ranking_inactivos` como `get_estadistica_clientes_agg` (la tarjeta "Próximos pedidos") filtran `empresa = 'lk'`. Sin ese filtro los 243 códigos que operan únicamente en Chef aparecían como clientes de Loekemeyer —a recuperar en el ranking, o atrasados en próximos pedidos— sin haberle comprado nunca.
- **`p_solo_excluidos = true` ignora la exclusión por Chef.** "Ver ocultos" es la única pantalla desde donde se restaura un cliente escondido a mano; si además estaba excluido por Chef, no aparecía ahí y quedaba inaccesible para siempre. Al pedir los ocultos se está pidiendo explícitamente esa lista, así que la otra exclusión no corresponde.
- **El Ranking Inactivos mide solo Loekemeyer**: toda lectura de `sales_lines` filtra `empresa = 'lk'`. Antes mezclaba y los 243 códigos que operan únicamente en Chef figuraban como clientes a recuperar sin haberle comprado nunca. **No usar un CTE para ese filtro**: se probó (`WITH lk_lines AS (...)`) y como se referencia seis veces Postgres lo materializa — 189k filas y cada join pasa a seq scan, 2.163 ms contra 496 ms con el filtro inline. Hay un índice parcial `sales_lines_lk_cliente_idx ON sales_lines (customer_code) WHERE empresa = 'lk'`.
- **El 3/9/2026 había CINCO crons fallando y nadie se había enterado**, porque
  `pg_cron` marca la corrida como `failed` pero no avisa a ningún lado. Detalle
  completo y cómo se arreglaron en `sql/fix_crons_20260903.sql`; backup de las
  definiciones tocadas en la tabla `_backup_funcdefs_20260903`. Lo que importa
  recordar: (1) **`app_settings.value` es `text`**, así que todo `COALESCE((SELECT
  s.value ...), 0.02)::numeric` con el cast AFUERA revienta — el cast va ADENTRO
  (`s.value::numeric`); estaban así 7 funciones y arrastraban a `sincronizar_chef`
  y a `gv_generar_dia`. (2) **`PPP_Pedidos_Entregados` la borró Virgilio en su
  v10.25 y LK nunca se enteró**; la reemplaza `PPP_Entregados_Meta`. (3)
  **`gv_cobertura_provincia` tenía el guard estricto `gv_es_admin()`** y la llama
  `gv_candidatos` (señal `zona_fria`), que corre desde el cron sin JWT: pasó a
  `gv_es_admin_o_cron()`. Ese bug estaba TAPADO por el del COALESCE. (4) **El cron
  `gerente-ventas-diario` eran seis `select` encadenados sin manejo de error**, y
  `gv_generar_dia` es el primero: cuando reventaba, las tres del dashboard nunca
  corrían. Ahora cada paso va aislado en su `BEGIN/EXCEPTION`. Lo mismo se hizo
  dentro de `sincronizar_ppp()`, que era una sola transacción y por un paso roto
  congelaba las seis tablas `ppp_*`.
  **`pedidos-pdf-cleanup-30d` se reescribió el 4/9/2026** contra la Storage API
  (`limpiar_pedidos_pdf`, pg_net + la `service_role_key` del Vault). El trigger
  `storage.protect_delete` **se puede saltear** con `set local
  storage.allow_delete_query = 'true'`, pero **es el arreglo equivocado**: borra la
  fila del índice y deja el archivo HUÉRFANO en S3 —sigue ocupando y ya no se puede
  ni listar—, así que la única vía que borra los bytes es la API. Falta cargar
  `service_role_key` en el Vault: hasta entonces la función devuelve 0 con un
  `notice` (el cron termina bien) y **`rep_salud` avisa del backlog con la acción
  concreta** (508 PDFs, 236 MB) en vez del error críptico.
  **Sigue roto y no se puede arreglar desde LK**: `refresh-mvs-daily` necesita
  `grant select on public.sales_lines to loke_reader;` **en el proyecto CHEF**
  (mismo pendiente que ya existía para `orders`).
- **Un cron que falla es invisible.** Los cinco de arriba estuvieron caídos entre 7
  y 51 días sin que nada lo avisara; el síntoma visible era el panel mostrando
  julio cuando `sales_lines` ya tenía agosto. Al tocar cualquier cosa que corra por
  cron, chequear después con:
  `select j.jobname, r.status, r.start_time, r.return_message from cron.job_run_details r join cron.job j on j.jobid=r.jobid order by r.start_time desc limit 20;`
- **Los archivos de `sql/` estuvieron al día el 31/7/2026, pero el inventario creció.** 14 archivos SQL en `sql/` al 24/8/2026: `arca_padron.sql`, `clientes_lk_ch.sql`, `customer_grupos.sql`, `expo.sql`, `fix_tipos_uuid_tracking_modulos.sql`, `gerente_ventas.sql`, `get_estadistica_clientes_agg.sql`, `get_ranking_inactivos.sql`, `order_items_source.sql`, `precios_super.sql`, `ranking_inactivos_excluidos.sql`, `sales_excluded_items_pseudo_articulos.sql`, `v_orders_origen.sql`; más `arca_padron.INSTRUCTIVO.md`. **La fuente de verdad sigue siendo la base**: los `.sql` no se ejecutan solos, se corren a mano en el SQL editor, así que un cambio hecho ahí y no volcado los desfasa. Para sacar la definición real: `select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = '<nombre>';`. Para verificar un archivo contra la base, comparar el md5 del cuerpo normalizado (sin comentarios ni espacios) contra `md5(regexp_replace(regexp_replace(regexp_replace(prosrc,'/\*.*?\*/','','gs'),'--[^\n]*','','g'),'\s','','g'))`.
- **El reparto de `sql/` para lo de clientes**: `customer_grupos.sql` tiene SOLO agrupar (razones sociales dentro de una empresa) y `clientes_lk_ch.sql` tiene todo lo de cruzar empresas (vínculos, switch, `chef_padron`, cache y cron). `datos_cliente_empresa` vive en `clientes_lk_ch.sql` porque es la pieza que abstrae los dos padrones, aunque la usen los dos módulos.
- **Las cuatro RPC que refrescan `lk_ch_excluidos_cache` lo hacen con un `PERFORM` suelto al final del cuerpo, y ahí hay una trampa**: si queda DESPUÉS de un `RETURN` es código inalcanzable y Postgres no lo marca como error. `vincular_lk_ch` y `desvincular_lk_ch` estuvieron así hasta el 31/7/2026 (vincular no se veía en el ranking hasta el cron del día siguiente); se corrigió moviendo el `PERFORM` arriba del `RETURN`. `set_lk_ch_excluido` y `reset_lk_ch_excluido` siempre funcionaron, pero tienen el `PERFORM` con la misma indentación engañosa (pegado al margen antes del `END`). Al editar cualquiera de las cuatro, verificar que el `PERFORM` quede antes del `RETURN`.
- **Supabase corre `supautils` en `session_preload_libraries`, que bloquea `DELETE`/`UPDATE` sin `WHERE` para roles no superusuario.** Desde el SQL editor (rol `postgres`) esas sentencias pasan, así que el error aparece solo en el navegador: *"DELETE requires a WHERE clause"*. `SECURITY DEFINER` no salva — cambia el usuario, no los parámetros de sesión. Pasó con `refrescar_lk_ch_excluidos`, que vaciaba el cache con un `DELETE FROM lk_ch_excluidos_cache;` pelado y rompía el switch de Clientes vinculados. **Toda función que borre o actualice en masa necesita un `WHERE` real** (`WHERE cod_cliente IS NOT NULL` alcanza).
- **Postgres otorga `EXECUTE` a `PUBLIC` en cada función nueva, y `anon` hereda de `PUBLIC`.** O sea que toda RPC nueva nace ejecutable con la anon key, que es pública porque está embebida en los `.js`. Si además es `SECURITY DEFINER` (casi todas lo son), corre como `postgres` y saltea RLS. **Una RPC nueva NO está protegida por omisión: o lleva el chequeo de admin adentro (`IF NOT EXISTS (SELECT 1 FROM admins a WHERE a.auth_user_id = auth.uid()) THEN RAISE ...`), o hay que revocarle el `EXECUTE` a `PUBLIC`/`anon`.** Al 31/7/2026 había 96 `SECURITY DEFINER` alcanzables por `anon`, 45 de ellas sin ningún chequeo de identidad.
- **Revocadas de `anon` el 31/7/2026** (verificado antes con `SET ROLE anon` que devolvían datos, y después que ya no): `exec_raw_sql` (ejecutaba cualquier `SELECT`), `get_all_sales_lines_admin` (15.132 filas del histórico agregado de ventas), `get_customer_sales_history` (histórico de compras de cualquier cliente, enumerable por código) y `get_table_schema` (columnas de cualquier tabla). A `exec_raw_sql`, `get_table_schema` y `get_admin_otp_secret` se les revocó también `authenticated` porque no las llama ningún archivo del repo. Las cuatro conservan `service_role`, así que un consumidor con service key (n8n) sigue andando. `get_all_sales_lines_admin` y `get_customer_sales_history` conservan `authenticated` porque las llama el panel (`admin.js`, `analisis-venta-cliente.js`) con el usuario logueado.
- **`lookup_cuit_by_username` tiene que seguir abierta a `anon`**: la llama `script.js` en el login para resolver usuario → CUIT antes de que exista sesión. Es un leak de CUIT por enumeración de usuarios, pero es inherente al esquema de login.
- **Queda pendiente**: `get_customer_sales_history` sigue disponible para cualquier `authenticated`, o sea que un cliente mayorista logueado puede leer el histórico de compras de otro pasando su código. Solo la llaman pantallas de admin, así que se arregla agregándole el chequeo de `admins` adentro.
- **El `.xlsx` del Ranking Inactivos usa `get_ranking_inactivos_export`, no `get_ranking_inactivos`.** Las CTEs caras de la RPC de pantalla (frecuencia entre pedidos, artículos distintos, detalle de miembros, líneas del último pedido) están acotadas a la hoja visible de 25 filas; pedirle el ranking completo con un `p_limit` alto las hacía correr sobre los 531 clientes — 23 s medidos contra el `statement_timeout` de ~8 s, o sea el botón fallaba siempre. La RPC de export calcula solo las columnas del archivo: 740 ms. **Las dos tienen que usar el mismo factor de valorización**: una alimenta la tabla en pantalla y la otra el Excel del mismo módulo, así que si divergen muestran números distintos para el mismo cliente. (Antes el Excel salía de `get_valorizacion_clientes_baja`; esa RPC quedó huérfana y desactualizada —no filtraba `empresa = 'lk'` ni aplicaba grupos ni exclusiones por Chef, y daba un 71% de más— y se borró el 31/7/2026.)
- El **desglose por año** del Ranking Inactivos (pantalla y `.xlsx`) es una ventana MÓVIL de los últimos 7 años (`RANKING_ANIOS` en `admin.js`), del más nuevo al más viejo: el 1/1/2027 pasa sola a mostrar 2021–2027. Lo que queda atrás de la ventana se muestra agrupado como "Antes" (y como columna "Anteriores" en el Excel, solo si algún cliente tiene plata ahí), para que los años sigan sumando el valor histórico total.
- **El dashboard de ventas usa DOS FUENTES con significados distintos y la pantalla lo dice.** `FACTURADO` sale de `sales_lines` por mes CERRADO (lk al 31/7/2026, chef al 30/6) valorizado con `uxb*list_price*dtos`; `PEDIDO` sale de `orders.total`, que es plata REAL del portal y está EN VIVO. Nunca coinciden mes a mes porque `orders.created_at` es cuándo se pidió y `sales_lines.invoice_date` cuándo se facturó: un pedido del 30/6 se factura en julio. Reconciliación medida: abril 102%, junio 114%, julio 101% — **pero mayo da 52%** ($622 M ERP contra $323 M web), que quedó sin explicar y conviene revisar.
- **Desde 2026 el ~99% de los pedidos entra por el portal**, incluidos los que carga el admin desde cotizadores. Por eso `orders`/`order_items` dejó de ser una porción y es la operación: 981 pedidos desde marzo, el 100% con `total` y `payment_method`. Medir "adopción del canal web" ya no tiene sentido.
- **El dashboard se calcula en TRES funciones** (`gv_dashboard_calcular`, `_calcular2`, `_extra`: 4,7 + 4,6 + 2,5 s) y se guarda en `gv_dash_cache` (una fila, jsonb). Van en funciones separadas porque juntas pasarían el `statement_timeout` de ~8 s. `_extra` trae proyección de cierre de año (con estacionalidad), ranking de productos que crecen/caen, y fuga temprana (cliente 1,2×-2× su ritmo, antes del umbral de `ritmo_caido`). La pantalla lee `gv_dashboard()`, que solo toca el cache. Las refresca el cron `gerente-ventas-diario`.
- **`pedidos` NO se puede sumar desde el CTE `agg` del dashboard**: está abierto por categoría, así que un pedido con 5 categorías contaría 5 veces (daba 1.322 pedidos para 148 clientes en julio). Se cuentan en el CTE `ped`, en una pasada liviana sin joins.
- **Los medios de pago vienen sucios del ERP**: las filas tipo `075 - 075 DIAS SIN DPP NRO EXPEDICIÓN: 45438726` llevan el número de expedición adentro, así que son UNA POR PEDIDO y ensuciaban el mix con decenas de categorías de un pedido cada una. Se agrupan bajo "Condición ERP (a plazo)" con un `~ 'NRO EXPEDICI'`. Bajó de 38 etiquetas a 23.
- **El módulo Gerente de ventas tiene dos mitades independientes**: el AGENTE (5 acciones por día, `gv_*`) y la COBERTURA GEOGRÁFICA (mapa y ratio habitantes/punto, `geo_*`). Todo en `sql/gerente_ventas.sql`. La única atadura entre las dos es la señal `zona_fria`, que sale de `gv_cobertura_provincia`.
- **El agente NO es un LLM: es SQL determinístico + un peso que aprende.** `gv_candidatos` produce candidatos de seis señales (`reactivar`, `ritmo_caido`, `categoria_perdida`, `chef_activo_lk_frio`, `sin_portal`, `zona_fria`) con un score 0..1 dentro de cada una; `gv_generar_dia` elige 5 con `score_base × gv_peso(intentos, aciertos)`. El peso es la tasa de acierto suavizada (Laplace +1/+2), arranca en 0,50 y solo lo mueve `gv_registrar_resultado`. **Ahí está la automejora**: no hay constantes escritas a mano que alguien tenga que ir a tocar. `gv_registrar_resultado` deshace el conteo anterior antes de aplicar el nuevo, así cambiar de opinión sobre una sugerencia no suma dos intentos (verificado: intentos queda en 1, no en 2).
- **El feedback tiene DOS EJES SEPARADOS y confundirlos fue un error de diseño real.** `resultado` (`pendiente`/`en_curso`/`gano`/`perdio`/`no_aplica`) es qué pasó con el cliente y alimenta la conversión; `utilidad` (`sin_opinion`/`util`/`no_util`) es si el usuario quiere seguir viendo esa clase de sugerencia y **es lo ÚNICO que mueve el peso**. Antes un solo `estado` hacía las dos cosas: una venta perdida bajaba el peso de una señal bien pensada. Verificado: `gano` mueve conversión y deja el peso en 0,50; `no_util` lo baja a 0,33 sin tocar la conversión.
- **`gv_preguntas` es el segundo canal: el agente pregunta sobre SU PROPIO comportamiento**, no propone acciones comerciales. Las preguntas no están escritas a mano — `gv_generar_preguntas` las deriva de patrones del feedback (señal muy marcada como no útil, señal sin ninguna opinión, señal que convierte bien, cliente descartado dos veces). Responder tiene efecto real vía `gv_responder_pregunta`: apaga la señal, sube su `tope_dia`, o inserta en `gv_silenciados`. La `clave` es única para no repreguntar lo mismo todos los días.
- **`gv_senales.tope_dia` reemplazó al 2 hardcodeado** justamente para que una respuesta del usuario ("traeme más de estas") pueda moverlo sin tocar código. Tope máximo 4.
- **Nueve señales, 2.064 ms** (bajó desde 4.135 ms con seis: consolidar los escaneos de categorías en un solo `cat_rec` que sirve a dos señales mejoró el plan). Las tres nuevas son `ticket_bajo` (mismo ritmo, mitad de volumen — la fuga que no aparece en ningún ranking), `sin_segunda` (compró una vez hace 60-180 días) y `una_sola_linea` (concentra ≥85% en una categoría).
- **Cada candidato devuelve `evidencia` en el payload**: los 2-3 números crudos que lo dispararon, para que la sugerencia se pueda discutir en vez de tener que creerle a una frase.
- **`gv_rendimiento` compara trabajadas contra NO trabajadas.** No es un experimento controlado —nadie asignó al azar— pero es la referencia honesta: si los clientes trabajados no compran más que los ignorados, el módulo no aporta. Valoriza en neto con la misma cadena que el resto de Estadística Clientes.
- **El filtro por vendedor de la agenda va en el NAVEGADOR**, al revés que el del Ranking Inactivos: son 5 filas por día y 35 en la semana, así que un `p_vendedor` server-side sería un viaje por tecla al pedo. El `vendedor` se resuelve al generar (`gv_completar_vendedores`) y se guarda en la fila.
- **El tope de 2 por señal en `gv_generar_dia` no es cosmético.** Sin él, `reactivar` se lleva las 5 todos los días —es la señal con los montos más grandes— y el mensaje diario se vuelve una lista de morosos. Con el tope, el día mezcla cartera y prospección.
- **Los scores usan `gv_score_suave(x, k) = x/(x+k)`, NO `LEAST(1, x/k)`.** El tope saturaba: un cliente a 11,4× su ritmo y otro a 5,6× puntuaban igual (1.0 los dos) y el orden dentro de la señal se perdía — las 5 del día salían todas con score 0,5000. Con la curva suave dan 0,70 y 0,47.
- **`gv_candidatos` cuesta 4.135 ms** contra el `statement_timeout` de ~8 s: es lo más caro del repo después del ranking completo. Corre una vez por día desde el cron `gerente-ventas-diario` (10:30 UTC = 07:30 ART, después de `sincronizar-chef-diario` porque una señal lee el padrón de Chef). El botón "Regenerar" la vuelve a correr a demanda. **No meter `sales_lines` en un CTE compartido entre señales**: se materializa (189k filas) y cada uso pasa a seq scan, el mismo problema ya documentado para `get_ranking_inactivos`.
- **El guard de admin NO puede colgarse del `FROM` de una función SQL.** Se probó `FROM (SELECT gv_es_admin()) _adm, ...` y Postgres elimina una subconsulta de una fila cuyas columnas no se referencian: el guard nunca se evaluaba y **bloqueaba 0 de 5** funciones. La forma que sí anda es `PERFORM gv_es_admin();` en `plpgsql`, que no es optimizable. Verificado después: 5 de 5 rechazan a un no-admin y devuelven lo mismo que antes para un admin.
- **Lo que también corre el cron usa `gv_es_admin_o_cron()`, no `gv_es_admin()`.** El cron ejecuta como `postgres` sin JWT, así que `auth.uid()` es NULL y el guard estricto mataría la generación de todas las mañanas. Con sesión exige admin; sin sesión pasa, y a `anon` ya se le revocó el `EXECUTE`.
- **La unidad geográfica es la LOCALIDAD, no la calle.** `customer_delivery_addresses` tiene `cp` cargado en 3 filas de 1583 y `calle` en 4: el domicilio fino no existe. Sí están provincia (1566/1583) y localidad (1471/1583). `customers.localidad` está **vacía en las 1245 fichas**, no sirve para nada. Son 439 localidades distintas sobre 1583 sucursales de 1230 clientes.
- **`gv_cobertura_provincia` NO se calcula sobre `gv_cobertura`.** Esa exige localidad y 112 sucursales no la tienen (92 solo en CABA), así que el rollup subestimaba el denominador y hacía ver a CABA como 1 punto cada 9.514 habitantes cuando son 7.430. Cuenta contra el padrón crudo y expone `sin_localidad` para que el faltante se vea en pantalla en vez de desaparecer.
- **La población por provincia que está cargada es PROVISORIA y hay que reemplazarla.** La suma de las 24 da 46.082.944 contra los 46.044.703 publicados del Censo 2022: **~38.241 de más** repartidos en alguna provincia (0,08%). Alcanza para comparar (el ratio va de 1 cada 7.430 en CABA a 1 cada 320.240 en Misiones, 43×), pero no es dato oficial. Se reemplaza con `gv_set_poblacion(provincia, NULL, poblacion, fuente, anio)`. **La población por localidad no viene cargada**, así que el ratio por localidad sale vacío hasta que se importe.
- **La geocodificación la hace el NAVEGADOR contra la API Georef de datos.gob.ar** (pública, sin autenticación, con CORS): el mismo caso que el BCRA y el opuesto al de ARCA, que necesita certificado y por eso necesita un worker. Prueba tres recursos en cascada (`localidades` → `asentamientos` → `municipios`) porque no todo cae en el mismo. Concurrencia 3 con pausa de 200 ms, igual que la tanda del BCRA. `gv_geo_registrar` valida que la coordenada caiga dentro de Argentina: una coordenada mal descoloca el encuadre del mapa entero.
- **El contorno del mapa sale de `argentina-provinces.json`, que vive EN EL REPO.** Hasta el 3/8/2026 `argentina-map-data.js` lo pedía como `argentina-provinces.geojson` pero el archivo **nunca se había commiteado**: daba 404 y quedaban los dos CDN (GitHub raw y jsDelivr), que en la red de la oficina tampoco responden. Resultado: el mapa caía SIEMPRE al fallback simplificado —rectángulos, no Argentina— y como ese fallback no es geográfico, tampoco se dibujaban los pines. Esto afectaba también al mapa de Estadística madre, que usa el mismo cargador. La extensión es **`.json` y no `.geojson` a propósito**: IIS devuelve 404 para extensiones que no tenga declaradas en `staticContent`, y el `web.config` real declara `.webp`/`.woff2`/`.avif` pero no `.geojson`. El dato es Natural Earth ADM1 (dominio público) vía el paquete npm `@geo-insight/data` (MIT), recortado a la propiedad `name` y con coordenadas a 4 decimales: 40 kB, 24 provincias, bbox lon −73,57..−53,66 / lat −55,05..−21,79. **Sin el reclamo antártico**, que estiraría el encuadre hasta el polo y dejaría el país como una raya.
- **El zoom por provincia es reencuadrar el `viewBox`, no una librería.** Cada `path` del SVG lleva `data-prov`, así que `getBBox()` da la caja en las MISMAS unidades en las que se proyectaron los pines y los dos sistemas coinciden solos. Se llega desde el menú o haciendo clic en la provincia (clic sobre la ya acercada vuelve al país). **Hay que reescalar los radios de pin y los grosores de borde dividiendo por la escala**: se miden en unidades del SVG, así que el zoom los agranda junto con el mapa y en CABA —que amplía 71,5×, contra 2,4× de Buenos Aires— quedarían manchones tapando la provincia entera.
- **El mapa reusa `argentina-map-data.js`, no trae Leaflet.** Ese archivo ya construía el SVG de las provincias desde un GeoJSON; se le agregó `ARGENTINA_MAP_PROJECTION` + `arMapProject(lon, lat)` para poder ubicar pines sobre el mismo dibujo. **`ARGENTINA_MAP_PROJECTION` queda en `null` cuando se usó el fallback simplificado**, cuyas coordenadas están dibujadas a mano y no son geográficas: quien pinte puntos tiene que chequearlo o los pines caen en cualquier lado.
- **Los nombres de localidad se normalizan con `gv_norm_loc`, que NO es `norm_razon_social`**: esa además borra sufijos societarios, que en un topónimo no corresponde. La normalización resuelve sola las variantes de mayúsculas ("Lomas de Zamora" vs "Lomas De Zamora"); los sinónimos reales van en `geo_localidad_alias`, editable a propósito igual que `tokens_no_distintivos` (hoy tiene una fila: "tucuman" → "san miguel de tucuman"). **CABA usa barrios, no localidades** (San Cristóbal, Balvanera, Constitución, Once), así que su población hay que cargarla por barrio o comuna.
- **Historical sales live in `sales_lines` (~260k rows), not in `orders`.** `orders`/`order_items` only hold web B2B orders (~1k rows, recent). Anything that needs real purchase history (last-purchase dates, churn, lifetime value) must read `sales_lines` — columns `customer_code` (text, matches `customers.cod_cliente`), `item_code` (text, matches `products.cod`), `boxes`, `invoice_date` (text, ISO `YYYY-MM-DD`, so it sorts/compares correctly as a string). `get_estadistica_clientes_agg` and `get_ranking_inactivos` both UNION the two sources.
- **Do the heavy lifting in an RPC, not the browser.** The Supabase REST API caps responses at 1000 rows, so a `.from("sales_lines").select(...)` silently returns a truncated slice — it does not error. The `authenticated` role also has a ~8s `statement_timeout`, so aggregate first and narrow (e.g. LIMIT to the top N) before computing anything expensive. Function definitions live in `sql/`.
- **Edge Functions en el repo** (bajo `supabase/functions/`):
  - `admin-otp/index.ts` — 2FA via email OTP para login admin PPP.
  - `crear-cliente-auth/index.ts` — **Crea auth users** usando `auth.admin.createUser` para bypassear la validación de dominio de Supabase sobre el email sintético `<cuit>@cuit.loekemeyer`. Lo llaman `script.js` y `admin.js`.
- **Edge Functions externas** (no están en este repo, viven en Supabase directamente): `sheets-proxy` y `sheets-entregas-proxy` (push de pedidos confirmados a Google Sheets, llamadas vía `fetch`). `orders.sheets_payload` / `orders.sheets_sent` se escriben después de un push exitoso. También `sales-agent` (SQL generado por LLM, ver Pendientes → Seguridad).
- Product images are served via Supabase public storage: `{SUPABASE_URL}/storage/v1/object/public/products-images/{cod}.webp`. The `BASE_IMG`/`IMG_PARAMS` pair is redeclared in `script.js`, `historial.js`, `sugerencias.js` and `admin.js`; keep them in sync. **Do not use** `/storage/v1/render/image/public/` — the image-transformations feature is disabled on this Supabase tenant (returns 403 "FeatureNotEnabled"). Photos are stored pre-rendered at 400x400 WebP, so `IMG_PARAMS` is an empty string.
- `app_settings.web_order_discount` is read at load time as the web-order discount (fallback `0.02`).
- **Los módulos de estadística valorizan en NETO, no a precio de lista.** `get_ranking_inactivos` y `get_ranking_inactivos_export` hacen `boxes * products.uxb * products.list_price * (1 - customers.dto_vol) * (1 - app_settings.web_order_discount)`. **`list_price` es el precio POR UNIDAD, no por caja**, así que el `uxb` NO es opcional: sin él el monto sale dividido por las unidades por caja (promedio 12,1, rango 1 a 100). Es el mismo cálculo que hace el carrito en `script.js` (`listUnit * (uxb * cajas)`) — la misma cadena multiplicativa que arma un pedido real en `script.js` (`listUnit * (1 - dtoVol) * (1 - webDiscountRate) * (1 - extraRate)`). El descuento por medio de pago queda afuera: depende de cómo se pagó cada pedido y `sales_lines` no lo guarda. Las dos RPC tienen que usar el MISMO factor: una alimenta la tabla en pantalla y la otra el Excel descargable del mismo módulo, así que si divergen muestran números distintos para el mismo cliente.

## Pages and their scripts

| Page | Script | Role |
|---|---|---|
| `index.html` | `script.index.js` + `css/styles.index.css` | Public landing, video hero, client-logo bouncing carousel, legal modals. No Supabase. |
| `mayorista.html` | `script.js` + `css/styles.css` | Main B2B SPA-ish catalog: login, product browsing, cart, order submission, Loke line, profile, order history link. Single file containing every "section" (`productos`, `carrito`, `perfil`, `loke`, `pedidoConfirmado`, …) — `showSection(id)` in `script.js` toggles `.active` on `.section` nodes. |
| `historial.html` | `historial.js` + `css/historial.css` | Customer-facing past-orders view. |
| `sugerencias.html` | `sugerencias.js` + `css/sugerencias.css` | Suggestions / new-product tabs per customer (uses `sugerencias_cliente` / `novedades_marca` RPCs). |
| `admin.html` | `admin.js` + `css/admin.css` | Admin panel with sidebar nav (`data-page` attributes on `.nav-item`, hash-based deep-linking via `location.hash`). Handles customers, addresses, products, tracking, promos, and the "Carga/Promo Pedidos" tool (cotizador upload + flyer generator). Depends on the `xlsx` CDN for spreadsheet import/export. Incluye **Gerente de ventas** (`data-page="gerente-ventas"`), que reusa `argentina-map-data.js` para el mapa. |
| `analisis-venta-cliente.html` | `analisis-venta-cliente.js` + `css/analisis-venta-cliente.css` | Análisis de venta por cliente (standalone y embebido en mayorista). Tiene su propio Supabase client. |
| `analisis-cobranzas.html` | `analisis-cobranzas.js` + `css/analisis-cobranzas.css` | Módulo de análisis de cobranzas. |
| `carga-pedidos.html` | — | Carga de pedidos por Excel (cotizador). |
| `expo-qr-test.html` | `jsqr.js` | Página de prueba del escáner QR para el modo expo (ferias). |

## Módulo Expo (ferias)

El modo expo permite onboarding de clientes nuevos en ferias comerciales. Archivos:
- `expo-qr-test.html` + `jsqr.js` — escáner QR de credenciales de asistentes.
- Integrado en `script.js` (modo expo dentro del catálogo mayorista).
- `sql/expo.sql` — esquema Supabase (tablas `expo_config`, `expo_clientes_pendientes`, `expo_dto_escala`; RPCs `expo_dashboard`, `expo_peek_cod`, `expo_reservar_cod`, `buscar_cliente_expo`).
- `docs/expo-replicacion-completa.md` / `.txt` y `docs/expo-resumen-global.md` — guías para replicar el módulo a otros repos (verificado contra LK base 16/8/2026).

## Módulo Vendor Import Excel

`vendor-import-excel.js` + `scotapi-shim.js` — importación de Excels Megashops para uso de vendedores en `mayorista.html`. Explota un Excel grupal (Poy/Megashop/Primer Precio) en N pedidos por sucursal. `scotapi-shim.js` es un shim liviano de `window.scotApi` para reusar el loader de Excel fuera del admin.

## Directorio docs/

Documentos de planificación y replicación, NO ejecutables:
- `expo-replicacion-completa.md` / `.txt` — guía completa para replicar el módulo expo.
- `expo-resumen-global.md` — resumen global del módulo expo.
- `plan-pedido-automatico-multitenant.md` — plan para pedidos automáticos multi-tenant.
- `prompt-crm.md` — prompt para CRM con estructura de onboarding ICIS ERP.

## Client-side state conventions (`script.js`)

- `script.js` is a ~13,750-line IIFE-less global-namespace file. Functions are exposed to inline `onclick=` handlers via `window.showSection = showSection` etc. When adding a new handler used from HTML, remember to re-export on `window`.
- Global state lives as top-level `let`s: `products`, `cart`, `customerProfile`, `isAdmin`, `deliveryChoice`, `sortMode`, `lastConfirmedOrder`, etc. There is no framework — render functions read these globals and write the DOM directly.
- Anomaly detection: `ANOMALY_THRESHOLD = 6` flags cart lines > 6× a customer's historical monthly average (from view `v_customer_item_month`), cached per-customer in `_anomalyCache`.
- A single customer code is treated as special: `cod_cliente === "5000"` triggers list-price-only mode alongside admins (`isListPriceOnlyClient()`).
- Category ordering is hardcoded: `CATEGORY_ORDER` and `UTENSILIOS_SUB_ORDER` at the top of `script.js`. New categories are ignored in the menu until added here.

## Common operations

- **Run locally**: open `index.html` or `mayorista.html` in a browser, or serve the `wwwroot` directory with any static server (e.g. `python -m http.server`). There is no dev server.
- **Deploy: se despliega SOLO con el push a `main`.** El sitio de trabajo es **GitHub Pages** (`loekemeyer.github.io`), que se rebuildea con cada push mediante el workflow *"pages build and deployment"*. Tarda entre 30 s y un par de minutos; si el cambio no se ve, lo más probable es que la corrida esté en cola, no que falte un paso. **No sugerir `git pull` ni copiar archivos**: no hay nada que hacer a mano después del push, solo `Ctrl+F5`.
  - Para ver el estado de la última corrida: Actions → *pages build and deployment*, o `mcp__github__actions_list` con `method: list_workflow_runs`.
  - **El IIS es un despliegue APARTE y ocasional**, no el flujo normal. Ahí sí los archivos son el entregable y se copian a mano al web root. Ojo con el espejo (`robocopy /MIR`, `rsync --delete`): borraría el `web.config` del servidor, que es el único que existe.
  - `loeke.zip` en el repo es un bundle de despliegue viejo; no editar.
- **Third-party libs** are loaded from CDN in the HTML files (Supabase JS v2, jsPDF, lottie-web, xlsx). There is no bundler; add new libs the same way (a `<script src="https://cdn...">` tag).
- **SQL fix scripts** like `fix_missing.sql` are one-shot data repairs run manually in the Supabase SQL editor; they are not migrations and have no framework.
- **`vercel.json`** tiene rewrites de URLs limpias (mayorista, historial, sugerencias, admin). Presente por si se hace un deploy de prueba a Vercel, pero la producción va por IIS/GitHub Pages.
- **SQL files en la raíz** (one-shot, no documentados como módulo): `add_module_usage_tracking.sql`, `add_order_source_tracking.sql`, `crear_ventas_chef.sql`, `estadistica_madre_cache.sql`, `impactar_ventas_chef_en_sales_lines.sql`, `programar_pedido_automatico.sql`, `recordatorio_mail_ventas.sql`. Todos son scripts de data repair o setup que se corren a mano.

## Versionamiento automático

Los hooks viven en **`hooks/`** (versionados) y **automáticamente**:
- Incrementan la versión en `version.js` (+1 en patch, ej: 2.3.1 → 2.3.2)
- Actualizan los `?v=XXX` de **`.js` y `.css`** en los HTML (cache busting del navegador)
- Generan un commit message descriptivo identificando **exactamente qué archivos cambió** (ej: `styles.css`, `script.js`, etc.)

**Activación (una vez por clon):**
```bash
git config core.hooksPath hooks
```
Sin eso los hooks NO corren: `.git/hooks` no se versiona, así que un clon nuevo
—o una sesión de Claude en un contenedor— arranca sin ellos. Si ves un commit
sin el `bump:` en el mensaje, es que faltó este paso.

**Flujo normal:**
```bash
# 1. Haz cambios
# 2. Stage los archivos
git add script.js css/styles.css

# 3. Commit - los hooks se ejecutan automáticamente
git commit -m "descripción breve de tus cambios"
```

**El hook genera automáticamente:**
```
bump: version 2.3.1 → 2.3.2

Cambios:
- script.js: script JS modificado
- css/styles.css: estilos CSS modificado
```

**Notas:**
- Version.js se actualiza y se agrega al commit automáticamente
- Los `?v=XXX` en HTML se actualizan automáticamente
- No necesitas ejecutar nada manual, todo ocurre al hacer `git commit`
- El mensaje de commit será sobrescrito con el descriptivo automático
- `prepare-commit-msg` corre DESPUÉS de `pre-commit`, así que cuando lee `version.js` ya está bumpeada. Por eso saca la versión vieja de `git show HEAD:version.js` y no restándole 1 al archivo. Si se toca ese orden, el mensaje vuelve a anunciar una versión que el commit no contiene.

## SEO / crawling

- `robots.txt` explicitly allow-lists the major AI/search crawlers (GPTBot, ClaudeBot, Google-Extended, PerplexityBot, bingbot, CCBot, etc.) and declares the sitemap. Generic `User-agent: *` is also allowed; only `/logs/`, `/backup/`, `/tmp/` are disallowed.
- `sitemap.xml` lists only the two public entry points: `/` (landing) and `/mayorista.html` (login gate). The auth-gated pages (`historial.html`, `sugerencias.html`, `admin.html`) must NOT be added — their content lives behind Supabase auth and is not crawlable anyway.
- When adding a new public page, update both `sitemap.xml` (with `<lastmod>`) and — if it should appear in nav — the relevant HTML.

## File locks (edición concurrente)

Varias personas y sesiones de Claude editan este proyecto sobre el mismo share de red. Antes de cualquier `Edit`, `Write` o `NotebookEdit`, Claude DEBE seguir este protocolo. Esto es obligatorio, no opcional.

**Estado compartido:** un solo archivo JSON en `.locks/active.json`:

```json
{
  "locks": [
    { "file": "script.js", "owner": "user@mail@HOSTNAME", "acquired": "2026-04-24T15:30:00Z", "note": "filtro categoría" }
  ]
}
```

**Protocolo antes de editar el archivo `F`:**

1. **Leer** `.locks/active.json`. Si no existe, crearlo con `{"locks": []}`.
2. **Chequear** si `F` ya está listado:
   - Lock propio (mismo `owner`) → continuar sin duplicar la entrada.
   - Lock ajeno con `acquired` dentro de los últimos **60 minutos** → DETENERSE. Avisar al usuario: "`F` está bloqueado por `<owner>` desde hace X min. ¿Esperar, coordinar, o forzar el unlock?" y esperar respuesta.
   - Lock ajeno con `acquired` > 60 min (stale) → avisar al usuario que se rompe el lock viejo y continuar.
   - Sin lock → continuar.
3. **Adquirir:** agregar `{ file, owner, acquired: <ISO now>, note: <motivo corto> }` y escribir el JSON.
4. **Editar** `F`.
5. **Liberar:** al cerrar el turno (tarea completada, o cuando el usuario indica que terminó), quitar las entradas propias y escribir el JSON.

**Owner:** `<email de la sesión>@<COMPUTERNAME>` — obtener el hostname con `$env:COMPUTERNAME` vía PowerShell si aún no se sabe, y reutilizarlo en toda la sesión.

**No se lockean:** `.locks/active.json` mismo, ni archivos que solo se leen.

**Escrituras concurrentes al JSON:** SMB no da locking atómico fuerte. Si al releer antes de escribir el contenido cambió respecto a lo leído, rehacer el paso 2 (otro proceso modificó el archivo en el ínterin).

## Gotchas

- Language is Spanish throughout UI text, variable names, and comments — match the surrounding style when editing.
- The same Supabase URL/anon key/image helper block is duplicated across files by design (no module system). When changing any of these constants, grep for them everywhere.
- `admin.js` uses `var` / function-scoped old-style JS, `script.js` / `historial.js` / `sugerencias.js` use `const`/`let`/arrow functions. Don't "modernize" `admin.js` opportunistically — it's consistent within its file.
- Paths in HTML use a mix of `./css/...` and `css/...` — both resolve the same way under IIS; no need to normalize unless fixing a real bug.

## Pendientes — AVISAR AL USUARIO

**Instrucción para Claude, no es una nota suelta:** cuando una sesión toque alguno de
estos módulos, mencionarle al usuario el pendiente que le corresponde antes de terminar
el turno. Es él quien decide si lo encara ahora o lo deja; no hay que implementarlo por
iniciativa propia. Cuando un pendiente se resuelve, borrar la línea de acá.

### Gerente de ventas

- **TELEGRAM YA ESTÁ ANDANDO (3/9/2026).** Se resolvió el pendiente. Bot
  **@Lk_gerencia_bot**, token en el Vault de LK (`telegram_bot_token`), destinatario
  el **chat privado** del usuario (`6282395816`), NO un grupo. El transporte es el
  patrón `telegram_outbox` portado de Producción Virgilio: **pg_net + pg_cron +
  Vault, sin Edge Function y sin n8n** — `sendMessage` es un POST JSON y `pg_net`
  ya estaba instalado. Todo en `sql/reportes_telegram.sql`.
  El CLAUDE.md decía antes que "si el bot existe, vive en n8n, que no es alcanzable
  desde una sesión de Claude": era falso y hacía parecer difícil una tarea de una
  tarde. Virgilio tenía el stack completo hecho en Postgres.
  **`tg_enqueue` NO parte mensajes y Telegram corta en 4096 chars**: para cualquier
  texto que pueda crecer (rankings, listados) usar `tg_enqueue_largo`, que parte por
  líneas y sufija el `dedup_key`. Sin eso, Telegram devuelve 400 y el flush lo
  reintenta 60 veces antes de rendirse.
  **Las funciones `tg_*` y `rep_*` tienen `EXECUTE` revocado a `public`/`anon`/
  `authenticated` y no es opcional**: son `SECURITY DEFINER` y la anon key de LK es
  pública (va embebida en los `.js` que sirve GitHub Pages). Sin el revoke,
  cualquiera puede inyectar mensajes al Telegram de gerencia.
  **La fase 2 (botones inline) está hecha** (4/9/2026). Mandarlos era la parte
  fácil (`reply_markup` + la columna nueva `telegram_outbox.reply_markup`); lo
  que faltaba era RECIBIR el click, que necesita un endpoint público: la Edge
  Function **`gv-telegram-webhook`** (`verify_jwt=off`), en
  `supabase/functions/` con su README de deploy. Falta que el usuario la
  deployee, cargue `telegram_webhook_secret` y corra el `setWebhook`.
  **Va UN MENSAJE POR SUGERENCIA, no uno solo con todo**: el `callback_data`
  tiene que llevar el id y Telegram lo topea en 64 bytes; además así cada
  respuesta edita su propio mensaje y en el historial queda qué se contestó.
  **El gate NO es el JWT: es el `secret_token`** que Telegram devuelve en el
  header `X-Telegram-Bot-Api-Secret-Token`. La URL de una Edge Function es
  pública y adivinable, así que sin ese chequeo cualquiera podría inyectar
  feedback falso y torcer el aprendizaje del agente. Un request que no pasa el
  gate devuelve **200 y no 401**, porque a Telegram un error le hace reintentar
  la misma update en loop.
  **`gv_marcar_utilidad` y `gv_marcar_resultado` pasaron a `gv_es_admin_o_cron()`**:
  el webhook entra con `service_role` y sin JWT, así que `auth.uid()` es NULL y
  el guard estricto lo mataría. No abre nada — `anon` ya tenía el `EXECUTE`
  revocado y un `authenticated` que no sea admin sigue rechazado. Verificado de
  punta a punta: un click movió el peso de `ticket_bajo` de 0,5000 a 0,6667 y
  dejó `acc_trab` en 0, o sea que los dos ejes siguen separados.
- **Lo que realmente SALIÓ del depósito NO está en el Supabase de LK: está en el de
  Virgilio** (`Facturacion_NP`, con `fecha_salida` al día). Se espeja a LK con
  `sincronizar_ppp()` → `ppp_facturacion`. **Es lo que hace posible un número de
  plata DIARIO**, porque `sales_lines` entra por lote mensual y no sirve para eso.
  El reporte diario y el semanal muestran ese bloque como "DESPACHADO".
- **`rep_despacho_diario` es una FOTO y no se puede reemplazar por una consulta.**
  `ppp_base_pedidos` es amnésica (el sync la reemplaza entera), así que las líneas
  de una NP vieja desaparecen y con ellas la posibilidad de valorizarla. Medido el
  3/9/2026: septiembre 100% valorizable, agosto 95%, julio 66%, **junio 0%**. La
  foto la toma `rep_snapshot_despacho()`, que llama `sincronizar_ppp()` apenas
  refresca el espejo, y solo pisa un día si la corrida nueva tiene al menos tantas
  NP valorizadas como la guardada — si no, una corrida tardía degradaría un dato
  que ya estaba bien.
- **El despacho se valoriza sobre las cajas PEDIDAS y se ajusta por lo entregado.**
  `ppp_base_pedidos` es el único detalle por artículo que existe, pero Virgilio
  despacha corto ~4,5%: sin el ajuste el número sobreestima. El ratio sale de
  `vista_ppp_pedidos_entregados`, espejada como `ppp_entregas_np` (necesita
  `grant select ... to lk_ppp_reader` del lado Virgilio).
- **DESPACHADO y FACTURADO no son el mismo número y no se suman.** Agosto 2026:
  Virgilio ajustado **$538,9 M**, ERP crudo **$477,0 M**, ERP corregido por las
  cajas sin match **$586,0 M**; cajas 19.353 vs 22.556 (86%). Se corroboran, y las
  diferencias tienen causa conocida: el ERP pierde el 18,6% de las cajas de agosto
  en el join a `products`, y no todo lo que factura LK pasa por PPP.
- **Los reportes de gerencia miden DOS RELOJES distintos y no se pueden mezclar.**
  `orders` (portal) es plata **pedida**, está EN VIVO. `sales_lines` (ERP) es plata
  **facturada**, y entra **por lote MENSUAL cargado a mano** (un `import_batch` por
  mes, subido a principios del siguiente: `ago-26` se cargó el 2/9). Tiene fecha
  diaria adentro, así que un diario retrospectivo se puede armar, pero **la
  facturación de hoy no existe en la base hasta el mes que viene**. Por eso el
  reporte diario y el semanal miden pedido + backlog PPP, y sólo el mensual mide
  facturación real. Un diario de facturación en vivo exige cambiar la cadencia de
  carga del Excel.
- **El reporte mensual dedupea por MES REPORTADO, no por fecha de envío.** El cron
  intenta los días 3, 5, 8 y 12 porque el lote del ERP llega entre el 2 y el 14;
  mientras el mes del cache no cambie, el `on conflict do nothing` frena el envío.
  El día que entra el lote, el mes es nuevo y sale solo. No tocar esa lógica
  pensando que son envíos duplicados.
- **El aviso POR ARTÍCULO necesita los meses en cero, no el promedio.** Coto
  dejó de comprar el **505** —su artículo más fuerte— y el reporte lo mostraba
  como *"CAE FUERTE −52%"* en vez de un corte: `rep_articulos_cliente` compara el
  promedio de los últimos 3 meses contra los 12 previos, y la ventana jun-jul-ago
  todavía contenía junio (332 cj), así que 332/3 = 110,7 contra una base de 228,3
  da −52%. **Un artículo que se cortó del todo se lee como media caída.** Es la
  misma lección del drawdown que ya se había aprendido para clientes, ahora a
  nivel artículo. Se agregó `meses_sin_compra` como señal propia y el estado
  **`SE CORTÓ`** (≥ 2 meses en cero y ≥ 6 meses de historia; con 1 mes solo, el
  ritmo de reposición de un súper ya da falsos positivos). Se calcula como la
  distancia en meses entre la última compra y el último mes cerrado del ERP, que
  por construcción ES la racha de ceros del final — no hace falta armar la
  rejilla. Con eso el 505 de Coto pasa a "SE CORTÓ · hace 2 meses" y aparece
  además el 529E, que estaba tapado igual.
- **`rep_articulos_cortados` barre sólo clientes VIVOS** (los que compraron en
  los últimos 2 meses): el que dejó de comprar del todo es el Ranking Inactivos,
  no este reporte. Llama a `rep_articulos_cliente` por `LATERAL` **a propósito**,
  para que el criterio esté definido una sola vez y las dos vistas no puedan
  divergir. Al 4/9/2026: 20 artículos, **$35,4 M/mes en juego**, encabezados por
  505 en Coto ($4,3 M/mes), 504 en Coto ($3,5 M) y 505 en OSA ($3,3 M). Cron
  `reporte-articulos-telegram`, lunes 11:30 UTC.
- **La alerta de caída de clientes (`rep_caidas`) mide CAJAS, no unidades, a
  propósito.** Unidades exige joinear `products`, y el % de cajas sin match viene
  creciendo fuerte: 1,6% en abril 2026 contra **18,5% en agosto** (el CLAUDE.md
  decía 4,2%, quedó viejo). Con unidades, una caída podría ser sólo un artículo dado
  de baja del maestro. Las unidades se informan igual, marcadas como aproximadas.
  Ventana: promedio mensual de los últimos 3 meses contra el de los 12 previos,
  umbral 40% de caída y piso de 40 cajas/mes de base.
- **UNA LÍNEA ENTERA DE PRODUCTOS SE VENDE Y NO ESTÁ EN `products`.** Es la causa
  del salto del 0,1% de cajas sin ficha en mayo al **16,1% en agosto**: 89 códigos
  empezaron a venderse el **1/7/2026** y nunca se cargaron (`706` a 32 clientes,
  `713` a 30, `701` a 29, `099`, `702E`…). Aparte, el **`574`** vende desde enero a
  **41 clientes** y tampoco está — ése es un agujero viejo, no de la tanda de julio.
  Mientras no se carguen, **todo monto de plata sale ~16% corto**, y por eso el
  contraste con el despacho de Virgilio da 119% en vez de ~100%. Son 171 códigos y
  7.138 cajas en 12 meses; la lista completa se saca con el `LEFT JOIN products
  ... WHERE p.cod IS NULL AND lp.cod IS NULL`. `rep_salud()` lo vigila.
  **Al 4/9/2026 quedan 103 códigos sin precio** (las 78 variantes `L` ya se
  resolvieron en `item_precios`): la cobertura de agosto subió de 81,4% a **89,7%
  de las cajas** y el contraste contra el despacho de Virgilio bajó de 119% a
  **97%**. Falta el precio de LK de esos 103; ver más abajo por qué el de Chef no
  sirve para taparlo.
- **Las 15 funciones que valorizan leen `v_item_precio`, no `products`** (migradas
  el 4/9/2026; backup de las definiciones previas en `_backup_funcdefs_20260904`).
  Agosto 2026 pasó de $477,0 M a **$522.387.667** (+9,5%) y la cobertura de 81,4%
  a 89,7% de las cajas. El Ranking Inactivos quedó con los **mismos 368 clientes**
  (0 altas, 0 bajas) y +2,0% de valor histórico; pantalla y Excel siguen
  coincidiendo al peso. Son `gv_dashboard_calcular`, `_calcular2`, `_extra`,
  `gv_drill`, `get_ranking_inactivos`, `get_ranking_inactivos_export`,
  `rep_caidas`, `datos_cliente_empresa`, `ppp_valor_linea`,
  `get_acuerdo_vendedores`, `get_ranking_clientes`, `get_seguimiento_mensual`,
  `get_top_clientes_hist`, `gv_cadenas_sin_lista` y `gv_rendimiento`. **Al agregar
  una función que valorice, joinear la vista y NO `products`**: si la mitad usa una
  y la mitad la otra, el mismo cliente muestra plata distinta según la pantalla.
  Como efecto secundario desaparece el pendiente de los **artículos
  discontinuados**: el `active is true` los descartaba (0% en 2024, 1,4% en 2025,
  4,2% en 2026) y la vista no filtra por `active` a propósito — eso es catálogo,
  no valorización.
- **DOS joins NO se migraron y no hay que "arreglarlos"**: los de `order_items`
  (`p.id = oi.product_id`), porque la vista no tiene `id` y un pedido web sólo
  puede referenciar artículos que están en `products`; y el de `arts_cnt` en
  `get_ranking_inactivos` (`p.cod = a.item`), que cuenta artículos
  **discontinuados** del cliente y por eso tiene que seguir mirando
  `products.active`.
- **`v_item_precio` NO se puede consultar como `UNION ALL` desde el camino
  caliente: lee `item_precio_cache`.** La unión de tres orígenes le sacaba el
  índice al planner — `get_ranking_inactivos(12, 25)` pasó de 671 ms a **4.305 ms**,
  y con `p_limit` alto no terminaba en 60 s. Con el cache y su PK baja a **462 ms**,
  mejor que el original. La unión sobrevive como `v_item_precio_calc`, que es la
  definición y lo único que lee el refresco. **El `ANALYZE` del final de
  `refrescar_item_precio_cache()` no es opcional**: sin él el planner pierde el
  índice y la misma llamada cuesta 1.405 ms en vez de 462 ms. Se refresca solo por
  trigger `AFTER ... FOR EACH STATEMENT` en `products`, `loke_products` e
  `item_precios` (se editan a mano y muy de vez en cuando), así que no hay ventana
  de desactualización ni cron que vigilar.
- **`rep_salud()` mide la cobertura contra `v_item_precio`, no contra `products`.**
  Mientras midió el catálogo avisaba 16,1% de cajas sin ficha cuando los reportes
  ya valorizaban el 89,7% de ellas. Hoy dice **10,3% (81 códigos)**, que es el
  número real. Si se cambia de dónde sale el precio, hay que cambiarlo también acá
  o la alerta vuelve a mentir.
- **El sufijo `L` en un código NO es un renombre global: es una variante para un
  cliente puntual.** 75 pares medidos, todos con ≤3 clientes, y en **72 de los 75 el
  código base le sigue vendiendo a los demás**. Pero para el cliente que la usa, el
  código base deja de aparecer y la variante arranca (`031` termina el 28/2, `031L`
  empieza el 8/7). Sin unificarlos, Relca figuraba **perdiendo 22 artículos cuando
  perdió 6 y encima creció 38%**. Los une la vista **`v_item_canon`**, que aplica
  primero `sales_item_remap` (la tabla de equivalencias que ya existía, con 3 filas)
  y después el sufijo. **Se usa SOLO para detectar caídas, nunca para valorizar**:
  el precio de la variante puede no ser el del base y eso lo decide una persona.
- **`boxes` puede venir NULL, y `ORDER BY sum(boxes) DESC` pone los NULL PRIMERO.**
  Un cliente nuevo y chico (Gigot, cod 5000) encabezó el ranking de "principales"
  justamente por no tener una sola caja contable, y encima salió marcado como
  "dejó de comprar". Son 122 líneas, un solo cliente, un solo día (9/4/2026), y con
  `import_batch` y `row_hash` también NULL: **no vinieron del lote mensual del ERP**.
  Toda función que rankee por volumen necesita `and boxes is not null` y
  `nulls last`. `rep_salud()` lo vigila.
- **"Cliente en caída" se mide con DRAWDOWN sobre el pico, no con 3m vs 12m.**
  El criterio viejo es un promedio contra un promedio y llega tarde: simulado mes a
  mes sobre Coto, el drawdown (trimestre móvil actual contra el mejor trimestre
  móvil de 15 meses) cruza el umbral con datos de **mayo** y el criterio viejo con
  datos de **julio** — dos meses, y en esos dos meses Coto pasó de 1.544 cajas/mes a
  435. Umbral **25% para el top 20** y 35% para el resto. `rep_drawdown()` excluye a
  los que ya se fueron (ésos son del Ranking Inactivos) y **completa la rejilla de
  meses con ceros**: sin eso el trimestre móvil saltea los huecos y el que dejó de
  comprar se ve igual que el que compra siempre.
- **El fill-rate (pedido por portal vs facturado por ERP) necesita tres cuidados o
  manda a llamar al cliente equivocado.** (1) **Resubmits**: el portal deja mandar
  dos veces el mismo pedido — Coto tiene dos idénticos de 853 cajas el 28/4, y sin
  deduplicar daba 66% en vez de **82%**. Se deduplica por cliente+total dentro de 15
  días. (2) **Desfasaje**: se pide en mayo y se factura en junio, así que se compara
  acumulado sobre una ventana larga, nunca mes a mes. (3) **La norma NO es 100%**:
  la cartera entera da 102-108% porque no todo lo facturado entra por el portal, y
  sin ese número al lado un 82% parece grave. (4) **Sólo clientes con RELACIÓN
  CONTINUA** (6+ meses activos de 12): en alguien que compra 2 o 3 veces al año,
  comparar 5 meses de pedidos contra 5 meses de facturas da cualquier cosa. Peor,
  un cliente que hizo UN pedido y nunca más compró sale 0% y parece un desastre de
  servicio — **eso pasó con Día Argentina**, que pidió 420 cajas el 28/4/2026 y no
  compra desde abril de 2025. Sin el filtro salían 8 clientes; con él, 4, y los 4
  son reales: Sauer 64%, OSA 72%, Coto 82%, Cuyana 89%.
- **Un pedido que nunca se facturó NO es fill-rate: es `rep_pedidos_colgados()`.**
  Son dos llamadas distintas a dos personas distintas — una es "le despachamos
  corto", la otra es "este pedido no se procesó o el cliente lo anuló". Hoy hay dos:
  Día Argentina (420 cj, $5,3 M, pedido el 28/4, inactivo desde abril 2025) y
  Alberdi (100 cj, $2,0 M). Excluye el código `1` (Loekemeyer SRL), que son pedidos
  internos de prueba y eran 3 de los 6 que salían al principio.
- **`rep_salud()` existe porque un cron que falla es invisible** y ya costó cinco
  caídos entre 7 y 51 días. Manda por Telegram **sólo si hay algo** (08:05 ART): un
  aviso diario de "todo bien" se deja de leer. **`rep_cron_verificado` +
  `rep_cron_ok(jobname, nota)`** silencian un cron arreglado a mano hasta su próxima
  corrida real — sin eso la primera alerta reportó como caídos los tres crons que se
  habían arreglado ese mismo día. Si vuelve a fallar, la corrida nueva es posterior a
  la verificación, el filtro deja de aplicar y la alerta sale sola.
- **La población por provincia cargada es PROVISORIA**: suma 46.082.944 contra los
  46.044.703 del Censo 2022 (~38.241 de más). Reemplazar con el dato oficial del INDEC vía
  `gv_set_poblacion(provincia, NULL, poblacion, fuente, anio)`.
- **La población por localidad no está cargada**, así que la pestaña "Por localidad" del
  ratio sale sin números. El mapa igual anda: los pines se dimensionan por sucursales.
- **Quedan 78 localidades sin geocodificar de 439** (corrido el 3/8/2026: 361 resueltas,
  que cubren 1.390 de 1.469 sucursales = 94,6%). No es un bug: es cola de calidad de dato,
  en cuatro grupos. (1) Barrios que Georef no tiene como localidad: `Once`, `Abasto`,
  `Tribunales`, `Alta Cordoba`, `Barrio Jardin`. (2) **Provincia mal cargada**: `Esquel` y
  `Gaiman` figuran en Buenos Aires y son de Chubut; `Berazategui`, `Quilmes`, `San Miguel`,
  `Munro`, `Villa Ballester` y `Ciudadela` figuran en CABA y son de Buenos Aires — eso se
  arregla en `customer_delivery_addresses`, el alias no puede cruzar provincias. (3) Notas
  metidas en el campo: `Verificar`, `Local 86 - Cordoba`, `Mataderos (8:30 a 14)`,
  `Mercado Central (Ma a Ju)`. (4) Abreviaturas y sufijos, que **ya se resolvieron con 18
  alias** (`S.M. de Tucuman`, `Rosario Sud`, `MDQ Norte`, `Usuahia`…). Para sumar más,
  agregar filas en `geo_localidad_alias`; el destino tiene que existir y estar geocodificado.
- **Capa de redacción con LLM (opcional).** `CLAUDE_API_KEY` ya está en el vault, así que
  el mensaje diario podría salir en prosa en vez de lista estructurada sin tocar el motor
  de señales, que es determinístico y no debe depender de un modelo.
- **`sql/gerente_ventas.sql` se regeneró el 4/9/2026 desde la base** con
  `pg_get_functiondef` y el DDL de `pg_catalog`: 8 tablas, 33 funciones,
  **33/33 con md5 normalizado idéntico** a lo que corre. Antes se había escrito
  antes de la segunda tanda de trabajo y no servía para recrear el módulo. **La base
  sigue siendo la fuente de verdad**: el archivo no se ejecuta solo, así que un
  cambio hecho en el SQL editor y no volcado lo vuelve a desfasar; para
  re-verificarlo, comparar el md5 del cuerpo normalizado contra el de `prosrc`.

### Dashboard de ventas

- **El importador de listas de súper detecta las columnas por ENCABEZADO, con `hoja_cod_col`/`hoja_price_col` como fallback.** Los índices de columna del Excel se corren cuando alguien mete una columna nueva en el medio, y ahí `hoja_price_col` terminaba apuntando a "Costo sin aportes" en vez de a "Lista Vigente" — un re-upload cargaba COSTOS como precios. Verificado 4/8/2026 contra `A_Costos_VIGENTES`: los índices que estaban en la config (col 2 = costo) NO coincidían con lo cargado (col "Lista Vigente"), o sea que los datos vivos se habían cargado desde un layout anterior. Se corrigieron los índices a los verificados y `admin-supercot.js` ahora busca "Cod"/"Lista Vigente"/"Lista a Enviar" por nombre (probado contra las 9 hojas). **La lista de Toledo se cargó ese día** (33 precios, hoja "Toledo Loeke"); dejó de valorizarse con la lista general.
- **`precios_super.cadena.usa_lista_general` separa dos casos que antes se confundían.** Una cadena sin lista propia caía en la lista general EN SILENCIO, y eso mezclaba "está bien así" con "le falta la lista". Decisión del usuario (4/8/2026): **Messina va con lista general** (`true`), **Toledo con lista especial propia** (`false`, todavía sin cargar). `gv_cadenas_sin_lista()` devuelve las que necesitan lista propia y no la tienen, o la tienen sin fecha o con más de 10 meses — hoy son 9 cadenas con **$1.159 M de venta anual** mal o dudosamente valorizada, encabezadas por Coto ($455 M con lista SIN FECHA).
- **LAS LISTAS DE PRECIOS VIVEN EN EL PROYECTO `Costos`** (`fxyhvacysnqzzsdvmplx`),
  en `listas_vigentes` (cliente, cod_art, descripcion, precio, fecha). Son **14
  listas**: `Propio` (la de LK, 197 códigos), Abastecedor, Libertad, Jumbo,
  `Inc s/TTC`, Walmart Chef, `Toledo LK`, Coto, Alberdi, Anónima, Día, Diarco,
  La Luguenze y Gigot. **Verificado: la lista `Propio` coincide exacto con
  `products.list_price` de LK en 15 de 15 códigos** (031 $820, 506 $1.190,
  504 $3.290, 513 $2.375…), o sea que es la misma fuente.
  **Esto resuelve el mapeo cliente→cadena que el CLAUDE.md daba por inexistente**
  y que hacía que el 14,4% de la venta (los supermercados) se valorizara con
  lista general. El nombre de la lista es la cadena.
  **Pero está desactualizada**: las listas son del 26/9/2025 y del 3/10/2025. Los
  artículos que empezaron a venderse el 1/7/2026 no están, y por eso el precio de
  LK de esos 81 códigos **no existe en ninguno de los cuatro proyectos Supabase**
  (se buscó en `loekemeyer's web`, Chef, Costos y Virgilio).
  Otras tablas útiles de ese proyecto: `costos` (cod, familia, `uni_por_caja`,
  desglose de costo por componente), `costos_vivos_diarios` (13.464 filas),
  `renta_lineas` (cod × cliente × mes con `lista_prom`), `importados`,
  `web_products_espejo` (espejo del catálogo web de LK).
- **El repo `paginach` es el portal web de CHEF, y NO tiene precios adentro.** Se
  incorporó a la sesión el 4/9/2026 (`/home/user/paginach`, HEAD `67870b9`). Es el
  gemelo del sitio de LK —mismos `admin.js`, `script.js`, `mayorista.html`, mismos
  módulos— apuntando a **otro** Supabase: `nkhzocgdpwtgrmwleihr` (declarado en
  `config.js` como `LK_CONFIG.SUPABASE_URL`, con la URL/anon key de LK al lado para
  el sync de PIN por CUIT). No hay ni un `.xlsx`, `.csv` ni dump de precios: el
  catálogo entero vive en la base. O sea que **traer el repo no aporta precios** —
  lo que aporta es dejar documentado dónde está cada portal.
  **El acceso programático a los precios de Chef ya existía y no hace falta el repo
  ni la anon key**: LK tiene la foreign table **`chef_ext.products`** por el FDW
  `chef_db` (152 filas, las 152 con `list_price`). El proxy de red del contenedor
  **bloquea `nkhzocgdpwtgrmwleihr.supabase.co`** (CONNECT 403), así que el REST
  directo no es una vía; el FDW sí.
- **Los precios de Chef NO sirven como proxy de los de LK, y está medido.** De los
  **103** códigos que facturaron en 12 meses sin ficha en `v_item_precio`, **81
  tienen precio en `chef_ext.products`** y 22 no. Tentador cargarlos, pero:
  (1) sólo **3 códigos** existen con precio en las dos empresas, muy poco para
  validar, y ni siquiera coinciden (ratio chef/lk 0,74 / 1,11 / 1,11 — el `uxb` sí
  coincide en los 3, así que **el `uxb` de Chef sí es confiable**);
  (2) el contraste contra el despacho de Virgilio, que es independiente, los
  descarta. Agosto 2026: **20.242 cajas (89,7%) con ficha = $522,4 M**, **1.834
  cajas (8,1%) sólo con precio Chef = $48,2 M**, **480 cajas (2,1%) sin nada**.
  Hoy el ERP da 97% del despacho ajustado ($522,4 M contra $538,9 M); cargando los
  precios de Chef pasaría a **$570,6 M = 106%**, o sea que se pasa de largo. El
  faltante real implícito es ~$9.000/caja contra los ~$26.264/caja que valen en
  Chef. **Decisión: no cargarlos.** Falta el precio de LK de verdad.
- **De los 22 sin precio en ningún lado, 9 son variantes de un código base que sí
  tiene precio** y se pueden resolver con una fila en `item_precios` — pero **hay
  que confirmarlas una por una, no derivarlas**: ya se comprobó que `809`/`809E`
  son dos artículos distintos, así que el sufijo no garantiza el mismo producto.
  Con base priceada: `599EZ`→`599E` $2.990, `441Z`→`441` $1.690, `525`→`525E`
  $1.845, `590ES`→`590E` $550, `256zz`→`256` $16.990, `809`→`809E` $4.060 (LK),
  `702EN`→`702E`, `727EN`→`727E`, `865ED`→`865E`, `730D`→`730` (estos cuatro sólo
  con precio de Chef, o sea que arrastran el problema de arriba).
  **Los 12 que no tienen absolutamente nada**, por cajas de 12 meses: `186` (1.426
  cajas, 1 cliente), `198E` (211, 1), `55215` (208, 1), **`029` (177 cajas y 82
  clientes** — el más transversal de todos), `193` (130, 1), `120` (87, 1), `838E`
  (80, 1 — figura en Chef con precio 0, que es lo mismo que nada), `563` (17, 14),
  `030` (6), `228` (3), `657` (3), `877E` (22 cajas, precio 0 en Chef).
- **Ningún código sin ficha puede haber entrado por el portal.** `order_items` se
  ata al catálogo por `product_id` (uuid) contra `products`/`loke_products`, no por
  código de texto, así que un artículo sin ficha es literalmente inseleccionable en
  la web. Por eso `order_items.unit_list_price` no es una vía para recuperar el
  precio de estos 103: no tienen ni una línea ahí. Vinieron todos por el lote
  mensual del ERP.
- **Los SUPERMERCADOS tienen lista de precios propia y el dashboard los valoriza mal.**
  `precios_super.precio` (453 filas, 8 cadenas: abastecedor, alberdi, coto, dia, diarco,
  inc, laanonima, libertad) la usa solo el cotizador, y ahí el súper sale del **nombre de
  la hoja del Excel** — **no hay ningún vínculo `cod_cliente` → `super_key` en la base**, y
  `supermarket_branch_mapping` está vacía. Medido: 8 clientes de súper son el **14,4% de la
  venta** ($750 M de $5.227 M en 12 meses), y la brecha contra la lista general va de
  **75%** (Abastecedor, Alberdi) a **118%** (Carrefour/INC), con Coto en 99%. Para
  arreglarlo hacen falta dos cosas del usuario: el mapeo cliente→cadena, y confirmar qué
  significa `precios_super.precio` (nuestro precio a ellos o el de góndola) — las listas
  tienen fechas de 2021 a 2025 contra una lista general de hoy, así que el 118% de INC
  huele a que no son comparables.
- **No existe historial de precios.** `products.list_price` es un único valor de HOY y
  `order_items.unit_list_price` está cargado en 43 de 13.597 líneas (0,3%). Por eso la
  venta del ERP es **a precios constantes**: las comparaciones interanuales son reales
  (volumen y mix), no nominales. Verificado contra plata real: julio dio $410,7 M
  reconstruido contra $412,8 M facturados en el portal, 0,5% de diferencia. Para tener
  nominal propio habría que empezar a poblar `order_items.unit_list_price`.
- **Las líneas de artículos discontinuados ya NO se descartan** (resuelto el
  4/9/2026 con la migración a `v_item_precio`, que no filtra por `active`). El
  `join products ... and p.active is true` las perdía —0% en 2024, 1,4% en 2025 y
  4,2% en 2026— y como la pérdida crecía, subestimaba el interanual.

- **La PPP en curso se espeja de Virgilio por `postgres_fdw`** (proyecto `hrxfctzncixxqmpfhskv`), calcado del FDW de Chef. LK TIRA con el rol de solo-lectura `lk_ppp_reader` (creado en Virgilio: `SELECT` sobre 4 tablas + una policy propia por tabla, RLS estaba activo). Las foráneas viven en el esquema `virgilio`; `sincronizar_ppp()` las copia a tablas locales `ppp_*` (reemplazo total, la fuente es amnésica) y el cron `sincronizar-ppp-diario` (10:00 UTC) las refresca. **Nunca joinear el FDW en el camino caliente** (lección de Chef). Las tablas `ppp_*` no tienen policy para anon/authenticated; se leen por RPC con chequeo de admin.
- **El string identificador de pedido web viaja AL REVÉS: LK EMPUJA a Virgilio** (2026-08-28). Virgilio no tiene la sucursal de entrega de los pedidos; LK sí (`sheets_payload.sucursal_entrega`). La vista **`v_pedidos_match`** (revocada de anon/authenticated) arma por pedido `match_string = cod_cliente|fecha ART|items` con items = `cod_art`x`cajas` ordenado por código y cajas sumadas por código repetido — sale de `sheets_payload.items`, exactamente lo que viajó al Sheet/ERP. `sync_pedidos_match_virgilio()` (cron `sync-pedidos-match-virgilio`, cada 15 min, ventana móvil de 14 días con delete+insert) la copia a la tabla **`lk_pedidos_match`** de Virgilio escribiendo a través del MISMO FDW/rol `lk_ppp_reader`, que ahora tiene INSERT/UPDATE/DELETE **solo sobre esa tabla** (el resto sigue solo-lectura). Se eligió empujar en vez de que Virgilio tire porque reusa la credencial existente y deja a Virgilio leyendo una tabla local (cero FDW en su camino caliente). `ambiguo=true` marca el único caso que el string no resuelve (mismo cliente, mismo día, mismos ítems, distinta sucursal: 17 de 977 pedidos históricos; los strings repetidos hacia la MISMA sucursal —resubmits— no molestan) y `orden_en_dia` desempata por hora. **Cubre también CHEF** (2026-08-28): sus pedidos web viven en el proyecto Supabase de Chef (portal gemelo, misma `orders`/`sheets_payload`) y LK los lee por el FDW `chef_db` (foreign table `chef_orders` + vista `v_pedidos_match_chef`, cod del payload con fallback a `chef_customers` por `customer_id`) y los reenvía con `empresa='chef'` — la tabla de Virgilio lleva `empresa` en la PK porque numeraciones de cliente y `order_id` chocan entre portales (NP 9xxxx = lk, 4xxxx = chef). ⚠ **Pendiente un grant en el proyecto Chef**: `grant select on public.orders to loke_reader;` — hasta entonces el sync saltea Chef con un NOTICE (visible en los logs del cron) y LK sigue normal; una vez corrido, el próximo cron hace el backfill completo solo. Todo en `sql/pedidos_match_virgilio.sql`; el DDL del lado Virgilio en `sql/lk_pedidos_match.sql` del repo Produccion-Virgilio.
- **El universo "en curso" es `ppp_programacion` (NP 9xxxx = Loekemeyer) MENOS las NP en `ppp_facturacion`.** Da 139 NP, 70,8 m³, $266,5 M neto, 18,8 días de PPP (m³ ÷ despacho de 3,77 m³/día). Verificado contra el traspaso ($261,3 M, dentro del 2%). La valorización (`ppp_valor_linea`) replica el cotizador: súper con lista propia = precio final sin descuento; cliente normal = `list_price × uxb × (1-dto_vol) × 0,98`; artículos contra `products ∪ loke_products`. **NP 9xxxx = Loekemeyer, 4xxxx = Chef** (numeraciones independientes: el mismo cod es otro cliente en cada empresa).
- **La etapa por tanda se agrega EN VIRGILIO, no se espejan los 18k eventos.** La vista `ppp_etapa_tanda` (en Virgilio) colapsa `Registros_Produccion_Virgilio` a 1 fila por tanda con 5 booleanos (`picking_ini`/`picking_fin`/`armado_ini`/`armado_fin`/`carga`, de las opciones EP/TP/AP/TAP/CC). El código de tanda sale del campo `texto`, que tiene formatos mezclados (código limpio, `np|tanda`, `np|x|tanda`); se acota a tandas que existen en `PPP_Programacion_Diaria` para no arrastrar basura. Verificado: 24 tandas con etapa, 0 secuencias imposibles (ninguna carga sin picking). LK espeja el resultado chico a `ppp_etapa` y `gv_ppp_detalle` muestra la etapa más avanzada por NP. El rol `lk_ppp_reader` tiene `SELECT` sobre la vista + `Registros_Produccion_Virgilio`.
- **`ppp_facturacion` no tiene `facturado_at` en el espejo** (no se copió esa columna): `gv_ppp_resumen` usa `max(fecha_salida)` como "última salida".

### Estadística Clientes

### Estadística Clientes

- **El worker de ARCA no existe todavía**: falta decidir n8n vs Edge Function y conseguir
  el certificado X.509. Instructivo completo en `sql/arca_padron.INSTRUCTIVO.md`.
- **Filtro BCRA "Sin dato"**: `error` y `sin_consultar` comparten opción de filtro y son
  cosas distintas (un fallo de red contra algo nunca consultado).
- Evaluar si `v_clientes_arca` debería alimentar el Ranking Inactivos.

### Seguridad

- **`get_customer_sales_history` ya lleva el chequeo de `admins` adentro** (4/9/2026).
  Cualquier `authenticated` podía leer el histórico de compras de otro cliente pasando
  su código: el gate de `analisis-venta-cliente.js` es solo del navegador y no frena una
  llamada directa con la anon key, que es pública. Los tres llamadores legítimos
  (`admin.js`, `analisis-venta-cliente.js`, `carga-pedidos.html`) son pantallas de admin,
  así que no rompió nada. Se le revocó además el `EXECUTE` a `anon`.
- **`sales-agent` (Edge Function) le pasa SQL generado por un LLM a `exec_raw_sql` con el
  cliente `service_role`**, o sea que saltea el revoke de `anon`/`authenticated` hecho el
  31/7. El filtro es un match de texto (`startsWith("SELECT")` y rechaza si aparece
  `UPDATE`/`DELETE`/`INSERT`/`DROP` en cualquier lado): bloquea consultas legítimas que
  mencionen `updated_at` y no frena una construida a propósito. Está detrás del chequeo de
  `admins`, así que el alcance se limita a un admin. Sin revisar en detalle.

### Limpieza

- `sales_lines_chef_backup_20260731` (71.574 filas) se puede borrar cuando se confirme que
  la desduplicación de Chef quedó bien.
- `v_orders_origen` tiene una rama del `CASE` redundante y un `JOIN` que debería ser
  `LEFT JOIN`.
