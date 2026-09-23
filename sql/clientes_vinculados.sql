-- ===========================================================================
-- clientes_vinculados — TABLA CANÓNICA del "cliente real" (Luis, 23/09/2026)
-- ===========================================================================
-- Un mismo cliente real puede tener VARIOS códigos: cambió de razón social, se dio de
-- alta en las dos empresas, abrió otra sociedad. Sin juntarlos, un cliente de años
-- aparece como "cliente nuevo" o como "inactivo" cuando no lo es.
--
-- Esta tabla junta TODAS las fuentes de vínculo que existían por separado y le da a
-- cada código su GRUPO (el cliente real):
--
--   fuente         de dónde sale                                  alcance
--   ventas         clientes_vinculo_ventas (Excel de Ventas 23/09) LK↔LK, CH↔CH, LK↔CH
--   cuit           mismo CUIT en customers / chef_padron           cualquier par
--   grupo_admin    customer_grupos (ABM Clientes agrupados)         dentro de una empresa
--   link_manual    clientes_lk_ch_links (vínculo LK↔CH a mano)      LK↔CH
--
-- ⚠ La clave es (empresa, cod), nunca cod solo: el mismo número es otro cliente en la
--   otra empresa (regla del dueño, 16/09).
-- ⚠ La razón social NO vincula sola (da falsos positivos: "Distribuidora Veneto" vs
--   "Distribuidora Pezzali", ver customer_grupos.sql). Sólo CUIT, Ventas o una persona.
-- ⚠ Es DERIVADA: se recalcula entera con recalcular_clientes_vinculados(). No se edita a
--   mano: para agregar un vínculo se carga la fuente (una fila en clientes_vinculo_ventas,
--   un grupo en el ABM) y se recalcula.
--
-- grupo = el menor 'empresa:cod' del componente (estable mientras no cambien las fuentes).
-- principal = el código del grupo con la última compra (sales_lines), el que "vive" hoy.
-- Sólo figuran los códigos que tienen al menos otro código vinculado.
-- ===========================================================================

create table if not exists public.clientes_vinculados (
  empresa        text not null check (empresa in ('lk','chef')),
  cod            text not null,
  grupo          text not null,
  razon_social   text,
  cuit           text,
  fuentes        text[] not null default '{}',
  n_codigos      int  not null,
  ultima_compra  date,
  es_principal   boolean not null default false,
  actualizado_at timestamptz not null default now(),
  primary key (empresa, cod));
create index if not exists clientes_vinculados_grupo_idx on public.clientes_vinculados (grupo);
comment on table public.clientes_vinculados is
  'CANONICA del cliente real: cada (empresa, cod) con su grupo. Derivada de clientes_vinculo_ventas + CUIT + customer_grupos + clientes_lk_ch_links. Se recalcula con recalcular_clientes_vinculados().';
alter table public.clientes_vinculados enable row level security;
revoke all on public.clientes_vinculados from anon;
drop policy if exists clientes_vinculados_admin_read on public.clientes_vinculados;
create policy clientes_vinculados_admin_read on public.clientes_vinculados for select to authenticated
  using (exists (select 1 from admins a where a.auth_user_id = auth.uid()));

