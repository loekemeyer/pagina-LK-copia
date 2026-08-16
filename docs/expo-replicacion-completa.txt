# Módulo EXPO — guía completa de replicación

**Objetivo de este documento:** recrear desde cero el módulo "Expo" (tomar
pedidos en una exposición desde el sitio mayorista) en **otro repo** de otra
empresa/marca, con **su propio proyecto Supabase**. Es autocontenido: incluye el
DDL SQL real (verificado contra la base LK el 16/8/2026), el inventario de
funciones de frontend, el HTML/CSS, los cambios de pricing y los gotchas con su
causa.

> **Convención:** cada bloque marca **[LK-específico]** (nombres, project ref,
> escala, listas de datos — hay que **adaptarlos**) o **[Genérico]** (lógica que
> se copia igual). El project ref LK es `kwkclwhmoygunqmlegrg`; el esquema de
> `customers` / `customer_delivery_addresses` / `admins` / `orders` /
> `loke_access` es el de este repo. En otra empresa esos nombres pueden diferir.

> **Verificado contra la base LK (16/8/2026):** varios objetos DESPLEGADOS
> difieren de lo que dice `sql/expo.sql`. Este documento refleja lo desplegado,
> que es la fuente de verdad. Diferencias marcadas con ⚠️.

---

## 1. Overview y flujo de negocio

El **operador** entra al sitio mayorista logueado como **admin** (en LK es
Loekemeyer SRL, cód de cliente `1`). Toda la lógica expo está gateada a
`EXPO_MODE && isAdmin`. Cuando `EXPO_MODE` está activo, el selector normal
"Elegir razón social" (dropdown de razones vinculadas al vendedor) **se
reemplaza** por una barra de entrada con:

