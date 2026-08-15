# Módulo EXPO — resumen global para replicar en otros repos

Plataforma para **tomar pedidos en una exposición** desde el sitio mayorista:
el operador (admin) elige un cliente existente o da de alta uno nuevo, le arma
el pedido con precios reales, y cierra pasándole PIN + resumen por WhatsApp.
Construido sobre `pagina-LK-copia`. Este documento sirve para replicarlo en los
repos de las otras dos empresas.

> **Importante al replicar:** cada empresa tiene su **propio proyecto Supabase**
> y su propio esquema. Los nombres de tablas/columnas y el project ref son
> LK-específicos. Abajo se marca qué es genérico y qué hay que adaptar.

---

## 1. Arquitectura / decisiones

- **El operador entra como admin** (en LK, cliente cod 1). Toda la lógica expo
  está gateada a admin.
- **Se reemplaza el selector "Elegir razón social"** (dropdown de clientes
  vinculados) por una barra **[Elegir cliente] [+ Nuevo cliente]**.
- **Cliente nuevo = híbrido, forzado por los requisitos:** para que el pedido
  vaya al flujo normal, se pueda descargar y el cliente tenga PIN, se crea en
  `customers` + `auth`. **En paralelo** se registra en una tabla staging
  (`expo_clientes_pendientes`) que es "el otro módulo" para levantarlos al ERP
  después, todos juntos.
- **El pedido va a `orders` normal** (mismo `submit_order_fast` + Sheets).
- **Descuentos del cliente nuevo (1ª compra):** volumen por **escala** (según
  monto de LISTA del pedido, en vivo) + **contado –25% obligatorio** + web –2%.
  Los clientes **existentes** no cambian en nada.
- **NO se espeja a otros paneles** (en LK: no va al espejo Virgilio). Es
  específico de esta copia.

---

## 2. Backend (SQL) — 3 objetos nuevos

Están en `sql/expo.sql`. Adaptar `admins`, `customers`,
`customer_delivery_addresses` a los nombres de cada proyecto.

### 2.1 `buscar_cliente_expo(p_q text)` — buscador del popup "Elegir cliente"
Busca por **cód / razón social / CUIT (solo dígitos, ≥6) / dirección de entrega
o localidad**. `SECURITY DEFINER`, gate admin, solo lectura. Revocar `EXECUTE`
a `public`, dar a `authenticated, service_role`.

### 2.2 `expo_clientes_pendientes` — staging para el ERP
Una fila por cliente nuevo (customer_id + snapshot: razón, cuit, dir/loc/prov,
whatsapp, mail, vend, dto, pin, direcciones_entrega jsonb, estado
`pendiente`/`cargado_erp`). RLS: todo para admin.

### 2.3 `expo_dto_escala` — escala de descuento por volumen (editable)
Filas `(desde numeric, dto numeric 0..1)`. RLS: **lectura abierta**, escritura
admin. Semilla LK confirmada:

| Desde (monto lista) | Dto |
|---|---|
| 0 | 0% |
| 600.000 | 2% |
| 1.000.000 | 4% |
| 1.500.000 | 6% |
| 2.300.000 | 8% |
| 4.000.000 | 10% |
| 6.000.000 | 12% |

> La escala salió de analizar el padrón real (dto_vol vs tamaño de pedido). En
> cada empresa **recalcular** con sus datos antes de sembrar.

---

## 3. Frontend

### 3.1 `script.js` (mayorista) — entrada + nuevo cliente + pricing
- **`EXPO_MODE`, `_expoClientMode`, `_expoScale`** (constantes/estado, arriba).
- **`renderCustomerSelector()`**: rama temprana → si `EXPO_MODE && isAdmin`,
  llama `renderExpoEntryBar()` y corta (no dibuja el dropdown viejo).
- **`renderExpoEntryBar()`**: barra con chip del cliente + botones + un
  `<select id="customerSelect">` OCULTO (lo leen `onLinkedCustomerSelected` y el
  gate de submit — no romper eso).
- **Popup Elegir cliente**: `expoOpenPickModal` / `_expoRunSearch` (RPC
  `buscar_cliente_expo`, debounce 250ms) / `expoApplyCustomer`.
