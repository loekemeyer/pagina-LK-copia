-- =====================================================================================
-- sync_krikos_oc_virgilio() — empuja la Bandeja de OC de Krikos al espejo de Gestión.
--
-- POR QUÉ EXISTE: los datos viven en el Supabase de LK (`krikos_oc_inbox`) y Virgilio NO
-- tiene FDW contra LK, así que LK los EMPUJA (mismo patrón que `sync_pedidos_match_virgilio`).
-- Del otro lado la tabla es `public."GV_Krikos_OC"` del proyecto de Gestión, y la lee el
-- bloque de aviso de "A Programar" (`aprKrikosCargar` / `aprKrikosHtml` en su index.html),
-- CON SESIÓN, no con la anon key: la columna `link` es una URL de Planexware cuyo token abre
-- el PDF sin pedir credenciales.
--
-- Cron: jobid 42 `krikos-oc-a-virgilio-10min`, `5-59/10 * * * *`.
--
-- QUÉ VIAJA, y por qué cada corte:
--   1. `pendiente` sin pedido  → lo que todavía hay que cargar.
--   2. `parcial` de los últimos 7 días → entró sola pero con diferencias contra la OC; es el
--      "si el importe NO DA, QUE LO ACLARE MUY GRANDE EN PPP" del dueño.
--   3. `error` con mail de los últimos 30 días → AGREGADO EL 2026-09-13.
--      Dueño: *"no me interesa ya krikos x paginalk si llega directo a GV"*. Antes las que
--      fallaban NO viajaban, así que la única forma de enterarse era abrir la bandeja del
--      panel de LK — justo lo que él ya no quiere mirar. La ventana va sobre `mail_fecha` y
--      NO sobre `created_at`: las 6 históricas de junio/julio tienen `created_at` del backfill
--      (11/09) y habrían quedado como 6 avisos muertos permanentes en la PPP. Con el corte por
--      fecha del mail no viaja ninguna de ésas y cualquier falla nueva aparece en ≤ 10 min.
--      Medido el 13/09: con 30 días viajan 0 de 6; con 120 días viajarían las 6.
--      Para esas 6 el camino es resolverlas (ver sql/PENDIENTE-krikos-inbox-20260913.sql).
--   Lo que entró limpio NO viaja: ya es un pedido normal en la PPP.
--
-- `auto_aviso` en las de error lleva el `error_msg` del ingest: el front ya lo muestra en
-- `apr-krikos-aviso`, así que el motivo se lee sin abrir nada. Sin eso el aviso salía mudo.
--
-- ✅ 2026-09-13, MAS TARDE: LA VENTANA PASO DE 30 A 90 DIAS Y EL CAMINO QUEDO PROBADO.
--   Thomas: "no me interesa ya krikos x paginalk si llega directo a GV" — y con 30 dias NO
--   llegaba nada: el espejo de Gestion tenia 0 filas porque de las 21 OC de la bandeja no
--   calificaba ninguna (0 `pendiente` sin pedido, 0 `parcial` de 7 dias, y de los 6 `error`
--   el mas nuevo con el mail de hace 62 dias, o sea afuera). La ventana se amplio a **90
--   dias** con un CREATE OR REPLACE que solo cambia ese literal.
--
--   Se corrio `select public.sync_krikos_oc_virgilio();` a mano → devolvio **6**, y las 6
--   aparecieron en `public."GV_Krikos_OC"` del proyecto de Gestion con su motivo visible.
--   **Eso es la prueba de punta a punta que faltaba**: hasta ese momento el espejo nunca
--   habia entregado una sola fila, asi que no habia forma de saber si el push funcionaba
--   (un cron en `succeeded` prueba que la funcion corrio, no que la fila llego).
--
--   Las 6 tienen EL MISMO motivo: `el link no devolvio un PDF (text/html, 9845 bytes)` —
--   COTO x3, LA ANONIMA x2, CARREFOUR x1, mails del 16/06 al 13/07. No son 6 problemas
--   distintos, es uno: el link de Planexware no sirve para bajar el PDF por ese camino.
--   Ojo tambien: las 6 tienen la fecha de entrega ya vencida (junio/julio).
--
--   NO quedan como aviso muerto permanente: el corte es por `mail_fecha`, asi que la mas
--   nueva sale sola de la ventana en ~28 dias. Para volver atras: cambiar 90 por 30.
--
-- ROLLBACK (deja de viajar lo que falló, vuelve al comportamiento anterior al 13/09):
--   borrar la tercera condición del WHERE y el CASE de `auto_aviso`.
-- =====================================================================================

create or replace function public.sync_krikos_oc_virgilio()
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_n integer;
begin
  -- Espejo COMPLETO: se vacia y se reescribe. Es chico (decenas de filas) y asi
  -- una OC que se carga bien o se descarta desaparece sola del aviso.
  delete from virgilio."GV_Krikos_OC";
  insert into virgilio."GV_Krikos_OC"
    (inbox_id, doc_id, nro_documento, cadena, sucursal, direccion,
     fecha_entrega, fecha_entrega_d, link, tiene_pdf, estado, mail_fecha, actualizado_at,
     auto_estado, auto_aviso, auto_at, order_id)
  select k.id, k.doc_id, k.nro_documento, k.cadena, k.sucursal, k.direccion,
         k.fecha_entrega,
         case when k.fecha_entrega ~ '^\d{2}/\d{2}/\d{4}'
              then to_date(left(k.fecha_entrega, 10), 'DD/MM/YYYY') else null end,
         k.link, k.storage_path is not null, k.estado, k.mail_fecha, now(),
         k.auto_estado,
         -- 2026-09-13: una OC en `error` no tiene auto_aviso, y sin motivo el aviso de la
         -- PPP no dice nada. Se manda el error_msg del ingest, que es lo que hay que leer.
         case when k.estado = 'error'
              then coalesce(nullif(btrim(k.auto_aviso), ''), k.error_msg)
              else k.auto_aviso end,
         k.auto_at, k.order_id
    from public.krikos_oc_inbox k
   where (k.estado = 'pendiente' and k.order_id is null)
      or (k.auto_estado = 'parcial' and k.auto_at > now() - interval '7 days')
      or (k.estado = 'error' and k.mail_fecha > now() - interval '90 days');
  get diagnostics v_n = row_count;
  return v_n;
end; $function$;

-- verificación
select public.sync_krikos_oc_virgilio();                       -- filas espejadas
select estado, count(*) from public.krikos_oc_inbox group by 1 order by 2 desc;
