-- SR20 calculator: accounts + token system.
-- Run once in the Supabase SQL editor on a fresh project. Mostly idempotent.
-- All writes go through the security-definer functions below; clients get no direct write access.

-- ---------------------------------------------------------------- tables

create table if not exists public.profiles (
  id         uuid primary key references auth.users on delete cascade,
  email      text not null,
  name       text,
  role       text not null default 'user' check (role in ('user','admin')),
  tokens     int  not null default 0 check (tokens >= 0),
  disabled   boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.calculations (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references public.profiles on delete cascade,
  created_at  timestamptz not null default now(),
  flight_date date,
  dep_time    text,
  route       text,
  reg         text,
  inputs      jsonb not null,
  input_hash  text not null,
  unique (user_id, input_hash)
);
create index if not exists calculations_user_created_idx on public.calculations (user_id, created_at desc);
create index if not exists calculations_created_idx      on public.calculations (created_at desc);

create table if not exists public.token_ledger (
  id             bigint generated always as identity primary key,
  user_id        uuid not null references public.profiles on delete cascade,
  delta          int  not null,
  reason         text not null check (reason in ('grant','calc','adjust')),
  calculation_id bigint references public.calculations on delete set null,
  admin_id       uuid references public.profiles,
  note           text,
  created_at     timestamptz not null default now()
);
create index if not exists token_ledger_user_created_idx on public.token_ledger (user_id, created_at desc);

-- ---------------------------------------------------------------- helpers

-- True if the caller has a non-disabled admin profile.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin' and not disabled
  );
$$;

-- New auth user -> profile row (tokens start at 0).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, name)
  values (new.id, new.email, new.raw_user_meta_data->>'name')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------- calculate

