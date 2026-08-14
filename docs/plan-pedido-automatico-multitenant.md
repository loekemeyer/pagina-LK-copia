# Plan — Pedido Automático multi‑tenant (abrirlo a muchos clientes)

> Documento de planificación. **No se tocó código ni base** todavía. Pensado para
> revisar antes de implementar. Fecha: 2026‑06‑26.

## 1. Objetivo

Hoy el módulo **Pedido Automático** (ex "Formato OSA") está armado para **2 clientes
especiales**: OSA (`2533`) y Torres y Liva (`288`). Queremos poder **habilitarlo a
cualquier cliente** sin que se vuelva inmanejable.

Decisiones del cliente ya tomadas:

- **Cada cliente carga su propio máximo** por artículo (self‑service). No precargamos máximos.
- **El catálogo no se limita a los 18 meses**: si un cliente carga stock / máximo de un
  artículo que NO compró en los últimos 18m, igual debe entrar a su stock.
- Al **activar** un cliente, su lista arranca **precargada con su surtido de los últimos
  18 meses** (máximo en blanco), pero puede agregar/quitar cualquiera de los 260 artículos.

## 2. Por qué no sirve replicar lo de hoy

Arquitectura actual (pensada para 2 clientes, riesgo cero):

- **5 tablas por cliente**: `x_articulos`, `x_ventas`, `x_entregas`, `x_ajustes`, `x_config`.
- **1 carpeta + `index.html`** por cliente (`osa/`, `tyl/`).
- **1 entrada** por cliente en `FORMATO_CLIENTES` (en `script.js`).

Datos reales de la base:

- **1.241 clientes** en `customers`.
- **260 productos** en `products` (201 activos), **todos con `uxb`** (unidades por caja).

Replicar el molde actual para todos ⇒ **~6.200 tablas** (5 × 1.241) y ~1.241 archivos HTML.
Inmanejable (backups, RLS, panel de Supabase). **No es por el peso de la página** — el
navegador descarga el mismo código compartido siempre; cada cliente baja solo sus datos.
El problema es el **desorden en el backend**.

## 3. Arquitectura objetivo (multi‑tenant)

### 3.1 Backend — 5 tablas únicas, todas con `cod_cliente`

En lugar de 5 tablas por cliente, **5 tablas para todos**, particionadas por `cod_cliente`:

| Tabla | Rol | Columnas clave |
|---|---|---|
| `pa_articulos` | lista que trackea cada cliente (su overlay) | `id bigserial`, `cod_cliente`, `codigo`, `nombre`, `uxc`, `stock_inicial`, `stock_maximo`, `activo`, `updated_at` · **UNIQUE(cod_cliente, codigo)** |
| `pa_entregas` | entregas de Loke al cliente (suma stock) | igual a `osa_entregas` pero se lee/filtra por `cod_cliente` |
| `pa_ventas` | ventas del cliente a los suyos (resta stock) | igual a `osa_ventas` filtrado por `cod_cliente` |
| `pa_ajustes` | ajustes manuales de stock | `cod_cliente`, `codigo`, `unidades`, `fecha`, `motivo` |
| `pa_config` | config por cliente | `cod_cliente` (PK), `empresa`, `cliente`, demás flags |

Notas de diseño:

- Se **abandona** el esquema de id `'a_'+codigo` (colisiona entre clientes). PK surrogate
  + `UNIQUE(cod_cliente, codigo)`. Los movimientos referencian `(cod_cliente, codigo)`.
- `nombre`/`uxc` se **denormalizan** en `pa_articulos` al agregar el artículo (copiados de
  `products.description` / `products.uxb`), igual que hoy — así el formato lee solo `pa_*`.
- **RLS obligatorio**: cada fila visible/editable solo si su `cod_cliente` pertenece al
  usuario autenticado (vía el link `auth_user_id → cod_cliente` que ya usa el sitio). Esto
  es lo más sensible del refactor y se testea aparte.

### 3.2 Catálogo maestro y "agregar cualquier artículo"

- El maestro es **`products`** (260 filas, `cod` + `description` + `uxb` + `images` + `category`).
- En el módulo, un **buscador sobre `products`**: el cliente elige un `cod` → se inserta en
  su `pa_articulos` con `uxc = products.uxb`, `nombre = products.description`, `stock_maximo`
  el que cargue él, y el stock que cargue. **Un código fuera de sus 18m entra sin problema.** ✅
- Los 18m son solo un **atajo de arranque** (ver 3.4), no un límite.

### 3.3 Front‑end — una sola página dinámica

- Una página **`pedido-automatico.html`** (reemplaza a `osa/index.html` + `tyl/index.html`).
- En vez de `window.__formatoCfg` hardcodeado por página, `store.js` **deriva la config de
  la sesión**: lee el `cod_cliente` del cliente logueado y arma `CFG` en runtime.
