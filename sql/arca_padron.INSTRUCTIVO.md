# Estado de actividad de clientes (fuente ARCA) — instructivo para terminarlo

**Última actualización: 3/8/2026**

---

## Qué queremos lograr

Que el panel diga, para cada uno de nuestros clientes, si **se dio de baja**,
si **falleció** o si **posiblemente sigue en actividad**, consultando el padrón
de ARCA por CUIT.

El módulo ya está construido y andando en Estadística Clientes → **Estado de
actividad de clientes**. Lo que falta es la pieza que va a buscar los datos a
ARCA. La otra fuente del módulo, el BCRA, **ya funciona**: su API es pública y
la consulta el propio navegador, sin nada de lo que sigue.

---

## Cómo está repartido el trabajo

| | Estado | Quién |
|---|---|---|
| Tabla, estado derivado, módulo del panel, buscador, filtros | ✅ **Hecho** | Ya está |
| Conseguir el certificado de ARCA | ⬜ Falta | **Vos** (requiere clave fiscal) |
| Elegir dónde corre el consultador | ⬜ Falta | Decisión tuya |
| Programar el consultador | ⬜ Falta | Yo, cuando estén las dos de arriba |

Hoy el módulo muestra los 1.245 clientes con el cartel **"Sin consultar"**.
No está roto: está esperando los datos.

---

## Antes de empezar, asegurate de tener

- [ ] La **clave fiscal de Loekemeyer SRL**, con **nivel de seguridad 3**.
      (Si al entrar a servicios te pide "elevar el nivel", es esto.)
- [ ] Que quien haga el trámite sea el **administrador de relaciones** de ese
      CUIT — normalmente el representante legal — o que tenga la delegación.
- [ ] Una computadora con **openssl**. En Mac y Linux ya viene. En Windows viene
      con Git para Windows (usar "Git Bash").

Si alguna de las dos primeras no se cumple, ese es el primer paso: sin eso no se
puede avanzar.

**Tiempo estimado de la Parte 1: entre 20 y 40 minutos**, si no hay que resolver
antes el tema de la clave fiscal.

---

# PARTE 1 — Conseguir el certificado

## ¿Por qué hace falta un certificado?

ARCA no deja consultar el padrón con usuario y contraseña. Te pide un
**certificado digital**: dos archivos que funcionan como una llave y una
cerradura. Uno es público (el certificado) y el otro es secreto (la clave
privada).

La clave privada **no puede estar en la página web**. Nuestro repositorio es
público y se publica en internet, así que cualquiera podría descargarla y hacer
consultas a nombre de Loekemeyer. Por eso las consultas las va a hacer un
programa aparte, en un servidor.

---

### Paso 1 — Generar tus dos archivos

Abrí una terminal (o Git Bash en Windows), entrá a una carpeta donde quieras
guardarlos, y pegá esto:

```bash
openssl genrsa -out loekemeyer.key 2048
```

Eso crea `loekemeyer.key`. **Este es el archivo secreto.** No se manda por mail,
no va al repositorio, no se pega en un chat.

Ahora creá el pedido de certificado:

```bash
openssl req -new -key loekemeyer.key -subj "/C=AR/O=Loekemeyer SRL/CN=padron/serialNumber=CUIT 30515842450" -out loekemeyer.csr
```

Eso crea `loekemeyer.csr`. **Este sí se sube a ARCA**, no tiene nada secreto.

> Si decidís consultar con otro CUIT, cambiá el número en `serialNumber`.
> El formato tiene que ser exactamente `CUIT ` seguido de los 11 dígitos sin
> guiones.

**Cómo saber que salió bien:** en la carpeta tienen que estar los dos archivos,
y `loekemeyer.csr` abierto con un editor de texto empieza con
`-----BEGIN CERTIFICATE REQUEST-----`.

---

### Paso 2 — Entrar a ARCA

Andá al sitio de ARCA e ingresá con la **clave fiscal de Loekemeyer SRL**.

Buscá el servicio **"Administrador de Relaciones de Clave Fiscal"**.

> Si no aparece en tu lista de servicios, hay que habilitarlo primero desde
> "Administrador de Relaciones" del representante legal.

---

### Paso 3 — Subir el pedido y bajar el certificado

