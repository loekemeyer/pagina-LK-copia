-- =============================================================================
-- get_ficha_isis(p_cod) — la parte de la Ficha de Cliente que sale de ISIS
-- =============================================================================
-- Luis, 25/09/2026: la ficha tiene que tener la data de la planilla de cliente.
--
-- Por que NO sale de sales_lines: la planilla usa la plata REAL facturada
-- (facturas - NC, con IVA), y sales_lines es cajas valorizadas a lista de HOY.
-- Medido con Messina (LK 1573):
--   FC 2024  planilla 17.225.952  |  ISIS 17.225.952,43  |  sales_lines 21.585.838
--   FC 2025  planilla 30.048.890  |  ISIS 30.048.889,55  |  sales_lines 36.218.834
-- La fuente es virgilio.comprobantes_venta (FDW a isis_lk/isis_ch.documentos
-- de Gestion Virgilio), la misma que ya usa sincronizar_fact_live.
--
-- La DEUDA sale de virgilio.gv_deuda_feed: el MISMO Excel del ERP que usa
-- Cuarentena y que ya usa el portal del cliente (get_mi_deuda). La columna
-- customers.debt la carga a mano el upload de Deuda del admin LK y quedaba
-- vieja (Messina: 256.701,98 contra 5.700.753,28 del Excel del 25/09).
--
-- Va en una RPC aparte de get_ficha_cliente a proposito: el FDW cuesta ~0,9 s
-- y el front la llama en paralelo; si Virgilio no responde, la ficha se ve igual.
-- =============================================================================
create or replace function public.get_ficha_isis(p_cod text)
returns jsonb
language plpgsql
stable security definer
set search_path to 'public', 'virgilio'
as $function$
declare
  v_cod   text := ltrim(btrim(coalesce(p_cod,'')), '0');
  v_cuit  text;
  v_chef  text[];
  v_lkv   text[];
  v_chv   text[];
  v_anios jsonb;
  v_prim  date;
  v_deuda numeric;
  v_deuda_at timestamptz;
begin
  if not exists (select 1 from admins a where a.auth_user_id = auth.uid()) then
    raise exception 'no autorizado';
  end if;
  if v_cod = '' then return null; end if;

  select nullif(regexp_replace(coalesce(c.cuit,''),'[^0-9]','','g'),'')
    into v_cuit from customers c where c.cod_cliente::text = v_cod;

  -- mismos codigos de Chef que get_ficha_cliente (CUIT + vinculos manuales)
  select array(
    select distinct cp.cod_cliente::text from chef_padron cp
     where v_cuit is not null
       and regexp_replace(coalesce(cp.cuit,''),'[^0-9]','','g') = v_cuit
    union
    select distinct l2.cod_cliente::text from clientes_lk_ch_links l1
      join clientes_lk_ch_links l2 on l2.link_id = l1.link_id and l2.empresa = 'chef'
     where l1.empresa = 'lk' and l1.cod_cliente = v_cod
  ) into v_chef;

  -- ISIS guarda el codigo con ceros adelante de largo variable (4 a 7).
  -- Se mandan las variantes para que el filtro viaje al remoto por igualdad.
  select array_agg(distinct lpad(v_cod, n, '0'))
    into v_lkv from generate_series(greatest(length(v_cod),1), 7) n;
  select array_agg(distinct lpad(ltrim(c,'0'), n, '0'))
    into v_chv
    from unnest(coalesce(v_chef, '{}'::text[])) c,
         generate_series(1, 7) n
   where n >= length(ltrim(c,'0'));

  with comp as (
    select 'lk'::text emp, cv.familia, cv.signo, cv.fecha, cv.total
      from virgilio.comprobantes_venta cv
     where cv.marca = 'LK' and cv.contraparte_codigo = any (v_lkv)
    union all
    select 'chef', cv.familia, cv.signo, cv.fecha, cv.total
      from virgilio.comprobantes_venta cv
     where cv.marca = 'CH' and coalesce(array_length(v_chv,1),0) > 0
       and cv.contraparte_codigo = any (v_chv)
  ), c2 as (select * from comp)
  select
    (select coalesce(jsonb_agg(jsonb_build_object(
        'anio',   y,
        'fc_lk',  round(fc_lk),
        'fc_ch',  round(fc_ch),
        'fc',     round(fc_lk + fc_ch),
        'n_fact', n_fact,
        'mayor',  round(mayor)
      ) order by y desc), '[]'::jsonb)
     from (
       select extract(year from fecha)::int y,
              coalesce(sum(signo*total) filter (where emp='lk'),0)   fc_lk,
              coalesce(sum(signo*total) filter (where emp='chef'),0) fc_ch,
              count(*) filter (where familia='factura_venta')        n_fact,
              max(total) filter (where familia='factura_venta')      mayor
         from c2 group by 1
     ) a),
    (select min(fecha) from c2 where familia='factura_venta')
  into v_anios, v_prim;

  select sum(f.deuda), max(f.cargado_at)
    into v_deuda, v_deuda_at
    from virgilio.gv_deuda_feed f
   where f.empresa = 'lk' and f.cod = v_cod;

  return jsonb_build_object(
    'anios',          v_anios,
    'primera_compra', v_prim,
    'deuda',          v_deuda,
    'deuda_at',       v_deuda_at
  );
end;
$function$;

revoke execute on function public.get_ficha_isis(text) from public, anon;
grant execute on function public.get_ficha_isis(text) to authenticated, service_role;
