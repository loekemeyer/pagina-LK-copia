-- Leyenda D / LC / PP del pedido calculada por el SERVIDOR (Luis, 07/10/2026).
-- YA APLICADO en LK (kwkclwhmoygunqmlegrg) el 07/10/2026. Chef: ver sql/ de paginach.
-- El navegador del cliente deja de bajar customers.debt / credit_limit; la base
-- completa deuda, credit_limit, payment_term, lc, d y pp de orders.sheets_payload
-- desde customers en cada INSERT / UPDATE de la ficha (pisa lo que mande el front).
-- sheets-proxy v74 toma esos valores de orders para el Sheet (fail-open).
-- Probado en transacción abortada: deuda 416.301,18 / límite 5.500.000 -> d X, lc OK;
-- con total 999.999.999 -> lc X. Front mandando 0 / OK queda pisado.

create or replace function public.trg_orders_leyenda_servidor()
returns trigger language plpgsql security definer set search_path = public as $f$
declare v_debt numeric; v_lc numeric; v_pt numeric; v_tot numeric; v_ok boolean;
begin
  if new.sheets_payload is null or new.customer_id is null
     or jsonb_typeof(new.sheets_payload) <> 'object' then return new; end if;
  select coalesce(c.debt,0), c.credit_limit, c.payment_term, true
    into v_debt, v_lc, v_pt, v_ok
    from customers c where c.id = new.customer_id;
  if not coalesce(v_ok,false) then return new; end if;
  v_tot := coalesce(new.total, nullif(new.sheets_payload->>'order_total','')::numeric, 0);
  new.sheets_payload := new.sheets_payload || jsonb_build_object(
    'deuda', v_debt, 'credit_limit', v_lc, 'payment_term', v_pt,
    'lc', case when v_lc is not null and v_debt + v_tot > v_lc then 'X' else 'OK' end,
    'd',  case when v_debt > 0 then 'X' else 'OK' end,
    'pp', coalesce(v_pt::text, 'Null'),
    'leyenda_origen', 'servidor');
  return new;
end $f$;

create trigger aa_orders_leyenda_servidor before insert or update of sheets_payload
  on public.orders for each row execute function public.trg_orders_leyenda_servidor();
revoke execute on function public.trg_orders_leyenda_servidor() from public, anon, authenticated;

-- ROLLBACK:
-- drop trigger aa_orders_leyenda_servidor on public.orders;
-- drop function public.trg_orders_leyenda_servidor();
