---
name: publicar-lk
description: Arma el paquete para publicar loekemeyer.com (el IIS de SolidCP) con SOLO los archivos que cambiaron desde la version que hoy esta en el aire, y se lo entrega al usuario como un .zip chico. Usar cuando pidan publicar, subir o deployar el sitio LK, o cuando pregunten que le falta a loekemeyer.com.
---

# Publicar en loekemeyer.com

`loekemeyer.com` corre sobre **IIS administrado con SolidCP** y se publica **a mano**:
el push a `main` NO lo actualiza. Lo que el push actualiza es GitHub Pages
(`https://loekemeyer.github.io/pagina-LK-copia/`), que sirve para mirar los
cambios pero no es lo que ven los clientes.

Subir el sitio entero no funciona: son ~31 MB y el File Manager de SolidCP corre
sobre IIS, que corta las subidas grandes. Por eso se sube **solo el delta**, que
en un dia normal de trabajo son unos cientos de KB.

## Pasos

### 1. Averiguar que version esta publicada

Pedirsela al usuario ("¿que dice el footer de loekemeyer.com?") o, si la sesion
tiene salida a internet, leerla:

```bash
curl -s "https://www.loekemeyer.com/version.js?nocache=$RANDOM" | grep -o 'APP_VERSION = "[^"]*"'
```

En las sesiones remotas de Claude Code el proxy suele **bloquear ese dominio**;
en ese caso hay que preguntarle el numero al usuario, no adivinarlo.

### 2. Ubicar el commit de esa version

Cada bump escribe el numero en `version.js`, asi que `-S` lo encuentra. Devuelve
dos commits (el que la puso y el que la saco): el que la puso es **el mas viejo**.

```bash
git log --format=%H -S "2.3.374" -- version.js | tail -1
```

### 3. Armar el ZIP con el delta

```bash
git diff --name-only <commit_base> HEAD \
  | grep -vE '^(web\.config$|\.locks/|hooks/|scripts/|docs/|sql/|supabase/|\.github/)|\.md$|\.sql$|^LOCKS\.txt$|^config-claude\.json$|^caveman-state\.json$|^vercel\.json$|^\.gitignore$' \
  | while read f; do [ -f "$f" ] && echo "$f"; done > /tmp/delta.txt

rm -rf /tmp/zip && mkdir -p /tmp/zip
while read f; do mkdir -p "/tmp/zip/$(dirname "$f")"; cp "$f" "/tmp/zip/$f"; done < /tmp/delta.txt
(cd /tmp/zip && zip -qr /tmp/deploy.zip .)
```

**Nunca incluir `web.config`.** El del servidor IIS es el unico que existe (no
esta en el repo) y pisarlo tira el sitio entero: ya paso una vez, ver CLAUDE.md.
Tampoco van `sql/`, `docs/`, `supabase/` ni los `.md`: son material interno.

Antes de entregarlo, verificar que el ZIP no traiga nada de eso:

```bash
unzip -l /tmp/deploy.zip | grep -cE 'web\.config|sql/|docs/|supabase/|\.md$'   # tiene que dar 0
```

### 4. Entregarlo

Mandarlo con `SendUserFile` y decirle al usuario:

1. SolidCP → File Manager → la **raiz** del sitio.
2. Subir el ZIP y **descomprimir ahi mismo, en la raiz** — adentro vienen
   `css/`, `img/`, `osa/`, `tyl/` y tienen que caer en su lugar.
3. Borrar el ZIP del servidor.
4. `Ctrl+F5` y confirmar que el footer muestra la version nueva.

## La via sin ZIP: FTP

`scripts/deploy-iis.ps1` hace todo esto desde Windows, y con `-Mode Ftp` ademas
**sube los archivos solo**, sin File Manager:

```powershell
.\scripts\deploy-iis.ps1 -Simular     # lista que falta, sin tocar nada
.\scripts\deploy-iis.ps1              # arma el .zip del delta
.\scripts\deploy-iis.ps1 -Mode Ftp    # sube el delta directo
```

Para el modo Ftp hacen falta las credenciales del hosting, que salen de
**SolidCP → Hosting Space → FTP Accounts**, en `scripts/deploy-iis.local.json`:

```json
{ "host": "ftp.loekemeyer.com", "usuario": "...", "clave": "...", "carpetaRemota": "/", "ftps": true }
```

Ese archivo **nunca va al repo** (esta en `.gitignore`): el repositorio es
publico. Claude no puede correr el `.ps1` ni subir por FTP desde una sesion
remota — el proxy solo deja pasar HTTPS —, asi que desde el chat el entregable
es siempre el ZIP.

## Ojo con el espejo

Si lo que se publica toca archivos del panel admin, ademas hay que replicarlos
al `/admin/` de `loekemeyer/Gestion-Virgilio`. La lista de archivos espejados y
los ajustes propios que NO se deben pisar estan en `CLAUDE.md`.
