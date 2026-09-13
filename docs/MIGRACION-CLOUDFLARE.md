# Migración a Cloudflare — plan sin romper nada (2026-09-13)

Pedido de Thomas: pasar los repos importantes a Cloudflare y dejar de pagar hosting cPanel
en dosmentes para sitios que son estáticos. Dominios en juego: **loekemeyer.com**,
**chefsrl.com**, **tierranativasa.com**.

## 1. Veredicto corto

Sí se puede, y **no se pierde ningún dominio**: cambiar de hosting o de DNS no toca la
titularidad. Pero hay que separar cuatro cosas que hoy vienen juntas en una sola factura:

| Pieza | Qué es | ¿Cloudflare? | Costo |
|---|---|---|---|
| **Registro del dominio** | quién figura como dueño, la renovación anual | Opcional (Cloudflare Registrar, al costo). **No hace falta mover nada** | ~USD 10-12/año por .com |
| **DNS** | quién responde "loekemeyer.com está en tal IP" | **Sí**, Cloudflare DNS | Gratis |
| **Hosting web** | servir HTML/CSS/JS/imágenes | **Sí**, Cloudflare Pages | Gratis (ancho de banda ilimitado, 500 builds/mes) |
| **Correo** (`ventas@`, `mail.loekemeyer.com`) | los buzones y su contenido | **NO. Cloudflare no hace casillas** | Es lo único que obliga a seguir pagando algo |

O sea: el cPanel para servir HTML estático efectivamente está de más. **Pero el mismo plan
está sosteniendo el correo**, y ahí sí hay que tener cuidado.

## 2. El riesgo real: el correo, no la web

- `mail.loekemeyer.com` es **SmarterMail** e **IMAP 143 sin TLS** (el 993 está cerrado).
- De esa casilla come la integración **Krikos**: la Edge Function `krikos-ingest` entra por
  IMAP a `ventas@loekemeyer.com` y lee la carpeta
  `Inbox/1 Pedidos pendientes a pasar ISIS/Pedidos Super` (**1.284 mails archivados ahí**).
  Ver `CLAUDE.md` → "Integración Krikos".
- Si se da de baja el hosting sin migrar el correo antes, **se pierden los buzones**, y con
  ellos la Bandeja de OC de supermercados.

Conclusión: **la web se migra primero y el correo se toca después, o no se toca.** Bajar de
plan a uno "solo correo" en dosmentes es una salida perfectamente válida y es la de menor
riesgo. Si algún día se migra el correo, las opciones sanas son Google Workspace, Zoho Mail
o Migadu, y la migración se hace con `imapsync` (copia buzón a buzón, conservando carpetas)
antes de tocar el MX.

## 3. Qué se migra y qué NO conviene migrar

| Repo / sitio | Hoy | Mover a Pages | Nota |
|---|---|---|---|
| `pagina-LK-copia` (loekemeyer.com) | IIS + GitHub Pages | **Sí** | 173 archivos, 0 PHP. `web.config` → `_headers`, `vercel.json` → `_redirects` |
| `paginach` (chefsrl.com) | IIS | **Sí** | 73 archivos, gemelo del anterior |
| `Gestion-Productiva-2.0` | GitHub Pages | Sí, sin apuro | 213 archivos, todo Supabase |
| `Gestion-Virgilio` | GitHub Pages | ⚠ **NO todavía** | ver abajo |
| tierranativasa.com | (verificar) | a confirmar | no tiene repo en esta sesión |

### ⚠ Por qué Gestión Virgilio se queda donde está

Corre en `https://loekemeyer.github.io/Produccion-Virgilio/` y ese origen está clavado en
tres lugares: la **TWA de Play Store** (`twa-manifest.json` + `.well-known/assetlinks.json`,
host `loekemeyer.github.io`), la **cola offline de eventos** de los operarios (IndexedDB
`registro-prod` + localStorage) y las **sesiones de login**. Todo eso es por origen: cambiar
de dominio **vacía la cola pendiente y desloguea a todos**, con los operarios pickeando.

