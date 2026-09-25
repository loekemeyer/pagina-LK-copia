-- =============================================================================
-- customers.debt <- Excel de deuda de Gestion Virgilio (el mismo de Cuarentena)
-- =============================================================================
-- Luis, 25/09/2026: "deja el cable para que tome el dato de la tabla que carga
-- Gestion con el excel que se sube a mano". El upload de Deuda del admin LK se
-- retiro (v2.3.484); la ultima carga fue el 05/05/2026. customers.debt lo siguen
-- leyendo el payload de cada pedido (deuda / d / lc) y el cotizador del admin.
--
-- Fuente: virgilio.gv_deuda_feed (FDW a GV_Cuarentena_Fuente tipo 'deuda').
-- Deuda negativa (plata a favor) queda en 0, igual que el upload viejo.
-- Si el feed viene vacio NO toca nada: un feed caido no es "nadie debe".
-- Solo escribe las filas que cambian.
-- APLICADO 25/09/2026 con el si de Luis: 236 clientes, 0 diferencias.
-- Backup previo: zz_backups.lk_customers_debt_20260925 (id, cod_cliente, debt).
-- Rollback: select cron.unschedule('sync-debt-desde-gestion');
--   update customers c set debt = b.debt from zz_backups.lk_customers_debt_20260925 b where b.id = c.id;
-- =============================================================================
create or replace function public.sync_debt_desde_gestion()
returns integer
language plpgsql
security definer
set search_path to 'public', 'virgilio'
as $function$
declare
  v_n int;
begin
  create temp table _feed on commit drop as
    select f.cod, greatest(sum(f.deuda), 0) as deuda
      from virgilio.gv_deuda_feed f
     where f.empresa = 'lk'
     group by f.cod;

  if not exists (select 1 from _feed) then
    raise notice 'gv_deuda_feed vacio: no se toca customers.debt';
    return 0;
  end if;

  update customers c
     set debt = coalesce(fd.deuda, 0)
    from customers c2
    left join _feed fd on fd.cod = c2.cod_cliente::text
   where c.id = c2.id
     and coalesce(c.debt, 0) is distinct from coalesce(fd.deuda, 0);
  get diagnostics v_n = row_count;
  return v_n;
end;
$function$;

revoke execute on function public.sync_debt_desde_gestion() from public, anon, authenticated;

-- minuto 17: impar, fuera de los */2, */10 y del :00 (regla de los 6 worker slots)
select cron.schedule('sync-debt-desde-gestion', '17 * * * *',
                     'select public.sync_debt_desde_gestion()');
