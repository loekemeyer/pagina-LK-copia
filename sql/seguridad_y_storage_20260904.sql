-- ============================================================================
-- get_customer_sales_history: chequeo de admin adentro  (4/9/2026)
-- ============================================================================
-- Estaba abierta a cualquier `authenticated`: un mayorista logueado podia leer
-- el historico de compras de OTRO cliente pasando su codigo. El gate de
-- analisis-venta-cliente.js es solo del navegador (chequea `admins` y redirige)
-- y no frena una llamada directa con la anon key, que es publica porque va
-- embebida en los .js que sirve GitHub Pages.
--
-- Los tres llamadores legitimos son pantallas de admin, asi que el chequeo no
-- rompe nada: admin.js, analisis-venta-cliente.js y carga-pedidos.html.
-- Definicion previa en _backup_funcdefs_20260904.

create or replace function public.get_customer_sales_history(p_customer_code text)
returns table(item_code text, total_boxes bigint)
language plpgsql security definer set search_path to 'public','pg_temp'
as $function$
begin
  if not exists (select 1 from admins a where a.auth_user_id = auth.uid()) then
    raise exception 'no autorizado';
  end if;
  return query
    select sl.item_code, sum(sl.boxes)::bigint as total_boxes
    from sales_lines sl
    where sl.customer_code = p_customer_code
    group by sl.item_code
    order by total_boxes desc;
end
$function$;

revoke execute on function public.get_customer_sales_history(text) from public, anon;
grant  execute on function public.get_customer_sales_history(text) to authenticated, service_role;


-- ============================================================================
-- pedidos-pdf-cleanup-30d: reescrito contra la Storage API  (4/9/2026)
-- ============================================================================
-- El cron hacia un DELETE directo sobre storage.objects y fallaba siempre:
--   ERROR: Direct deletion from storage tables is not allowed. Use the Storage
--          API instead.  (trigger storage.protect_delete)
--
-- El guard SE PUEDE saltear con `set local storage.allow_delete_query = 'true'`,
-- pero es el arreglo EQUIVOCADO: storage.objects es el indice, el archivo vive
-- en S3. Borrar la fila deja el archivo HUERFANO: sigue ocupando y ya no se
-- puede ni listar ni borrar. La unica via que borra los bytes es la API.
--
-- Necesita la `service_role_key` en el Vault. Mientras no este, devuelve 0 con
-- un notice (el cron termina bien) y rep_salud avisa del backlog aparte.

create or replace function public.limpiar_pedidos_pdf(p_dias int default 30, p_lote int default 100)
returns int
language plpgsql security definer set search_path to 'public','pg_temp'
as $$
declare
  v_key   text;
  v_pref  text[];
  v_req   bigint;
  v_n     int;
begin
  select decrypted_secret into v_key
    from vault.decrypted_secrets where name = 'service_role_key' limit 1;

  select count(*) into v_n from storage.objects
   where bucket_id='pedidos-pdf' and created_at < now() - (p_dias||' days')::interval;

  if v_key is null then
    raise notice 'faltan % PDFs por borrar: cargar service_role_key en el Vault', v_n;
    return 0;
  end if;

  if v_n = 0 then return 0; end if;

  select array_agg(name) into v_pref from (
    select name from storage.objects
     where bucket_id='pedidos-pdf' and created_at < now() - (p_dias||' days')::interval
     order by created_at limit p_lote
  ) z;

  select net.http_delete(
           url     := 'https://kwkclwhmoygunqmlegrg.supabase.co/storage/v1/object/pedidos-pdf',
           headers := jsonb_build_object('Content-Type','application/json',
                                         'Authorization','Bearer '||v_key,
                                         'apikey', v_key),
           body    := jsonb_build_object('prefixes', to_jsonb(v_pref))
         ) into v_req;

  return coalesce(array_length(v_pref,1),0);
end $$;

revoke execute on function public.limpiar_pedidos_pdf(int,int) from public, anon, authenticated;

select cron.alter_job(
  (select jobid from cron.job where jobname='pedidos-pdf-cleanup-30d'),
  command := 'select public.limpiar_pedidos_pdf(30, 100);'
);
