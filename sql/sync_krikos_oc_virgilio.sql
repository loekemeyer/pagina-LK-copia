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
--   1. `pendiente` sin pedido, con mail de los últimos **30 días** → lo que todavía hay que
--      cargar a mano y todavía se puede.
--   2. `parcial` de los últimos 7 días → entró sola pero con diferencias contra la OC; es el
--      "si el importe NO DA, QUE LO ACLARE MUY GRANDE EN PPP" del dueño.
--   3. `error` con mail de los últimos **30 días** Y **desde el 2026-09-14** → lo que falló al
--      importarse. Ver abajo por qué son dos cortes y no uno.
--   Lo que entró limpio NO viaja: ya es un pedido normal en la PPP.
--
-- `auto_aviso` en las de error lleva el `error_msg` del ingest: el front ya lo muestra en
-- `apr-krikos-aviso`, así que el motivo se lee sin abrir nada. Sin eso el aviso salía mudo.
--
-- ⚠ 2026-09-14 (Luis): *"fijate que ahí está mostrando avisos de pedidos por mail al pedo (son
-- viejos). Sacalos, debería ser de ahora en adelante la cosa para pedidos nuevos que entren"*.
-- En la PPP había **6 renglones rojos permanentes** —COTO x3, LA ANÓNIMA x2, CARREFOUR x1,
-- mails del 16/06 al 13/07— todas con el mismo motivo: `el link no devolvió un PDF`. El link
-- de Planexware ya venció y la fecha de entrega de las 6 pasó hace meses: **no hay nada que
-- alguien pueda hacer con ese aviso**, así que era ruido fijo que tapaba lo que sí importa.
--
-- POR QUÉ ESTABAN AHÍ, que no fue un descuido: el 13/09 la ventana se había ampliado a 90 días
-- A PROPÓSITO, porque hasta ese momento el espejo **nunca había entregado una sola fila** y no
-- había forma de saber si el push funcionaba (un cron en `succeeded` prueba que la función
-- corrió, no que la fila llegó del otro lado). Con 90 días viajaron las 6 y ahí quedó probado
-- el camino de punta a punta. Esa prueba ya está hecha; el ruido, no hace falta.
--
-- POR QUÉ DOS CORTES en la rama de `error`:
--   · **30 días móviles** sobre `mail_fecha` — y no sobre `created_at`, que para las viejas es
--     la fecha del backfill (11/09) y las volvería a colar. Es lo que la doc de este archivo ya
--     decía desde el 13/09; lo que estaba en 90 era el código.
--   · **piso fijo el 2026-09-14** = el "de ahora en adelante" que pidió Luis. Sin el piso, una
--     OC vieja que se re-procese hoy (el ingest la vuelve a tocar y le mueve el estado) volvería
--     a aparecer. En 30 días el corte móvil manda solo y el piso queda inocuo.
--
-- MEDIDO al aplicarlo (2026-09-14): la función devolvió **0** y `GV_Krikos_OC` quedó en 0 filas,
-- o sea que el cartel desapareció. Y no se escondió nada vivo: de las 21 OC de la bandeja, 5
-- están `cargado`, 10 `descartado` y las 6 `error` son las de junio/julio. **`pendiente` sin
-- pedido: ninguna.** Las viejas no se pierden — siguen en la Bandeja Krikos del panel de LK, que
-- es donde se resuelven (ver `sql/PENDIENTE-krikos-inbox-20260913.sql`).
--
-- ROLLBACK: sacar los cortes nuevos (volver a `(k.estado='pendiente' and k.order_id is null)` y
-- a `interval '90 days'` sin el piso). Para ver una OC vieja puntual en la PPP alcanza con eso.
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
   where
      -- PENDIENTES (hay que cargarlas a mano). Ventana de 30 dias sobre la FECHA DEL MAIL:
      -- una OC de hace mas de un mes ya no es accionable y en la PPP solo es ruido fijo.
      -- Las viejas no se pierden: siguen en la Bandeja Krikos del panel de LK.
      (k.estado = 'pendiente' and k.order_id is null and k.mail_fecha > now() - interval '30 days')
      -- Las que SI se cargaron pero con algo que no dio viajan 7 dias: es el
      -- "aclaralo MUY GRANDE en PPP" del dueno. Las que entraron limpias no
      -- viajan: ya son un pedido normal en la PPP.
      or (k.auto_estado = 'parcial' and k.auto_at > now() - interval '7 days')
      -- FALLADAS. 2026-09-14 (Luis: *"esta mostrando avisos de pedidos por mail al pedo (son
      -- viejos), sacalos, deberia ser de ahora en adelante"*): dos cortes juntos.
      --   · 30 dias moviles sobre la fecha del mail — el comentario de la v16.xx ya decia 30
      --     pero el codigo tenia 90, y por eso seguian viajando las 6 de junio/julio cuyo link
      --     de Planexware ya habia vencido: seis renglones rojos permanentes que nadie podia
      --     resolver.
      --   · y un piso fijo el 2026-09-14, que es el "de ahora en adelante" que pidio Luis: sin
      --     el piso, una OC vieja que se re-procese hoy volveria a aparecer. En 30 dias el
      --     corte movil manda solo y el piso queda inocuo.
      or (k.estado = 'error' and k.mail_fecha > now() - interval '30 days'
          and k.mail_fecha >= timestamptz '2026-09-14 00:00-03');
  get diagnostics v_n = row_count;
  return v_n;
end; $function$;

-- verificación
select public.sync_krikos_oc_virgilio();                       -- filas espejadas
select estado, count(*) from public.krikos_oc_inbox group by 1 order by 2 desc;
select estado, count(*) filter (where mail_fecha > now() - interval '30 days') dentro_de_30d
  from public.krikos_oc_inbox group by 1;
