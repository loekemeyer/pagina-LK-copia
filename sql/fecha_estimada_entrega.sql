-- =====================================================================
-- FECHA ESTIMADA DE ENTREGA POR ZONA (aplicado en Supabase LK el 10/9/2026,
-- migración "fecha_estimada_entrega_por_zona"). La base es la fuente de
-- verdad; este archivo es la copia de referencia.
--
-- Regla del dueño:
--   base  = última fecha REAL de programación en Gestión Virgilio
--           (ppp_programacion, empresa='lk', zonas 1-7, sin Super/Retira,
--           ventana de 15 días para ignorar bookings sueltos a semanas)
--   fecha = base + N días HÁBILES (lun-vie) según la zona del barrio de la
--           sucursal elegida (customer_delivery_addresses.zona_expreso)
--
-- Offsets por zona (entrega_zona_config, EDITABLE):
--   1 CABA Sur +1 · 2 CABA Centro +2 · 3 CABA Oeste +4 · 4 GBA Sur +4
--   5 GBA Oeste +5 · 6 GBA Norte +6 · 7 GBA Norte Lejos +6
--   (parseados del dictado del 10/9 — confirmar; se cambian con un UPDATE)
--
-- Mapa barrio→zona (entrega_barrio_zona, EDITABLE): semilla = los 39 barrios
-- que Virgilio ya programó (unívocos). Los que faltan se agregan a mano:
--   insert into entrega_barrio_zona (barrio_norm, zona) values ('villa devoto', 3);
-- Villa Devoto quedó cargado a mano el 10/9 (zona 3, A CONFIRMAR) para poder
-- probar con el cliente de prueba Tierra Nativa.
--
-- Pendiente: feriados (hoy solo se saltan sábados y domingos).
-- El portal la consume con:  sb.rpc('get_fecha_estimada_entrega',
--   { p_customer_id, p_slot })  → {fecha, zona, base, dias_habiles} | {fecha:null, motivo}
-- =====================================================================

create table if not exists public.entrega_zona_config (
  zona          smallint primary key,
  dias_habiles  smallint not null,
  descripcion   text,
  actualizado_at timestamptz not null default now()
);
insert into public.entrega_zona_config (zona, dias_habiles, descripcion) values
  (1, 1, 'CABA Sur'),
  (2, 2, 'CABA Centro'),
  (3, 4, 'CABA Oeste'),
  (4, 4, 'GBA Sur'),
  (5, 5, 'GBA Oeste'),
  (6, 6, 'GBA Norte'),
  (7, 6, 'GBA Norte Lejos')
on conflict (zona) do nothing;

create table if not exists public.entrega_barrio_zona (
  barrio_norm  text primary key,
  zona         smallint not null references public.entrega_zona_config(zona),
  origen       text not null default 'manual',
  actualizado_at timestamptz not null default now()
);

create or replace function public.entrega_norm_barrio(p text)
returns text language sql immutable as $$
  select regexp_replace(
           lower(translate(coalesce(p,''),
             'áéíóúÁÉÍÓÚñÑüÜ', 'aeiouaeiounnuu')),
           '[^a-z0-9]+', ' ', 'g')
$$;

insert into public.entrega_barrio_zona (barrio_norm, zona, origen)
select distinct on (public.entrega_norm_barrio(barrio))
       trim(public.entrega_norm_barrio(barrio)),
       substring(zona from 'Zona (\d)')::smallint,
       'ppp_programacion'
from public.ppp_programacion
where empresa = 'lk' and zona ~ '^Zona \d' and coalesce(barrio,'') <> ''
order by public.entrega_norm_barrio(barrio), fecha_entrega desc
on conflict (barrio_norm) do nothing;

create or replace function public.entrega_fecha_base()
returns date language sql stable as $$
  select coalesce(
    (select max(left(fecha_entrega,10)::date)
       from public.ppp_programacion
      where empresa = 'lk'
        and zona ~ '^Zona \d'
        and left(fecha_entrega,10) ~ '^\d{4}-\d{2}-\d{2}$'
        and left(fecha_entrega,10)::date
              between current_date and current_date + 15),
    current_date);
$$;

create or replace function public.entrega_sumar_habiles(p_desde date, p_n int)
returns date language plpgsql immutable as $$
declare d date := p_desde; k int := 0;
begin
  while k < p_n loop
    d := d + 1;
    if extract(isodow from d) < 6 then k := k + 1; end if;
  end loop;
  while extract(isodow from d) >= 6 loop d := d + 1; end loop;
  return d;
end $$;

create or replace function public.get_fecha_estimada_entrega(
  p_customer_id uuid, p_slot smallint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_barrio text; v_zona smallint; v_dias smallint; v_base date; v_fecha date;
begin
  select a.zona_expreso into v_barrio
    from customer_delivery_addresses a
   where a.customer_id = p_customer_id and a.slot = p_slot;

  if v_barrio is null or lower(trim(v_barrio)) = 'retira' then
    return jsonb_build_object('fecha', null, 'motivo', 'retira_o_sin_direccion');
  end if;

  select m.zona into v_zona from entrega_barrio_zona m
   where m.barrio_norm = trim(entrega_norm_barrio(v_barrio));
  if v_zona is null then
    return jsonb_build_object('fecha', null, 'motivo', 'barrio_sin_zona',
                              'barrio', v_barrio);
  end if;

  select c.dias_habiles into v_dias from entrega_zona_config c where c.zona = v_zona;
  v_base  := entrega_fecha_base();
  v_fecha := entrega_sumar_habiles(v_base, v_dias);

  return jsonb_build_object('fecha', v_fecha, 'zona', v_zona,
                            'base', v_base, 'dias_habiles', v_dias);
end $$;

revoke execute on function public.get_fecha_estimada_entrega(uuid, smallint) from public, anon;
grant  execute on function public.get_fecha_estimada_entrega(uuid, smallint) to authenticated;