create or replace function public.recalcular_clientes_vinculados()
returns table(codigos int, grupos int, lk_ch int)
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_cambios int;
begin
  create temp table _cv_pad on commit drop as
    select 'lk'::text emp, regexp_replace(cod_cliente::text,'^0+(?=.)','') cod, business_name rs,
           nullif(regexp_replace(coalesce(cuit,''),'\D','','g'),'') cuit
      from public.customers where cod_cliente is not null
    union all
    select 'chef', regexp_replace(cod_cliente,'^0+(?=.)',''), business_name,
           nullif(regexp_replace(coalesce(cuit,''),'\D','','g'),'')
      from public.chef_padron;

  -- aristas (a, b, fuente); nodo = 'empresa:cod'
  create temp table _cv_e (a text, b text, f text) on commit drop;
  insert into _cv_e
    select empresa_a||':'||regexp_replace(cod_a,'^0+(?=.)',''), empresa_b||':'||regexp_replace(cod_b,'^0+(?=.)',''), 'ventas'
      from public.clientes_vinculo_ventas;
  insert into _cv_e
    select x.emp||':'||x.cod, y.emp||':'||y.cod, 'cuit'
      from _cv_pad x join _cv_pad y on y.cuit = x.cuit and (y.emp, y.cod) > (x.emp, x.cod)
     where length(x.cuit) = 11;
  insert into _cv_e
    select g1.empresa||':'||regexp_replace(g1.cod_cliente,'^0+(?=.)',''), g2.empresa||':'||regexp_replace(g2.cod_cliente,'^0+(?=.)',''), 'grupo_admin'
      from public.customer_grupos g1 join public.customer_grupos g2
        on g2.grupo_id = g1.grupo_id and (g2.empresa, g2.cod_cliente) > (g1.empresa, g1.cod_cliente);
  insert into _cv_e
    select l1.empresa||':'||regexp_replace(l1.cod_cliente,'^0+(?=.)',''), l2.empresa||':'||regexp_replace(l2.cod_cliente,'^0+(?=.)',''), 'link_manual'
      from public.clientes_lk_ch_links l1 join public.clientes_lk_ch_links l2
        on l2.link_id = l1.link_id and (l2.empresa, l2.cod_cliente) > (l1.empresa, l1.cod_cliente);
  delete from _cv_e where a = b;

  -- componentes conexos por propagación de etiqueta (la menor gana)
  create temp table _cv_n on commit drop as
    select n, n as g from (select a n from _cv_e union select b from _cv_e) z;
  loop
    update _cv_n t set g = s.g
      from (select x.n, min(y.g) g
              from (select a n, b m from _cv_e union all select b, a from _cv_e) x
              join _cv_n y on y.n = x.m group by x.n) s
     where s.n = t.n and s.g < t.g;
    get diagnostics v_cambios = row_count;
    exit when v_cambios = 0;
  end loop;

  delete from public.clientes_vinculados where true;
  insert into public.clientes_vinculados (empresa, cod, grupo, razon_social, cuit, fuentes, n_codigos, ultima_compra, es_principal)
  with nodo as (
    select n.n, n.g, split_part(n.n,':',1) emp, split_part(n.n,':',2) cod from _cv_n n),
  fu as (
    select n, array_agg(distinct f order by f) fuentes
      from (select a n, f from _cv_e union all select b, f from _cv_e) z group by n),
  uc as (
    select lower(empresa) emp, regexp_replace(customer_code::text,'^0+(?=.)','') cod, max(invoice_date)::date ult
      from public.sales_lines group by 1, 2),
  base as (
    select d.emp, d.cod, d.g, p.rs, p.cuit, fu.fuentes, count(*) over (partition by d.g) n_cod, uc.ult
      from nodo d join fu on fu.n = d.n
      left join _cv_pad p on p.emp = d.emp and p.cod = d.cod
      left join uc on uc.emp = d.emp and uc.cod = d.cod)
  select emp, cod, g, rs, cuit, fuentes, n_cod, ult,
         row_number() over (partition by g order by ult desc nulls last, emp, cod) = 1
    from base;

  return query select count(*)::int, count(distinct grupo)::int,
    (select count(*)::int from (select grupo from public.clientes_vinculados
       group by grupo having count(distinct empresa) = 2) z)
    from public.clientes_vinculados;
end $$;
revoke all on function public.recalcular_clientes_vinculados() from public, anon, authenticated;

-- Carga inicial de la fuente (23/09/2026): los 3 Excel de Ventas, 427 pares
-- (rs_lk 103, rs_ch 36, lk_ch 288) en clientes_vinculo_ventas. Tabla con RLS y sin grants a
-- anon/authenticated. Para agregar vínculos: insert en esa tabla + recalcular.
--
-- Recalculo automático (cron LK jobid 55, antes del sync de clientes nuevos de las :40):
--   select cron.schedule('recalcular-clientes-vinculados', '35 * * * *',
--                        'select public.recalcular_clientes_vinculados()');
--
-- Resultado al 23/09: 906 códigos en 410 clientes reales; 344 grupos cruzan LK y Chef.
-- Tamaños: 354 de 2 códigos, 39 de 3, 10 de 4, 2 de 5, 4 de 6, 1 de 7 (Kuo Mei Miao / Hsieh Yi Ta).
-- 13 códigos del Excel no están en ningún padrón (clientes dados de baja): quedan igual en el
-- grupo, con razon_social null.
--
-- Rollback:
--   select cron.unschedule('recalcular-clientes-vinculados');
--   drop function public.recalcular_clientes_vinculados();
--   drop table public.clientes_vinculados; drop table public.clientes_vinculo_ventas;
