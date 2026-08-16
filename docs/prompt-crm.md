# Prompt para el repo del CRM de ventas

> Pegá esto en una sesión de Claude dentro del repo del CRM. Le da la estructura
> real del ERP (ICIS) y cómo debe dar de alta un cliente para que entre al ERP.

---

CONTEXTO — Alta de clientes hacia el ERP ICIS (Loekemeyer)

Este CRM tiene que poder **dar de alta clientes nuevos** con TODOS los datos que
pide el ERP **ICIS**, para que después se carguen ahí (hoy el alta al ERP es por
importación/carga manual desde un módulo de pendientes; no hay API directa a
ICIS). El ERP es la fuente de verdad del **código de cliente** y de la **Fecha
Ult.Factura** (que define si un cliente está activo).

## Estructura del cliente en ICIS (export "Búsqueda de Clientes", 86 columnas)

Campos que el alta debe capturar/mapear (nombre EXACTO de la columna ICIS):

- **Identidad:** `Código` (numérico, correlativo — el próximo = máx + 1),
  `Razón Social`, `Razón Social de Búsqueda`, `Estado`
  (Activo/Suspendido/Potencial/Sin Cta.Cte.), `Calificación`.
- **Impositivo:** `Condición de IVA` (Inscripto/Monotributo/Exento/Consumidor
  Final), `CUIT`, `Letra` (A/B/…), `Ingr. Brutos`, `% Liber.`,
  `Gran Contribuyente`, `Calc.Internos`, `Incluye Imp.Int.`, `Nro. RENPRE`.
- **Domicilio:** `Calle`, `Dirección Nro.`, `Piso`, `Depto.`, `Barrio`,
  `Partido`, `Localidad`, `Código Postal`, `Provincia` (+ `Cód.Provincia`),
  `Pais` (+ `Cód.Pais`). Opc. `Latitud`/`Longitud`.
- **Contacto:** `Teléfono 1/2/3`, `Fax`, `E-Mail`, `Página Web`, `Horario`.
- **Comercial:** `Cód.Vendedor`/`Nombre Vendedor`, `Cód.Cobrador`,
  `Cód.L/Precio`/`Listas de Precio`, `Cód.C/Pago`/`Condiciones de Pago`,
  `Límite de Crédito`, `Moneda`, `Cód.Transportista`/`Transportista`,
  `Cuenta Contable` (+ `Cód.Cuenta`), `Cód.Proveedor para el Cte.`.
- **Descuentos por ítem** (pestaña Adicionales del ERP, no viaja en el export):
  `Usa Dtos. de Precio x ítem` (Sí/No), `% Dto.1`, `% Dto.2`, `% Dto.3`. El
  `% Dto.1` es el **descuento por volumen** del cliente.
- **Fechas:** `Fecha de Alta`, `Fecha Ult.Factura`, `Fecha Ult.Recibo`.
- **Sucursales (N por cliente):** nombre, domicilio completo, `Transportista` /
  `Expreso`, teléfono, e-mail, días de visita (Lun..Dom + orden).

## Cómo lo resolvió la web LK (patrón a replicar)

El sitio mayorista de LK ya hace este alta en modo "expo" (ver repo
`pagina-LK-copia`, `docs/expo-resumen-global.md`):

1. El operador crea el cliente desde un form; se genera una clave (PIN).
2. El cliente se guarda en la base propia (Supabase) **y** en una tabla staging
   `expo_clientes_pendientes` (el "otro módulo") con: código, razón social,
   CUIT, condición de IVA, dirección/número/CP/localidad/provincia, teléfono,
   whatsapp, mail, vendedor, dto, PIN, direcciones de entrega (con expreso),
   estado `pendiente`/`cargado_erp`. De ahí se levantan **todos juntos** al ERP.
3. El pedido va al flujo normal de pedidos y se puede descargar + mandar por
   WhatsApp con el resumen, el dto otorgado y el PIN.

**Escala de descuento por volumen** (aplicada solo a clientes nuevos, sobre el
monto de LISTA del pedido, en vivo): tramos editables. El descuento final es
`(1 - dto_vol) × (1 - contado) × (1 - web 2%)` — el orden no cambia el total
(es multiplicativo). En LK: contado (-25%) obligatorio en la 1ª compra.

## Tarea en el CRM

Dejá preparado el **alta de cliente hacia ICIS**: un form que capture los campos
de arriba (mapeados 1:1 a las columnas ICIS), que persista a una tabla de
pendientes en la base del CRM, y que exponga esos pendientes para la carga al
ERP. El código de cliente se sugiere como `máx(Código) + 1`.

## A adaptar por empresa

- Cada empresa tiene su **propio proyecto Supabase/base** y su propio padrón. Las
  numeraciones son **independientes** entre empresas (el mismo código es otro
  cliente en cada una).
- Confirmá el gate de admin, el esquema de clientes y las listas de valores
  (vendedores, transportistas, condiciones de pago) contra el ICIS de esa
  empresa antes de fijar los mapeos.
