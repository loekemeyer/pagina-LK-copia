-- Proyección: excluir ventas intercompañía Chef -> Loekemeyer (Luis, 25/09/2026)
-- Aplicado en LK (kwkclwhmoygunqmlegrg) sobre la definición VIVA de _fn_proy_window.
-- En Chef, Loekemeyer Hnos S.R.L. es el cliente 1434 (CUIT 30515842450).
-- Sus líneas en sales_lines (empresa='chef', customer_code='1434') son traspasos
-- entre empresas, no demanda: 321 líneas, 38.176 cajas netas desde 2021-07.
-- El filtro viejo ('1','3878') NO lo cubría: '1' es Loekemeyer en LK y Tierra Nativa en Chef.
do $$
declare d text; n text;
begin
  d := pg_get_functiondef('public._fn_proy_window(integer)'::regprocedure);
  if position('1434' in d) > 0 then raise notice 'ya aplicado'; return; end if;
  n := replace(d, E'and sl.customer_code not in (''1'',''3878'')\n',
    E'and sl.customer_code not in (''1'',''3878'')\n      -- Chef -> Loekemeyer Hnos (chef 1434): venta intercompania, no es demanda (Luis 25/09/2026)\n      and not (sl.empresa = ''chef'' and sl.customer_code = ''1434'')\n');
  if n = d then raise exception 'patron no encontrado, no se aplico'; end if;
  execute n;
end $$;

-- Rollback: la misma función sin la línea `and not (sl.empresa = 'chef' and sl.customer_code = '1434')`.

-- Movimientos históricos identificados:
-- select item_code, invoice_date, sum(boxes) from sales_lines
--  where empresa='chef' and customer_code='1434' group by 1,2 order by 2,1;
