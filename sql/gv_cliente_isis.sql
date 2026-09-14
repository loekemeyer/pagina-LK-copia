-- =====================================================================================
-- gv_cliente_isis — a qué ISIS se factura cada cliente de LK, empujado a Gestión Virgilio
-- 2026-09-14 (pedido de Thomas). Lado LK de la v17.75 de `Gestion-Virgilio`.
-- =====================================================================================
-- POR QUÉ EXISTE. Un cliente de Tierra del Fuego compra artículos de Loekemeyer pero se
-- le factura por Chef: carga el pedido desde la
-- página de LK y los artículos salen con la L pegada (505 → 505L). Eso ya lo resuelve
-- `v_pedidos_web` acá mismo, con `isis_empresa` y `cod_isis`.
--
-- Lo que faltaba estaba del otro lado: la CUARENTENA de Gestión (deuda / estado / límite de
-- crédito) seguía mirando el padrón de LK, donde esos clientes tienen **límite 0** y varios
-- figuran **Suspendido** — justamente porque a ellos no se les vende por LK. Un pedido sano
-- quedaba retenido (pasó con LK 1431, Il Cheff, el 14/09).
--
-- Gestión necesita entonces saber, por cliente, a qué padrón mirarle la deuda. Como Virgilio
-- no tiene FDW hacia LK (es LK el que empuja, igual que `sync_pedidos_match_virgilio` y
-- `sync_clientes_nuevos_virgilio`), el mapeo se calcula acá y se escribe allá.
--
-- QUIÉN ENTRA: cliente de LK con **todas** sus direcciones de entrega en Tierra del Fuego, o
-- con `gv_isis_override` mandándolo a Chef, y con el CUIT presente en `chef_padron`. Al
-- 14/09 son **9**. La Anónima (771) queda afuera por las dos vías: su override dice 'lk'
-- (dueño 07/09: *"se le vende por LK, no por CH"*) y 10 de sus 11 sucursales no son de TdF.
--
-- ⚠ CENCOSUD NO ENTRA POR ACÁ, Y NO HAY QUE DARLO DE ALTA (dueño, 14/09: *"Cencosud sube
-- pedido por Krikos y eso lo detectaba… siempre (histórico) subió pedidos por CH. No lo voy
-- a dar de alta."*). No está en `customers` (0 filas con el CUIT 30590360763) y no lo
-- necesita: **no carga por la página**. Sus OC entran por Krikos y la Bandeja las manda
-- derecho al portal de Chef — `precios_super.cadena` lo tiene con `empresa='chef'`,
-- `cod_cliente_chef='2444'` y `cod_cliente_lk` nulo. Medido: 4.452 líneas del 2444 en
-- `sales_lines` marcadas `chef`, del 2021-05-27 a hoy, ninguna en LK. Su caso propio —NP de
-- Chef con artículos de Loeke SIN la L— lo cubre `gv_fac_ajustes_isis` de Gestión: es el
-- caso INVERSO al de Tierra del Fuego.
--
-- ROLLBACK: `select cron.unschedule('sync-cliente-isis-virgilio');` y, en Virgilio,
-- `delete from public."GV_Cliente_Isis" where empresa is not null;`
-- =====================================================================================

-- ── 1) el cálculo ────────────────────────────────────────────────────────────────────
create or replace view public.gv_cliente_isis_calc as
with c as (
  select cu.id, cu.cod_cliente::text as cod, cu.business_name,
         nullif(regexp_replace(coalesce(cu.cuit,''), '\D', '', 'g'), '') as cuit
    from public.customers cu
), dir as (
  select d.customer_id,
         count(*) as n,
         count(*) filter (where coalesce(d.provincia,'') ilike '%tierra del fuego%') as tdf
    from public.customer_delivery_addresses d
   group by 1
), res as (
  select 'lk'::text as empresa, c.cod,
         coalesce(ov.isis_empresa,
                  case when coalesce(dir.n,0) > 0 and dir.tdf = dir.n then 'chef' else 'lk' end) as isis_empresa,
         (select p.cod_cliente::text from public.chef_padron p
           where nullif(regexp_replace(coalesce(p.cuit,''), '\D', '', 'g'), '') = c.cuit
           order by p.cod_cliente limit 1) as cod_isis,
         c.business_name as razon_social, c.cuit,
         case when ov.isis_empresa is not null then 'override' else 'tierra_del_fuego' end as motivo
    from c
    left join public.gv_isis_override ov on ov.cuit = c.cuit
    left join dir on dir.customer_id = c.id
   where c.cuit is not null
)
select empresa, cod, isis_empresa, cod_isis, razon_social, cuit, motivo
  from res
 where isis_empresa <> 'lk' and cod_isis is not null;

-- Es padrón de clientes: no la ve el navegador. La lee sólo la función de abajo.
revoke all on public.gv_cliente_isis_calc from public, anon, authenticated;

-- ── 2) la foreign table ──────────────────────────────────────────────────────────────
create foreign table if not exists virgilio.cliente_isis (
  empresa text, cod text, isis_empresa text, cod_isis text,
  razon_social text, cuit text, motivo text, actualizado_at timestamptz
) server virgilio_db options (schema_name 'public', table_name 'GV_Cliente_Isis');

-- ── 3) el push ───────────────────────────────────────────────────────────────────────
create or replace function public.sync_cliente_isis_virgilio()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_n integer;
begin
  -- 2026-09-14 (Thomas) — empuja a Gestion Virgilio el mapeo cliente LK -> cliente de ISIS
  -- Chef para los pedidos que se facturan por Chef (Tierra del Fuego, y cualquier CUIT
  -- puesto a mano en gv_isis_override). Mismo patron que sync_clientes_nuevos_virgilio: LK
  -- escribe por el FDW con el rol lk_ppp_reader y Virgilio lee una tabla local.
  -- Reemplazo total (la lista es de 9 clientes). Si el calculo da 0 NO se pisa nada: una
  -- lista vacia volveria a evaluar la Cuarentena contra el padron LK, que es justo el bug
  -- que esto arregla (problema 192 de github_repo_problemas).
  create temp table _ci on commit drop as
    select empresa, cod, isis_empresa, cod_isis, razon_social, cuit, motivo
      from public.gv_cliente_isis_calc;
  select count(*) into v_n from _ci;
  if v_n = 0 then
    raise notice 'sync_cliente_isis_virgilio: 0 filas, no se pisa nada';
    return 0;
  end if;
  delete from virgilio.cliente_isis where empresa is not null;
  insert into virgilio.cliente_isis (empresa, cod, isis_empresa, cod_isis, razon_social, cuit, motivo, actualizado_at)
  select empresa, cod, isis_empresa, cod_isis, razon_social, cuit, motivo, now() from _ci;
  return v_n;
end;
$function$;

revoke all on function public.sync_cliente_isis_virgilio() from public, anon, authenticated;
grant execute on function public.sync_cliente_isis_virgilio() to service_role;

-- ── 4) el cron (jobid 47) ────────────────────────────────────────────────────────────
-- select cron.schedule('sync-cliente-isis-virgilio', '7-59/15 * * * *',
--                      $$select public.sync_cliente_isis_virgilio();$$);