Dentro del Administrador de Relaciones, buscá la opción de **certificados
digitales** (según la versión del sitio puede llamarse "Administración de
Certificados Digitales" o similar).

1. Elegí crear un certificado nuevo.
2. Ponele un **alias**. Sugerencia: `padron-panel`. Anotalo, lo vas a necesitar
   en el paso siguiente.
3. Subí el archivo **`loekemeyer.csr`**.
4. Descargá el certificado que te devuelve. Va a ser un archivo `.crt` (o `.pem`).
   Guardalo junto a los otros dos.

**Ahora tenés tres archivos.** Los que importan son:
- `loekemeyer.key` → **secreto**
- el `.crt` que bajaste → público

---

### Paso 4 — Autorizar el servicio al certificado ⚠️

**Este es el paso que más se olvida.** Tener el certificado no alcanza: hay que
decirle a ARCA que ese certificado puede usar el servicio del padrón.

Volvé al **Administrador de Relaciones** y:

1. Elegí **"Nueva Relación"**.
2. En el buscador de servicios, buscá **"Consulta a Padrón A5"**.
   (El nombre técnico es `ws_sr_padron_a5`.)
3. Cuando te pregunte a quién asignárselo, elegí el **alias del paso 3**
   (`padron-panel`).
4. Confirmá.

**Por qué insisto:** si te salteás este paso, todo va a parecer correcto hasta
el final. El certificado va a autenticar bien, y recién al consultar el padrón
va a fallar con un error que no dice "te falta autorizar el servicio". Se pierde
mucho tiempo buscando el problema en el lugar equivocado.

---

### Paso 5 — Guardar las credenciales donde corresponde

Los dos archivos (`.key` y `.crt`) van a ir a un lugar seguro: las credenciales
de n8n o los secretos de Supabase, según lo que decidamos en la Parte 2.

**Mientras tanto:**
- ❌ No los subas al repositorio
- ❌ No me los pegues en el chat
- ❌ No los mandes por mail o WhatsApp
- ✅ Guardalos en un gestor de contraseñas o en una carpeta que no se sincronice

---

### Paso 6 — Avisame

Cuando tengas los archivos y el servicio autorizado, avisame y seguimos con la
Parte 3. **No necesito ver los archivos**, solo saber que existen.

---

# PARTE 2 — Elegir dónde corre el consultador

Hay que decidir una de dos. Te doy mi recomendación y qué implica cada una.

### Opción A — n8n ⭐ recomendada

Ya lo tenés funcionando y con acceso a la base.

- ✅ Las herramientas para firmar el pedido a ARCA son nativas ahí
- ✅ Programar la corrida mensual es arrastrar un nodo
- ✅ Si algo falla, se ve el error en la pantalla de n8n
- ➖ Es una pieza más, fuera de Supabase

### Opción B — Supabase Edge Function

Queda todo dentro de Supabase, junto a las funciones que ya usamos para Google
Sheets.

- ✅ Todo en un solo lugar
- ✅ El botón "revisar" del panel podría volverse instantáneo
- ➖ La firma que pide ARCA es bastante más difícil de hacer en ese entorno
- ➖ Más trabajo de mi lado, y más superficie para que algo salga mal

**Mi recomendación: la A.** Con la opción A el botón "revisar" del panel deja el
cliente primero en la fila y lo consulta la próxima corrida, que para este caso
es más que suficiente.

**Decisión pendiente #2: ¿con qué CUIT consultamos?** Lo natural es el de
Loekemeyer SRL, que es el que usamos en el ejemplo del Paso 1.

---

# PARTE 3 — El consultador (esto lo hago yo)

> Esta parte es técnica. Si no la vas a programar vos, podés saltearla: está acá
> para que quede documentado y para quien lo implemente.

## Cómo se conecta con lo que ya existe

El consultador **no toca la tabla directamente**. Usa dos funciones, para que
podamos cambiar de n8n a Edge Function sin tocar la base:

| Función | Para qué |
|---|---|
| `arca_padron_pendientes(p_limit)` | Devuelve qué CUITs hay que consultar |
| `arca_padron_registrar(...)` | Deja el resultado de una consulta |

Las dos corren **solo con service key**: les revoqué el permiso a `anon` y a
`authenticated`.

## Autenticarse contra ARCA (WSAA)

1. Armar un **TRA**: un XML chico con un id único, la hora de generación, la de
   vencimiento y el servicio (`ws_sr_padron_a5`).
2. **Firmarlo** en formato CMS/PKCS#7 con el `.crt` y el `.key`.
3. Mandarlo al `LoginCms` de WSAA.
4. Guardar el **token** y el **sign** que devuelve.

> ⚠️ **El token dura unas 12 horas y hay que guardarlo.** Si se pide uno nuevo
> por cada cliente, ARCA rechaza los pedidos repetidos. Una corrida de 1.229
> clientes tiene que usar **un solo** token.

Las direcciones de WSAA y del padrón conviene confirmarlas contra la
documentación vigente: con el pasaje de AFIP a ARCA algunos dominios se fueron
migrando.

## El ciclo

```
token = obtenerTokenWSAA()                       # UNA sola vez por corrida
pendientes = rpc('arca_padron_pendientes', { p_limit: 300 })

para cada cuit en pendientes:
    r = consultarPadronA5(token, cuitConsultante, cuit)

    rpc('arca_padron_registrar', {
        p_cuit: cuit,
        p_estado_clave: r.estadoClave,                  # ACTIVO / INACTIVO
        p_tipo_persona: r.tipoPersona,                  # FISICA / JURIDICA
        p_razon_social: r.razonSocial || (r.apellido + ' ' + r.nombre),
        p_fecha_fallecimiento: r.fechaFallecimiento,    # solo personas físicas
        p_tiene_impuestos_activos: <hay algún impuesto sin fecha de baja>,
        p_fecha_baja: <la baja más reciente entre los impuestos>,
        p_raw: r,                                       # la respuesta COMPLETA
        p_error: null
    })

    esperar un poco entre llamadas          # hay cuotas de uso
```

**Si ARCA devuelve error o el CUIT no existe:** mandar `p_error` con el mensaje
y el resto en null. Esa fila se reprograma sola a 7 días en vez de a un mes,
para no quedar reintentando lo mismo en cada corrida.

**Los nombres de campo de arriba son aproximados.** Hay que ajustarlos contra la
respuesta real la primera vez. Por eso guardamos `p_raw` con la respuesta
completa: si después afinamos el criterio, se recalcula sin volver a consultar
los 1.229.

## Cada cuánto

Mensual. La fila que se acaba de consultar queda programada para dentro de un
mes, así que la lista de pendientes se rearma sola — **no hace falta ningún
proceso que "marque" nada**. Lo único que hay que programar es que el
consultador se despierte una vez por mes.

Si preferís partirlo en tandas, `p_limit` lo permite: lo que no se consultó
sigue pendiente para la próxima.

---

# PARTE 4 — Cómo saber que funcionó

**En el panel:** Estadística Clientes → **Estado de actividad de clientes**. Las seis tarjetas de
arriba tienen que dejar de estar todas en cero.

**En la base**, si querés mirar más fino:

```sql
-- ¿Cuántos faltan consultar?
select count(*) from arca_padron_pendientes(100000);

-- ¿Cómo quedó repartido?
select estado_arca, count(*) from v_clientes_arca group by 1 order by 2 desc;

-- ¿Alguno falló?
select cuit, error, consultado_at from arca_padron where error is not null;
```

---

# Si algo falla

| Lo que ves | Qué suele ser | Qué hacer |
|---|---|---|
| Error de autenticación en WSAA | El certificado venció o está mal el par `.crt`/`.key` | Verificar que sean del mismo pedido (Paso 1) |
| Autentica bien pero el padrón rechaza | **Falta el Paso 4** | Autorizar "Consulta a Padrón A5" al alias |
| Andaba y de golpe rechaza todo | Se pidió un token nuevo por cada cliente | Cachear el token (dura ~12 h) |
| Un CUIT puntual da error siempre | Puede no existir en el padrón | Queda registrado con su error y se reintenta a los 7 días |
| Todo sigue en "Sin consultar" | El consultador no corrió, o no usó la service key | Revisar el log de n8n |

---

# Glosario

- **Padrón**: el registro de contribuyentes de ARCA.
- **Certificado digital**: el par de archivos que nos identifica ante ARCA.
- **Clave privada** (`.key`): la mitad secreta. Si se filtra, hay que revocar el
  certificado y volver a empezar.
- **WSAA**: el servicio de ARCA que entrega el permiso temporal para consultar.
- **Token**: ese permiso temporal. Dura unas 12 horas.
- **Service key**: la llave de máxima confianza de Supabase. Solo la usa el
  consultador, nunca el navegador.

---

# Decisiones que quedan abiertas

1. **¿n8n o Edge Function?** (Parte 2 — recomiendo n8n)
2. **¿Con qué CUIT consultamos?** (normalmente Loekemeyer SRL)
3. **Los 16 CUITs con prefijo 99.** Son placeholders, no CUITs reales, y hoy
   quedan afuera por decisión tomada. Si se corrigen a mano, entran solos.
4. **¿Qué otros módulos usan este dato?** Dejé lista la vista `v_clientes_arca`
   como interfaz, pero **todavía no la usa nadie**. El candidato natural es el
   Ranking Inactivos: un cliente fallecido o dado de baja no es "recuperable".
   Si conviene marcarlo, excluirlo o no hacer nada es una decisión de negocio.
5. **¿Qué se hace con un fallecido o una baja?** Hoy el módulo informa y nada
   más: no modifica la ficha del cliente ni lo saca de ningún listado.
