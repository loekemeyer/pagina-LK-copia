-- sql/ficha_isis_detalle.sql — de dónde sale la FC / Mayor compra / Cant. FC de la Ficha de Cliente.
-- 09/10/2026. Pedido: al tocar una celda de la hoja, un pop-up que muestre de dónde toma el dato.
--
-- get_ficha_isis_detalle(p_cod, p_anio) devuelve los comprobantes de ISIS (facturas, NC y ND,
-- con IVA) que suman la celda de ese año: EXACTAMENTE el mismo universo que get_ficha_isis
-- (mismas variantes de código con ceros, mismos códigos de Chef por CUIT o vínculo manual).
-- Si se cambia el criterio de get_ficha_isis, cambiarlo acá también.
--
-- La foránea virgilio.comprobantes_venta no traía el número del comprobante: se le agregan
-- letra, punto_venta y numero (postgres_fdw sólo trae las columnas que pide cada consulta:
-- a los demás lectores no les cambia nada).
-- Rollback:
--   drop function if exists public.get_ficha_isis_detalle(text, int);
--   alter foreign table virgilio.comprobantes_venta drop column letra, drop column punto_venta, drop column numero;

alter foreign table virgilio.comprobantes_venta
  add column if not exists letra text,
  add column if not exists punto_venta text,
  add column if not exists numero text;

create or replace function public.get_ficha_isis_detalle(p_cod text, p_anio int)
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
  v_rows  jsonb;
begin
  if not exists (select 1 from admins a where a.auth_user_id = auth.uid()) then
    raise exception 'no autorizado';
  end if;
  if v_cod = '' or p_anio is null then return null; end if;

  -- ≡ get_ficha_isis
  select nullif(regexp_replace(coalesce(c.cuit,''),'[^0-9]','','g'),'')
    into v_cuit from customers c where c.cod_cliente::text = v_cod;
  select array(
    select distinct cp.cod_cliente::text from chef_padron cp
     where v_cuit is not null
       and regexp_replace(coalesce(cp.cuit,''),'[^0-9]','','g') = v_cuit
    union
    select distinct l2.cod_cliente::text from clientes_lk_ch_links l1
      join clientes_lk_ch_links l2 on l2.link_id = l1.link_id and l2.empresa = 'chef'
     where l1.empresa = 'lk' and l1.cod_cliente = v_cod
  ) into v_chef;
  select array_agg(distinct lpad(v_cod, n, '0'))
    into v_lkv from generate_series(greatest(length(v_cod),1), 7) n;
  select array_agg(distinct lpad(ltrim(c,'0'), n, '0'))
    into v_chv
    from unnest(coalesce(v_chef, '{}'::text[])) c, generate_series(1, 7) n
   where n >= length(ltrim(c,'0'));

  with comp as (
    select 'lk'::text emp, cv.familia, cv.signo, cv.fecha, cv.total, cv.tipo, cv.letra,
           cv.punto_venta, cv.numero, cv.total_cajas, cv.contraparte_codigo, cv.contraparte_nombre
      from virgilio.comprobantes_venta cv
     where cv.marca = 'LK' and cv.contraparte_codigo = any (v_lkv)
       and cv.fecha >= make_date(p_anio,1,1) and cv.fecha < make_date(p_anio+1,1,1)
    union all
    select 'chef', cv.familia, cv.signo, cv.fecha, cv.total, cv.tipo, cv.letra,
           cv.punto_venta, cv.numero, cv.total_cajas, cv.contraparte_codigo, cv.contraparte_nombre
      from virgilio.comprobantes_venta cv
     where cv.marca = 'CH' and coalesce(array_length(v_chv,1),0) > 0
       and cv.contraparte_codigo = any (v_chv)
       and cv.fecha >= make_date(p_anio,1,1) and cv.fecha < make_date(p_anio+1,1,1)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'emp', emp, 'familia', familia, 'signo', signo, 'fecha', fecha,
           'tipo', tipo, 'letra', letra, 'pv', punto_venta, 'numero', numero,
           'total', total, 'cajas', total_cajas,
           'cod', contraparte_codigo, 'nombre', contraparte_nombre)
         order by fecha, emp, numero), '[]'::jsonb)
    into v_rows from comp;

  return jsonb_build_object(
    'anio', p_anio,
    'cods_lk', to_jsonb(v_lkv),
    'cods_ch', to_jsonb(coalesce(v_chef,'{}'::text[])),
    'cuit', v_cuit,
    'comprobantes', v_rows);
end;
$function$;

revoke execute on function public.get_ficha_isis_detalle(text, int) from public, anon;
grant execute on function public.get_ficha_isis_detalle(text, int) to authenticated, service_role;
