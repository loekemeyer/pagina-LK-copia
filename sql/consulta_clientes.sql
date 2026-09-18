-- =====================================================================
-- Modulo "Consulta de clientes"  (consulta.html + consulta.js)
-- =====================================================================
-- Acceso de SOLO LECTURA para un empleado que no es admin y tampoco es
-- cliente: entra con CUIT + clave (mismo esquema sintetico
-- <digitos>@cuit.loekemeyer que usa todo el sitio) y ve DOS cosas por cliente:
--
--   1) que le compra hoy                    -> consulta_historial(p_cod)
--   2) que NO le compra y deberia comprarle -> consulta_faltantes(p_cod)
--
-- El cliente se elige por razon social, CUIT o codigo -> consulta_buscar_clientes.
-- No hay carrito, no hay alta de pedidos, no hay padron editable: solo lectura.
--
-- SEGURIDAD (CLAUDE.md, "Postgres otorga EXECUTE a PUBLIC en cada funcion
-- nueva"): las cinco RPC son SECURITY DEFINER, llevan el guard adentro Y
-- ademas tienen EXECUTE revocado a PUBLIC/anon. El guard va con un IF de
-- plpgsql, NO colgado del FROM de una funcion SQL: Postgres elimina una
-- subconsulta de una fila cuyas columnas no se referencian y el guard queda
-- sin evaluarse (es lo que paso con gv_es_admin, ya documentado).
--
-- SOLO Loekemeyer: todo filtra empresa = 'lk'.
--
-- Reglas del checklist de reportes por cliente del CLAUDE.md que este modulo
-- respeta, y que no son opcionales:
--   * precios de v_item_precio, NO de products (products deja ~47% sin precio).
--   * sales_excluded_items siempre afuera (descuentos por pago, NC, agregados
--     de ISIS: si cuentan, corren la fecha de ultima compra).
--   * una devolucion no es una compra: las cajas se suman solo si boxes > 0.
--   * el codigo se normaliza por item_precios.base_cod, asi 504L cuenta como
--     504 (sales_lines guarda el codigo CON sufijo y el join contra products
--     lo perderia).
--
-- ⚠ Y una que se descubrio escribiendo esto (18/09/2026): "ultima compra" NO
-- es max(invoice_date). sales_lines tiene 390 lineas de lk con boxes = 0 (en
-- 40 clientes) y 6.611 con boxes < 0. Con el max pelado, Relca (2444) figuraba
-- comprando el 510 el 31/01/2026 cuando su ultima compra real fue el
-- 31/07/2025: lo del medio son ceros mensuales. Por eso las tres RPC usan
-- max(invoice_date) FILTER (WHERE boxes > 0).
--
-- Tiempos medidos el 18/09/2026 (statement_timeout ~8 s):
--   consulta_buscar_clientes  16 ms
--   consulta_historial         9 ms
--   consulta_faltantes       158 ms
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Quien puede entrar
-- ---------------------------------------------------------------------
create table if not exists public.consulta_usuarios (
  auth_user_id uuid primary key,
  nombre       text        not null,
  activo       boolean     not null default true,
  nota         text,
  creado_at    timestamptz not null default now(),
  creado_por   uuid
);

alter table public.consulta_usuarios enable row level security;

-- Cada usuario ve SOLO su propia fila (la pantalla la lee para saludarlo).
-- El alta la hace un admin desde el SQL editor / service_role.
drop policy if exists consulta_usuarios_self on public.consulta_usuarios;
create policy consulta_usuarios_self on public.consulta_usuarios
  for select to authenticated
  using (auth_user_id = auth.uid());

-- ---------------------------------------------------------------------
-- 2. Guard
-- ---------------------------------------------------------------------
create or replace function public.consulta_es_usuario()
returns boolean language sql stable security definer set search_path to 'public'
as $$
  select exists (select 1 from public.consulta_usuarios cu
                  where cu.auth_user_id = auth.uid() and cu.activo)
      or exists (select 1 from public.admins a where a.auth_user_id = auth.uid());
$$;

-- Quien soy: la pantalla la llama apenas hay sesion y, si devuelve ok=false,
-- cierra la sesion y no muestra nada.
create or replace function public.consulta_perfil()
returns jsonb language plpgsql stable security definer set search_path to 'public'
as $$
declare v jsonb;
begin
  if not public.consulta_es_usuario() then
    return jsonb_build_object('ok', false);
  end if;
  select jsonb_build_object(
           'ok', true,
           'nombre', coalesce((select cu.nombre from public.consulta_usuarios cu
                                where cu.auth_user_id = auth.uid()), 'Administrador'),
           'es_admin', exists (select 1 from public.admins a where a.auth_user_id = auth.uid())
         ) into v;
  return v;
end
$$;

-- ---------------------------------------------------------------------
-- 3. Buscador de clientes (razon social / CUIT / codigo)
-- ---------------------------------------------------------------------
-- El CUIT se compara SOLO por digitos y exige al menos 6, mismo criterio que
-- el buscador del Ranking Inactivos: sin ese piso, buscar el codigo "996"
-- devuelve ademas todos los clientes cuyo CUIT contiene "996" en algun lado.
-- Se resuelve contra customers (el padron), no contra sales_lines: un codigo
-- con ventas marcadas lk no garantiza que sea cliente de Loekemeyer.
create or replace function public.consulta_buscar_clientes(p_q text, p_limit integer default 30)
returns table(cod_cliente text, business_name text, cuit text, ultima_compra date, cajas_12m numeric)
language plpgsql stable security definer set search_path to 'public'
as $$
declare
  v_q   text := public.ficha_norm(coalesce(p_q, ''));
  v_dig text := regexp_replace(coalesce(p_q, ''), '\D', '', 'g');
  v_d12 text := to_char(current_date - interval '12 months', 'YYYY-MM-DD');
  v_lim integer := least(greatest(coalesce(p_limit, 30), 1), 100);
begin
  if not public.consulta_es_usuario() then raise exception 'no autorizado'; end if;
  v_q := btrim(v_q);
  if v_q = '' then return; end if;
  return query
  with cand as (
    select c.cod_cliente::text as cod,
           coalesce(c.business_name, '(sin razon social)') as nom,
           c.cuit as cu
      from public.customers c
     where c.cod_cliente::text = v_dig
        or public.ficha_norm(coalesce(c.business_name, '')) like '%' || v_q || '%'
        or (length(v_dig) >= 6
            and regexp_replace(coalesce(c.cuit, ''), '\D', '', 'g') like '%' || v_dig || '%')
     order by public.ficha_norm(coalesce(c.business_name, ''))
     limit v_lim
  )
  select cand.cod, cand.nom, cand.cu, m.ultima, coalesce(m.cajas, 0)
    from cand
    left join lateral (
      select max(s.invoice_date) filter (where s.boxes > 0)::date as ultima,
             sum(case when s.boxes > 0 and s.invoice_date >= v_d12 then s.boxes else 0 end)::numeric as cajas
        from public.sales_lines s
       where s.empresa = 'lk'
         and s.customer_code = cand.cod
         and s.item_code not in (select e.item_code from public.sales_excluded_items e)
    ) m on true
   order by m.ultima desc nulls last, cand.nom;
end
$$;

-- ---------------------------------------------------------------------
-- 4. Que le compra (historial por articulo)
-- ---------------------------------------------------------------------
-- cajas_12m vs cajas_prev12 es la comparacion que importa: el mismo articulo
-- en los ultimos 12 meses contra los 12 anteriores. neto_12m valoriza con la
-- cadena completa del CLAUDE.md: cajas * uxb * list_price * (1-dto_vol) * (1-web).
-- list_price es POR UNIDAD, no por caja: sin el uxb el monto sale dividido por
-- las unidades por caja (promedio 12,1, rango 1 a 100).
create or replace function public.consulta_historial(p_cod text)
returns table(cod text, descripcion text, categoria text, cajas_12m numeric,
              cajas_prev12 numeric, cajas_hist numeric, ultima_compra date, neto_12m numeric)
language plpgsql stable security definer set search_path to 'public'
as $$
declare
  v_d12 text    := to_char(current_date - interval '12 months', 'YYYY-MM-DD');
  v_d24 text    := to_char(current_date - interval '24 months', 'YYYY-MM-DD');
  v_dto numeric := 0;
  v_web numeric := 0.02;
begin
  if not public.consulta_es_usuario() then raise exception 'no autorizado'; end if;
  select coalesce(c.dto_vol, 0) into v_dto
    from public.customers c where c.cod_cliente::text = p_cod limit 1;
  v_dto := coalesce(v_dto, 0);
  select coalesce(nullif(a.value, '')::numeric, 0.02) into v_web
    from public.app_settings a where a.key = 'web_order_discount';
  v_web := coalesce(v_web, 0.02);
  return query
  with lin as (
    select coalesce(ip.base_cod, s.item_code) as c, s.boxes, s.invoice_date
      from public.sales_lines s
      left join public.item_precios ip on ip.cod = s.item_code
     where s.empresa = 'lk' and s.customer_code = p_cod
       and s.item_code not in (select e.item_code from public.sales_excluded_items e)
  ),
  agg as (
    select lin.c,
           sum(case when lin.boxes > 0 and lin.invoice_date >= v_d12 then lin.boxes else 0 end)::numeric as c12,
           sum(case when lin.boxes > 0 and lin.invoice_date >= v_d24 and lin.invoice_date < v_d12 then lin.boxes else 0 end)::numeric as cprev,
           sum(case when lin.boxes > 0 then lin.boxes else 0 end)::numeric as chist,
           max(lin.invoice_date) filter (where lin.boxes > 0) as ult
      from lin group by lin.c
  )
  select agg.c,
         coalesce(v.description, '(sin alta en el padron)'),
         v.category,
         agg.c12, agg.cprev, agg.chist, agg.ult::date,
         round(agg.c12 * coalesce(v.uxb, 0) * coalesce(v.list_price, 0) * (1 - v_dto) * (1 - v_web), 2)
    from agg
    left join public.v_item_precio v on v.cod = agg.c
   where agg.chist > 0
   order by agg.c12 desc, agg.ult desc nulls last;
end
$$;

-- ---------------------------------------------------------------------
-- 5. Que NO le compra y deberia comprarle
-- ---------------------------------------------------------------------
-- "Deberia" = penetracion: sobre los clientes de Loekemeyer que compraron
-- algo en los ultimos 12 meses, que porcentaje compra ESE articulo. Es el
-- mismo criterio de sugerencias_cliente (la pantalla del portal), con tres
-- diferencias a proposito:
--   * la ventana del cliente es de 12 meses y no 6: para un reporte de "no me
--     compra", un articulo que compro hace 8 meses no es un faltante.
--   * devuelve tambien lo que el cliente compraba ANTES y dejo de comprar
--     (ultima_compra / cajas_hist): esa es la fila mas accionable de todas.
--   * no corta en 30 filas.
-- Las cadenas de supermercado quedan fuera del UNIVERSO (compran pocos SKU en
-- volumen enorme y distorsionan la penetracion); la lista sale de
-- precios_super.cadena, que es la tabla viva, y no de codigos escritos a mano
-- como en sugerencias_cliente.
-- Se respeta item_groups: si compra una variante del mismo grupo, el grupo
-- entero no es faltante.
create or replace function public.consulta_faltantes(p_cod text, p_limit integer default 200)
returns table(cod text, descripcion text, categoria text, pct_clientes numeric,
              clientes_compran integer, cajas_mercado numeric, cajas_prom_cliente numeric,
              ultima_compra date, cajas_hist numeric)
language plpgsql stable security definer set search_path to 'public'
as $$
declare
  v_d12 text    := to_char(current_date - interval '12 months', 'YYYY-MM-DD');
  v_lim integer := least(greatest(coalesce(p_limit, 200), 1), 500);
begin
  if not public.consulta_es_usuario() then raise exception 'no autorizado'; end if;
  return query
  with univ as (
    select s.customer_code as cc, coalesce(ip.base_cod, s.item_code) as c, s.boxes as bx
      from public.sales_lines s
      left join public.item_precios ip on ip.cod = s.item_code
     where s.empresa = 'lk' and s.invoice_date >= v_d12 and s.boxes > 0
       and s.item_code not in (select e.item_code from public.sales_excluded_items e)
       and s.customer_code not in (select ca.cod_cliente_lk::text from precios_super.cadena ca
                                    where ca.cod_cliente_lk is not null)
  ),
  tot as (select count(distinct univ.cc)::numeric as n from univ),
  pen as (select univ.c, count(distinct univ.cc)::numeric as cli, sum(univ.bx)::numeric as cj
            from univ group by univ.c),
  mio as (
    select distinct coalesce(ip.base_cod, s.item_code) as c
      from public.sales_lines s
      left join public.item_precios ip on ip.cod = s.item_code
     where s.empresa = 'lk' and s.customer_code = p_cod
       and s.invoice_date >= v_d12 and s.boxes > 0
       and s.item_code not in (select e.item_code from public.sales_excluded_items e)
  ),
  grp as (select distinct ig.group_id from public.item_groups ig join mio on mio.c = ig.item_code),
  hist as (
    select coalesce(ip.base_cod, s.item_code) as c,
           max(s.invoice_date) filter (where s.boxes > 0) as ult,
           sum(case when s.boxes > 0 then s.boxes else 0 end)::numeric as cj
      from public.sales_lines s
      left join public.item_precios ip on ip.cod = s.item_code
     where s.empresa = 'lk' and s.customer_code = p_cod
       and s.item_code not in (select e.item_code from public.sales_excluded_items e)
     group by 1
  )
  select p.cod::text, p.description, p.category,
         round(pen.cli * 100.0 / nullif(tot.n, 0), 0),
         pen.cli::integer, pen.cj,
         round(pen.cj / nullif(pen.cli, 0), 1),
         h.ult::date, coalesce(h.cj, 0)
    from public.products p
    join pen on pen.c = p.cod::text
   cross join tot
    left join public.item_groups pig on pig.item_code = p.cod::text
    left join hist h on h.c = p.cod::text
   where p.active = true
     and coalesce(p.badge_status, '') <> 'SIN STOCK'
     and not exists (select 1 from mio where mio.c = p.cod::text)
     and not exists (select 1 from grp where pig.group_id = grp.group_id)
   order by pen.cli desc, pen.cj desc
   limit v_lim;
end
$$;

-- ---------------------------------------------------------------------
-- 6. Permisos
-- ---------------------------------------------------------------------
revoke all on function public.consulta_es_usuario()                   from public, anon;
revoke all on function public.consulta_perfil()                       from public, anon;
revoke all on function public.consulta_buscar_clientes(text, integer)  from public, anon;
revoke all on function public.consulta_historial(text)                from public, anon;
revoke all on function public.consulta_faltantes(text, integer)       from public, anon;

grant execute on function public.consulta_es_usuario()                   to authenticated, service_role;
grant execute on function public.consulta_perfil()                       to authenticated, service_role;
grant execute on function public.consulta_buscar_clientes(text, integer)  to authenticated, service_role;
grant execute on function public.consulta_historial(text)                to authenticated, service_role;
grant execute on function public.consulta_faltantes(text, integer)       to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 7. Alta de un usuario del modulo  (PASO MANUAL, no se corre solo)
-- ---------------------------------------------------------------------
-- El auth user va con el mismo esquema sintetico del sitio,
-- <digitos del CUIT>@cuit.loekemeyer, y la clave es el PIN.
-- OJO: email_change / confirmation_token / recovery_token van en '' y NUNCA
-- en null; gotrue rompe con "Database error finding user" si son null.
--
--   insert into auth.users (
--     instance_id, id, aud, role, email, encrypted_password,
--     email_confirmed_at, created_at, updated_at,
--     confirmation_token, recovery_token, email_change, email_change_token_new,
--     raw_app_meta_data, raw_user_meta_data)
--   values (
--     '00000000-0000-0000-0000-000000000000', gen_random_uuid(),
--     'authenticated', 'authenticated',
--     '<cuit>@cuit.loekemeyer', crypt('<clave>', gen_salt('bf')),
--     now(), now(), now(), '', '', '', '',
--     '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb)
--   returning id;
--
--   insert into public.consulta_usuarios (auth_user_id, nombre, nota)
--   values ('<id devuelto>', '<Nombre>', 'Acceso de solo lectura al modulo de consulta.');
--
-- Para dar de baja sin borrar nada:
--   update public.consulta_usuarios set activo = false where auth_user_id = '<id>';
