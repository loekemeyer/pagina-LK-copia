-- =====================================================================
-- Ficha de Cliente del panel de CHEF (Luis, 28/09/2026).
--
-- La ficha de Chef (paginach/ficha-cliente.js) lee los datos del cliente de su
-- propia base (customers, sucursales). Lo que Chef NO tiene es la facturacion de
-- ISIS ni el Excel de deuda del ERP: viven en Gestion Virgilio y LK ya los lee por
-- FDW (esquema virgilio). Esta funcion es el gemelo de get_ficha_isis ANCLADO EN
-- EL CODIGO DE CHEF: FC por anio (CH + las razones sociales LK del mismo CUIT o
-- vinculadas a mano), primera compra y deuda del cliente de Chef.
--
-- Seguridad: NO la llama el navegador. La llama la Edge Function `ficha-chef`
-- con la service key, despues de verificar que el token es de un admin de Chef.
-- Por eso EXECUTE es SOLO de service_role (el guard de adentro lo repite).
-- =====================================================================
create or replace function public.get_ficha_isis_chef(p_cod text)
returns jsonb
language plpgsql
stable security definer
set search_path to 'public', 'virgilio'
as $function$
declare
  v_cod   text := ltrim(btrim(coalesce(p_cod,'')), '0');
  v_cuit  text;
  v_lk    text[];
  v_lkv   text[];
  v_chv   text[];
  v_anios jsonb;
  v_prim  date;
  v_deuda numeric;
  v_deuda_at timestamptz;
begin
  if coalesce(auth.role(), '') in ('anon','authenticated') then
    raise exception 'no autorizado';
  end if;
  if v_cod = '' then return null; end if;

  select nullif(regexp_replace(coalesce(cp.cuit,''),'[^0-9]','','g'),'')
    into v_cuit from chef_padron cp where cp.cod_cliente::text = v_cod limit 1;

  -- razones sociales de LK del mismo cliente: por CUIT o vinculadas a mano
  select array(
    select distinct c.cod_cliente::text from customers c
     where v_cuit is not null and c.cod_cliente is not null
       and regexp_replace(coalesce(c.cuit,''),'[^0-9]','','g') = v_cuit
    union
    select distinct l2.cod_cliente::text from clientes_lk_ch_links l1
      join clientes_lk_ch_links l2 on l2.link_id = l1.link_id and l2.empresa = 'lk'
     where l1.empresa = 'chef' and l1.cod_cliente = v_cod
  ) into v_lk;

  select array_agg(distinct lpad(v_cod, n, '0'))
    into v_chv from generate_series(greatest(length(v_cod),1), 7) n;
  select array_agg(distinct lpad(ltrim(c,'0'), n, '0'))
    into v_lkv
    from unnest(coalesce(v_lk, '{}'::text[])) c, generate_series(1, 7) n
   where n >= length(ltrim(c,'0'));

  with c2 as (
    select 'chef'::text emp, cv.familia, cv.signo, cv.fecha, cv.total
      from virgilio.comprobantes_venta cv
     where cv.marca = 'CH' and cv.contraparte_codigo = any (v_chv)
    union all
    select 'lk', cv.familia, cv.signo, cv.fecha, cv.total
      from virgilio.comprobantes_venta cv
     where cv.marca = 'LK' and coalesce(array_length(v_lkv,1),0) > 0
       and cv.contraparte_codigo = any (v_lkv)
  )
  select
    (select coalesce(jsonb_agg(jsonb_build_object(
        'anio', y, 'fc_lk', round(fc_lk), 'fc_ch', round(fc_ch),
        'fc', round(fc_lk + fc_ch), 'n_fact', n_fact, 'mayor', round(mayor)
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
   where f.empresa = 'chef' and ltrim(f.cod,'0') = v_cod;

  return jsonb_build_object(
    'anios', v_anios, 'primera_compra', v_prim,
    'deuda', v_deuda, 'deuda_at', v_deuda_at,
    'lk_cods', to_jsonb(coalesce(v_lk, '{}'::text[])),
    -- Acuerdo de Chef (Luis, 28/09/2026): MISMOS parametros que LK (indice,
    -- pago, cotizador, flete, piso); dto de volumen y comision salen de Chef.
    'acuerdo_parametros', (select jsonb_build_object(
        'indice_lista', ap.indice_lista, 'dto_pago', ap.dto_pago, 'dto_cot', ap.dto_cot,
        'flete', ap.flete, 'piso', ap.piso, 'dto_pago_anterior', ap.dto_pago_anterior)
      from acuerdo_parametros ap where ap.id = 1),
    -- Comision: el MISMO % que tiene el cliente en Loekemeyer (Luis, 28/09/2026).
    -- Varia por cliente aun dentro del mismo vendedor, asi que va por el cod LK
    -- vinculado. Si hay mas de una razon social LK, la MAYOR (acuerdo conservador).
    -- null = sin cliente LK vinculado o sin fila de comision.
    'comision_lk', (select jsonb_build_object('rate', cc.rate, 'cod', cc.cod_cliente,
                                              'vendedor', cc.vendor_label)
                      from customer_commissions cc
                     where cc.cod_cliente::text = any (coalesce(v_lk, '{}'::text[]))
                     order by cc.rate desc nulls last, cc.cod_cliente limit 1)
  );
end;
$function$;

revoke all on function public.get_ficha_isis_chef(text) from public, anon, authenticated;
grant execute on function public.get_ficha_isis_chef(text) to service_role;