-- Freeze a snapshot of the inputs and charge 1 token. Identical inputs (per user) are free.
create or replace function public.calculate(
  p_inputs jsonb, p_flight_date date, p_dep_time text, p_route text, p_reg text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_hash   text;
  v_prof   public.profiles%rowtype;
  v_calc   public.calculations%rowtype;
  v_new_id bigint;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  if p_inputs is null or length(p_inputs::text) > 200000 then
    raise exception 'inputs_too_large';
  end if;

  v_hash := md5(p_inputs::text);   -- jsonb text form is canonical (sorted keys, normalized spacing)

  -- Lock the profile first: serializes concurrent calls from the same user.
  select * into v_prof from public.profiles where id = v_uid for update;
  if not found then
    raise exception 'no_profile';
  end if;

  -- Already calculated? Return it without charging (even if disabled / out of tokens).
  select * into v_calc from public.calculations where user_id = v_uid and input_hash = v_hash;
  if found then
    return jsonb_build_object('id', v_calc.id, 'created_at', v_calc.created_at,
                              'balance', v_prof.tokens, 'charged', false);
  end if;

  if v_prof.disabled then
    raise exception 'account_disabled';
  end if;
  if v_prof.tokens < 1 then
    raise exception 'no_tokens';
  end if;

  insert into public.calculations (user_id, flight_date, dep_time, route, reg, inputs, input_hash)
  values (v_uid, p_flight_date, p_dep_time, p_route, p_reg, p_inputs, v_hash)
  on conflict (user_id, input_hash) do nothing
  returning id into v_new_id;

  select * into v_calc from public.calculations where user_id = v_uid and input_hash = v_hash;

  if v_new_id is null then
    -- Lost a race: someone else inserted it; do not charge twice.
    return jsonb_build_object('id', v_calc.id, 'created_at', v_calc.created_at,
                              'balance', v_prof.tokens, 'charged', false);
  end if;

  update public.profiles set tokens = tokens - 1 where id = v_uid
  returning tokens into v_prof.tokens;

  insert into public.token_ledger (user_id, delta, reason, calculation_id)
  values (v_uid, -1, 'calc', v_calc.id);

  return jsonb_build_object('id', v_calc.id, 'created_at', v_calc.created_at,
                            'balance', v_prof.tokens, 'charged', true);
end;
$$;

-- ---------------------------------------------------------------- admin functions

-- Grant (positive) or remove (negative) tokens; returns the new balance.
create or replace function public.admin_adjust_tokens(p_user uuid, p_delta int, p_note text)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cur int;
  v_new int;
begin
  if not public.is_admin() then
    raise exception 'forbidden';
  end if;

  select tokens into v_cur from public.profiles where id = p_user for update;
  if not found then
    raise exception 'no_profile';
  end if;

  if v_cur + p_delta < 0 then
    raise exception 'insufficient_tokens';
  end if;

  update public.profiles set tokens = tokens + p_delta where id = p_user
  returning tokens into v_new;

  insert into public.token_ledger (user_id, delta, reason, admin_id, note)
  values (p_user, p_delta, case when p_delta > 0 then 'grant' else 'adjust' end, auth.uid(), p_note);

  return v_new;
end;
$$;

-- Disable/enable a user or change role. NULL argument = leave unchanged.
create or replace function public.admin_set_user(p_user uuid, p_disabled boolean, p_role text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'forbidden';
  end if;
  if p_role is not null and p_role not in ('user','admin') then
    raise exception 'invalid_role';
  end if;
  if p_user = auth.uid() and (p_disabled is true or (p_role is not null and p_role <> 'admin')) then
    raise exception 'cannot_modify_self';
  end if;

  update public.profiles
     set disabled = coalesce(p_disabled, disabled),
         role     = coalesce(p_role, role)
   where id = p_user;
  if not found then
    raise exception 'no_profile';
  end if;
end;
$$;

-- Per-user usage overview. period = [p_from, p_to); week/month = last 7/30 days.
create or replace function public.admin_usage(p_from timestamptz, p_to timestamptz)
returns table (
  user_id uuid, email text, name text, role text, disabled boolean, tokens int,
  calcs_period int, calcs_week int, calcs_month int, calcs_total int,
  granted_total int, last_calc timestamptz, created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'forbidden';
  end if;

  return query
  select p.id, p.email, p.name, p.role, p.disabled, p.tokens,
         (count(c.id) filter (where c.created_at >= p_from and c.created_at < p_to))::int,
         (count(c.id) filter (where c.created_at >= now() - interval '7 days'))::int,
         (count(c.id) filter (where c.created_at >= now() - interval '30 days'))::int,
         (count(c.id))::int,
         coalesce((select sum(l.delta) from public.token_ledger l
                   where l.user_id = p.id and l.reason = 'grant'), 0)::int,
         max(c.created_at),
         p.created_at
  from public.profiles p
  left join public.calculations c on c.user_id = p.id
  group by p.id
  order by max(c.created_at) desc nulls last;
end;
$$;

-- ---------------------------------------------------------------- RLS

alter table public.profiles     enable row level security;
alter table public.calculations enable row level security;
alter table public.token_ledger enable row level security;

drop policy if exists profiles_select     on public.profiles;
drop policy if exists calculations_select on public.calculations;
drop policy if exists ledger_select       on public.token_ledger;

create policy profiles_select     on public.profiles     for select to authenticated
  using (id = auth.uid() or public.is_admin());
create policy calculations_select on public.calculations for select to authenticated
  using (user_id = auth.uid() or public.is_admin());
create policy ledger_select       on public.token_ledger for select to authenticated
  using (user_id = auth.uid() or public.is_admin());
-- No insert/update/delete policies: all writes go through the functions above.

-- ---------------------------------------------------------------- privileges

revoke all on public.profiles, public.calculations, public.token_ledger from anon;
revoke insert, update, delete, truncate on public.profiles, public.calculations, public.token_ledger from authenticated;
grant select on public.profiles, public.calculations, public.token_ledger to authenticated;

revoke execute on function public.calculate(jsonb, date, text, text, text) from public, anon;
revoke execute on function public.admin_adjust_tokens(uuid, int, text)     from public, anon;
revoke execute on function public.admin_set_user(uuid, boolean, text)      from public, anon;
revoke execute on function public.admin_usage(timestamptz, timestamptz)    from public, anon;
revoke execute on function public.is_admin()                               from public, anon;
revoke execute on function public.handle_new_user()                        from public, anon, authenticated;

grant execute on function public.calculate(jsonb, date, text, text, text) to authenticated;
grant execute on function public.admin_adjust_tokens(uuid, int, text)     to authenticated;
grant execute on function public.admin_set_user(uuid, boolean, text)      to authenticated;
grant execute on function public.admin_usage(timestamptz, timestamptz)    to authenticated;
grant execute on function public.is_admin()                               to authenticated;

-- ---------------------------------------------------------------- after setup (run manually)
-- Make yourself admin (after inviting yourself and accepting the invite):
--   update public.profiles set role = 'admin' where email = 'you@example.com';
--
-- Optional manual test (SQL editor runs as postgres; simulate a user):
--   -- begin;
--   -- select set_config('request.jwt.claim.sub', '<user uuid>', true);
--   -- select set_config('request.jwt.claims', '{"sub":"<user uuid>"}', true);
--   -- set local role authenticated;
--   -- (give the user 1 token first, as admin or via: update profiles set tokens = 1 where id = '<user uuid>';)
--   -- select calculate('{"a":1}', null, null, null, null);  -- charged: true, balance 0
--   -- select calculate('{"a":1}', null, null, null, null);  -- charged: false (same inputs, no charge)
--   -- select calculate('{"a":2}', null, null, null, null);  -- error: no_tokens (0 tokens left)
--   -- (grant 1 more token, then {"a":2} succeeds with charged: true)
--   -- rollback;

-- ================================================================ OFP (VFR navigation log builder)
-- Additive and idempotent: safe to re-run on a database that already has the schema above.
-- ofps          one row per flight plan; the inputs jsonb is the editable draft + result.
-- waypoints     owner null = global (ATO points placed by admins), owner = user id = personal points.
-- finalize_ofp  creates or updates an OFP; charges 3 tokens (constant below) once per flight
--               (same id owned by the caller + same flight_date + dep + dest => free update).

create table if not exists public.ofps (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references public.profiles on delete cascade,
  flight_date date not null,
  dep         text not null,
  dest        text not null,
  route       text,
  reg         text,
  inputs      jsonb not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists ofps_user_created_idx on public.ofps (user_id, created_at desc);

-- Ledger: link to the OFP and allow the 'ofp' reason (the old check may be auto-named: look it up).
alter table public.token_ledger add column if not exists ofp_id bigint references public.ofps on delete set null;

do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.token_ledger'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%reason%'
  loop
    execute format('alter table public.token_ledger drop constraint %I', c.conname);
  end loop;
  alter table public.token_ledger
    add constraint token_ledger_reason_check check (reason in ('grant','calc','adjust','ofp'));
end;
$$;

create table if not exists public.waypoints (
  id         bigint generated always as identity primary key,
  owner      uuid references public.profiles on delete cascade,   -- null = global (ATO)
  name       text not null check (length(name) between 1 and 40),
  ident      text check (ident is null or length(ident) <= 6),
  lat        double precision not null check (lat between -90 and 90),
  lon        double precision not null check (lon between -180 and 180),
  notes      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists waypoints_owner_idx on public.waypoints (owner);
-- One global point per name (case-insensitive), so an ATO point cannot be placed twice.
create unique index if not exists waypoints_global_name_uidx on public.waypoints (lower(name)) where owner is null;

-- ---------------------------------------------------------------- finalize_ofp

-- Save an OFP. Returns {id, created_at, balance, charged}.
create or replace function public.finalize_ofp(
  p_id bigint, p_inputs jsonb, p_flight_date date, p_dep text, p_dest text, p_route text, p_reg text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  c_price  constant int := 3;          -- tokens per flight (server constant)
  v_uid    uuid := auth.uid();
  v_prof   public.profiles%rowtype;
  v_ofp    public.ofps%rowtype;
  v_dep    text := upper(btrim(coalesce(p_dep, '')));
  v_dest   text := upper(btrim(coalesce(p_dest, '')));
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  if p_inputs is null or length(p_inputs::text) > 200000 then
    raise exception 'inputs_too_large';
  end if;
  if p_flight_date is null or v_dep = '' or v_dest = '' then
    raise exception 'invalid_flight';
  end if;

  -- Lock the profile first: serializes concurrent calls from the same user.
  select * into v_prof from public.profiles where id = v_uid for update;
  if not found then
    raise exception 'no_profile';
  end if;

  -- Same flight already finalized by this user: update for free (even if disabled / out of tokens).
  if p_id is not null then
    select * into v_ofp from public.ofps
     where id = p_id and user_id = v_uid
       and flight_date = p_flight_date and dep = v_dep and dest = v_dest
     for update;
    if found then
      update public.ofps
         set inputs = p_inputs, route = p_route, reg = p_reg, updated_at = now()
       where id = v_ofp.id
      returning * into v_ofp;
      return jsonb_build_object('id', v_ofp.id, 'created_at', v_ofp.created_at,
                                'balance', v_prof.tokens, 'charged', false);
    end if;
  end if;

  -- New flight (no id, someone else's id, or date/dep/dest changed): charge.
  if v_prof.disabled then
    raise exception 'account_disabled';
  end if;
  if v_prof.tokens < c_price then
    raise exception 'no_tokens';
  end if;

  insert into public.ofps (user_id, flight_date, dep, dest, route, reg, inputs)
  values (v_uid, p_flight_date, v_dep, v_dest, p_route, p_reg, p_inputs)
  returning * into v_ofp;

  update public.profiles set tokens = tokens - c_price where id = v_uid
  returning tokens into v_prof.tokens;

  insert into public.token_ledger (user_id, delta, reason, ofp_id)
  values (v_uid, -c_price, 'ofp', v_ofp.id);

  return jsonb_build_object('id', v_ofp.id, 'created_at', v_ofp.created_at,
                            'balance', v_prof.tokens, 'charged', true);
end;
$$;

-- ---------------------------------------------------------------- personal waypoints

-- Create (p_id null) or update (own point only) a personal waypoint; returns its id.
create or replace function public.upsert_waypoint(
  p_id bigint, p_name text, p_ident text, p_lat double precision, p_lon double precision, p_notes text
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_prof  public.profiles%rowtype;
  v_name  text := btrim(coalesce(p_name, ''));
  v_ident text := nullif(upper(btrim(coalesce(p_ident, ''))), '');
  v_id    bigint;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  if length(v_name) not between 1 and 40 or (v_ident is not null and length(v_ident) > 6)
     or length(coalesce(p_notes, '')) > 500 then
    raise exception 'invalid_waypoint';
  end if;
  if p_lat is null or p_lon is null or p_lat not between -90 and 90 or p_lon not between -180 and 180 then
    raise exception 'invalid_waypoint';
  end if;

  select * into v_prof from public.profiles where id = v_uid for update;   -- also serializes the count check
  if not found then
    raise exception 'no_profile';
  end if;
  if v_prof.disabled then
    raise exception 'account_disabled';
  end if;

  if p_id is null then
    if (select count(*) from public.waypoints where owner = v_uid) >= 500 then
      raise exception 'too_many_waypoints';
    end if;
    insert into public.waypoints (owner, name, ident, lat, lon, notes)
    values (v_uid, v_name, v_ident, p_lat, p_lon, nullif(p_notes, ''))
    returning id into v_id;
  else
    update public.waypoints
       set name = v_name, ident = v_ident, lat = p_lat, lon = p_lon,
           notes = nullif(p_notes, ''), updated_at = now()
     where id = p_id and owner = v_uid
    returning id into v_id;
    if v_id is null then
      raise exception 'not_found';
    end if;
  end if;
  return v_id;
end;
$$;

-- Delete one of the caller's own waypoints.
create or replace function public.delete_waypoint(p_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  delete from public.waypoints where id = p_id and owner = v_uid;
  if not found then
    raise exception 'not_found';
  end if;
end;
$$;

-- ---------------------------------------------------------------- admin: global (ATO) waypoints

-- Place or move a global waypoint (owner null). With p_id null and an existing global point of the
-- same name, that point is updated instead of creating a duplicate.
create or replace function public.admin_upsert_waypoint(
  p_id bigint, p_name text, p_ident text, p_lat double precision, p_lon double precision, p_notes text
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name  text := btrim(coalesce(p_name, ''));
  v_ident text := nullif(upper(btrim(coalesce(p_ident, ''))), '');
  v_id    bigint := p_id;
begin
  if not public.is_admin() then
    raise exception 'forbidden';
  end if;
  if length(v_name) not between 1 and 40 or (v_ident is not null and length(v_ident) > 6)
     or length(coalesce(p_notes, '')) > 500 then
    raise exception 'invalid_waypoint';
  end if;
  if p_lat is null or p_lon is null or p_lat not between -90 and 90 or p_lon not between -180 and 180 then
    raise exception 'invalid_waypoint';
  end if;

  if v_id is null then
    select id into v_id from public.waypoints where owner is null and lower(name) = lower(v_name);
  end if;

  if v_id is null then
    insert into public.waypoints (owner, name, ident, lat, lon, notes)
    values (null, v_name, v_ident, p_lat, p_lon, nullif(p_notes, ''))
    returning id into v_id;
  else
    update public.waypoints
       set name = v_name, ident = v_ident, lat = p_lat, lon = p_lon,
           notes = nullif(p_notes, ''), updated_at = now()
     where id = v_id and owner is null
    returning id into v_id;
    if v_id is null then
      raise exception 'not_found';
    end if;
  end if;
  return v_id;
end;
$$;

create or replace function public.admin_delete_waypoint(p_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'forbidden';
  end if;
  delete from public.waypoints where id = p_id and owner is null;
  if not found then
    raise exception 'not_found';
  end if;
end;
$$;

-- ---------------------------------------------------------------- admin: ATO procedures (overrides of the defaults in ato.js)

create table if not exists public.ato_procedures (
  id         text primary key check (char_length(id) between 1 and 60),
  data       jsonb not null check (pg_column_size(data) <= 20000),
  hidden     boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);
alter table public.ato_procedures enable row level security;
drop policy if exists ato_procedures_select on public.ato_procedures;
create policy ato_procedures_select on public.ato_procedures for select to authenticated using (true);
revoke all on public.ato_procedures from anon;
revoke insert, update, delete, truncate on public.ato_procedures from authenticated;
grant select on public.ato_procedures to authenticated;

create or replace function public.admin_upsert_procedure(p_id text, p_data jsonb, p_hidden boolean default false)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'forbidden';
  end if;
  if p_id is null or p_id !~ '^[A-Za-z0-9._-]{1,60}$'
     or p_data is null or jsonb_typeof(p_data) <> 'object' or pg_column_size(p_data) > 20000 then
    raise exception 'invalid_procedure';
  end if;
  if not coalesce(p_hidden, false) then
    if char_length(coalesce(p_data->>'airport', '')) not between 3 and 4
       or coalesce(p_data->>'kind', '') not in ('dep', 'arr')
       or char_length(coalesce(p_data->>'name', '')) not between 1 and 60
       or char_length(coalesce(p_data->>'gate', '')) not between 1 and 40 then
      raise exception 'invalid_procedure';
    end if;
  end if;
  insert into public.ato_procedures (id, data, hidden, updated_at, updated_by)
  values (p_id, p_data, coalesce(p_hidden, false), now(), auth.uid())
  on conflict (id) do update
    set data = excluded.data, hidden = excluded.hidden, updated_at = now(), updated_by = auth.uid();
end;
$$;

create or replace function public.admin_delete_procedure(p_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'forbidden';
  end if;
  delete from public.ato_procedures where id = p_id;
end;
$$;

revoke execute on function public.admin_upsert_procedure(text, jsonb, boolean) from public, anon;
revoke execute on function public.admin_delete_procedure(text)                 from public, anon;
grant execute on function public.admin_upsert_procedure(text, jsonb, boolean) to authenticated;
grant execute on function public.admin_delete_procedure(text)                 to authenticated;

-- ---------------------------------------------------------------- OFP RLS and privileges

alter table public.ofps      enable row level security;
alter table public.waypoints enable row level security;

drop policy if exists ofps_select      on public.ofps;
drop policy if exists waypoints_select on public.waypoints;

create policy ofps_select      on public.ofps      for select to authenticated
  using (user_id = auth.uid() or public.is_admin());
create policy waypoints_select on public.waypoints for select to authenticated
  using (owner is null or owner = auth.uid());
-- No insert/update/delete policies: all writes go through the functions above.

revoke all on public.ofps, public.waypoints from anon;
revoke insert, update, delete, truncate on public.ofps, public.waypoints from authenticated;
grant select on public.ofps, public.waypoints to authenticated;

revoke execute on function public.finalize_ofp(bigint, jsonb, date, text, text, text, text)                      from public, anon;
revoke execute on function public.upsert_waypoint(bigint, text, text, double precision, double precision, text)  from public, anon;
revoke execute on function public.delete_waypoint(bigint)                                                        from public, anon;
revoke execute on function public.admin_upsert_waypoint(bigint, text, text, double precision, double precision, text) from public, anon;
revoke execute on function public.admin_delete_waypoint(bigint)                                                  from public, anon;

grant execute on function public.finalize_ofp(bigint, jsonb, date, text, text, text, text)                      to authenticated;
grant execute on function public.upsert_waypoint(bigint, text, text, double precision, double precision, text)  to authenticated;
grant execute on function public.delete_waypoint(bigint)                                                        to authenticated;
grant execute on function public.admin_upsert_waypoint(bigint, text, text, double precision, double precision, text) to authenticated;
grant execute on function public.admin_delete_waypoint(bigint)                                                  to authenticated;

-- ---------------------------------------------------------------- OFP rollback (run manually, destroys OFP data)
--   drop function if exists public.admin_delete_procedure(text);
--   drop function if exists public.admin_upsert_procedure(text, jsonb, boolean);
--   drop table if exists public.ato_procedures;
--   drop function if exists public.admin_delete_waypoint(bigint);
--   drop function if exists public.admin_upsert_waypoint(bigint, text, text, double precision, double precision, text);
--   drop function if exists public.delete_waypoint(bigint);
--   drop function if exists public.upsert_waypoint(bigint, text, text, double precision, double precision, text);
--   drop function if exists public.finalize_ofp(bigint, jsonb, date, text, text, text, text);
--   -- ledger rows with reason 'ofp' must go (or be re-labelled) before the old check can come back:
--   delete from public.token_ledger where reason = 'ofp';   -- refund first if needed: update profiles set tokens = tokens + 3 where ...
--   alter table public.token_ledger drop column if exists ofp_id;
--   alter table public.token_ledger drop constraint if exists token_ledger_reason_check;
--   alter table public.token_ledger add constraint token_ledger_reason_check check (reason in ('grant','calc','adjust'));
--   drop table if exists public.waypoints;
--   drop table if exists public.ofps;