Si algún día se mueve: fuera de horario, con la cola en cero (`✓ al día` en todas las
tablets), publicando antes una versión nueva de la TWA con el `assetlinks.json` del dominio
nuevo. No es un cambio de una tarde.

## 4. Lo que reemplaza al `web.config`

Cloudflare Pages ya da por default lo que hoy hace el IIS a mano: HTTPS forzado, HTTP/3,
compresión Brotli/gzip, y los MIME de `.webp`/`.woff2`/`.avif`/`.json`. Lo que queda:

`_headers` (en la raíz del repo):

```
/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  X-Frame-Options: SAMEORIGIN
/admin/*
  X-Robots-Tag: noindex, nofollow
/*.js
  Cache-Control: public, max-age=31536000, immutable
/*.css
  Cache-Control: public, max-age=31536000, immutable
```

`_redirects` (reemplaza los rewrites de `vercel.json`):

```
/mayorista     /mayorista.html    200
/historial     /historial.html    200
/sugerencias   /sugerencias.html  200
/admin         /admin.html        200
```

El `200` es rewrite (URL limpia, no redirección). El cache largo de `.js`/`.css` es seguro
porque los hooks del repo ya versionan con `?v=` en cada commit.

## 5. Plan por fases (cada fase es reversible sola)

**Fase 0 — inventario, antes de tocar nada.** En el panel de dosmentes:
1. Exportar la **zona DNS completa** de los tres dominios (guardar el archivo).
2. Anotar **todos los buzones** de correo y su tamaño, y si hay reenvíos o alias.
3. Confirmar si el cPanel corre algo más que HTML: PHP, MySQL, formularios, cron.
4. Ver si dosmentes es también el **registrador** o solo el hosting.
5. Confirmar a dónde apunta hoy cada dominio (¿el IIS propio o el cPanel?).

**Fase 1 — Pages en paralelo.** Conectar cada repo a Cloudflare Pages (build command vacío,
output = raíz). Queda en `loekemeyer.pages.dev`. Probar el sitio entero ahí: login, carrito,
admin, imágenes de Supabase. **Nada público cambió todavía.**

**Fase 2 — DNS a Cloudflare, sin mover nada más.** Bajar los TTL a 300 s el día anterior.
Agregar el dominio en Cloudflare, **revisar registro por registro contra el export de la
Fase 0** (los MX, `mail.`, `autodiscover`, SPF, DKIM y DMARC son los que rompen el correo si
faltan), y recién ahí cambiar los NS en el registrador. Web y correo siguen exactamente
donde están: es un cambio de quién *responde* el DNS, no de dónde *vive* el servicio.
> Regla: **todo lo de correo va en nube gris (DNS only), nunca proxied.** Cloudflare solo
> puede proxear HTTP; un MX o un `mail.` en naranja mata el correo.

**Fase 3 — apuntar la web a Pages.** Recién con la Fase 2 estable (24-48 h), en Cloudflare
Pages agregar el dominio custom y pasar `@` y `www` a Pages. **Rollback = volver ese registro
al valor viejo**, propaga en minutos con TTL 300.

**Fase 4 — recién ahí, la plata.** Dejar el cPanel vivo 1-2 meses en paralelo. Después:
bajar al plan más barato que conserve el correo, o migrar el correo y recién ahí darlo de
baja. **No dar de baja nada en el mismo mes de la migración.**

## 6. Transferir el registro a Cloudflare (opcional, y para después)

No es necesario y no conviene hacerlo junto con lo demás. Si se hace, va aparte: dominio con
más de 60 días desde el último registro/transferencia, desbloquear, pedir el código EPP,
y el WHOIS con un mail al que se tenga acceso. Los `.com` se pueden; los `.com.ar` de NIC
Argentina **no** los toma Cloudflare Registrar (ésos siguen en NIC.ar, y ahí igual se pueden
apuntar los NS a Cloudflare).

## 7. Lo que falta definir (decisión de Thomas)

- ¿El correo se queda en dosmentes (plan chico) o se migra a Workspace/Zoho?
- ¿tierranativasa.com tiene sitio y casillas propias, o solo el dominio?
- ¿El IIS propio sigue existiendo después de esto, o se apaga también?
