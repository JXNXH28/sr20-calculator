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