- **`expoApplyCustomer(cust, opts)`**: registra en `linkedCustomers`, setea el
  select oculto, detecta si es cliente-expo (staging) → prende `_expoClientMode`,
  carga la escala, y reusa **`onLinkedCustomerSelected({customerId})`** para
  cargar el perfil (a esa función se le agregó el parámetro `opts.customerId`).
- **Modal Nuevo cliente**: `expoNuevoCliente` / `_expoGuardarNuevo(pauseOnly)` /
  repetidor de direcciones. Porta `generatePassword30` + `createAuthUser` desde
  `admin.js`. **Pausar** = guarda parcial (customers+auth+staging+direcciones) y
  permite volver; **Guardar y cargar pedido** = handoff a `expoApplyCustomer(..,
  {forceExpoNew:true})`.
- **Pricing (el nudo):** el operador es admin, y el pricing tenía ramas
  `isAdmin`/`isListPriceOnlyClient()` que anulan descuentos. Se introdujo el
  "modo cliente-expo" tocando POCAS primitivas:
  - `isListPriceOnlyClient()` → `false` en modo expo.
  - `getPaymentDiscount/Text/Code` → **contado forzado** en modo expo.
  - 3 sitios `isAdmin ? 0 : WEB_ORDER_DISCOUNT` → `(isAdmin && !_expoClientMode)`.
  - `showTuPrecio` → visible en modo expo.
  - **`_expoSyncDto()`** (llamado al tope de `renderProducts`/`updateCart`)
    escribe `customerProfile.dto_vol = escala(subtotalLista)` — así TODO el
    pricing lee el mismo dto y recalcula en vivo.
  - Todo esto queda **inerte** cuando `_expoClientMode` es false (clientes
    normales sin cambios).
- **Confirmación**: `_expoShowConfirmPanel()` (llamado tras
  `showSection("pedidoConfirmado")`) muestra el PIN y arma el link `wa.me` con
  resumen + dto otorgado + PIN.

### 3.2 `mayorista.html`
Dos modales nuevos (`#expoPickModal`, `#expoNewModal`) + panel
`#expoConfirmPanel` dentro de `#pedidoConfirmado`.

### 3.3 `css/styles.css`
Bloques `.expo-entry-bar`, `.expo-pick-*`, `.expo-new-*`, `.expo-confirm-*`.

### 3.4 `admin.html` + `admin.js` — editor de la escala
Nav item `data-page="escala-expo"` + `<section id="escala-expo">` +
`cargarEscalaExpo` / `guardarEscalaExpo` (delete+insert de `expo_dto_escala`).
Hook lazy-load en el router de `.nav-item`.

---

## 4. Checklist para replicar en otro repo

1. **Confirmar el gate de admin** (tabla equivalente a `admins` + `auth.uid()`).
2. **Verificar el esquema `customers`**: necesita `cuit`, `dto_vol`, `pin`,
   `auth_user_id`, `whatsapp`, `direccion_fiscal`, `localidad`. Si falta alguna,
   ajustar el alta.
3. **Verificar `customer_delivery_addresses`** (o equivalente) con
   `direccion_entrega`, `localidad`, `provincia`, `slot`, `label`.
4. **Correr `sql/expo.sql`** adaptado (3 objetos). Recalcular la escala con los
   datos de esa empresa.
5. **Portar los bloques de `script.js`** (marcados con comentarios `EXPO`) +
   los 2 modales/1 panel de `mayorista.html` + el CSS.
6. **Adaptar las primitivas de pricing** a cómo esa empresa gatea admin/list
   price (los nombres de función pueden diferir).
7. **Editor de escala** en su panel admin.
8. **Login del operador como admin** en la expo.

---

## 5. Pendiente / a probar

- **Falta prueba en navegador de punta a punta** (se construyó sin runtime):
  crear cliente → pausar/reanudar → cargar pedido → ver dto por escala en vivo →
  confirmar → PIN + WhatsApp.
- **CUIT ya existente en auth**: el cliente se crea sin login (mismo
  comportamiento que el alta de admin).
- **Número de WhatsApp**: si el cliente no lo cargó, el link `wa.me` abre sin
  destinatario (el operador elige el contacto).
