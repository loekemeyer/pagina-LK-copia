-- ⚠ EJECUTADO el 30/09/2026 ~11:50 ART, con dos diferencias contra lo de abajo:
--   1) 1540 (Hiper Bazar) SE EXCLUYÓ: su tanda E18C ya tenía picking (34 eventos, 72 movimientos).
--      Sigue partido: LK 0254 en E95A.
--   2) El paso 2 NO lo hace el armado: el pase intradía corta antes del resync si no hay nada
--      pendiente. Se corrió a mano: ppp_web_resync con el feed de LK de 1473/1486/1560/1565/1574,
--      gv_ppp_web_np_asignar para 1574 idx 2 (entró MRG 1575 → LK 0286 en F34A) y PPP_Web_Base
--      rehecha desde el feed. Backups: zz_backups."GV_Backup_Partidos_{Prog,Base,NP}_20260930".
--      MRG 1575 ya estaba programado aparte (F35A) y se borró de Gestión.
-- juntar_pedidos_partidos_20260930.sql — Luis, 30/09/2026
-- Junta la parte separada por importados sin stock con el pedido principal, SÓLO donde
-- nada está empezado (sin eventos, sin movimientos de stock, sin armado, sin factura).
-- Medido el 30/09 antes de escribir.
--
--   caso A · pedido aparte creado por la página (hijo -> padre):
--     1561 -> 1560 R Cuarto (padre programado E97A 05/10, hijo LK 0257 en F11A 11/11)
--     1556 -> 1555 y 1558 -> 1557 Autoservicio Capo (sin programar)
--     1575 -> 1574 MRG Soluciones (sin programar, de hoy)
--   caso B · la NP diferida del mismo pedido (se borra la marca y la NP se re-corta):
--     1486 Nuñez      F21D 08/10 · se va LK 0149 (E95A)
--     1540 Hiper      E18C 02/10 · se van LK 0227 (E18C) y LK 0254 (E95A)
--     1565 Bolinaga   F22B 06/10 · se va LK 0264 (F29A)
--     1473 De Prima   F18A 05/10 · 37 líneas = siguen 3 NP: la 3.ª pasa a F18A 05/10
--
-- NO se tocan: Solia (armado), Laza (armado), Fioriti/Silvano/Spillare/Grandes Bazares
-- (principal facturado), Luiggy (prueba, anulado).

-- ============ PASO 1 · base LK (kwkclwhmoygunqmlegrg), una transacción ============
begin;
create table public.bkp_partidos_20260930_diferido as
  select * from public.pedido_diferido where empresa='lk'
   and order_id in (1473,1486,1540,1565,1556,1558,1561,1575);
create table public.bkp_partidos_20260930_orders as
  select * from public.orders where id in (1555,1556,1557,1558,1560,1561,1574,1575);
create table public.bkp_partidos_20260930_items as
  select * from public.order_items where order_id in (1556,1558,1561,1575);
alter table public.bkp_partidos_20260930_diferido enable row level security;
alter table public.bkp_partidos_20260930_orders   enable row level security;
alter table public.bkp_partidos_20260930_items    enable row level security;
revoke all on public.bkp_partidos_20260930_diferido, public.bkp_partidos_20260930_orders,
              public.bkp_partidos_20260930_items from anon, authenticated;

-- la demanda sin stock queda anotada a nombre del pedido que sobrevive
update public.pedido_sin_stock s set order_id = m.padre
  from (values (1556,1555),(1558,1557),(1561,1560),(1575,1574)) m(hijo,padre)
 where s.empresa='lk' and s.order_id = m.hijo;

-- caso B + hijos: sin marca de diferido
delete from public.pedido_diferido where empresa='lk'
   and order_id in (1473,1486,1540,1565,1556,1558,1561,1575);

-- caso A: las líneas del hijo pasan al padre
update public.order_items i set order_id = m.padre
  from (values (1556,1555),(1558,1557),(1561,1560),(1575,1574)) m(hijo,padre)
 where i.order_id = m.hijo;
update public.orders p
   set sheets_payload = jsonb_set(p.sheets_payload, '{items}',
                          (p.sheets_payload->'items') || (h.sheets_payload->'items')),
       total = p.total + h.total
  from (values (1556,1555),(1558,1557),(1561,1560),(1575,1574)) m(hijo,padre)
  join public.orders h on h.id = m.hijo
 where p.id = m.padre;
delete from public.orders where id in (1556,1558,1561,1575);
commit;

-- empujar ya a Gestión (sin esperar el cron)
select public.sync_diferido_virgilio(45);
select public.sync_pedidos_match_virgilio();

-- ============ PASO 2 · Gestión (hrxfctzncixxqmpfhskv), DESPUÉS de una corrida del armado (≤5 min) ============
begin;
create table zz_backups."GV_Backup_Partidos_Prog_20260930" as
  select * from public."PPP_Web_Programacion" where empresa='lk'
   and order_id in (1473,1486,1540,1565,1556,1558,1561,1575);
create table zz_backups."GV_Backup_Partidos_Base_20260930" as
  select * from public."PPP_Web_Base" where empresa='lk'
   and order_id in (1473,1486,1540,1565,1556,1558,1561,1575);
alter table zz_backups."GV_Backup_Partidos_Prog_20260930" enable row level security;
alter table zz_backups."GV_Backup_Partidos_Base_20260930" enable row level security;

-- el pedido hijo desaparece de Gestión (sólo 1561 tenía NP: LK 0257)
delete from public."PPP_Web_Base"        where empresa='lk' and order_id in (1556,1558,1561,1575);
delete from public."PPP_Web_Programacion" where empresa='lk' and order_id in (1556,1558,1561,1575);
delete from public."PPP_Web_NP"          where empresa='lk' and order_id in (1556,1558,1561,1575);

-- De Prima: la 3.ª NP va con el resto del pedido
update public."PPP_Web_Programacion" g
   set tanda = p.tanda, fecha_entrega = p.fecha_entrega, zona = p.zona
  from public."PPP_Web_Programacion" p
 where g.empresa='lk' and g.order_id=1473 and g.np_idx=3
   and p.empresa='lk' and p.order_id=1473 and p.np_idx=1;

-- picking de NP que ya no existen
delete from public."PPP_Web_Base" b
 where b.empresa='lk' and b.order_id in (1473,1486,1540,1565)
   and not exists (select 1 from public."PPP_Web_Programacion" g
                    where g.empresa=b.empresa and g.order_id=b.order_id and g.np_idx=b.np_idx);
commit;

-- Verificación
-- select order_id, np_idx, gv_ppp_web_np_label(empresa,np,np_idx), tanda, fecha_entrega, lineas, cajas
--   from "PPP_Web_Programacion" where empresa='lk' and order_id in (1473,1486,1540,1565,1555,1557,1560,1574) order by 1,2;
-- select * from "GV_PPP_Web_Diferido" where order_id in (1473,1486,1540,1565);   -- vacía
-- select * from gv_ppp_tanda_camion_mezclado; select * from gv_ppp_tanda_dos_dias;  -- vacías