- `store.js` pasa a **filtrar y sellar `cod_cliente`** en cada lectura/escritura (hoy cada
  cliente tenía su propia tabla, así que no filtraba).
- `app.js`: se agrega el **buscador "Agregar artículo"** (sobre `products`) y se asegura que
  la solapa **"Máximos por Código"** sea **editable** y persista en `pa_articulos.stock_maximo`.

### 3.4 Arranque de un cliente nuevo (precargado con 18m)

Al activar un cliente:

1. Se siembra `pa_articulos` con su **surtido de los últimos 18 meses** (RPC
   `get_my_assortment_18m` ya existe), con `stock_maximo = null` y `stock_inicial = 0`.
2. El cliente entra, **carga sus máximos** y su **stock inicial**, y **agrega** lo que falte
   desde el catálogo completo.

### 3.5 Acceso — un flag, no una lista

- Nueva columna **`customers.pedido_automatico boolean default false`**.
- El chooser "Pedido Automático" (al loguear) y el ítem de menú aparecen **solo si el cliente
  tiene el flag en `true`**.
- Se **elimina** la lista hardcodeada `FORMATO_CLIENTES` de `script.js`; el gate pasa a leer
  el flag del perfil ya cargado en sesión.

## 4. Migración de OSA y Torres y Liva

OSA y TyL pasan a ser **dos clientes más** del modelo unificado:

1. Copiar `osa_articulos`/`osa_ventas`/`osa_entregas`/… → `pa_*` sellando `cod_cliente = 2533`.
2. Idem `tyl_*` → `pa_*` con `cod_cliente = 288`.
3. Poner `pedido_automatico = true` en esos dos clientes.
4. **Reapuntar la sync de Virgilio**: la Edge Function `virgilio-entrega-sync` deja de escribir
   en `osa_entregas`/`tyl_entregas` y pasa a escribir en **`pa_entregas`** (con `cod_cliente`).
   El trigger en *Control Partes* no cambia.
5. Verificar y recién entonces **deprecar** (renombrar, no borrar de una) las `osa_*`/`tyl_*`.

## 5. Pasos de implementación (por fases, con verificación entre cada una)

1. **DDL**: crear `pa_*` + índices (`cod_cliente`, `(cod_cliente, codigo)`) + RLS. (no toca lo vivo)
2. **store.js multi‑tenant**: derivar `CFG` de la sesión, filtrar/sellar `cod_cliente`.
3. **app.js**: buscador "Agregar artículo" + máximos editables.
4. **Página** `pedido-automatico.html` dinámica + chooser por flag.
5. **Migrar OSA/TyL** a `pa_*` y reapuntar la Edge Function de Virgilio.
6. **Pruebas** con OSA y TyL (que todo siga igual) + 1 cliente nuevo de prueba.
7. **Deprecar** `osa_*`/`tyl_*` y el código viejo (`osa/`, `tyl/`, `FORMATO_CLIENTES`).

## 6. Riesgos y mitigación

- **RLS mal configurado** ⇒ un cliente vería datos de otro. Mitigación: políticas por
  `cod_cliente` + test explícito con dos usuarios antes de habilitar a nadie.
- **Regresión en OSA/TyL** (ya en producción). Mitigación: migrar al final, mantener `osa_*`/
  `tyl_*` intactas hasta validar, rollback = reapuntar a las viejas.
- **`uxc` faltante** para algún código. No aplica: los 260 de `products` tienen `uxb`.
- **Doble fuente de verdad temporal** durante la migración. Mitigación: ventana corta, cutover
  atómico de la Edge Function.

## 7. Lo que NO cambia

- El peso/los archivos que descarga el navegador (mismo código compartido).
- La lógica de stock del módulo (stock = inicial + entregas − ventas ± ajustes).
- El trigger de `Entregas_Virgilio` en *Control Partes Talleristas*.

## 8. Esfuerzo estimado

Refactor **grande pero acotado**: el grueso es `store.js` (multi‑tenant + RLS) y el buscador
de artículos en `app.js`. La migración de OSA/TyL es mecánica. Sin frameworks, sin build.

## 9. Decisiones ya tomadas vs. abiertas

**Tomadas:** máximos self‑service · catálogo completo (260) · arranque precargado con 18m ·
entregas de Virgilio como entrega (suma stock) · sync solo en INSERT.

**Abiertas (a confirmar antes de implementar):**

- ¿La columna del flag va en `customers` o en una tabla `pa_clientes` aparte?
- ¿`stock_inicial` lo carga el cliente una sola vez al activarse, o editable siempre?
- ¿Deprecamos `osa/` y `tyl/` (URLs viejas) o las dejamos redirigiendo a la página nueva?
