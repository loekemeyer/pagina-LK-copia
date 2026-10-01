-- =====================================================================
-- Ventas de ISIS: alarma de frescura (D6) + freno de fuente vacía (D7)
-- Proyecto LK (kwkclwhmoygunqmlegrg). Aplicado el 01/10/2026.
-- Pedido de Tomás Beviglia. Se aplica SOBRE la definición viva
-- (pg_get_functiondef), es idempotente y falla si el texto cambió.
--
-- D6 · rep_salud() bloque 4. Antes avisaba por el lote MENSUAL del ERP
--      (CSV a mano). Desde el 14/09 el cron 45 trae las facturas de ayer, así
--      que el aviso ahora mide DÍAS HÁBILES sin facturas nuevas:
--      LK  >= 2 🟠 · >= 3 🔴   (hueco natural medido desde junio: 1)
--      Chef >= 4 🟠 · >= 5 🔴  (hueco natural: hasta 3, 7 veces de 2+)
--      Sale por el Telegram de las 08:05 (cron 33). No mira feriados.
-- D7 · gv_sales_lines_auto_sync(): si ISIS trae menos del 80 % de las filas
--      que hay hoy en la ventana, RAISE y no se borra nada. El cron 45 queda
--      en rojo y lo canta el bloque 1 de rep_salud (crons fallidos).
--
-- Probado en transacción abortada (01/10): con isis_ventas vacío frenó
-- ("ISIS trae 0 filas contra 34330 de hoy") y sales_lines quedó en 34.330;
-- con isis_ventas normal pasó (borradas 34.330, insertadas 34.331).
-- =====================================================================
do $$ declare v text; i4 int; i5 int;
  ancla text := '  if to_regclass(''zz_backups."GV_Backup_Sales_Lines_PreISIS"'') is null then';
begin
  -- D6
  v := pg_get_functiondef('public.rep_salud()'::regprocedure);
  if position('dias habiles sin facturas' in v) = 0 then
    i4 := position('  -- 4. El lote mensual del ERP no llego.' in v);
    i5 := position('  -- 5. Cajas que no se pueden valorizar.' in v);
    if i4 = 0 or i5 < i4 then raise exception 'rep_salud cambió'; end if;
    execute substr(v,1,i4-1) || $b$  -- 4. Ventas de ISIS (cron 45 trae las de ayer). LK 2 / Chef 4 dias habiles sin facturas = se corto.
  select case when habiles >= umbral + 1 then '🔴' else '🟠' end, 'ventas ISIS ' || empresa,
         'sales_lines llega hasta ' || ult || ': ' || habiles || ' días hábiles sin facturas nuevas'
  from (select s.empresa, max(s.invoice_date) ult,
               case s.empresa when 'lk' then 2 else 4 end umbral,
               (select count(*) from generate_series(max(s.invoice_date)::date + 1, current_date - 1, interval '1 day') d
                 where extract(isodow from d) < 6) habiles
          from sales_lines s where s.empresa in ('lk','chef') group by s.empresa) x
  where habiles >= umbral

  union all
$b$ || substr(v, i5);
  end if;
  -- D7
  v := pg_get_functiondef('public.gv_sales_lines_auto_sync(boolean)'::regprocedure);
  if position('guard-fuente-vacia' in v) = 0 then
    if position(ancla in v) = 0 then raise exception 'gv_sales_lines_auto_sync cambió'; end if;
    execute replace(v, ancla, '  -- guard-fuente-vacia (01/10/2026): una lectura rota no es un cero.
  if v_isis_filas < 0.8 * v_hoy_filas then
    raise exception ''ISIS trae % filas contra % de hoy: no se borra nada'', v_isis_filas, v_hoy_filas;
  end if;

' || ancla);
  end if;
end $$;

-- Chequeo
-- select proname, position('dias habiles sin facturas' in prosrc) > 0 d6,
--        position('guard-fuente-vacia' in prosrc) > 0 d7
--   from pg_proc where proname in ('rep_salud','gv_sales_lines_auto_sync');

-- ---------------------------------------------------------------------
-- ROLLBACK
-- ---------------------------------------------------------------------
-- D7: sacar el guard
-- do $$ declare v text; begin
--   v := pg_get_functiondef('public.gv_sales_lines_auto_sync(boolean)'::regprocedure);
--   execute regexp_replace(v, '  -- guard-fuente-vacia.*?end if;\n\n', '', 's');
-- end $$;
--
-- D6: volver al bloque 4 viejo (lote mensual del ERP). Reemplazar el bloque
-- "-- 4. Ventas de ISIS ..." hasta su "union all" por:
--   -- 4. El lote mensual del ERP no llego. Se carga a mano entre el 2 y el 14.
--   select case when extract(day from current_date) > 14 then '🔴' else '🟠' end, 'ERP',
--          'sales_lines llega hasta ' || ult || ', ya estamos en ' || to_char(current_date,'YYYY-MM')
--   from (select left(max(invoice_date),7) as ult from sales_lines where empresa='lk') x
--   where ult < to_char(current_date - interval '1 month','YYYY-MM')
--     and extract(day from current_date) >= 5
--
--   union all
