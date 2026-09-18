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

## ⚠ REGLA: preguntar QUIÉN habla y dejar cada pedido como tarea en su Planify

**Vale para TODOS los repos** (LK, Gestión Virgilio, Planify y cualquiera nuevo: copiar este
bloque al `CLAUDE.md` del repo nuevo). Objetivo del dueño: que ninguna tarea quede a medio
hacer sin figurar en la agenda de alguien.

1. **Al empezar la sesión, preguntar quién está hablando** (antes de hacer nada):
   *"¿Quién sos? (Thomas, Marianela, Luis, Gastón, …)"*. Si el mensaje ya lo dice, no repreguntar.
2. **Cada pedido de trabajo se registra como tarea en el Planify de esa persona**, apenas se
   empieza, con nombre MUY resumido (≤ 60 caracteres). Queda `done=false` hasta que se cierre
   (punto 4). Si la sesión termina sin cerrar, la tarea queda en la agenda: ése es el objetivo.

   **La nota (comentario) lleva SIEMPRE estas tres cosas, en este orden y conciso** (dueño,
   2026-09-11: *"en comentarios tiene que explicar conciso qué es lo que falta y quién le creó
   la tarea y desde qué sesión de Claude"*):
   1. **Qué falta**: qué hay que hacer, concreto y accionable — no el historial de lo ya hecho.
      Si algo ya se hizo, va en una línea aparte al final ("Ya hecho: …").
   2. **Quién la pidió**: el nombre de la persona que lo pidió en el chat (Thomas, Marianela, …).
   3. **De qué sesión salió**: la URL de esta sesión de Claude, para poder ir a leer la charla.

   Formato:
   `Falta: <qué hay que hacer>. Pedido de <Nombre> · cargada por Claude, sesión <url>`

   Ejemplo real: `Falta: cargar el secreto KRIKOS_IMAP_PASS en el Vault de Supabase LK
   (kwkclwhmoygunqmlegrg); sin eso krikos-ingest no lee la casilla y la Bandeja de OC queda
   vacía. Pedido de Thomas · cargada por Claude, sesión https://claude.ai/code/session_XXXX`

   **Al cerrar o actualizar la tarea, la nota se reescribe con lo que quedó pendiente**, no se
   le agrega texto encima: quien la lee tiene que ver de un vistazo qué falta hoy.
3. **Excepción del dueño:** Thomas Loekemeyer NO usa Planify. Sus pedidos se cargan en el
   Planify de **Tomás Beviglia (employee_id 20)** con el nombre antepuesto por **`Th `**
   (ej. `Th Fecha estimada de entrega por zona`).

**Dónde:** proyecto Supabase de Gestión Virgilio `hrxfctzncixxqmpfhskv`, schema `planify`.
Empleados activos con Planify (`planify.employees`): Marianela Becker **38**, Luis Rial Otero
**52**, Gastón Dalponte **61**, Tomás Beviglia **20**, Gonzalez Tomas 16, Elías Irace 1,
Nazareno Rodríguez 27, Angely Asuaje 22, Viviana Gauna 4, Alan Gonzalez 5, Diego Mollo 44,
Nora Heredia 33, Juan Cruz Karaygan 51, Pablo Martos 6, Martín Cornejo 34, Martín Pregelj 15,
Romina Maturano 55, Iván Meta 58, Jhonny Cartaya 46. Si el nombre no está, buscar:
`select id, nombre from planify.employees where activo and nombre ilike '%<apellido>%'`.

```sql
-- alta (al empezar el pedido)
insert into planify.tasks (name, type, prio, time, date, note, rec, done, assignment_type,
  employee_id, department_id, system_generated, broadcast, created_at, updated_at)
values ('<resumen ≤60>', 'tarea', 'normal', '09:00', to_char(now() at time zone
  'America/Argentina/Buenos_Aires', 'YYYY-MM-DD'),
  'Falta: <qué hay que hacer, concreto>. Pedido de <Nombre> · cargada por Claude, sesión
  <url de ESTA sesión>', 'none', false, 'employee', <employee_id>, null, false, false, now(), now())
returning id;
-- cierre (cuando la persona la da por terminada)
update planify.tasks set done = true, updated_at = now() where id = <id>;
```

Avisar en el chat el `id` al crearla y al cerrarla. No crear tareas para preguntas o consultas
que se responden en el momento; sólo para pedidos que implican hacer algo.

4. **Cierre por criterio propio y SIN preguntar** (dueño, 2026-09-11: *"las que ya están
   cerradas, cerradas"*). Claude evalúa **solo** si el objetivo del pedido se cumplió (lo
   entregado funciona, está commiteado/pusheado/aplicado, y no quedó ninguna parte del
   pedido sin hacer). Si se cumplió: `done=true` y lo avisa en el chat. **NO** se pregunta
   "¿falta algo más para dar por cerrada la tarea?" — esa pregunta queda prohibida. Lo que
   se pidió y quedó a medias NO se cierra: queda abierta con la nota actualizada ("queda
   pendiente: …") y en el chat se dice qué falta y por qué. Si después la persona pide algo
   más sobre esa tarea, se reabre (`done=false`) o se crea una nueva.

5. **Alerta de inactividad (1 hora).** Si hay tareas abiertas de esta sesión y pasa una
   hora sin mensajes, Claude escribe: *"Te estoy registrando estas tareas pendientes:
   … ¿Querés continuar alguna o damos por cerrada la charla?"* Cómo: al terminar un turno
   con tareas abiertas, si la sesión tiene `send_later` (Claude Code web/remoto) o
   `ScheduleWakeup`, armar UN recordatorio a 60 min (borrar el anterior si existía); al
   dispararse, si sigue habiendo tareas abiertas, mandar la alerta; si no, no decir nada.
   En una sesión local sin esas herramientas no hay forma de despertarse sola: en ese
   caso, al cerrar cada turno con tareas abiertas, dejar la lista escrita en el chat.

6. **Propagar la regla a todo repo nuevo.** Si en una charla se agrega o se toca por
   primera vez un repo que NO tiene este bloque en su `CLAUDE.md` (se lo trae de referencia,
   se lo crea, o se le hace un cambio), copiarle este bloque entero (creando el `CLAUDE.md`
   si no existe) y commitearlo en ese repo, avisando en el chat. Así el dueño no tiene que
   pedirlo cada vez. Fuente canónica del bloque: `CLAUDE.md` de `loekemeyer/pagina-LK-copia`.


## ⚠⚠⚠ REGLA: TRAER SIEMPRE LA DEFINICIÓN VIVA, Y USAR SIEMPRE LA TABLA VIGENTE

**Luis, 2026-09-17, después de que esto costara 4 tandas con el picking duplicado en Gestión
Virgilio:** *"QUE SIEMPRE TRAIGAN DEFINICIONES VIVAS Y ACTUALIZADAS ASÍ COMO TAMBIÉN QUE USEN LAS
TABLAS VIGENTES."*

**Vale para TODOS los repos** (LK, Chef, Gestión Virgilio, Planify y cualquiera nuevo: copiar
este bloque al `CLAUDE.md` del repo nuevo). Son dos reglas con la misma raíz: **lo que uno tiene
en la cabeza no es lo que está corriendo.**

### 1. Antes de `CREATE OR REPLACE`, traer la definición VIVA

**Nunca** partir de una copia propia, de un archivo `.sql` del repo, ni de lo que se leyó hace un
rato en la misma charla. **Varias sesiones de Claude tocan los mismos objetos al mismo tiempo**, y
un `CREATE OR REPLACE` pisa el cuerpo entero sin decir una palabra. Y los `.sql` del repo **no se
ejecutan solos**: se corren a mano, así que un cambio hecho en el editor de Supabase y no volcado
los deja desfasados. **La base es la fuente de verdad, el archivo es documentación.**

```sql
-- SIEMPRE esto, justo antes de escribir:
select pg_get_functiondef('public.<la funcion>'::regprocedure);
select pg_get_viewdef('public.<la vista>'::regclass, true);
-- y para una vista, ademas, las opciones (o te comes el security_invoker):
select relname, reloptions from pg_class where oid = 'public.<la vista>'::regclass;
```

Se le agrega el cambio **encima de eso**, y recién ahí se escribe. Para comparar un `.sql` del
repo contra lo que corre de verdad, el md5 del cuerpo normalizado:

```sql
select md5(regexp_replace(regexp_replace(regexp_replace(
         prosrc,'/\*.*?\*/','','gs'),'--[^\n]*','','g'),'\s','','g'))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname='public' and p.proname='<la funcion>';
```

**Lo que costó no hacerlo (problema 390, 17/09):** dos sesiones editaron la misma función el mismo
día. La segunda partió de una copia anterior y borró una regla de negocio de la primera sin que
nada avisara. Se duplicó el picking entero de 4 tandas: +287 cajas fantasma y −265 en góndola.

### 2. Y después PROBARLO, no leerlo

Leer la función que uno acaba de escribir no prueba nada: la que corre puede ser otra. Se hace una
escritura de verdad contra la tabla real, se mira el resultado y se borra. El diagnóstico del
problema 390 salió así, en dos líneas, después de un rato largo de leer código sin entender nada.

### 3. La tabla vigente, no la que uno conoce

Antes de escribir una consulta contra una tabla que uno no tocó nunca, **mirar cuándo se escribió
por última vez**. Hay tablas viejas conviviendo con las vivas, con el mismo contenido aparente, y
leer la que no es da respuestas que suenan bien y están mal:

```sql
select c.relname, s.n_tup_ins + s.n_tup_upd escrituras, s.last_autoanalyze
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  left join pg_stat_user_tables s on s.relid = c.oid
 where n.nspname = 'public' and c.relkind = 'r' and c.relname ilike '%<lo que busques>%';
-- y si la tabla tiene columna de fecha, la prueba que vale: select max(<fecha>) from ...
```

En **Gestión Virgilio** eso está resuelto con dos centinelas —`gv_fuentes_lugares` (qué tabla está
viva) y `gv_tablas_viejas_en_uso` (qué objeto sigue leyendo una congelada)— más
`gv_reglas_perdidas`, que avisa si a una función le borraron una regla. Si este repo llega a tener
el mismo problema, se copia ese patrón: una tabla `*_Reglas_Centinela` con
`(objeto, patrón que tiene que estar, regla)` y una vista que lista lo que falta.

## ⚠ REGLA: NO preguntar — razonar primero y resolver

**Dueño (2026-09-11): *"no me tenés que preguntar, tenés que razonar primero"*.** Vale para
TODOS los repos (LK, Chef, Gestión Virgilio, Planify y cualquiera nuevo: copiar este bloque
al `CLAUDE.md` del repo nuevo, igual que el de Planify).

Antes de escribirle una pregunta al dueño, **resolverla**: leer el código, consultar la base,
mirar la doc del repo (`GUIA-PROYECTO.md`, `docs/SUPABASE-GESTION-VIRGILIO.md`, los `CLAUDE.md`),
probar. Preguntar es el último recurso, no el primero.

- **Nunca** preguntar algo averiguable: qué tabla es, qué versión corre, si algo ya está hecho,
  qué significa un dato, si el cron lo pisa. Se averigua y se sigue.
- **Nunca** preguntar "¿lo hago?" / "¿querés que…?" sobre lo que ya pidió. Si el pedido se
  entiende, se hace completo.
- **Dos caminos razonables** → elegir el más seguro y reversible (con backup si toca datos),
  hacerlo, y avisar en UNA línea el criterio usado. No se frena la tarea esperando respuesta.
- **Un pedido ambiguo** se interpreta como lo haría alguien que conoce el negocio, mirando las
  reglas del dueño ya escritas en estos archivos. Si quedan dos lecturas con consecuencias muy
  distintas, se hace la reversible y se avisa cuál se tomó.
- **Sí se pregunta y se espera** sólo en tres casos: (a) la acción es destructiva o irreversible
  sobre datos reales (borrar, pisar, mandar algo afuera: mail, WhatsApp, ISIS); (b) dos reglas
  del dueño se contradicen y hay que elegir; (c) falta un dato que no existe en ningún lado
  porque es una decisión comercial suya (un precio, a quién se le vende, una fecha pactada).
- El cierre de tareas de Planify **no se pregunta**: punto 4 del bloque de arriba.

## ⚠ REGLA: borrar un pedido = borrarlo de TODOS lados (todos los repos/proyectos)

Cuando el usuario pida **borrar un pedido**, borrarlo de **todos los lugares donde ese pedido
interviene**, no de uno solo. Un pedido web vive en varios proyectos a la vez:

1. **Página LK** (`kwkclwhmoygunqmlegrg`, este repo): `orders` + `order_items`.
   (El pedido de Chef vive en el proyecto Chef `nkhzocgdpwtgrmwleihr`, repo `paginach`.)
2. **Gestión Virgilio** (`hrxfctzncixxqmpfhskv`): la NP y la programación. Buscar el `order_id`
   (filtrando `empresa` = `lk`/`chef`) en `PPP_Web_NP`, `PPP_Web_Programacion`, `PPP_Web_Base`,
   `PPP_Web_Tanda_Items`. Si ya está en tanda/picking, avisarlo antes de borrar.

**Backup antes de cada borrado** (protocolo de Supabase). Borrar hijos antes que padres
(`order_items` antes de `orders`). Al terminar, reportar en qué lugares apareció y de cuáles se borró.

## Git: commitear a main por defecto (OBLIGATORIO)

Salvo que el usuario aclare otra branch, **todo commit y push va a `main`**.
No usar branches de trabajo por defecto. `main` es la branch de deploy
(GitHub Pages), así que pushear ahí publica el cambio. Si el usuario pide una
branch puntual, respetarla solo para ese pedido y volver a `main` después.

## Respuestas concisas (OBLIGATORIO)

Por más análisis interno que se haga, la respuesta al usuario tiene que terminar
con un **resumen corto y legible**: pocas líneas, lo esencial y los próximos pasos.
El usuario NO quiere leer todo el proceso de análisis. Si hace falta el detalle
(tablas largas, listados, razonamiento), va aparte o se ofrece; el mensaje default
es breve. Regla: si no se puede leer de un vistazo, es demasiado largo.

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

## Copia del panel admin dentro de Gestión Virgilio

Desde 2026-08-11 existe una **copia del panel admin** dentro del repo
[`loekemeyer/Gestion-Virgilio`](https://github.com/loekemeyer/Gestion-Virgilio),
bajo `/admin/`, servida por GitHub Pages. La copia apunta al **mismo proyecto
Supabase LK** que este repo (`kwkclwhmoygunqmlegrg`) — no hay migración de
datos, es coexistencia.

**El espejo vivía en `Produccion-Virgilio` y se movió a `Gestion-Virgilio` el
2026-09-09.** `Produccion-Virgilio` ya no corre y va a eliminarse: **no
replicar más ahí**, el único espejo vigente es el de `Gestion-Virgilio/admin/`.
Ese repo NO tiene los hooks de versión, así que el bump del `?v=` de los `.js`/
`.css` en las HTML del espejo es **a mano**.

### Consecuencia operativa: cambios en el admin van a DOS repos

**Cualquier cambio a los archivos del panel admin de este repo debe replicarse
al espejo bajo `/admin/` del repo `Gestion-Virgilio`.** Archivos espejados:
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
proyecto Supabase LK (verify_jwt=off, código fuente en el repo `Gestion-Virgilio`
bajo `admin/supabase/admin-login-otp/index.ts`). Al verificar setea password
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
- **Ficha de Cliente (vista 360, `data-page="ficha-cliente"` en el admin).** Buscador + ficha por cliente. Dos RPC en `sql/ficha_cliente.sql`, **ambas con chequeo de `admins` adentro** (son `SECURITY DEFINER`): `buscar_cliente_ficha(p_q)` busca por código / razón social / CUIT / dirección de entrega; `get_ficha_cliente(p_cod)` arma toda la ficha en UN jsonb (datos, direcciones, pedidos del portal mes/trimestre con origen de `v_orders_origen`, facturación y compras por año 2020-hoy, resumen de altas/bajas, y **matriz artículo × mes** — 12 meses en el payload, el frontend muestra 6 y expande con "ver más"). Une **LK + Chef** por CUIT (`chef_padron`) más vínculos manuales (`clientes_lk_ch_links`). **Valoriza en neto con `v_item_precio`** (NO `products` a secas — ver el checklist de reportes: `products` deja ~47% sin precio), `dto_vol` solo LK, `web_order_discount`, filtrando `sales_excluded_items`. El frontend es el módulo `fc*`/`initFichaCliente` al final de `admin.js` + estilos `.fc-*` en `css/admin.css`. **Espejado a `Gestion-Virgilio/admin/`** (mismo proyecto Supabase, las RPC no se replican).
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
- Key RPCs: `submit_order_fast` (order submission), `get_my_assortment_18m`, `get_my_linked_customers`, `has_loke_access`, `get_customer_sales_history`, `sugerencias_cliente`, `novedades_marca`, `get_estadistica_clientes_agg`, `get_ranking_inactivos`, `get_customer_grupos`, `guardar_customer_grupo`, `quitar_de_customer_grupo`, `deshacer_customer_grupo`, `buscar_clientes_para_grupo`, `sugerir_customer_grupos`, `get_clientes_lk_ch`, `codigos_lk_excluidos_por_chef`, `set_lk_ch_excluido`, `reset_lk_ch_excluido`, `vincular_lk_ch`, `desvincular_lk_ch`, `buscar_clientes_lk_ch`, `get_ranking_inactivos_export`, `datos_cliente_empresa`, `refrescar_chef_padron`, `refrescar_lk_ch_excluidos`, `sincronizar_chef`, `buscar_cliente_ficha`, `get_ficha_cliente`, `krikos_inbox_list`, `krikos_inbox_resolver`.
- **Todo Estadística Clientes mide solo Loekemeyer**: tanto `get_ranking_inactivos` como `get_estadistica_clientes_agg` (la tarjeta "Próximos pedidos") filtran `empresa = 'lk'`. Sin ese filtro los 243 códigos que operan únicamente en Chef aparecían como clientes de Loekemeyer —a recuperar en el ranking, o atrasados en próximos pedidos— sin haberle comprado nunca.
- **`p_solo_excluidos = true` ignora la exclusión por Chef.** "Ver ocultos" es la única pantalla desde donde se restaura un cliente escondido a mano; si además estaba excluido por Chef, no aparecía ahí y quedaba inaccesible para siempre. Al pedir los ocultos se está pidiendo explícitamente esa lista, así que la otra exclusión no corresponde.
- **El Ranking Inactivos mide solo Loekemeyer**: toda lectura de `sales_lines` filtra `empresa = 'lk'`. Antes mezclaba y los 243 códigos que operan únicamente en Chef figuraban como clientes a recuperar sin haberle comprado nunca. **No usar un CTE para ese filtro**: se probó (`WITH lk_lines AS (...)`) y como se referencia seis veces Postgres lo materializa — 189k filas y cada join pasa a seq scan, 2.163 ms contra 496 ms con el filtro inline. Hay un índice parcial `sales_lines_lk_cliente_idx ON sales_lines (customer_code) WHERE empresa = 'lk'`.
- **Los archivos de `sql/` estuvieron al día el 31/7/2026, pero el inventario creció.** 14 archivos SQL en `sql/` al 24/8/2026: `arca_padron.sql`, `clientes_lk_ch.sql`, `customer_grupos.sql`, `expo.sql`, `fix_tipos_uuid_tracking_modulos.sql`, `gerente_ventas.sql`, `get_estadistica_clientes_agg.sql`, `get_ranking_inactivos.sql`, `order_items_source.sql`, `precios_super.sql`, `ranking_inactivos_excluidos.sql`, `sales_excluded_items_pseudo_articulos.sql`, `v_orders_origen.sql`, `ficha_cliente.sql`; más `arca_padron.INSTRUCTIVO.md`. **La fuente de verdad sigue siendo la base**: los `.sql` no se ejecutan solos, se corren a mano en el SQL editor, así que un cambio hecho ahí y no volcado los desfasa. Para sacar la definición real: `select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = '<nombre>';`. Para verificar un archivo contra la base, comparar el md5 del cuerpo normalizado (sin comentarios ni espacios) contra `md5(regexp_replace(regexp_replace(regexp_replace(prosrc,'/\*.*?\*/','','gs'),'--[^\n]*','','g'),'\s','','g'))`.
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
- **El bucket `pedidos-pdf` se purga solo a los 30 dias, y depende de un secreto del Vault.**
  El cron 2 `pedidos-pdf-cleanup-30d` (03:00 UTC) llama `limpiar_pedidos_pdf(30, 100)`, que
  borra de a 100 objetos por corrida **por la Storage API** — nunca por SQL: saltear
  `storage.protect_delete` con `set local storage.allow_delete_query` borra la fila del indice
  y **deja el archivo huerfano en S3**, ocupando y sin poder listarlo. La funcion lee la clave
  de `vault.decrypted_secrets` con el nombre **`service_role_key`**; si no esta, **degrada en
  silencio** (`return 0` + `raise notice`) y el cron igual figura `succeeded`. Eso paso: el
  secreto nunca se habia cargado y se acumularon 567 PDFs viejos (264 MB) hasta que lo canto
  `rep_salud()` el 14/09. Hoy el secreto esta cargado con una **`sb_secret_`** (no la legacy:
  la funcion manda `Authorization` **y** `apikey`, ver el punto 3 de la migracion de claves).
  Chequeo: `select * from public.rep_salud();` tiene que dar vacio.
- **Edge Functions en el repo** (bajo `supabase/functions/`):
  - `admin-otp/index.ts` — 2FA via email OTP para login admin PPP.
  - `crear-cliente-auth/index.ts` — **Crea auth users** usando `auth.admin.createUser` para bypassear la validación de dominio de Supabase sobre el email sintético `<cuit>@cuit.loekemeyer`. Lo llaman `script.js` y `admin.js`.
- **Edge Functions externas** (no están en este repo, viven en Supabase directamente): `sheets-proxy` y `sheets-entregas-proxy` (push de pedidos confirmados a Google Sheets, llamadas vía `fetch`). `orders.sheets_payload` / `orders.sheets_sent` se escriben después de un push exitoso. También `sales-agent` (SQL generado por LLM, ver Pendientes → Seguridad).
- Product images are served via Supabase public storage: `{SUPABASE_URL}/storage/v1/object/public/products-images/{cod}.webp`. The `BASE_IMG`/`IMG_PARAMS` pair is redeclared in `script.js`, `historial.js`, `sugerencias.js` and `admin.js`; keep them in sync. **Do not use** `/storage/v1/render/image/public/` — the image-transformations feature is disabled on this Supabase tenant (returns 403 "FeatureNotEnabled"). Photos are stored pre-rendered at 400x400 WebP, so `IMG_PARAMS` is an empty string.
- `app_settings.web_order_discount` is read at load time as the web-order discount (fallback `0.02`).
- **Los módulos de estadística valorizan en NETO, no a precio de lista.** `get_ranking_inactivos` y `get_ranking_inactivos_export` hacen `boxes * products.uxb * products.list_price * (1 - customers.dto_vol) * (1 - app_settings.web_order_discount)`. **`list_price` es el precio POR UNIDAD, no por caja**, así que el `uxb` NO es opcional: sin él el monto sale dividido por las unidades por caja (promedio 12,1, rango 1 a 100). Es el mismo cálculo que hace el carrito en `script.js` (`listUnit * (uxb * cajas)`) — la misma cadena multiplicativa que arma un pedido real en `script.js` (`listUnit * (1 - dtoVol) * (1 - webDiscountRate) * (1 - extraRate)`). El descuento por medio de pago queda afuera: depende de cómo se pagó cada pedido y `sales_lines` no lo guarda. Las dos RPC tienen que usar el MISMO factor: una alimenta la tabla en pantalla y la otra el Excel descargable del mismo módulo, así que si divergen muestran números distintos para el mismo cliente.

## Integración Krikos (OC de supermercados por mail)

- **Krikos360 es el portal EDI de Planexware** por el que las cadenas (Coto, Carrefour/INC, Día,
  Diarco, La Anónima, Cencosud, Dorinka, Libertad, Alberdi, Abastecedor, Toledo, Messina) mandan
  sus órdenes de compra. **No tiene API pública**; la integración formal es el servicio pago
  "Servicios EDI" (SFTP/webservice/AS2, a cotizar con comercial@planexware.com — consulta enviada
  el 3/9/2026, sin respuesta todavía). Se optó por la vía gratis: el mail.
- **Cada OC llega a `ventas@loekemeyer.com` como mail de `noreply@planexware.com`** con asunto
  "Notificación de recepción de Orden de Compra". El cuerpo trae Emisor (cadena + GLN + sucursal
  + GLN + dirección), N° de Documento y fechas de emisión/entrega/cancelación, y **un link
  firmado** `krikos360.planexware.net/Documentos/api/documento?token=<JWT>` que **devuelve el PDF
  sin login** (verificado desde una Edge Function: `application/pdf`, 181 KB). El `id` del payload
  del JWT es el `doc_id`, clave de deduplicación. **Los parsers de `admin-supercot.js` ya eran de
  Krikos**: detectan `OrdCotoPlx`, `OrdIncPlx`, `OrdJumboPlx`… ("Plx" = Planexware). Lo único
  que faltaba era el transporte.
- **⚠ LOS MAILS NO ESTÁN EN LA BANDEJA DE ENTRADA.** Entran a INBOX y ahí nomás los ARCHIVAN a
  mano en **`Inbox/1 Pedidos pendientes a pasar ISIS/Pedidos Super`** (1.284 mails; ojo que el
  padre es `Inbox`, no `INBOX`, y el separador es `/`). Mirando sólo INBOX la bandeja quedaba
  vacía para siempre: el 11/9/2026 había 0 mails de Planexware en INBOX y 10 en esa carpeta.
  Por eso la función recorre una LISTA de carpetas, configurable sin tocar código:
  `select vault.create_secret('INBOX,Inbox/1 Pedidos pendientes a pasar ISIS/Pedidos Super', 'KRIKOS_MAILBOXES');`
  (default `INBOX`). Para encontrar el nombre exacto de una carpeta sin abrir el correo:
  `{"action":"list_folders"}` lista todas con cuántos mails de Krikos tiene cada una. El
  `doc_id` evita que una OC entre dos veces si aparece en dos carpetas.
- **El link del mail VENCE.** Al procesar 45 días de historia el 11/9/2026, las 3 OC de Coto más
  viejas (entrega 28/07, 03/08, 18/08) devolvieron `text/html` de 9.845 bytes en vez del PDF y
  quedaron en `estado = 'error'`; las 7 recientes bajaron bien (146-181 kB). No es un bug: en
  régimen el cron procesa el mail del día. Sólo aparece si se pide una ventana larga hacia atrás.
- **⚠ El ingest busca por REMITENTE, así que también entran los mails de SERVICIO de Krikos360**
  (recupero de contraseña, alta de usuario). Hasta el 16/9/2026 quedaban como `estado = 'error'`
  con todos los campos en null, y `sync_krikos_oc_virgilio` los empujaba a la PPP de Gestión: el
  15/09 dos de esos mails salieron en "A Programar" como *"2 órdenes de compra de súper NO se pudo
  importar"*, con la fila vacía y sin nada que resolver. Ahora `krikos-ingest` los anota como
  **`estado = 'ignorado'`** (se anotan igual, para no volver a bajarlos cada 10 min, pero ese
  estado no viaja a Virgilio). **La condición NO es "no trae link"**: ese caso tapa dos cosas
  distintas, y la otra es una OC de verdad cuyo link no matcheó `LINK_RE` — si Planexware cambia
  el host o el formato del token caen TODAS, y mandarlas a `ignorado` sería tirar órdenes de
  compra reales en silencio. Se mira el mail (`pareceOc`): asunto con "orden de compra", o cuerpo
  con los campos que sólo trae una OC (Nº de Documento, Emisor … Receptor). **Parece OC y no hay
  link → sigue en `error`, visible en la PPP.** Problema 362.
- **Flujo**: cron `krikos-ingest-10min` (pg_cron, `*/10`) → `net.http_post` a la Edge Function
  **`krikos-ingest`** (header `x-krikos-secret`) → IMAP a la casilla → por cada mail nuevo baja el
  PDF al bucket privado **`krikos-oc`** (`<año>/<doc_id>.pdf`) e inserta en **`krikos_oc_inbox`**
  (`estado = 'pendiente'`) → el panel admin (PDF Krikos → **"Bandeja Krikos"**, arriba del grid de
  cards) lista con `krikos_inbox_list` y "Abrir en card" baja el PDF y lo mete en la primera card
  vacía por `handleFile`, o sea el mismo parser/match/submit de siempre; al subir el pedido la card
  llama `krikos_inbox_resolver(id, 'cargado', order_id)`. Descartar/restaurar también van por esa
  RPC. Todo en `sql/krikos_oc_inbox.sql` y `supabase/functions/krikos-ingest/index.ts`.
- **La casilla es SmarterMail, IMAP4rev1 en el puerto 143 SIN TLS** (el 993 está cerrado; probado
  desde la Edge Function el 3/9/2026 — desde una sesión de Claude no se puede, la red bloquea todo
  lo que no sea HTTPS). No anuncia STARTTLS pero sí **`AUTH=CRAM-MD5`**, así que la Edge Function
  autentica con HMAC-MD5 (`node:crypto`) y **la contraseña nunca viaja en claro**; el contenido
  del mail sí. **DECIDIDO y cerrado (Luis, 16/09/2026): NO se le pide al hosting que habilite el
  993.** Lo que viaja son órdenes de compra de supermercados, no datos sensibles, y hace meses que
  funciona así. **No volver a proponerlo.** (Si algún día se habilita, el cambio es de dos
  secretos: `KRIKOS_IMAP_TLS=true` y `KRIKOS_IMAP_PORT=993`, más pasar Thunderbird a SSL/TLS 993.)
  El cliente IMAP está escrito a mano sobre `Deno.connect` (no hay
  librería): `EXAMINE` (solo lectura) + `UID SEARCH FROM … SINCE …` + `UID FETCH … BODY.PEEK[]`,
  así **nunca marca leído ni mueve nada** y Thunderbird ve la casilla igual. Dedupe por
  `mail_uid = <UIDVALIDITY>:<UID>` y por `doc_id`.
- **Secretos de la Edge Function**: `KRIKOS_INGEST_SECRET` (el mismo valor va en el header del
  cron — está en `select command from cron.job where jobname = 'krikos-ingest-10min'`),
  `KRIKOS_IMAP_PASS`, y opcionales `KRIKOS_IMAP_HOST/PORT/TLS/USER`, `KRIKOS_SENDER`,
  `KRIKOS_MAILBOXES`. La función
  los lee primero del env (Supabase → Edge Functions → Secrets) y, si no están, **del Vault de
  Postgres** vía `krikos_secret(p_name)` (solo `service_role`): se cargan con
  `select vault.create_secret('<valor>', 'KRIKOS_IMAP_PASS');` desde el SQL editor, sin pasar
  por el dashboard. `KRIKOS_INGEST_SECRET` ya está en el Vault desde el 4/9/2026. NUNCA en el
  repo, que es público. Sin `KRIKOS_INGEST_SECRET` la función responde 503 y el cron no hace nada. Para probar credenciales sin escribir:
  `{"action":"test_imap"}`; para ver qué haría: `{"action":"sync","dry_run":true}`.
- **La FECHA DE ENTREGA que exige el súper se parsea aparte del vencimiento.** En
  `admin-supercot.js` `dueDate` es el VENCIMIENTO (cuándo cobrar: "Fecha Tope", "Vto", o
  entrega + N días "(aprox)") y **`deliveryDate` es la ENTREGA** (cuándo hay que estar en el
  depósito). Prioridad: `fecha_entrega` del mail de Krikos (viene estructurada, con hora a veces,
  en las 4 cadenas verificadas) > lo que saca el parser de la cadena (Día, Diarco, La Anónima,
  Alberdi, Abastecedor "Fecha Prometida", Messina) > `findDeliveryDateGeneric_` (label "Fecha de
  Entrega/Prometida/Recepción" inline o fecha cercana). La card la muestra como "F. ENTREGA" con
  el origen (Krikos/PDF) y viaja en `sheets_payload.fecha_entrega` (+ `fecha_entrega_origen`) y
  en el payload de Entregas. **El Apps Script del Sheet y el Excel del ERP todavía no tienen
  columna para esto**: queda persistido en `orders.sheets_payload` y en `krikos_oc_inbox`.
  **Desde el 7/9/2026 además viaja a Virgilio**: `v_pedidos_match` expone `fecha_entrega_txt`
  (el texto crudo) y `fecha_entrega` (parseada: primera `dd/mm/yyyy` del texto, separador
  normalizado, así que "15.09.2026 08:00" también entra) y `sync_pedidos_match_virgilio()` las
  copia a `lk_pedidos_match` por el FDW. Chef va `NULL` (su portal no carga OC de súper).
  `sql/pedidos_match_fecha_entrega.sql`, backup en `sql/backups/`.
- **⚠ Y ese texto NO SE CASTEA CON `::date` — el 16/09/2026 apagó el armado automático de Gestión
  por 2 horas.** `sheets_payload->>'fecha_entrega'` es TEXTO del proveedor: la OC del pedido 1468
  (INC, Krikos) trajo **`"29/09/2026 14:00"`** y los tres feeds que consume Gestión
  (`gv_pedidos_web_np_lk`, `gv_pedidos_web_np_chef`, `_chef_fdw`) lo casteaban directo →
  `22008 date/time field value out of range`. La RPC entera devuelve 400, así que **un solo
  pedido con turno dejó al cron de Gestión leyendo 0 NP de LK durante 24 corridas seguidas** (de
  las 13:55 a las 15:50; ningún pedido web de LK se programó solo). Desde la v19.11 el parseo vive
  en **`gv_fe_pactada_fecha(text)`** y **`gv_fe_pactada_hora(text)`** (`immutable`, mismo criterio
  que `v_pedidos_match`): lo que no entienden devuelve NULL, nunca un error. Y el turno ya se VE:
  **`v_pedidos_web_np` publica `fecha_entrega_txt`, `fecha_entrega_pactada` y
  `hora_entrega_pactada`** (las 3 al final, y la vista conserva `security_invoker`), que es de
  donde las lee el badge del reloj de "A Programar" de Gestión. **Regla: ninguna fecha que venga
  de `sheets_payload` se castea directo.** SQL, medición y rollback:
  `sql/gv_turno_entrega_oc_v1911.sql` del repo `Gestion-Virgilio` (+ §3.in de su doc de Supabase).
  Problema 357.
- `krikos_inbox_list` y `krikos_inbox_resolver` son `SECURITY DEFINER` con chequeo de `admins`
  adentro y `EXECUTE` revocado a `PUBLIC`/`anon`. La tabla tiene RLS de solo lectura para admins
  (escribe únicamente `service_role`) y el bucket es privado con policy de lectura para admins.

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
| `consulta.html` | `consulta.js` + `css/consulta.css` | **Consulta de clientes**: login propio con CUIT+clave (tabla `consulta_usuarios`), solo lectura. Se elige un cliente y aparecen dos botones: qué compra y qué NO compra y debería. RPC en `sql/consulta_clientes.sql`. |
| `expo-qr-test.html` | `jsqr.js` | Página de prueba del escáner QR para el modo expo (ferias). |

## Módulo Consulta de clientes (`consulta.html`)

Pantalla de **solo lectura** para un empleado que no es admin ni cliente (el primero es
**Poli**). Entra con **CUIT + clave** por el mismo esquema sintético `<dígitos>@cuit.loekemeyer`
del resto del sitio, elige un cliente por razón social / CUIT / código, y recién ahí aparecen
**dos botones**: *Artículos que compra* y *Artículos que NO compra*. No hay carrito, ni alta de
pedidos, ni padrón editable.

- **Quién entra lo decide `consulta_usuarios`** (no `admins`): una fila por persona, con
  `activo` para dar de baja sin borrar. Los admins también pasan el guard, para poder probarlo.
- **Cinco RPC en `sql/consulta_clientes.sql`**, todas `SECURITY DEFINER` con el guard adentro Y
  `EXECUTE` revocado a `PUBLIC`/`anon`. El guard va con un `IF` de plpgsql y **no** colgado del
  `FROM` de una función SQL (Postgres elimina la subconsulta y el guard no se evalúa — el mismo
  pozo de `gv_es_admin`). Medidas: buscar 16 ms, historial 9 ms, faltantes 158 ms.
- **"No compra y debería" = penetración**: sobre los clientes de Loekemeyer que compraron algo
  en los últimos 12 meses (sin las cadenas de súper, que sacan de `precios_super.cadena`), qué %
  compra ese artículo. Mismo criterio que `sugerencias_cliente` pero con ventana de 12 meses en
  vez de 6, sin tope de 30 filas, y devolviendo además **lo que el cliente compraba antes y
  dejó** (`ultima_compra` / `cajas_hist`), que es la fila que se usa para vender.
- ⚠ **"Última compra" NO es `max(invoice_date)`.** `sales_lines` tiene **390 líneas de lk con
  `boxes = 0`** (en 40 clientes) y **6.611 negativas**: con el max pelado, Relca (2444) figuraba
  comprando el 510 el 31/01/2026 cuando su última compra real fue el 31/07/2025 — lo del medio
  son ceros mensuales. Las tres RPC usan `max(invoice_date) FILTER (WHERE boxes > 0)`. Vale para
  cualquier reporte nuevo que calcule fechas de compra.
- **Espejado en Chef** (`paginach`, `consulta.html` + `sql/consulta_clientes.sql`). La versión de
  Chef es **autocontenida**: esa base no tiene `v_item_precio`, `item_precios`,
  `sales_excluded_items`, `ficha_norm` ni `precios_super`, así que valoriza con `products` y trae
  su propia `consulta_norm()`. Al tocar uno, mirar el otro.
- **No va en `sitemap.xml`** (está detrás de login) y lleva `<meta name="robots" content="noindex,nofollow">`.

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
- ⚠ **Deploy: son DOS sitios, y al que usan los clientes NO llega con el push.**

  > **Nombre para el equipo: "CPanel".** El servidor de producción `www.loekemeyer.com`
  > —que en este archivo aparece históricamente como **IIS / panel SolidCP**— el equipo lo
  > llama **CPanel** (pedido de Yanina, 17/09/2026). Es lo mismo: cuando alguien dice "subir
  > a CPanel" / "publicar en CPanel" se refiere a este server de producción. En el chat con
  > el equipo, decirle **CPanel**. (Aclaración técnica, por si algún día se toca el hosting
  > real: el server es **IIS** y el panel es **SolidCP**, NO el producto cPanel de otros
  > hostings — distinto software con el mismo nombre coloquial.)

  | Sitio | Quién entra | Cómo se despliega |
  |---|---|---|
  | **`www.loekemeyer.com`** (CPanel — IIS / panel SolidCP) | **los clientes — es producción** | **a mano por SolidCP** (`/publicar-sitio` arma el `.zip`; `scripts\deploy-iis.ps1` si hay FTP) |
  | `loekemeyer.github.io` (GitHub Pages) | desarrollo / revisión | solo, con cada push a `main` |

  **Pushear a `main` NO llega a los clientes.** Hasta el 14/09 este archivo decía que el sitio "se
  despliega SOLO con el push" y que el IIS era "aparte y ocasional". Es al revés, y salió caro: ese
  día se corrigió el bug que dejaba los pedidos web sin `sheets_payload`, se pusheó, el workflow de
  Pages dio verde — y se dio por publicado. Los clientes seguían con la v2.3.388 y **seguían
  entrando pedidos rotos**. Lo delató el pie de la página: decía 388 con el repo en 389.

  ⚠⚠ **EL DEPLOY NO ES AUTOMÁTICO: las páginas se suben A MANO por SolidCP** (Luis, 2026-09-17).
  Este párrafo decía desde el 14/09 que el workflow `.github/workflows/deploy-iis.yml` publicaba
  solo, y **nunca publicó una sola vez**: los secrets `FTP_HOST` / `FTP_USER` / `FTP_PASS` no están
  cargados, así que **todas** las corridas que tocan archivos mueren con *"Falta el secret
  FTP_HOST"* (runs 57 y 59, entre otras); sólo salen en verde las de commits que no suben nada.
  Hoy el canal real es **SolidCP, a mano**, así que **pushear a `main` NO llega a los clientes** y
  el workflow en rojo **no es una alarma nueva: es el estado normal**. Problema 396.

  ⚠ **El workflow NO se borra** (Luis, 17/09/2026: *"no la borres, es un proyecto pendiente"*).
  Automatizar el deploy sigue siendo la intención; lo que falta es cargar los tres secrets. Hasta
  entonces convive en rojo a propósito: **no interpretarlo como CI rota ni proponer borrarlo.**

  **La única prueba de que un cambio llegó es el número del pie de `www.loekemeyer.com`.** Que el
  run de Pages esté en verde no alcanza, y que el de IIS esté en rojo no significa que algo se
  rompió. Para armar el paquete: la skill **`/publicar-sitio`**, que deja un `.zip` con SÓLO lo que
  cambió desde la versión que hoy está en el aire (el File Manager de SolidCP no acepta los ~31 MB
  del sitio entero). `chefsrl.com` es igual y ni siquiera tiene workflow.

  Se sube, **nunca se borra nada del servidor**, así que el `web.config` —que sólo existe allá— no
  se toca. Ojo con el espejo (`robocopy /MIR`, `rsync --delete`): lo borraría.

  **A mano, si hace falta** (el workflow caído, o para recuperarse):

  ```powershell
  .\scripts\deploy-iis.ps1 -Simular     # qué subiría (delta contra lo que hay publicado)
  .\scripts\deploy-iis.ps1 -Mode Ftp    # lo sube
  ```

  El script saca el delta leyendo `https://www.loekemeyer.com/version.js`, así que **el número del
  pie de la página es la única prueba de que un cambio llegó a los clientes**. Antes de decir que
  algo está publicado, comprobalo ahí: que el run de Pages esté en verde no alcanza. Necesita
  `scripts\deploy-iis.local.json` con las credenciales FTP (fuera del repo).
  - Para ver el estado de la última corrida de Pages: Actions → *pages build and deployment*, o
    `mcp__github__actions_list` con `method: list_workflow_runs`. Eso prueba que se publicó en
    Pages, **no** que llegó a `loekemeyer.com`.
  - Ojo con el espejo (`robocopy /MIR`, `rsync --delete`): borraría el `web.config` del servidor,
    que es el único que existe. El script ya lo excluye a propósito.
  - `loeke.zip` en el repo es un bundle de despliegue viejo; no editar.
  - **Para publicar en el IIS desde cualquier chat: pedirlo, o invocar la skill
    `/publicar-sitio`** (`.claude/skills/publicar-sitio/SKILL.md`). Arma un `.zip` con
    SOLO los archivos que cambiaron desde la version que hoy esta en el aire — unos
    cientos de KB contra los ~31 MB del sitio entero, que el File Manager de SolidCP no
    acepta — y lo entrega por el chat. Excluye `web.config`, `sql/`, `docs/`,
    `supabase/`, `.claude/` y los `.md`. La version publicada hay que PREGUNTARSELA al
    usuario: el proxy de las sesiones remotas bloquea estos dominios, asi que no se puede
    leer desde el chat. **No es exclusiva de LK**: el dominio sale de
    `scripts/deploy-sitio.json`, asi que la skill y `deploy-iis.ps1` se copian tal cual a
    `paginach` (chefsrl.com) o a cualquier otro sitio estatico del mismo hosting — la
    seccion "Llevarlo a otro repo" del SKILL.md tiene los tres pasos.
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

## Páginas públicas de posicionamiento (SEO / Google Ads) — BORRADOR sin linkear

**Descartada el mismo día, a pedido de Tomás, la landing `comprar-por-mayor.html` para comercios nuevos: el alta de clientes se maneja por otro canal.** Si el deploy ya la subió al IIS, hay que borrarla a mano desde SolidCP (el workflow nunca borra).

Creadas el 15/09/2026 para el objetivo "aparecer en Google cuando buscan utensilios" y para la
pauta de Google Ads. **Están en el servidor pero NO linkeadas desde la home ni desde `mayorista.html`,
NO están en `sitemap.xml` y llevan `<meta name="robots" content="noindex">`** hasta que Tomás/Thomas
las aprueben. No muestran precios.

| Página | Qué es | Origen del contenido |
|---|---|---|
| `historia.html` | Nuestra historia: línea de tiempo 1950→hoy, los 5 modelos industriales del INPI (12433/1969, 18279/1971, 27925/1975, 29777/1976, 66602/1999, todos vencidos: se muestran como registros históricos), marca, garantía, INAL/ADIMRA, historia del abrelatas. Tiene un comentario `QUIENES-SOMOS-2018` donde va el texto del sitio viejo cuando lo pasen. | Capturas del INPI + mails |
| `productos/index.html` + `productos/<slug>.html` (19) | Catálogo público estático sin precios, una página por línea, fotos del bucket `products-images`. **Generado**: no editar a mano. | `scripts/generar-catalogo.py` + `scripts/catalogo-data.json` |
| `css/publico.css` | Estilos propios de estas páginas (complementa `styles.index.css` y `productos.css`). | |
| `js/conversiones.js` | Google Tag + conversiones (WhatsApp, PDF, formulario, mail). **Inactivo hasta pegar el `AW-…`** en `LK_ADS_ID`. | |

- **Regenerar el catálogo**, todo desde Supabase:
  ```
  python3 scripts/exportar-catalogo.py --verificar   # no escribe: dice qué cambiaría
  python3 scripts/exportar-catalogo.py --generar     # reescribe el JSON y las 20 páginas
  ```
  `exportar-catalogo.py` lee `public.products` con **`active = true`**, así que un artículo puesto en
  FALSE desaparece del catálogo en la siguiente exportación. Un artículo nuevo o una línea nueva
  entran solos. Al 17/09/2026 hay 199 activos y 67 inactivos.
  El workflow `.github/workflows/catalogo.yml` hace las dos cosas y commitea si algo cambió;
  **hoy sólo se dispara a mano** (Actions → Run workflow). El cron diario está escrito y comentado.
- **Lo único escrito a mano** de cada línea son cuatro campos del JSON: `nombre` (el título público),
  `slug` (la URL), `intro` (qué hay en la línea) y `cierre` (el dato propio de esa línea). El
  exportador los CONSERVA buscándolos por el nombre de categoría de la base. Si aparece una categoría
  nueva los deja vacíos y **avisa fuerte**, porque esa página sale sin texto propio.
- **La bajada de cada línea tiene tres partes** (`bajada()` en el generador): `intro` + un tramo
  derivado de los datos (`"9 artículos. Caja cerrada de 6 o 12 unidades."`) + `cierre`. Antes las 19
  páginas cerraban con la misma frase —"Fabricantes desde 1950; venta mayorista por caja cerrada a
  comercios de todo el país"—, que además de sonar a plantilla Google la lee como contenido duplicado
  entre páginas del mismo sitio. Verificado: **cero frases repetidas entre las 19**.
- **El `?v=` de las fotos sale de `generado`**: si alguien reemplaza una foto en el bucket con el
  mismo nombre, la próxima exportación cambia el parámetro y el navegador no sirve la vieja de cache.
- **Se publica en `/productos/`, no en `/catalogo/`**: el 16/09/2026 se verificó que `/productos/` NO
  existe en el IIS y que el botón "VER PRODUCTOS ONLINE" (`index.html:124`) y el link "Productos" del
  pie (`index.html:829`) daban error desde hacía tiempo. Este catálogo ocupa esa carpeta y arregla los
  dos links sin tocar la home. Las URLs del sitio viejo (`abrelatas.htm`, `coladores.html`,
  `quienes_somos.html`…) siguen indexadas en Google pero ya no responden: si alguna vale la pena, se
  reemplaza con una página nueva del mismo nombre.
- **Para publicar**: `NOINDEX = False` en el generador y quitar la meta `robots` de `historia.html`; agregar todas al `sitemap.xml`; linkear desde la home (nav, footer y el botón
  "Ver productos online", que ya apunta a `/productos/` y empieza a funcionar solo).
- El sufijo `E` en el código de artículo marca importado (`importado: true` en el JSON). Es dato
  interno: **el texto público NO dice que importamos** (instrucción de Tomás, 16/09/2026). Se sacó la
  frase "completamos la línea con productos importados seleccionados" de `productos/index.html`, del
  template de `scripts/generar-catalogo.py` y de dos lugares de `historia.html`. El badge visible
  sigue siendo sólo `NUEVO`.

### El ancho de `historia.html` (rediseño del 16/09/2026)

Hasta la v2.3.406 cada sección era un `.container` de 1200 px con un párrafo de 62-72ch adentro: el
texto quedaba pegado al borde izquierdo y sobraban ~480 px de blanco a la derecha en toda la página.
Ahora manda **`.pub-wrap`: un solo bloque de 960 px centrado**, y todo —título, texto, tabla,
tarjetas, dibujos— arranca y termina en el mismo borde. No conviven dos anchos distintos, que era lo
que producía el escalonado. Lo único que no llega al borde derecho son los párrafos (`max-width:70ch`):
eso es medida de lectura, no hueco.

Reglas que quedaron fijadas en `css/publico.css`:

- **Las figuras de una misma fila llevan todas la misma altura** (`height` fijo + `width:auto` +
  `object-fit:contain`): 380 px los dibujos de patentes, 150 px las láminas del INPI. Con `width:100%`
  los epígrafes quedaban escalonados. Pedido de Tomás, 16/09/2026.
- La tabla va con `width:auto`: la manda el contenido de las celdas, nunca estirada.
- Cuando hay un solo dibujo (`.pub-figuras--una`), el epígrafe va **al costado**, no abajo.

### PENDIENTE: pulir la línea de tiempo con material de archivo (pedido de Tomás, 17/09/2026)

La línea de tiempo hoy son siete hitos de texto verificados. Falta el trabajo que la convierte en
una historia: **imágenes de archivo reales de cada época** que acompañen la narrativa, y **una foto
del equipo actual al cierre**, para humanizar la marca.

Qué hace falta y quién lo trae:

| Qué | Para qué hito | Quién |
|---|---|---|
| Fotos de la planta o de la familia, años 50-60 | 1950, fundación | Tomás / archivo familiar |
| Catálogos, folletos o listas de precios viejos | 1969-1999, los modelos del INPI | Tomás / archivo |
| Foto de un abrelatas a manija con la leyenda "Patente N° 129.035" | El abrelatas | Tomás |
| Foto del equipo actual en Cervantes 2868 | Cierre, "Hoy" | Tomás |

**Claude no puede conseguirlas solo:** el proxy de la sesión bloquea `web.archive.org`, el portal del
INPI y Mercado Libre, y no corresponde poner fotos de archivo genéricas de internet como si fueran de
la empresa. Cuando Tomás las mande (adjuntas o por Drive), van a `img/historia/archivo/` con nombre
descriptivo, y se integran en `.pub-timeline` con la misma regla de altura pareja que el resto de las
figuras de la página.

Junto con eso queda el texto **QUIENES-SOMOS-2018** (marcador en `historia.html`, línea ~88): el
contenido de `web.archive.org/web/20180919231226/http://www.loekemeyer.com/productos/quienes_somos.html`,
que Tomás tiene que copiar y pegar porque el proxy no llega a archive.org.

### `productos/`: LISTA en el índice, MOSAICO adentro de cada línea (17/09/2026)

Dos formatos distintos a propósito, y el criterio es **qué identifica en cada pantalla**:

| Página | Formato | Columnas / ficha | Por qué |
|---|---|---|---|
| `productos/index.html` | **Mosaico de línea** (`.cat-grid` / `.cat-mosaico`) | hasta 4 fotos de la línea en 2×2, con "+N" en la cuarta · nombre · N artículos | Una sola foto no representaba a la línea: el primer pelador no habla por los nueve. Cuatro sí son una muestra, y el "+N" dice cuántos faltan. Idea de Tomás, al estilo de WhatsApp. |
| `productos/<línea>.html` | **Mosaico** (`.prod-grid` / `.prod-card`) | código · nombre · u. por caja · "Consultar disponibilidad" | Adentro de una línea la foto sí es distinta artículo por artículo, y el comercio reconoce el modelo mirándola. |

En los dos casos, **sin cromo de tienda**: no hay borde, radio, sombra, caja gris detrás de la foto ni
botón rojo. Esta página no tiene precio, ni carrito, ni checkout; el modelo es el catálogo impreso.
El **código va arriba del nombre**, en versalita roja, porque es lo que el comercio escribe en el
pedido. "NUEVO" es una marca amarilla al lado del código, no una pastilla sobre la foto. El link dice
"Consultar" en gris.

**Grilla de tres columnas y no cuatro**, medido sobre las 19 líneas reales: con tres quedan 14 huecos
en las últimas filas de todo el catálogo, con cuatro 25.

El mosaico de línea reparte según cuántos artículos tenga: 1 foto ocupa el cuadro entero, 2 van lado
a lado, 3 es una grande a la izquierda y dos apiladas, y de 4 en adelante es 2×2 con el "+N" encima
de la cuarta (`.cat-mosaico--1` a `--4`). El "+N" cuenta **N − 3**: Abrelatas tiene 9 y muestra "+6".

⚠ **No declarar dos veces el mismo selector en este archivo.** Hubo tres bugs seguidos el 17/09/2026
por reglas duplicadas donde la segunda pisaba a la primera (`margin-top: auto` de `.prod-cta`, el
bloque muerto del mosaico, y una regla responsive de la lista). Si dos formatos comparten una clase,
lo común se declara una vez y las diferencias se califican (`.prod-card .prod-cta`).

**`productos/*.html` NO se edita a mano**: se cambia `scripts/generar-catalogo.py` y se corre
`python3 scripts/generar-catalogo.py`.

⚠ **`css/productos.css` y `css/publico.css` los cargan SÓLO `historia.html` y `productos/*.html`.**
Verificado el 17/09/2026. Ninguna otra página del sitio los lee.

### Jerarquía de `historia.html` (17/09/2026)

Tres niveles, no siete secciones del mismo peso: `.pub-section--clave` (H2 de 36 px) para el diseño
propio y cómo trabajamos, `.pub-section` (29 px) para la empresa, y `.pub-section--relato` (H3 de
19 px, cuerpo 16 px, dibujos de 270 px) para las tres historias de los inventos, que hablan de Warner,
Lyman, Neweczerzal y Rosati, no de Loekemeyer. Dentro de cada sección: `.pub-kicker` (volanta),
`.pub-bajada` (19 px) y `.pub-destacado`.

⚠ **Cuidado con la especificidad en `publico.css`.** `.pub-section p` es (0,1,1) y le gana a
`.pub-note`, `.pub-kicker`, `.pub-bajada` y `.pub-destacado`, que son (0,1,0) y se aplican a `<p>`.
Por eso están escritos como `.pub-section p.pub-note, .pub-note { … }`. Si se agrega otra clase de
párrafo a estas páginas, hay que calificarla igual o sale en 17 px.

### Láminas del INPI — ya están en `img/historia/inpi/`

Los cinco dibujos depositados (`12433.png`, `18279.png`, `27925.png`, `29777.png`, `66602.png`) son
las copias que sirve el portal del INPI: fotocopias de microfilm de 149 a 322 px de ancho. Se les
corrigió el nivel de blanco y se recortó el margen; **no se ampliaron ni se pasaron por un upscaler
de IA** (inventaría trazos en un documento de registro). Por eso se muestran a 150 px de alto: más
grandes se ven peor.

**Qué protege cada modelo:** en los cinco casos, la **pieza plástica**, no el producto armado
(confirmado por Tomás el 16-17/09/2026 con las fotos de los productos actuales). Por eso el 18.279 y
el 29.777 figuran en el INPI como "empuñadura para útiles de cocina" aunque el producto sea el
pelador: se registró el cuerpo. El orden 18.279 (1971) / 29.777 (1976) quedó confirmado.

**Bloque "De la lámina al mostrador"**: el plano registrado al lado de la foto del artículo actual,
sólo para el pelador 505 y el afila cuchillos 504 —los dos que sostienen el argumento y están entre
los más vendidos—. Las fotos están en `img/historia/producto-*.webp`, derivadas de las que mandó
Tomás; no se usa el bucket `products-images` para que la página no dependa de él.

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

## Reportes por Telegram (`rep_*`) — viven SOLO en la base

El reporte **diario / semanal / mensual** no está en el repo: son funciones de Supabase LK que
dispara `pg_cron` y salen por Telegram vía `tg_enqueue_largo` → `tg_outbox_flush` (cron 28, cada
minuto). Los crons: **29** diario (`rep_enviar_diario`, lun–sáb 08:00 ART), **30** semanal (lun
08:15), **31** mensual (días 3/5/8/12, 08:30), más **32** top20, **33** salud, **34** riesgo y
**35** artículos. El texto lo arman `rep_texto_diario` / `_semanal` / `_mensual`; los helpers son
`rep_plata` y `rep_var`. Son `SECURITY DEFINER` y mandan Telegram: **no exponerlas a `anon`**.

**El depósito sale de Gestión Virgilio, no se recalcula acá.** `sincronizar_ppp()` (cron 19, 07:00
ART) espeja por FDW la vista `gv_lk_np_feed` a la tabla local **`ppp_np_feed`**: una fila por NP,
ISIS y web juntas, con el **neto facturado** que calcula Gestión y el **valor de lista** de lo
pendiente. De ahí salen los dos números del reporte:

- **$ facturada por día** → `rep_snapshot_despacho(30)` guarda la foto en `rep_despacho_diario`.
  La columna que manda es **`plata_neto`**; `plata` es el valor viejo (LK reconstruía sobre lo
  *pedido* y corregía con un ratio de cajas: daba de +0,5% a +14,5% de más) y **se conserva como
  historia**. Los textos leen `coalesce(plata_neto, plata)`. La foto es imprescindible:
  `ppp_base_pedidos` es amnésica y las líneas de una NP vieja desaparecen de Virgilio.
- **$ pendiente de facturar** → `rep_ppp()`. Backlog = `ppp_np_feed` no facturada, empresa `lk`.
  Las NP de ISIS se valorizan línea por línea con `ppp_valor_linea` (contempla la lista propia de
  los súper); las **NP web** no tienen líneas acá, así que usan `valor_lista × (1−dto_vol) × 0,98`.

**Nunca filtrar la empresa con `left(np,1)='9'`.** La NP web de Gestión es un contador propio con
etiqueta `LK 0001` / `CH 0002`; usar la columna `empresa` del feed. Y **no separar ISIS de web en
pantalla**: regla del dueño (Gestión v13.64), `rep_ppp()` devuelve `nps_web` pero no se imprime.

Definiciones y medición en `sql/reporte_deposito_gestion.sql`; el lado Virgilio en el repo
`Gestion-Virgilio`, `sql/gv_lk_np_feed.sql` y §3.bk de `docs/SUPABASE-GESTION-VIRGILIO.md`.

## Pendientes — AVISAR AL USUARIO

**Instrucción para Claude, no es una nota suelta:** cuando una sesión toque alguno de
estos módulos, mencionarle al usuario el pendiente que le corresponde antes de terminar
el turno. Es él quien decide si lo encara ahora o lo deja; no hay que implementarlo por
iniciativa propia. Cuando un pendiente se resuelve, borrar la línea de acá.

### Gerente de ventas

- **Telegram de la agenda — RESUELTO (9/9/2026).** Las 5 acciones del día salen por el
  **bot existente** `@Lk_gerencia_bot` (token en Vault `telegram_bot_token`, el mismo que
  usan los reportes `rep_*`). **Envío + ruteo**: `gv_enviar_agenda_telegram(p_fecha)` —
  gerencia → `chat_gerencia`, resto → `chat_faltantes` (grupo "Faltantes Virgilio"), según
  la tabla `gv_telegram_config` (`chat_gerencia`/`chat_faltantes`/`gerencia_vendedores`);
  encola con `tg_enqueue_botones` y sale por `tg_outbox_flush` (cron 28). Cron
  `gerente-ventas-agenda-telegram` (job 37, `35 10 * * *` = 07:35 ART, 5 min después del
  generador job 18). **Botones** 👍/👎 (utilidad) y ✅/❌ (resultado) → webhook Edge Function
  `gerente-ventas-telegram-webhook` (verify_jwt off, secreto en
  `gv_telegram_config.webhook_secret`) → RPC `gv_telegram_webhook` (usa el token del Vault
  para `answerCallbackQuery`/`editMessageReplyMarkup`) → `gv_telegram_callback`. La Edge
  Function `gerente-ventas-telegram` quedó **deprecada** (stub HTTP 410, borrable del
  dashboard). Para cambiar destinos o vendedores de gerencia: editar `gv_telegram_config`.
- **La población por provincia cargada es PROVISORIA**: suma 46.082.944 contra los
  46.044.703 del Censo 2022 (~38.241 de más). Reemplazar con el dato oficial del INDEC vía
  `gv_set_poblacion(provincia, NULL, poblacion, fuente, anio)`.
- **La población por localidad no está cargada**, así que la pestaña "Por localidad" del
  ratio sale sin números. El mapa igual anda: los pines se dimensionan por sucursales.
- **Quedan ~17 localidades sin geocodificar** (al 9/9/2026: cobertura de sucursales
  **98,8%**, subió de 94,6%). El 9/9 se resolvieron ~50: correcciones de provincia mal
  cargada en `customer_delivery_addresses` (`Capital Federal`/`Ciudad Autónoma…` → `CABA`;
  `Berazategui`/`Quilmes`/`San Miguel`/`Munro`/`Villa Ballester`/`Ciudadela` de CABA → Buenos
  Aires; `Cipolletti` de Neuquén → Río Negro; `San Martín de los Andes` de Río Negro →
  Neuquén) + ~40 filas nuevas en `geo_localidad_alias` (barrios de CABA/Córdoba, abreviaturas
  de capitales). **Georef está bloqueado por el proxy de egress**, así que geocodificar desde
  una sesión de Claude NO se puede: la vía es agregar aliases a localidades ya geocodificadas
  de la MISMA provincia (el alias no cruza provincias) o corregir el dato. Lo que queda es
  basura real (notas tipo `Verificar`/`Topsy`/`Mercado Central`, o Chubut sin cargar como
  `Esquel`/`Gaiman`): no hay a dónde mapearla sin corregir la ficha del cliente.
- **Capa de redacción con LLM (opcional).** `CLAUDE_API_KEY` ya está en el vault, así que
  el mensaje diario podría salir en prosa en vez de lista estructurada sin tocar el motor
  de señales, que es determinístico y no debe depender de un modelo.
- **`sql/gerente_ventas.sql` está INCOMPLETO y desfasado.** Se escribió antes de la segunda
  tanda de trabajo, así que le faltan por completo: el esquema de los dos ejes
  (`resultado`/`utilidad`, `util_si`/`util_no`/`acc_*`, `tope_dia`), `gv_marcar_resultado`,
  `gv_marcar_utilidad`, `gv_preguntas` + `gv_generar_preguntas` + `gv_responder_pregunta` +
  `gv_preguntas_abiertas`, `gv_silenciados`, `gv_rendimiento`, `gv_agenda_rango`,
  `gv_vendedor_de`, `gv_completar_vendedores`, y las tres señales nuevas de `gv_candidatos`.
  Tampoco da md5 idéntico para lo que sí tiene (varias funciones se desplegaron parcheando
  `prosrc`). **La base es la fuente de verdad; el archivo hoy NO sirve para recrear el
  módulo.** Para regenerarlo: volcar con `pg_get_functiondef` todo `gv_*` y el DDL de las
  tablas `gv_*`/`geo_*`.

### Integración Krikos

- ~~**Falta `KRIKOS_IMAP_PASS`**~~ ✅ **cargado el 11/9/2026 por Luis** en el Vault de LK. Ese
  mismo día se vio que no alcanzaba: los mails se archivan fuera de INBOX, así que la función pasó
  a recorrer varias carpetas (`KRIKOS_MAILBOXES`, ver arriba). **La bandeja quedó andando**: 10 OC
  detectadas, 7 con PDF bajado (Carrefour x2, Diarco x2, La Anónima, Coto x2) y 3 con el link
  vencido. ~~Las 10 son de OC que ya se habían cargado a mano: hay que **descartarlas desde la
  Bandeja Krikos** una vez.~~ ✅ hecho. **Al 16/9/2026 la bandeja no tiene ni un pendiente ni un
  error**: 16 descartadas, 6 cargadas, 2 ignoradas. Las 6 de junio/julio con el link vencido se
  descartaron ese día (backup en `zz_backups."GV_Backup_krikos_oc_error_20260916"`): no se podían
  bajar nunca más y eran seis renglones rojos fijos.
- ~~**Pedir al hosting que habilite IMAP con TLS (993)**~~ ❌ **NO VA** (Luis, 16/9/2026). Se
  evaluó y se descartó: son OC de supermercados, no datos sensibles. **No volver a proponerlo.**
- **Planexware**: consulta de plan enviada a comercial@ y mesadeayuda@ el 3/9/2026 (si el plan
  incluye SFTP/webservice, o descarga estructurada). Sin respuesta todavía.
- ~~**Espejo en Virgilio**~~ ✅ replicado el 7/9/2026 a `/admin/admin-supercot.js` de
  `Gestion-Virgilio` (mismo archivo, byte a byte; el espejo no tiene ajustes propios en ese
  archivo). Bump de `?v=` en `admin/admin.html` a mano, que ahí no hay hook.
- Toledo no tiene regex de detección de PDF en `detectSuper` **ni parser propio** (nota en
  `precios_super.cadena`): una OC de Toledo desde la bandeja cae en "No se pudo identificar la
  cadena". **No agregar la regex sin el parser**: `PARSERS[key]` quedaría `undefined`. Desde el
  7/9/2026 hay un guard que avisa "cadena detectada pero todavía no hay parser" en vez de
  explotar, así que sumar la regex es seguro apenas haya una OC de Toledo de muestra para
  escribir `parseToledo`.

### Dashboard de ventas

- **El importador de listas de súper detecta las columnas por ENCABEZADO, con `hoja_cod_col`/`hoja_price_col` como fallback.** Los índices de columna del Excel se corren cuando alguien mete una columna nueva en el medio, y ahí `hoja_price_col` terminaba apuntando a "Costo sin aportes" en vez de a "Lista Vigente" — un re-upload cargaba COSTOS como precios. Verificado 4/8/2026 contra `A_Costos_VIGENTES`: los índices que estaban en la config (col 2 = costo) NO coincidían con lo cargado (col "Lista Vigente"), o sea que los datos vivos se habían cargado desde un layout anterior. Se corrigieron los índices a los verificados y `admin-supercot.js` ahora busca "Cod"/"Lista Vigente"/"Lista a Enviar" por nombre (probado contra las 9 hojas). **La lista de Toledo se cargó ese día** (33 precios, hoja "Toledo Loeke"); dejó de valorizarse con la lista general.
- **`precios_super.cadena.usa_lista_general` separa dos casos que antes se confundían.** Una cadena sin lista propia caía en la lista general EN SILENCIO, y eso mezclaba "está bien así" con "le falta la lista". Decisión del usuario (4/8/2026): **Messina va con lista general** (`true`), **Toledo con lista especial propia** (`false`, todavía sin cargar). `gv_cadenas_sin_lista()` devuelve las que necesitan lista propia y no la tienen, o la tienen sin fecha o con más de 10 meses — hoy son 9 cadenas con **$1.159 M de venta anual** mal o dudosamente valorizada, encabezadas por Coto ($455 M con lista SIN FECHA).
- **Los SUPERMERCADOS tienen lista de precios propia y el dashboard los valoriza mal.**
  `precios_super.precio` (453 filas, 8 cadenas: abastecedor, alberdi, coto, dia, diarco,
  inc, laanonima, libertad) la usa solo el cotizador, y ahí el súper sale del **nombre de
  la hoja del Excel** — el vínculo por CADENA sí existe:
  `precios_super.cadena.cod_cliente_lk` (Coto 801, INC 1651, Día 3947, Diarco 4112, Libertad 325,
  Alberdi 2320, Abastecedor 4051, La Anónima 771, Toledo 1947, Messina 1573; Cencosud y Dorinka
  van a Chef) y es lo que usa PDF Krikos para auto-elegir el cliente. Lo que está vacío es
  `supermarket_branch_mapping`, el mapeo por SUCURSAL (0 filas al 3/9/2026). El dashboard no
  usa ninguno de los dos. Medido: 8 clientes de súper son el **14,4% de la
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
- **El join contra `products` descarta líneas de artículos discontinuados**: 0% en 2024,
  1,4% en 2025 y 4,2% en 2026. Como la pérdida crece, el interanual queda levemente
  SUBESTIMADO.

- **La PPP en curso se espeja de Virgilio por `postgres_fdw`** (proyecto `hrxfctzncixxqmpfhskv`), calcado del FDW de Chef. LK TIRA con el rol de solo-lectura `lk_ppp_reader` (creado en Virgilio: `SELECT` sobre 4 tablas + una policy propia por tabla, RLS estaba activo). Las foráneas viven en el esquema `virgilio`; `sincronizar_ppp()` las copia a tablas locales `ppp_*` (reemplazo total, la fuente es amnésica) y el cron `sincronizar-ppp-diario` (10:00 UTC) las refresca. **Nunca joinear el FDW en el camino caliente** (lección de Chef). Las tablas `ppp_*` no tienen policy para anon/authenticated; se leen por RPC con chequeo de admin.
- **El string identificador de pedido web viaja AL REVÉS: LK EMPUJA a Virgilio** (2026-08-28). Virgilio no tiene la sucursal de entrega de los pedidos; LK sí (`sheets_payload.sucursal_entrega`). La vista **`v_pedidos_match`** (revocada de anon/authenticated) arma por pedido `match_string = cod_cliente|fecha ART|items` con items = `cod_art`x`cajas` ordenado por código y cajas sumadas por código repetido — sale de `sheets_payload.items`, exactamente lo que viajó al Sheet/ERP. `sync_pedidos_match_virgilio()` (cron `sync-pedidos-match-virgilio`, cada 15 min, ventana móvil de 14 días con delete+insert) la copia a la tabla **`lk_pedidos_match`** de Virgilio escribiendo a través del MISMO FDW/rol `lk_ppp_reader`, que ahora tiene INSERT/UPDATE/DELETE **solo sobre esa tabla** (el resto sigue solo-lectura). Se eligió empujar en vez de que Virgilio tire porque reusa la credencial existente y deja a Virgilio leyendo una tabla local (cero FDW en su camino caliente). `ambiguo=true` marca el único caso que el string no resuelve (mismo cliente, mismo día, mismos ítems, distinta sucursal: 17 de 977 pedidos históricos; los strings repetidos hacia la MISMA sucursal —resubmits— no molestan) y `orden_en_dia` desempata por hora. **Cubre también CHEF** (2026-08-28): sus pedidos web viven en el proyecto Supabase de Chef (portal gemelo, misma `orders`/`sheets_payload`) y LK los lee por el FDW `chef_db` (foreign table `chef_orders` + vista `v_pedidos_match_chef`, cod del payload con fallback a `chef_customers` por `customer_id`) y los reenvía con `empresa='chef'` — la tabla de Virgilio lleva `empresa` en la PK porque numeraciones de cliente y `order_id` chocan entre portales (NP 9xxxx = lk, 4xxxx = chef). **Grant en Chef HECHO (2026-09-11)**: `grant select on public.orders to loke_reader;` corrido por el dueño; el backfill ya entró (69 pedidos chef en `lk_pedidos_match`). Todo en `sql/pedidos_match_virgilio.sql`; el DDL del lado Virgilio en `sql/lk_pedidos_match.sql` del repo `Gestion-Virgilio`.
- **⚠ `gv_pedidos_web_np_chef` NO lee el FDW de Chef: lee una COPIA LOCAL** (2026-09-14). Esa RPC es el feed de pedidos web de Chef que consume el armado de Gestión cada 15 min, y tardaba **7,03 s contra un `statement_timeout` de 8 s**: el **3,1 % de las corridas** moría con `57014` (14 de 446 en una semana) y esa corrida programaba LK pero no Chef. **La causa no era la consulta, era la conexión**: `select count(*) from chef_customers` —que el remoto resuelve entero y devuelve un número— tarda **2.879 ms**, contra **70 ms** del mismo `count` sobre `virgilio.volumen_articulo`. Mismo `postgres_fdw` y misma config de server; la diferencia es que Virgilio está en la misma org y región (`sa-east-1`) y **el proyecto de Chef está en otra organización**. Abrir esa conexión cuesta **~2,4 s fijos**, traiga 1 fila o 10.000, y ninguna optimización de SQL lo baja. Encima el filtro de fecha **no se empujaba** (`Rows Removed by Filter: 45` sobre 72: traía los 72 pedidos con el `sheets_payload` entero), porque `current_date` es STABLE y postgres_fdw sólo manda inmutables. Solución: el mismo patrón de `chef_padron` extendido a los pedidos — `chef_orders_cache`, `chef_customers_cache` y `chef_dirs_cache`, refrescadas por `sincronizar_chef_orders(90)` (cron `sincronizar-chef-orders`, jobid 48, **cada 5 min**, ~7 s por corrida y fuera del camino caliente). **La RPC pasó de 7.030 ms a 143 ms (49×)** con salida **idéntica**: 36 = 36 filas, `except all` 0 en los dos sentidos, mismo md5. La corrida entera del armado bajó de 16-25 s a **8,0 s**. **No se tocó nada del proyecto de Chef.** `gv_pedidos_web_np_chef_fdw(integer)` es la copia exacta de la versión vieja y es el rollback. **⚠ Una copia se desincroniza en silencio**: para eso está `chef_cache_salud()` (vacío = todo bien; cuesta los ~7 s del FDW, no llamarla desde una pantalla). Si el remoto viene vacío el sync **no pisa nada** — vaciar la copia sacaría de la PPP todos los pedidos de Chef sin que nadie se entere. Siguen leyendo el FDW, y pagando los 2,4 s, `get_pedidos_web_np_chef`, `oc_super_ya_cargada`, `refrescar_chef_padron` y `costos_sync_razones`: ninguna está en el camino del armado. `sql/chef_orders_cache.sql`.
- **A qué ISIS se le factura a cada cliente también lo EMPUJA LK** (2026-09-14, pedido de Thomas). Un cliente de Tierra del Fuego compra artículos de Loekemeyer pero se le factura por Chef: carga desde la página de LK y los códigos salen con **L** (505 → 505L). Eso ya lo resolvía `v_pedidos_web` (`isis_empresa`, `cod_isis`). Lo que faltaba era del otro lado: la **Cuarentena** de Gestión (deuda / estado / límite) miraba el padrón de **LK**, donde esos 9 clientes tienen **límite 0** y 4 figuran **Suspendido** — justamente porque a ellos no se les vende por LK —, y retenía pedidos sanos (el 14/09 frenó el pedido **1431**, Il Cheff). Ahora la vista `gv_cliente_isis_calc` calcula por cliente el par `(isis_empresa, cod_isis)` —**todas** sus direcciones de entrega en TdF, o `gv_isis_override` mandándolo a Chef, y CUIT presente en `chef_padron`— y `sync_cliente_isis_virgilio()` lo escribe en `GV_Cliente_Isis` de Virgilio por el mismo FDW y rol (cron `sync-cliente-isis-virgilio`, jobid 47, cada 15 min). Del lado de Virgilio lo consume `gv_cuarentena_ident`. **La Anónima (771) queda afuera a propósito** (override `lk`). **⚠ Cencosud NO entra por esta regla y NO hay que darlo de alta** (dueño, 14/09: *"Cencosud sube pedido por Krikos y eso lo detectaba… siempre (histórico) subió pedidos por CH. No lo voy a dar de alta."*): no está en `customers` (0 filas con el CUIT 30590360763) y no lo necesita, porque **no carga por la página** — sus OC entran por Krikos y la Bandeja las manda derecho al portal de Chef (`precios_super.cadena`: `cencosud` → `empresa='chef'`, `cod_cliente_chef='2444'`, `cod_cliente_lk` nulo). Medido: 4.452 líneas del 2444 en `sales_lines` marcadas `chef`, del 2021-05-27 a hoy, ninguna en LK. Su caso propio —NP de Chef con artículos de Loeke **sin** L— lo cubre `gv_fac_ajustes_isis` de Gestión: es el caso **inverso** al de Tierra del Fuego. `sql/gv_cliente_isis.sql`; el lado Virgilio en `sql/gv_cliente_isis_v1775.sql` del repo `Gestion-Virgilio`.
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

- **`get_customer_sales_history` sigue abierta a cualquier `authenticated`**: un mayorista
  logueado puede leer el histórico de compras de otro pasando su código. Solo la llaman
  pantallas de admin, así que se arregla agregándole el chequeo de `admins` adentro.
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

---

# Reportes de ventas por cliente — checklist obligatorio

**Escrito el 9/9/2026 después de un reporte que salió mal cuatro veces seguidas** ("clientes
que no compran el artículo 504"). Los tres errores no fueron de cálculo: fueron **supuestos
sobre el significado de los datos que no se verificaron contra la base**. Antes de entregar
cualquier ranking de clientes por volumen, recorrer esta lista.

## 1. Precios: la fuente es `v_item_precio`, NO `products`

**`products` + `loke_products` NO alcanzan para valorizar ventas.** Medido sobre los 369
artículos vendidos en 4 meses: esa combinación deja **170 sin resolver y 5 en $0 — 175 mal
valorizados (47%)**. `v_item_precio` cubre 362 de 369 y ninguno en cero, porque además de los
dos padrones consulta `item_precios` (precios cargados a mano, columna `fuente` =
`item_precios:manual`).

Los artículos de la línea Loke son el caso típico: `120` (Filtro de Café) y `193` (Tostador
Enlozado) **no existen en `products` y valen $0 en `loke_products`**, pero tienen $1.040 y
$4.950 en `v_item_precio`. El cliente 4112 (Diarco) compró 47 y 88 cajas de ellos: su volumen
pasó de $4,3 M a $10,6 M al corregir la fuente, y **cambió el puesto 1 del ranking**.

**Chequeo antes de entregar:** contar cuántos artículos del período quedan sin precio. Si no
es cero o casi, la fuente está mal.

```sql
select count(distinct s.item_code) filter (where v.cod is null) as sin_precio,
       count(distinct s.item_code) as total
from sales_lines s left join v_item_precio v on v.cod = s.item_code
where s.empresa='lk' and s.invoice_date >= '<desde>'
  and s.item_code not in (select item_code from sales_excluded_items);
```

Sin el filtro de `sales_excluded_items` da 16 de 378 en vez de 7 de 369: los códigos
administrativos tampoco tienen precio y ensucian el chequeo.

## 2. "Compró X" incluye los pedidos web sin facturar

`sales_lines` es solo lo **facturado**. Un cliente que pidió el artículo por el portal la
semana pasada todavía no aparece ahí, pero **comercialmente ya lo compró**: ofrecérselo es
quedar mal. Para un reporte de "a quién ofrecerle X" hay que cruzar también `order_items`.

```sql
-- quién pidió el artículo por el portal (facturado o no)
select distinct cu.cod_cliente
from order_items oi
join orders o   on o.id = oi.order_id
join customers cu on cu.id = o.customer_id
join products p on p.id = oi.product_id     -- OJO: order_items.product_id es uuid, no el código
where o.created_at >= '<desde>' and p.cod = '<articulo>';
```

**`order_items` no tiene `product_cod`**: se joinea por `product_id` (uuid) contra
`products.id`. Para artículos Loke, por `loke_product_id`.

**Pero los pedidos web NO se suman al volumen.** Desde 2026 el ~99% de los pedidos entra por
el portal y después se factura, así que sumar `orders.total` + `sales_lines` **cuenta dos
veces la misma operación** (verificado: mediana del cociente exactamente 2,00). Regla:
`orders`/`order_items` sirven para *saber si pidió*, nunca para *cuánto compró*.

## 3. Una devolución no es una compra

`sales_lines.boxes` puede ser negativo. Sin filtrar, un cliente que solo devolvió mercadería
figura como activo. Exigir **al menos una compra positiva** en la ventana:

```sql
having sum(case when boxes > 0 then boxes else 0 end) > 0
```

**Y el ranking se ordena por compras positivas, no por neto** (decisión del usuario, 9/9/2026).
Una devolución puede corresponder a mercadería vendida *antes* del período y hace parecer chico
a un cliente que hoy compra fuerte: Diarco compró $15,5 M y devolvió $4,9 M — por neto salía
3.º, por compras es el 1.º. Mostrar **tres columnas: Compras · Devoluciones · Venta neta**, así
las devoluciones quedan a la vista sin distorsionar el orden. 18 de 121 clientes tenían
devoluciones.

## 4. Un mismo artículo puede estar cargado con varias grafías

Buscar `item_code = '504'` no encuentra `504L`, que es el mismo Afila Cuchillos. Desde julio
2026 hay 78 códigos con sufijo `L`/`EL` cuyo código base sí existe en el padrón (75 de 78).
Por eso Relca y Malambo aparecían como "no compran el 504" cuando lo compran.

Usar `item_code LIKE '504%'` o normalizar, y **revisar siempre qué variantes existen** antes de
filtrar por un código:

```sql
select item_code, count(*), sum(boxes) from sales_lines
where empresa='lk' and item_code like '<cod>%' group by 1;
```

**El sufijo L YA ESTÁ RESUELTO en `item_precios`, no es una pregunta abierta.** El 4/9/2026 se
cargaron los 78 códigos con `origen = 'variante_L'`, su `base_cod` apuntando al código original
y la nota *"Variante para cliente puntual. Mismo precio que el codigo base (confirmado por el
usuario, 4/9/2026)"*. Por eso `v_item_precio` los valoriza bien y `products` no: **el maestro de
artículos nunca los tuvo, y no hace falta que los tenga**. Lo que hay que recordar es que
`sales_lines` guarda el código CON sufijo, así que cualquier join contra `products` los pierde.

Existe además `chef_item_remap` (from_code → to_code) para las grafías de Chef.

**Antes de declarar un artículo "sin alta", mirar `item_precios`**: tiene `base_cod`, `nota` y
`actualizado_at` justamente para dejar asentado el criterio de cada carga manual. De los 169
artículos que en julio-agosto no estaban en `products`/`loke_products`, **166 sí tenían precio**:
80 salían de `chef_products`, 78 de las variantes L y 8 de cargas manuales. Sin alta real había
**3**: `702EN`, `877E` y `730D`.

## 5. No todo lo que dice `empresa='lk'` es de Loekemeyer

Un código de cliente con ventas marcadas `lk` **no garantiza** que sea cliente de Loekemeyer.
Al 9/9/2026 hay 34 códigos con ventas `lk` desde julio que **no tienen ficha en `customers`** y
sí están en `chef_padron` — son ventas de Chef mal cargadas (ver la sección de anomalías abajo).
El caso testigo: el código 2686 es **Dorinka S.R.L., de Chef**, y con $40 M encabezaba un
ranking de clientes de Loekemeyer.

**Filtrar siempre contra el padrón**, no confiar solo en la columna `empresa`:

```sql
... where exists (select 1 from customers c where c.cod_cliente::text = s.customer_code)
```

Un cliente que sale "(sin razón social)" es una señal de alarma, no una fila más del ranking.
Y **nunca resolver el nombre desde `Wpp_Clientes` sin filtrar `marca='LK'`**: 63 códigos
figuran con las dos marcas y 62 con razón social distinta.

## 6. Valorización: la cadena completa

```
cajas × uxb × list_price × (1 - customers.dto_vol) × (1 - web_order_discount)
```

`list_price` es **por unidad, no por caja**: sin el `uxb` el monto sale dividido por las
unidades por caja (promedio 12,1, rango 1 a 100). Y excluir siempre
`sales_excluded_items` (descuentos por pago, notas de crédito, agregados de ISIS): son 21
códigos administrativos que si se cuentan como compra corren la fecha de última compra.

---

# Anomalía de carga de julio-agosto 2026 — SIN RESOLVER

Auditado el 9/9/2026. **1.372 líneas marcadas `empresa='lk'` con artículos que no existen en el
padrón de Loekemeyer**, en 82 clientes. Entraron por dos importaciones manuales:
`import_batch = 'julio_26'` (cargada el 3/8) y `'ago-26'` (cargada el 2/9). La serie deja el
salto aislado: histórico 0,1% · feb-jun 1,2% · **julio 17,3% · agosto 14,1%**.

Encaja con un segundo hecho: **la última factura cargada como `empresa='chef'` es del
30/06/2026**. Desde julio no entró ninguna. Las ventas de Chef no se duplicaron — se desviaron.
(Verificado: cero de las 1.372 líneas coincide con algo ya cargado como chef por
cliente+artículo+fecha+cajas.)

Son **tres problemas distintos**, no uno:

| Grupo | Clientes | Líneas | Cajas | Qué es | Qué hacer |
|---|---|---|---|---|---|
| **A** | 34 | 551 | 2.950 | **Chef cargado como LK.** 33 de 34 tienen historial en `chef`, **ninguno** tiene venta previa en `lk`. 92% de sus líneas usa artículos del catálogo de Chef. | Remarcar como `empresa='chef'`. **No borrar**: son ventas reales en la empresa equivocada. |
| **B** | 22 | 789 | 3.455 | **Sufijo L/EL**, concentrado en Relca (427 líneas) y Malambo (126). Es una **variante de código para un cliente puntual, mismo precio que el base** — ya resuelto en `item_precios` el 4/9/2026 (`origen='variante_L'`). | Nada urgente: `v_item_precio` los valoriza bien. Solo cuidar que ningún cálculo joinee contra `products` a secas. |
| **C** | 26 | 32 | 403 | Clientes LK legítimos (25 de 26 con historial previo) con artículos que faltan dar de alta. | Alta de artículos en el padrón. |

**Mientras no se corrija, el grupo A ensucia todo lo que lee la facturación de Loekemeyer**:
Ranking de Inactivos, dashboard de ventas, estadística madre y las proyecciones de las OC de
Virgilio. Son clientes que figuran como "dejaron de comprar" sin haber comprado nunca.

Queda pendiente además averiguar **por qué se cortó la carga de Chef en julio** — eso está
fuera de la base, en el proceso de importación.

## REGLA: auditar en Supabase cada problema del repo y su solucion

**Vale para TODOS los repos** (igual que la regla de Planify: copiar este bloque al `CLAUDE.md`
de cualquier repo nuevo). Objetivo: que cada error que tuvo un repositorio quede con su causa,
su correccion y el/los commits donde se arreglo, para no volver a pisar el mismo pozo.

**Donde:** proyecto Supabase `hrxfctzncixxqmpfhskv`, schema `github_repo_problemas`.
Se escribe con el MCP de Supabase (`execute_sql`), no con la anon key.

### Que se audita y que NO

Regla corta: **si ya estaba pusheado y andaba mal, se audita.** Si es trabajo nuevo, no.

| Se registra | NO se registra |
|---|---|
| Bug en codigo ya pusheado que llego al usuario | Feature nueva o pedido de cambio |
| Dato corrupto o mal migrado en la base | Refactor pedido por el usuario |
| Config o credencial rota o filtrada | Bug que introducis y arreglas antes de pushear |
| Performance degradada, query que no escala | Duda o consulta que se responde en el momento |
| Tabla derivada desincronizada de su madre | Ajuste de estilo o texto |

### Cuando

1. **Al detectar el problema** (antes de tocar nada): `registrar_problema` devuelve el id.
2. **Al pushear el fix**: `cerrar_problema` con el sha del commit.
3. **Si el fix necesita mas commits**: `agregar_commit` por cada uno. Un problema puede tener N
   commits; NO abrir un problema nuevo por el segundo pase del mismo fix.
4. Una sesion de Claude puede abarcar **varios** problemas: `sesion_id` no es unico.

### SQL

```sql
-- 1) al detectar
select github_repo_problemas.registrar_problema(
  p_repo          => 'owner/repo',            -- en minuscula
  p_titulo        => '<sintoma en <=120 chars>',
  p_descripcion   => '<que se rompio y como se manifesto>',
  p_categoria     => 'bug',                   -- bug|datos|seguridad|performance|config|ux|deuda_tecnica|documentacion
  p_severidad     => 'alto',                  -- critico|alto|medio|bajo
  p_modulo        => 'Carpeta/Modulo',
  p_archivos      => array['ruta/relativa.html'],
  p_sesion_id     => '<id de la sesion de Claude>',
  p_detectado_por => '<usuario> (claude-remote)',
  p_detectado_en  => now()                    -- fecha REAL si es carga historica
);

-- 2) al pushear el fix
select github_repo_problemas.cerrar_problema(
  p_id            => <id>,
  p_correccion    => '<que se cambio>',
  p_commit_sha    => '<sha corto>',
  p_branch        => '<branch>',
  p_commit_url    => 'https://github.com/owner/repo/commit/<sha>',
  p_causa_raiz    => '<por que paso, no que paso>',
  p_corregido_por => '<usuario> (claude-remote)',
  p_mensaje       => '<subject del commit>'
);

-- 3) commits extra del mismo problema
select github_repo_problemas.agregar_commit(<id>, '<sha>', '<branch>', '<url>', '<mensaje>', '<autor>');

-- lectura
select * from github_repo_problemas.v_problemas order by detectado_en desc;
```

**Avisar en el chat el titulo del problema** al registrarlo y al cerrarlo, no el numero de id
(mismo criterio que Planify).

**Si el problema se detecta pero NO se arregla, queda en `estado='abierto'`.** Ese es el punto:
que quede anotado. Estados: `abierto` | `en_curso` | `corregido` | `no_corregible` | `descartado`.
Para pasar a `corregido` la base exige `correccion` y `corregido_en` cargados (constraint).

**La auditoria no se borra.** El rol `anon` tiene SELECT/INSERT/UPDATE pero NO DELETE ni
TRUNCATE en las tres tablas. Si una fila esta mal, se corrige o se pasa a `descartado`.

## REGLA: claves de Supabase - migrar a las nuevas, NO apagar las legacy todavia

Estado al 2026-09-11. Supabase cambio el sistema de claves. Conviven dos juegos y **los dos
funcionan a la vez**, asi que se migra cliente por cliente sin downtime.

| Sistema | Claves | Se rota de a una |
|---|---|---|
| Nuevo | `sb_publishable_...` (frontend) + `sb_secret_...` (backend) | si |
| Legacy (JWT) | `anon` + `service_role` | NO: las dos derivan del JWT secret del proyecto |

Doc: `supabase.com/docs/guides/getting-started/migrating-to-new-api-keys`. Textual: *"The
legacy anon and service_role keys are based on your project's JWT secret, which makes them
hard to rotate without downtime."* **No existe boton "Roll" para las legacy.**

### 1. Lo filtrado vive en el HISTORIAL de git, y el historial no se arregla

Una `service_role` legacy quedo expuesta en el historial de un repo publico (ver `LOCKS.txt`
de `GestionProductivaEntero`, entrada 2026-09-04). El arbol de trabajo ya esta limpio, pero
eso no alcanza: lo que estuvo en un repo publico pudo clonarlo cualquiera y reescribir el
historial NO lo des-filtra. **El unico arreglo real es invalidar la clave.**

Precision importante: lo que se filtro es la **`service_role` key** (un JWT firmado con el
secret), NO el JWT secret. De un HS256 no se deriva la clave, asi que **apagar las legacy
alcanza** para matar lo filtrado. Rotar el JWT secret es un paso extra, no el obligatorio.

### 2. Como se invalida (y por que todavia no)

Dashboard -> Settings -> API Keys -> pestana **"Legacy anon, service_role API keys"** ->
boton **`Disable JWT-based API keys`**. Apaga `anon` y `service_role` de una sola vez. Es
reversible. Es lo que la doc pide para este caso: *"Make sure you also switch to publishable
and secret API keys and disable the anon and service_role keys."*

**NO apretarlo todavia:** apaga TAMBIEN la `anon`, que es la que usa el frontend. Hoy eso
tira abajo la app entera.

### 3. ⚠ EL STORAGE SI ACEPTA LAS CLAVES NUEVAS — lo que falta es el header `apikey`

**Este bloque cambio DOS veces el mismo dia, y la segunda es la buena.** Vale la pena leer las
dos, porque la equivocacion del medio es facil de repetir:

- **11/09** decia *"el Storage rechaza las claves nuevas al ESCRIBIR"* y que por eso no se podian
  apagar las legacy.
- **13/09 (v16.56)** dije que esa excepcion ya no existia, porque mande un upload con la
  `sb_publishable_` y dio 200. **Estaba mal la conclusion, no la medicion**: en esa prueba mande
  la clave en `apikey` **y** en `Authorization`, y no me di cuenta de que el que hacia el trabajo
  era el primero.
- **13/09 (v16.62), la buena:** el formato de la clave nunca fue el problema. **Lo que faltaba es
  el header `apikey`.**

Medicion contra el Storage real (bucket `inbox` de LK, objeto de prueba creado y borrado):

| Request | Resultado |
|---|---|
| `Bearer sb_secret_…` y nada mas | **403 `Invalid Compact JWS`** |
| `Bearer sb_secret_…` **+ `apikey: sb_secret_…`** | **200**, el objeto se sube |
| `Bearer sb_publishable_…` y nada mas | 403 `Invalid Compact JWS` |
| `Bearer sb_publishable_…` **+ `apikey: …`** | 403 **`new row violates row-level security policy`** ← paso auth; lo frena la RLS, que es lo correcto para una clave publica |

**Por que la legacy andaba sin `apikey`:** la legacy **es** un JWT, asi que el Storage la podia
parsear del Bearer. Con la clave nueva intenta lo mismo, no puede, y contesta `Invalid Compact
JWS`. Ese error significa *"no pude parsear el token"*, no *"no soporto el formato"*.

**Y por eso la app nunca estuvo rota:** `supabase-js` manda `apikey` siempre. Los que fallaban
eran los `curl` / `Invoke-RestMethod` escritos a mano, que mandan solo el Bearer — exactamente el
caso del workflow de Planify (runs 112 a 115 del 11/09). **Ya corregido**: `build-deploy.yml` y
`deploy-only.yml` de `loekemeyer/Planify` mandan las dos cabeceras desde el commit `75179d7`.

**Confirmado tambien BORRANDO, el 14/09** (lo de arriba es un upload): `limpiar_pedidos_pdf` de
LK hace `net.http_delete` contra `/storage/v1/object/pedidos-pdf` con `Authorization: Bearer
<sb_secret_>` **y** `apikey`. Seis tandas, las seis en **200**, 567 PDFs borrados de verdad (el
bucket paso de 706 a 139 objetos y de 329 a 65,6 MB). O sea que con `apikey` la clave nueva
escribe y borra.

Repro, para volver a medirlo (ojo: **si da 200 crea el objeto**, hay que borrarlo con un `DELETE`
a la misma URL — `storage.objects` no se puede borrar por SQL, `storage.protect_delete()` lo
impide):

```sql
select net.http_post(
  url := 'https://<ref>.supabase.co/storage/v1/object/<bucket>/__prueba__.json',
  headers := jsonb_build_object('Authorization','Bearer <clave>','apikey','<clave>',
                                'Content-Type','application/json'),
  body := '{"p":1}'::jsonb);
```

**Inventario de lo que escribe en Storage, al 13/09** (todos con `supabase-js` salvo Planify, o
sea que ya mandan `apikey`): `recepcion.js` de Gestion (bucket `remitos`), `krikos-ingest` de LK
(`krikos-oc`), `script.js` de LK (`.remove()` de videos) y los workflows de Planify (corregidos).

⚠ **Y hay un pedazo de `recepcion.js` que quedo muerto**: `pendUploadFoto` tiene un tercer intento
que hace `signOut()` y sube con la clave pelada como Bearer. Estaba pensado para la anon legacy.
Hoy el primer intento anda, asi que no molesta, pero el comentario que dice que ese fallback
"sube igual" hay que leerlo con esta nota al lado.

### Orden obligatorio

1. Contar donde esta escrita la clave legacy en este repo:
   ```
   grep -rl 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9' . --exclude-dir=.git | wc -l
   ```
   (Referencia: `GestionProductivaEntero` tenia 66 archivos y 0 con la clave nueva.)
2. Reemplazar esa cadena por la `sb_publishable_...` del proyecto Supabase de ESTE repo
   (cada proyecto tiene la suya; no mezclar).
3. Migrar todo backend que use `service_role` (Edge Functions, n8n, scripts) a `sb_secret_...`.
4. Inventariar lo que escribe en Storage (ver el punto 3) y confirmar que **cada uno manda el
   header `apikey`**, no solo el Bearer. Ya NO hay que dejar nada en legacy por eso: con
   `apikey` el Storage acepta tanto `sb_secret_` como `sb_publishable_` (medido el 13/09).
   Lo que usa `supabase-js` ya lo manda solo; lo escrito a mano (`curl`, `Invoke-RestMethod`)
   hay que mirarlo uno por uno.
5. Recien con 1-4 hechos en TODOS los repos que peguen contra ese proyecto:
   `Disable JWT-based API keys`. **Ya no esta bloqueado por el Storage** (punto 3). Lo que
   falta: que el dueno cambie el secret `SUPABASE_SERVICE_KEY` de Planify por una
   `sb_secret_` y mire ese primer build, y que ningun cliente siga mandando la anon legacy.
   El boton lo aprieta el dueno, no Claude: apaga la `anon` que usa el frontend.

### Paso opcional: rotar el JWT secret

Sirve si ademas se sospecha del secret en si. Va en **Settings -> JWT Keys**
(`/dashboard/project/_/settings/jwt`), NO en la pagina de API Keys:

1. `Migrate JWT secret` - importa el secret viejo y crea una clave asimetrica standby. Sin downtime.
2. `Rotate keys` - la standby firma los JWT nuevos. NO desloguea a nadie: los tokens no
   vencidos se siguen aceptando.
3. Revocar el secret legacy, que queda en *Previously used*.

Dos avisos de la doc antes del paso 2:
- *"Make sure your app does not directly rely on the legacy JWT secret. If it's verifying every
  JWT against the legacy JWT secret (using a library like jose, jsonwebtoken or similar),
  continuing with the rotation might break those components."*
- *"If you're using Edge Functions that have the Verify JWT setting, continuing with the
  rotation might break your app. You will need to turn off this setting."*

Cuando revocar: esperar el tiempo de expiracion del access token + 15 min (1 h 15 min si es de
1 h) para no desloguear a nadie; en un incidente activo, revocar de inmediato.

**Al tocar cualquier archivo con una clave de Supabase, dejarlo en el sistema nuevo. Nunca
escribir codigo nuevo con la clave legacy.**

## REGLA: toda copia de respaldo nace sin RLS

**Vale para TODOS los repos** (igual que las reglas de Planify y de auditoria: copiar este bloque
al `CLAUDE.md` de cualquier repo nuevo).

**⚠️ `CREATE TABLE AS` y `SELECT INTO` NO heredan Row Level Security de la tabla de origen.** La
copia queda con `relrowsecurity = false` aunque la madre este protegida, y los `GRANT` del schema
le siguen aplicando, asi que `anon` hereda SELECT/INSERT/UPDATE/DELETE. Postgres no emite ninguna
advertencia. **Prender RLS en el MISMO paso en que se crea la copia**, no despues:

```sql
create table <schema>.<copia> as select * from <schema>.<madre>;
alter table <schema>.<copia> enable row level security;  -- sin politicas = deny-all para anon
```

Sin politicas, RLS habilitada deja la tabla accesible solo para `service_role`, que es exactamente
lo que se quiere en un respaldo.

**Caso real (2026-09-14):** `planify.bkp_items_mayo_20260914`, respaldo de la liquidacion de sueldos
de mayo hecho —bien— antes de tocarla, quedo con 56 sueldos completos (legajo, nombre,
`sueldo_bolsillo`, banco, aportes) legibles y borrables por cualquiera con la clave publishable,
durante 24 horas. El respaldo estuvo bien; lo que falto fue el `alter`.

Para barrer copias abiertas en un proyecto:

```sql
select n.nspname, c.relname
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where c.relkind = 'r' and c.relrowsecurity = false
   and has_table_privilege('anon', c.oid, 'SELECT')
   and n.nspname not in ('pg_catalog','information_schema','pg_toast');
```

## ⚠ REGLA: la base de LK tiene SEIS worker slots — no colgarle otro cron en el minuto :00

**2026-09-18, problema 402.** `max_worker_processes = 6` (instancia chica: shared_buffers
224 MB, effective_cache_size 384 MB, max_connections 60). **pg_cron usa un worker por cada job
que arranca**, pg_net se queda con uno fijo y `max_parallel_workers = 2` sale de la misma bolsa.

El 17/09 a las 21:00 UTC había **once crons arrancando juntos en el minuto :00** (1, 5, 20, 21,
24, 26, 28, 38, 39, 41, 46) y la base se cayó en pedazos durante **nueve horas**: los logs
tiraban `cron job N job startup timeout` sin parar (0 por hora antes, 92 a 166 después),
consultas triviales de 12 a 15 s, un checkpoint de 128 s contra los 23 normales, y
**`gv_pedidos_web_np_lk` contestando `57014` / `504`**. Ese último es el feed que lee Gestión
Virgilio: **el armado automático de pedidos web estuvo 5 h 40 sin correr** por esto.

Nadie lo hizo mal de golpe: los jobs 42, 43, 47 y 48 ya estaban escalonados a mano. Lo que pasó
es que los syncs a Virgilio fueron creciendo (24, 38, 39, 41, 46, 47, 48) y cada uno se sumó al
`*/N`, que es lo que sale natural. Se escalonaron en `sql/lk_crons_escalonados.sql` (el peor
minuto pasó de 11 jobs a 5).

**Al crear o mover un cron en LK:**

1. **Nunca `*/N` a secas.** Va con offset: `3-59/5`, `8-59/10`, `11-59/15`. El minuto :00 tiene
   que quedar con los dos de cada minuto (5 y 28) y poco más.
2. **Contar cuántos caen en el mismo minuto** antes de darlo por bueno — no puede pasar de 5:
   ```sql
   select jobid, jobname, schedule from cron.job where active order by schedule;
   ```
3. **Ojo con el orden de Krikos**, que no es libre: 26 baja los mails (minuto 0) → 43 auto-importa
   (minuto 3) → 42 empuja a Virgilio (minuto 5). Por eso **26 se queda en `*/10`**.
4. **El síntoma se busca así** (dashboard → Logs → postgres, o el MCP `query_logs`):
   `event_message like '%job startup timeout%'`. **Si aparece una sola vez, ya hay que mirar**:
   significa que un job no llegó a arrancar, y pg_cron no lo reintenta.

⚠ **Y un job lento ocupa el slot todo lo que tarde.** `sincronizar_chef_orders(90)` (FDW contra
el proyecto de Chef, que está en OTRA organización) tenía 12,9 s de media y llegó a **117 s**:
con eso solo se come un sexto de la capacidad de workers durante minutos. **Bajado a cada 10
minutos el 18/09** (`2-59/10`, de 288 corridas por día a 144): es margen, no un fix — el job
corre en 7,2 s antes y después del apagón, y lo que lo justifica es que su peor caso fue de
**299,7 s contra un schedule de 300 s**. Se paga con frescura: un pedido web de Chef puede tardar
hasta 10 min (antes 5) en entrar al armado de Gestión. Son 23 NP.

❌ **Y NO se sube el compute: DECIDIDO por Thomas el 18/09/2026, se queda en Micro.** No volver a
proponerlo. Dos motivos: (1) el problema se saneó sin gastar plata —crons escalonados, el vacuum
de abajo y el job 48 a cada 10 min— y quedó en **0 `job startup timeout` desde las 07:00 ART**,
con el peor minuto en 5 jobs sobre 6 slots; (2) **no está confirmado que Small suba
`max_worker_processes` de 6**, que es lo único que rompió: la doc de Supabase no publica esa
tabla y **Gestión Virgilio está en el mismo tamaño** (6 workers, 60 conexiones), así que no hay
con qué comparar. Si vuelve a aparecer un `job startup timeout`, ahí sí se pasa a **Small**
(Settings → Compute and Disk; org en plan Pro con USD 10/mes de credits, así que el neto es
**~5 USD/mes**, prorrateado por hora y reversible). ⚠ **Claude no lo puede apretar**: el MCP de
Supabase no tiene herramienta para redimensionar la instancia.

⚠ **`net._http_response` se bloata y hay que compactarla cada tanto.** El 18/09 estaba en
**105 MB con 437 filas vivas** (10.729 páginas, o sea 24 por fila) con el último autovacuum del
**2026-08-05**: la limpieza de pg_net corre sobre esa tabla en cada vuelta de su worker, así que
la escaneaba entera todo el tiempo — 165.421 llamadas, **1.085 ms de media y 3.127 s la peor**.

**Se arregla con `vacuum (full) net._http_response`** (no borra datos, sólo compacta). Medido el
18/09 a las 08:30 ART, con la base ya respirando: **105 MB → 392 kB, 10.729 páginas → 44**, y la
limpieza de pg_net pasó a costar **0 s** (10 corridas en 6 minutos sin sumar tiempo medible).

⚠ **Con la base ahogada el `vacuum full` NO entra**: se intentó tres veces de madrugada y las
tres murieron esperando el lock (ni siquiera abría conexión). Hay que hacerlo con la base
tranquila, y si hace falta destrabarla antes: `select net.worker_restart();`.

Vaciar la tabla del todo (es transitoria, TTL 6 h) **no hace falta** — con el `vacuum full`
alcanza — y además sería borrar datos, o sea que **lo autoriza el dueño, no Claude**.

## ⚠ REGLA: por qué Claude pide permiso para TODO — y cómo se apaga

**Vale para TODOS los repos** (copiar este bloque y el archivo `scripts/claude-permisos.sh` al
repo nuevo, igual que el bloque de Planify). Thomas, 2026-09-18: *"otras sesiones están pidiendo
muchísimos permisos para editar todo y antes no pasaba"*. Son **dos** cosas distintas, y hacen
falta las dos: arreglar una sola no cambia nada.

### 1. Un `hooks` mal formado tira el `.claude/settings.json` ENTERO, sin avisar

El formato viejo —`{"matcher":"", "command":"..."}`— ya no vale. Hoy va con el array `hooks`
adentro:

```jsonc
"hooks": { "PreToolUse": [ { "matcher": "",
  "hooks": [ { "type": "command", "command": "echo hola" } ] } ] }
```

Con el formato viejo Claude Code **descarta el archivo completo**, así que la `permissions.allow`
(Read, Edit, Write, git…) deja de existir y **todo vuelve a preguntar**. No tira ningún error:
simplemente no pasa nada. Así estuvo este repo desde el commit `542ab7e` (16/09), y de yapa el
hook de caveman nunca corrió ni una vez.

**Cómo se ve la diferencia** (es el chequeo, no hay otro):

```bash
echo 'deci solo ok' | claude --print 2>&1 | grep -i ignoring
# aparece "Ignoring N permissions.allow entries…"  → el archivo SE LEE (bien)
# no aparece NADA                                  → el archivo se descartó (mal)
```

### 2. Y aunque se lea, un workspace **sin trust** ignora esa allow list igual

El mensaje lo dice con todas las letras: *"Ignoring 36 permissions.allow entries from
.claude/settings.json: this workspace has not been trusted"*. El trust vive **fuera del repo**, en
`~/.claude.json` → `projects["<dir>"].hasTrustDialogAccepted`. En los contenedores remotos de
Claude Code web ese archivo **nace vacío en cada sesión**, así que ningún repo está confiado nunca.

**Lo que SÍ funciona sin trust: los permisos a nivel USUARIO** (`~/.claude/settings.json`).
Medido el 18/09: en un workspace no confiado, con la allow list del repo ignorada, la del usuario
se aplica igual. **Por eso ése es el lugar que arregla todos los repos de una.**

### Lo que hace `scripts/claude-permisos.sh`

Las dos cosas, y es idempotente: **mergea** (nunca pisa) una allow list de lectura/edición en
`~/.claude/settings.json` y marca el workspace como confiado en `~/.claude.json`. `git push`,
`curl`, `rm` y el SQL de Supabase **quedan afuera a propósito**: ésos tienen que seguir preguntando.

⚠ **Hay que correrlo ANTES de que arranque Claude.** Los permisos se leen al arrancar la sesión:
el hook `SessionStart` que lo llama recién hace efecto en la sesión **siguiente** (medido — la
sesión que lo dispara sigue pidiendo permiso). O sea:

| Dónde | Qué hacer | Cuándo aplica |
|---|---|---|
| **Claude Code web** (lo que usamos) | pegar `bash scripts/claude-permisos.sh` en el **setup script del entorno** (lo hace el dueño, en la web) | desde la sesión siguiente, en **todos** los repos |
| **Local** | correrlo una vez a mano, o aceptar el diálogo de trust | queda para siempre en esa máquina |
| Hook `SessionStart` (ya está en `.claude/settings.json`) | nada | de la 2ª sesión del contenedor en adelante |

⚠ **De las dos cosas que hace el script, la que aguanta es la de los permisos de usuario.** El
trust lo escribe en `~/.claude.json`, que es **el archivo que Claude Code se guarda para sí** y
reescribe al cerrar la sesión desde lo que tenía en memoria al arrancar: o sea que la sesión que
disparó el hook puede pisarlo al salir (medido el 18/09 — en un repo quedó, en otro se borró).
`~/.claude/settings.json` no lo toca nadie, así que **ése es el que saca los permisos de encima**,
y no necesita trust. Por eso el lugar donde el script tiene que correr es el setup del entorno.

**Chequeo de que quedó bien**, en el repo: la 1ª corrida de arriba muestra el `Ignoring`, la 2ª
ya no lo muestra (si el trust aguantó) y, con o sin trust, lee y edita **sin preguntar**.