- **Chip del cliente activo** (razón social + cód + dto, o "Sin cliente
  seleccionado"), con una cruz "×" para soltar el cliente y volver al perfil del
  operador.
- **[Elegir cliente]** — abre un popup de búsqueda sobre TODO el padrón.
- **[+ Nuevo cliente]** — abre el modal de alta.
- **[Continuar carga pausada / ✓ Editar cliente]** — visible solo con un cliente
  de expo activo; relee el staging y reabre el modal de alta para completar datos.

### Flujo típico en la expo

1. Llega un cliente al stand → operador toca **+ Nuevo cliente**.
2. Con SOLO la razón social ya puede tocar **"Pausar y cargar pedido"**: registra
   al cliente parcial (`customers` + `auth` + staging + direcciones) y va al
   catálogo. El código de cliente lo asigna el sistema (contador propio).
3. Arma el pedido en cajas. En vivo aparece la **barra de checkpoints** del
   descuento por volumen (según el subtotal de LISTA del carrito).
4. Se piden los datos que faltan (CUIT, condición IVA, vendedor, WhatsApp, mail,
   dirección fiscal, direcciones de entrega). El botón **"Datos completados"**
   (verde) se habilita EN VIVO solo cuando está TODO salvo el expreso.
5. Va al carrito. El pago es **Contado (–25%)** forzado por ser 1ª compra.
6. **Confirmar pedido** (se deshabilita apenas se toca; anti doble-click).
7. Pantalla **"¡Pedido confirmado!"** — muestra en pantalla el **N° de pedido**
   (chip verde: prueba concreta de que quedó grabado) + **panel de cierre**. El
   panel aparece para **cualquier cliente de expo** (nuevo o elegido del padrón),
   no solo los nuevos. Trae tres botones: **Descargar pedido** (PDF), **Copiar
   resumen** (al portapapeles) y **Escribir al cliente por WhatsApp** (`wa.me`).
   El **bot NO manda nada solo**: el operador toca el botón `wa.me` y desde el
   **teléfono de ventas** se abre el chat con el texto ya cargado ("¡Tu pedido
   fue confirmado! ✅" + resumen) listo para enviar. Solo para **cliente nuevo**
   el resumen agrega el **PIN** (usuario = CUIT, clave = PIN) para sus compras
   online futuras.

### Decisiones de arquitectura

- **El pedido va a `orders` normal** (mismo `submit_order_fast` + push a Sheets).
  El cliente de expo NO es un caso especial para el submit; es un `customers`
  real con su `auth`.
- **Cliente nuevo = híbrido.** Se crea en `customers` + `auth` (para que el
  pedido/PIN/descarga funcionen y pueda loguearse online después) **y en paralelo**
  se registra en `expo_clientes_pendientes` (staging), que es la lista para
  levantarlos al ERP (ISIS) todos juntos más tarde.
- **Los clientes EXISTENTES no cambian en nada.** Elegir un cliente del padrón
  cotiza con SUS descuentos reales, como cualquier cliente logueado.
- **El aviso al cliente lo manda el OPERADOR a mano, no un bot.** El panel de
  cierre da un botón `wa.me` que abre WhatsApp en el teléfono de ventas con el
  resumen pre-cargado; el operador revisa y envía. Es una decisión de producto:
  se quiere control humano sobre el mensaje, no un envío automático. Si el repo
  destino tiene un bot (n8n/Edge Function) que dispara con el push a Sheets, ese
  envío automático hay que **apagarlo aparte** — no vive en este frontend.
- **[LK-específico]** No se espeja a otros paneles. En LK, los cambios del panel
  admin se espejan al repo Virgilio (ver CLAUDE.md), pero el módulo Expo NO se
  espeja. En los otros repos esto no aplica.

---

## 2. Modelo de datos (Supabase)

Cinco objetos nuevos + reutilización de tablas existentes. El archivo base es
`sql/expo.sql`, pero **está desactualizado**; abajo va el DDL real desplegado.

### 2.1 Tablas/columnas EXISTENTES que el módulo asume  **[LK-específico: nombres]**

El alta y el pricing leen/escriben estas columnas. En otra empresa hay que
mapear a los nombres equivalentes:

- `customers`: `id` (uuid PK), `cod_cliente` (bigint), `business_name` (text),
  `cuit` (text), `dto_vol` (numeric 0..1), `vend` (text, código ERP del
  vendedor), `mail`, `whatsapp`, `direccion_fiscal`, `localidad`, `pin` (text,
  **6 dígitos**, con constraint), `auth_user_id` (uuid → `auth.users`).
- `customer_delivery_addresses`: `customer_id` (uuid FK), `slot` (int),
  `label` (text, nombre de la sucursal), `direccion_entrega` (text),
  `localidad`, `provincia`, `nombre_expreso` (text).
- `admins`: fila con `auth_user_id = auth.uid()` = es admin (gate de todo).
- `orders`: `customer_id`, `total` — para el dashboard.
- `loke_access`: `customer_id` — módulo Línea Loke por cliente (ver §7).

### 2.2 Constraint del PIN — 6 dígitos  **[Genérico, recomendado]**

⚠️ **Verificado en LK:** `customers_pin_6_digits = CHECK ((pin ~ '^\d{6}$'))`.

El PIN es el **password del login del cliente** (usuario = CUIT, clave = PIN de 6
dígitos). El alta genera un PIN aleatorio de 6 dígitos (`_expoNewGenPin`). Si en
tu esquema `pin` admite 30 chars o cualquier string, agregá el constraint o
alineá el generador — ver gotcha §10.

```sql
alter table public.customers
  add constraint customers_pin_6_digits check (pin ~ '^\d{6}$');
```

### 2.3 `expo_config` + `expo_peek_cod` + `expo_reservar_cod` — contador de código  **[LK-específico: valor semilla]**

Contador singleton (una sola fila, `id=1`) que asigna el código de cliente del
sistema. **Arranca en 4272** en LK (ISIS tenía max 4271). NO se deriva del padrón
parcial de la web. **En otra empresa: sembrar `next_cod` = (máximo código del ERP)
+ 1.**

```sql
create table if not exists public.expo_config (
  id int primary key default 1,
  next_cod bigint not null,
  constraint expo_config_singleton check (id = 1)
);
insert into public.expo_config (id, next_cod)
select 1, 4272 where not exists (select 1 from public.expo_config where id = 1);
alter table public.expo_config enable row level security;
drop policy if exists expo_config_admin on public.expo_config;
create policy expo_config_admin on public.expo_config for all
  using (exists (select 1 from public.admins a where a.auth_user_id = auth.uid()))
  with check (exists (select 1 from public.admins a where a.auth_user_id = auth.uid()));

-- peek: leer el próximo código sin consumirlo (para mostrarlo en el modal).
create or replace function public.expo_peek_cod()
returns bigint language sql security definer set search_path=public as $$
  select next_cod from public.expo_config where id = 1;
$$;

-- reservar: consume un código (incrementa el contador) y devuelve el reservado.
create or replace function public.expo_reservar_cod()
returns bigint language plpgsql security definer set search_path=public as $$
declare v bigint;
begin
  if not exists (select 1 from admins a where a.auth_user_id = auth.uid()) then
    raise exception 'no autorizado';
  end if;
  update public.expo_config set next_cod = next_cod + 1 where id = 1
    returning next_cod - 1 into v;
  return v;
end; $$;

revoke execute on function public.expo_peek_cod() from public;
revoke execute on function public.expo_reservar_cod() from public;
revoke execute on function public.expo_peek_cod() from anon;      -- ⚠️ ver §10
revoke execute on function public.expo_reservar_cod() from anon;  -- ⚠️ ver §10
grant execute on function public.expo_peek_cod() to authenticated, service_role;
grant execute on function public.expo_reservar_cod() to authenticated, service_role;
```

> ⚠️ **En LK, al 16/8/2026, `expo_peek_cod` y `expo_reservar_cod` siguen
> ejecutables por `anon`** (el `revoke ... from anon` no está en `sql/expo.sql`;
> el archivo solo revoca de `public`, que NO saca a anon — ver gotcha §10).
> `expo_peek_cod` NO tiene gate de admin (solo lee el contador — leak menor).
> `expo_reservar_cod` sí tiene gate adentro. Al replicar, **agregar el revoke a
> anon** como arriba.

### 2.4 `expo_clientes_pendientes` — staging para el ERP  **[Genérico + LK-específico]**

Una fila por cliente nuevo de expo. El frontend escribe un **núcleo** de columnas;
en LK la tabla fue **extendida con decenas de columnas que espejan el maestro de
clientes de ISIS** (razon_social_busqueda, calificacion, situacion, fecha_alta,
letra, pct_liberacion, gran_contribuyente, ingresos_brutos, cuenta_contable,
piso/depto/barrio/partido, telefono2/3, fax, horario, lista_precio, limite_credito,
moneda, cond_pago, transportista, expreso, dto2/dto3, dias_visita, empresa, …).
**Esas columnas extra NO las usa el frontend expo** — son para la importación al
ERP. Para replicar el módulo alcanza con el núcleo; las demás son opcionales.

DDL del **núcleo** (lo que el frontend realmente lee/escribe):

```sql
create table if not exists public.expo_clientes_pendientes (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references public.customers(id) on delete set null,
  cod_cliente bigint,
  business_name text,
  cuit text,
  condicion_iva text,
  direccion text,           -- calle fiscal
  numero text,
  cp text,
  localidad text,
  provincia text,
  telefono text,
  whatsapp text,
  mail text,
  vend text,
  dto_vol numeric,
  pin text,
  direcciones_entrega jsonb default '[]'::jsonb,
    -- [{titulo, direccion, localidad, provincia, expreso}]
  estado text default 'pendiente',   -- 'pendiente' | 'cargado_erp'
  creado_por uuid default auth.uid(),
  creado_at timestamptz default now(),
  actualizado_at timestamptz default now()
);

alter table public.expo_clientes_pendientes enable row level security;
drop policy if exists expo_pend_admin_all on public.expo_clientes_pendientes;
create policy expo_pend_admin_all on public.expo_clientes_pendientes
  for all
  using      (exists (select 1 from public.admins a where a.auth_user_id = auth.uid()))
  with check (exists (select 1 from public.admins a where a.auth_user_id = auth.uid()));
```

RLS: **todo gateado a admin** (verificado: policy `expo_pend_admin_all`, cmd ALL).
El frontend accede vía `supabaseClient.from("expo_clientes_pendientes")` directo
(no RPC) porque el operador está logueado como admin y la policy lo permite.

### 2.5 `expo_dto_escala` — escala de descuento por volumen  **[LK-específico: tramos]**

Filas `(desde numeric, dto numeric 0..1)`. El dto se elige por el **subtotal de
LISTA** del carrito (antes de descuento), en vivo. **Editable** desde el panel
admin. RLS: **lectura abierta** (`select using (true)`), **escritura admin**.

```sql
create table if not exists public.expo_dto_escala (
  id uuid primary key default gen_random_uuid(),
  desde numeric not null,      -- subtotal de lista desde el cual aplica
  dto   numeric not null,      -- fracción 0..1
  creado_at timestamptz default now()
);

alter table public.expo_dto_escala enable row level security;
drop policy if exists expo_escala_read on public.expo_dto_escala;
create policy expo_escala_read on public.expo_dto_escala for select using (true);
drop policy if exists expo_escala_admin on public.expo_dto_escala;
create policy expo_escala_admin on public.expo_dto_escala
  for all
  using      (exists (select 1 from public.admins a where a.auth_user_id = auth.uid()))
  with check (exists (select 1 from public.admins a where a.auth_user_id = auth.uid()));

-- Semilla LK (verificada en la base 16/8/2026). RECALCULAR por empresa.
insert into public.expo_dto_escala (desde, dto)
select * from (values
  (0::numeric, 0.00::numeric), (600000::numeric, 0.02::numeric),
  (1000000::numeric, 0.04::numeric), (1500000::numeric, 0.06::numeric),
  (2300000::numeric, 0.08::numeric), (4000000::numeric, 0.10::numeric),
  (6000000::numeric, 0.12::numeric)
) as t(desde, dto)
where not exists (select 1 from public.expo_dto_escala);
```

**Tramos LK (subtotal de lista → dto):**

| Desde ($ lista) | Dto |
|---|---|
| 0 | 0% |
| 600.000 | 2% |
| 1.000.000 | 4% |
| 1.500.000 | 6% |
| 2.300.000 | 8% |
| 4.000.000 | 10% |
| 6.000.000 | 12% |

> **[LK-específico]** La escala salió de analizar el padrón real (dto_vol vs
> tamaño de pedido). **En cada empresa RECALCULARLA** con sus datos antes de
> sembrar — los montos dependen de precios y volumen propios.

### 2.6 `buscar_cliente_expo(p_q text)` — buscador del popup "Elegir cliente"  **[Genérico]**

Busca por **cód / razón social / CUIT (solo dígitos, ≥4) / dirección de entrega o
localidad (≥3 chars)**. `SECURITY DEFINER`, gate admin adentro, solo lectura,
tope 25 filas ordenadas por `cod_cliente`.

⚠️ **La versión DESPLEGADA difiere de `sql/expo.sql`:** envuelve el `distinct on`
en un subselect y ordena el resultado externo por `cod_cliente` (el archivo
ordena por `c.id`). Este es el DDL real:

```sql
create or replace function public.buscar_cliente_expo(p_q text)
returns table(
  id uuid, cod_cliente bigint, business_name text, cuit text,
  dto_vol numeric, vend text, direccion text, localidad text
)
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_q      text := btrim(coalesce(p_q, ''));
  v_digits text := regexp_replace(coalesce(p_q, ''), '\D', '', 'g');
  v_isnum  boolean := v_q ~ '^\d+$';
  v_cod    bigint := null;
begin
  if not exists (select 1 from admins a where a.auth_user_id = auth.uid()) then
    raise exception 'no autorizado';
  end if;
  if length(v_q) < 2 then return; end if;
  -- Cast protegido: SOLO dígitos puros. v_q::bigint directo en el WHERE se
  -- const-foldea y tira 22P02 con un CUIT con guiones. Ver gotcha §10.
  if v_isnum and length(v_q) <= 18 then
    begin v_cod := v_q::bigint; exception when others then v_cod := null; end;
  end if;

  return query
  select * from (
    with matches as (
      select c.id
      from customers c
      where (v_cod is not null and c.cod_cliente = v_cod)
         or c.business_name ilike '%' || v_q || '%'
         or (length(v_digits) >= 4
             and regexp_replace(coalesce(c.cuit, ''), '\D', '', 'g') like '%' || v_digits || '%')
      union
      select da.customer_id
      from customer_delivery_addresses da
      where length(v_q) >= 3
        and (da.direccion_entrega ilike '%' || v_q || '%'
             or da.localidad ilike '%' || v_q || '%')
    )
    select distinct on (c.id)
      c.id, c.cod_cliente, c.business_name, c.cuit, c.dto_vol, c.vend,
      coalesce(nullif(c.direccion_fiscal, ''), da.direccion_entrega) as direccion,
      coalesce(nullif(c.localidad, ''), da.localidad) as localidad
    from customers c
    join matches m on m.id = c.id
    left join customer_delivery_addresses da on da.customer_id = c.id
    order by c.id, da.slot nulls last
  ) s
  order by s.cod_cliente
  limit 25;
end;
$function$;

revoke execute on function public.buscar_cliente_expo(text) from public;
revoke execute on function public.buscar_cliente_expo(text) from anon;   -- ⚠️ ver §10
grant execute on function public.buscar_cliente_expo(text) to authenticated, service_role;
```

> ⚠️ **En LK, al 16/8/2026, `buscar_cliente_expo` sigue ejecutable por `anon`**
> (mismo motivo que §2.3). Tiene gate de admin adentro, así que anon recibe "no
> autorizado", pero **al replicar agregar el `revoke ... from anon`**.

### 2.7 `expo_dashboard()` — métricas del panel "Clientes Expo pend."  **[Genérico]**

Devuelve jsonb con `clientes_total`, `clientes_pendientes`, `clientes_cargados`,
`pedidos_count`, `pedidos_monto` (pedidos de `orders` cuyo `customer_id` está en el
staging). Gate admin adentro. **Verificado: anon = false** (es la ÚNICA de las
cuatro que tiene el revoke a anon explícito y por eso quedó bien).

```sql
create or replace function public.expo_dashboard()
returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
declare v jsonb;
begin
  if not exists (select 1 from admins a where a.auth_user_id = auth.uid()) then
    raise exception 'no autorizado';
  end if;
  select jsonb_build_object(
    'clientes_total',      (select count(*) from expo_clientes_pendientes),
    'clientes_pendientes', (select count(*) from expo_clientes_pendientes where estado = 'pendiente'),
    'clientes_cargados',   (select count(*) from expo_clientes_pendientes where estado = 'cargado_erp'),
    'pedidos_count',       (select count(*) from orders o
                              where o.customer_id in (select customer_id from expo_clientes_pendientes where customer_id is not null)),
    'pedidos_monto',       (select coalesce(sum(o.total),0) from orders o
                              where o.customer_id in (select customer_id from expo_clientes_pendientes where customer_id is not null))
  ) into v;
  return v;
end;
$function$;

revoke execute on function public.expo_dashboard() from public;
revoke execute on function public.expo_dashboard() from anon;   -- ✅ imprescindible
grant execute on function public.expo_dashboard() to authenticated, service_role;
```

### 2.8 `has_loke_access(p_customer_id uuid)` — NO tocar  **[LK-específico]**

Devuelve true si el cliente tiene acceso Loke **OR** si el que consulta es admin.
La usa el sitio real; el módulo expo NO la modifica (ver §7). DDL real:

```sql
create or replace function public.has_loke_access(p_customer_id uuid)
returns boolean language sql security definer set search_path to 'public'
as $function$
  SELECT EXISTS (SELECT 1 FROM loke_access WHERE customer_id = p_customer_id)
      OR EXISTS (SELECT 1 FROM admins WHERE auth_user_id = auth.uid());
$function$;
```

---

## 3. Pricing (el nudo)

El operador es admin y el pricing normal tiene ramas `isAdmin` /
`isListPriceOnlyClient()` que **anulan descuentos** (el admin ve precio de lista).
Para que en expo el pricing muestre precios REALES del cliente, se introdujeron
**dos flags** que gatean las primitivas:

- **`_expoActiveCustomer`** (bool): hay un cliente REAL elegido (existente o nuevo)
  → mostrar SUS precios (dto + web), no lista. Anula el modo admin/lista.
- **`_expoClientMode`** (bool): el cliente es NUEVO de expo (presente en staging o
  forzado desde el alta) → dto por ESCALA + contado –25% forzado + web –2%.
- **`_expoClientComplete`** (bool): el cliente nuevo tiene TODOS los datos salvo
  expreso → habilita el envío del pedido.

Los tres son `false` para el operador sin cliente, así que **todo el módulo queda
inerte** para el flujo normal.

### Primitivas tocadas (script.js) — **[Genérico: la lógica; LK: los nombres de función]**

| Primitiva | Cambio |
|---|---|
| `isListPriceOnlyClient()` | `if (_expoActiveCustomer) return false;` al inicio — con cliente activo, NO es precio-lista. |
| `getDtoVol()` | sin cambio directo; devuelve `customerProfile.dto_vol`, que `_expoSyncDto()` sobrescribe. |
| `getPaymentDiscount()` | `if (_expoClientMode) return 0.25;` (contado –25% forzado). |
| `getPaymentMethodText()` | `if (_expoClientMode) return "Contado";` |
| `getPaymentMethodCode()` | `if (_expoClientMode) return 8;` (código ERP de Contado). |
| `webDiscountRate` (2 sitios: `updateCart` línea ~6003, `buildOrderPayload` ~7002) | `(isAdmin && !_expoActiveCustomer) ? 0 : WEB_ORDER_DISCOUNT` — con cliente activo, SÍ aplica web –2%. |
| `showTuPrecio` (render productos ~6652) | `(!isAdmin \|\| _expoActiveCustomer) && !isListPriceOnlyClient()` — muestra "Tu precio" con cliente activo. |
| `hasPayment` (en `refreshSubmitEnabled` ~7630) | `isAdmin && !(EXPO_MODE && _expoActiveCustomer) ? true : !!paySel.value` — con cliente activo se exige método de pago como en la web normal. |

### `_expoSyncDto()` — la clave para que TODO lea el mismo dto

```js
function _expoSyncDto() {
  if (!_expoClientMode || !customerProfile) return;
  customerProfile.dto_vol = _expoScaleDtoFor(_expoListSubtotal());
  _expoRenderCheckpoints();
}
```

Se llama al tope de `renderProducts` (línea ~3459) y de `updateCart` (~6055).
Escribe `customerProfile.dto_vol = escala(subtotalLista)` de modo que **todas las
funciones de pricing leen el mismo dto** (vía `getDtoVol()`), recalculado en vivo
según el carrito. `_expoListSubtotal()` suma `list_price * (cajas * uxb)` sobre el
carrito; `_expoScaleDtoFor(sub)` recorre la escala y toma el último tramo cuyo
`desde <= sub`.

### Cadena de descuentos (cliente nuevo de expo)

`precio_unitario = list_price × (1 − dtoVolEscala) × (1 − 0.25 contado) × (1 − 0.02 web)`

Multiplicativos, en este orden. Mismo cálculo que arma un pedido real en
`script.js` (`listUnit * (1 - dtoVol) * (1 - webDiscountRate) * (1 - extraRate)`).

**Ejemplo numérico** — carrito con subtotal de lista **$1.700.000**:

- Tramo de escala: `$1.500.000 ≤ 1.700.000 < 2.300.000` → **dto volumen 6%**.
- Unidad de lista $1000 → `1000 × 0.94 × 0.75 × 0.98 = $690,90` por unidad.
- El total del pedido usa la misma cadena sobre cada línea.
- La barra de checkpoints muestra "6%", "Pedido (lista): $1.700.000", "Faltan
  $600.000 para 8%".

---

## 4. Frontend — inventario de funciones (script.js salvo aclaración)

Estado global (arriba del archivo): `EXPO_MODE = true` **[LK]**, `_expoClientMode`,
`_expoActiveCustomer`, `_expoClientComplete`, `_expoScale` (cache de la escala).

### Entrada / chip / barra

| Función | Qué hace |
|---|---|
| `renderCustomerSelector()` | **Punto de integración.** Corta temprano: `if (EXPO_MODE && isAdmin) { renderExpoEntryBar(); return; }` — no dibuja el dropdown viejo. |
| `renderExpoEntryBar()` | Construye la barra (chip + 3 botones) e inserta un `<select id="customerSelect">` **OCULTO** (lo leen `onLinkedCustomerSelected` y el gate de submit). Inserta también `#expoCheckpoints`. Cablea los modales. |
| `_expoUpdateChip()` | Repinta el chip del cliente activo (nombre, cód, dto o "Contado 1ª compra · ✓/Faltan datos") y la cruz de soltar. |
| `_expoEnsureOption(id, label)` | Garantiza que el select oculto tenga la `<option>` del cliente elegido. |

### Popup "Elegir cliente"

| Función | Qué hace |
|---|---|
| `expoOpenPickModal()` / `expoClosePickModal()` | Abre/cierra `#expoPickModal` (`.modal` se muestra con `.open`). |
| `_expoRunSearch()` | RPC `buscar_cliente_expo` con debounce 250 ms; descarta respuestas viejas si el input cambió; pinta las filas. |
| `expoApplyCustomer(cust, opts)` | Aplica el cliente: lo mete en `linkedCustomers`, setea el select oculto, prende `_expoActiveCustomer`; detecta si es de expo (staging o `opts.forceExpoNew`) → prende `_expoClientMode`, carga la escala y calcula completitud; llama `onLinkedCustomerSelected({customerId})`; persiste en `localStorage["lk_expo_selected_client"]`; corre `checkLokeAccess`; fuerza contado y recalcula. |
| `expoClearCustomer()` | Suelta el cliente (vacía carrito con confirm), limpia flags y localStorage, vuelve al perfil del operador (`VENDOR_SELF_VALUE`). |
| `_expoWirePickModal()` | Reparenta el modal a `<body>`, cablea input/close/backdrop/Escape. |

### Modal "Nuevo cliente" y alta

| Función | Qué hace |
|---|---|
| `expoNuevoCliente()` | Abre `#expoNewModal`, limpia campos, genera PIN, llena vendedores/provincias, hace `expo_peek_cod` para mostrar el código. |
| `_expoGuardarNuevo(mode)` | **Corazón del alta.** `mode = "order"` (Pausar y cargar: guarda parcial, exige solo razón social) \| `"complete"` (Datos completados: exige todo salvo expreso). Reserva código (`expo_reservar_cod`), crea/actualiza `customers`, crea auth user (si hay CUIT), reemplaza `customer_delivery_addresses`, upserta el staging. Valida CUIT (avisa, no bloquea) y avisa duplicados por CUIT. Al terminar hace handoff a `expoApplyCustomer(.., {forceExpoNew:true})`. |
| `_expoNewGenPin()` | PIN aleatorio de **6 dígitos**. |
| `_expoCreateAuthUser(cuit, pin)` | Crea el auth user con un **cliente Supabase aparte** (`persistSession:false`) para no pisar la sesión del operador. Email sintético `<cuit>@cuit.loekemeyer` **[LK]**. Si ya existe, intenta login. |
| `_expoCuitValido(digits)` | Valida CUIT argentino (11 dígitos + DV módulo 11). |
| `_expoDuplicadosCuit(cuit, selfId)` | Reusa `buscar_cliente_expo` para avisar clientes con el mismo CUIT. |
| `_expoAddrAddRow(prefill, prepend)` | Agrega una fila de dirección de entrega (título auto "dirección - zona", provincia select, expreso con datalist). |
| `_expoAddrCollect()` | Junta las direcciones del formulario a `[{titulo,direccion,localidad,provincia,expreso}]`. |
| `_expoFillVendedores()` / `_expoFillProvincias()` | Llenan los selects desde `EXPO_VENDEDORES` / `EXPO_PROVINCIAS`. |
| `_expoBuildExpresoDatalist()` | Crea (una vez) el `<datalist id="expoExpresoList">` desde `EXPO_EXPRESOS`. |
| `_expoWireNewModal()` | Reparenta a `<body>`; cablea validación en vivo (`input`/`change` → `_expoNewSyncComplete`), botones. |

### Completitud automática (arriba del archivo, líneas 51-134)

| Función | Qué hace |
|---|---|
| `_expoDatosCompletos(d)` | true si están TODOS los campos salvo el expreso de cada dirección (razón, cuit, cond IVA, vend, whatsapp, mail, calle, número, cp, localidad, provincia + ≥1 dirección con calle/localidad/provincia). |
| `_expoFaltantes(d)` | Lista legible de lo que falta (para el aviso). |
| `_expoReadFormData()` | Lee el formulario de alta a la forma que consumen las dos de arriba. |
| `_expoNewSyncComplete()` | Habilita/deshabilita el botón "Datos completados" (verde) en vivo. |

### Escala / checkpoints

| Función | Qué hace |
|---|---|
| `_expoLoadScale()` | Carga (y cachea) `expo_dto_escala` ordenada por `desde`. |
| `_expoListSubtotal()` | Subtotal de LISTA del carrito. |
| `_expoScaleDtoFor(sub)` | dto del tramo que corresponde a un subtotal. |
| `_expoSyncDto()` | Sincroniza `customerProfile.dto_vol` con la escala (ver §3). |
| `_expoNextTier(sub)` | Próximo tramo y cuánto falta. |
| `_expoRenderCheckpoints()` / `_expoCompact(n)` / `_expoMoney(n)` | Barra visual de hitos del dto por volumen (solo cliente nuevo). |

### Continuar carga pausada

| Función | Qué hace |
|---|---|
| `_expoRefreshResumeBtn()` | Muestra/oculta "Continuar carga pausada (N)" / "✓ Editar cliente" según el staging. `N` cuenta solo los **incompletos**. Re-chequea el estado tras el await (race). |
| `expoOpenResumeModal()` / `expoCloseResumeModal()` | Lista **solo lo EN CURSO**: los `pendiente` **incompletos** ("Falta datos") + el cliente **activo** ahora (para editarlo aunque esté completo). Los clientes viejos ya completos NO se listan (ensuciaban la carga en curso). |
| `expoEditarPendiente(row)` | Reabre `#expoNewModal` en modo EDICIÓN precargado (setea `_expoNewState.id` → el guardado hace UPDATE). |

### Confirmación

| Función | Qué hace |
|---|---|
| `_expoShowConfirmPanel()` | Tras `showSection("pedidoConfirmado")`. Muestra el panel si `EXPO_MODE && (_expoClientMode || _expoActiveCustomer)` — es decir, para **cualquier** cliente de expo. Lee `pin`/`whatsapp` de `customers`; oculta la fila del PIN si NO es cliente nuevo. Arma el resumen (arranca con "¡Tu pedido fue confirmado! ✅"; agrega usuario=CUIT / clave=PIN solo para cliente nuevo), lo guarda en `_expoConfirmMsg` (para "Copiar resumen") y arma el link `wa.me` con ese texto. Oculta la descarga estándar duplicada (`.success-download-wrap`). |
| `expoCopiarResumen()` | Copia `_expoConfirmMsg` al portapapeles (`navigator.clipboard` con fallback a `textarea` + `execCommand`). Feedback visual "✓ Resumen copiado" 1,8 s. |

### Listas de datos — **[LK-específico: reemplazar por los datos de cada empresa]**

- `EXPO_VENDEDORES` — array `{c: código ERP, n: nombre}`. En LK, 23 vendedores;
  el default es el `7` = "FCA (Nosotros)".
- `EXPO_PROVINCIAS` — 24 jurisdicciones argentinas (genérico para Argentina).
- `EXPO_EXPRESOS` — **~230 transportistas TAL CUAL están cargados en ISIS** (última
  columna del export de sucursales). El campo Expreso autocompleta contra esta
  lista para que el nombre sea EXACTO y la importación al ERP no falle por typo.
  **Cada empresa tiene su propio padrón de expresos.**

### Integración con el flujo existente — puntos a no romper

- **`renderCustomerSelector`** corta temprano si `EXPO_MODE && isAdmin`.
- El **`<select id="customerSelect">` OCULTO** es leído por
  `onLinkedCustomerSelected` (a la que se le agregó el parámetro `opts.customerId`)
  y por el gate de submit. `expoApplyCustomer` lo puebla con `_expoEnsureOption`.
- **`onLinkedCustomerSelected({customerId, fromRestore})`**: se extendió para
  aceptar un `customerId` explícito (además del value del select).
- **`restoreSelectedCustomerIfAny()`**: al inicio, si `EXPO_MODE && isAdmin` y hay
  `lk_expo_selected_client` en localStorage, re-aplica el cliente completo con
  `expoApplyCustomer(.., {fromRestore:true})`. Esto restaura el cliente al volver
  de historial/sugerencias (que recargan la página) — el cliente puede venir del
  padrón y NO estar en `linkedCustomers`, así que la restauración normal no lo
  encontraría.

---

## 5. Completitud automática + gates

- **Todos los campos son obligatorios salvo el Expreso** de cada dirección.
- **"Pausar y cargar pedido"** (`mode="order"`) permite arrancar con SOLO la razón
  social — registra parcial y va al catálogo.
- **"Datos completados"** (verde, `#expoNewClose`, `mode="complete"`) se habilita
  EN VIVO (`_expoNewSyncComplete` en `input`/`change`) solo cuando está todo. Al
  tocarlo: si falta algo, avisa QUÉ y NO cierra (igual guarda lo parcial); si está
  completo, cierra y lleva al carrito.
- **El ENVÍO del pedido se bloquea** si el cliente nuevo está incompleto:
  - `refreshSubmitEnabled()`: `expoOk = !(_expoClientMode && !_expoClientComplete)`;
    muestra/oculta el aviso `#expoOrderGate` y deshabilita el botón.
  - `submitOrder()`: chequeo redundante al inicio (defensa en profundidad).
- **Pago Contado forzado** para clientes de expo: se sacó el bypass de admin en
  `hasPayment` (con cliente activo se exige método de pago; para el nuevo ya viene
  forzado a contado).
- **Anti doble-click:** `submitOrder` deshabilita el botón APENAS se toca
  (`dataset.busy`), antes de cualquier `await`, y lo re-habilita en `finally`.

---

## 6. Módulos admin (admin.html + admin.js)  **[LK-específico: espejo Virgilio]**

Dos nav-items nuevos (`data-page="escala-expo"` "Escala Expo" y
`data-page="clientes-pendientes"` "Clientes Expo pend.") con lazy-load en el router
de `.nav-item` (admin.js ~695-708).

### (a) Escala Expo — editor de `expo_dto_escala`

- Sección `#escala-expo` con tabla editable (Desde $ / Dto %).
- `cargarEscalaExpo()` — lee la escala, pinta filas.
- `guardarEscalaExpo()` — valida, ordena, **delete+insert** de toda la tabla
  (`delete().gte("desde", 0)` — WHERE real, ver gotcha del DELETE en CLAUDE.md).
- `_escalaExpoAddRow` / `_escalaExpoStatus` / `_escalaExpoWireOnce`.

### (b) Clientes Expo pend. — staging + dashboard + Excel

- Sección `#clientes-pendientes`: mini-dashboard (5 stats), filtro
  (pendiente/cargado/todos), tabla, botones Actualizar/Exportar.
- `cargarClientesPendientes()` — lista `expo_clientes_pendientes` filtrada por
  estado; llama `_cliPendCargarStats()`.
- `_cliPendCargarStats()` — RPC `expo_dashboard`, pinta los 5 números.
- `_cliPendRender()` / `_cliPendDirResumen()` — tabla con checkbox "Cargado ERP".
- `_cliPendSetEstado(id, estado)` — UPDATE `estado` (pendiente ↔ cargado_erp).
- `_cliPendDelete(id)` — borra el registro de staging (el cliente sigue en
  `customers`).
- `exportarClientesPendientes()` — genera `.xlsx` con XLSX (18 columnas: cód,
  razón, CUIT, cond IVA, dir fiscal, número, cp, localidad, provincia, tel,
  whatsapp, mail, vend, dto%, PIN, direcciones de entrega, estado, creado).

> **[LK-específico]** En LK, los cambios de admin.html/admin.js se espejan al repo
> Virgilio (ver CLAUDE.md). **En los otros repos ese espejo NO aplica.**

---

## 7. Línea Loke por cliente  **[LK-específico]**

`has_loke_access(customer_id)` devuelve true para cualquier admin (cláusula `OR
admins`). Como el operador de expo ES admin, la RPC daría siempre true y "Línea
Loke" seguiría al operador, no al cliente. Solución (sin tocar la RPC, que la usa
el sitio real): en expo, `checkLokeAccess()` tiene una rama
`if (EXPO_MODE && isAdmin)` que **consulta `loke_access` directo por
`customer_id`** (la policy de admin lo permite), así el módulo sigue al CLIENTE
cargado. Vale también tras un reload que restaura el cliente sin pasar por
`expoApplyCustomer`. En otra empresa: si no hay módulo tipo "Loke", esta sección
se omite entera.

---

## 8. Deploy / infra

- **Vercel** auto-deploy desde `main` (a diferencia de LK-original que va a GitHub
  Pages / IIS). El sitio es `pagina-lk-copia.vercel.app`.
- **`vercel.json`** con rewrites extensionless → `.html`, porque **Vercel devuelve
  404 para `/mayorista` sin `.html`** (a diferencia de IIS/GitHub Pages):

```json
{
  "rewrites": [
    { "source": "/mayorista",   "destination": "/mayorista.html" },
    { "source": "/historial",   "destination": "/historial.html" },
    { "source": "/sugerencias", "destination": "/sugerencias.html" },
    { "source": "/admin",       "destination": "/admin.html" }
  ]
}
```

- **Hooks de versionado** (`hooks/`, `git config core.hooksPath hooks`): bumpean
  `version.js` y los `?v=XXX` de `.js`/`.css` en los HTML en cada commit. Igual que
  el repo base.
- **Badge de versión fijo** (opcional pero muy útil al testear un sitio que
  autodeploya): un `<div data-app-version>` con `position:fixed; right/bottom` justo
  antes de `</body>` en `mayorista.html`. `version.js` ya rellena todo elemento con
  `[data-app-version]` con `"v" + APP_VERSION` en `DOMContentLoaded`. Sirve para
  confirmar a simple vista que el navegador tiene el último deploy (evita el
  ida-y-vuelta de "¿lo ves? / hacé Ctrl+F5").

---

## 9. Checklist de replicación paso a paso (repo nuevo)

1. **Gate de admin.** Confirmar tabla equivalente a `admins` con `auth_user_id` y
   que `exists(select 1 from admins where auth_user_id = auth.uid())` funciona.
2. **Esquema `customers`.** Verificar/crear: `cuit`, `dto_vol`, `pin` (con
   constraint 6 dígitos), `auth_user_id`, `whatsapp`, `direccion_fiscal`,
   `localidad`, `cod_cliente`, `business_name`, `vend`, `mail`.
3. **Esquema `customer_delivery_addresses`.** `direccion_entrega`, `localidad`,
   `provincia`, `slot`, `label`, `nombre_expreso`.
4. **Correr el SQL** (§2), adaptado a los nombres de esa empresa:
   `expo_config` (+ `expo_peek_cod`/`expo_reservar_cod`), `expo_clientes_pendientes`,
   `expo_dto_escala`, `buscar_cliente_expo`, `expo_dashboard`. **Revocar `anon`
   explícito** en las 4 RPCs (no solo `public`).
5. **RECALCULAR la escala** `expo_dto_escala` con los datos de esa empresa. Sembrar
   `expo_config.next_cod` = max código ERP + 1.
6. **Portar script.js**: los ~1000 renglones EXPO (funciones §4), los flags de
   estado, la rama de `renderCustomerSelector`, la extensión de
   `onLinkedCustomerSelected`, `restoreSelectedCustomerIfAny`, `checkLokeAccess`.
7. **Adaptar las primitivas de pricing** (§3) a cómo esa empresa gatea
   admin/list-price (los nombres de función pueden diferir; la lógica de los dos
   flags es la misma).
8. **Portar mayorista.html**: 3 modales (`#expoPickModal`, `#expoResumeModal`,
   `#expoNewModal`), `#expoOrderGate` junto al botón Confirmar, `#expoConfirmPanel`
   dentro de `#pedidoConfirmado` (con botones Descargar/Copiar/WhatsApp y las ids
   `#expoConfirmTitle`/`#expoConfirmPinrow`), el chip `#successOrderNum`, y el badge
   `[data-app-version]` fijo antes de `</body>`.
9. **Portar CSS** (`.expo-*` en `css/styles.css`), incluida la regla
   ID-específica `#expoNewModal .expo-new-card` (gotcha de especificidad).
10. **Cargar las listas** `EXPO_VENDEDORES`, `EXPO_PROVINCIAS`, `EXPO_EXPRESOS` con
    los datos de ESA empresa (los expresos del padrón de sucursales de su ERP).
11. **Panel admin**: nav-items + secciones `#escala-expo` y `#clientes-pendientes`
    + funciones de admin.js (§6). (Sin espejo en los otros repos.)
12. **`vercel.json`** con los rewrites (§8).
13. **Login del operador como admin** en la expo; email sintético
    `<cuit>@cuit.<dominio>` adaptado.

---

## 10. Gotchas aprendidos (con la causa)

1. **PIN 6 dígitos (constraint) vs 30 chars.** El PIN es password del login del
   cliente (CUIT + PIN). `customers_pin_6_digits = CHECK (pin ~ '^\d{6}$')`. Si el
   generador produce otra longitud, el insert de `customers` falla. Generar
   siempre 6 dígitos.
2. **Especificidad CSS del modal.** `.modal .modal-card` (0,2,0) fija
   `max-width:420px` y le gana a `.expo-new-card` (0,1,0), dejando el modal de alta
   angosto. Fix: usar el selector ID **`#expoNewModal .expo-new-card`** (0,1,1 +
   id) con `max-width:1500px; width:96vw`.
3. **Reparentar los modales a `<body>`.** Nacen dentro de `#perfil`, que es una
   `.section` con `display:none` cuando no estás en Perfil, así que el modal no
   renderiza desde Productos. `_expoWire*Modal()` hace
   `if (m.parentElement !== document.body) document.body.appendChild(m);`.
4. **`.modal` se muestra con `.open`, NO quitando `.hidden`.** El sistema de
   modales del sitio activa con la clase `.open`. Abrir = `add("open")` (y de yapa
   `remove("hidden")`); cerrar = `remove("open")` + `add("hidden")`.
5. **Cast const-fold `text::bigint` (22P02).** Poner `v_q::bigint` directo en el
   `WHERE` hace que Postgres lo const-foldee y tire `22P02` con un CUIT con guiones
   ("30-68092135-7"), rompiendo la búsqueda por CUIT. Fix: castear a una **variable
   plpgsql protegida** con `begin ... exception when others then null; end;` y usar
   la variable en el WHERE.
6. **Race del botón "Continuar carga pausada".** Entre pedir el staging y pintar,
   el operador pudo soltar el cliente. `_expoRefreshResumeBtn` **re-chequea el
   estado después del await** y oculta si ya no hay cliente activo.
7. **Doble-submit del pedido.** Deshabilitar el botón APENAS se toca
   (`dataset.busy = "1"`), antes de cualquier `await`; re-habilitar en `finally`.
8. **Revocar `anon` en RPCs SECURITY DEFINER.** `create or replace` **re-otorga
   EXECUTE a PUBLIC**, y `anon` hereda de PUBLIC. Un `revoke ... from public` en el
   MISMO batch **no siempre saca a `anon`**. Hay que **revocar `anon`
   explícitamente**. ⚠️ Verificado en LK (16/8/2026): `buscar_cliente_expo`,
   `expo_peek_cod` y `expo_reservar_cod` **siguen ejecutables por anon** porque el
   archivo solo revoca de `public`. Solo `expo_dashboard` quedó bien (tiene el
   revoke a anon). Al replicar, revocar anon en las cuatro.
9. **DELETE/UPDATE sin WHERE los bloquea `supautils`** (ver CLAUDE.md). El editor
   de escala borra con `.gte("desde", 0)` (WHERE real), no un delete pelado.
10. **El código de cliente NO se deriva del padrón parcial de la web.** La web solo
    tiene una porción de los clientes; usar su max daría colisiones con el ERP. Por
    eso el contador propio `expo_config` (sembrado desde el max del ERP).
11. **`expo_clientes_pendientes` creció** en LK con decenas de columnas que espejan
    el maestro de ISIS (para la importación). El frontend solo escribe el núcleo;
    no hace falta portar las columnas extra para tener el módulo funcionando.
12. **La confirmación se muestra ANTES del reset de UI, y el reset va en
    `try/catch`.** El pedido ya está grabado cuando se llama a
    `showSection("pedidoConfirmado")`. Si `showSection` quedara DESPUÉS del reset
    (limpiar carrito, `renderProducts`, `loadDeliveryOptions`) y algo del reset
    tirara, el `catch` se saltaba la confirmación aunque el pedido SÍ existía: el
    operador no veía "¡Pedido confirmado!" y creía que no se mandó. Orden correcto:
    grabar → `showSection` + panel de cierre → `try { reset UI } catch {}`.
13. **`ReferenceError` de una var de otra función tumba la confirmación (bug real
    16/8/2026).** `_submitSingleOrder` referenciaba `observacionesValue`, que estaba
    declarada con `const` dentro de `submitOrder` — otra función, otro scope. El
    RPC del pedido corre ANTES de esa línea, así que el pedido **se grababa** y
    después la función explotaba con `observacionesValue is not defined`; el `catch`
    de `submitOrder` lo tomaba como "no se pudo confirmar" y nunca se mostraba el
    modal. Síntoma exacto: "el pedido aparece en la base pero no veo la
    confirmación". Fix: leer el valor DENTRO de `_submitSingleOrder` (desde el DOM),
    no depender de una var de la función llamadora. Lección general: cualquier dato
    del formulario que use `_submitSingleOrder` debe leerse ahí o pasarse por
    parámetro.

---

## Tabla resumen — archivos tocados

| Archivo | Qué contiene del módulo Expo |
|---|---|
| `script.js` | ~1000 líneas: flags de estado (líneas 34-46), completitud (51-134), bloque EXPO (9085-10337), rama de `renderCustomerSelector` (10353), primitivas de pricing tocadas, `restoreSelectedCustomerIfAny` (11034), `checkLokeAccess` (11103). |
| `mayorista.html` | 3 modales (`#expoPickModal` ~994, `#expoResumeModal` ~1024, `#expoNewModal` ~1050), `#expoOrderGate` (~1245), `#expoConfirmPanel` (~1458, con `#expoConfirmTitle`/`#expoConfirmPinrow`/`#expoConfirmCopy` + `.expo-confirm-btns`), `#successOrderNum` (chip N° pedido) en `#pedidoConfirmado`, badge `[data-app-version]` fijo antes de `</body>`. |
| `css/styles.css` | Bloques `.expo-*` (~14246-14880): entry bar, chip, checkpoints, pick/new cards, addr rows, order gate, confirm panel (`.expo-confirm-btns`/`-dl`/`-copy`/`-wa`), `.success-ordernum`, regla ID-específica del modal. |
| `admin.html` | Nav-items `escala-expo` / `clientes-pendientes` (~483,496); secciones `#escala-expo` (~3205) y `#clientes-pendientes` (~3243). |
| `admin.js` | Router lazy-load (~695-708); `cargarEscalaExpo`/`guardarEscalaExpo` (~14310); `cargarClientesPendientes` + `_cliPend*` + `exportarClientesPendientes` (~14410-14643). |
| `vercel.json` | Rewrites extensionless → `.html`. |
| `sql/expo.sql` | DDL de referencia (⚠️ desactualizado vs la base — este doc manda). |

## Tabla resumen — objetos Supabase

| Objeto | Tipo | Propósito | RLS / grants |
|---|---|---|---|
| `expo_config` | tabla | Contador singleton del código de cliente (LK: 4272→…, hoy 4273). | RLS admin (ALL). |
| `expo_peek_cod()` | RPC | Lee el próximo código sin consumirlo. | SECURITY DEFINER, sin gate. ⚠️ anon aún true en LK. |
| `expo_reservar_cod()` | RPC | Consume y devuelve un código. | SECURITY DEFINER, gate admin. ⚠️ anon aún true en LK. |
| `expo_clientes_pendientes` | tabla | Staging de clientes nuevos para el ERP. | RLS admin (ALL). |
| `expo_dto_escala` | tabla | Escala dto por volumen (7 tramos LK). | RLS: read `true`, write admin. |
| `buscar_cliente_expo(text)` | RPC | Buscador del popup "Elegir cliente". | SECURITY DEFINER, gate admin. ⚠️ anon aún true en LK. |
| `expo_dashboard()` | RPC | Métricas del panel de pendientes. | SECURITY DEFINER, gate admin. ✅ anon revocado. |
| `customers_pin_6_digits` | constraint | `pin ~ '^\d{6}$'`. | — |
| `has_loke_access(uuid)` | RPC (existente) | Acceso Loke OR admin. **NO tocar.** | SECURITY DEFINER. |
| `customers`, `customer_delivery_addresses`, `admins`, `orders`, `loke_access` | tablas existentes | Padrón, direcciones, gate, pedidos, acceso Loke. | — |

---

*Verificado contra el proyecto Supabase LK `kwkclwhmoygunqmlegrg` el 16/8/2026
(solo lectura). La base es la fuente de verdad; los `.sql` del repo pueden estar
desfasados.*
