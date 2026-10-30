-- Apply in Supabase SQL Editor as the project owner, for a new or existing database.
-- Safe to reapply: existing accounts, roles, identity links and inactive status are preserved.
begin;
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

create table if not exists public.accounts (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique references auth.users(id) on delete restrict,
  email text not null unique check (email = lower(btrim(email)) and length(email) between 3 and 320),
  display_name text not null check (length(btrim(display_name)) between 1 and 100),
  role text not null check (role in ('coordinator', 'driver', 'patient', 'caregiver')),
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now()
);
-- Account status has its own concurrency version, independent of personal/vehicle details.
alter table public.accounts add column if not exists status_version integer not null default 1 check (status_version > 0);
-- Project-owner-managed capability and fixture ownership; never writable by app users.
alter table public.accounts add column if not exists demo_admin boolean not null default false;
alter table public.accounts add column if not exists demo_owner_id uuid references public.accounts(id) on delete restrict;
alter table public.accounts add column if not exists demo_key text;
alter table public.accounts drop constraint if exists accounts_demo_scope;
alter table public.accounts add constraint accounts_demo_scope check (
  (not demo_admin or (role='coordinator' and demo_owner_id is null))
  and (demo_owner_id is null or (demo_owner_id<>id and role<>'coordinator')));
create unique index if not exists accounts_demo_identity on public.accounts(demo_owner_id,email) where demo_owner_id is not null;
create unique index if not exists accounts_demo_key on public.accounts(demo_owner_id,demo_key) where demo_owner_id is not null;
-- The optional seed enrolls existing fictional accounts without changing their
-- operational ownership, Auth link, vehicle or booking history.
create table if not exists private.seeded_accounts (
  account_id uuid primary key references public.accounts(id) on delete restrict,
  owner_id uuid not null references public.accounts(id) on delete restrict,
  seed_key text not null check(seed_key in ('patient1','patient2','patient3','caregiver1','caregiver2','caregiver3','driver1','driver2','driver3','coordinator')),
  unique(owner_id,seed_key),check(account_id<>owner_id)
);
alter table private.seeded_accounts enable row level security;
revoke all on private.seeded_accounts from public,anon,authenticated;
-- Capability grants shared demo access; registry ownership only identifies fixtures.
create or replace function private.demo_administrator(target uuid default null) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.accounts a join auth.users u on u.id=a.auth_user_id
    where (target is null or a.id=target) and a.role='coordinator' and a.status='active' and a.demo_admin
      and a.demo_owner_id is null and not exists(select 1 from private.seeded_accounts s where s.account_id=a.id)
      and u.email_confirmed_at is not null
      and exists(select 1 from auth.identities i where i.user_id=u.id and i.provider='google'));
$$;
revoke all on function private.demo_administrator(uuid) from public,anon,authenticated;
create or replace function private.demo_identity_allowed() returns boolean
language sql stable security definer set search_path='' as $$
  select not exists(select 1 from public.accounts a left join private.seeded_accounts s on s.account_id=a.id
    where a.auth_user_id=(select auth.uid()) and coalesce(a.demo_owner_id,s.owner_id) is not null
    and not private.demo_administrator());
$$;
revoke all on function private.demo_identity_allowed() from public,anon;
grant execute on function private.demo_identity_allowed() to authenticated;
create or replace function private.increment_account_status_version() returns trigger
language plpgsql set search_path = '' as $$
begin new.status_version := old.status_version + 1; return new; end;
$$;
drop trigger if exists account_status_version on public.accounts;
create trigger account_status_version before update of status on public.accounts
  for each row execute function private.increment_account_status_version();
-- Upgrade earlier account statuses without recreating the table or deleting data.
alter table public.accounts drop constraint if exists accounts_status_check;
alter table public.accounts alter column status set default 'active';
update public.accounts set status = case
  when status in ('pending', 'approved') then 'active'
  when status = 'rejected' then 'inactive'
  else status end
where status in ('pending', 'approved', 'rejected');
alter table public.accounts add constraint accounts_status_check check (status in ('active', 'inactive'));
-- Remove obsolete approval APIs; leave any stored review metadata untouched.
drop function if exists public.review_account(uuid, text);
drop function if exists private.review_account(uuid, text);
drop index if exists public.accounts_pending_created;

alter table public.accounts enable row level security;
-- Direct writes are reserved for the project owner. Narrow functions below enforce transitions.
revoke all on public.accounts from public, anon, authenticated;
grant select on public.accounts to authenticated;

create or replace function private.is_coordinator() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.accounts
    where auth_user_id = (select auth.uid()) and role = 'coordinator' and status = 'active' and private.demo_identity_allowed());
$$;
drop policy if exists accounts_read on public.accounts;
create policy accounts_read on public.accounts for select to authenticated
  using (auth_user_id = (select auth.uid()) or (select private.is_coordinator()));

-- Read the trusted Auth record, never user_metadata or email supplied by the browser.
create or replace function private.verified_email() returns text
language plpgsql stable security definer set search_path = '' as $$
declare verified text;
begin
  select lower(btrim(u.email)) into verified from auth.users u
  where u.id = (select auth.uid()) and u.email_confirmed_at is not null
    and (exists(select 1 from auth.identities i where i.user_id = u.id and i.provider = 'google')
      or exists(select 1 from public.accounts a join public.accounts owner on owner.id=a.demo_owner_id
        where a.auth_user_id=u.id and a.status='active' and owner.role='coordinator' and private.demo_administrator())
      or exists(select 1 from public.accounts a join private.seeded_accounts s on s.account_id=a.id join public.accounts owner on owner.id=s.owner_id
        where a.auth_user_id=u.id and a.status='active' and owner.role='coordinator' and private.demo_administrator()));
  if verified is null then
    raise exception 'A verified Google account is required.' using errcode = '42501';
  end if;
  return verified;
end;
$$;

create or replace function private.current_account() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare account public.accounts; verified text;
begin
  verified := private.verified_email();
  select * into account from public.accounts where auth_user_id = (select auth.uid());
  if found then return private.account_details(account); end if;
  -- An administrator can preconfigure coordinator emails before their first Google login.
  update public.accounts set auth_user_id = (select auth.uid())
    where email = verified and auth_user_id is null returning * into account;
  if found then return private.account_details(account); end if;
  -- Another first-login request may have linked the same user while UPDATE waited.
  select * into account from public.accounts where auth_user_id = (select auth.uid());
  if found then return private.account_details(account); end if;
  return null;
end;
$$;

create or replace function private.register_account(requested_role text, requested_name text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare account public.accounts; verified text;
begin
  if requested_role is null or requested_role not in ('patient', 'caregiver', 'driver')
    or requested_name is null or length(btrim(requested_name)) not between 1 and 100 then
    raise exception 'Invalid registration.' using errcode = '22023';
  end if;
  verified := private.verified_email();
  if private.current_account() is not null then
    raise exception 'Account already registered.' using errcode = '23505';
  end if;
  if requested_role in ('patient','driver','caregiver') then raise exception 'Personal details are required.' using errcode = '22023'; end if;
  insert into public.accounts(auth_user_id, email, display_name, role, status)
    values ((select auth.uid()), verified, btrim(requested_name), requested_role, 'active')
    returning * into account;
  return to_jsonb(account);
exception when unique_violation then
  raise exception 'Account already registered.' using errcode = '23505';
end;
$$;

-- Public API wrappers are security invoker; privileged implementations stay in private.
create or replace function public.current_account() returns jsonb
language sql security invoker set search_path = '' as $$ select private.current_account(); $$;
create or replace function public.register_account(requested_role text, requested_name text) returns jsonb
language sql security invoker set search_path = '' as $$ select private.register_account(requested_role, requested_name); $$;
revoke all on function private.is_coordinator(), private.verified_email(), private.current_account(),
  private.register_account(text, text), public.current_account(), public.register_account(text, text)
  from public, anon;
grant execute on function private.is_coordinator(), private.verified_email(), private.current_account(),
  private.register_account(text, text), public.current_account(), public.register_account(text, text)
  to authenticated;
-- UC-02 operational records are separate from Google sign-in accounts.
create table if not exists public.patients (
  id uuid primary key default gen_random_uuid(),
  full_name text not null check (length(btrim(full_name)) between 1 and 100),
  phone text not null check (phone ~ '^\+?[0-9][0-9 ()-]{5,24}$'),
  pickup_address text not null check (length(btrim(pickup_address)) between 1 and 300),
  mobility text not null check (mobility in ('ambulant', 'walking-aid', 'wheelchair')),
  assistance_required boolean not null default false,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now()
);
-- Nullable additions preserve legacy/mock records without inventing personal data.
alter table public.patients add column if not exists birth_date date check (birth_date between date '1900-01-01' and (now() at time zone 'Asia/Singapore')::date);
alter table public.patients add column if not exists gender text check (gender in ('female','male','other','prefer-not-to-say'));

-- Shared server-side validation also protects direct RPC calls.
create or replace function private.validate_personal_details(details jsonb) returns void
language plpgsql set search_path = '' as $$
declare born date;
begin
  if details is null or jsonb_typeof(details) <> 'object'
    or coalesce(jsonb_typeof(details->'full_name'),'') <> 'string' or length(btrim(details->>'full_name')) not between 1 and 100
    or coalesce(jsonb_typeof(details->'phone'),'') <> 'string' or details->>'phone' !~ '^(\+?[0-9][0-9 ()-]{5,24})$'
    or coalesce(jsonb_typeof(details->'birth_date'),'') <> 'string' or coalesce(details->>'birth_date','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    or coalesce(jsonb_typeof(details->'gender'),'') <> 'string' or details->>'gender' not in ('female','male','other','prefer-not-to-say') then
    raise exception 'Invalid personal details.' using errcode='22023';
  end if;
  begin born := (details->>'birth_date')::date;
  exception when datetime_field_overflow or invalid_datetime_format then
    raise exception 'Invalid birth date.' using errcode='22023'; end;
  if born < date '1900-01-01' or born > (now() at time zone 'Asia/Singapore')::date then
    raise exception 'Invalid birth date.' using errcode='22023';
  end if;
end;
$$;
revoke all on function private.validate_personal_details(jsonb) from public, anon, authenticated;
-- Structured address additions preserve the original address as the street field.
alter table public.patients add column if not exists unit_no text not null default '' check (length(unit_no) <= 20);
alter table public.patients add column if not exists postal_code text not null default '' check (postal_code = '' or postal_code ~ '^[0-9]{6}$');
alter table public.patients add column if not exists notes text not null default '' check (length(notes) <= 1000);
alter table public.patients add column if not exists version integer not null default 1 check (version > 0);
create or replace function private.increment_patient_version() returns trigger
language plpgsql set search_path = '' as $$
begin new.version := old.version + 1; return new; end;
$$;
drop trigger if exists patients_version on public.patients;
create trigger patients_version before update on public.patients for each row execute function private.increment_patient_version();
-- Nullable ownership preserves coordinator-created records without guessing identities.
alter table public.patients add column if not exists account_id uuid references public.accounts(id) on delete restrict;
create unique index if not exists patients_account on public.patients(account_id);
create or replace function private.patient_account_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select id from public.accounts where auth_user_id = (select auth.uid()) and role = 'patient' and status = 'active' and private.demo_identity_allowed();
$$;
revoke all on function private.patient_account_id() from public, anon;
grant execute on function private.patient_account_id() to authenticated;
alter table public.patients enable row level security;
revoke all on public.patients from public, anon, authenticated;
grant select on public.patients to authenticated;
revoke update (status, notes) on public.patients from authenticated;
drop policy if exists patients_read on public.patients;
create policy patients_read on public.patients for select to authenticated
  using ((select private.is_coordinator()) or account_id = (select private.patient_account_id()));
drop policy if exists patients_create on public.patients;
drop policy if exists patients_update on public.patients;
create policy patients_update on public.patients for update to authenticated
  using ((select private.is_coordinator())) with check ((select private.is_coordinator()));
create index if not exists patients_created on public.patients(created_at desc, id);

-- All authenticated coordinator writes compare the version while holding the row lock.
create or replace function private.save_patient(target uuid, details jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare saved public.patients;
begin
  if not private.is_coordinator() then raise exception 'Coordinator access required.' using errcode = '42501'; end if;
  if details is null or jsonb_typeof(details) <> 'object'
    or details - array['version','status','notes'] <> '{}'::jsonb
    or not (details ? 'status' or details ? 'notes')
    or (details ? 'status' and (jsonb_typeof(details->'status') <> 'string' or details->>'status' not in ('active','inactive')))
    or (details ? 'notes' and (jsonb_typeof(details->'notes') <> 'string' or length(details->>'notes') > 1000)) then
    raise exception 'Invalid patient details.' using errcode = '22023';
  end if;
  if coalesce(jsonb_typeof(details->'version'), '') <> 'number' or coalesce(details->>'version','') !~ '^[1-9][0-9]*$' then
    raise exception 'Patient version is required.' using errcode = '22023';
  end if;
  select * into saved from public.patients where id=target for update;
  if not found then raise exception 'Patient not found.' using errcode = 'P0002'; end if;
  if saved.version <> (details->>'version')::numeric then raise exception 'Patient has changed. Reload before saving.' using errcode = 'PT409'; end if;
  update public.patients set status=coalesce(details->>'status',status), notes=case when details ? 'notes' then btrim(details->>'notes') else notes end
    where id=target returning * into saved;
  return to_jsonb(saved);
end;
$$;
create or replace function public.save_patient(target uuid, details jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.save_patient(target,details); $$;
revoke all on function private.save_patient(uuid,jsonb), public.save_patient(uuid,jsonb) from public, anon;
grant execute on function private.save_patient(uuid,jsonb), public.save_patient(uuid,jsonb) to authenticated;

-- A narrow owner-save API prevents patients from assigning ownership or changing status.
create or replace function private.save_my_patient(details jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare owner_id uuid; candidate public.patients; saved public.patients;
begin
  owner_id := private.patient_account_id();
  if owner_id is null then raise exception 'Patient access required.' using errcode = '42501'; end if;
  perform private.verified_email();
  if details is null or jsonb_typeof(details) <> 'object' then
    raise exception 'Invalid patient details.' using errcode = '22023';
  end if;
  if details - array['birth_date','gender','full_name','phone','pickup_address','mobility','assistance_required','unit_no','postal_code','notes','version'] <> '{}'::jsonb
    or coalesce(jsonb_typeof(details->'full_name'), '') <> 'string'
    or coalesce(jsonb_typeof(details->'phone'), '') <> 'string'
    or coalesce(jsonb_typeof(details->'pickup_address'), '') <> 'string'
    or coalesce(jsonb_typeof(details->'mobility'), '') <> 'string'
    or coalesce(jsonb_typeof(details->'assistance_required'), '') <> 'boolean'
    or (details ? 'unit_no' and jsonb_typeof(details->'unit_no') <> 'string')
    or (details ? 'postal_code' and jsonb_typeof(details->'postal_code') <> 'string')
    or (details ? 'notes' and jsonb_typeof(details->'notes') <> 'string') then
    raise exception 'Invalid patient details.' using errcode = '22023';
  end if;
  perform private.validate_personal_details(details);
  candidate := jsonb_populate_record(null::public.patients, details);
  -- Lock the account as well, serializing simultaneous first profile creations.
  perform 1 from public.accounts where id=owner_id for update;
  select * into saved from public.patients where account_id=owner_id for update;
  if found then
    if saved.status <> 'active' then raise exception 'Patient profile is inactive.' using errcode = '42501'; end if;
    if coalesce(jsonb_typeof(details->'version'), '') <> 'number' or coalesce(details->>'version','') !~ '^[1-9][0-9]*$' then
      raise exception 'Patient version is required.' using errcode = '22023';
    end if;
    if saved.version <> (details->>'version')::numeric then raise exception 'Patient has changed. Reload before saving.' using errcode = 'PT409'; end if;
  elsif details ? 'version' then
    raise exception 'Patient profile has changed. Reload before saving.' using errcode = 'PT409';
  end if;
  insert into public.patients(account_id, birth_date, gender, full_name, phone, pickup_address, mobility, assistance_required, unit_no, postal_code, notes)
    values (owner_id, candidate.birth_date, candidate.gender, btrim(candidate.full_name), btrim(candidate.phone), btrim(candidate.pickup_address), candidate.mobility, candidate.assistance_required, coalesce(btrim(candidate.unit_no), ''), coalesce(btrim(candidate.postal_code), ''), coalesce(btrim(candidate.notes), ''))
    on conflict (account_id) do update set birth_date = excluded.birth_date, gender = excluded.gender, full_name = excluded.full_name, phone = excluded.phone,
      pickup_address = excluded.pickup_address, mobility = excluded.mobility, assistance_required = excluded.assistance_required,
      unit_no = case when details ? 'unit_no' then excluded.unit_no else public.patients.unit_no end,
      postal_code = case when details ? 'postal_code' then excluded.postal_code else public.patients.postal_code end,
      notes = case when details ? 'notes' then excluded.notes else public.patients.notes end
      where public.patients.status = 'active'
    returning * into saved;
  if not found then raise exception 'Patient profile is inactive.' using errcode = '42501'; end if;
  return to_jsonb(saved);
end;
$$;
create or replace function public.save_my_patient(details jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.save_my_patient(details); $$;
revoke all on function private.save_my_patient(jsonb), public.save_my_patient(jsonb) from public, anon;
grant execute on function private.save_my_patient(jsonb), public.save_my_patient(jsonb) to authenticated;

-- Final signup submission: both rows commit together or neither is created.
create or replace function private.register_patient_account(requested_name text, details jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare verified text;
begin
  verified := private.verified_email();
  if private.current_account() is not null then
    raise exception 'Account already registered.' using errcode = '23505';
  end if;
  if requested_name is null or length(btrim(requested_name)) not between 1 and 100
    or details is null or jsonb_typeof(details) <> 'object'
    or coalesce(details->>'postal_code', '') !~ '^[0-9]{6}$' then
    raise exception 'Invalid registration details.' using errcode = '22023';
  end if;
  insert into public.accounts(auth_user_id, email, display_name, role, status)
    values ((select auth.uid()), verified, btrim(requested_name), 'patient', 'active');
  perform private.save_my_patient(details);
  return private.current_account();
exception when unique_violation then
  raise exception 'Account already registered.' using errcode = '23505';
end;
$$;
create or replace function public.register_patient_account(requested_name text, details jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.register_patient_account(requested_name, details); $$;
revoke all on function private.register_patient_account(text,jsonb), public.register_patient_account(text,jsonb) from public, anon;
grant execute on function private.register_patient_account(text,jsonb), public.register_patient_account(text,jsonb) to authenticated;

-- Driver personal profiles are separate from vehicle registration approval.
create table if not exists public.drivers (
  account_id uuid primary key references public.accounts(id) on delete restrict,
  full_name text not null check (length(btrim(full_name)) between 1 and 100),
  phone text not null check (phone ~ '^\+?[0-9][0-9 ()-]{5,24}$'),
  birth_date date not null check (birth_date between date '1900-01-01' and (now() at time zone 'Asia/Singapore')::date),
  gender text not null check (gender in ('female','male','other','prefer-not-to-say')),
  created_at timestamptz not null default now()
);
alter table public.drivers enable row level security;
revoke all on public.drivers from public, anon, authenticated;
grant select on public.drivers to authenticated;
create or replace function private.driver_account_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select id from public.accounts where auth_user_id=(select auth.uid()) and role='driver' and status='active' and private.demo_identity_allowed();
$$;
revoke all on function private.driver_account_id() from public, anon;
grant execute on function private.driver_account_id() to authenticated;
drop policy if exists drivers_read on public.drivers;
create policy drivers_read on public.drivers for select to authenticated
  using (account_id=(select private.driver_account_id()));

alter table public.drivers add column if not exists version integer not null default 1 check (version>0);

-- Owner edits are separate from signup completion and cannot change vehicle approval.
create or replace function private.update_my_driver(details jsonb, expected_version integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare owner_id uuid; saved public.drivers;
begin
  owner_id:=private.driver_account_id();
  if owner_id is null then raise exception 'Driver access required.' using errcode='42501'; end if;
  perform private.verified_email();
  perform private.validate_personal_details(details);
  if details-array['full_name','phone','birth_date','gender']<>'{}'::jsonb
    or expected_version is null or expected_version<1 then raise exception 'Invalid driver details.' using errcode='22023'; end if;
  perform 1 from public.accounts where id=owner_id and status='active' and role='driver' for update;
  if not found then raise exception 'Driver access required.' using errcode='42501'; end if;
  select * into saved from public.drivers where account_id=owner_id for update;
  if not found then raise exception 'Driver profile not found.' using errcode='P0002'; end if;
  if saved.version<>expected_version then raise exception 'Driver profile changed. Reload before saving.' using errcode='PT409'; end if;
  update public.drivers set full_name=btrim(details->>'full_name'),phone=btrim(details->>'phone'),
    birth_date=(details->>'birth_date')::date,gender=details->>'gender',version=version+1
    where account_id=owner_id returning * into saved;
  return to_jsonb(saved);
end;
$$;
create or replace function public.update_my_driver(details jsonb, expected_version integer) returns jsonb
language sql security invoker set search_path='' as $$ select private.update_my_driver(details,expected_version); $$;
revoke all on function private.update_my_driver(jsonb,integer),public.update_my_driver(jsonb,integer) from public,anon;
grant execute on function private.update_my_driver(jsonb,integer),public.update_my_driver(jsonb,integer) to authenticated;

-- Used for signup and completion of legacy driver accounts; personal details are not approval.
create or replace function private.save_my_driver(details jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare owner_id uuid; saved public.drivers;
begin
  owner_id := private.driver_account_id();
  if owner_id is null then raise exception 'Driver access required.' using errcode='42501'; end if;
  perform private.verified_email();
  perform private.validate_personal_details(details);
  if details - array['full_name','phone','birth_date','gender'] <> '{}'::jsonb then
    raise exception 'Invalid driver details.' using errcode='22023'; end if;
  perform 1 from public.accounts where id=owner_id and status='active' and role='driver' for update;
  if not found then raise exception 'Driver access required.' using errcode='42501'; end if;
  insert into public.drivers(account_id,full_name,phone,birth_date,gender)
    values (owner_id,btrim(details->>'full_name'),btrim(details->>'phone'),(details->>'birth_date')::date,details->>'gender')
    on conflict (account_id) do nothing returning * into saved;
  if not found then raise exception 'Driver profile already exists. Reload before continuing.' using errcode='PT409'; end if;
  return to_jsonb(saved);
end;
$$;
create or replace function public.save_my_driver(details jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.save_my_driver(details); $$;

create or replace function private.register_driver_account(requested_name text, details jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare verified text;
begin
  verified := private.verified_email();
  if private.current_account() is not null then raise exception 'Account already registered.' using errcode='23505'; end if;
  if requested_name is null or length(btrim(requested_name)) not between 1 and 100 then
    raise exception 'Invalid registration details.' using errcode='22023'; end if;
  insert into public.accounts(auth_user_id,email,display_name,role,status)
    values ((select auth.uid()),verified,btrim(requested_name),'driver','active');
  perform private.save_my_driver(details);
  return private.current_account();
exception when unique_violation then raise exception 'Account already registered.' using errcode='23505';
end;
$$;
create or replace function public.register_driver_account(requested_name text, details jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.register_driver_account(requested_name,details); $$;

revoke all on function private.save_my_driver(jsonb),public.save_my_driver(jsonb),
  private.register_driver_account(text,jsonb),public.register_driver_account(text,jsonb) from public, anon;
grant execute on function private.save_my_driver(jsonb),public.save_my_driver(jsonb),
  private.register_driver_account(text,jsonb),public.register_driver_account(text,jsonb) to authenticated;

create table if not exists public.driver_vehicles (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null unique references public.drivers(account_id) on delete restrict,
  licence_number text not null check (length(btrim(licence_number)) between 1 and 50),
  plate_number text not null unique check (plate_number = upper(btrim(plate_number)) and length(plate_number) between 1 and 20),
  make text not null check (length(btrim(make)) between 1 and 60),
  model text not null check (length(btrim(model)) between 1 and 60),
  passenger_capacity integer not null check (passenger_capacity between 1 and 12),
  wheelchair_accessible boolean not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  version integer not null default 1 check (version > 0),
  submitted_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references public.accounts(id) on delete restrict,
  review_reason text not null default '' check (length(review_reason) <= 1000),
  check ((status='pending' and reviewed_at is null and reviewed_by is null and review_reason='')
    or (status in ('approved','rejected') and reviewed_at is not null and reviewed_by is not null)),
  check (status <> 'rejected' or length(btrim(review_reason)) > 0)
);
-- Internal audit: resubmission must not erase previous review decisions.
create table if not exists private.driver_registration_events (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references public.drivers(account_id),
  actor_id uuid not null references public.accounts(id),
  recorded_at timestamptz not null default now(),
  snapshot jsonb not null
);
-- Retain the latest approval through edits so returning drivers keep My Vehicle.
alter table public.driver_vehicles add column if not exists registered_at timestamptz;
update public.driver_vehicles v set registered_at=coalesce(
  case when v.status='approved' then v.reviewed_at end,
  (select max((e.snapshot->>'reviewed_at')::timestamptz) from private.driver_registration_events e
    where e.driver_id=v.driver_id and e.snapshot->>'status'='approved')
) where v.registered_at is null;
alter table private.driver_registration_events enable row level security;
revoke all on private.driver_registration_events from public, anon, authenticated;

alter table public.drivers enable row level security;
alter table public.driver_vehicles enable row level security;
revoke all on public.drivers, public.driver_vehicles from public, anon, authenticated;
grant select on public.drivers, public.driver_vehicles to authenticated;
drop policy if exists drivers_read on public.drivers;
create policy drivers_read on public.drivers for select to authenticated
  using ((select private.is_coordinator()) or account_id=(select private.driver_account_id()));
drop policy if exists driver_vehicles_read on public.driver_vehicles;
create policy driver_vehicles_read on public.driver_vehicles for select to authenticated
  using ((select private.is_coordinator()) or driver_id=(select private.driver_account_id()));

create or replace function private.submit_driver_vehicle(details jsonb, expected_version integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare owner_id uuid; saved public.driver_vehicles; candidate public.driver_vehicles;
begin
  owner_id := private.driver_account_id();
  if owner_id is null then raise exception 'Driver access required.' using errcode='42501'; end if;
  perform 1 from public.accounts where id=owner_id and status='active' and role='driver' for update;
  if not found then raise exception 'Driver access required.' using errcode='42501'; end if;
  if not exists(select 1 from public.drivers where account_id=owner_id) then
    raise exception 'Complete driver personal details first.' using errcode='22023'; end if;
  if details is null or jsonb_typeof(details)<>'object'
    or details - array['licence_number','plate_number','make','model','passenger_capacity','wheelchair_accessible'] <> '{}'::jsonb
    or coalesce(jsonb_typeof(details->'licence_number'),'')<>'string'
    or coalesce(jsonb_typeof(details->'plate_number'),'')<>'string'
    or coalesce(jsonb_typeof(details->'make'),'')<>'string'
    or coalesce(jsonb_typeof(details->'model'),'')<>'string'
    or coalesce(jsonb_typeof(details->'passenger_capacity'),'')<>'number'
    or coalesce(details->>'passenger_capacity','') !~ '^([1-9]|1[0-2])$'
    or coalesce(jsonb_typeof(details->'wheelchair_accessible'),'')<>'boolean' then
    raise exception 'Invalid vehicle details.' using errcode='22023'; end if;
  candidate := jsonb_populate_record(null::public.driver_vehicles,details);
  select * into saved from public.driver_vehicles where driver_id=owner_id for update;
  if found then
    if expected_version is null or expected_version<>saved.version then
      raise exception 'Registration changed. Reload before saving.' using errcode='PT409'; end if;
  elsif expected_version is not null then raise exception 'Registration changed. Reload before saving.' using errcode='PT409'; end if;
  insert into public.driver_vehicles(driver_id,licence_number,plate_number,make,model,passenger_capacity,wheelchair_accessible)
    values (owner_id,btrim(candidate.licence_number),upper(btrim(candidate.plate_number)),btrim(candidate.make),btrim(candidate.model),candidate.passenger_capacity,candidate.wheelchair_accessible)
    on conflict (driver_id) do update set licence_number=excluded.licence_number,plate_number=excluded.plate_number,
      make=excluded.make,model=excluded.model,passenger_capacity=excluded.passenger_capacity,wheelchair_accessible=excluded.wheelchair_accessible,
      status='pending',version=public.driver_vehicles.version+1,submitted_at=now(),reviewed_at=null,reviewed_by=null,review_reason=''
    returning * into saved;
  insert into private.driver_registration_events(driver_id,actor_id,snapshot) values(owner_id,owner_id,to_jsonb(saved));
  return to_jsonb(saved);
end;
$$;
create or replace function public.submit_driver_vehicle(details jsonb, expected_version integer) returns jsonb
language sql security invoker set search_path = '' as $$ select private.submit_driver_vehicle(details,expected_version); $$;

create or replace function private.review_driver_vehicle(target uuid, expected_version integer, decision text, reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare saved public.driver_vehicles; actor uuid;
begin
  if not private.is_coordinator() then raise exception 'Coordinator access required.' using errcode='42501'; end if;
  if decision is null or decision not in ('approved','rejected') or reason is null or length(reason)>1000
    or (decision='rejected' and length(btrim(reason))=0) then
    raise exception 'A valid decision and rejection reason are required.' using errcode='22023'; end if;
  -- Same lock order as submission: account, then vehicle.
  perform 1 from public.accounts where id=target and role='driver' and status='active' for update;
  if not found then raise exception 'Active driver not found.' using errcode='P0002'; end if;
  select * into saved from public.driver_vehicles where driver_id=target for update;
  if not found then raise exception 'Vehicle registration not found.' using errcode='P0002'; end if;
  if expected_version is null or saved.version<>expected_version then raise exception 'Registration changed. Reload before reviewing.' using errcode='PT409'; end if;
  if saved.status<>'pending' then raise exception 'Only pending registrations can be reviewed.' using errcode='22023'; end if;
  select id into actor from public.accounts where auth_user_id=(select auth.uid()) and role='coordinator' and status='active' for share;
  if actor is null then raise exception 'Coordinator access required.' using errcode='42501'; end if;
  update public.driver_vehicles set status=decision,review_reason=btrim(reason),reviewed_by=actor,reviewed_at=now(),
    registered_at=case when decision='approved' then now() else registered_at end,version=version+1
    where driver_id=target returning * into saved;
  insert into private.driver_registration_events(driver_id,actor_id,snapshot) values(target,actor,to_jsonb(saved));
  return to_jsonb(saved);
end;
$$;
create or replace function public.review_driver_vehicle(target uuid, expected_version integer, decision text, reason text) returns jsonb
language sql security invoker set search_path = '' as $$ select private.review_driver_vehicle(target,expected_version,decision,reason); $$;

-- Coordinators may change only the login status of a Driver account, never its identity/role.
create or replace function private.save_driver_status(target uuid, expected_version integer, new_status text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare selected public.accounts; actor uuid;
begin
  if not private.is_coordinator() then raise exception 'Coordinator access required.' using errcode='42501'; end if;
  if new_status is null or new_status not in ('active','inactive') or expected_version is null or expected_version < 1 then
    raise exception 'Invalid driver status.' using errcode='22023'; end if;
  select * into selected from public.accounts where id=target and role='driver' for update;
  if not found then raise exception 'Driver not found.' using errcode='P0002'; end if;
  if selected.status_version<>expected_version then raise exception 'Driver status changed. Reload before saving.' using errcode='PT409'; end if;
  select id into actor from public.accounts where auth_user_id=(select auth.uid()) and role='coordinator' and status='active' for share;
  if actor is null then raise exception 'Coordinator access required.' using errcode='42501'; end if;
  update public.accounts set status=new_status where id=target returning * into selected;
  return jsonb_build_object('id',selected.id,'account_status',selected.status,'status_version',selected.status_version);
end;
$$;
create or replace function public.save_driver_status(target uuid, expected_version integer, new_status text) returns jsonb
language sql security invoker set search_path = '' as $$ select private.save_driver_status(target,expected_version,new_status); $$;
revoke all on function private.save_driver_status(uuid,integer,text),public.save_driver_status(uuid,integer,text) from public,anon;
grant execute on function private.save_driver_status(uuid,integer,text),public.save_driver_status(uuid,integer,text) to authenticated;

-- Replace the earlier three-argument API; defaults retain compatibility with existing calls.
drop function if exists public.list_drivers(integer,text,text);
drop function if exists private.list_drivers(integer,text,text);
create or replace function private.list_drivers(page_no integer, search_text text, status_filter text, sort_by text default 'created_at', sort_order text default 'desc') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  if not private.is_coordinator() then raise exception 'Coordinator access required.' using errcode='42501'; end if;
  if page_no is null or page_no not between 1 and 1000000 or search_text is null or length(search_text)>100
    or status_filter is null or status_filter not in ('all','not-submitted','pending','approved','rejected')
    or sort_by is null or sort_by not in ('created_at','id','full_name','phone','plate_number','status')
    or sort_order is null or sort_order not in ('asc','desc') then
    raise exception 'Invalid driver filters.' using errcode='22023'; end if;
  with matching as (
    select a.id,a.email,a.display_name,a.status as account_status,a.status_version,a.created_at,
      case when d.account_id is not null then to_jsonb(d) else null end as profile,
      case when v.driver_id is not null then to_jsonb(v) else null end as vehicle,
      case sort_by when 'id' then a.id::text when 'full_name' then lower(coalesce(d.full_name,a.display_name))
        when 'phone' then coalesce(d.phone,'') when 'plate_number' then coalesce(v.plate_number,'')
        when 'status' then coalesce(v.status,'not-submitted') else '' end as sort_value
    from public.accounts a left join public.drivers d on d.account_id=a.id left join public.driver_vehicles v on v.driver_id=a.id
    where a.role='driver' and (status_filter='all' or coalesce(v.status,'not-submitted')=status_filter)
      and (search_text='' or strpos(lower(concat_ws(' ',d.full_name,d.phone,a.display_name,a.email,a.id::text,v.plate_number)),lower(btrim(search_text)))>0)
  ), ordered as (
    select matching.*,row_number() over (order by
      case when sort_by='created_at' and sort_order='asc' then created_at end asc,
      case when sort_by='created_at' and sort_order='desc' then created_at end desc,
      case when sort_order='asc' then sort_value end asc,
      case when sort_order='desc' then sort_value end desc,id) as list_position from matching
  ), selected as (select * from ordered order by list_position limit 10 offset (page_no-1)*10)
  select jsonb_build_object('drivers',coalesce((select jsonb_agg(to_jsonb(s)-array['sort_value','list_position'] order by s.list_position) from selected s),'[]'::jsonb),
    'total',(select count(*) from matching),'page',page_no,'pageSize',10) into result;
  return result;
end;
$$;
create or replace function public.list_drivers(page_no integer, search_text text, status_filter text, sort_by text default 'created_at', sort_order text default 'desc') returns jsonb
language sql security invoker set search_path = '' as $$ select private.list_drivers(page_no,search_text,status_filter,sort_by,sort_order); $$;

revoke all on function private.submit_driver_vehicle(jsonb,integer),public.submit_driver_vehicle(jsonb,integer),
  private.review_driver_vehicle(uuid,integer,text,text),public.review_driver_vehicle(uuid,integer,text,text),
  private.list_drivers(integer,text,text,text,text),public.list_drivers(integer,text,text,text,text) from public, anon;
grant execute on function private.submit_driver_vehicle(jsonb,integer),public.submit_driver_vehicle(jsonb,integer),
  private.review_driver_vehicle(uuid,integer,text,text),public.review_driver_vehicle(uuid,integer,text,text),
  private.list_drivers(integer,text,text,text,text),public.list_drivers(integer,text,text,text,text) to authenticated;

-- Weekly availability uses Singapore time: Monday=0, 48 half-hour slots per day.
-- A slot key is weekday_index*48 + half_hour_index (0..335); no selected slots means unavailable.
create table if not exists public.driver_availability (
  driver_id uuid primary key references public.drivers(account_id) on delete restrict,
  weekly_slots integer[] not null default '{}' check (cardinality(weekly_slots)<=336 and 0<=all(weekly_slots) and 335>=all(weekly_slots) and array_position(weekly_slots,null) is null),
  version integer not null default 1 check (version>0),
  updated_at timestamptz not null default now()
);
-- Date overrides are retired; existing weekly slots remain unchanged.
drop function if exists public.save_my_availability(integer[],jsonb,integer);
drop function if exists private.save_my_availability(integer[],jsonb,integer);
alter table public.driver_availability drop column if exists exceptions;
create or replace function private.approved_driver_id() returns uuid
language sql stable security definer set search_path='' as $$
  select a.id from public.accounts a join public.driver_vehicles v on v.driver_id=a.id
    where a.auth_user_id=(select auth.uid()) and a.role='driver' and a.status='active' and v.status='approved';
$$;
revoke all on function private.approved_driver_id() from public,anon;
grant execute on function private.approved_driver_id() to authenticated;
alter table public.driver_availability enable row level security;
revoke all on public.driver_availability from public,anon,authenticated;
grant select on public.driver_availability to authenticated;
drop policy if exists driver_availability_read on public.driver_availability;
create policy driver_availability_read on public.driver_availability for select to authenticated
  using ((select private.is_coordinator()) or driver_id=(select private.approved_driver_id()));

create or replace function private.get_my_availability() returns jsonb
language plpgsql security definer set search_path='' as $$
declare owner_id uuid;
begin
  owner_id:=private.driver_account_id();
  if owner_id is null then raise exception 'Driver access required.' using errcode='42501'; end if;
  if private.approved_driver_id() is null then return jsonb_build_object('eligible',false,'availability',null); end if;
  return jsonb_build_object('eligible',true,'availability',(select to_jsonb(a) from public.driver_availability a where driver_id=owner_id));
end;
$$;
create or replace function public.get_my_availability() returns jsonb
language sql security invoker set search_path='' as $$ select private.get_my_availability(); $$;

-- Coordinator reads do not grant availability editing or relax assignment eligibility.
create or replace function private.get_driver_availability(target uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare eligible boolean;
begin
  if not private.is_coordinator() then raise exception 'Coordinator access required.' using errcode='42501'; end if;
  select a.status='active' and coalesce(v.status='approved',false) into eligible
    from public.accounts a left join public.driver_vehicles v on v.driver_id=a.id
    where a.id=target and a.role='driver';
  if not found then raise exception 'Driver not found.' using errcode='P0002'; end if;
  return jsonb_build_object('eligible',eligible,'availability',
    (select to_jsonb(a) from public.driver_availability a where a.driver_id=target));
end;
$$;
create or replace function public.get_driver_availability(target uuid) returns jsonb
language sql security invoker set search_path='' as $$ select private.get_driver_availability(target); $$;
revoke all on function private.get_driver_availability(uuid),public.get_driver_availability(uuid) from public,anon;
grant execute on function private.get_driver_availability(uuid),public.get_driver_availability(uuid) to authenticated;

create or replace function private.save_my_availability(slots integer[], expected_version integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare owner_id uuid; saved public.driver_availability;
begin
  owner_id:=private.driver_account_id();
  if owner_id is null then raise exception 'Approved Driver access required.' using errcode='42501'; end if;
  -- Serialize against status changes, vehicle resubmission/review and other availability saves.
  perform 1 from public.accounts where id=owner_id and role='driver' and status='active' for update;
  if not found then raise exception 'Approved Driver access required.' using errcode='42501'; end if;
  perform 1 from public.driver_vehicles where driver_id=owner_id and status='approved' for share;
  if not found then raise exception 'Approved Driver access required.' using errcode='42501'; end if;
  if slots is null or cardinality(slots)>336 or array_position(slots,null) is not null
    or not (0<=all(slots) and 335>=all(slots)) or (select count(distinct x) from unnest(slots) x)<>cardinality(slots)
    or expected_version is null or expected_version<0 then
    raise exception 'Invalid availability.' using errcode='22023'; end if;
  if exists(select 1 from private.driver_booking_windows(owner_id) t cross join lateral generate_series(
      date_trunc('hour',t.window_start at time zone 'Asia/Singapore')+floor(extract(minute from t.window_start at time zone 'Asia/Singapore')/30)*interval '30 minutes',
      (t.window_end-interval '1 microsecond') at time zone 'Asia/Singapore',interval '30 minutes') slot
    where t.window_end>now()
      and not exists(select 1 from public.driver_week_availability w where w.driver_id=owner_id and w.week_start=slot::date-extract(isodow from slot)::integer+1)
      and ((extract(isodow from slot)::integer-1)*48+extract(hour from slot)::integer*2+extract(minute from slot)::integer/30)<>all(slots)) then
    raise exception 'Assigned trip times must remain available until a coordinator unassigns the trip.' using errcode='P0001';
  end if;
  select * into saved from public.driver_availability where driver_id=owner_id for update;
  if (found and saved.version<>expected_version) or (not found and expected_version<>0) then
    raise exception 'Availability changed. Reload before saving.' using errcode='PT409'; end if;
  insert into public.driver_availability(driver_id,weekly_slots)
    values(owner_id,array(select x from unnest(slots) x order by x))
    on conflict(driver_id) do update set weekly_slots=excluded.weekly_slots,
      version=public.driver_availability.version+1,updated_at=now() returning * into saved;
  return to_jsonb(saved);
end;
$$;
create or replace function public.save_my_availability(slots integer[], expected_version integer) returns jsonb
language sql security invoker set search_path='' as $$ select private.save_my_availability(slots,expected_version); $$;
revoke all on function private.get_my_availability(),public.get_my_availability(),private.save_my_availability(integer[],integer),public.save_my_availability(integer[],integer) from public,anon;
grant execute on function private.get_my_availability(),public.get_my_availability(),private.save_my_availability(integer[],integer),public.save_my_availability(integer[],integer) to authenticated;

-- Treatment requirements are separate from operational Trips and pickup times.
create table if not exists public.dialysis_centres (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 150),
  address text not null check (length(btrim(address)) between 1 and 300),
  postal_code text not null check (postal_code ~ '^[0-9]{6}$')
);
-- NKF reference directory: https://nkfs.org/contact-us/dialysis-centre-locations/
-- Names/addresses checked 20 October 2026; NKF coverage only, not all Singapore providers.
-- Stable IDs keep schedule references intact. Keep existing manually entered matches.
insert into public.dialysis_centres(id,name,address,postal_code)
select seed.id::uuid,seed.name,seed.address,seed.postal_code from (values
  ('cda23889-4834-5bf0-b370-7cdfb2e63c0f', 'NKF Dialysis Centre Supported by Lorong Koo Chye Sheng Hong Temple', 'Blk 213 Bidadari Park Drive #03-14', '360213'),
  ('aea31be2-3645-5fe6-841f-80a6c50bd16a', 'NKF Dialysis Centre Supported by Christopher Heng Tiaw Boon Memorial Fund', 'Blk 465 Fernvale Road #01-07', '790465'),
  ('260c0802-8ddd-5bd8-be56-8b930c9f8b78', 'NKF Dialysis Centre Supported by Kwan Im Thong Hood Cho Temple (One Punggol)', '1 Punggol Drive #04-08', '828629'),
  ('6fc1462b-f9e2-5271-98b0-0aabcdd48aee', 'NKF Dialysis Centre Supported by San Wang Wu Ti Religious Society (Sengkang Community Hospital)', '1 Anchorvale Street, #01-26', '544835'),
  ('40d73c87-2e67-5e1e-8400-08473c1e2a57', 'NKF Dialysis Centre Supported by TL Whang Foundation', 'Blk 427 Pasir Ris Drive 6 #01-35/43', '510427'),
  ('07a0667f-abb9-5257-9ec8-c45aaf840fbd', 'NKF Dialysis Centre Supported by Man Fatt Lam Buddhist Temple', 'Blk 105 Bedok North Avenue 4 #01-2168', '460105'),
  ('e84c76e2-0f10-5dad-b067-01b0177f442f', 'NKF Dialysis Centre Supported by Keppel', '2 Yishun Central 2 #03-01 Yishun Community Hospital', '768024'),
  ('3ec48d9d-214e-5dee-983e-643acd025dc1', 'Seck Hong Choon - NKF Dialysis Centre', '200 Toa Payoh Lorong 2 #03-01', '319642'),
  ('098ae8dc-09ae-5259-89d7-48ed67d75f20', 'Foo Hai - NKF Dialysis Centre', 'Blk 311 Ubi Avenue 1 #01-383', '400311'),
  ('570bf8e2-f8d7-55a8-821d-1f3dd9dc2bad', 'NKF Dialysis Centre Supported by Wong Sui Ha Edna', 'Blk 271 Tampines Street 21 #01-99', '520271'),
  ('664b3c66-ff94-5bf9-86c3-026fe2611033', 'NKF Dialysis Centre Supported by Guan Choon Foundation', 'Blk 935 Tampines Street 91 #01-333', '520935'),
  ('2e94fdfb-5b42-5407-a524-eb25857a0e18', 'NKF Dialysis Centre Supported by Kwan Im Thong Hood Cho Temple (Simei)', 'Blk 101 Simei Street 1 #01-892', '520101'),
  ('74c3bfbe-5dc5-56e2-8c7c-304de7a25103', 'NKF Dialysis Centre Supported by San Wang Wu Ti Religious Society (Strathmore)', 'Blk 55 Strathmore Ave #01-145', '140055'),
  ('82463c33-e11b-5a68-9417-6abbb56cac6a', 'Tampines Chinese Temple - NKF Dialysis Centre', 'Blk 180 Pasir Ris Street 11 #01-06', '510180'),
  ('4c97f6ab-7afd-580a-8b57-99e53825a550', 'NKF Dialysis Centre Supported by Ngiam Kia Hum & Family', 'Blk 681 Punggol Drive #02-02', '820681'),
  ('8c6d2839-aada-5c68-8986-b944a8341ff3', 'NKF Dialysis Centre Supported by The Singapore Buddhist Lodge', 'Blk 128 Bukit Merah View #01-22', '150128'),
  ('3e022915-1155-514d-b6c1-b8da887b3145', 'NKF Dialysis Centre Supported by San Wang Wu Ti Religious Society (New Upper Changi)', 'Blk 27 New Upper Changi Road #01-694', '462027'),
  ('6173df48-6b02-5115-9f1b-03b00b618075', 'NKF Dialysis Centre Supported by The Singapore Contractors Association Ltd (SCAL) (Yishun)', 'Blk 840 Yishun Street 81 #01-382', '760840'),
  ('9c5f5720-eabf-5b4a-85c2-907e90100702', 'NKF Dialysis Centre Supported by Le Champ (South East Asia) Pte Ltd (Yishun)', 'Blk 639 Yishun Street 61 #01-168', '760639'),
  ('3f8a9dc6-8c33-508d-a1c6-3aebabfe243a', 'Toa Payoh Seu Teck Sean Tong - NKF Dialysis Centre', 'Blk 203 Yishun Street 21 #01-239', '760203'),
  ('79b448b9-f427-527f-b65b-7617956192e9', 'NKF Dialysis Centre Supported by The Singapore Contractors Association Ltd (SCAL) (Woodlands)', '365 Woodlands Avenue 5 #01-490', '730365'),
  ('1bba1131-447c-54a6-84b3-19ff2131478b', 'NKF Dialysis Centre Supported by Thong Teck Sian Tong Lian Sin Sia', 'Blk 825 Woodlands Street 81 #01-30', '730825'),
  ('d3f9858b-bb1e-54a7-bbdb-81c7efe47954', 'NKF Dialysis Centre Supported by Sakyadhita', 'Blk 19 Upper Boon Keng Road #01-1220', '380019'),
  ('99a31795-1b42-53a4-9c78-e045285799e1', 'NKF Dialysis Centre Supported by Toa Payoh Seu Teck Sean Tong', 'Blk 225 Toa Payoh Lor 8 #01-54', '310225'),
  ('a054accc-5ac4-59b0-af1f-732e02f6ebb5', 'NKF Dialysis Centre Supported by Insurance and Financial Practitioners Association of Singapore', 'Blk 201 Serangoon Central #01-30', '550201'),
  ('f94f87d5-257b-5a1e-ac06-11077bf41ca1', 'Jo & Gerry Essery - NKF Dialysis Centre', 'Blk 204 Marsiling Drive #01-188', '730204'),
  ('c6f8854f-2c71-5425-acff-aa8f6887e47c', 'NKF Dialysis Centre Supported by Kwan Im Thong Hood Cho Temple (Kolam Ayer)', 'Blk 43 Bendemeer Road #01-1018', '330043'),
  ('96e8d4f9-bf57-5a71-bfae-6546f1183fdc', 'NKF Dialysis Centre Supported by Tay Choon Hye', '81 Kim Keat Road', '328836'),
  ('7c677b80-c26d-56f8-927f-0bed42e58438', 'NKF Hougang - Punggol Dialysis Centre', 'Blk 628, Hougang Ave 8 #01-108', '530628'),
  ('4154ba6d-330d-5202-a9e5-492e28ad95f0', 'NKF Dialysis Centre Supported by Singapore Buddhist Welfare Services', 'Blk 114 Hougang Ave 1 #01-1298', '530114'),
  ('b30d0342-0e33-5100-bd4e-f040a863ee2a', 'Pei Hwa Foundation - NKF Dialysis Centre', 'Blk 565 Ang Mo Kio Ave 3 #01-3401', '560565'),
  ('5c43a30f-4819-5551-ba29-b9d6d6181666', 'NKF Dialysis Centre', 'Blk 633 Ang Mo Kio Ave 6 #01-5155', '560633'),
  ('907eb151-a885-5f68-a9b0-54484e1089d0', 'NKF Dialysis Centre Supported by Hong Leong Foundation', 'Blk 102 Aljunied Crescent #01-265', '380102'),
  ('f757c837-602d-5994-bd54-b767fa4b1745', 'The Hour Glass - NKF Dialysis Centre (Admiralty Branch)', 'Blk 761 Woodlands Ave 6 #01-108', '730761'),
  ('d6a8fd7e-f681-5601-8c19-06a25f6c0e7b', 'The Hour Glass - NKF Dialysis Centre (West Coast Branch)', 'Blk 701 West Coast Rd #01-323', '120701'),
  ('3ef61adc-c34a-57f2-a282-b86e93c5d3cb', 'Leong Hwa Chan Si Temple - NKF Dialysis Centre', 'Blk 113 Teck Whye Lane #01-666', '680113'),
  ('65e28d6f-c81e-590b-8de2-f651e718fbd8', 'NKF Dialysis Centre Supported by The Sirivadhanabhakdi Foundation', 'Blk 940 Jurong West St 91 #01-441', '640940'),
  ('2c7d0284-2ad2-55f2-868c-14ff0f615f0b', 'NKF Dialysis Centre Supported by Sheng Hong Temple', 'Blk 744 Jurong West Street 73 #01-19', '640744'),
  ('2e8362d4-639e-537d-8666-c2bd8bb72763', 'NKF Dialysis Centre Supported by Yuhua Grassroots Organisations', 'Blk 240C Jurong East Avenue 1 #01-01', '603240'),
  ('0803713b-e1e0-5e19-9674-fde84d9caac5', 'Woh Hup - NKF Dialysis Centre', 'Blk 1 Ghim Moh Rd #01-358', '270001'),
  ('9b1ca7d7-fe1b-5b8e-8458-7ce6cf6b2401', 'NKF Integrated Renal Centre Supported by The Sirivadhanabhakdi Foundation', '500 Corporation Road', '649808'),
  ('3cae85cf-d83b-5f23-af26-f2e70a2139bb', 'Lew Foundation - NKF Dialysis Centre', 'Blk 326 Clementi Ave 5 #01-175', '120326'),
  ('7263e509-00d4-51a3-b1ea-bc835fd399eb', 'NKF Dialysis Centre Supported by Le Champ (South East Asia) Pte Ltd (Bukit Panjang)', '275 Bangkit Rd, #01-96', '670275'),
  ('1502f9ba-5f12-59bb-b9e4-f1f7550041ee', 'NKF Dialysis Centre Supported by New Creation Church', 'Blk 274 Bangkit Rd #01-54', '670274'),
  ('8eee063e-d406-529e-9c6f-16fb271340ab', 'NKF Dialysis Centre Supported by Singapore Buddhist Youth Mission', '113A Bukit Batok West Avenue 6 #01-01', '651113')
) as seed(id,name,address,postal_code)
where not exists(select 1 from public.dialysis_centres c
  where c.id<>seed.id::uuid and lower(btrim(c.name))=lower(btrim(seed.name)) and c.postal_code=seed.postal_code)
on conflict(id) do update set name=excluded.name,address=excluded.address,postal_code=excluded.postal_code;

create table if not exists public.treatment_schedules (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.patients(id) on delete restrict,
  centre_id uuid not null references public.dialysis_centres(id) on delete restrict,
  days integer[] not null check (cardinality(days) between 1 and 7 and days <@ array[1,2,3,4,5,6,7] and array_position(days,null) is null),
  start_time time not null check (start_time < time '24:00'),
  end_time time not null check (end_time > start_time and end_time < time '24:00'),
  effective_from date not null check (isfinite(effective_from)),
  effective_to date not null check (isfinite(effective_to) and effective_to >= effective_from),
  created_at timestamptz not null default now()
);
-- Upgrade multi-day entries without losing any weekday, centre, time or date range.
-- The original UUID stays with the first day; additional days get their own records.
-- This runs in the schema transaction and is safe to repeat.
alter table public.treatment_schedules drop constraint if exists treatment_schedules_days_check;
drop trigger if exists treatment_overlap on public.treatment_schedules;
insert into public.treatment_schedules(patient_id,centre_id,days,start_time,end_time,effective_from,effective_to,created_at)
select s.patient_id,s.centre_id,array[d.day],s.start_time,s.end_time,s.effective_from,s.effective_to,s.created_at
from public.treatment_schedules s cross join lateral unnest(s.days) with ordinality as d(day,position)
where cardinality(s.days)>1 and d.position>1;
update public.treatment_schedules set days=array[days[1]] where cardinality(days)>1;
alter table public.treatment_schedules add constraint treatment_schedules_days_check
  check (cardinality(days)=1 and days <@ array[1,2,3,4,5,6,7] and array_position(days,null) is null);
-- Existing entries remain recurring. A replacement is a single session linked to one
-- original occurrence; its presence excludes that occurrence without changing the series.
alter table public.treatment_schedules add column if not exists kind text not null default 'recurring';
alter table public.treatment_schedules add column if not exists replaces_schedule_id uuid references public.treatment_schedules(id) on delete restrict;
alter table public.treatment_schedules add column if not exists replaces_date date;
alter table public.treatment_schedules add column if not exists version integer not null default 1;
alter table public.treatment_schedules drop constraint if exists treatment_supported_dates;
alter table public.treatment_schedules add constraint treatment_supported_dates check (
  effective_from between date '0001-01-01' and date '9999-12-31'
  and effective_to between date '0001-01-01' and date '9999-12-31'
  and (replaces_date is null or replaces_date between date '0001-01-01' and date '9999-12-31')) not valid;
alter table public.treatment_schedules drop constraint if exists treatment_has_occurrence;
alter table public.treatment_schedules add constraint treatment_has_occurrence check (
  effective_from + ((days[1]-extract(isodow from effective_from)::integer+7)%7) <= effective_to) not valid;
alter table public.treatment_schedules drop constraint if exists treatment_kind_check;
alter table public.treatment_schedules add constraint treatment_kind_check check (
  kind in ('recurring','single') and (kind<>'single' or
    (effective_from=effective_to and days[1]=extract(isodow from effective_from)::integer))
  and ((replaces_schedule_id is null and replaces_date is null) or
    (kind='single' and replaces_schedule_id is not null and replaces_date is not null and isfinite(replaces_date))));
create unique index if not exists treatment_one_replacement on public.treatment_schedules(replaces_schedule_id,replaces_date)
  where replaces_schedule_id is not null;
create index if not exists treatment_schedules_patient on public.treatment_schedules(patient_id);
alter table public.dialysis_centres enable row level security;
alter table public.treatment_schedules enable row level security;
revoke all on public.dialysis_centres, public.treatment_schedules from public, anon, authenticated;
grant select on public.dialysis_centres, public.treatment_schedules to authenticated;
grant insert(patient_id,centre_id,kind,days,start_time,end_time,effective_from,effective_to) on public.treatment_schedules to authenticated;
revoke insert(replaces_schedule_id,replaces_date) on public.treatment_schedules from authenticated;
-- Patient creation is allowed; saved schedules require coordinator approval to change.
revoke update on public.treatment_schedules from authenticated;
revoke update(centre_id,kind,days,start_time,end_time,effective_from,effective_to) on public.treatment_schedules from authenticated;

-- Read/write ownership uses live account state, not user-editable JWT metadata.
create or replace function private.owns_active_patient(target uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.patients p join public.accounts a on a.id=p.account_id
    where p.id=target and p.status='active' and a.auth_user_id=(select auth.uid())
      and a.role='patient' and a.status='active');
$$;
revoke all on function private.owns_active_patient(uuid) from public, anon;
grant execute on function private.owns_active_patient(uuid) to authenticated;
-- Transport authority is separate from ownership of personal profile details.
create or replace function private.can_manage_patient_transport(target uuid) returns boolean
language plpgsql stable security definer set search_path='' as $$
begin
  if private.owns_active_patient(target) then return true; end if;
  -- The link foundation is defined later on a fresh installation.
  if to_regprocedure('private.caregiver_can_access_patient(uuid)') is null then return false; end if;
  return private.caregiver_can_access_patient(target);
end;
$$;
create or replace function private.transport_patient_name(target uuid) returns text
language sql stable security definer set search_path='' as $$
  select full_name from public.patients where id=target and (private.is_coordinator() or private.can_manage_patient_transport(target));
$$;
revoke all on function private.can_manage_patient_transport(uuid),private.transport_patient_name(uuid) from public,anon;
grant execute on function private.can_manage_patient_transport(uuid),private.transport_patient_name(uuid) to authenticated;
drop policy if exists centres_read on public.dialysis_centres;
create policy centres_read on public.dialysis_centres for select to authenticated using (
  exists(select 1 from public.accounts where auth_user_id=(select auth.uid()) and status='active' and role in ('patient','caregiver','coordinator')));
drop policy if exists treatment_read on public.treatment_schedules;
create policy treatment_read on public.treatment_schedules for select to authenticated
  using ((select private.is_coordinator()) or private.can_manage_patient_transport(patient_id));
drop policy if exists treatment_insert on public.treatment_schedules;
create policy treatment_insert on public.treatment_schedules for insert to authenticated
  with check (private.can_manage_patient_transport(patient_id) and replaces_schedule_id is null and replaces_date is null);
drop policy if exists treatment_update on public.treatment_schedules;
-- Saved schedules are read-only to clients; future approved changes use a coordinator workflow.

-- Generation preferences are coordinator-owned, separate from patient treatment versions.
create table if not exists public.treatment_trip_generation (
  schedule_id uuid primary key references public.treatment_schedules(id) on delete cascade,
  enabled boolean not null default false,
  version integer not null default 1 check (version>0),
  enabled_by uuid not null references public.accounts(id) on delete restrict,
  updated_at timestamptz not null default now(),
  last_run_at timestamptz,
  last_error text
);
alter table public.treatment_trip_generation enable row level security;
revoke all on public.treatment_trip_generation from public,anon,authenticated;
grant select on public.treatment_trip_generation to authenticated;
drop policy if exists treatment_generation_read on public.treatment_trip_generation;
create policy treatment_generation_read on public.treatment_trip_generation for select to authenticated
  using (private.is_coordinator());
create or replace function private.treatment_auto_generation(target uuid) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare result jsonb;
begin
  if not private.is_coordinator() then raise exception 'Coordinator access required.' using errcode='42501'; end if;
  select jsonb_build_object('enabled',g.enabled,'version',g.version,'last_run_at',g.last_run_at,'last_error',g.last_error)
    into result from public.treatment_trip_generation g where g.schedule_id=target;
  return coalesce(result,jsonb_build_object('enabled',false,'version',0,'last_run_at',null,'last_error',null));
end;
$$;
revoke all on function private.treatment_auto_generation(uuid) from public,anon;
grant execute on function private.treatment_auto_generation(uuid) to authenticated;

-- Requests preserve the saved schedule until a coordinator reviews the proposal.
create table if not exists public.treatment_change_requests (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null,
  root_schedule_id uuid not null,
  patient_id uuid not null references public.patients(id) on delete restrict,
  requested_by uuid not null references public.accounts(id) on delete restrict,
  action text not null check (action in ('update','reschedule','delete')),
  proposal jsonb not null default '{}'::jsonb check (jsonb_typeof(proposal)='object'),
  original_date date,
  before_snapshot jsonb not null,
  schedule_version integer not null check (schedule_version>0),
  root_version integer not null check (root_version>0),
  reason text not null check (length(btrim(reason)) between 1 and 1000),
  status text not null default 'pending' check (status in ('pending','approved','rejected','withdrawn')),
  version integer not null default 1 check (version>0),
  requested_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references public.accounts(id) on delete restrict,
  review_note text not null default '' check (length(review_note)<=1000)
);
create unique index if not exists treatment_one_pending_change on public.treatment_change_requests(root_schedule_id) where status='pending';
create index if not exists treatment_change_latest on public.treatment_change_requests(schedule_id,requested_at desc,id);
alter table public.treatment_change_requests enable row level security;
revoke all on public.treatment_change_requests from public,anon,authenticated;
grant select on public.treatment_change_requests to authenticated;
drop policy if exists treatment_change_read on public.treatment_change_requests;
create policy treatment_change_read on public.treatment_change_requests for select to authenticated
  using (private.is_coordinator() or private.can_manage_patient_transport(patient_id));

create or replace function private.treatment_change_summary(target uuid) returns jsonb
language sql stable security invoker set search_path='' as $$
  select to_jsonb(r) from public.treatment_change_requests r
  where r.schedule_id=target or (r.status='pending' and r.root_schedule_id=(select coalesce(s.replaces_schedule_id,s.id) from public.treatment_schedules s where s.id=target))
  order by (r.status='pending') desc,r.requested_at desc,r.id desc limit 1;
$$;
revoke all on function private.treatment_change_summary(uuid) from public,anon;
grant execute on function private.treatment_change_summary(uuid) to authenticated;

-- Lock before the statement touches any schedule rows, including direct Data API
-- updates. Saves and deletion therefore always acquire Patient -> Schedule locks.
create or replace function private.lock_treatment_patient() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.patients where account_id=(select private.patient_account_id()) for update;
  return null;
end;
$$;
revoke all on function private.lock_treatment_patient() from public, anon, authenticated;
drop trigger if exists treatment_patient_lock on public.treatment_schedules;
create trigger treatment_patient_lock before insert or update on public.treatment_schedules
  for each statement execute function private.lock_treatment_patient();

-- Serialize changes per Patient so concurrent submissions cannot bypass overlap checks.
create or replace function private.check_treatment_overlap() returns trigger
language plpgsql security definer set search_path = '' as $$
declare parent public.treatment_schedules;
begin
  if not private.can_manage_patient_transport(new.patient_id) and not private.is_coordinator() then
    raise exception 'Treatment access denied.' using errcode='42501';
  end if;
  perform 1 from public.patients where id=new.patient_id for update;
  if not private.can_manage_patient_transport(new.patient_id) and not private.is_coordinator() then
    raise exception 'Treatment access denied.' using errcode='42501';
  end if;
  if tg_op='UPDATE' then
    new.version := old.version + 1;
    if new.kind<>old.kind then raise exception 'Schedule type cannot be changed.' using errcode='22023'; end if;
    if new.replaces_schedule_id is distinct from old.replaces_schedule_id or new.replaces_date is distinct from old.replaces_date then
      raise exception 'Original occurrence cannot be changed.' using errcode='22023';
    end if;
    if exists(select 1 from public.treatment_schedules r where r.replaces_schedule_id=new.id
      and (r.replaces_date<new.effective_from or r.replaces_date>new.effective_to or extract(isodow from r.replaces_date)::integer<>new.days[1])) then
      raise exception 'Recurring schedule changes would invalidate a rescheduled occurrence.' using errcode='22023';
    end if;
  end if;
  if new.replaces_schedule_id is not null then
    select * into parent from public.treatment_schedules where id=new.replaces_schedule_id;
    if not found or parent.patient_id<>new.patient_id or parent.kind<>'recurring'
      or new.kind<>'single' or new.replaces_date is null or not isfinite(new.replaces_date)
      or new.replaces_date<parent.effective_from or new.replaces_date>parent.effective_to
      or extract(isodow from new.replaces_date)::integer<>parent.days[1] then
      raise exception 'Select a valid original recurring occurrence.' using errcode='22023';
    end if;
    if exists(select 1 from public.treatment_schedules r where r.replaces_schedule_id=new.replaces_schedule_id
      and r.replaces_date=new.replaces_date and r.id<>new.id) then
      raise exception 'This occurrence has already been rescheduled.' using errcode='23505';
    end if;
  end if;
  if exists(select 1 from public.treatment_schedules s where s.patient_id=new.patient_id and s.id<>new.id
    and s.days && new.days and s.effective_from<=new.effective_to and s.effective_to>=new.effective_from
    and s.start_time<new.end_time and s.end_time>new.start_time
    and exists(select 1 from generate_series(
      (greatest(s.effective_from,new.effective_from) + ((new.days[1]-extract(isodow from greatest(s.effective_from,new.effective_from))::integer+7)%7))::timestamp,
      least(s.effective_to,new.effective_to)::timestamp, interval '7 days') d
      where not exists(select 1 from public.treatment_schedules r where r.replaces_schedule_id=s.id and r.replaces_date=d::date)
        and not exists(select 1 from public.treatment_schedules r where r.replaces_schedule_id=new.id and r.replaces_date=d::date)
        and not coalesce(s.id=new.replaces_schedule_id and d::date=new.replaces_date,false))) then
    raise exception 'Treatment sessions overlap.' using errcode='23P01';
  end if;
  return new;
end;
$$;
revoke all on function private.check_treatment_overlap() from public, anon, authenticated;
drop trigger if exists treatment_overlap on public.treatment_schedules;
create trigger treatment_overlap before insert or update on public.treatment_schedules
  for each row execute function private.check_treatment_overlap();

-- Owner-only internal operation for controlled future approval work; no client execution.
-- Direct DELETE remains revoked; all changes serialize on the same Patient as saves.
drop function if exists public.delete_my_treatment(uuid);
drop function if exists private.delete_my_treatment(uuid);
create or replace function private.delete_my_treatment(target uuid, expected_version integer) returns uuid
language plpgsql security definer set search_path = '' as $$
declare selected public.treatment_schedules;
begin
  if expected_version is null or expected_version < 1 then raise exception 'A schedule version is required.' using errcode='22023'; end if;
  select * into selected from public.treatment_schedules where id=target;
  if not found then
    if (select private.patient_account_id()) is null then
      raise exception 'Treatment access denied.' using errcode='42501';
    end if;
    return null;
  end if;
  if not private.can_manage_patient_transport(selected.patient_id) and not private.is_coordinator() then
    raise exception 'Treatment access denied.' using errcode='42501';
  end if;
  perform 1 from public.patients where id=selected.patient_id for update;
  -- Recheck after the lock: another request may have deleted the schedule.
  select * into selected from public.treatment_schedules where id=target for update;
  if not found then return null; end if;
  if selected.version <> expected_version then raise exception 'Schedule changed. Reload before deleting.' using errcode='PT409'; end if;
  if not private.can_manage_patient_transport(selected.patient_id) and not private.is_coordinator() then
    raise exception 'Treatment access denied.' using errcode='42501';
  end if;
  delete from public.treatment_schedules where replaces_schedule_id=target;
  delete from public.treatment_schedules where id=target;
  if selected.replaces_schedule_id is not null then
    -- Removing a replacement restores its original occurrence. The existing trigger
    -- checks the restored series; a conflict rolls this entire deletion back.
    update public.treatment_schedules set start_time=start_time where id=selected.replaces_schedule_id;
  end if;
  return target;
end;
$$;
create or replace function public.delete_my_treatment(target uuid, expected_version integer) returns uuid
language sql security invoker set search_path = '' as $$ select private.delete_my_treatment(target,expected_version); $$;
revoke all on function private.delete_my_treatment(uuid,integer), public.delete_my_treatment(uuid,integer) from public, anon;
revoke all on function private.delete_my_treatment(uuid,integer), public.delete_my_treatment(uuid,integer) from authenticated;

-- Owner-only internal edits compare the version while holding the same Patient lock
-- used by inserts/deletion. Direct Data API UPDATE is intentionally unavailable.
create or replace function private.update_my_treatment(target uuid, details jsonb, expected_version integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare selected public.treatment_schedules; candidate public.treatment_schedules;
begin
  if expected_version is null or expected_version < 1 or details is null or jsonb_typeof(details)<>'object'
    or details - array['kind','centre_id','days','start_time','end_time','effective_from','effective_to'] <> '{}'::jsonb then
    raise exception 'Invalid schedule update.' using errcode='22023';
  end if;
  select * into selected from public.treatment_schedules where id=target;
  if not found then return null; end if;
  if not private.can_manage_patient_transport(selected.patient_id) and not private.is_coordinator() then raise exception 'Treatment access denied.' using errcode='42501'; end if;
  perform 1 from public.patients where id=selected.patient_id for update;
  select * into selected from public.treatment_schedules where id=target for update;
  if not found then return null; end if;
  if not private.can_manage_patient_transport(selected.patient_id) and not private.is_coordinator() then raise exception 'Treatment access denied.' using errcode='42501'; end if;
  if selected.version<>expected_version then raise exception 'Schedule changed. Reload before saving.' using errcode='PT409'; end if;
  candidate := jsonb_populate_record(selected,details);
  update public.treatment_schedules set kind=candidate.kind,centre_id=candidate.centre_id,days=candidate.days,
    start_time=candidate.start_time,end_time=candidate.end_time,effective_from=candidate.effective_from,effective_to=candidate.effective_to
    where id=target returning * into selected;
  return to_jsonb(selected);
end;
$$;
create or replace function public.update_my_treatment(target uuid, details jsonb, expected_version integer) returns jsonb
language sql security invoker set search_path = '' as $$ select private.update_my_treatment(target,details,expected_version); $$;
revoke all on function private.update_my_treatment(uuid,jsonb,integer), public.update_my_treatment(uuid,jsonb,integer) from public,anon;
revoke all on function private.update_my_treatment(uuid,jsonb,integer), public.update_my_treatment(uuid,jsonb,integer) from authenticated;

-- A replacement changes the series context seen by an open editor as well.
create or replace function private.touch_treatment_parent() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.replaces_schedule_id is not null then
    update public.treatment_schedules set start_time=start_time where id=new.replaces_schedule_id;
  end if;
  return null;
end;
$$;
revoke all on function private.touch_treatment_parent() from public,anon,authenticated;
drop trigger if exists treatment_parent_version on public.treatment_schedules;
create trigger treatment_parent_version after insert or update on public.treatment_schedules
  for each row execute function private.touch_treatment_parent();

-- Filter and paginate inside PostgreSQL before returning a single JSON result,
-- avoiding PostgREST row caps. All reads retain the caller's RLS permissions.
drop function if exists public.list_treatments(text,integer);
drop function if exists private.list_treatments(text,integer);
create or replace function private.list_treatments(search_text text default '', page_no integer default 1, kind_filter text default 'all', centre_filter text default 'all', sort_by text default 'effective_from', sort_order text default 'asc') returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare result jsonb;
begin
  if page_no is null or page_no<1 or page_no>1000000 or search_text is null or length(search_text)>100
    or search_text ~ '[[:cntrl:]]' or kind_filter is null or kind_filter !~ '^(all|(recurring|single|rescheduled)(,(recurring|single|rescheduled)){0,2})$'
    or centre_filter is null or (centre_filter<>'all' and centre_filter !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$')
    or sort_by is null or sort_by not in ('effective_from','start_time','patient_name','centre_name','kind')
    or sort_order is null or sort_order not in ('asc','desc') then raise exception 'Invalid schedule search.' using errcode='22023'; end if;
  with visible as materialized (
    select s.*,jsonb_build_object('full_name',private.transport_patient_name(s.patient_id)) as patients,c.name as centre_name
    from public.treatment_schedules s join public.dialysis_centres c on c.id=s.centre_id
  ), matched as materialized (
    select * from visible s where (kind_filter='all' or ('recurring'=any(string_to_array(kind_filter,',')) and s.kind='recurring')
      or ('single'=any(string_to_array(kind_filter,',')) and s.kind='single' and s.replaces_schedule_id is null)
      or ('rescheduled'=any(string_to_array(kind_filter,',')) and s.replaces_schedule_id is not null))
      and (centre_filter='all' or s.centre_id::text=centre_filter)
      and (btrim(search_text)='' or exists (
      select 1 from unnest(array[
        s.patients->>'full_name',s.patient_id::text,
        s.centre_name, (array['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'])[s.days[1]],
        s.effective_from::text,s.effective_to::text,to_char(s.effective_from,'FMDD Mon YYYY'),to_char(s.effective_to,'FMDD Mon YYYY'),
        case when s.kind='single' then 'Single Session' else 'Recurring' end,
        case when s.replaces_schedule_id is not null then 'Rescheduled Session' else '' end
      ]) field where strpos(lower(field),lower(btrim(search_text)))>0))
  ), ordered as (
    select matched.*, row_number() over (order by
      case when sort_order='asc' then case sort_by when 'effective_from' then effective_from::text when 'start_time' then start_time::text when 'patient_name' then lower(patients->>'full_name') when 'centre_name' then lower(centre_name) when 'kind' then case when replaces_schedule_id is not null then 'rescheduled' else kind end end end asc,
      case when sort_order='desc' then case sort_by when 'effective_from' then effective_from::text when 'start_time' then start_time::text when 'patient_name' then lower(patients->>'full_name') when 'centre_name' then lower(centre_name) when 'kind' then case when replaces_schedule_id is not null then 'rescheduled' else kind end end end desc,
      effective_from,start_time,id) as list_order from matched
  ), page as materialized (
    select * from ordered order by list_order limit 10 offset ((page_no::bigint-1)*10)
  ), parents as (select id from page union select replaces_schedule_id from page where replaces_schedule_id is not null)
  select jsonb_build_object(
    'centres',(select coalesce(jsonb_agg(to_jsonb(c) order by name,id),'[]'::jsonb) from public.dialysis_centres c),
    'schedules',(select coalesce(jsonb_agg((to_jsonb(p)-'centre_name'-'list_order') || jsonb_build_object('change_request',private.treatment_change_summary(p.id)) || case when private.is_coordinator() then jsonb_build_object('trip_generation',private.treatment_trip_coverage(p.id),'auto_generation',private.treatment_auto_generation(coalesce(p.replaces_schedule_id,p.id))) else '{}'::jsonb end order by list_order),'[]'::jsonb) from page p),
    'context',(select coalesce(jsonb_agg(to_jsonb(s)-'centre_name' order by effective_from,id),'[]'::jsonb) from visible s where s.id in (select id from parents) or s.replaces_schedule_id in (select id from parents)),
    'total',(select count(*) from matched),'page',page_no,'pageSize',10) into result;
  return result;
end;
$$;
create or replace function public.list_treatments(search_text text default '', page_no integer default 1, kind_filter text default 'all', centre_filter text default 'all', sort_by text default 'effective_from', sort_order text default 'asc') returns jsonb
language sql stable security invoker set search_path = '' as $$ select private.list_treatments(search_text,page_no,kind_filter,centre_filter,sort_by,sort_order); $$;
revoke all on function private.list_treatments(text,integer,text,text,text,text), public.list_treatments(text,integer,text,text,text,text) from public,anon;
grant execute on function private.list_treatments(text,integer,text,text,text,text), public.list_treatments(text,integer,text,text,text,text) to authenticated;

-- Operational journeys are created explicitly by a Coordinator. Treatment source
-- UUIDs are retained as history even after a requirement is removed.
create table if not exists public.trips (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.patients(id) on delete restrict,
  patient_name text not null,
  source_schedule_id uuid not null,
  root_schedule_id uuid not null,
  occurrence_key text not null,
  original_session_date date not null,
  session_date date not null check (session_date between date '0001-01-01' and date '9999-12-31'),
  direction text not null check (direction in ('outbound','return')),
  origin text not null,
  destination text not null,
  treatment_start timestamptz not null,
  treatment_end timestamptz not null check (treatment_end>treatment_start),
  arrival_by timestamptz,
  pickup_not_before timestamptz,
  pickup_at timestamptz check (pickup_at is null),
  status text not null default 'unfilled' check (status='unfilled'),
  review_required boolean not null default false,
  source_version integer not null,
  patient_version integer not null,
  created_by uuid not null references public.accounts(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(root_schedule_id,occurrence_key,direction),
  check ((direction='outbound' and arrival_by is not null and arrival_by=treatment_start-interval '15 minutes' and pickup_not_before is null)
    or (direction='return' and pickup_not_before is not null and pickup_not_before=treatment_end+interval '15 minutes' and arrival_by is null))
);
create index if not exists trips_patient_date on public.trips(patient_id,session_date,id);
create index if not exists trips_session_date on public.trips(session_date,id);
alter table public.trips add column if not exists version integer not null default 1 check (version>0);
alter table public.trips add column if not exists deleted_at timestamptz;
alter table public.trips add column if not exists duration_minutes integer not null default 30 check (duration_minutes between 5 and 360 and duration_minutes%5=0);
alter table public.trips add column if not exists route_snapshot jsonb;
alter table public.trips add column if not exists demo_owner_id uuid references public.accounts(id) on delete restrict;
-- Business time belongs to a tagged fixture. Expiry, auditing and GPS freshness
-- intentionally continue using the real clock.
alter table public.trips add column if not exists demo_clock_at timestamptz;
alter table public.trips add column if not exists demo_clock_started_at timestamptz;
alter table public.trips drop constraint if exists trips_demo_clock_check;
alter table public.trips add constraint trips_demo_clock_check check (
  (demo_clock_at is null and demo_clock_started_at is null)
  or (demo_owner_id is not null and demo_clock_at is not null and isfinite(demo_clock_at)
    and (demo_clock_started_at is null or isfinite(demo_clock_started_at))));
create or replace function private.trip_now(journey public.trips) returns timestamptz
language sql stable security invoker set search_path='' as $$
  select case when journey.demo_owner_id is not null and journey.demo_clock_at is not null
    then journey.demo_clock_at+case when journey.demo_clock_started_at is null then interval '0 seconds'
      else greatest(interval '0 seconds',now()-journey.demo_clock_started_at) end
    else now() end;
$$;
revoke all on function private.trip_now(public.trips) from public,anon;
grant execute on function private.trip_now(public.trips) to authenticated;

-- Journey progress is independent of operational risk and patient confirmation.
alter table public.trips add column if not exists lifecycle text not null default 'scheduled';
alter table public.trips add column if not exists driver_unavailable_at timestamptz;
alter table public.trips add column if not exists traffic_review_required boolean not null default false;
alter table public.trips add column if not exists recovery_critical boolean not null default false;
create table if not exists private.trip_traffic_checks (
  trip_id uuid primary key references public.trips(id) on delete cascade,
  next_check_at timestamptz not null default now(),
  assessed_at timestamptz,
  assessment jsonb
);
alter table private.trip_traffic_checks enable row level security;
revoke all on private.trip_traffic_checks from public,anon,authenticated;

alter table public.trips add column if not exists confirmed_at timestamptz;
alter table public.trips add column if not exists confirmed_by uuid references public.accounts(id) on delete restrict;
alter table public.trips add column if not exists cancelled_at timestamptz;
alter table public.trips add column if not exists cancelled_by uuid references public.accounts(id) on delete restrict;
-- Historical read access is separate from a live driver reservation.
alter table public.trips add column if not exists cancelled_driver_id uuid references public.accounts(id) on delete restrict;
alter table public.trips drop constraint if exists trips_cancelled_driver_check;
alter table public.trips add constraint trips_cancelled_driver_check check (cancelled_driver_id is null or lifecycle='cancelled');
alter table public.trips add column if not exists cancelled_assignment jsonb;
alter table public.trips drop constraint if exists trips_cancelled_assignment_check;
alter table public.trips add constraint trips_cancelled_assignment_check check (cancelled_assignment is null or (lifecycle='cancelled' and cancelled_driver_id is not null and jsonb_typeof(cancelled_assignment)='object'));
alter table public.trips add column if not exists started_at timestamptz;
alter table public.trips add column if not exists completed_at timestamptz;
alter table public.trips add column if not exists first_started_at timestamptz;
alter table public.trips add column if not exists handover_at timestamptz;
update public.trips set first_started_at=started_at where started_at is not null and first_started_at is null;
alter table public.trips drop constraint if exists trips_lifecycle_check;
alter table public.trips add constraint trips_lifecycle_check check (
  (lifecycle='scheduled' and started_at is null and completed_at is null and cancelled_at is null and cancelled_by is null)
  or (lifecycle='in-progress' and started_at is not null and completed_at is null and cancelled_at is null and cancelled_by is null)
  or (lifecycle='completed' and started_at is not null and completed_at is not null and completed_at>=started_at and cancelled_at is null and cancelled_by is null)
  or (lifecycle='cancelled' and cancelled_at is not null and cancelled_by is not null and started_at is null and completed_at is null)
);
-- System cancellations can return when the schedule changes back; deliberate deletions cannot.
alter table public.trips add column if not exists schedule_change_cancelled boolean not null default false;
create or replace function private.increment_trip_version() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.version:=old.version+1;
  new.first_started_at:=coalesce(old.first_started_at,new.started_at);
  -- Once transport has begun, source reconciliation cannot rewrite the journey.
  -- Only the explicit handover transition may replace its pickup and reservation.
  if old.first_started_at is not null
    and not (old.demo_owner_id is not null and new.deleted_at is not null
      and current_setting('app.demo_reset_owner',true)=old.demo_owner_id::text
      and coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role','')='service_role')
    and not (old.lifecycle='in-progress' and new.lifecycle='scheduled' and new.handover_at is distinct from old.handover_at) and (
    new.origin is distinct from old.origin or new.destination is distinct from old.destination
    or new.treatment_start is distinct from old.treatment_start or new.treatment_end is distinct from old.treatment_end
    or new.source_schedule_id is distinct from old.source_schedule_id or new.session_date is distinct from old.session_date
    or new.deleted_at is not null or new.lifecycle='cancelled' or (old.assigned_driver_id is not null and new.assigned_driver_id is null)) then
    raise exception 'A journey that has started requires coordinator handover recovery.' using errcode='22023';
  end if;
  if new.lifecycle<>'cancelled' then new.cancelled_driver_id:=null; new.cancelled_assignment:=null;
  elsif old.lifecycle<>'cancelled' then
    new.cancelled_driver_id:=old.assigned_driver_id;
    new.cancelled_assignment:=old.assignment-'patient_phone'-'mobility'-'assistance_required';
  end if;
  if new.origin is distinct from old.origin or new.destination is distinct from old.destination then
    if (old.lifecycle='in-progress' and new.lifecycle='scheduled' and new.handover_at is distinct from old.handover_at
      and new.route_snapshot->>'origin'=new.origin and new.route_snapshot->>'destination'=new.destination) is not true then
      new.route_snapshot:=null; new.duration_minutes:=30;
    end if;
  end if;
  if new.assigned_driver_id is distinct from old.assigned_driver_id then new.driver_unavailable_at:=null; end if;
  if new.assigned_driver_id is distinct from old.assigned_driver_id or new.assigned_vehicle_id is distinct from old.assigned_vehicle_id
    or new.pickup_at is distinct from old.pickup_at or new.origin is distinct from old.origin or new.destination is distinct from old.destination
    or new.duration_minutes is distinct from old.duration_minutes or new.treatment_start is distinct from old.treatment_start
    or new.treatment_end is distinct from old.treatment_end or new.lifecycle in ('completed','cancelled') or new.deleted_at is not null then
    new.traffic_review_required:=false; new.recovery_critical:=false;
    delete from private.trip_traffic_checks where trip_id=new.id;
  end if;
  if (new.traffic_review_required or new.recovery_critical) and new.assigned_driver_id is not null and new.lifecycle in ('scheduled','in-progress') then new.status:='at-risk'; end if;

  if new.assigned_driver_id is distinct from old.assigned_driver_id or new.pickup_at is distinct from old.pickup_at
    or new.origin is distinct from old.origin or new.destination is distinct from old.destination
    or new.treatment_start is distinct from old.treatment_start or new.treatment_end is distinct from old.treatment_end then
    new.confirmed_at:=null; new.confirmed_by:=null;
  end if;
  return new;
end;
$$;
revoke all on function private.increment_trip_version() from public,anon,authenticated;
drop trigger if exists trips_version on public.trips;
create trigger trips_version before update on public.trips for each row execute function private.increment_trip_version();
create table if not exists public.trip_history (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete restrict,
  actor_id uuid references public.accounts(id) on delete restrict,
  event text not null check (event in ('generated','refreshed','requirements_changed')),
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists trip_history_trip on public.trip_history(trip_id,created_at,id);
alter table public.trip_history drop constraint if exists trip_history_event_check;
alter table public.trip_history add constraint trip_history_event_check check (event in ('generated','refreshed','requirements_changed','deleted','restored','schedule_change_approved','assigned','unassigned','confirmed','cancelled','driver_unavailable','started','completed','traffic_risk_detected','traffic_risk_cleared','recovery_critical','recovery_approved','handover_approved'));
alter table public.trips enable row level security;
alter table public.trip_history enable row level security;
revoke all on public.trips,public.trip_history from public,anon,authenticated;
grant select on public.trips,public.trip_history to authenticated;
drop policy if exists trips_read on public.trips;
create policy trips_read on public.trips for select to authenticated
  using ((select private.is_coordinator()) or private.can_manage_patient_transport(patient_id));
drop policy if exists trip_history_read on public.trip_history;
create policy trip_history_read on public.trip_history for select to authenticated
  using (exists(select 1 from public.trips t where t.id=trip_id));

-- A driver owns one approved vehicle; every journey reserves the whole mock driving window.
alter table public.trips add column if not exists assigned_driver_id uuid references public.accounts(id) on delete restrict;
alter table public.trips add column if not exists assigned_vehicle_id uuid references public.driver_vehicles(id) on delete restrict;
alter table public.trips add column if not exists dropoff_at timestamptz;
alter table public.trips add column if not exists assignment jsonb;
alter table public.trips drop constraint if exists trips_pickup_at_check;
alter table public.trips drop constraint if exists trips_status_check;
alter table public.trips add constraint trips_status_check check (status in ('unfilled','on-track','at-risk','resolved'));
alter table public.trips drop constraint if exists trips_assignment_check;
alter table public.trips add constraint trips_assignment_check check (
  (assigned_driver_id is null and assigned_vehicle_id is null and pickup_at is null and dropoff_at is null and assignment is null and ((lifecycle='scheduled' and status='unfilled') or (lifecycle='cancelled' and status='resolved')))
  or (assigned_driver_id is not null and assigned_vehicle_id is not null and pickup_at is not null and dropoff_at is not null and dropoff_at=pickup_at+make_interval(mins=>duration_minutes)
    and assignment is not null and jsonb_typeof(assignment)='object'
    and ((lifecycle in ('scheduled','in-progress') and status in ('on-track','at-risk')) or (lifecycle='completed' and status='resolved'))
    and ((direction='outbound' and dropoff_at<=arrival_by) or (direction='return' and pickup_at>=pickup_not_before)))
);
alter table public.trips drop constraint if exists trips_confirmation_check;
alter table public.trips add constraint trips_confirmation_check check (
  (confirmed_at is null and confirmed_by is null) or
  (confirmed_at is not null and confirmed_by is not null and assigned_driver_id is not null and lifecycle<>'cancelled')
);
alter table public.trips drop constraint if exists trips_driver_unavailability_check;
alter table public.trips add constraint trips_driver_unavailability_check check (
  driver_unavailable_at is null or (assigned_driver_id is not null and lifecycle in ('scheduled','in-progress') and status='at-risk')
);
create index if not exists trips_driver_window on public.trips(assigned_driver_id,pickup_at,dropoff_at) where deleted_at is null;
drop policy if exists trips_read on public.trips;
create policy trips_read on public.trips for select to authenticated using (
  (select private.is_coordinator()) or private.can_manage_patient_transport(patient_id)
  or (deleted_at is null and (assigned_driver_id=(select private.driver_account_id())
    or (lifecycle='cancelled' and cancelled_driver_id=(select private.driver_account_id())))));

-- Recover only the driver recorded on the latest cancellation, never an earlier assignment.
-- The owner-only schema apply can read history; repeated applies do not rewrite restored links.
with cancellations as (
  select t.id,(select h.details->>'driver_id' from public.trip_history h
    where h.trip_id=t.id and h.event='cancelled' order by h.created_at desc,h.id desc limit 1) as driver_id
  from public.trips t where t.lifecycle='cancelled' and t.cancelled_driver_id is null
)
update public.trips t set cancelled_driver_id=a.id from cancellations c join public.accounts a on a.id::text=c.driver_id and a.role='driver'
  where t.id=c.id;
-- New cancellations retain the original snapshot. For legacy events without one,
-- recover available driver/vehicle records only for the recorded cancellation assignment.
with snapshots as (
  select t.id,case when jsonb_typeof(h.details->'assignment')='object' then h.details->'assignment'
    else jsonb_strip_nulls(jsonb_build_object('driver_name',d.full_name,'driver_phone',d.phone,
      'plate',v.plate_number,'make',v.make,'model',v.model)) end as snapshot
  from public.trips t
  left join lateral (select details from public.trip_history where trip_id=t.id and event='cancelled'
    order by created_at desc,id desc limit 1) h on true
  left join public.drivers d on d.account_id=t.cancelled_driver_id
  left join public.driver_vehicles v on v.id::text=h.details->>'vehicle_id' and v.driver_id=t.cancelled_driver_id
  where t.lifecycle='cancelled' and t.cancelled_driver_id is not null and t.cancelled_assignment is null
    and (d.account_id is not null or jsonb_typeof(h.details->'assignment')='object')
)
update public.trips t set cancelled_assignment=s.snapshot from snapshots s where t.id=s.id;
create index if not exists trips_cancelled_driver on public.trips(cancelled_driver_id,session_date)
  where lifecycle='cancelled' and deleted_at is null;

-- Patient actions lock the same resources as assignment. RLS alone cannot authorise writes.
create or replace function private.patient_trip_action(target uuid,expected_version integer,action text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare chosen public.trips; actor uuid; saved public.trips; cutoff timestamptz;
begin
  select id into actor from public.accounts where auth_user_id=(select auth.uid()) and status='active' and role in ('patient','caregiver');
  if actor is null then raise exception 'Patient access required.' using errcode='42501'; end if;
  if action is null or action not in ('confirm','cancel') or expected_version is null or expected_version<1 then
    raise exception 'A valid trip action and version are required.' using errcode='22023';
  end if;
  select t.* into chosen from public.trips t where t.id=target and t.deleted_at is null
    and private.can_manage_patient_transport(t.patient_id);
  if not found then raise exception 'Trip access denied.' using errcode='42501'; end if;
  perform 1 from public.patients where id=chosen.patient_id and status='active' for update;
  if not found then raise exception 'Trip access denied.' using errcode='42501'; end if;
  if chosen.assigned_driver_id is not null then perform 1 from public.accounts where id=chosen.assigned_driver_id for update; end if;
  select * into chosen from public.trips where id=target and deleted_at is null for update;
  if not found then raise exception 'Trip not found.' using errcode='P0002'; end if;
  if not private.can_manage_patient_transport(chosen.patient_id) then raise exception 'Trip access denied.' using errcode='42501'; end if;
  if chosen.version<>expected_version then raise exception 'Trip changed. Reload before trying again.' using errcode='PT409'; end if;
  cutoff:=coalesce(chosen.pickup_at,chosen.pickup_not_before,chosen.arrival_by-make_interval(mins=>chosen.duration_minutes));
  if action='confirm' then
    if chosen.lifecycle<>'scheduled' or chosen.assigned_driver_id is null or chosen.pickup_at<=private.trip_now(chosen) or chosen.review_required or chosen.driver_unavailable_at is not null then
      raise exception 'Only an assigned upcoming pickup can be confirmed.' using errcode='22023';
    end if;
    if chosen.confirmed_at is not null then return to_jsonb(chosen); end if;
    update public.trips set confirmed_at=private.trip_now(chosen),confirmed_by=actor,updated_at=now() where id=target returning * into saved;
    insert into public.trip_history(trip_id,actor_id,event,details) values(target,actor,'confirmed',jsonb_build_object('pickup_at',chosen.pickup_at,'driver_id',chosen.assigned_driver_id,'actor_role',(select role from public.accounts where id=actor)));
  else
    if chosen.lifecycle<>'scheduled' or chosen.first_started_at is not null or cutoff<=private.trip_now(chosen) then raise exception 'Only upcoming trips can be cancelled before pickup.' using errcode='22023'; end if;
    update public.trips set lifecycle='cancelled',cancelled_at=private.trip_now(chosen),cancelled_by=actor,status='resolved',
      assigned_driver_id=null,assigned_vehicle_id=null,pickup_at=null,dropoff_at=null,assignment=null,
      confirmed_at=null,confirmed_by=null,review_required=false,updated_at=now() where id=target returning * into saved;
    insert into public.trip_history(trip_id,actor_id,event,details) values(target,actor,'cancelled',
      jsonb_build_object('driver_id',chosen.assigned_driver_id,'vehicle_id',chosen.assigned_vehicle_id,'pickup_at',chosen.pickup_at,'dropoff_at',chosen.dropoff_at,'assignment',saved.cancelled_assignment));
  end if;
  return to_jsonb(saved);
end;
$$;
create or replace function public.confirm_trip(target uuid,expected_version integer) returns jsonb
language sql security invoker set search_path='' as $$ select private.patient_trip_action(target,expected_version,'confirm'); $$;
create or replace function public.cancel_trip(target uuid,expected_version integer) returns jsonb
language sql security invoker set search_path='' as $$ select private.patient_trip_action(target,expected_version,'cancel'); $$;
revoke all on function private.patient_trip_action(uuid,integer,text),public.confirm_trip(uuid,integer),public.cancel_trip(uuid,integer) from public,anon;
grant execute on function private.patient_trip_action(uuid,integer,text),public.confirm_trip(uuid,integer),public.cancel_trip(uuid,integer) to authenticated;

create or replace function private.report_driver_unavailability(target uuid,expected_version integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare chosen public.trips; actor uuid:=private.driver_account_id();
begin
  if actor is null then raise exception 'Driver access required.' using errcode='42501'; end if;
  select * into chosen from public.trips where id=target and assigned_driver_id=actor and deleted_at is null;
  if not found then raise exception 'Trip access denied.' using errcode='42501'; end if;
  perform 1 from public.patients where id=chosen.patient_id for update;
  perform 1 from public.accounts where id=actor and role='driver' and status='active' for update;
  if not found then raise exception 'Driver access required.' using errcode='42501'; end if;
  select * into chosen from public.trips where id=target and assigned_driver_id=actor and deleted_at is null for update;
  if not found then raise exception 'Trip access denied.' using errcode='42501'; end if;
  if expected_version is null or expected_version<1 then raise exception 'A trip version is required.' using errcode='22023'; end if;
  if chosen.version<>expected_version then raise exception 'Trip changed. Reload before trying again.' using errcode='PT409'; end if;
  if chosen.lifecycle not in ('scheduled','in-progress') or (chosen.lifecycle='scheduled' and chosen.dropoff_at<=private.trip_now(chosen)) then
    raise exception 'Only an upcoming or active assigned trip can be reported.' using errcode='22023';
  end if;
  if chosen.driver_unavailable_at is not null then return to_jsonb(chosen); end if;
  update public.trips set driver_unavailable_at=now(),status='at-risk',updated_at=now() where id=target returning * into chosen;
  insert into public.trip_history(trip_id,actor_id,event,details) values(target,actor,'driver_unavailable',jsonb_build_object('driver_id',actor,'pickup_at',chosen.pickup_at));
  return to_jsonb(chosen);
end;
$$;
create or replace function public.report_driver_unavailability(target uuid,expected_version integer) returns jsonb
language sql security invoker set search_path='' as $$ select private.report_driver_unavailability(target,expected_version); $$;
revoke all on function private.report_driver_unavailability(uuid,integer),public.report_driver_unavailability(uuid,integer) from public,anon;
grant execute on function private.report_driver_unavailability(uuid,integer),public.report_driver_unavailability(uuid,integer) to authenticated;

-- Persistent inbox entries are delivered atomically with the trip event, once per recipient.
create table if not exists public.trip_notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references public.accounts(id) on delete restrict,
  trip_id uuid not null references public.trips(id) on delete restrict,
  event_id uuid not null references public.trip_history(id) on delete restrict,
  event text not null, message text not null,
  created_at timestamptz not null default now(), read_at timestamptz,
  unique(recipient_id,event_id)
);
create index if not exists trip_notifications_recipient_date on public.trip_notifications(recipient_id,created_at desc,id);
-- Keep one inbox for trip, relationship and shared schedule events.
alter table public.trip_notifications alter column trip_id drop not null;
alter table public.trip_notifications alter column event_id drop not null;
alter table public.trip_notifications add column if not exists notice_kind text not null default 'trip';
alter table public.trip_notifications add column if not exists patient_id uuid references public.patients(id) on delete restrict;
alter table public.trip_notifications drop constraint if exists notification_destination;
alter table public.trip_notifications add constraint notification_destination check (
  (notice_kind='trip' and trip_id is not null and event_id is not null and patient_id is null)
  or (notice_kind='link' and trip_id is null and event_id is null and patient_id is null)
  or (notice_kind='schedule' and trip_id is null and event_id is null and patient_id is not null));
alter table public.trip_notifications enable row level security;
revoke all on public.trip_notifications from public,anon,authenticated;
grant select on public.trip_notifications to authenticated;
drop policy if exists trip_notifications_read on public.trip_notifications;
create or replace function private.can_read_notice(recipient uuid,target uuid,patient_context uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.accounts a where a.id=recipient and a.auth_user_id=(select auth.uid()) and a.status='active'
    and (a.role<>'caregiver' or (target is null and patient_context is null)
      or (patient_context is not null and private.can_manage_patient_transport(patient_context))
      or exists(select 1 from public.trips t where t.id=target and t.deleted_at is null and private.can_manage_patient_transport(t.patient_id))));
$$;
revoke all on function private.can_read_notice(uuid,uuid,uuid) from public,anon;
grant execute on function private.can_read_notice(uuid,uuid,uuid) to authenticated;
create policy trip_notifications_read on public.trip_notifications for select to authenticated using (
  private.can_read_notice(recipient_id,trip_id,patient_id)
);
-- Patient notices describe outcomes; operational review wording stays with staff.
create or replace function private.patient_trip_event_label(event_name text,details jsonb) returns text
language sql immutable set search_path='' as $$
  select case
    when event_name='traffic_risk_detected' then 'Your trip may be delayed'
    when event_name='confirmed' and details->>'actor_role'='caregiver' then 'Caregiver acknowledged trip'
    when event_name='confirmed' and details->>'actor_role'='patient' then 'Patient acknowledged trip'
    when event_name='cancelled' and details->>'actor_role'='caregiver' then 'Caregiver cancelled trip'
    when event_name='cancelled' and details->>'actor_role'='patient' then 'Patient cancelled trip'
    when event_name='recovery_critical' then 'Your trip needs attention. Your coordinator is arranging transport.'
    when event_name in ('recovery_approved','handover_approved') then case
      when (details->>'previous_driver_id') is distinct from (details->>'driver_id') and (details->>'previous_pickup_at') is distinct from (details->>'pickup_at') then 'Your driver and pickup time have changed'
      when (details->>'previous_driver_id') is distinct from (details->>'driver_id') then 'Your driver has changed'
      when (details->>'previous_pickup_at') is distinct from (details->>'pickup_at') then 'Your pickup time has changed'
      else 'Your trip details have changed' end
  end;
$$;
revoke all on function private.patient_trip_event_label(text,jsonb) from public,anon,authenticated;
create or replace function private.driver_trip_event_label(recipient uuid,event_name text,details jsonb) returns text
language sql immutable set search_path='' as $$
  select case
    when event_name='assigned' then 'Trip assigned to you'
    when event_name='unassigned' then 'Trip assignment removed'
    when event_name='confirmed' then case when details->>'actor_role'='caregiver' then 'Caregiver acknowledged trip' else 'Patient acknowledged trip' end
    when event_name='traffic_risk_detected' then 'Traffic may delay your trip'
    when event_name='recovery_critical' then 'Your trip needs attention. Await coordinator instructions.'
    when event_name in ('recovery_approved','handover_approved') then case
      when (details->>'previous_driver_id') is distinct from (details->>'driver_id') and recipient::text=details->>'previous_driver_id' then 'Trip reassigned to another driver'
      when (details->>'previous_driver_id') is distinct from (details->>'driver_id') and recipient::text=details->>'driver_id' then 'Trip assigned to you'
      when (details->>'previous_pickup_at') is distinct from (details->>'pickup_at') then 'Your pickup time has changed'
      else 'Your trip details have changed' end
  end;
$$;
revoke all on function private.driver_trip_event_label(uuid,text,jsonb) from public,anon,authenticated;
create or replace function private.deliver_trip_event() returns trigger
language plpgsql security definer set search_path='' as $$
declare journey public.trips; patient_account uuid; affected_driver uuid; label text; action_details jsonb;
begin
  action_details:=new.details||jsonb_build_object('actor_role',(select role from public.accounts where id=new.actor_id));
  label:=case new.event when 'assigned' then 'Driver assigned' when 'unassigned' then 'Driver assignment removed'
    when 'handover_approved' then 'Safe handover approved' when 'recovery_critical' then 'Trip needs urgent manual intervention' when 'recovery_approved' then 'Recovery approved' when 'traffic_risk_cleared' then 'Traffic concern cleared' when 'traffic_risk_detected' then 'Traffic disruption requires review' when 'started' then 'Trip started' when 'completed' then 'Trip completed' when 'driver_unavailable' then 'Driver unavailable' when 'confirmed' then 'Trip acknowledged' when 'cancelled' then 'Trip cancelled'
    when 'requirements_changed' then 'Trip requires coordinator review' when 'refreshed' then 'Trip details updated'
    when 'schedule_change_approved' then 'Schedule change approved' end;
  if label is null then return null; end if;
  select * into journey from public.trips where id=new.trip_id;
  select account_id into patient_account from public.patients where id=journey.patient_id;
  affected_driver:=coalesce((new.details->>'driver_id')::uuid,journey.assigned_driver_id);
  -- Message snapshots omit patient identity, medical details and addresses, even after access is revoked.
  insert into public.trip_notifications(recipient_id,trip_id,event_id,event,message,created_at)
    select a.id,journey.id,new.id,new.event,
      case when journey.demo_owner_id is not null then 'Demo · ' else '' end||coalesce(case when a.role='patient' and new.event='completed' then 'Rate your driver'
        when a.role='patient' then private.patient_trip_event_label(new.event,action_details)
        when a.role='driver' then private.driver_trip_event_label(a.id,new.event,new.details) end,label)||' · '||to_char(journey.session_date,'FMDD Mon YYYY')||' · '||initcap(journey.direction),new.created_at
    from public.accounts a where a.status='active' and (a.id in (patient_account,affected_driver,(new.details->>'previous_driver_id')::uuid)
      or (a.role='coordinator' and (journey.demo_owner_id is null or a.id=journey.demo_owner_id) and new.event in ('confirmed','cancelled','driver_unavailable','started','completed','traffic_risk_detected','traffic_risk_cleared','recovery_critical','recovery_approved','handover_approved')))
      and not (new.event in ('confirmed','cancelled') and a.id=patient_account and new.actor_id is not distinct from a.id)
      and not (a.role='driver' and new.event in ('started','completed','driver_unavailable') and new.actor_id is not distinct from a.id)
    on conflict(recipient_id,event_id) do nothing;
  if to_regclass('public.caregiver_links') is not null then
    insert into public.trip_notifications(recipient_id,trip_id,event_id,event,message,created_at)
      select a.id,journey.id,new.id,new.event,case when journey.demo_owner_id is not null then 'Demo · ' else '' end||coalesce(private.patient_trip_event_label(new.event,action_details),label)||' · '||to_char(journey.session_date,'FMDD Mon YYYY')||' · '||initcap(journey.direction),new.created_at
      from public.caregiver_links l join public.caregivers c on c.account_id=l.caregiver_id join public.accounts a on a.id=c.account_id
      join public.patients p on p.id=l.patient_id join public.accounts pa on pa.id=p.account_id
      where l.patient_id=journey.patient_id and l.active and a.role='caregiver' and a.status='active' and p.status='active' and pa.status='active' and pa.role='patient'
        and not (new.event in ('confirmed','cancelled') and new.actor_id is not distinct from a.id)
      on conflict(recipient_id,event_id) do nothing;
  end if;
  return null;
end;
$$;
revoke all on function private.deliver_trip_event() from public,anon,authenticated;
drop trigger if exists trip_event_notification on public.trip_history;
create trigger trip_event_notification after insert on public.trip_history for each row execute function private.deliver_trip_event();

-- Apply the same patient presentation to existing inboxes without changing history/read state.
update public.trip_notifications n set message=case when t.demo_owner_id is not null then 'Demo · ' else '' end||'Rate your driver · '||to_char(t.session_date,'FMDD Mon YYYY')||' · '||initcap(t.direction)
  from public.accounts a,public.trips t
  where a.id=n.recipient_id and a.role='patient' and t.id=n.trip_id and n.event='completed'
    and t.lifecycle='completed' and t.assigned_driver_id is not null and t.deleted_at is null
    and n.message is distinct from case when t.demo_owner_id is not null then 'Demo · ' else '' end||'Rate your driver · '||to_char(t.session_date,'FMDD Mon YYYY')||' · '||initcap(t.direction);
update public.trip_notifications n set message=private.patient_trip_event_label(n.event,h.details)||coalesce(substring(n.message from ' · .*'),'')
  from public.accounts a,public.trip_history h
  where a.id=n.recipient_id and a.role='patient' and h.id=n.event_id
    and n.event in ('traffic_risk_detected','recovery_critical','recovery_approved','handover_approved')
    and n.message is distinct from private.patient_trip_event_label(n.event,h.details)||coalesce(substring(n.message from ' · .*'),'');
delete from public.trip_notifications n using public.accounts a,public.trip_history h
  where a.id=n.recipient_id and a.role='patient' and h.id=n.event_id and n.event='confirmed' and h.actor_id=a.id;
update public.trip_notifications n set message=private.driver_trip_event_label(a.id,n.event,h.details)||coalesce(substring(n.message from ' · .*'),'')
  from public.accounts a,public.trip_history h
  where a.id=n.recipient_id and a.role='driver' and h.id=n.event_id
    and n.event in ('assigned','unassigned','confirmed','traffic_risk_detected','recovery_critical','recovery_approved','handover_approved')
    and n.message is distinct from private.driver_trip_event_label(a.id,n.event,h.details)||coalesce(substring(n.message from ' · .*'),'');
delete from public.trip_notifications n using public.accounts a,public.trip_history h
  where a.id=n.recipient_id and a.role='driver' and h.id=n.event_id and n.event in ('started','completed','driver_unavailable') and h.actor_id=a.id;

create or replace function public.list_trip_notifications(page_no integer default 1) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare result jsonb;
begin
  if not exists(select 1 from public.accounts where auth_user_id=(select auth.uid()) and status='active') then raise exception 'Notification access denied.' using errcode='42501'; end if;
  if page_no is null or page_no<1 or page_no>1000000 then raise exception 'Invalid notification page.' using errcode='22023'; end if;
  select jsonb_build_object('notifications',(select coalesce(jsonb_agg(to_jsonb(n) order by n.created_at desc,n.id desc),'[]'::jsonb)
      from (select * from public.trip_notifications order by created_at desc,id desc limit 10 offset (page_no::bigint-1)*10) n),
    'total',(select count(*) from public.trip_notifications),'unread',(select count(*) from public.trip_notifications where read_at is null),
    'page',page_no,'pageSize',10) into result;
  return result;
end;
$$;
create or replace function private.read_trip_notification(target uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare saved public.trip_notifications;
begin
  update public.trip_notifications n set read_at=coalesce(n.read_at,now()) where n.id=target
    and private.can_read_notice(n.recipient_id,n.trip_id,n.patient_id) returning * into saved;
  if not found then raise exception 'Notification access denied.' using errcode='42501'; end if;
  return to_jsonb(saved);
end;
$$;
create or replace function public.read_trip_notification(target uuid) returns jsonb
language sql security invoker set search_path='' as $$ select private.read_trip_notification(target); $$;
revoke all on function public.list_trip_notifications(integer),private.read_trip_notification(uuid),public.read_trip_notification(uuid) from public,anon;
grant execute on function public.list_trip_notifications(integer),private.read_trip_notification(uuid),public.read_trip_notification(uuid) to authenticated;

-- One atomic recipient-scoped action, including notifications not loaded in the dropdown.
create or replace function private.read_all_trip_notifications() returns jsonb
language plpgsql security definer set search_path='' as $$
declare recipient uuid; marked_at timestamptz;
begin
  select id into recipient from public.accounts where auth_user_id=(select auth.uid()) and status='active'
    and role in ('patient','caregiver','driver','coordinator') for key share;
  if not found then raise exception 'Notification access denied.' using errcode='42501'; end if;
  marked_at:=clock_timestamp();
  update public.trip_notifications set read_at=marked_at where recipient_id=recipient and read_at is null and created_at<=marked_at and private.can_read_notice(recipient_id,trip_id,patient_id);
  return jsonb_build_object('read_at',marked_at,'unread',(select count(*) from public.trip_notifications where recipient_id=recipient and read_at is null and private.can_read_notice(recipient_id,trip_id,patient_id)));
end;
$$;
create or replace function public.read_all_trip_notifications() returns jsonb
language sql security invoker set search_path='' as $$ select private.read_all_trip_notifications(); $$;
revoke all on function private.read_all_trip_notifications(),public.read_all_trip_notifications() from public,anon;
grant execute on function private.read_all_trip_notifications(),public.read_all_trip_notifications() to authenticated;

create or replace function private.delete_read_trip_notifications() returns jsonb
language plpgsql security definer set search_path='' as $$
declare recipient uuid; removed integer;
begin
  select id into recipient from public.accounts where auth_user_id=(select auth.uid()) and status='active'
    and role in ('patient','caregiver','driver','coordinator') for key share;
  if not found then raise exception 'Notification access denied.' using errcode='42501'; end if;
  delete from public.trip_notifications where recipient_id=recipient and read_at is not null and private.can_read_notice(recipient_id,trip_id,patient_id);
  get diagnostics removed=row_count;
  return jsonb_build_object('deleted',removed,'notifications',(select coalesce(jsonb_agg(to_jsonb(n) order by n.created_at desc,n.id desc),'[]'::jsonb)
      from (select * from public.trip_notifications where recipient_id=recipient and private.can_read_notice(recipient_id,trip_id,patient_id) order by created_at desc,id desc limit 10) n),
    'page',1,'pageSize',10,'total',(select count(*) from public.trip_notifications where recipient_id=recipient and private.can_read_notice(recipient_id,trip_id,patient_id)),
    'unread',(select count(*) from public.trip_notifications where recipient_id=recipient and read_at is null and private.can_read_notice(recipient_id,trip_id,patient_id)));
end;
$$;
create or replace function public.delete_read_trip_notifications() returns jsonb
language sql security invoker set search_path='' as $$ select private.delete_read_trip_notifications(); $$;
revoke all on function private.delete_read_trip_notifications(),public.delete_read_trip_notifications() from public,anon;
grant execute on function private.delete_read_trip_notifications(),public.delete_read_trip_notifications() to authenticated;

create or replace function private.trip_history_page(target uuid,page_no integer) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
  if not exists(select 1 from public.trips t where t.id=target and (private.is_coordinator() or private.can_manage_patient_transport(t.patient_id)
    or (t.deleted_at is null and (t.assigned_driver_id=private.driver_account_id()
      or (t.lifecycle='cancelled' and t.cancelled_driver_id=private.driver_account_id()))))) then raise exception 'Trip access denied.' using errcode='42501'; end if;
  if page_no is null or page_no<1 or page_no>1000000 then raise exception 'Invalid history page.' using errcode='22023'; end if;
  select jsonb_build_object('events',(select coalesce(jsonb_agg(to_jsonb(e) order by e.created_at desc,e.id desc),'[]'::jsonb) from (
      select h.id,h.event,h.created_at,coalesce(a.role,'system') as actor,h.details
      from public.trip_history h left join public.accounts a on a.id=h.actor_id where h.trip_id=target
      order by h.created_at desc,h.id desc limit 10 offset (page_no::bigint-1)*10) e),
    'total',(select count(*) from public.trip_history where trip_id=target),'page',page_no,'pageSize',10) into result;
  return result;
end;
$$;
create or replace function public.trip_history_page(target uuid,page_no integer default 1) returns jsonb
language sql stable security invoker set search_path='' as $$ select private.trip_history_page(target,page_no); $$;
revoke all on function private.trip_history_page(uuid,integer),public.trip_history_page(uuid,integer) from public,anon;
grant execute on function private.trip_history_page(uuid,integer),public.trip_history_page(uuid,integer) to authenticated;

-- Verified provider data is written only by the backend integration role, never a browser JWT.
create table if not exists public.driving_routes (
  origin text not null, destination text not null,
  data jsonb not null check (jsonb_typeof(data)='object'),
  assessed_at timestamptz not null default now(), primary key(origin,destination)
);
alter table public.driving_routes enable row level security;
revoke all on public.driving_routes from public,anon,authenticated;
create or replace function private.cache_driving_route(origin_text text,destination_text text,route_data jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  if origin_text is null or destination_text is null or length(origin_text) not between 1 and 1500 or length(destination_text) not between 1 and 1500
    or route_data is null or jsonb_typeof(route_data)<>'object' or jsonb_typeof(route_data->'geometry') is distinct from 'array'
    or jsonb_array_length(route_data->'geometry') not between 2 and 20000
    or jsonb_typeof(route_data->'duration_seconds') is distinct from 'number'
    or (route_data->>'duration_seconds')::numeric<=0 or (route_data->>'duration_seconds')::numeric>21600
    or jsonb_typeof(route_data->'distance_metres') is distinct from 'number'
    or (route_data->>'distance_metres')::numeric<0 or (route_data->>'distance_metres')::numeric>300000
    or jsonb_typeof(route_data->'origin_coordinates') is distinct from 'object' or jsonb_typeof(route_data->'destination_coordinates') is distinct from 'object' then
    raise exception 'Invalid verified driving route.' using errcode='22023';
  end if;
  route_data:=route_data||jsonb_build_object('duration_minutes',greatest(5,ceil((route_data->>'duration_seconds')::numeric/300)::integer*5),'provider','onemap');
  insert into public.driving_routes(origin,destination,data,assessed_at) values(origin_text,destination_text,route_data,now())
    on conflict(origin,destination) do update set data=excluded.data,assessed_at=excluded.assessed_at;
  select data||jsonb_build_object('origin',origin,'destination',destination,'assessed_at',assessed_at) into result
    from public.driving_routes where origin=origin_text and destination=destination_text;
  return result;
end;
$$;
create or replace function public.cache_driving_route(origin_text text,destination_text text,route_data jsonb) returns jsonb
language sql security invoker set search_path='' as $$ select private.cache_driving_route(origin_text,destination_text,route_data); $$;
create or replace function private.cached_driving_route(origin_text text,destination_text text) returns jsonb
language sql stable security definer set search_path='' as $$
  select data||jsonb_build_object('origin',origin,'destination',destination,'assessed_at',assessed_at) from public.driving_routes
    where origin=origin_text and destination=destination_text and assessed_at>now()-interval '24 hours';
$$;
create or replace function public.cached_driving_route(origin_text text,destination_text text) returns jsonb
language sql stable security invoker set search_path='' as $$ select private.cached_driving_route(origin_text,destination_text); $$;
revoke all on function private.cache_driving_route(text,text,jsonb),public.cache_driving_route(text,text,jsonb),private.cached_driving_route(text,text),public.cached_driving_route(text,text) from public,anon,authenticated;
do $$ begin
  if exists(select 1 from pg_roles where rolname='service_role') then
    grant usage on schema private to service_role;
    grant execute on function private.cache_driving_route(text,text,jsonb),public.cache_driving_route(text,text,jsonb),private.cached_driving_route(text,text),public.cached_driving_route(text,text) to service_role;
  end if;
end; $$;

-- A coordinator may adopt only an existing trusted cache entry, on an unassigned versioned trip.
create or replace function private.prepare_trip_route(target uuid,expected_version integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare chosen public.trips; verified jsonb;
begin
  if not private.is_coordinator() then raise exception 'Coordinator access required.' using errcode='42501'; end if;
  select * into chosen from public.trips where id=target and deleted_at is null;
  if not found then raise exception 'Trip not found.' using errcode='P0002'; end if;
  perform 1 from public.patients where id=chosen.patient_id for update;
  select * into chosen from public.trips where id=target and deleted_at is null for update;
  if not found then raise exception 'Trip not found.' using errcode='P0002'; end if;
  if expected_version is null or chosen.version<>expected_version then raise exception 'Trip changed.' using errcode='PT409'; end if;
  if chosen.lifecycle<>'scheduled' or chosen.assigned_driver_id is not null then return to_jsonb(chosen); end if;
  verified:=private.cached_driving_route(chosen.origin,chosen.destination);
  if verified is null then raise exception 'A verified driving route is required.' using errcode='P0001'; end if;
  if chosen.route_snapshot is distinct from verified then
    update public.trips set route_snapshot=verified,duration_minutes=(verified->>'duration_minutes')::integer,
      demo_clock_at=case when demo_owner_id is not null and demo_clock_started_at is null
        then least(demo_clock_at,coalesce(arrival_by-make_interval(mins=>(verified->>'duration_minutes')::integer),pickup_not_before)-interval '15 minutes')
        else demo_clock_at end,updated_at=now() where id=target returning * into chosen;
  end if;
  return to_jsonb(chosen);
end;
$$;
create or replace function public.prepare_trip_route(target uuid,expected_version integer) returns jsonb
language sql security invoker set search_path='' as $$ select private.prepare_trip_route(target,expected_version); $$;
revoke all on function private.prepare_trip_route(uuid,integer),public.prepare_trip_route(uuid,integer) from public,anon;
grant execute on function private.prepare_trip_route(uuid,integer),public.prepare_trip_route(uuid,integer) to authenticated;

-- Recurring slots remain the default template; an override affects one dated Monday only.
create table if not exists public.driver_week_availability (
  driver_id uuid not null references public.drivers(account_id) on delete restrict,
  week_start date not null check (isfinite(week_start) and extract(isodow from week_start)=1),
  weekly_slots integer[] not null check (cardinality(weekly_slots)<=336 and 0<=all(weekly_slots) and 335>=all(weekly_slots) and array_position(weekly_slots,null) is null),
  version integer not null default 1 check (version>0), updated_at timestamptz not null default now(),
  primary key(driver_id,week_start)
);
alter table public.driver_week_availability enable row level security;
revoke all on public.driver_week_availability from public,anon,authenticated;
grant select on public.driver_week_availability to authenticated;
drop policy if exists driver_week_read on public.driver_week_availability;
create policy driver_week_read on public.driver_week_availability for select to authenticated
  using ((select private.is_coordinator()) or driver_id=(select private.driver_account_id()));
create or replace function private.effective_driver_slots(driver uuid,day date) returns integer[]
language sql stable security definer set search_path='' as $$
  select coalesce((select w.weekly_slots from public.driver_week_availability w where w.driver_id=driver and w.week_start=day-extract(isodow from day)::integer+1),
    (select a.weekly_slots from public.driver_availability a where a.driver_id=driver),'{}'::integer[]);
$$;
revoke all on function private.effective_driver_slots(uuid,date) from public,anon,authenticated;

create or replace function private.effective_trip_end(journey public.trips) returns timestamptz
language sql stable security definer set search_path='' as $$
  select case when journey.lifecycle='completed' then journey.completed_at
    when journey.lifecycle='in-progress' then greatest(journey.dropoff_at,journey.started_at+make_interval(mins=>journey.duration_minutes)) else journey.dropoff_at end;
$$;
revoke all on function private.effective_trip_end(public.trips) from public,anon,authenticated;

-- Internal eligibility predicate; callers must enforce role and lock resources before writes.
create or replace function private.driver_fits_trip_base(driver uuid,target public.trips,starts timestamptz) returns boolean
language sql stable security definer set search_path='' as $$
  select starts is not null and isfinite(starts) and starts>private.trip_now(target)
    and not exists(select 1 from public.trips active where active.assigned_driver_id=driver and active.lifecycle='in-progress' and active.deleted_at is null and private.effective_trip_end(active)<=private.trip_now(target)) and target.deleted_at is null
    and target.lifecycle='scheduled' and target.driver_unavailable_at is null and not target.review_required and not target.traffic_review_required and not target.recovery_critical
    and (starts at time zone 'Asia/Singapore')::date=(case when target.direction='outbound' then target.arrival_by-make_interval(mins=>target.duration_minutes) else target.pickup_not_before end at time zone 'Asia/Singapore')::date
    and case when target.direction='outbound' then starts+make_interval(mins=>target.duration_minutes)<=target.arrival_by else starts>=target.pickup_not_before end
    and exists(select 1 from public.patients p join public.accounts pa on pa.id=p.account_id
      where p.id=target.patient_id and p.status='active' and pa.status='active' and pa.role='patient')
    and exists(select 1 from public.accounts a join public.drivers d on d.account_id=a.id
      join public.driver_vehicles v on v.driver_id=a.id
      join public.patients p on p.id=target.patient_id
      where a.id=driver and a.status='active' and a.role='driver' and v.status='approved'
      and (a.demo_owner_id is not distinct from target.demo_owner_id or exists(select 1 from private.seeded_accounts s where s.account_id=a.id and s.owner_id=target.demo_owner_id))
      and v.passenger_capacity>=1
      and (p.mobility<>'wheelchair' or v.wheelchair_accessible)
      and not exists(select 1 from generate_series(
        date_trunc('hour',starts at time zone 'Asia/Singapore') + floor(extract(minute from starts at time zone 'Asia/Singapore')/30)*interval '30 minutes',
        (starts+make_interval(mins=>target.duration_minutes)-interval '1 microsecond') at time zone 'Asia/Singapore',interval '30 minutes') slot
        where ((extract(isodow from slot)::integer-1)*48+extract(hour from slot)::integer*2+extract(minute from slot)::integer/30)<>all(private.effective_driver_slots(a.id,slot::date))))
    and not exists(select 1 from public.trips other where other.assigned_driver_id=driver and other.id<>target.id and other.deleted_at is null
      and other.pickup_at<starts+make_interval(mins=>target.duration_minutes) and private.effective_trip_end(other)>starts);
$$;
revoke all on function private.driver_fits_trip_base(uuid,public.trips,timestamptz) from public,anon,authenticated;

create or replace function private.driver_covers_window(driver uuid,begins timestamptz,finishes timestamptz) returns boolean
language sql stable security definer set search_path='' as $$
  select not exists(select 1 from generate_series(
    date_trunc('hour',begins at time zone 'Asia/Singapore')+floor(extract(minute from begins at time zone 'Asia/Singapore')/30)*interval '30 minutes',
    (finishes-interval '1 microsecond') at time zone 'Asia/Singapore',interval '30 minutes') slot
    where ((extract(isodow from slot)::integer-1)*48+extract(hour from slot)::integer*2+extract(minute from slot)::integer/30)<>all(private.effective_driver_slots(driver,slot::date)));
$$;
revoke all on function private.driver_covers_window(uuid,timestamptz,timestamptz) from public,anon,authenticated;

-- Connecting travel ends at the following pickup; calendars and removal guards share it.
create or replace function private.driver_transfer_windows(driver uuid) returns table(trip_id uuid,window_start timestamptz,window_end timestamptz,origin text,destination text)
language sql stable security definer set search_path='' as $$
  with bookings as (
    select t.*,lag(t.destination) over(order by coalesce(started_at,pickup_at),id) as previous_destination,lag(private.effective_trip_end(t)) over(order by coalesce(started_at,pickup_at),id) as previous_dropoff
    from public.trips t where assigned_driver_id=driver and deleted_at is null and lifecycle<>'cancelled'
  )
  select b.id,coalesce(b.started_at,b.pickup_at)-make_interval(mins=>(r.data->>'duration_minutes')::integer),coalesce(b.started_at,b.pickup_at),b.previous_destination,b.origin from bookings b
    join public.driving_routes r on r.origin=b.previous_destination and r.destination=b.origin
    where b.previous_destination<>b.origin and b.previous_dropoff<=coalesce(b.started_at,b.pickup_at)-make_interval(mins=>(r.data->>'duration_minutes')::integer);
$$;
create or replace function private.driver_booking_windows(driver uuid) returns table(window_start timestamptz,window_end timestamptz)
language sql stable security definer set search_path='' as $$
  select coalesce(started_at,pickup_at),private.effective_trip_end(t) from public.trips t where assigned_driver_id=driver and deleted_at is null and lifecycle<>'cancelled'
  union all select window_start,window_end from private.driver_transfer_windows(driver);
$$;
revoke all on function private.driver_transfer_windows(uuid),private.driver_booking_windows(uuid) from public,anon,authenticated;

-- Adjacent bookings must leave enough road travel time, not just avoid overlap.
create or replace function private.driver_route_connected(driver uuid,target public.trips,starts timestamptz) returns boolean
language plpgsql stable security definer set search_path='' as $$
declare preceding public.trips; following public.trips; leg jsonb; finishes timestamptz:=starts+make_interval(mins=>target.duration_minutes);
begin
  select * into preceding from public.trips where assigned_driver_id=driver and id<>target.id and deleted_at is null and lifecycle<>'cancelled'
    and private.effective_trip_end(trips)<=starts order by private.effective_trip_end(trips) desc,id limit 1;
  if preceding.id is not null and preceding.destination<>target.origin then
    leg:=private.cached_driving_route(preceding.destination,target.origin);
    if leg is null or private.effective_trip_end(preceding)+make_interval(mins=>(leg->>'duration_minutes')::integer)>starts
      or not private.driver_covers_window(driver,starts-make_interval(mins=>(leg->>'duration_minutes')::integer),starts) then return false; end if;
  end if;
  select * into following from public.trips where assigned_driver_id=driver and id<>target.id and deleted_at is null and lifecycle<>'cancelled'
    and pickup_at>=finishes order by pickup_at,id limit 1;
  if following.id is not null and following.origin<>target.destination then
    leg:=private.cached_driving_route(target.destination,following.origin);
    if leg is null or finishes+make_interval(mins=>(leg->>'duration_minutes')::integer)>following.pickup_at
      or not private.driver_covers_window(driver,following.pickup_at-make_interval(mins=>(leg->>'duration_minutes')::integer),following.pickup_at) then return false; end if;
  end if;
  return true;
end;
$$;
create or replace function private.driver_fits_trip(driver uuid,target public.trips,starts timestamptz) returns boolean
language sql stable security definer set search_path='' as $$
  select coalesce(private.driver_fits_trip_base(driver,target,starts)
    and ((target.route_snapshot->>'origin'=target.origin and target.route_snapshot->>'destination'=target.destination
      and (target.route_snapshot->>'assessed_at')::timestamptz>now()-interval '24 hours') or coalesce(target.assigned_driver_id=driver,false))
    and private.driver_route_connected(driver,target,starts),false);
$$;
revoke all on function private.driver_route_connected(uuid,public.trips,timestamptz),private.driver_fits_trip(uuid,public.trips,timestamptz) from public,anon,authenticated;

-- Feedback belongs to the patient and the final driver of a completed journey.
create table if not exists private.driver_ratings (
  trip_id uuid primary key references public.trips(id) on delete restrict,
  patient_id uuid not null references public.patients(id) on delete restrict,
  driver_id uuid not null references public.drivers(account_id) on delete restrict,
  stars integer not null check(stars between 1 and 5),
  created_at timestamptz not null default now()
);
create index if not exists driver_ratings_driver on private.driver_ratings(driver_id);
create table if not exists private.driver_preferences (
  patient_id uuid primary key references public.patients(id) on delete restrict,
  driver_id uuid references public.drivers(account_id) on delete restrict,
  version integer not null default 1 check(version>0),
  updated_at timestamptz not null default now()
);
alter table private.driver_ratings enable row level security;
alter table private.driver_preferences enable row level security;
revoke all on private.driver_ratings,private.driver_preferences from public,anon,authenticated;

create or replace function private.driver_feedback_summary(driver uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object('completed_trips',(select count(*) from public.trips where assigned_driver_id=driver and lifecycle='completed' and deleted_at is null),
    'average_rating',round(avg(stars),1),'rating_count',count(*)) from private.driver_ratings where driver_id=driver;
$$;
create or replace function private.preferred_driver_for(patient uuid) returns uuid
language sql stable security definer set search_path='' as $$ select driver_id from private.driver_preferences where patient_id=patient; $$;
create or replace function private.last_completed_driver_for(patient uuid) returns uuid
language sql stable security definer set search_path='' as $$
  select assigned_driver_id from public.trips where patient_id=patient and lifecycle='completed' and deleted_at is null and assigned_driver_id is not null
    order by completed_at desc nulls last,id desc limit 1;
$$;
create or replace function private.preference_driver_eligible(driver uuid,patient uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.accounts a join public.drivers d on d.account_id=a.id
    join public.driver_vehicles v on v.driver_id=a.id join public.patients p on p.id=patient
    where a.id=driver and a.role='driver' and a.status='active' and v.status='approved' and v.passenger_capacity>=1
      and (p.mobility<>'wheelchair' or v.wheelchair_accessible));
$$;
revoke all on function private.driver_feedback_summary(uuid),private.preferred_driver_for(uuid),private.last_completed_driver_for(uuid),private.preference_driver_eligible(uuid,uuid) from public,anon,authenticated;

create or replace function private.trip_feedback(target uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare journey public.trips;
begin
  select * into journey from public.trips where id=target and deleted_at is null;
  if not found or not private.owns_active_patient(journey.patient_id) then raise exception 'Patient feedback access denied.' using errcode='42501'; end if;
  if journey.lifecycle<>'completed' or journey.assigned_driver_id is null then raise exception 'Feedback requires a completed trip.' using errcode='22023'; end if;
  return jsonb_build_object('trip_id',target,'driver_id',journey.assigned_driver_id,
    'rating',(select stars from private.driver_ratings where trip_id=target),
    'can_prefer',private.preference_driver_eligible(journey.assigned_driver_id,journey.patient_id),
    'preference',coalesce((select jsonb_build_object('driver_id',p.driver_id,'driver_name',d.full_name,'version',p.version)
      from private.driver_preferences p left join public.drivers d on d.account_id=p.driver_id where p.patient_id=journey.patient_id),jsonb_build_object('driver_id',null,'driver_name',null,'version',0)));
end;
$$;
create or replace function private.rate_driver(target uuid,rating integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare journey public.trips; saved private.driver_ratings;
begin
  if rating is null or rating not between 1 and 5 then raise exception 'Choose a rating from 1 to 5.' using errcode='22023'; end if;
  select * into journey from public.trips where id=target and deleted_at is null;
  if not found or not private.owns_active_patient(journey.patient_id) then raise exception 'Patient feedback access denied.' using errcode='42501'; end if;
  perform 1 from public.patients where id=journey.patient_id for update;
  perform 1 from public.accounts where id=journey.assigned_driver_id for key share;
  select * into journey from public.trips where id=target and deleted_at is null for update;
  if not found or not private.owns_active_patient(journey.patient_id) then raise exception 'Patient feedback access denied.' using errcode='42501'; end if;
  if journey.lifecycle<>'completed' or journey.assigned_driver_id is null then raise exception 'Feedback requires a completed trip.' using errcode='22023'; end if;
  insert into private.driver_ratings(trip_id,patient_id,driver_id,stars) values(target,journey.patient_id,journey.assigned_driver_id,rating)
    on conflict(trip_id) do nothing returning * into saved;
  if saved.trip_id is null then
    select * into saved from private.driver_ratings where trip_id=target;
    if saved.stars<>rating then raise exception 'A rating has already been submitted.' using errcode='PT409'; end if;
  end if;
  return jsonb_build_object('trip_id',target,'rating',saved.stars);
end;
$$;
create or replace function private.set_driver_preference(driver uuid,expected_version integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare patient uuid; saved private.driver_preferences;
begin
  select id into patient from public.patients where private.owns_active_patient(id) for update;
  if patient is null or not private.owns_active_patient(patient) then raise exception 'Patient preference access denied.' using errcode='42501'; end if;
  select * into saved from private.driver_preferences where patient_id=patient for update;
  if expected_version is null or expected_version<>coalesce(saved.version,0) then raise exception 'Driver preference changed.' using errcode='PT409'; end if;
  if driver is not null then
    perform 1 from public.accounts where id=driver for key share;
    if not private.preference_driver_eligible(driver,patient) or not exists(select 1 from public.trips
      where patient_id=patient and assigned_driver_id=driver and lifecycle='completed' and deleted_at is null) then
      raise exception 'Choose an eligible driver from a completed trip.' using errcode='22023'; end if;
  end if;
  insert into private.driver_preferences(patient_id,driver_id) values(patient,driver)
    on conflict(patient_id) do update set driver_id=excluded.driver_id,version=driver_preferences.version+1,updated_at=now() returning * into saved;
  return jsonb_build_object('driver_id',saved.driver_id,'driver_name',(select full_name from public.drivers where account_id=saved.driver_id),'version',saved.version);
end;
$$;
create or replace function private.my_driver_statistics() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare driver uuid;
begin
  select a.id into driver from public.accounts a join public.drivers d on d.account_id=a.id
    where a.auth_user_id=(select auth.uid()) and a.role='driver' and a.status='active';
  if driver is null then raise exception 'Driver access required.' using errcode='42501'; end if;
  return private.driver_feedback_summary(driver);
end;
$$;
create or replace function public.trip_feedback(target uuid) returns jsonb
language sql stable security invoker set search_path='' as $$ select private.trip_feedback(target); $$;
create or replace function public.rate_driver(target uuid,rating integer) returns jsonb
language sql security invoker set search_path='' as $$ select private.rate_driver(target,rating); $$;
create or replace function public.set_driver_preference(driver uuid,expected_version integer) returns jsonb
language sql security invoker set search_path='' as $$ select private.set_driver_preference(driver,expected_version); $$;
create or replace function public.my_driver_statistics() returns jsonb
language sql stable security invoker set search_path='' as $$ select private.my_driver_statistics(); $$;
revoke all on function private.trip_feedback(uuid),public.trip_feedback(uuid),private.rate_driver(uuid,integer),public.rate_driver(uuid,integer),private.set_driver_preference(uuid,integer),public.set_driver_preference(uuid,integer),private.my_driver_statistics(),public.my_driver_statistics() from public,anon;
grant execute on function private.trip_feedback(uuid),public.trip_feedback(uuid),private.rate_driver(uuid,integer),public.rate_driver(uuid,integer),private.set_driver_preference(uuid,integer),public.set_driver_preference(uuid,integer),private.my_driver_statistics(),public.my_driver_statistics() to authenticated;

create or replace function private.assignment_route_requirements(target uuid,starts timestamptz) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare chosen public.trips; result jsonb;
begin
  if not private.is_coordinator() then raise exception 'Coordinator access required.' using errcode='42501'; end if;
  select * into chosen from public.trips where id=target and deleted_at is null;
  if not found then raise exception 'Trip not found.' using errcode='P0002'; end if;
  if starts is null or not isfinite(starts) then raise exception 'Choose a pickup time.' using errcode='22023'; end if;
  with drivers as (
    select a.id from public.accounts a where a.role='driver' and private.driver_fits_trip_base(a.id,chosen,starts)
  ), legs as (
    select p.destination as origin,chosen.origin as destination from drivers d cross join lateral
      (select destination from public.trips where assigned_driver_id=d.id and id<>target and deleted_at is null and lifecycle<>'cancelled'
        and private.effective_trip_end(trips)<=starts order by private.effective_trip_end(trips) desc,id limit 1) p
    union
    select chosen.destination,n.origin from drivers d cross join lateral
      (select origin from public.trips where assigned_driver_id=d.id and id<>target and deleted_at is null and lifecycle<>'cancelled'
        and pickup_at>=starts+make_interval(mins=>chosen.duration_minutes) order by pickup_at,id limit 1) n
  ) select coalesce(jsonb_agg(to_jsonb(legs)) filter(where origin<>destination),'[]'::jsonb) into result from legs;
  return result;
end;
$$;
create or replace function public.assignment_route_requirements(target uuid,starts timestamptz) returns jsonb
language sql stable security invoker set search_path='' as $$ select private.assignment_route_requirements(target,starts); $$;
revoke all on function private.assignment_route_requirements(uuid,timestamptz),public.assignment_route_requirements(uuid,timestamptz) from public,anon;
grant execute on function private.assignment_route_requirements(uuid,timestamptz),public.assignment_route_requirements(uuid,timestamptz) to authenticated;

create or replace function private.trip_assignment_options(target uuid,starts timestamptz) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare chosen public.trips; result jsonb;
begin
  if not private.is_coordinator() then raise exception 'Coordinator access required.' using errcode='42501'; end if;
  select * into chosen from public.trips where id=target and deleted_at is null;
  if not found then raise exception 'Trip not found.' using errcode='P0002'; end if;
  if starts is null or not isfinite(starts) then raise exception 'Choose a pickup time.' using errcode='22023'; end if;
  with eligible as materialized (
    select a.id,d.full_name,d.phone,v.id as vehicle_id,v.plate_number,v.make,v.model,v.passenger_capacity,v.wheelchair_accessible,
      coalesce(a.id=private.preferred_driver_for(chosen.patient_id),false) as preferred,
      coalesce(a.id=private.last_completed_driver_for(chosen.patient_id),false) as continuity,
      private.driver_feedback_summary(a.id) as feedback
    from public.accounts a join public.drivers d on d.account_id=a.id join public.driver_vehicles v on v.driver_id=a.id
    where private.driver_fits_trip(a.id,chosen,starts)
  ) select jsonb_build_object('trip',to_jsonb(chosen),'duration_minutes',chosen.duration_minutes,
    'drivers',coalesce(jsonb_agg(jsonb_build_object('id',id,'name',full_name,'phone',phone,'vehicle_id',vehicle_id,'plate',plate_number,
      'make',make,'model',model,'passenger_capacity',passenger_capacity,'wheelchair_accessible',wheelchair_accessible,
      'preferred',preferred,'continuity',continuity,'average_rating',feedback->'average_rating','rating_count',feedback->'rating_count')
      order by preferred desc,continuity desc,(feedback->>'average_rating')::numeric desc nulls last,full_name,id),'[]'::jsonb)) into result from eligible;
  return result;
end;
$$;
create or replace function public.trip_assignment_options(target uuid,starts timestamptz) returns jsonb
language sql stable security invoker set search_path='' as $$ select private.trip_assignment_options(target,starts); $$;
revoke all on function private.trip_assignment_options(uuid,timestamptz),public.trip_assignment_options(uuid,timestamptz) from public,anon;
grant execute on function private.trip_assignment_options(uuid,timestamptz),public.trip_assignment_options(uuid,timestamptz) to authenticated;

create or replace function private.assign_trip(target uuid,driver uuid,starts timestamptz,expected_version integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare chosen public.trips; saved public.trips; snapshot jsonb; actor uuid;
begin
  if not private.is_coordinator() then raise exception 'Coordinator access required.' using errcode='42501'; end if;
  select * into chosen from public.trips where id=target and deleted_at is null;
  if not found then raise exception 'Trip not found.' using errcode='P0002'; end if;
  -- All competing assignments to this driver serialize, including assignments for other patients.
  perform 1 from public.patients where id=chosen.patient_id for update;
  perform 1 from public.accounts where id=driver and role='driver' and status='active' for update;
  if not found then raise exception 'Driver is no longer eligible.' using errcode='PT409'; end if;
  perform 1 from public.driver_vehicles where driver_id=driver for share;
  perform 1 from public.driver_availability where driver_id=driver for share;
  select * into chosen from public.trips where id=target and deleted_at is null for update;
  if not found then raise exception 'Trip not found.' using errcode='P0002'; end if;
  if expected_version is null or chosen.version<>expected_version then raise exception 'Trip changed.' using errcode='PT409'; end if;
  if chosen.assigned_driver_id is not null then raise exception 'Unassign the current driver first.' using errcode='22023'; end if;
  if private.driver_fits_trip(driver,chosen,starts) is distinct from true then raise exception 'Driver is no longer eligible for this pickup time.' using errcode='PT409'; end if;
  select jsonb_build_object('driver_name',d.full_name,'driver_phone',d.phone,'vehicle_id',v.id,'plate',v.plate_number,'make',v.make,'model',v.model,
    'passenger_capacity',v.passenger_capacity,'wheelchair_accessible',v.wheelchair_accessible,'patient_phone',p.phone,'mobility',p.mobility,'assistance_required',p.assistance_required) into snapshot
    from public.drivers d join public.driver_vehicles v on v.driver_id=d.account_id cross join public.patients p where d.account_id=driver and p.id=chosen.patient_id;
  select id into actor from public.accounts where auth_user_id=(select auth.uid());
  update public.trips set assigned_driver_id=driver,assigned_vehicle_id=(snapshot->>'vehicle_id')::uuid,assignment=snapshot,
    pickup_at=starts,dropoff_at=starts+make_interval(mins=>chosen.duration_minutes),status='on-track',updated_at=now() where id=target returning * into saved;
  insert into public.trip_history(trip_id,actor_id,event,details) values(target,actor,'assigned',jsonb_build_object('driver_id',driver,'pickup_at',starts,'dropoff_at',saved.dropoff_at));
  return to_jsonb(saved);
end;
$$;
create or replace function public.assign_trip(target uuid,driver uuid,starts timestamptz,expected_version integer) returns jsonb
language sql security invoker set search_path='' as $$ select private.assign_trip(target,driver,starts,expected_version); $$;
revoke all on function private.assign_trip(uuid,uuid,timestamptz,integer),public.assign_trip(uuid,uuid,timestamptz,integer) from public,anon;
grant execute on function private.assign_trip(uuid,uuid,timestamptz,integer),public.assign_trip(uuid,uuid,timestamptz,integer) to authenticated;

create or replace function private.unassign_trip(target uuid,expected_version integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare chosen public.trips; actor uuid;
begin
  if not private.is_coordinator() then raise exception 'Coordinator access required.' using errcode='42501'; end if;
  select * into chosen from public.trips where id=target and deleted_at is null;
  if not found then raise exception 'Trip not found.' using errcode='P0002'; end if;
  perform 1 from public.patients where id=chosen.patient_id for update;
  select * into chosen from public.trips where id=target and deleted_at is null for update;
  if not found then raise exception 'Trip not found.' using errcode='P0002'; end if;
  if expected_version is null or chosen.version<>expected_version then raise exception 'Trip changed.' using errcode='PT409'; end if;
  if chosen.lifecycle<>'scheduled' or chosen.assigned_driver_id is null or chosen.pickup_at<=private.trip_now(chosen) then raise exception 'Only upcoming assigned trips may be unassigned.' using errcode='22023'; end if;
  select id into actor from public.accounts where auth_user_id=(select auth.uid());
  insert into public.trip_history(trip_id,actor_id,event,details) values(target,actor,'unassigned',jsonb_build_object('driver_id',chosen.assigned_driver_id,'pickup_at',chosen.pickup_at,'reason','coordinator'));
  update public.trips set assigned_driver_id=null,assigned_vehicle_id=null,assignment=null,pickup_at=null,dropoff_at=null,status='unfilled',updated_at=now() where id=target returning * into chosen;
  return to_jsonb(chosen);
end;
$$;
create or replace function public.unassign_trip(target uuid,expected_version integer) returns jsonb
language sql security invoker set search_path='' as $$ select private.unassign_trip(target,expected_version); $$;
revoke all on function private.unassign_trip(uuid,integer),public.unassign_trip(uuid,integer) from public,anon;
grant execute on function private.unassign_trip(uuid,integer),public.unassign_trip(uuid,integer) to authenticated;

-- Resource edits retain the assignment and flag it for coordinator attention when no longer feasible.
create or replace function private.recheck_driver_trips() returns trigger
language plpgsql security definer set search_path='' as $$
declare owner_id uuid; journey public.trips; new_status text;
begin
  if tg_table_name='accounts' then
    if new.role<>'driver' or new.status is not distinct from old.status then return null; end if;
    owner_id:=new.id;
  elsif tg_table_name='drivers' then owner_id:=new.account_id;
  else owner_id:=new.driver_id;
  end if;
  for journey in select * from public.trips where assigned_driver_id=owner_id and deleted_at is null and lifecycle='scheduled' and pickup_at>private.trip_now(trips) order by id for update loop
    new_status:=case when private.driver_fits_trip(owner_id,journey,journey.pickup_at) then 'on-track' else 'at-risk' end;
    if journey.status<>new_status or tg_table_name in ('drivers','driver_vehicles') then
      update public.trips set status=new_status,assignment=assignment || (select jsonb_build_object('driver_name',d.full_name,'driver_phone',d.phone) from public.drivers d where d.account_id=owner_id)
        || coalesce((select jsonb_build_object('plate',v.plate_number,'make',v.make,'model',v.model,'passenger_capacity',v.passenger_capacity,'wheelchair_accessible',v.wheelchair_accessible)
          from public.driver_vehicles v where v.driver_id=owner_id and v.status='approved'),'{}'::jsonb),updated_at=now() where id=journey.id;
      insert into public.trip_history(trip_id,event,details) values(journey.id,'requirements_changed',jsonb_build_object('source',tg_table_name,'status',new_status));
    end if;
  end loop;
  return null;
end;
$$;
revoke all on function private.recheck_driver_trips() from public,anon,authenticated;
drop trigger if exists driver_status_trip_check on public.accounts;
create trigger driver_status_trip_check after update on public.accounts for each row execute function private.recheck_driver_trips();
drop trigger if exists driver_contact_trip_check on public.drivers;
create trigger driver_contact_trip_check after update on public.drivers for each row execute function private.recheck_driver_trips();
drop trigger if exists driver_vehicle_trip_check on public.driver_vehicles;
create trigger driver_vehicle_trip_check after update on public.driver_vehicles for each row execute function private.recheck_driver_trips();
drop trigger if exists driver_availability_trip_check on public.driver_availability;
create trigger driver_availability_trip_check after insert or update on public.driver_availability for each row execute function private.recheck_driver_trips();

drop trigger if exists driver_week_trip_check on public.driver_week_availability;
create trigger driver_week_trip_check after insert or update on public.driver_week_availability for each row execute function private.recheck_driver_trips();

-- Every source mutation locks the Patient before touching Trips, just as explicit
-- generation does. Source edits flag future journeys instead of silently treating
-- an old transport snapshot as current. No history or transport row is deleted.
create or replace function private.flag_trip_review() returns trigger
language plpgsql security definer set search_path = '' as $$
declare root uuid; original date; subject uuid; changed uuid; actor uuid;
begin
  select id into actor from public.accounts where auth_user_id=(select auth.uid());
  if tg_table_name='patients' then
    if (to_jsonb(old)-'version') is not distinct from (to_jsonb(new)-'version') then return null; end if;
    subject := new.id;
  elsif tg_op='DELETE' then
    root := coalesce(old.replaces_schedule_id,old.id); original := old.replaces_date;
  else
    if tg_op='UPDATE' and row(old.centre_id,old.days,old.start_time,old.end_time,old.effective_from,old.effective_to)
      is not distinct from row(new.centre_id,new.days,new.start_time,new.end_time,new.effective_from,new.effective_to) then return null; end if;
    root := coalesce(new.replaces_schedule_id,new.id); original := new.replaces_date;
  end if;
  -- Resource rechecks acquire trip rows by ID too; lock the patient set before multi-row changes.
  if tg_table_name='patients' then
    perform 1 from public.trips where deleted_at is null and patient_id=subject order by id for update;
  elsif tg_op='DELETE' then
    perform 1 from public.trips where deleted_at is null and patient_id=old.patient_id order by id for update;
  else
    perform 1 from public.trips where deleted_at is null and patient_id=new.patient_id order by id for update;
  end if;
  for changed in update public.trips set review_required=true,status=case when assigned_driver_id is null then status else 'at-risk' end,updated_at=now()
    where deleted_at is null and lifecycle='scheduled' and (coalesce(pickup_not_before,treatment_end) at time zone 'Asia/Singapore')::date >= (now() at time zone 'Asia/Singapore')::date
      and (subject is not null or treatment_start>now())
      and (patient_id=subject or (root_schedule_id=root and (original is null or original_session_date=original))) returning id
  loop
    insert into public.trip_history(trip_id,actor_id,event,details)
      values(changed,actor,'requirements_changed',jsonb_build_object('source',tg_table_name,'operation',tg_op));
  end loop;
  return null;
end;
$$;
revoke all on function private.flag_trip_review() from public,anon,authenticated;
drop trigger if exists treatment_trip_review on public.treatment_schedules;
create trigger treatment_trip_review after insert or update or delete on public.treatment_schedules
  for each row execute function private.flag_trip_review();
drop trigger if exists patient_trip_review on public.patients;
create trigger patient_trip_review after update on public.patients for each row execute function private.flag_trip_review();

-- The shared planning horizon is Singapore's current Monday through the fourth Sunday.
create or replace function private.planning_window_end() returns date
language sql stable security invoker set search_path='' as $$
  select least((now() at time zone 'Asia/Singapore')::date-extract(isodow from now() at time zone 'Asia/Singapore')::integer+28,date '9999-12-31');
$$;
revoke all on function private.planning_window_end() from public,anon;
grant execute on function private.planning_window_end() to authenticated;

create or replace function private.save_my_week_availability(target_week date,slots integer[],expected_version integer,expected_template_version integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare owner_id uuid; saved public.driver_week_availability; template_version integer; has_override boolean;
  today date:=(now() at time zone 'Asia/Singapore')::date;
begin
  owner_id:=private.driver_account_id();
  if owner_id is null then raise exception 'Driver access required.' using errcode='42501'; end if;
  perform 1 from public.accounts where id=owner_id and status='active' and role='driver' for update;
  if not found then raise exception 'Driver access required.' using errcode='42501'; end if;
  perform 1 from public.driver_vehicles where driver_id=owner_id and status='approved' for share;
  if not found then raise exception 'An approved vehicle is required.' using errcode='42501'; end if;
  if target_week is null or not isfinite(target_week) or extract(isodow from target_week)<>1
    or target_week<today-extract(isodow from today)::integer+1 or target_week>private.planning_window_end()
    or slots is null or cardinality(slots)>336 or array_position(slots,null) is not null
    or not (0<=all(slots) and 335>=all(slots)) or (select count(distinct x) from unnest(slots) x)<>cardinality(slots)
    or expected_version is null or expected_version<0 or expected_template_version is null or expected_template_version<0 then
    raise exception 'Check the week and availability slots.' using errcode='22023'; end if;
  select a.version into template_version from public.driver_availability a where a.driver_id=owner_id for share;
  template_version:=coalesce(template_version,0);
  select * into saved from public.driver_week_availability where driver_id=owner_id and week_start=target_week for update;
  has_override:=found;
  if (has_override and saved.version<>expected_version) or (not has_override and (expected_version<>0 or template_version<>expected_template_version)) then
    raise exception 'Availability changed. Reload before saving.' using errcode='PT409'; end if;
  -- Serialize with assignments on the same Driver account, including midnight crossings.
  if exists(select 1 from private.driver_booking_windows(owner_id) t cross join lateral generate_series(
      date_trunc('hour',t.window_start at time zone 'Asia/Singapore')+floor(extract(minute from t.window_start at time zone 'Asia/Singapore')/30)*interval '30 minutes',
      (t.window_end-interval '1 microsecond') at time zone 'Asia/Singapore',interval '30 minutes') slot
    where t.window_end>now()
      and slot::date>=target_week and slot::date<target_week+7
      and ((extract(isodow from slot)::integer-1)*48+extract(hour from slot)::integer*2+extract(minute from slot)::integer/30)<>all(slots)) then
    raise exception 'Assigned trip times must remain available until a coordinator unassigns the trip.' using errcode='P0001';
  end if;
  insert into public.driver_week_availability(driver_id,week_start,weekly_slots) values(owner_id,target_week,array(select x from unnest(slots) x order by x))
    on conflict(driver_id,week_start) do update set weekly_slots=excluded.weekly_slots,version=public.driver_week_availability.version+1,updated_at=now() returning * into saved;
  return to_jsonb(saved)||jsonb_build_object('template_version',template_version);
end;
$$;
create or replace function public.save_my_week_availability(target_week date,slots integer[],expected_version integer,expected_template_version integer) returns jsonb
language sql security invoker set search_path='' as $$ select private.save_my_week_availability(target_week,slots,expected_version,expected_template_version); $$;
revoke all on function private.save_my_week_availability(date,integer[],integer,integer),public.save_my_week_availability(date,integer[],integer,integer) from public,anon;
grant execute on function private.save_my_week_availability(date,integer[],integer,integer),public.save_my_week_availability(date,integer[],integer,integer) to authenticated;

create or replace function private.generate_treatment_trips_internal(target uuid,from_date date,until_date date,expected_version integer,actor uuid,restore_deleted boolean,approved_change boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare chosen public.treatment_schedules; person public.patients; old_trip public.trips; saved public.trips;
  session record; leg text; source_root uuid; key text; origin_text text; destination_text text;
  session_start timestamptz; session_end timestamptz; due timestamptz; ready timestamptz;
  inserted integer:=0; refreshed integer:=0; unchanged integer:=0; skipped integer:=0;
begin
  if from_date is null or until_date is null or not isfinite(from_date) or not isfinite(until_date)
    or from_date<(now() at time zone 'Asia/Singapore')::date or until_date>date '9999-12-31'
    or until_date<from_date or until_date-from_date>89 or (not approved_change and until_date>private.planning_window_end()) or expected_version is null or expected_version<1 then
    raise exception 'Choose dates from today through the fourth Sunday and a schedule version.' using errcode='22023';
  end if;
  select * into chosen from public.treatment_schedules where id=target;
  if not found then raise exception 'Treatment schedule not found.' using errcode='P0002'; end if;
  select * into person from public.patients where id=chosen.patient_id for update;
  if not found or person.status<>'active' then raise exception 'An active Patient profile is required.' using errcode='42501'; end if;
  select * into chosen from public.treatment_schedules where id=target for update;
  if not found then raise exception 'Treatment schedule not found.' using errcode='P0002'; end if;
  if chosen.version<>expected_version then raise exception 'Treatment schedule changed. Reload before generating Trips.' using errcode='PT409'; end if;
  if not restore_deleted and not approved_change then
    perform 1 from public.treatment_trip_generation where schedule_id=chosen.id and enabled for update;
    if not found then return jsonb_build_object('created',0,'updated',0,'unchanged',0,'skipped',0,'total',0); end if;
    if not exists(select 1 from public.accounts a where a.id=person.account_id and a.role='patient' and a.status='active') then
      raise exception 'An active Patient account is required.' using errcode='42501';
    end if;
  end if;
  perform 1 from public.trips where patient_id=chosen.patient_id and deleted_at is null order by id for update;
  for session in
    with sources as (
      select s.*,c.name as centre_name,c.address as centre_address,c.postal_code as centre_postal
      from public.treatment_schedules s join public.dialysis_centres c on c.id=s.centre_id
      where s.id=target or (chosen.kind='recurring' and s.replaces_schedule_id=target)
    )
    select s.*,d::date as actual_date,coalesce(s.replaces_date,d::date) as original_date
    from sources s cross join lateral generate_series(greatest(s.effective_from,from_date)::timestamp,least(s.effective_to,until_date)::timestamp,interval '1 day') d
    where extract(isodow from d)::integer=s.days[1]
      and not exists(select 1 from public.treatment_schedules r where r.replaces_schedule_id=s.id and r.replaces_date=d::date)
    order by d,s.id
  loop
    session_start := (session.actual_date+session.start_time) at time zone 'Asia/Singapore';
    session_end := (session.actual_date+session.end_time) at time zone 'Asia/Singapore';
    if ((session_end+interval '15 minutes') at time zone 'Asia/Singapore')::date>date '9999-12-31' then
      raise exception 'The return buffer exceeds the supported date range.' using errcode='22023';
    end if;
    -- Do not manufacture past journeys when generating from today's date.
    if session_start<=now() then continue; end if;
    source_root := coalesce(session.replaces_schedule_id,session.id);
    key := case when session.kind='single' and session.replaces_schedule_id is null then 'single' else session.original_date::text end;
    foreach leg in array array['outbound','return'] loop
      origin_text := concat_ws(', ',person.pickup_address,nullif(person.unit_no,''),case when person.postal_code<>'' then 'Singapore '||person.postal_code end);
      destination_text := concat_ws(', ',session.centre_name,session.centre_address,'Singapore '||session.centre_postal);
      if leg='return' then origin_text := destination_text; destination_text := concat_ws(', ',person.pickup_address,nullif(person.unit_no,''),case when person.postal_code<>'' then 'Singapore '||person.postal_code end); end if;
      due := case when leg='outbound' then session_start-interval '15 minutes' end;
      ready := case when leg='return' then session_end+interval '15 minutes' end;
      select * into old_trip from public.trips where root_schedule_id=source_root and occurrence_key=key and direction=leg for update;
      if approved_change and session.actual_date>private.planning_window_end() and old_trip.id is null then skipped:=skipped+1; continue; end if;
      if found and (old_trip.lifecycle<>'scheduled' or old_trip.first_started_at is not null or old_trip.treatment_start<=now()) then skipped:=skipped+1; continue; end if;
      if found and old_trip.deleted_at is not null and not restore_deleted and not old_trip.schedule_change_cancelled then skipped:=skipped+1; continue; end if;
      if found and old_trip.deleted_at is null and not old_trip.review_required and old_trip.source_version=session.version and old_trip.patient_version=person.version
        and old_trip.source_schedule_id=session.id and old_trip.session_date=session.actual_date and old_trip.origin=origin_text and old_trip.destination=destination_text
        and old_trip.treatment_start=session_start and old_trip.treatment_end=session_end then
        unchanged:=unchanged+1; continue;
      end if;
      if old_trip.id is null then
        insert into public.trips(patient_id,patient_name,source_schedule_id,root_schedule_id,occurrence_key,original_session_date,session_date,direction,origin,destination,
          treatment_start,treatment_end,arrival_by,pickup_not_before,source_version,patient_version,created_by)
        values(person.id,person.full_name,session.id,source_root,key,session.original_date,session.actual_date,leg,origin_text,destination_text,
          session_start,session_end,due,ready,session.version,person.version,actor) returning * into saved;
        inserted:=inserted+1;
      else
        if old_trip.assigned_driver_id is not null and (old_trip.origin<>origin_text or old_trip.destination<>destination_text
          or old_trip.treatment_start<>session_start or old_trip.treatment_end<>session_end) then
          if old_trip.pickup_at<=now() then skipped:=skipped+1; continue; end if;
          insert into public.trip_history(trip_id,actor_id,event,details) values(old_trip.id,actor,'unassigned',jsonb_build_object('driver_id',old_trip.assigned_driver_id,'reason','requirements_changed'));
          update public.trips set assigned_driver_id=null,assigned_vehicle_id=null,assignment=null,pickup_at=null,dropoff_at=null,status='unfilled' where id=old_trip.id;
        end if;
        update public.trips set patient_name=person.full_name,source_schedule_id=session.id,session_date=session.actual_date,
          origin=origin_text,destination=destination_text,treatment_start=session_start,treatment_end=session_end,arrival_by=due,pickup_not_before=ready,
          source_version=session.version,patient_version=person.version,review_required=false,deleted_at=null,schedule_change_cancelled=false,updated_at=now()
          where id=old_trip.id returning * into saved;
        if saved.assigned_driver_id is not null then
          update public.trips set assignment=assignment || jsonb_build_object('patient_phone',person.phone,'mobility',person.mobility,'assistance_required',person.assistance_required),
            status=case when private.driver_fits_trip(saved.assigned_driver_id,saved,saved.pickup_at) then 'on-track' else 'at-risk' end
            where id=saved.id returning * into saved;
        end if;
        refreshed:=refreshed+1;
      end if;
      insert into public.trip_history(trip_id,actor_id,event,details) values(saved.id,actor,
        case when old_trip.id is null then 'generated' when old_trip.deleted_at is not null then 'restored' else 'refreshed' end,
        jsonb_build_object('source_schedule_id',session.id,'source_version',session.version,'session_date',session.actual_date));
    end loop;
  end loop;
  return jsonb_build_object('created',inserted,'updated',refreshed,'unchanged',unchanged,'skipped',skipped,'total',inserted+refreshed+unchanged+skipped);
end;
$$;
revoke all on function private.generate_treatment_trips_internal(uuid,date,date,integer,uuid,boolean,boolean) from public,anon,authenticated;
create or replace function private.generate_treatment_trips_internal(target uuid,from_date date,until_date date,expected_version integer,actor uuid,restore_deleted boolean) returns jsonb
language sql security definer set search_path='' as $$ select private.generate_treatment_trips_internal(target,from_date,until_date,expected_version,actor,restore_deleted,false); $$;
revoke all on function private.generate_treatment_trips_internal(uuid,date,date,integer,uuid,boolean) from public,anon,authenticated;
create or replace function private.generate_treatment_trips(target uuid,from_date date,until_date date,expected_version integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid;
begin
  if not private.is_coordinator() then raise exception 'Coordinator access required.' using errcode='42501'; end if;
  select id into actor from public.accounts where auth_user_id=(select auth.uid());
  return private.generate_treatment_trips_internal(target,from_date,until_date,expected_version,actor,true);
end;
$$;
create or replace function public.generate_treatment_trips(target uuid,from_date date,until_date date,expected_version integer) returns jsonb
language sql security invoker set search_path = '' as $$ select private.generate_treatment_trips(target,from_date,until_date,expected_version); $$;
revoke all on function private.generate_treatment_trips(uuid,date,date,integer),public.generate_treatment_trips(uuid,date,date,integer) from public,anon;
grant execute on function private.generate_treatment_trips(uuid,date,date,integer),public.generate_treatment_trips(uuid,date,date,integer) to authenticated;

-- A deletion hides one journey while retaining history and its unique occurrence
-- key. Re-generating the source must not silently recreate a deleted journey.
create or replace function private.delete_trip(target uuid,expected_version integer) returns uuid
language plpgsql security definer set search_path = '' as $$
declare selected public.trips; actor uuid;
begin
  if not private.is_coordinator() then raise exception 'Coordinator access required.' using errcode='42501'; end if;
  if expected_version is null or expected_version<1 then raise exception 'A trip version is required.' using errcode='22023'; end if;
  select * into selected from public.trips where id=target and deleted_at is null;
  if not found then raise exception 'Trip not found or already deleted.' using errcode='P0002'; end if;
  perform 1 from public.patients where id=selected.patient_id for update;
  select * into selected from public.trips where id=target and deleted_at is null for update;
  if not found then raise exception 'Trip not found or already deleted.' using errcode='P0002'; end if;
  if selected.version<>expected_version then raise exception 'Trip changed. Reload before deleting.' using errcode='PT409'; end if;
  if selected.lifecycle<>'scheduled' or selected.status<>'unfilled' or selected.pickup_at is not null then raise exception 'Only unassigned trips may be deleted.' using errcode='22023'; end if;
  select id into actor from public.accounts where auth_user_id=(select auth.uid());
  update public.trips set deleted_at=now(),schedule_change_cancelled=false,updated_at=now() where id=target;
  insert into public.trip_history(trip_id,actor_id,event,details) values(target,actor,'deleted',
    jsonb_build_object('direction',selected.direction,'session_date',selected.session_date));
  return target;
end;
$$;
create or replace function public.delete_trip(target uuid,expected_version integer) returns uuid
language sql security invoker set search_path = '' as $$ select private.delete_trip(target,expected_version); $$;
revoke all on function private.delete_trip(uuid,integer),public.delete_trip(uuid,integer) from public,anon;
grant execute on function private.delete_trip(uuid,integer),public.delete_trip(uuid,integer) to authenticated;

drop function if exists public.list_trips(integer,date,date,text);
drop function if exists private.list_trips(integer,date,date,text);
drop function if exists public.list_trips(integer,date,date,text,text,text);
drop function if exists private.list_trips(integer,date,date,text,text,text);
-- Coordinator row indicators are calculated from current journeys, not generation history.
create or replace function private.treatment_trip_coverage(target uuid) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare chosen public.treatment_schedules; window_start date; window_end date; result jsonb;
begin
  if not private.is_coordinator() then raise exception 'Coordinator access required.' using errcode='42501'; end if;
  select * into chosen from public.treatment_schedules where id=target;
  if not found or not isfinite(chosen.effective_from) or not isfinite(chosen.effective_to)
    or chosen.effective_from not between date '0001-01-01' and date '9999-12-31'
    or chosen.effective_to not between date '0001-01-01' and date '9999-12-31' then
    return jsonb_build_object('status','unavailable','through',null);
  end if;
  window_start:=(now() at time zone 'Asia/Singapore')::date;
  window_end:=private.planning_window_end();
  with sources as materialized (
    select s.*,p.version as current_patient_version from public.treatment_schedules s
    join public.patients p on p.id=s.patient_id
    where (s.id=target or (chosen.kind='recurring' and s.replaces_schedule_id=target))
      and s.effective_from between date '0001-01-01' and date '9999-12-31'
      and s.effective_to between date '0001-01-01' and date '9999-12-31'
  ), sessions as (
    select s.*,d::date as actual_date,(d::date+s.start_time) at time zone 'Asia/Singapore' as actual_start,
      (d::date+s.end_time) at time zone 'Asia/Singapore' as actual_end,
      coalesce(s.replaces_schedule_id,s.id) as root_id,
      case when s.kind='single' and s.replaces_schedule_id is null then 'single' else coalesce(s.replaces_date,d::date)::text end as occurrence
    from sources s cross join lateral generate_series(greatest(s.effective_from,window_start)::timestamp,
      least(s.effective_to,window_end)::timestamp,interval '1 day') d
    where extract(isodow from d)::integer=s.days[1]
      and (d::date+s.start_time) at time zone 'Asia/Singapore'>now()
      and not exists(select 1 from public.treatment_schedules r where r.replaces_schedule_id=s.id and r.replaces_date=d::date)
  ), coverage as (
    select s.id,s.actual_date,count(t.id) as present_legs,
      count(t.id) filter (where t.lifecycle='cancelled' or (t.source_schedule_id=s.id and t.source_version=s.version
        and t.patient_version=s.current_patient_version and not t.review_required
        and t.session_date=s.actual_date and t.treatment_start=s.actual_start and t.treatment_end=s.actual_end)) as valid_legs
    from sessions s left join public.trips t on t.root_schedule_id=s.root_id and t.occurrence_key=s.occurrence and t.deleted_at is null
    group by s.id,s.actual_date
  ), summary as (
    select count(*) as expected,count(*) filter(where valid_legs=2) as complete,
      coalesce(sum(present_legs),0) as present,min(actual_date) filter(where valid_legs<>2) as first_gap from coverage
  ), dates as (
    select actual_date,bool_and(valid_legs=2) as complete from coverage group by actual_date
  ), blocks as (
    select *,sum(case when complete then 0 else 1 end) over(order by actual_date) as block from dates
  ), generated_ranges as (
    select min(actual_date) as from_date,max(actual_date) as until_date from blocks where complete group by block
  )
  select jsonb_build_object(
    'status',case when x.expected=0 then 'none' when x.complete=x.expected then 'generated' when x.present=0 then 'not_generated' else 'partial' end,
    'through',(select max(actual_date) from coverage where valid_legs=2 and (x.first_gap is null or actual_date<x.first_gap)),
    'generated_ranges',(select coalesce(jsonb_agg(to_jsonb(r) order by from_date),'[]'::jsonb) from generated_ranges r),
    'expected_sessions',x.expected,'generated_sessions',x.complete,'window_start',window_start,'window_end',window_end)
    into result from summary x;
  return result;
end;
$$;
revoke all on function private.treatment_trip_coverage(uuid) from public,anon;
grant execute on function private.treatment_trip_coverage(uuid) to authenticated;

create or replace function private.list_trips(page_no integer,from_date date,until_date date,status_filter text default 'all',search_text text default '',direction_filter text default 'all',sort_by text default 'treatment_start',sort_order text default 'asc') returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare result jsonb;
begin
  if not private.is_coordinator() and private.patient_account_id() is null and private.driver_account_id() is null
    and not exists(select 1 from public.accounts where auth_user_id=(select auth.uid()) and role='caregiver' and status='active') then raise exception 'Trip access denied.' using errcode='42501'; end if;
  if page_no is null or page_no<1 or page_no>1000000 or from_date is null or not isfinite(from_date)
    or from_date<date '0001-01-01' or from_date>date '9999-12-31'
    or (until_date is not null and (not isfinite(until_date) or until_date>date '9999-12-31' or until_date<from_date))
    or status_filter is null or status_filter !~ '^(all|(unfilled|at-risk|on-track|resolved|cancelled|upcoming|in-progress|completed)(,(unfilled|at-risk|on-track|resolved|cancelled|upcoming|in-progress|completed)){0,7})$'
    or direction_filter is null or direction_filter !~ '^(all|(outbound|return)(,(outbound|return)){0,1})$'
    or sort_by is null or sort_by not in ('treatment_start','pickup_time','patient_name','direction','status')
    or sort_order is null or sort_order not in ('asc','desc')
    or search_text is null or length(search_text)>100 or search_text ~ '[[:cntrl:]]' then raise exception 'Invalid trip filters.' using errcode='22023'; end if;
  with windowed as materialized (select t.*,case when t.lifecycle='cancelled' then 'cancelled' else t.status end as list_status from public.trips t where deleted_at is null and session_date>=from_date and (until_date is null or session_date<=until_date)
    and (direction_filter='all' or direction=any(string_to_array(direction_filter,',')))
    and (btrim(search_text)='' or exists(select 1 from unnest(array[
      patient_name,patient_id::text,
      origin,destination,direction,case when lifecycle='cancelled' then 'cancelled' else status end,lifecycle,case when review_required then 'Needs review' else '' end,
      case when pickup_at is null then 'Pickup pending' else '' end,
      session_date::text,to_char(session_date,'FMDD Mon YYYY'),to_char(session_date,'FMDay'),
      to_char(treatment_start at time zone 'Asia/Singapore','HH24:MI'),to_char(treatment_end at time zone 'Asia/Singapore','HH24:MI'),
      to_char(arrival_by at time zone 'Asia/Singapore','HH24:MI'),to_char(pickup_not_before at time zone 'Asia/Singapore','HH24:MI'),
      to_char(arrival_by at time zone 'Asia/Singapore','YYYY-MM-DD'),to_char(pickup_not_before at time zone 'Asia/Singapore','YYYY-MM-DD')
    ]) field where strpos(lower(field),lower(btrim(search_text)))>0))),
    filtered as materialized (select * from windowed where status_filter='all' or list_status=any(string_to_array(status_filter,',')) or (case lifecycle when 'scheduled' then 'upcoming' else lifecycle end)=any(string_to_array(status_filter,','))),
    ordered as (select filtered.*,row_number() over (order by
      case when sort_by='pickup_time' and sort_order='asc' then coalesce(pickup_at,pickup_not_before,arrival_by-make_interval(mins=>duration_minutes),treatment_start) end asc,
      case when sort_by='pickup_time' and sort_order='desc' then coalesce(pickup_at,pickup_not_before,arrival_by-make_interval(mins=>duration_minutes),treatment_start) end desc,
      case when sort_by='treatment_start' and sort_order='asc' then treatment_start end asc,
      case when sort_by='treatment_start' and sort_order='desc' then treatment_start end desc,
      case when sort_order='asc' then case sort_by when 'patient_name' then lower(patient_name) when 'direction' then direction when 'status' then case when private.is_coordinator() then list_status when lifecycle='scheduled' then 'upcoming' else lifecycle end end end asc,
      case when sort_order='desc' then case sort_by when 'patient_name' then lower(patient_name) when 'direction' then direction when 'status' then case when private.is_coordinator() then list_status when lifecycle='scheduled' then 'upcoming' else lifecycle end end end desc,
      session_date,treatment_start,case direction when 'outbound' then 0 else 1 end,id) as list_order from filtered),
    page as (select * from ordered order by list_order limit 10 offset ((page_no::bigint-1)*10))
  select jsonb_build_object('trips',(select coalesce(jsonb_agg(to_jsonb(p)-'list_order'-'list_status' order by list_order),'[]'::jsonb) from page p),
    'total',(select count(*) from filtered),'page',page_no,'pageSize',10,
    'counts',jsonb_build_object('upcoming',(select count(*) from windowed where lifecycle='scheduled'),'in-progress',(select count(*) from windowed where lifecycle='in-progress'),'completed',(select count(*) from windowed where lifecycle='completed'),'unfilled',(select count(*) from windowed where status='unfilled'),'at-risk',(select count(*) from windowed where status='at-risk'),'on-track',(select count(*) from windowed where status='on-track'),'resolved',(select count(*) from windowed where list_status='resolved'),'cancelled',(select count(*) from windowed where list_status='cancelled')),
    'active_trip',(select to_jsonb(t) from public.trips t where deleted_at is null and lifecycle='in-progress' order by started_at,id limit 1),
    'next_trip',(select to_jsonb(t) from public.trips t where deleted_at is null and lifecycle='scheduled' and (
      (private.driver_account_id() is not null and pickup_at>private.trip_now(t)) or
      (private.driver_account_id() is null and ((direction='outbound' and treatment_start>private.trip_now(t)) or
      (direction='return' and (pickup_not_before at time zone 'Asia/Singapore')::date >= (private.trip_now(t) at time zone 'Asia/Singapore')::date))))
      order by case when private.driver_account_id() is not null then pickup_at end,session_date,coalesce(pickup_at,pickup_not_before,arrival_by),id limit 1)) into result;
  return result;
end;
$$;
create or replace function public.list_trips(page_no integer,from_date date,until_date date,status_filter text default 'all',search_text text default '',direction_filter text default 'all',sort_by text default 'treatment_start',sort_order text default 'asc') returns jsonb
language sql stable security invoker set search_path = '' as $$ select private.list_trips(page_no,from_date,until_date,status_filter,search_text,direction_filter,sort_by,sort_order); $$;
revoke all on function private.list_trips(integer,date,date,text,text,text,text,text),public.list_trips(integer,date,date,text,text,text,text,text) from public,anon;
grant execute on function private.list_trips(integer,date,date,text,text,text,text,text),public.list_trips(integer,date,date,text,text,text,text,text) to authenticated;

-- Enable fills immediately; turning off never removes existing journeys.
create or replace function private.set_treatment_auto_generation(target uuid,enabled boolean,expected_version integer,expected_setting_version integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare chosen public.treatment_schedules; person public.patients; setting public.treatment_trip_generation;
  actor uuid; today date:=(now() at time zone 'Asia/Singapore')::date;
begin
  if not private.is_coordinator() then raise exception 'Coordinator access required.' using errcode='42501'; end if;
  if enabled is null or expected_version is null or expected_version<1 or expected_setting_version is null or expected_setting_version<0 then
    raise exception 'A boolean setting and valid versions are required.' using errcode='22023';
  end if;
  select * into chosen from public.treatment_schedules where id=target;
  if not found then raise exception 'Treatment schedule not found.' using errcode='P0002'; end if;
  select * into person from public.patients where id=chosen.patient_id for update;
  select * into chosen from public.treatment_schedules where id=target for update;
  if not found then raise exception 'Treatment schedule not found.' using errcode='P0002'; end if;
  if chosen.version<>expected_version then raise exception 'Schedule changed.' using errcode='PT409'; end if;
  if chosen.replaces_schedule_id is not null then raise exception 'Manage automatic generation on the original recurring schedule.' using errcode='22023'; end if;
  select * into setting from public.treatment_trip_generation where schedule_id=target for update;
  if coalesce(setting.version,0)<>expected_setting_version then raise exception 'Generation setting changed.' using errcode='PT409'; end if;
  select id into actor from public.accounts where auth_user_id=(select auth.uid());
  insert into public.treatment_trip_generation(schedule_id,enabled,enabled_by)
    values(target,enabled,actor)
    on conflict(schedule_id) do update set enabled=excluded.enabled,enabled_by=excluded.enabled_by,
      version=public.treatment_trip_generation.version+1,updated_at=now(),last_error=null;
  if enabled then
    perform private.generate_treatment_trips_internal(target,today,private.planning_window_end(),chosen.version,actor,false);
    update public.treatment_trip_generation set last_run_at=now(),last_error=null where schedule_id=target;
  end if;
  return (select jsonb_build_object('enabled',g.enabled,'version',g.version,'last_run_at',g.last_run_at,'last_error',g.last_error)
    from public.treatment_trip_generation g where g.schedule_id=target);
end;
$$;
create or replace function public.set_treatment_auto_generation(target uuid,enabled boolean,expected_version integer,expected_setting_version integer) returns jsonb
language sql security invoker set search_path='' as $$ select private.set_treatment_auto_generation(target,enabled,expected_version,expected_setting_version); $$;
revoke all on function private.set_treatment_auto_generation(uuid,boolean,integer,integer),public.set_treatment_auto_generation(uuid,boolean,integer,integer) from public,anon;
grant execute on function private.set_treatment_auto_generation(uuid,boolean,integer,integer),public.set_treatment_auto_generation(uuid,boolean,integer,integer) to authenticated;

-- Database-owner job only: no browser token, service key or HTTP endpoint is involved.
create or replace function private.run_automatic_trip_generation() returns jsonb
language plpgsql security definer set search_path='' as $$
declare item record; today date:=(now() at time zone 'Asia/Singapore')::date;
  processed integer:=0; failed integer:=0; patient_ids uuid[];
begin
  -- The batch retains locks across patients. Acquire every participating Patient first,
  -- then their Trips in global ID order, matching driver-resource rechecks.
  select coalesce(array_agg(distinct s.patient_id),'{}'::uuid[]) into patient_ids
    from public.treatment_trip_generation g join public.treatment_schedules s on s.id=g.schedule_id where g.enabled;
  perform 1 from public.patients where id=any(patient_ids) order by id for update;
  perform 1 from public.trips where patient_id=any(patient_ids) and deleted_at is null order by id for update;
  for item in select s.id,s.version,p.id as patient_id,g.enabled_by from public.treatment_trip_generation g
    join public.treatment_schedules s on s.id=g.schedule_id
    join public.patients p on p.id=s.patient_id
    join public.accounts a on a.id=p.account_id
    where g.enabled and p.id=any(patient_ids) and p.status='active' and a.role='patient' and a.status='active'
      and exists(select 1 from public.treatment_schedules upcoming
        where (upcoming.id=s.id or upcoming.replaces_schedule_id=s.id)
          and upcoming.effective_to>=today and upcoming.effective_from<=private.planning_window_end())
    order by p.id,s.id
  loop
    begin
      perform private.generate_treatment_trips_internal(item.id,today,private.planning_window_end(),item.version,item.enabled_by,false);
      update public.treatment_trip_generation set last_run_at=now(),last_error=null where schedule_id=item.id and enabled;
      processed:=processed+1;
    exception when others then
      -- The failed subtransaction released its locks; reacquire Patient before Setting.
      perform 1 from public.patients where id=item.patient_id for update;
      -- Isolate a bad schedule so the remaining patients are still processed.
      update public.treatment_trip_generation set last_error='Automatic generation failed ('||sqlstate||').' where schedule_id=item.id and enabled;
      failed:=failed+1;
    end;
  end loop;
  return jsonb_build_object('processed',processed,'failed',failed);
end;
$$;
revoke all on function private.run_automatic_trip_generation() from public,anon,authenticated;

-- Enable Supabase Cron in Integrations, then reapply this schema to register the job.
-- A stable job name makes reapplication idempotent. 16:05 UTC = 00:05 Singapore.
do $$
begin
  if exists(select 1 from pg_extension where extname='pg_cron') then
    perform cron.schedule('dialysis-automatic-trips','5 16 * * *','select private.run_automatic_trip_generation();');
  else
    raise notice 'Enable pg_cron and reapply schema.sql to activate the daily trip refill.';
  end if;
end;
$$;

-- Validate stored proposals at the database boundary as well as in the HTTP service.
create or replace function private.validate_treatment_proposal(chosen public.treatment_schedules,operation text,proposal jsonb,original_day date) returns jsonb
language plpgsql security definer set search_path='' as $$
declare candidate public.treatment_schedules;
begin
  if operation is null or operation not in ('update','reschedule','delete') or proposal is null or jsonb_typeof(proposal)<>'object' then
    raise exception 'Invalid schedule change.' using errcode='22023';
  end if;
  if operation='delete' then
    if proposal<>'{}'::jsonb or original_day is not null then raise exception 'Deletion has no replacement details.' using errcode='22023'; end if;
    return proposal;
  end if;
  if proposal-array['kind','centre_id','days','start_time','end_time','effective_from','effective_to']<>'{}'::jsonb
    or not (proposal ?& array['kind','centre_id','days','start_time','end_time','effective_from','effective_to']) then
    raise exception 'Complete treatment details are required.' using errcode='22023';
  end if;
  candidate:=jsonb_populate_record(chosen,proposal);
  if num_nulls(candidate.kind,candidate.centre_id,candidate.days,candidate.start_time,candidate.end_time,candidate.effective_from,candidate.effective_to)>0
    or candidate.kind not in ('recurring','single') or cardinality(candidate.days)<>1 or candidate.days[1] is null or candidate.days[1] not between 1 and 7
    or candidate.start_time>=candidate.end_time or candidate.start_time>=time '24:00' or candidate.end_time>=time '24:00' or not isfinite(candidate.effective_from) or not isfinite(candidate.effective_to)
    or candidate.effective_from<date '0001-01-01' or candidate.effective_to>date '9999-12-31' or candidate.effective_to<candidate.effective_from
    or candidate.effective_from+((candidate.days[1]-extract(isodow from candidate.effective_from)::integer+7)%7)>candidate.effective_to
    or (candidate.kind='single' and candidate.effective_from<>candidate.effective_to)
    or (candidate.kind='single' and (candidate.effective_from+candidate.start_time) at time zone 'Asia/Singapore'<=now())
    or not exists(select 1 from public.dialysis_centres where id=candidate.centre_id) then
    raise exception 'Check the centre, days, dates and treatment times.' using errcode='22023';
  end if;
  if operation='update' then
    if chosen.kind='single' and (chosen.effective_from+chosen.start_time) at time zone 'Asia/Singapore'<=now() then
      raise exception 'A session that has already started cannot be moved.' using errcode='22023';
    end if;
    if original_day is not null or candidate.kind<>chosen.kind then raise exception 'Schedule type cannot be changed.' using errcode='22023'; end if;
    if row(candidate.centre_id,candidate.days,candidate.start_time,candidate.end_time,candidate.effective_from,candidate.effective_to)
      is not distinct from row(chosen.centre_id,chosen.days,chosen.start_time,chosen.end_time,chosen.effective_from,chosen.effective_to) then
      raise exception 'Change at least one treatment detail.' using errcode='22023';
    end if;
  else
    if chosen.kind<>'recurring' or chosen.replaces_schedule_id is not null or candidate.kind<>'single' or original_day is null
      or not isfinite(original_day) or original_day<chosen.effective_from or original_day>chosen.effective_to
      or original_day<(now() at time zone 'Asia/Singapore')::date or extract(isodow from original_day)::integer<>chosen.days[1]
      or (original_day+chosen.start_time) at time zone 'Asia/Singapore'<=now()
      or candidate.effective_from<(now() at time zone 'Asia/Singapore')::date
      or exists(select 1 from public.treatment_schedules where replaces_schedule_id=chosen.id and replaces_date=original_day) then
      raise exception 'Choose an upcoming occurrence that has not been rescheduled.' using errcode='22023';
    end if;
  end if;
  return jsonb_build_object('kind',candidate.kind,'centre_id',candidate.centre_id,'days',candidate.days,
    'start_time',candidate.start_time,'end_time',candidate.end_time,'effective_from',candidate.effective_from,'effective_to',candidate.effective_to);
end;
$$;
revoke all on function private.validate_treatment_proposal(public.treatment_schedules,text,jsonb,date) from public,anon,authenticated;

create or replace function private.request_treatment_change(target uuid,operation text,proposal jsonb,original_day date,reason text,expected_version integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare chosen public.treatment_schedules; root public.treatment_schedules; actor uuid; saved public.treatment_change_requests;
begin
  select * into chosen from public.treatment_schedules where id=target;
  if not found or not private.can_manage_patient_transport(chosen.patient_id) then raise exception 'Treatment access denied.' using errcode='42501'; end if;
  perform 1 from public.patients where id=chosen.patient_id for update;
  select * into root from public.treatment_schedules where id=coalesce(chosen.replaces_schedule_id,chosen.id) for update;
  select * into chosen from public.treatment_schedules where id=target for update;
  if not found then raise exception 'Treatment schedule not found.' using errcode='P0002'; end if;
  if not private.can_manage_patient_transport(chosen.patient_id) then raise exception 'Treatment access denied.' using errcode='42501'; end if;
  if expected_version is null or expected_version<>chosen.version then raise exception 'Treatment schedule changed.' using errcode='PT409'; end if;
  if reason is null or length(btrim(reason)) not between 1 and 1000 then raise exception 'A reason is required.' using errcode='22023'; end if;
  if exists(select 1 from public.treatment_change_requests where root_schedule_id=root.id and status='pending') then
    raise exception 'A change request for this series is already pending.' using errcode='PT409';
  end if;
  proposal:=private.validate_treatment_proposal(chosen,operation,proposal,original_day);
  select id into actor from public.accounts where auth_user_id=(select auth.uid());
  insert into public.treatment_change_requests(schedule_id,root_schedule_id,patient_id,requested_by,action,proposal,original_date,before_snapshot,schedule_version,root_version,reason)
    values(chosen.id,root.id,chosen.patient_id,actor,operation,proposal,original_day,to_jsonb(chosen),chosen.version,root.version,btrim(reason)) returning * into saved;
  return to_jsonb(saved);
end;
$$;
create or replace function public.request_treatment_change(target uuid,operation text,proposal jsonb,original_day date,reason text,expected_version integer) returns jsonb
language sql security invoker set search_path='' as $$ select private.request_treatment_change(target,operation,proposal,original_day,reason,expected_version); $$;
revoke all on function private.request_treatment_change(uuid,text,jsonb,date,text,integer),public.request_treatment_change(uuid,text,jsonb,date,text,integer) from public,anon;
grant execute on function private.request_treatment_change(uuid,text,jsonb,date,text,integer),public.request_treatment_change(uuid,text,jsonb,date,text,integer) to authenticated;

create or replace function public.get_treatment_change_request(target uuid) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare chosen public.treatment_schedules;
begin
  select * into chosen from public.treatment_schedules where id=target;
  if not found then raise exception 'Treatment schedule not found.' using errcode='P0002'; end if;
  return jsonb_build_object('schedule',to_jsonb(chosen),'request',private.treatment_change_summary(target));
end;
$$;
revoke all on function public.get_treatment_change_request(uuid) from public,anon;
grant execute on function public.get_treatment_change_request(uuid) to authenticated;

create or replace function private.withdraw_treatment_change(target uuid,expected_version integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare saved public.treatment_change_requests;
begin
  select * into saved from public.treatment_change_requests where id=target;
  if not found or not private.can_manage_patient_transport(saved.patient_id) then raise exception 'Treatment access denied.' using errcode='42501'; end if;
  perform 1 from public.patients where id=saved.patient_id for update;
  perform 1 from public.treatment_schedules where id=saved.root_schedule_id for update;
  select * into saved from public.treatment_change_requests where id=target for update;
  if not private.can_manage_patient_transport(saved.patient_id) then raise exception 'Treatment access denied.' using errcode='42501'; end if;
  if expected_version is null or saved.version<>expected_version or saved.status<>'pending' then raise exception 'Request changed.' using errcode='PT409'; end if;
  update public.treatment_change_requests set status='withdrawn',version=version+1 where id=target returning * into saved;
  return to_jsonb(saved);
end;
$$;
create or replace function public.withdraw_treatment_change(target uuid,expected_version integer) returns jsonb
language sql security invoker set search_path='' as $$ select private.withdraw_treatment_change(target,expected_version); $$;
revoke all on function private.withdraw_treatment_change(uuid,integer),public.withdraw_treatment_change(uuid,integer) from public,anon;
grant execute on function private.withdraw_treatment_change(uuid,integer),public.withdraw_treatment_change(uuid,integer) to authenticated;

-- Recompute the exact affected assignment set at review time; callers acknowledge its version token.
create or replace function private.treatment_assignment_impact(target uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare request public.treatment_change_requests; chosen public.treatment_schedules; result jsonb;
begin
  if not private.is_coordinator() then raise exception 'Coordinator access required.' using errcode='42501'; end if;
  select * into request from public.treatment_change_requests where id=target;
  if not found then raise exception 'Change request not found.' using errcode='P0002'; end if;
  select * into chosen from public.treatment_schedules where id=request.schedule_id;
  with affected as (select t.* from public.trips t where t.root_schedule_id=request.root_schedule_id and t.assigned_driver_id is not null
    and t.deleted_at is null and t.lifecycle='scheduled' and t.treatment_start>now() and (
      (request.action='delete' and (chosen.replaces_schedule_id is null or t.source_schedule_id=chosen.id))
      or (request.action='reschedule' and t.original_session_date=request.original_date)
      or (request.action='update' and t.source_schedule_id=chosen.id and (
        (request.proposal->>'centre_id')::uuid<>chosen.centre_id
        or (request.proposal->>'start_time')::time<>chosen.start_time or (request.proposal->>'end_time')::time<>chosen.end_time
        or (chosen.kind='single' and (request.proposal->>'effective_from')::date<>chosen.effective_from)
        or (chosen.kind='recurring' and (t.original_session_date not between (request.proposal->>'effective_from')::date and (request.proposal->>'effective_to')::date
          or extract(isodow from t.original_session_date)::integer<>(request.proposal->'days'->>0)::integer))))))
  select jsonb_build_object('token',md5(coalesce(string_agg(id::text||':'||version::text,',' order by id),'')),
    'trips',coalesce(jsonb_agg(jsonb_build_object('id',id,'version',version,'direction',direction,'pickup_at',pickup_at,
      'driver_name',assignment->>'driver_name') order by pickup_at,id),'[]'::jsonb)) into result from affected;
  return result;
end;
$$;
create or replace function public.treatment_assignment_impact(target uuid) returns jsonb
language sql stable security invoker set search_path='' as $$ select private.treatment_assignment_impact(target); $$;
revoke all on function private.treatment_assignment_impact(uuid),public.treatment_assignment_impact(uuid) from public,anon;
grant execute on function private.treatment_assignment_impact(uuid),public.treatment_assignment_impact(uuid) to authenticated;

-- Approval and all trip reconciliation occur in one transaction under Patient -> Schedule -> Request locks.
create or replace function private.review_treatment_change(target uuid,decision text,note text,expected_version integer,assignment_token text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare request public.treatment_change_requests; chosen public.treatment_schedules; root public.treatment_schedules;
  candidate public.treatment_schedules; actor uuid; affected uuid; impact jsonb; assigned public.trips; window_from date; window_until date; cursor_day date;
  today date:=(now() at time zone 'Asia/Singapore')::date;
begin
  if not private.is_coordinator() then raise exception 'Coordinator access required.' using errcode='42501'; end if;
  if decision is null or decision not in ('approved','rejected') or note is null or length(note)>1000 or (decision='rejected' and btrim(note)='') then
    raise exception 'Choose a decision and give a reason for rejection.' using errcode='22023';
  end if;
  select * into request from public.treatment_change_requests where id=target;
  if not found then raise exception 'Change request not found.' using errcode='P0002'; end if;
  perform 1 from public.patients where id=request.patient_id for update;
  perform 1 from public.trips where patient_id=request.patient_id and deleted_at is null order by id for update;
  select * into root from public.treatment_schedules where id=request.root_schedule_id for update;
  select * into chosen from public.treatment_schedules where id=request.schedule_id for update;
  select * into request from public.treatment_change_requests where id=target for update;
  if expected_version is null or request.version<>expected_version or request.status<>'pending' then raise exception 'Request changed.' using errcode='PT409'; end if;
  select id into actor from public.accounts where auth_user_id=(select auth.uid());
  if decision='approved' then
    if chosen.id is null or root.id is null or chosen.version<>request.schedule_version or root.version<>request.root_version then
      raise exception 'The treatment changed since this request. Reject it and ask for a new request.' using errcode='PT409';
    end if;
    if not exists(select 1 from public.patients p join public.accounts a on a.id=p.account_id
      where p.id=request.patient_id and p.status='active' and a.role='patient' and a.status='active') then
      raise exception 'An active patient is required.' using errcode='42501';
    end if;
    impact:=private.treatment_assignment_impact(request.id);
    if jsonb_array_length(impact->'trips')>0 then
      if assignment_token is distinct from impact->>'token' then raise exception 'Affected assignments changed. Reload and confirm their release.' using errcode='PT409'; end if;
      for assigned in select * from public.trips where id in (select (item->>'id')::uuid from jsonb_array_elements(impact->'trips') item) for update loop
        if assigned.version<>(select (item->>'version')::integer from jsonb_array_elements(impact->'trips') item where (item->>'id')::uuid=assigned.id) then raise exception 'Affected assignments changed. Reload before approving.' using errcode='PT409'; end if;
        if assigned.pickup_at<=now() then raise exception 'A journey that has started cannot be changed.' using errcode='22023'; end if;
        insert into public.trip_history(trip_id,actor_id,event,details) values(assigned.id,actor,'unassigned',jsonb_build_object('driver_id',assigned.assigned_driver_id,'reason','schedule_change','request_id',request.id));
        update public.trips set assigned_driver_id=null,assigned_vehicle_id=null,assignment=null,pickup_at=null,dropoff_at=null,status='unfilled',updated_at=now() where id=assigned.id;
      end loop;
    end if;
    request.proposal:=private.validate_treatment_proposal(chosen,request.action,request.proposal,request.original_date);
    select min(session_date),max(session_date) into window_from,window_until from public.trips where root_schedule_id=root.id and (deleted_at is null or schedule_change_cancelled) and treatment_start>now();
    if request.action='delete' then
      perform private.delete_my_treatment(chosen.id,chosen.version);
    elsif request.action='update' then
      perform private.update_my_treatment(chosen.id,request.proposal,chosen.version);
      candidate:=jsonb_populate_record(chosen,request.proposal);
    else
      candidate:=jsonb_populate_record(chosen,request.proposal);
      insert into public.treatment_schedules(patient_id,centre_id,kind,days,start_time,end_time,effective_from,effective_to,replaces_schedule_id,replaces_date)
        values(chosen.patient_id,candidate.centre_id,'single',candidate.days,candidate.start_time,candidate.end_time,candidate.effective_from,candidate.effective_to,chosen.id,request.original_date);
    end if;
    -- A logical occurrence that still exists is refreshed in place, retaining journey identity.
    for affected in update public.trips t set deleted_at=now(),schedule_change_cancelled=true,updated_at=now() where t.root_schedule_id=request.root_schedule_id
      and t.deleted_at is null and t.lifecycle='scheduled' and t.treatment_start>now() and not exists (
        select 1 from public.treatment_schedules s where coalesce(s.replaces_schedule_id,s.id)=t.root_schedule_id and (
          (s.replaces_schedule_id is not null and s.replaces_date=t.original_session_date and (s.effective_from+s.start_time) at time zone 'Asia/Singapore'>now())
          or (s.replaces_schedule_id is null and s.kind='single' and t.occurrence_key='single' and (s.effective_from+s.start_time) at time zone 'Asia/Singapore'>now())
          or (s.replaces_schedule_id is null and s.kind='recurring' and t.original_session_date between s.effective_from and s.effective_to
            and extract(isodow from t.original_session_date)::integer=s.days[1] and (t.original_session_date+s.start_time) at time zone 'Asia/Singapore'>now()
            and not exists(select 1 from public.treatment_schedules r where r.replaces_schedule_id=s.id and r.replaces_date=t.original_session_date)))) returning id
    loop
      insert into public.trip_history(trip_id,actor_id,event,details) values(affected,actor,'schedule_change_approved',jsonb_build_object('request_id',request.id,'operation','removed'));
    end loop;
    select * into root from public.treatment_schedules where id=request.root_schedule_id;
    if root.id is not null then
      if window_from is not null then
        if request.action='delete' and chosen.replaces_date is not null then
          window_from:=least(window_from,chosen.replaces_date); window_until:=greatest(window_until,chosen.replaces_date);
        elsif candidate.kind='single' then
          window_from:=least(window_from,candidate.effective_from);
          window_until:=greatest(window_until,candidate.effective_to);
        elsif candidate.kind='recurring' and candidate.days<>chosen.days then
          window_until:=least(window_until+6,date '9999-12-31');
        end if;
        cursor_day:=greatest(window_from,today);
        while cursor_day<=window_until loop
          perform private.generate_treatment_trips_internal(root.id,cursor_day,least(cursor_day+89,window_until),root.version,actor,false,true);
          exit when cursor_day>=date '9999-12-31'-89;
          cursor_day:=cursor_day+90;
        end loop;
      end if;
      if exists(select 1 from public.treatment_trip_generation where schedule_id=root.id and enabled) then
        perform private.generate_treatment_trips_internal(root.id,today,private.planning_window_end(),root.version,actor,false,true);
      end if;
    end if;
  end if;
  update public.treatment_change_requests set status=decision,review_note=btrim(note),reviewed_by=actor,reviewed_at=now(),version=version+1
    where id=target returning * into request;
  return to_jsonb(request);
end;
$$;
create or replace function public.review_treatment_change(target uuid,decision text,note text,expected_version integer,assignment_token text) returns jsonb
language sql security invoker set search_path='' as $$ select private.review_treatment_change(target,decision,note,expected_version,assignment_token); $$;
revoke all on function private.review_treatment_change(uuid,text,text,integer,text),public.review_treatment_change(uuid,text,text,integer,text) from public,anon;
grant execute on function private.review_treatment_change(uuid,text,text,integer,text),public.review_treatment_change(uuid,text,text,integer,text) to authenticated;

-- Compatibility entry point still refuses to release assignments without acknowledgement.
create or replace function private.review_treatment_change(target uuid,decision text,note text,expected_version integer) returns jsonb
language sql security definer set search_path='' as $$ select private.review_treatment_change(target,decision,note,expected_version,null); $$;
create or replace function public.review_treatment_change(target uuid,decision text,note text,expected_version integer) returns jsonb
language sql security invoker set search_path='' as $$ select private.review_treatment_change(target,decision,note,expected_version); $$;
revoke all on function private.review_treatment_change(uuid,text,text,integer),public.review_treatment_change(uuid,text,text,integer) from public,anon;
grant execute on function private.review_treatment_change(uuid,text,text,integer),public.review_treatment_change(uuid,text,text,integer) to authenticated;

-- Coordinators inspect any driver; active drivers inspect only themselves. Per-week slots override the default template.
-- Progress is explicit. One driver and one patient cannot be on two active journeys.
create unique index if not exists trips_one_active_driver on public.trips(assigned_driver_id) where lifecycle='in-progress' and deleted_at is null;
create unique index if not exists trips_one_active_patient on public.trips(patient_id) where lifecycle='in-progress' and deleted_at is null;
create unique index if not exists trips_one_underway_patient on public.trips(patient_id) where first_started_at is not null and lifecycle in ('scheduled','in-progress') and deleted_at is null;

create table if not exists public.trip_locations (
  trip_id uuid primary key references public.trips(id) on delete restrict,
  driver_id uuid not null references public.accounts(id) on delete restrict,
  sharing_id uuid not null default gen_random_uuid(),
  latitude double precision check(latitude between -90 and 90), longitude double precision check(longitude between -180 and 180),
  accuracy_metres double precision check(accuracy_metres between 0 and 10000), recorded_at timestamptz, received_at timestamptz,
  check ((latitude is null and longitude is null and accuracy_metres is null and recorded_at is null and received_at is null)
    or (latitude is not null and longitude is not null and accuracy_metres is not null and recorded_at is not null and received_at is not null))
);
alter table public.trip_locations enable row level security;
revoke all on public.trip_locations from public,anon,authenticated;
grant select(trip_id,latitude,longitude,accuracy_metres,recorded_at,received_at) on public.trip_locations to authenticated;
create or replace function private.can_view_trip(target uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.trips t where t.id=target and t.deleted_at is null and
    (private.is_coordinator() or private.can_manage_patient_transport(t.patient_id) or t.assigned_driver_id=private.driver_account_id()
      or (t.lifecycle='cancelled' and t.cancelled_driver_id=private.driver_account_id())));
$$;
create or replace function private.can_track_trip(target uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select private.can_view_trip(target) and exists(select 1 from public.trips t join public.accounts a on a.id=t.assigned_driver_id
    where t.id=target and t.lifecycle='in-progress' and t.deleted_at is null and a.role='driver' and a.status='active');
$$;
revoke all on function private.can_view_trip(uuid),private.can_track_trip(uuid) from public,anon;
grant execute on function private.can_view_trip(uuid),private.can_track_trip(uuid) to authenticated;
drop policy if exists trip_locations_read on public.trip_locations;
create policy trip_locations_read on public.trip_locations for select to authenticated using(private.can_track_trip(trip_id));

create or replace function private.clear_inactive_trip_location() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if tg_table_name='accounts' then
    if new.status<>'active' or new.role<>'driver' then delete from public.trip_locations where driver_id=new.id; end if;
  elsif new.lifecycle<>'in-progress' or new.assigned_driver_id is distinct from old.assigned_driver_id or new.deleted_at is not null then
    delete from public.trip_locations where trip_id=new.id;
  end if;
  return null;
end;
$$;
revoke all on function private.clear_inactive_trip_location() from public,anon,authenticated;
drop trigger if exists trip_location_cleanup on public.trips;
create trigger trip_location_cleanup after update on public.trips for each row execute function private.clear_inactive_trip_location();
drop trigger if exists driver_location_cleanup on public.accounts;
create trigger driver_location_cleanup after update on public.accounts for each row execute function private.clear_inactive_trip_location();

create or replace function private.execute_trip(target uuid,action text,expected_version integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare chosen public.trips; actor uuid:=private.driver_account_id(); next_trip public.trips; next_status text;
begin
  if actor is null then raise exception 'Driver access required.' using errcode='42501'; end if;
  if action is null or action not in ('start','complete') or expected_version is null or expected_version<1 then raise exception 'Invalid execution action.' using errcode='22023'; end if;
  select * into chosen from public.trips where id=target and assigned_driver_id=actor and deleted_at is null;
  if not found then raise exception 'Trip access denied.' using errcode='42501'; end if;
  perform 1 from public.patients where id=chosen.patient_id for update;
  perform 1 from public.accounts where id=actor and role='driver' and status='active' for update;
  if not found then raise exception 'Driver access required.' using errcode='42501'; end if;
  select * into chosen from public.trips where id=target and assigned_driver_id=actor and deleted_at is null for update;
  if not found then raise exception 'Trip access denied.' using errcode='42501'; end if;
  if chosen.version<>expected_version then raise exception 'Trip changed. Reload before trying again.' using errcode='PT409'; end if;
  if action='start' then
    if chosen.lifecycle='in-progress' then return to_jsonb(chosen); end if;
    if chosen.lifecycle<>'scheduled' then raise exception 'Only a scheduled journey can start.' using errcode='22023'; end if;
    if chosen.pickup_at>private.trip_now(chosen) then raise exception 'The assigned pickup time has not arrived.' using errcode='22023'; end if;
    if chosen.review_required or chosen.driver_unavailable_at is not null then raise exception 'The coordinator must resolve this assignment first.' using errcode='22023'; end if;
    if not exists(select 1 from public.driver_vehicles v join public.patients p on p.id=chosen.patient_id join public.accounts a on a.id=p.account_id
      where v.id=chosen.assigned_vehicle_id and v.driver_id=actor and v.status='approved' and p.status='active' and a.status='active' and a.role='patient'
        and (p.mobility<>'wheelchair' or v.wheelchair_accessible) and v.passenger_capacity>=1) then
      raise exception 'Current driver, vehicle and patient eligibility is required.' using errcode='22023';
    end if;
    if exists(select 1 from public.trips where id<>target and deleted_at is null and
      ((lifecycle='in-progress' and assigned_driver_id=actor) or (patient_id=chosen.patient_id and (lifecycle='in-progress' or (lifecycle='scheduled' and first_started_at is not null))))) then
      raise exception 'A driver or patient already has an active trip.' using errcode='PT409';
    end if;
    update public.trips set lifecycle='in-progress',started_at=private.trip_now(chosen),status=case when (direction='outbound' and private.trip_now(chosen)+make_interval(mins=>duration_minutes)>arrival_by) or not private.driver_covers_window(actor,private.trip_now(chosen),private.trip_now(chosen)+make_interval(mins=>duration_minutes)) then 'at-risk' else status end,updated_at=now()
      where id=target returning * into chosen;
  else
    if chosen.lifecycle='completed' then return to_jsonb(chosen); end if;
    if chosen.lifecycle<>'in-progress' then raise exception 'Only an active journey can be completed.' using errcode='22023'; end if;
    update public.trips set lifecycle='completed',completed_at=private.trip_now(chosen),status='resolved',driver_unavailable_at=null,updated_at=now() where id=target returning * into chosen;
  end if;
  insert into public.trip_history(trip_id,actor_id,event,details) values(target,actor,case when action='start' then 'started' else 'completed' end,
    jsonb_build_object('driver_id',actor,'started_at',chosen.started_at,'completed_at',chosen.completed_at));
  for next_trip in select * from public.trips where assigned_driver_id=actor and lifecycle='scheduled' and deleted_at is null order by id for update loop
    next_status:=case when private.driver_fits_trip(actor,next_trip,next_trip.pickup_at) then 'on-track' else 'at-risk' end;
    if next_status<>next_trip.status then
      update public.trips set status=next_status,updated_at=now() where id=next_trip.id;
      insert into public.trip_history(trip_id,actor_id,event,details) values(next_trip.id,actor,'requirements_changed',jsonb_build_object('source','trip_progress','status',next_status,'driver_id',actor));
    end if;
  end loop;
  return to_jsonb(chosen);
end;
$$;
create or replace function public.execute_trip(target uuid,action text,expected_version integer) returns jsonb
language sql security invoker set search_path='' as $$ select private.execute_trip(target,action,expected_version); $$;
revoke all on function private.execute_trip(uuid,text,integer),public.execute_trip(uuid,text,integer) from public,anon;
grant execute on function private.execute_trip(uuid,text,integer),public.execute_trip(uuid,text,integer) to authenticated;

-- Each explicit sharing session gets a new nonce; late reports from stopped sessions cannot restore a marker.
create or replace function private.begin_trip_sharing(target uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.driver_account_id(); saved uuid;
begin
  if actor is null then raise exception 'Driver access required.' using errcode='42501'; end if;
  perform 1 from public.accounts where id=actor and status='active' and role='driver' for share;
  if not found then raise exception 'Driver access required.' using errcode='42501'; end if;
  perform 1 from public.trips where id=target and assigned_driver_id=actor and lifecycle='in-progress' and deleted_at is null and demo_owner_id is null for share;
  if not found then raise exception 'Only an active assigned trip may share location.' using errcode='42501'; end if;
  insert into public.trip_locations(trip_id,driver_id) values(target,actor) on conflict(trip_id) do update set
    driver_id=actor,sharing_id=gen_random_uuid(),latitude=null,longitude=null,accuracy_metres=null,recorded_at=null,received_at=null returning sharing_id into saved;
  return jsonb_build_object('sharing_id',saved);
end;
$$;
create or replace function public.begin_trip_sharing(target uuid) returns jsonb
language sql security invoker set search_path='' as $$ select private.begin_trip_sharing(target); $$;
create or replace function private.report_trip_location(target uuid,session_id uuid,latitude double precision,longitude double precision,accuracy_metres double precision,recorded_at timestamptz) returns void
language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.driver_account_id();
begin
  if actor is null then raise exception 'Driver access required.' using errcode='42501'; end if;
  if session_id is null or latitude is null or longitude is null or accuracy_metres is null or recorded_at is null
    or latitude not between -90 and 90 or longitude not between -180 and 180 or accuracy_metres not between 0 and 10000
    or not isfinite(recorded_at) or recorded_at<now()-interval '2 minutes' or recorded_at>now()+interval '30 seconds' then raise exception 'Invalid current location.' using errcode='22023'; end if;
  perform 1 from public.accounts where id=actor and role='driver' and status='active' for share;
  if not found then raise exception 'Driver access required.' using errcode='42501'; end if;
  perform 1 from public.trips where id=target and assigned_driver_id=actor and lifecycle='in-progress' and deleted_at is null and demo_owner_id is null for share;
  if not found then raise exception 'Only an active assigned trip may report location.' using errcode='42501'; end if;
  perform 1 from public.trip_locations l where l.trip_id=target and l.driver_id=actor and l.sharing_id=session_id for update;
  if not found then raise exception 'Location sharing session ended.' using errcode='PT409'; end if;
  update public.trip_locations l set latitude=report_trip_location.latitude,longitude=report_trip_location.longitude,
    accuracy_metres=report_trip_location.accuracy_metres,recorded_at=report_trip_location.recorded_at,received_at=now()
    where l.trip_id=target and (l.recorded_at is null or l.recorded_at<report_trip_location.recorded_at);
end;
$$;
create or replace function public.report_trip_location(target uuid,session_id uuid,latitude double precision,longitude double precision,accuracy_metres double precision,recorded_at timestamptz) returns void
language sql security invoker set search_path='' as $$ select private.report_trip_location(target,session_id,latitude,longitude,accuracy_metres,recorded_at); $$;
create or replace function private.clear_trip_location(target uuid,session_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.driver_account_id();
begin
  if actor is null then raise exception 'Driver access required.' using errcode='42501'; end if;
  delete from public.trip_locations where trip_id=target and driver_id=actor and sharing_id=session_id
    and exists(select 1 from public.trips where id=target and demo_owner_id is null);
end;
$$;
create or replace function public.clear_trip_location(target uuid,session_id uuid) returns void
language sql security invoker set search_path='' as $$ select private.clear_trip_location(target,session_id); $$;
revoke all on function private.begin_trip_sharing(uuid),public.begin_trip_sharing(uuid),private.report_trip_location(uuid,uuid,double precision,double precision,double precision,timestamptz),public.report_trip_location(uuid,uuid,double precision,double precision,double precision,timestamptz),private.clear_trip_location(uuid,uuid),public.clear_trip_location(uuid,uuid) from public,anon;
grant execute on function private.begin_trip_sharing(uuid),public.begin_trip_sharing(uuid),private.report_trip_location(uuid,uuid,double precision,double precision,double precision,timestamptz),public.report_trip_location(uuid,uuid,double precision,double precision,double precision,timestamptz),private.clear_trip_location(uuid,uuid),public.clear_trip_location(uuid,uuid) to authenticated;

create or replace function private.trip_progress(target uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare chosen public.trips; point jsonb; sharing boolean:=false;
begin
  if not private.can_view_trip(target) then raise exception 'Trip access denied.' using errcode='42501'; end if;
  select * into chosen from public.trips where id=target;
  if private.can_track_trip(target) then
    select true,case when l.latitude is not null then jsonb_build_object('latitude',l.latitude,'longitude',l.longitude,'accuracy_metres',l.accuracy_metres,'recorded_at',l.recorded_at,'received_at',l.received_at) end
      into sharing,point from public.trip_locations l where l.trip_id=target;
  end if;
  return jsonb_build_object('trip',to_jsonb(chosen),'location',point,'sharing',coalesce(sharing,false));
end;
$$;
create or replace function public.trip_progress(target uuid) returns jsonb
language sql stable security invoker set search_path='' as $$ select private.trip_progress(target); $$;
revoke all on function private.trip_progress(uuid),public.trip_progress(uuid) from public,anon;
grant execute on function private.trip_progress(uuid),public.trip_progress(uuid) to authenticated;

create or replace function private.get_driver_week(target uuid,week_start date) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb; today date:=(now() at time zone 'Asia/Singapore')::date;
begin
  if target is null or (not private.is_coordinator() and private.driver_account_id() is distinct from target) then raise exception 'Calendar access denied.' using errcode='42501'; end if;
  if week_start is null or not isfinite(week_start) or extract(isodow from week_start)<>1
    or week_start<today-extract(isodow from today)::integer+1 or week_start>private.planning_window_end() then
    raise exception 'Choose a week within the four-week planning window.' using errcode='22023';
  end if;
  if private.is_coordinator() then result:=private.get_driver_availability(target);
  else result:=jsonb_build_object('eligible',private.approved_driver_id() is not null); end if;
  result:=result || jsonb_build_object('availability',jsonb_build_object('weekly_slots',private.effective_driver_slots(target,week_start),
    'version',coalesce((select version from public.driver_week_availability where driver_id=target and driver_week_availability.week_start=get_driver_week.week_start),0),
    'template_version',coalesce((select version from public.driver_availability where driver_id=target),0)));
  return result || jsonb_build_object('week_start',week_start,'planning_end',private.planning_window_end(),'trips',
    (select coalesce(jsonb_agg(to_jsonb(t) order by t.pickup_at,t.id),'[]'::jsonb) from (
      select t.id::text as id,t.patient_name,t.direction,coalesce(t.started_at,t.pickup_at) as pickup_at,private.effective_trip_end(t) as dropoff_at,t.origin,t.destination,t.status,'journey'::text as kind,t.lifecycle
      from public.trips t where t.assigned_driver_id=target and t.deleted_at is null
        and coalesce(t.started_at,t.pickup_at)<((week_start+7)::timestamp at time zone 'Asia/Singapore') and private.effective_trip_end(t)>(week_start::timestamp at time zone 'Asia/Singapore')
      union all
      select t.id::text||'-transfer',t.patient_name,t.direction,w.window_start,w.window_end,w.origin,w.destination,t.status,'transfer'::text,t.lifecycle
      from private.driver_transfer_windows(target) w join public.trips t on t.id=w.trip_id
      where w.window_start<((week_start+7)::timestamp at time zone 'Asia/Singapore') and w.window_end>(week_start::timestamp at time zone 'Asia/Singapore')
    ) t));
end;
$$;
create or replace function public.get_driver_week(target uuid,week_start date) returns jsonb
language sql stable security invoker set search_path='' as $$ select private.get_driver_week(target,week_start); $$;
revoke all on function private.get_driver_week(uuid,date),public.get_driver_week(uuid,date) from public,anon;
grant execute on function private.get_driver_week(uuid,date),public.get_driver_week(uuid,date) to authenticated;

-- Server-only monitoring: no authenticated caller can forge observations or claim work.
create or replace function private.claim_trip_traffic_checks() returns jsonb
language plpgsql security definer set search_path='' as $$
declare journey public.trips; ids jsonb:='[]'::jsonb;
begin
  for journey in select t.* from public.trips t left join private.trip_traffic_checks c on c.trip_id=t.id
    where t.deleted_at is null and t.demo_owner_id is null and t.assigned_driver_id is not null and t.lifecycle in ('scheduled','in-progress')
      and (t.lifecycle='in-progress' or t.pickup_at between now()-interval '1 day' and now()+interval '1 hour')
      and coalesce(c.next_check_at,'-infinity'::timestamptz)<=now()
    order by c.next_check_at nulls first,t.pickup_at,t.id limit 25 for update of t skip locked
  loop
    insert into private.trip_traffic_checks(trip_id,next_check_at) values(journey.id,now()+interval '1 minute')
      on conflict(trip_id) do update set next_check_at=excluded.next_check_at;
    ids:=ids||to_jsonb(journey.id);
  end loop;
  return ids;
end;
$$;
create or replace function private.trip_traffic_context(target uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object('trip',to_jsonb(t),'location',(
    select jsonb_build_object('latitude',l.latitude,'longitude',l.longitude,'accuracy_metres',l.accuracy_metres,'recorded_at',l.recorded_at,'received_at',l.received_at)
    from public.trip_locations l join public.accounts a on a.id=l.driver_id
    where l.trip_id=t.id and l.driver_id=t.assigned_driver_id and a.role='driver' and a.status='active'
      and t.lifecycle='in-progress' and l.latitude is not null))
  from public.trips t where t.id=target and t.deleted_at is null and t.assigned_driver_id is not null and t.lifecycle in ('scheduled','in-progress');
$$;
-- Application conflicts use PT409 throughout this schema. Never raise 40001 for
-- validation: PostgREST 14 can retry it indefinitely, including expired payloads.
create or replace function private.record_trip_traffic_check(target uuid,expected_version integer,assessment jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare journey public.trips; projected public.trips; checked_at timestamptz; expires_at timestamptz; attention boolean; clear_verified boolean; recheck_at timestamptz;
begin
  if assessment is null or jsonb_typeof(assessment)<>'object' or not assessment ?& array['assessed_at','expires_at','risk','requires_attention']
    or exists(select 1 from jsonb_object_keys(assessment) as fields(key) where key not in ('assessed_at','expires_at','risk','requires_attention','clear_verified','coverage_percent','incidents_retrieved_at','speeds_retrieved_at','arrival_from','arrival_until'))
    or expected_version is null or expected_version<1 or jsonb_typeof(assessment->'risk')<>'string'
    or jsonb_typeof(assessment->'requires_attention')<>'boolean' or (assessment->>'risk') not in ('at-risk','possible-delay','no-delay-detected') then
    raise exception 'Invalid traffic assessment.' using errcode='22023';
  end if;
  checked_at:=(assessment->>'assessed_at')::timestamptz; expires_at:=(assessment->>'expires_at')::timestamptz;
  if checked_at is null or expires_at is null or checked_at<now()-interval '30 seconds' or checked_at>now()+interval '5 seconds'
    or expires_at<=now() or expires_at<=checked_at or expires_at>checked_at+interval '2 minutes' then raise exception 'Traffic assessment expired.' using errcode='PT409'; end if;
  select * into journey from public.trips where id=target and deleted_at is null;
  if not found then raise exception 'Trip not found.' using errcode='P0002'; end if;
  -- Match execution/assignment ordering before the notification FK takes account locks.
  perform 1 from public.patients where id=journey.patient_id for update;
  perform 1 from public.accounts where id=journey.assigned_driver_id for key share;
  select * into journey from public.trips where id=target and deleted_at is null for update;
  if not found then raise exception 'Trip not found.' using errcode='P0002'; end if;
  if journey.version<>expected_version or journey.assigned_driver_id is null or journey.lifecycle not in ('scheduled','in-progress') then
    raise exception 'Trip changed.' using errcode='PT409';
  end if;
  if checked_at<clock_timestamp()-interval '30 seconds' or expires_at<=clock_timestamp() then
    raise exception 'Traffic assessment expired while waiting.' using errcode='PT409';
  end if;
  attention:=(assessment->>'requires_attention')::boolean;
  if attention and (assessment->>'risk')='no-delay-detected' then raise exception 'Invalid traffic risk.' using errcode='22023'; end if;
  if assessment ? 'clear_verified' and jsonb_typeof(assessment->'clear_verified')<>'boolean' then raise exception 'Invalid traffic clearance.' using errcode='22023'; end if;
  clear_verified:=coalesce((assessment->>'clear_verified')::boolean,false);
  if clear_verified and (attention or assessment->>'risk'<>'no-delay-detected' or jsonb_typeof(assessment->'coverage_percent') is distinct from 'number'
    or (assessment->>'coverage_percent')::numeric not between 90 and 100 or assessment->>'arrival_until' is null) then
    raise exception 'Traffic clearance requires fresh covered observations.' using errcode='22023';
  end if;
  insert into private.trip_traffic_checks(trip_id,next_check_at,assessed_at,assessment)
    values(target,now()+interval '1 minute',checked_at,assessment)
    on conflict(trip_id) do update set assessed_at=excluded.assessed_at,assessment=excluded.assessment;
  if attention and not journey.traffic_review_required then
    update public.trips set traffic_review_required=true,status='at-risk',updated_at=now() where id=target returning * into journey;
    insert into public.trip_history(trip_id,event,details) values(target,'traffic_risk_detected',jsonb_build_object('risk',assessment->>'risk','assessed_at',checked_at));
  elsif clear_verified and journey.traffic_review_required then
    projected:=journey; projected.traffic_review_required:=false;
    if journey.lifecycle='in-progress' then
      recheck_at:=clock_timestamp()+interval '1 second';
      projected.lifecycle:='scheduled';
      projected.duration_minutes:=greatest(5,ceil(extract(epoch from ((assessment->>'arrival_until')::timestamptz-recheck_at))/300)::integer*5);
      projected.pickup_at:=recheck_at;
    end if;
    update public.trips set traffic_review_required=false,
      status=case when private.driver_fits_trip(journey.assigned_driver_id,projected,projected.pickup_at) then 'on-track' else 'at-risk' end,
      updated_at=now() where id=target returning * into journey;
    insert into public.trip_history(trip_id,event,details) values(target,'traffic_risk_cleared',jsonb_build_object('assessed_at',checked_at,'coverage_percent',assessment->'coverage_percent'));
  end if;
  return jsonb_build_object('version',journey.version,'traffic_review_required',journey.traffic_review_required);
end;
$$;
create or replace function public.claim_trip_traffic_checks() returns jsonb
language sql security invoker set search_path='' as $$ select private.claim_trip_traffic_checks(); $$;
create or replace function public.trip_traffic_context(target uuid) returns jsonb
language sql stable security invoker set search_path='' as $$ select private.trip_traffic_context(target); $$;
create or replace function public.record_trip_traffic_check(target uuid,expected_version integer,assessment jsonb) returns jsonb
language sql security invoker set search_path='' as $$ select private.record_trip_traffic_check(target,expected_version,assessment); $$;
revoke all on function private.claim_trip_traffic_checks(),public.claim_trip_traffic_checks(),private.trip_traffic_context(uuid),public.trip_traffic_context(uuid),private.record_trip_traffic_check(uuid,integer,jsonb),public.record_trip_traffic_check(uuid,integer,jsonb) from public,anon,authenticated;
do $$ begin
  if exists(select 1 from pg_roles where rolname='service_role') then
    grant usage on schema private to service_role;
    grant execute on function private.claim_trip_traffic_checks(),public.claim_trip_traffic_checks(),private.trip_traffic_context(uuid),public.trip_traffic_context(uuid),private.record_trip_traffic_check(uuid,integer,jsonb),public.record_trip_traffic_check(uuid,integer,jsonb) to service_role;
  end if;
end $$;

-- Recovery proposals are private, server-generated and never release a reservation.
create table if not exists private.trip_recovery_options (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete restrict,
  trip_version integer not null check(trip_version>0),
  driver_id uuid not null references public.drivers(account_id) on delete restrict,
  vehicle_id uuid not null references public.driver_vehicles(id) on delete restrict,
  pickup_at timestamptz not null,
  duration_minutes integer not null check(duration_minutes between 5 and 360 and duration_minutes%5=0),
  route jsonb not null check(jsonb_typeof(route)='object'),
  expires_at timestamptz not null,
  validated_at timestamptz, validation_expires_at timestamptz,
  approved_at timestamptz, approved_by uuid references public.accounts(id) on delete restrict
);
alter table private.trip_recovery_options enable row level security;
alter table private.trip_recovery_options add column if not exists handover_origin text;
alter table private.trip_recovery_options add column if not exists estimated_duration boolean not null default false;
alter table private.trip_recovery_options add column if not exists buffer_minutes integer not null default 0;
alter table private.trip_recovery_options drop constraint if exists recovery_duration_estimate_check;
alter table private.trip_recovery_options add constraint recovery_duration_estimate_check check (
  buffer_minutes between 0 and 60 and ((estimated_duration and buffer_minutes>0) or (not estimated_duration and buffer_minutes=0))
);
revoke all on private.trip_recovery_options from public,anon,authenticated;
create index if not exists trip_recovery_pending on private.trip_recovery_options(trip_id,expires_at) where approved_at is null;

-- The worker only prepares proposals. These leases never authorize a booking change.
create table if not exists private.trip_recovery_checks (
  trip_id uuid primary key references public.trips(id) on delete cascade,
  next_check_at timestamptz not null
);
alter table private.trip_recovery_checks enable row level security;
revoke all on private.trip_recovery_checks from public,anon,authenticated;

create or replace function private.claim_trip_recovery_checks() returns jsonb
language plpgsql security definer set search_path='' as $$
declare journey public.trips; work jsonb:='[]'::jsonb;
begin
  for journey in select t.* from public.trips t left join private.trip_recovery_checks c on c.trip_id=t.id
    where t.deleted_at is null and t.demo_owner_id is null and t.lifecycle='scheduled' and t.status='at-risk'
      and t.assigned_driver_id is not null and not t.review_required and t.pickup_at>=now()-interval '1 day'
      and (t.pickup_at at time zone 'Asia/Singapore')::date<=private.planning_window_end()
      and coalesce(c.next_check_at,'-infinity'::timestamptz)<=now()
      and not exists(select 1 from private.trip_recovery_options o where o.trip_id=t.id and o.trip_version=t.version and o.approved_at is null and o.expires_at>now())
    order by c.next_check_at nulls first,t.pickup_at,t.id limit 8 for update of t skip locked
  loop
    insert into private.trip_recovery_checks(trip_id,next_check_at) values(journey.id,now()+interval '2 minutes')
      on conflict(trip_id) do update set next_check_at=excluded.next_check_at;
    work:=work||jsonb_build_array(jsonb_build_object('id',journey.id,'version',journey.version));
  end loop;
  return work;
end;
$$;

create or replace function private.pending_trip_recovery_options(target uuid,expected_version integer) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare journey public.trips; options jsonb;
begin
  select * into journey from public.trips where id=target and deleted_at is null;
  if not found or expected_version is null or journey.version<>expected_version then raise exception 'Trip changed.' using errcode='PT409'; end if;
  if journey.lifecycle<>'scheduled' or journey.status<>'at-risk' or journey.assigned_driver_id is null or journey.review_required then return null; end if;
  select jsonb_agg(jsonb_build_object('id',o.id,'driver_id',o.driver_id,'driver_name',d.full_name,'vehicle_id',o.vehicle_id,
    'plate',v.plate_number,'make',v.make,'model',v.model,'pickup_at',o.pickup_at,'dropoff_at',o.pickup_at+make_interval(mins=>o.duration_minutes),
    'duration_minutes',o.duration_minutes,'same_driver',o.driver_id=journey.assigned_driver_id,'expires_at',o.expires_at,
    'estimated_duration',o.estimated_duration,'buffer_minutes',o.buffer_minutes,
    'preferred',coalesce(o.driver_id=private.preferred_driver_for(journey.patient_id),false),
    'continuity',coalesce(o.driver_id=private.last_completed_driver_for(journey.patient_id),false),
    'average_rating',private.driver_feedback_summary(o.driver_id)->'average_rating')
    order by abs(extract(epoch from (o.pickup_at-journey.pickup_at))), (o.driver_id=journey.assigned_driver_id) desc,
      coalesce(o.driver_id=private.preferred_driver_for(journey.patient_id),false) desc,
      coalesce(o.driver_id=private.last_completed_driver_for(journey.patient_id),false) desc,
      (private.driver_feedback_summary(o.driver_id)->>'average_rating')::numeric desc nulls last,
      o.pickup_at,d.full_name,o.driver_id)
  into options from private.trip_recovery_options o join public.drivers d on d.account_id=o.driver_id join public.driver_vehicles v on v.id=o.vehicle_id
    where o.trip_id=target and o.trip_version=expected_version and o.handover_origin is null and o.approved_at is null and o.expires_at>now();
  if options is null then return null; end if;
  return jsonb_build_object('trip',to_jsonb(journey),'options',options,'critical',journey.recovery_critical);
end;
$$;

create or replace function private.recovery_candidates(target uuid,expected_version integer,reserved_minutes integer,route_blocked boolean,handover_origin text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare original public.trips; projected public.trips; route jsonb; starts timestamptz; base timestamptz;
  candidate record; preceding public.trips; following public.trips; options jsonb:='[]'::jsonb; legs jsonb:='[]'::jsonb;
begin
  select * into original from public.trips where id=target and deleted_at is null;
  if not found then raise exception 'Trip not found.' using errcode='P0002'; end if;
  if expected_version is null or original.version<>expected_version then raise exception 'Trip changed.' using errcode='PT409'; end if;
  if original.status<>'at-risk' or original.assigned_driver_id is null or original.review_required
    or (handover_origin is null and original.lifecycle<>'scheduled')
    or (handover_origin is not null and (original.lifecycle<>'in-progress' or length(btrim(handover_origin)) not between 1 and 500)) then
    raise exception 'Recovery requires an eligible At-Risk trip with approved source details.' using errcode='22023';
  end if;
  route:=private.cached_driving_route(coalesce(handover_origin,original.origin),original.destination);
  if route is null then raise exception 'A verified recovery route is required.' using errcode='P0001'; end if;
  if reserved_minutes is null or reserved_minutes<greatest(5,(route->>'duration_minutes')::integer) or reserved_minutes>360 or reserved_minutes%5<>0 or route_blocked is null then
    raise exception 'Invalid recovery duration.' using errcode='22023';
  end if;
  projected:=original; projected.assigned_driver_id:=null; projected.assigned_vehicle_id:=null;
  projected.lifecycle:='scheduled'; projected.started_at:=null; projected.origin:=coalesce(handover_origin,original.origin);
  projected.pickup_at:=null; projected.dropoff_at:=null; projected.assignment:=null;
  projected.driver_unavailable_at:=null; projected.traffic_review_required:=false; projected.recovery_critical:=false;
  projected.status:='unfilled'; projected.route_snapshot:=route; projected.duration_minutes:=reserved_minutes;
  base:=case when handover_origin is not null then greatest(original.pickup_not_before,date_trunc('minute',private.trip_now(original))+interval '5 minutes')
    when original.direction='outbound' then original.pickup_at
    else greatest(original.pickup_at,original.pickup_not_before,date_trunc('minute',private.trip_now(original))+interval '5 minutes') end;
  if not route_blocked then
    for starts in select distinct proposed from unnest(case when original.direction='outbound'
      then array[base,base-interval '15 minutes',base-interval '30 minutes',original.arrival_by-make_interval(mins=>reserved_minutes)]
      else array[base,base+interval '15 minutes',base+interval '30 minutes'] end) proposed where proposed>private.trip_now(original)
    loop
      for candidate in select a.id,d.full_name,d.phone,v.id as vehicle_id,v.plate_number,v.make,v.model,
        coalesce(a.id=private.preferred_driver_for(original.patient_id),false) as preferred,
        coalesce(a.id=private.last_completed_driver_for(original.patient_id),false) as continuity,
        (private.driver_feedback_summary(a.id)->>'average_rating')::numeric as average_rating
        from public.accounts a join public.drivers d on d.account_id=a.id join public.driver_vehicles v on v.driver_id=a.id
        where (handover_origin is null or a.id<>original.assigned_driver_id)
          and (original.driver_unavailable_at is null or a.id<>original.assigned_driver_id)
          and private.driver_fits_trip_base(a.id,projected,starts)
      loop
        select * into preceding from public.trips where assigned_driver_id=candidate.id and id<>target and deleted_at is null and lifecycle<>'cancelled'
          and private.effective_trip_end(trips)<=starts order by private.effective_trip_end(trips) desc,id limit 1;
        if preceding.id is not null and preceding.destination<>projected.origin then legs:=legs||jsonb_build_array(jsonb_build_object('origin',preceding.destination,'destination',projected.origin)); end if;
        select * into following from public.trips where assigned_driver_id=candidate.id and id<>target and deleted_at is null and lifecycle<>'cancelled'
          and pickup_at>=starts+make_interval(mins=>reserved_minutes) order by pickup_at,id limit 1;
        if following.id is not null and following.origin<>projected.destination then legs:=legs||jsonb_build_array(jsonb_build_object('origin',projected.destination,'destination',following.origin)); end if;
        if private.driver_fits_trip(candidate.id,projected,starts) then
          options:=options||jsonb_build_array(jsonb_build_object('driver_id',candidate.id,'driver_name',candidate.full_name,'phone',candidate.phone,
            'vehicle_id',candidate.vehicle_id,'plate',candidate.plate_number,'make',candidate.make,'model',candidate.model,
            'pickup_at',starts,'dropoff_at',starts+make_interval(mins=>reserved_minutes),'duration_minutes',reserved_minutes,
            'same_driver',candidate.id=original.assigned_driver_id,'change_minutes',abs(extract(epoch from starts-original.pickup_at))/60,
            'preferred',candidate.preferred,'continuity',candidate.continuity,'average_rating',candidate.average_rating));
        end if;
      end loop;
    end loop;
  end if;
  select coalesce(jsonb_agg(value),'[]'::jsonb) into options from (
    select value from jsonb_array_elements(options) order by (value->>'change_minutes')::numeric,(value->>'same_driver')::boolean desc,
      (value->>'preferred')::boolean desc,(value->>'continuity')::boolean desc,(value->>'average_rating')::numeric desc nulls last,
      (value->>'dropoff_at')::timestamptz,value->>'driver_name',value->>'driver_id' limit 12) ranked;
  select coalesce(jsonb_agg(distinct value),'[]'::jsonb) into legs from jsonb_array_elements(legs);
  return jsonb_build_object('trip',to_jsonb(original),'route',route,'requirements',legs,'options',options);
end;
$$;

create or replace function private.trip_recovery_candidates(target uuid,expected_version integer,reserved_minutes integer,route_blocked boolean) returns jsonb
language sql stable security definer set search_path='' as $$ select private.recovery_candidates(target,expected_version,reserved_minutes,route_blocked,null); $$;
create or replace function private.trip_handover_candidates(target uuid,expected_version integer,reserved_minutes integer,handover_origin text) returns jsonb
language sql stable security definer set search_path='' as $$ select private.recovery_candidates(target,expected_version,reserved_minutes,false,handover_origin); $$;

create or replace function private.store_assessed_recovery_options(target uuid,expected_version integer,reserved_minutes integer,route_blocked boolean,handover_origin text,estimated_duration boolean,buffer_minutes integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare journey public.trips; preview jsonb; option jsonb; saved_id uuid; saved_options jsonb:='[]'::jsonb; critical boolean; leg jsonb; pending jsonb;
begin
  if estimated_duration is null or buffer_minutes is null or buffer_minutes not between 0 and 60
    or (estimated_duration and buffer_minutes=0) or (not estimated_duration and buffer_minutes<>0) then raise exception 'Invalid recovery estimate.' using errcode='22023'; end if;
  select * into journey from public.trips where id=target and deleted_at is null;
  if not found then raise exception 'Trip not found.' using errcode='P0002'; end if;
  perform 1 from public.patients where id=journey.patient_id for update;
  perform 1 from public.accounts where id=journey.assigned_driver_id for key share;
  select * into journey from public.trips where id=target and deleted_at is null for update;
  if handover_origin is null then pending:=private.pending_trip_recovery_options(target,expected_version); end if;
  if pending is not null then return pending; end if;
  preview:=private.recovery_candidates(target,expected_version,reserved_minutes,route_blocked,handover_origin);
  if reserved_minutes<(preview->'route'->>'duration_minutes')::integer+buffer_minutes then raise exception 'Recovery duration must include its planning buffer.' using errcode='22023'; end if;
  for leg in select value from jsonb_array_elements(preview->'requirements') loop
    if private.cached_driving_route(leg->>'origin',leg->>'destination') is null then raise exception 'Recovery connecting routes are unavailable.' using errcode='P0001'; end if;
  end loop;
  critical:=jsonb_array_length(preview->'options')=0;
  if journey.recovery_critical is distinct from critical then
    update public.trips set recovery_critical=critical,status='at-risk',updated_at=now() where id=target returning * into journey;
    if critical then insert into public.trip_history(trip_id,event,details) values(target,'recovery_critical',jsonb_build_object('reason',case when route_blocked then 'no_verified_route' else 'no_feasible_resource' end)); end if;
  end if;
  delete from private.trip_recovery_options where trip_id=target and approved_at is null;
  for option in select value from jsonb_array_elements(preview->'options') loop
    insert into private.trip_recovery_options(trip_id,trip_version,driver_id,vehicle_id,pickup_at,duration_minutes,route,expires_at,handover_origin,estimated_duration,buffer_minutes)
      values(target,journey.version,(option->>'driver_id')::uuid,(option->>'vehicle_id')::uuid,(option->>'pickup_at')::timestamptz,reserved_minutes,preview->'route',now()+interval '1 minute',handover_origin,estimated_duration,buffer_minutes) returning id into saved_id;
    saved_options:=saved_options||jsonb_build_array(option||jsonb_build_object('id',saved_id,'expires_at',now()+interval '1 minute','estimated_duration',estimated_duration,'buffer_minutes',buffer_minutes));
  end loop;
  return jsonb_build_object('trip',to_jsonb(journey),'options',saved_options,'critical',critical,'handover_origin',handover_origin);
end;
$$;
create or replace function private.store_recovery_options(target uuid,expected_version integer,reserved_minutes integer,route_blocked boolean,handover_origin text) returns jsonb
language sql security definer set search_path='' as $$ select private.store_assessed_recovery_options(target,expected_version,reserved_minutes,route_blocked,handover_origin,false,0); $$;
create or replace function public.store_assessed_trip_recovery_options(target uuid,expected_version integer,reserved_minutes integer,route_blocked boolean,handover_origin text,estimated_duration boolean,buffer_minutes integer) returns jsonb
language sql security invoker set search_path='' as $$ select private.store_assessed_recovery_options(target,expected_version,reserved_minutes,route_blocked,handover_origin,estimated_duration,buffer_minutes); $$;
revoke all on function private.store_assessed_recovery_options(uuid,integer,integer,boolean,text,boolean,integer),public.store_assessed_trip_recovery_options(uuid,integer,integer,boolean,text,boolean,integer) from public,anon,authenticated;
create or replace function private.store_trip_recovery_options(target uuid,expected_version integer,reserved_minutes integer,route_blocked boolean) returns jsonb
language sql security definer set search_path='' as $$ select private.store_recovery_options(target,expected_version,reserved_minutes,route_blocked,null); $$;
create or replace function private.store_trip_handover_options(target uuid,expected_version integer,reserved_minutes integer,handover_origin text) returns jsonb
language sql security definer set search_path='' as $$ select private.store_recovery_options(target,expected_version,reserved_minutes,false,handover_origin); $$;

create or replace function private.trip_recovery_option(proposal uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object('option',to_jsonb(o),'trip',to_jsonb(t)) from private.trip_recovery_options o join public.trips t on t.id=o.trip_id
    where o.id=proposal and o.approved_at is null and o.expires_at>now() and t.deleted_at is null and t.version=o.trip_version;
$$;
-- Validate the saved time, not a newly generated grid that moves every minute.
create or replace function private.trip_recovery_validation(proposal uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare option private.trip_recovery_options; journey public.trips; projected public.trips; preceding public.trips; following public.trips; legs jsonb:='[]'::jsonb;
begin
  select * into option from private.trip_recovery_options where id=proposal and approved_at is null and expires_at>now();
  if not found then raise exception 'Recovery option changed.' using errcode='PT409'; end if;
  select * into journey from public.trips where id=option.trip_id and deleted_at is null;
  if not found or journey.version<>option.trip_version or journey.status<>'at-risk' or journey.review_required or journey.assigned_driver_id is null
    or (option.handover_origin is null and journey.lifecycle<>'scheduled')
    or (option.handover_origin is not null and (journey.lifecycle<>'in-progress' or option.driver_id=journey.assigned_driver_id))
    or (journey.driver_unavailable_at is not null and option.driver_id=journey.assigned_driver_id) then
    raise exception 'Recovery option changed.' using errcode='PT409';
  end if;
  projected:=journey; projected.lifecycle:='scheduled'; projected.started_at:=null;
  projected.origin:=coalesce(option.handover_origin,journey.origin); projected.route_snapshot:=private.cached_driving_route(projected.origin,journey.destination);
  projected.duration_minutes:=option.duration_minutes; projected.assigned_driver_id:=null; projected.assigned_vehicle_id:=null;
  projected.assignment:=null; projected.pickup_at:=null; projected.dropoff_at:=null; projected.driver_unavailable_at:=null;
  projected.traffic_review_required:=false; projected.recovery_critical:=false; projected.status:='unfilled';
  select * into preceding from public.trips where assigned_driver_id=option.driver_id and id<>journey.id and deleted_at is null and lifecycle<>'cancelled'
    and private.effective_trip_end(trips)<=option.pickup_at order by private.effective_trip_end(trips) desc,id limit 1;
  if preceding.id is not null and preceding.destination<>projected.origin then legs:=legs||jsonb_build_array(jsonb_build_object('origin',preceding.destination,'destination',projected.origin)); end if;
  select * into following from public.trips where assigned_driver_id=option.driver_id and id<>journey.id and deleted_at is null and lifecycle<>'cancelled'
    and pickup_at>=option.pickup_at+make_interval(mins=>option.duration_minutes) order by pickup_at,id limit 1;
  if following.id is not null and following.origin<>projected.destination then legs:=legs||jsonb_build_array(jsonb_build_object('origin',projected.destination,'destination',following.origin)); end if;
  return jsonb_build_object('requirements',legs,'feasible',private.driver_fits_trip(option.driver_id,projected,option.pickup_at));
end;
$$;
create or replace function private.attest_trip_recovery_option(proposal uuid,valid_until timestamptz) returns void
language plpgsql security definer set search_path='' as $$
declare option private.trip_recovery_options;
begin
  if valid_until is null or not isfinite(valid_until) or valid_until<=now() or valid_until>now()+interval '30 seconds' then raise exception 'Invalid recovery attestation.' using errcode='22023'; end if;
  update private.trip_recovery_options o set validated_at=now(),validation_expires_at=least(valid_until,o.expires_at)
    where o.id=proposal and o.approved_at is null and o.expires_at>now()
      and exists(select 1 from public.trips t where t.id=o.trip_id and t.deleted_at is null and t.version=o.trip_version) returning * into option;
  if not found then raise exception 'Recovery option changed.' using errcode='PT409'; end if;
end;
$$;

create or replace function private.approve_recovery_action(proposal uuid,expected_version integer,safe_pickup_confirmed boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare option private.trip_recovery_options; chosen public.trips; projected public.trips; saved public.trips; route jsonb; snapshot jsonb; actor uuid; fresh timestamptz;
begin
  if not private.is_coordinator() then raise exception 'Coordinator access required.' using errcode='42501'; end if;
  select * into option from private.trip_recovery_options where id=proposal;
  if not found then raise exception 'Recovery option changed.' using errcode='PT409'; end if;
  select * into chosen from public.trips where id=option.trip_id and deleted_at is null;
  if not found then raise exception 'Trip not found.' using errcode='P0002'; end if;
  select id into actor from public.accounts where auth_user_id=(select auth.uid());
  perform 1 from public.patients where id=chosen.patient_id for update;
  perform 1 from public.accounts where id in (chosen.assigned_driver_id,option.driver_id) order by id for update;
  perform 1 from public.accounts where id=actor for key share;
  if not private.is_coordinator() then raise exception 'Coordinator access required.' using errcode='42501'; end if;
  perform 1 from public.driver_vehicles where driver_id=option.driver_id for share;
  perform 1 from public.driver_availability where driver_id=option.driver_id for share;
  select * into chosen from public.trips where id=option.trip_id and deleted_at is null for update;
  select * into option from private.trip_recovery_options where id=proposal for update;
  fresh:=clock_timestamp();
  if not found or expected_version is null or chosen.version<>expected_version or chosen.version<>option.trip_version
    or option.approved_at is not null or option.expires_at<=fresh or option.validated_at is null or option.validated_at<fresh-interval '10 seconds'
    or option.validation_expires_at<=fresh or option.pickup_at<=private.trip_now(chosen) then
    raise exception 'Recovery option changed or expired. Reassess before approval.' using errcode='PT409';
  end if;
  if (option.handover_origin is null and chosen.lifecycle<>'scheduled')
    or (option.handover_origin is not null and (chosen.lifecycle<>'in-progress' or safe_pickup_confirmed is distinct from true or chosen.assigned_driver_id=option.driver_id))
    or chosen.status<>'at-risk' or chosen.assigned_driver_id is null or chosen.review_required
    or (chosen.driver_unavailable_at is not null and chosen.assigned_driver_id=option.driver_id) then raise exception 'Recovery is no longer eligible.' using errcode='PT409'; end if;
  route:=private.cached_driving_route(coalesce(option.handover_origin,chosen.origin),chosen.destination);
  if route is null or route->'geometry' is distinct from option.route->'geometry' or (route->>'duration_minutes')::integer>option.duration_minutes then
    raise exception 'Recovery route changed. Reassess before approval.' using errcode='PT409';
  end if;
  projected:=chosen; projected.assigned_driver_id:=null; projected.assigned_vehicle_id:=null; projected.assignment:=null;
  projected.lifecycle:='scheduled'; projected.started_at:=null; projected.origin:=coalesce(option.handover_origin,chosen.origin);
  projected.pickup_at:=null; projected.dropoff_at:=null; projected.driver_unavailable_at:=null;
  projected.traffic_review_required:=false; projected.recovery_critical:=false; projected.status:='unfilled';
  projected.duration_minutes:=option.duration_minutes; projected.route_snapshot:=route;
  if private.driver_fits_trip(option.driver_id,projected,option.pickup_at) is distinct from true
    or not exists(select 1 from public.driver_vehicles where id=option.vehicle_id and driver_id=option.driver_id and status='approved') then
    raise exception 'Recovery option is no longer feasible.' using errcode='PT409';
  end if;
  select jsonb_build_object('driver_name',d.full_name,'driver_phone',d.phone,'vehicle_id',v.id,'plate',v.plate_number,'make',v.make,'model',v.model,
    'passenger_capacity',v.passenger_capacity,'wheelchair_accessible',v.wheelchair_accessible,'patient_phone',p.phone,'mobility',p.mobility,'assistance_required',p.assistance_required) into snapshot
    from public.drivers d join public.driver_vehicles v on v.driver_id=d.account_id cross join public.patients p where d.account_id=option.driver_id and p.id=chosen.patient_id;
  update public.trips set assigned_driver_id=option.driver_id,assigned_vehicle_id=option.vehicle_id,assignment=snapshot,
    origin=projected.origin,lifecycle='scheduled',started_at=null,
    handover_at=case when option.handover_origin is not null then private.trip_now(chosen) else handover_at end,
    pickup_at=option.pickup_at,dropoff_at=option.pickup_at+make_interval(mins=>option.duration_minutes),duration_minutes=option.duration_minutes,
    route_snapshot=route,driver_unavailable_at=null,traffic_review_required=false,recovery_critical=false,confirmed_at=null,confirmed_by=null,status='on-track',updated_at=now()
    where id=chosen.id returning * into saved;
  update private.trip_recovery_options set approved_at=now(),approved_by=actor where id=proposal;
  insert into public.trip_history(trip_id,actor_id,event,details) values(chosen.id,actor,case when option.handover_origin is not null then 'handover_approved' else 'recovery_approved' end,jsonb_build_object('proposal_id',proposal,
    'previous_driver_id',chosen.assigned_driver_id,'driver_id',saved.assigned_driver_id,'previous_pickup_at',chosen.pickup_at,'pickup_at',saved.pickup_at,
    'handover_origin',option.handover_origin,'estimated_duration',option.estimated_duration,'buffer_minutes',option.buffer_minutes,
    'previous_origin',chosen.origin,'previous_started_at',chosen.started_at,'previous_route',chosen.route_snapshot,'previous_assignment',chosen.assignment));
  return to_jsonb(saved);
end;
$$;
create or replace function private.approve_trip_recovery(proposal uuid,expected_version integer) returns jsonb
language sql security definer set search_path='' as $$ select private.approve_recovery_action(proposal,expected_version,false); $$;
create or replace function private.approve_trip_handover(proposal uuid,expected_version integer,safe_pickup_confirmed boolean) returns jsonb
language sql security definer set search_path='' as $$ select private.approve_recovery_action(proposal,expected_version,safe_pickup_confirmed); $$;

create or replace function public.trip_recovery_candidates(target uuid,expected_version integer,reserved_minutes integer,route_blocked boolean) returns jsonb
language sql stable security invoker set search_path='' as $$ select private.trip_recovery_candidates(target,expected_version,reserved_minutes,route_blocked); $$;
create or replace function public.claim_trip_recovery_checks() returns jsonb
language sql security invoker set search_path='' as $$ select private.claim_trip_recovery_checks(); $$;
create or replace function public.pending_trip_recovery_options(target uuid,expected_version integer) returns jsonb
language sql stable security invoker set search_path='' as $$ select private.pending_trip_recovery_options(target,expected_version); $$;
revoke all on function private.claim_trip_recovery_checks(),public.claim_trip_recovery_checks(),private.pending_trip_recovery_options(uuid,integer),public.pending_trip_recovery_options(uuid,integer) from public,anon,authenticated;
create or replace function public.store_trip_recovery_options(target uuid,expected_version integer,reserved_minutes integer,route_blocked boolean) returns jsonb
language sql security invoker set search_path='' as $$ select private.store_trip_recovery_options(target,expected_version,reserved_minutes,route_blocked); $$;
create or replace function public.trip_recovery_option(proposal uuid) returns jsonb
language sql stable security invoker set search_path='' as $$ select private.trip_recovery_option(proposal); $$;
create or replace function public.trip_recovery_validation(proposal uuid) returns jsonb
language sql stable security invoker set search_path='' as $$ select private.trip_recovery_validation(proposal); $$;
revoke all on function private.trip_recovery_validation(uuid),public.trip_recovery_validation(uuid) from public,anon,authenticated;
create or replace function public.attest_trip_recovery_option(proposal uuid,valid_until timestamptz) returns void
language sql security invoker set search_path='' as $$ select private.attest_trip_recovery_option(proposal,valid_until); $$;
create or replace function public.approve_trip_recovery(proposal uuid,expected_version integer) returns jsonb
language sql security invoker set search_path='' as $$ select private.approve_trip_recovery(proposal,expected_version); $$;
create or replace function public.trip_handover_candidates(target uuid,expected_version integer,reserved_minutes integer,handover_origin text) returns jsonb
language sql stable security invoker set search_path='' as $$ select private.trip_handover_candidates(target,expected_version,reserved_minutes,handover_origin); $$;
create or replace function public.store_trip_handover_options(target uuid,expected_version integer,reserved_minutes integer,handover_origin text) returns jsonb
language sql security invoker set search_path='' as $$ select private.store_trip_handover_options(target,expected_version,reserved_minutes,handover_origin); $$;
create or replace function public.approve_trip_handover(proposal uuid,expected_version integer,safe_pickup_confirmed boolean) returns jsonb
language sql security invoker set search_path='' as $$ select private.approve_trip_handover(proposal,expected_version,safe_pickup_confirmed); $$;
revoke all on function private.recovery_candidates(uuid,integer,integer,boolean,text),private.store_recovery_options(uuid,integer,integer,boolean,text),private.approve_recovery_action(uuid,integer,boolean),private.trip_handover_candidates(uuid,integer,integer,text),public.trip_handover_candidates(uuid,integer,integer,text),private.store_trip_handover_options(uuid,integer,integer,text),public.store_trip_handover_options(uuid,integer,integer,text),private.approve_trip_handover(uuid,integer,boolean),public.approve_trip_handover(uuid,integer,boolean) from public,anon,authenticated;
grant execute on function private.approve_trip_handover(uuid,integer,boolean),public.approve_trip_handover(uuid,integer,boolean) to authenticated;
revoke all on function private.trip_recovery_candidates(uuid,integer,integer,boolean),public.trip_recovery_candidates(uuid,integer,integer,boolean),private.store_trip_recovery_options(uuid,integer,integer,boolean),public.store_trip_recovery_options(uuid,integer,integer,boolean),private.trip_recovery_option(uuid),public.trip_recovery_option(uuid),private.attest_trip_recovery_option(uuid,timestamptz),public.attest_trip_recovery_option(uuid,timestamptz),private.approve_trip_recovery(uuid,integer),public.approve_trip_recovery(uuid,integer) from public,anon,authenticated;
grant execute on function private.approve_trip_recovery(uuid,integer),public.approve_trip_recovery(uuid,integer) to authenticated;
do $$ begin
  if exists(select 1 from pg_roles where rolname='service_role') then
    grant usage on schema private to service_role;
    grant execute on function private.claim_trip_recovery_checks(),public.claim_trip_recovery_checks(),private.pending_trip_recovery_options(uuid,integer),public.pending_trip_recovery_options(uuid,integer) to service_role;
    grant execute on function private.trip_recovery_validation(uuid),public.trip_recovery_validation(uuid) to service_role;
    grant execute on function private.store_assessed_recovery_options(uuid,integer,integer,boolean,text,boolean,integer),public.store_assessed_trip_recovery_options(uuid,integer,integer,boolean,text,boolean,integer) to service_role;
    grant execute on function private.trip_handover_candidates(uuid,integer,integer,text),public.trip_handover_candidates(uuid,integer,integer,text),private.store_trip_handover_options(uuid,integer,integer,text),public.store_trip_handover_options(uuid,integer,integer,text) to service_role;
    grant execute on function private.trip_recovery_candidates(uuid,integer,integer,boolean),public.trip_recovery_candidates(uuid,integer,integer,boolean),private.store_trip_recovery_options(uuid,integer,integer,boolean),public.store_trip_recovery_options(uuid,integer,integer,boolean),private.trip_recovery_option(uuid),public.trip_recovery_option(uuid),private.attest_trip_recovery_option(uuid,timestamptz),public.attest_trip_recovery_option(uuid,timestamptz) to service_role;
  end if;
end $$;

-- Caregiver identity and consent are separate from patient transport access.
create table if not exists public.caregivers (
  account_id uuid primary key references public.accounts(id) on delete restrict,
  full_name text not null check(length(btrim(full_name)) between 1 and 100),
  phone text not null check(phone ~ '^\+?[0-9][0-9 ()-]{5,24}$'),
  birth_date date not null check(birth_date between date '1900-01-01' and (now() at time zone 'Asia/Singapore')::date),
  gender text not null check(gender in ('female','male','other','prefer-not-to-say')),
  version integer not null default 1 check(version>0),
  created_at timestamptz not null default now()
);
alter table public.caregivers enable row level security;
revoke all on public.caregivers from public,anon,authenticated;
grant select on public.caregivers to authenticated;
create or replace function private.caregiver_account_id() returns uuid
language sql stable security definer set search_path='' as $$
  select id from public.accounts where auth_user_id=(select auth.uid()) and role='caregiver' and status='active' and private.demo_identity_allowed();
$$;
revoke all on function private.caregiver_account_id() from public,anon;
grant execute on function private.caregiver_account_id() to authenticated;
drop policy if exists caregivers_read on public.caregivers;
create policy caregivers_read on public.caregivers for select to authenticated using((select private.is_coordinator()) or account_id=(select private.caregiver_account_id()));

create or replace function private.save_my_caregiver(details jsonb,expected_version integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare owner_id uuid:=private.caregiver_account_id(); saved public.caregivers;
begin
  if owner_id is null then raise exception 'Caregiver access required.' using errcode='42501'; end if;
  perform private.verified_email();
  perform private.validate_personal_details(details);
  if details-array['full_name','phone','birth_date','gender']<>'{}'::jsonb or (expected_version is not null and expected_version<1) then raise exception 'Invalid caregiver details.' using errcode='22023'; end if;
  perform 1 from public.accounts where id=owner_id and status='active' and role='caregiver' for no key update;
  if not found then raise exception 'Caregiver access required.' using errcode='42501'; end if;
  select * into saved from public.caregivers where account_id=owner_id for update;
  if expected_version is null then
    if found then raise exception 'Caregiver profile already exists.' using errcode='23505'; end if;
    insert into public.caregivers(account_id,full_name,phone,birth_date,gender)
      values(owner_id,btrim(details->>'full_name'),btrim(details->>'phone'),(details->>'birth_date')::date,details->>'gender') returning * into saved;
  else
    if saved.account_id is null or saved.version<>expected_version then raise exception 'Caregiver profile changed.' using errcode='PT409'; end if;
    update public.caregivers set full_name=btrim(details->>'full_name'),phone=btrim(details->>'phone'),birth_date=(details->>'birth_date')::date,
      gender=details->>'gender',version=version+1 where account_id=owner_id returning * into saved;
  end if;
  return to_jsonb(saved);
end;
$$;
create or replace function public.save_my_caregiver(details jsonb,expected_version integer) returns jsonb
language sql security invoker set search_path='' as $$ select private.save_my_caregiver(details,expected_version); $$;
revoke all on function private.save_my_caregiver(jsonb,integer),public.save_my_caregiver(jsonb,integer) from public,anon;
grant execute on function private.save_my_caregiver(jsonb,integer),public.save_my_caregiver(jsonb,integer) to authenticated;

create or replace function private.account_details(account public.accounts) returns jsonb
language sql stable security definer set search_path='' as $$
  select to_jsonb(account)||jsonb_build_object('demo_access_owner_id',(select owner_id from private.seeded_accounts where account_id=account.id),
    'seed_key',(select seed_key from private.seeded_accounts where account_id=account.id),'profile_complete',case account.role
    when 'patient' then exists(select 1 from public.patients where account_id=account.id)
    when 'driver' then exists(select 1 from public.drivers where account_id=account.id)
    when 'caregiver' then exists(select 1 from public.caregivers where account_id=account.id) else true end,
    'full_name',case account.role when 'patient' then (select full_name from public.patients where account_id=account.id)
    when 'driver' then (select full_name from public.drivers where account_id=account.id)
    when 'caregiver' then (select full_name from public.caregivers where account_id=account.id) else null end);
$$;
revoke all on function private.account_details(public.accounts) from public,anon,authenticated;
create or replace function private.register_caregiver_account(requested_name text,details jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare verified text:=private.verified_email();
begin
  if private.current_account() is not null then raise exception 'Account already registered.' using errcode='23505'; end if;
  if requested_name is null or length(btrim(requested_name)) not between 1 and 100 then raise exception 'Invalid registration.' using errcode='22023'; end if;
  insert into public.accounts(auth_user_id,email,display_name,role) values((select auth.uid()),verified,btrim(requested_name),'caregiver');
  perform private.save_my_caregiver(details,null);
  return private.current_account();
exception when unique_violation then raise exception 'Account already registered.' using errcode='23505';
end;
$$;
create or replace function public.register_caregiver_account(requested_name text,details jsonb) returns jsonb
language sql security invoker set search_path='' as $$ select private.register_caregiver_account(requested_name,details); $$;
revoke all on function private.register_caregiver_account(text,jsonb),public.register_caregiver_account(text,jsonb) from public,anon;
grant execute on function private.register_caregiver_account(text,jsonb),public.register_caregiver_account(text,jsonb) to authenticated;

create table if not exists public.caregiver_links (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.patients(id) on delete restrict,
  caregiver_id uuid not null references public.caregivers(account_id) on delete restrict,
  active boolean not null default true,
  version integer not null default 1 check(version>0),
  authorised_by uuid not null references public.accounts(id) on delete restrict,
  authorised_at timestamptz not null default now(),
  revoked_by uuid references public.accounts(id) on delete restrict,
  revoked_at timestamptz,
  unique(patient_id,caregiver_id),
  check((active and revoked_at is null and revoked_by is null) or (not active and revoked_at is not null and revoked_by is not null))
);
alter table public.caregiver_links enable row level security;
revoke all on public.caregiver_links from public,anon,authenticated;
-- Link lists deliberately use the scoped function below; no direct writes or bulk reads.
create index if not exists caregiver_links_active_caregiver on public.caregiver_links(caregiver_id,patient_id) where active;
-- Serialize both sides before counting, including invitations and assisted reauthorisation.
create or replace function private.check_caregiver_link_capacity() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if not new.active then return new; end if;
  perform 1 from public.patients where id=new.patient_id for update;
  perform 1 from public.accounts where id=new.caregiver_id for no key update;
  -- An already-active pair is idempotent even when either side is full.
  if exists(select 1 from public.caregiver_links where patient_id=new.patient_id and caregiver_id=new.caregiver_id and active) then return new; end if;
  if (select count(*) from public.caregiver_links where patient_id=new.patient_id and active and id<>new.id)>=5 then
    raise exception 'A patient can have at most five linked caregivers.' using errcode='P5001';
  end if;
  if (select count(*) from public.caregiver_links where caregiver_id=new.caregiver_id and active and id<>new.id)>=5 then
    raise exception 'A caregiver can have at most five linked patients.' using errcode='P5002';
  end if;
  return new;
end;
$$;
revoke all on function private.check_caregiver_link_capacity() from public,anon,authenticated;
drop trigger if exists caregiver_link_capacity on public.caregiver_links;
create trigger caregiver_link_capacity before insert or update of active,patient_id,caregiver_id on public.caregiver_links
  for each row execute function private.check_caregiver_link_capacity();
create table if not exists private.caregiver_invitations (
  id uuid primary key default gen_random_uuid(),
  caregiver_id uuid not null references public.caregivers(account_id) on delete restrict,
  code_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  used_by uuid references public.accounts(id) on delete restrict,
  revoked_at timestamptz
);
create index if not exists caregiver_invitation_owner on private.caregiver_invitations(caregiver_id,created_at desc);
create table if not exists private.caregiver_code_attempts (
  account_id uuid primary key references public.accounts(id) on delete cascade,
  window_start timestamptz not null,
  attempts integer not null check(attempts>0)
);
create table if not exists private.caregiver_link_events (
  id uuid primary key default gen_random_uuid(),link_id uuid not null references public.caregiver_links(id) on delete restrict,
  actor_id uuid not null references public.accounts(id) on delete restrict,
  event text not null check(event in ('authorised','revoked')),
  assisted boolean not null,created_at timestamptz not null default now()
);
alter table private.caregiver_invitations enable row level security;
alter table private.caregiver_code_attempts enable row level security;
alter table private.caregiver_link_events enable row level security;
revoke all on private.caregiver_invitations,private.caregiver_code_attempts,private.caregiver_link_events from public,anon,authenticated;

create or replace function private.create_caregiver_invitation() returns jsonb
language plpgsql security definer set search_path='' as $$
declare owner_id uuid:=private.caregiver_account_id(); code text:=gen_random_uuid()::text; saved private.caregiver_invitations;
begin
  if owner_id is null then raise exception 'Caregiver access required.' using errcode='42501'; end if;
  perform 1 from public.accounts a join public.caregivers c on c.account_id=a.id where a.id=owner_id and a.status='active' and a.role='caregiver' for no key update of a;
  if not found then raise exception 'An active caregiver profile is required.' using errcode='42501'; end if;
  if exists(select 1 from private.caregiver_invitations where caregiver_id=owner_id and created_at>clock_timestamp()-interval '1 minute') then return jsonb_build_object('error','invitation_rate_limited'); end if;
  update private.caregiver_invitations set revoked_at=clock_timestamp() where caregiver_id=owner_id and used_at is null and revoked_at is null;
  insert into private.caregiver_invitations(caregiver_id,code_hash,expires_at) values(owner_id,md5(code),clock_timestamp()+interval '15 minutes') returning * into saved;
  return jsonb_build_object('code',code,'expires_at',saved.expires_at);
end;
$$;

create or replace function private.review_caregiver_invitation(code text,confirmed_caregiver uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.patient_account_id(); person public.patients; invitation private.caregiver_invitations; caregiver public.caregivers; saved public.caregiver_links; attempts integer;
begin
  if actor is null then raise exception 'Patient access required.' using errcode='42501'; end if;
  select * into invitation from private.caregiver_invitations where code_hash=md5(lower(btrim(code)));
  -- Patient account precedes its profile; caregiver accounts follow that profile.
  -- This also precedes the counter INSERT's implicit foreign-key lock.
  perform 1 from public.accounts where id=actor for no key update;
  -- Invalid-code responses commit this counter; throwing would roll the limit back.
  insert into private.caregiver_code_attempts(account_id,window_start,attempts) values(actor,clock_timestamp(),1)
    on conflict(account_id) do update set attempts=case when caregiver_code_attempts.window_start<clock_timestamp()-interval '15 minutes' then 1 else caregiver_code_attempts.attempts+1 end,
      window_start=case when caregiver_code_attempts.window_start<clock_timestamp()-interval '15 minutes' then clock_timestamp() else caregiver_code_attempts.window_start end
    returning caregiver_code_attempts.attempts into attempts;
  if attempts>10 then return jsonb_build_object('error','invitation_rate_limited'); end if;
  select * into person from public.patients where account_id=actor and status='active' for update;
  if not found then raise exception 'Active patient profile required.' using errcode='42501'; end if;
  if invitation.id is null then return jsonb_build_object('error','invalid_invitation'); end if;
  perform 1 from public.accounts where id=invitation.caregiver_id for no key update;
  select c.* into caregiver from public.caregivers c join public.accounts a on a.id=c.account_id where a.id=invitation.caregiver_id and a.role='caregiver' and a.status='active';
  select * into invitation from private.caregiver_invitations where id=invitation.id for update;
  if caregiver.account_id is null or not exists(select 1 from public.accounts where id=actor and status='active' and role='patient')
    or invitation.used_at is not null or invitation.revoked_at is not null or invitation.expires_at<=clock_timestamp() then return jsonb_build_object('error','invalid_invitation'); end if;
  if confirmed_caregiver is null then return jsonb_build_object('caregiver_id',caregiver.account_id,'full_name',caregiver.full_name,'display_name',(select display_name from public.accounts where id=caregiver.account_id),'expires_at',invitation.expires_at); end if;
  if confirmed_caregiver<>caregiver.account_id then return jsonb_build_object('error','invalid_invitation'); end if;
  insert into public.caregiver_links(patient_id,caregiver_id,authorised_by) values(person.id,caregiver.account_id,actor)
    on conflict(patient_id,caregiver_id) do update set active=true,version=caregiver_links.version+1,authorised_by=actor,authorised_at=clock_timestamp(),revoked_at=null,revoked_by=null
    where not caregiver_links.active returning * into saved;
  if saved.id is not null then insert into private.caregiver_link_events(link_id,actor_id,event,assisted) values(saved.id,actor,'authorised',false);
  else select * into saved from public.caregiver_links where patient_id=person.id and caregiver_id=caregiver.account_id; end if;
  update private.caregiver_invitations set used_at=clock_timestamp(),used_by=actor where id=invitation.id;
  return jsonb_build_object('link',to_jsonb(saved));
end;
$$;

create or replace function private.manage_caregiver_link(patient uuid,caregiver uuid,link_active boolean,expected_version integer,patient_authorised boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor public.accounts; person public.patients; saved public.caregiver_links;
begin
  select * into actor from public.accounts where auth_user_id=(select auth.uid()) and status='active';
  if actor.id is null or actor.role not in ('patient','caregiver','coordinator') or link_active is null then raise exception 'Link access denied.' using errcode='42501'; end if;
  select * into person from public.patients where id=patient;
  if not found then raise exception 'Patient not found.' using errcode='P0002'; end if;
  perform 1 from public.accounts where id=person.account_id for no key update;
  select * into person from public.patients where id=patient for update;
  if not found then raise exception 'Patient not found.' using errcode='P0002'; end if;
  perform 1 from public.accounts where id in (actor.id,caregiver) order by id for no key update;
  if not exists(select 1 from public.accounts where id=actor.id and status='active' and role=actor.role)
    or (actor.role='patient' and person.account_id is distinct from actor.id) or (actor.role='caregiver' and caregiver is distinct from actor.id)
    or (link_active and (actor.role<>'coordinator' or patient_authorised is distinct from true)) then raise exception 'Link access denied.' using errcode='42501'; end if;
  select * into saved from public.caregiver_links where patient_id=patient and caregiver_id=caregiver for update;
  if (saved.id is null and expected_version is not null) or (saved.id is not null and (expected_version is null or saved.version<>expected_version)) then raise exception 'Link changed.' using errcode='PT409'; end if;
  if link_active then
    if person.status<>'active' or not exists(select 1 from public.accounts where id=person.account_id and role='patient' and status='active')
      or not exists(select 1 from public.accounts a join public.caregivers c on c.account_id=a.id where a.id=caregiver and a.role='caregiver' and a.status='active') then raise exception 'Active profiles required.' using errcode='22023'; end if;
    if saved.id is null then insert into public.caregiver_links(patient_id,caregiver_id,authorised_by) values(patient,caregiver,actor.id) returning * into saved;
    elsif not saved.active then update public.caregiver_links set active=true,version=version+1,authorised_by=actor.id,authorised_at=clock_timestamp(),revoked_by=null,revoked_at=null where id=saved.id returning * into saved;
    else return to_jsonb(saved); end if;
  else
    if saved.id is null then raise exception 'Link not found.' using errcode='P0002'; end if;
    if not saved.active then return to_jsonb(saved); end if;
    update public.caregiver_links set active=false,version=version+1,revoked_by=actor.id,revoked_at=clock_timestamp() where id=saved.id returning * into saved;
  end if;
  insert into private.caregiver_link_events(link_id,actor_id,event,assisted) values(saved.id,actor.id,case when link_active then 'authorised' else 'revoked' end,actor.role='coordinator');
  return to_jsonb(saved);
end;
$$;

create or replace function private.list_caregiver_links(patient uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor public.accounts; result jsonb;
begin
  select * into actor from public.accounts where auth_user_id=(select auth.uid()) and status='active';
  if actor.id is null or actor.role not in ('patient','caregiver','coordinator') then raise exception 'Link access denied.' using errcode='42501'; end if;
  if actor.role='coordinator' and patient is null then raise exception 'Choose a patient.' using errcode='22023'; end if;
  if patient is not null and actor.role='patient' and not exists(select 1 from public.patients where id=patient and account_id=actor.id) then raise exception 'Link access denied.' using errcode='42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',l.id,'patient_id',l.patient_id,'patient_name',p.full_name,'caregiver_id',l.caregiver_id,'caregiver_name',c.full_name,'version',l.version,'active',l.active,'authorised_at',l.authorised_at) order by p.full_name,c.full_name,l.id),'[]'::jsonb)
    into result from public.caregiver_links l join public.patients p on p.id=l.patient_id join public.caregivers c on c.account_id=l.caregiver_id
    where (l.active or actor.role='coordinator') and (patient is null or l.patient_id=patient) and (actor.role='coordinator' or (actor.role='patient' and p.account_id=actor.id) or (actor.role='caregiver' and l.caregiver_id=actor.id));
  return jsonb_build_object('links',result);
end;
$$;
-- Coordinator directory keeps search, filtering and pagination inside the authorised query.
create or replace function private.list_coordinator_caregivers(page_no integer,search_text text,status_filter text,sort_by text,sort_order text) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
begin
  if not private.is_coordinator() then raise exception 'Coordinator access required.' using errcode='42501'; end if;
  if page_no is null or page_no<1 or page_no>1000000 or search_text is null or length(search_text)>100 or search_text ~ '[[:cntrl:]]'
    or status_filter is null or status_filter not in ('all','active','inactive','active,inactive','inactive,active')
    or sort_by is null or sort_by not in ('created_at','id','full_name','phone','status') or sort_order is null or sort_order not in ('asc','desc') then
    raise exception 'Invalid caregiver search.' using errcode='22023';
  end if;
  return (with visible as materialized (
    select c.account_id as id,c.full_name,c.phone,c.birth_date,c.gender,c.version,c.created_at,a.status,a.status_version
    from public.caregivers c join public.accounts a on a.id=c.account_id where a.role='caregiver'
      and (status_filter='all' or a.status=any(string_to_array(status_filter,',')))
      and (btrim(search_text)='' or strpos(lower(c.full_name),lower(btrim(search_text)))>0 or strpos(c.phone,btrim(search_text))>0 or strpos(c.account_id::text,lower(btrim(search_text)))>0)
  ), ordered as (
    select visible.*,row_number() over(order by
      case when sort_by='created_at' and sort_order='asc' then created_at end asc,
      case when sort_by='created_at' and sort_order='desc' then created_at end desc,
      case when sort_order='asc' then case sort_by when 'id' then id::text when 'full_name' then lower(full_name) when 'phone' then phone when 'status' then status end end asc,
      case when sort_order='desc' then case sort_by when 'id' then id::text when 'full_name' then lower(full_name) when 'phone' then phone when 'status' then status end end desc,id) as list_order from visible
  ) select jsonb_build_object('caregivers',(select coalesce(jsonb_agg(to_jsonb(p)-'list_order' order by list_order),'[]'::jsonb) from (select * from ordered order by list_order limit 10 offset (page_no::bigint-1)*10) p),
    'total',(select count(*) from visible),'page',page_no,'pageSize',10));
end;
$$;
create or replace function private.coordinator_caregiver_links(target uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  if not private.is_coordinator() then raise exception 'Coordinator access required.' using errcode='42501'; end if;
  if not exists(select 1 from public.caregivers c join public.accounts a on a.id=c.account_id where c.account_id=target and a.role='caregiver') then raise exception 'Caregiver not found.' using errcode='P0002'; end if;
  return jsonb_build_object('links',(select coalesce(jsonb_agg(jsonb_build_object('id',l.id,'patient_id',l.patient_id,'patient_name',p.full_name,'active',l.active) order by p.full_name,l.id),'[]'::jsonb)
    from public.caregiver_links l join public.patients p on p.id=l.patient_id where l.caregiver_id=target));
end;
$$;
create or replace function private.set_caregiver_status(target uuid,decision text,expected_version integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid; saved public.accounts;
begin
  if not private.is_coordinator() then raise exception 'Coordinator access required.' using errcode='42501'; end if;
  if decision is null or decision not in ('active','inactive') or expected_version is null or expected_version<1 then raise exception 'Invalid caregiver status.' using errcode='22023'; end if;
  select id into actor from public.accounts where auth_user_id=(select auth.uid());
  perform 1 from public.accounts where id in (actor,target) order by id for update;
  if not private.is_coordinator() then raise exception 'Coordinator access required.' using errcode='42501'; end if;
  select * into saved from public.accounts where id=target and role='caregiver';
  if not found or not exists(select 1 from public.caregivers where account_id=target) then raise exception 'Caregiver not found.' using errcode='P0002'; end if;
  if saved.status_version<>expected_version then raise exception 'Caregiver changed.' using errcode='PT409'; end if;
  update public.accounts set status=decision where id=target returning * into saved;
  return jsonb_build_object('id',saved.id,'status',saved.status,'status_version',saved.status_version);
end;
$$;
create or replace function public.list_coordinator_caregivers(page_no integer,search_text text,status_filter text,sort_by text,sort_order text) returns jsonb
language sql stable security invoker set search_path='' as $$ select private.list_coordinator_caregivers(page_no,search_text,status_filter,sort_by,sort_order); $$;
create or replace function public.coordinator_caregiver_links(target uuid) returns jsonb
language sql stable security invoker set search_path='' as $$ select private.coordinator_caregiver_links(target); $$;
create or replace function public.set_caregiver_status(target uuid,decision text,expected_version integer) returns jsonb
language sql security invoker set search_path='' as $$ select private.set_caregiver_status(target,decision,expected_version); $$;
revoke all on function private.list_coordinator_caregivers(integer,text,text,text,text),public.list_coordinator_caregivers(integer,text,text,text,text),private.coordinator_caregiver_links(uuid),public.coordinator_caregiver_links(uuid),private.set_caregiver_status(uuid,text,integer),public.set_caregiver_status(uuid,text,integer) from public,anon;
grant execute on function private.list_coordinator_caregivers(integer,text,text,text,text),public.list_coordinator_caregivers(integer,text,text,text,text),private.coordinator_caregiver_links(uuid),public.coordinator_caregiver_links(uuid),private.set_caregiver_status(uuid,text,integer),public.set_caregiver_status(uuid,text,integer) to authenticated;

create or replace function private.caregiver_can_access_patient(target uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.caregiver_links l join public.patients p on p.id=l.patient_id
    join public.accounts pa on pa.id=p.account_id join public.caregivers c on c.account_id=l.caregiver_id
    where l.patient_id=target and l.caregiver_id=private.caregiver_account_id() and l.active
      and p.status='active' and pa.status='active' and pa.role='patient');
$$;
revoke all on function private.caregiver_can_access_patient(uuid) from public,anon;
grant execute on function private.caregiver_can_access_patient(uuid) to authenticated;
create or replace function public.create_caregiver_invitation() returns jsonb
language sql security invoker set search_path='' as $$ select private.create_caregiver_invitation(); $$;
create or replace function public.review_caregiver_invitation(code text,confirmed_caregiver uuid) returns jsonb
language sql security invoker set search_path='' as $$ select private.review_caregiver_invitation(code,confirmed_caregiver); $$;
create or replace function public.manage_caregiver_link(patient uuid,caregiver uuid,link_active boolean,expected_version integer,patient_authorised boolean) returns jsonb
language sql security invoker set search_path='' as $$ select private.manage_caregiver_link(patient,caregiver,link_active,expected_version,patient_authorised); $$;
create or replace function public.list_caregiver_links(patient uuid) returns jsonb
language sql stable security invoker set search_path='' as $$ select private.list_caregiver_links(patient); $$;
revoke all on function private.create_caregiver_invitation(),public.create_caregiver_invitation(),private.review_caregiver_invitation(text,uuid),public.review_caregiver_invitation(text,uuid),private.manage_caregiver_link(uuid,uuid,boolean,integer,boolean),public.manage_caregiver_link(uuid,uuid,boolean,integer,boolean),private.list_caregiver_links(uuid),public.list_caregiver_links(uuid) from public,anon;
grant execute on function private.create_caregiver_invitation(),public.create_caregiver_invitation(),private.review_caregiver_invitation(text,uuid),public.review_caregiver_invitation(text,uuid),private.manage_caregiver_link(uuid,uuid,boolean,integer,boolean),public.manage_caregiver_link(uuid,uuid,boolean,integer,boolean),private.list_caregiver_links(uuid),public.list_caregiver_links(uuid) to authenticated;

-- Relationship notices contain no patient identifiers and remain readable after unlinking.
-- Transport notices continue to require current consent on every inbox operation.
create or replace function private.notify_caregiver_link() returns trigger
language plpgsql security definer set search_path='' as $$
declare relationship public.caregiver_links; patient_account uuid;
begin
  select * into relationship from public.caregiver_links where id=new.link_id;
  select account_id into patient_account from public.patients where id=relationship.patient_id;
  insert into public.trip_notifications(recipient_id,notice_kind,event,message)
    select a.id,'link','caregiver_'||new.event,
      case when a.id=patient_account then
        case when new.event='authorised' then 'A caregiver is now linked to you' else 'A caregiver has been unlinked' end
      else case when new.event='authorised' then 'A patient is now linked to you' else 'A patient has been unlinked' end end
    from public.accounts a where a.status='active' and a.id in (patient_account,relationship.caregiver_id)
      and (new.event='authorised' or a.id<>new.actor_id);
  return null;
end;
$$;
revoke all on function private.notify_caregiver_link() from public,anon,authenticated;
drop trigger if exists caregiver_link_notification on private.caregiver_link_events;
create trigger caregiver_link_notification after insert on private.caregiver_link_events
  for each row execute function private.notify_caregiver_link();

create or replace function private.notify_shared_schedule() returns trigger
language plpgsql security definer set search_path='' as $$
declare actor public.accounts; patient_account uuid; action_label text; event_name text;
begin
  select * into actor from public.accounts where auth_user_id=(select auth.uid()) and status='active';
  if actor.id is null then return null; end if;
  if tg_table_name='treatment_schedules' then
    -- Coordinator-approved replacements have their own change-decision notice.
    if actor.role not in ('patient','caregiver') then return null; end if;
    action_label:='created a treatment schedule';event_name:='schedule_created';
  else
    if tg_op='UPDATE' and new.status is not distinct from old.status then return null; end if;
    action_label:=case new.status when 'pending' then 'requested a schedule change'
      when 'withdrawn' then 'withdrew a schedule change request'
      when 'approved' then 'approved a schedule change' when 'rejected' then 'rejected a schedule change' end;
    event_name:='schedule_change_'||new.status;
  end if;
  if action_label is null then return null; end if;
  select account_id into patient_account from public.patients where id=new.patient_id and status='active';
  if patient_account is null or not exists(select 1 from public.accounts where id=patient_account and status='active') then return null; end if;
  insert into public.trip_notifications(recipient_id,notice_kind,patient_id,event,message)
    select a.id,'schedule',new.patient_id,event_name,
      case actor.role when 'caregiver' then 'Caregiver ' when 'patient' then 'Patient ' else 'Coordinator ' end||action_label
    from public.accounts a where a.status='active' and a.id<>actor.id and (
      a.id=patient_account or (a.role='caregiver' and exists(select 1 from public.caregiver_links l
        join public.caregivers c on c.account_id=l.caregiver_id
        where l.patient_id=new.patient_id and l.caregiver_id=a.id and l.active)));
  return null;
end;
$$;
revoke all on function private.notify_shared_schedule() from public,anon,authenticated;
drop trigger if exists shared_schedule_notification on public.treatment_schedules;
create trigger shared_schedule_notification after insert on public.treatment_schedules
  for each row execute function private.notify_shared_schedule();
drop trigger if exists shared_schedule_change_notification on public.treatment_change_requests;
create trigger shared_schedule_change_notification after insert or update of status on public.treatment_change_requests
  for each row execute function private.notify_shared_schedule();

-- Demo fixtures are private and all controls require the backend service identity.
create table if not exists private.demo_scenarios (
  owner_id uuid primary key references public.accounts(id) on delete restrict,
  schedule_id uuid references public.treatment_schedules(id) on delete restrict,
  trip_id uuid references public.trips(id) on delete restrict,
  traffic text not null default 'normal' check(traffic in ('normal','delay')),
  progress integer not null default 0 check(progress between 0 and 100)
);
update public.trips t set demo_clock_at=coalesce(t.pickup_at,t.pickup_not_before,t.arrival_by-make_interval(mins=>t.duration_minutes))-interval '15 minutes'
  from private.demo_scenarios s where s.trip_id=t.id and s.owner_id=t.demo_owner_id
    and t.lifecycle='scheduled' and t.first_started_at is null and t.deleted_at is null and t.demo_clock_at is null;
alter table private.demo_scenarios enable row level security;
revoke all on private.demo_scenarios from public,anon,authenticated;

create or replace function private.apply_demo_traffic() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.demo_owner_id is not null and new.deleted_at is null and new.assigned_driver_id is not null and new.lifecycle in ('scheduled','in-progress')
    and exists(select 1 from private.demo_scenarios s where s.trip_id=new.id and s.owner_id=new.demo_owner_id and s.traffic='delay') then
    new.traffic_review_required:=true; new.status:='at-risk';
  end if;
  return new;
end;
$$;
revoke all on function private.apply_demo_traffic() from public,anon,authenticated;
-- Run after trips_version, which clears old risk when reservations change.
drop trigger if exists zz_demo_traffic on public.trips;
create trigger zz_demo_traffic before insert or update on public.trips for each row execute function private.apply_demo_traffic();

-- Tag generated journeys automatically, and prevent mixing real/demo resources even
-- when an ordinary assignment or recovery RPC is called directly.
create or replace function private.enforce_demo_trip_scope() returns trigger
language plpgsql security definer set search_path='' as $$
declare cohort_owner uuid;
begin
  select coalesce(a.demo_owner_id,s.owner_id) into cohort_owner from public.patients p join public.accounts a on a.id=p.account_id left join private.seeded_accounts s on s.account_id=a.id where p.id=new.patient_id;
  if tg_op='UPDATE' and old.demo_owner_id is distinct from cohort_owner then raise exception 'Demo ownership cannot change.' using errcode='42501'; end if;
  new.demo_owner_id:=cohort_owner;
  if new.assigned_driver_id is not null and not exists(select 1 from public.accounts a where a.id=new.assigned_driver_id and (a.demo_owner_id is not distinct from cohort_owner or exists(select 1 from private.seeded_accounts s where s.account_id=a.id and s.owner_id=cohort_owner))) then
    raise exception 'Real and demo bookings cannot share drivers.' using errcode='42501';
  end if;
  return new;
end;
$$;
revoke all on function private.enforce_demo_trip_scope() from public,anon,authenticated;
drop trigger if exists demo_trip_scope on public.trips;
create trigger demo_trip_scope before insert or update on public.trips for each row execute function private.enforce_demo_trip_scope();
create or replace function private.enforce_demo_link_scope() returns trigger
language plpgsql security definer set search_path='' as $$
declare patient_owner uuid; caregiver_owner uuid;
begin
  select coalesce(a.demo_owner_id,s.owner_id) into patient_owner from public.patients p join public.accounts a on a.id=p.account_id left join private.seeded_accounts s on s.account_id=a.id where p.id=new.patient_id;
  select coalesce(a.demo_owner_id,s.owner_id) into caregiver_owner from public.accounts a left join private.seeded_accounts s on s.account_id=a.id where a.id=new.caregiver_id;
  if patient_owner is distinct from caregiver_owner then raise exception 'Real and demo accounts cannot be linked.' using errcode='42501'; end if;
  return new;
end;
$$;
revoke all on function private.enforce_demo_link_scope() from public,anon,authenticated;
drop trigger if exists demo_link_scope on public.caregiver_links;
create trigger demo_link_scope before insert or update on public.caregiver_links for each row execute function private.enforce_demo_link_scope();

create or replace function private.demo_manage(owner uuid,action text,details jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor public.accounts; patient public.patients; scene private.demo_scenarios;
  journey public.trips; session_start timestamptz; session_end timestamptz; session_day date;
  centre public.dialysis_centres; schedule public.treatment_schedules; pickup timestamptz;
  point jsonb;
  original_claims text; original_sub text; owner_auth uuid; result jsonb;
  operator_id uuid:=owner; cohort_owner uuid;
begin
  if not private.demo_administrator(operator_id) then
    raise exception 'Demo administrator required.' using errcode='42501';
  end if;
  -- Service-only entry point; existing schedule/link triggers still see the verified
  -- coordinator actor. Keep role=service_role for the narrowly scoped reset guard.
  select auth_user_id into owner_auth from public.accounts where id=owner and role='coordinator' and status='active' and demo_admin and demo_owner_id is null for share;
  if owner_auth is null then raise exception 'Sign in as the demo administrator first.' using errcode='42501'; end if;
  -- Keep the caller as the verified actor, but operate on the existing shared cohort.
  -- Reject ambiguous registries instead of silently choosing another set of identities.
  if (select count(distinct s.owner_id) from private.seeded_accounts s)>1 then
    raise exception 'Expected one shared demo cohort.' using errcode='P5003';
  end if;
  select s.owner_id into cohort_owner from private.seeded_accounts s limit 1;
  owner:=coalesce(cohort_owner,operator_id);
  original_claims:=current_setting('request.jwt.claims',true); original_sub:=current_setting('request.jwt.claim.sub',true);
  perform set_config('request.jwt.claims',(coalesce(nullif(original_claims,''),'{}')::jsonb||jsonb_build_object('sub',owner_auth::text))::text,true);
  perform set_config('request.jwt.claim.sub',owner_auth::text,true);
  -- Serialize setup/reset/control for this owner's fixtures, not unrelated bookings.
  perform pg_advisory_xact_lock(hashtextextended('demo:'||owner::text,0));
  if action='setup' then
    if (select count(*) from private.seeded_accounts s where s.owner_id=owner)<>10 then
      raise exception 'Apply database/seed.sql before preparing the seeded accounts.' using errcode='P5003';
    end if;
    insert into private.demo_scenarios(owner_id) values(owner) on conflict do nothing;
  end if;
  select * into scene from private.demo_scenarios where owner_id=owner for update;
  if not found and action<>'state' then raise exception 'Prepare the demo first.' using errcode='22023'; end if;
  if action='attach' then
    select a.* into actor from public.accounts a join private.seeded_accounts s on s.account_id=a.id
      where a.id=(details->>'account_id')::uuid and s.owner_id=owner for update of a;
    if not found or not exists(select 1 from auth.users u where u.id=actor.id and u.email=actor.email and u.email_confirmed_at is not null
      and u.raw_app_meta_data->>'demo_account_id'=actor.id::text and u.raw_app_meta_data->>'demo_owner_id'=owner::text) then
      raise exception 'Invalid demo identity.' using errcode='42501';
    end if;
    update public.accounts set auth_user_id=actor.id where id=actor.id and (auth_user_id is null or auth_user_id=actor.id);
    if not found then raise exception 'Identity already linked.' using errcode='42501'; end if;
  elsif action='reset' or (action='setup' and scene.trip_id is null) then
    if action='reset' and details->'confirmed' is distinct from 'true'::jsonb then raise exception 'Confirm demo reset.' using errcode='22023'; end if;
    select p.* into patient from public.patients p join private.seeded_accounts s on s.account_id=p.account_id where s.owner_id=owner and s.seed_key='patient1' for update of p;
    perform 1 from public.accounts a join private.seeded_accounts s on s.account_id=a.id where s.owner_id=owner and a.role='driver' order by a.id for update of a;
    perform set_config('app.demo_reset_owner',owner::text,true);
    -- Keep historical fixtures and feedback; archive only this scenario's journey.
    if scene.trip_id is not null then
      update public.trips set deleted_at=now(),updated_at=now() where id=scene.trip_id and demo_owner_id=owner;
      insert into public.trip_history(trip_id,actor_id,event,details) values(scene.trip_id,operator_id,'deleted',jsonb_build_object('demo_reset',true));
    end if;
    -- Preserve the reused drivers' real saved availability rather than forcing
    -- all-day fixtures. Pick a daytime window with enough room for route planning.
    select candidate+interval '90 minutes' into session_start
      from generate_series(date_trunc('hour',now()+interval '1 hour'),now()+interval '7 days',interval '30 minutes') candidate
      where (candidate at time zone 'Asia/Singapore')::time between time '06:00' and time '20:00'
        and exists(select 1 from private.seeded_accounts membership join public.accounts a on a.id=membership.account_id
          join public.driver_vehicles v on v.driver_id=a.id
          where membership.owner_id=owner and a.role='driver' and a.status='active' and v.status='approved'
            and private.driver_covers_window(a.id,candidate,candidate+interval '2 hours')
            and not exists(select 1 from public.trips t where t.assigned_driver_id=a.id and t.deleted_at is null
              and t.pickup_at<candidate+interval '2 hours' and private.effective_trip_end(t)>candidate))
      order by candidate limit 1;
    if session_start is null then raise exception 'Set availability for a seeded driver before preparing the walkthrough.' using errcode='22023'; end if;
    session_end:=session_start+interval '1 hour'; session_day:=(session_start at time zone 'Asia/Singapore')::date;
    select * into centre from public.dialysis_centres order by (postal_code='640491') desc,id limit 1;
    if centre.id is null then raise exception 'Dialysis centre directory is required.' using errcode='22023'; end if;
    if scene.schedule_id is null then
      insert into public.treatment_schedules(patient_id,centre_id,days,start_time,end_time,effective_from,effective_to,kind)
        values(patient.id,centre.id,array[extract(isodow from session_day)::integer],(session_start at time zone 'Asia/Singapore')::time,
          (session_end at time zone 'Asia/Singapore')::time,session_day,session_day,'single') returning * into schedule;
    else
      update public.treatment_schedules set days=array[extract(isodow from session_day)::integer],start_time=(session_start at time zone 'Asia/Singapore')::time,
        end_time=(session_end at time zone 'Asia/Singapore')::time,effective_from=session_day,effective_to=session_day,version=version+1
        where id=scene.schedule_id and patient_id=patient.id returning * into schedule;
    end if;
    insert into public.trips(patient_id,patient_name,source_schedule_id,root_schedule_id,occurrence_key,original_session_date,session_date,direction,origin,destination,
      treatment_start,treatment_end,arrival_by,source_version,patient_version,created_by,demo_clock_at)
      values(patient.id,patient.full_name,schedule.id,schedule.id,'demo:'||gen_random_uuid()::text,session_day,session_day,'outbound',
        patient.pickup_address||', Singapore '||patient.postal_code,centre.address||', Singapore '||centre.postal_code,
        session_start,session_end,session_start-interval '15 minutes',schedule.version,patient.version,operator_id,session_start-interval '90 minutes') returning * into journey;
    insert into public.trip_history(trip_id,actor_id,event,details) values(journey.id,operator_id,'generated',jsonb_build_object('demo',true));
    update private.demo_scenarios set schedule_id=schedule.id,trip_id=journey.id,traffic='normal',progress=0 where owner_id=owner;
  elsif action in ('due','traffic','move') then
    select * into journey from public.trips where id=scene.trip_id and demo_owner_id=owner and deleted_at is null;
    if not found then raise exception 'Demo trip not found.' using errcode='P0002'; end if;
    perform 1 from public.patients where id=journey.patient_id for update;
    perform 1 from public.accounts a join private.seeded_accounts s on s.account_id=a.id where a.id=journey.assigned_driver_id and s.owner_id=owner for update of a;
    select * into journey from public.trips where id=scene.trip_id and demo_owner_id=owner and deleted_at is null for update;
    if action='due' then
      if journey.lifecycle<>'scheduled' or journey.assigned_driver_id is null then raise exception 'Assign an upcoming demo trip first.' using errcode='22023'; end if;
      -- Activate a clock at the reservation; never move the booking to wall time.
      -- Repeated clicks keep the original anchor rather than rewinding the run.
      if journey.demo_clock_started_at is null then
        pickup:=journey.pickup_at;
        if pickup is null or not private.driver_covers_window(journey.assigned_driver_id,pickup,pickup+make_interval(mins=>journey.duration_minutes)) or exists(
          select 1 from public.trips t where t.id<>journey.id and t.deleted_at is null and t.lifecycle in ('scheduled','in-progress')
            and (t.assigned_driver_id=journey.assigned_driver_id or t.patient_id=journey.patient_id)
            and t.pickup_at<pickup+make_interval(mins=>journey.duration_minutes) and private.effective_trip_end(t)>pickup) then
          raise exception 'Demo timing conflicts with availability or another booking.' using errcode='PT409';
        end if;
        update public.trips set demo_clock_at=pickup,demo_clock_started_at=now(),updated_at=now() where id=journey.id;
      end if;
    elsif action='traffic' then
      if details->>'scenario' not in ('normal','delay') or details->>'scenario' is null then raise exception 'Invalid demo traffic.' using errcode='22023'; end if;
      if journey.lifecycle not in ('scheduled','in-progress') then raise exception 'Demo journey has ended.' using errcode='22023'; end if;
      update private.demo_scenarios set traffic=details->>'scenario' where owner_id=owner;
      if journey.assigned_driver_id is not null then
        update public.trips set traffic_review_required=(details->>'scenario'='delay'),
          status=case when details->>'scenario'='delay' or driver_unavailable_at is not null or review_required or recovery_critical then 'at-risk' else 'on-track' end where id=journey.id;
        insert into public.trip_history(trip_id,actor_id,event,details) values(journey.id,operator_id,
          case when details->>'scenario'='delay' then 'traffic_risk_detected' else 'traffic_risk_cleared' end,jsonb_build_object('simulated',true));
      end if;
    else
      if journey.lifecycle<>'in-progress' or journey.assigned_driver_id is null then raise exception 'Start the demo trip first.' using errcode='22023'; end if;
      if jsonb_typeof(details->'percent') is distinct from 'number' or (details->>'percent')::numeric not between 0 and 100
        or jsonb_typeof(details->'point') is distinct from 'object' then raise exception 'Invalid simulated position.' using errcode='22023'; end if;
      point:=details->'point';
      if (point->>'latitude')::numeric not between 1.144 and 1.494 or (point->>'longitude')::numeric not between 103.535 and 104.502 then raise exception 'Invalid simulated position.' using errcode='22023'; end if;
      insert into public.trip_locations(trip_id,driver_id,latitude,longitude,accuracy_metres,recorded_at,received_at)
        values(journey.id,journey.assigned_driver_id,(point->>'latitude')::double precision,(point->>'longitude')::double precision,5,now(),now())
        on conflict(trip_id) do update set driver_id=excluded.driver_id,latitude=excluded.latitude,longitude=excluded.longitude,
          accuracy_metres=5,recorded_at=now(),received_at=now();
      update private.demo_scenarios set progress=(details->>'percent')::integer where owner_id=owner;
    end if;
  elsif action not in ('state','setup','attach') then raise exception 'Invalid demo action.' using errcode='22023';
  end if;
  result:=jsonb_build_object('cohort_owner_id',owner,'operator_id',operator_id,
    'actors',(select coalesce(jsonb_agg(private.account_details(a) order by s.seed_key),'[]'::jsonb) from public.accounts a join private.seeded_accounts s on s.account_id=a.id where s.owner_id=owner),
    'scenario',(select to_jsonb(s) from private.demo_scenarios s where s.owner_id=owner),
    'trip',(select to_jsonb(t) from public.trips t join private.demo_scenarios s on s.trip_id=t.id where s.owner_id=owner),
    'visible_actor_ids',(select coalesce(jsonb_agg(a.id),'[]'::jsonb) from private.seeded_accounts s join public.accounts a on a.id=s.account_id
      where s.owner_id=owner and a.status='active' and exists(select 1 from private.demo_scenarios visible_scene join public.trips t on t.id=visible_scene.trip_id join public.patients p on p.id=t.patient_id
        where visible_scene.owner_id=owner and t.deleted_at is null and (a.role='coordinator' or (a.role='patient' and p.account_id=a.id)
          or (a.role='driver' and a.id=t.assigned_driver_id) or (a.role='caregiver' and exists(select 1 from public.caregiver_links l where l.patient_id=p.id and l.caregiver_id=a.id and l.active))))));
  perform set_config('request.jwt.claims',coalesce(original_claims,''),true);
  perform set_config('request.jwt.claim.sub',coalesce(original_sub,''),true);
  return result;
end;
$$;
create or replace function public.demo_manage(owner uuid,action text,details jsonb) returns jsonb
language sql security invoker set search_path='' as $$ select private.demo_manage(owner,action,details); $$;
create or replace function private.demo_trip_context(target uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object('traffic',coalesce(s.traffic,'normal'),'progress',coalesce(s.progress,0)) from public.trips t
    join public.accounts owner on owner.id=t.demo_owner_id left join private.demo_scenarios s on s.trip_id=t.id and s.owner_id=t.demo_owner_id
    where t.id=target and t.deleted_at is null
      and owner.role='coordinator' and private.demo_administrator();
$$;
create or replace function public.demo_trip_context(target uuid) returns jsonb
language sql stable security invoker set search_path='' as $$ select private.demo_trip_context(target); $$;
revoke all on function private.demo_manage(uuid,text,jsonb),public.demo_manage(uuid,text,jsonb),private.demo_trip_context(uuid),public.demo_trip_context(uuid) from public,anon,authenticated;
do $$ begin if exists(select 1 from pg_roles where rolname='service_role') then
  grant usage on schema private to service_role;
  grant execute on function private.demo_manage(uuid,text,jsonb),public.demo_manage(uuid,text,jsonb),private.demo_trip_context(uuid),public.demo_trip_context(uuid) to service_role;
end if; end; $$;

-- UC-13: recipient-owned Calendar credentials and durable, leased reminder work.
-- Only the backend service identity can read these tables; no browser token access.
create table if not exists public.calendar_connections (
  account_id uuid primary key references public.accounts(id) on delete cascade,
  encrypted_tokens text,
  google_subject text,
  status text not null default 'reconnect' check(status in ('connected','reconnect','disconnecting')),
  version integer not null default 1,
  updated_at timestamptz not null default now()
);
alter table public.calendar_connections add column if not exists google_subject text;
alter table public.calendar_connections add column if not exists cleanup_token uuid;
alter table public.calendar_connections add column if not exists cleanup_until timestamptz;
alter table public.calendar_connections drop constraint if exists calendar_connections_status_check;
alter table public.calendar_connections add constraint calendar_connections_status_check check(status in ('connected','reconnect','disconnecting','disconnected'));
create table if not exists public.calendar_oauth_states (
  state_hash text primary key,
  account_id uuid not null references public.calendar_connections(account_id) on delete cascade,
  connection_version integer not null,
  verifier text not null,
  encrypted_tokens text,
  google_subject text,
  expires_at timestamptz not null
);
alter table public.calendar_oauth_states add column if not exists encrypted_tokens text;
alter table public.calendar_oauth_states add column if not exists google_subject text;
create table if not exists public.calendar_reminders (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.calendar_connections(account_id) on delete cascade,
  trip_id uuid not null references public.trips(id) on delete cascade,
  minutes integer default null check(minutes in (15,30,60,120,1440)),
  enabled boolean not null default true,
  revision bigint not null default 1,
  synced_revision bigint not null default 0,
  event_id uuid not null default gen_random_uuid(),
  sync_status text not null default 'pending' check(sync_status in ('pending','synced','retry','reconnect')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  lease_token uuid,
  lease_until timestamptz,
  unique(account_id,trip_id)
);
alter table public.calendar_reminders alter column minutes drop not null;
alter table public.calendar_reminders alter column minutes set default null;
alter table public.calendar_reminders add column if not exists event_id uuid not null default gen_random_uuid();
create index if not exists calendar_reminders_pending on public.calendar_reminders(next_attempt_at) where revision<>synced_revision;
alter table public.calendar_connections enable row level security;
alter table public.calendar_oauth_states enable row level security;
alter table public.calendar_reminders enable row level security;
revoke all on public.calendar_connections,public.calendar_oauth_states,public.calendar_reminders from public,anon,authenticated;
do $$ begin if exists(select 1 from pg_roles where rolname='service_role') then
  grant select,insert,update,delete on public.calendar_connections,public.calendar_oauth_states,public.calendar_reminders to service_role;
end if; end $$;

create or replace function private.calendar_trip_allowed(recipient uuid,target uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.accounts a join public.trips t on t.id=target
    join public.patients p on p.id=t.patient_id join public.accounts pa on pa.id=p.account_id
    where a.id=recipient and a.status='active' and a.role in ('patient','caregiver')
      and a.demo_owner_id is null and not exists(select 1 from private.seeded_accounts s where s.account_id=a.id)
      and t.demo_owner_id is null and p.status='active' and pa.status='active' and pa.role='patient'
      and ((a.role='patient' and p.account_id=a.id) or (a.role='caregiver' and exists(
        select 1 from public.caregiver_links l where l.caregiver_id=a.id and l.patient_id=p.id and l.active))));
$$;
revoke all on function private.calendar_trip_allowed(uuid,uuid) from public,anon,authenticated;

-- Every queued change increments revision; old in-flight work cannot acknowledge a newer change.
create or replace function private.calendar_dirty() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if tg_table_name='trips' then
    if row(new.pickup_at,new.dropoff_at,new.session_date,new.origin,new.destination,new.lifecycle,new.deleted_at,new.assigned_driver_id)
       is not distinct from row(old.pickup_at,old.dropoff_at,old.session_date,old.origin,old.destination,old.lifecycle,old.deleted_at,old.assigned_driver_id) then return new; end if;
    update public.calendar_reminders set enabled=case when new.lifecycle='cancelled' and old.lifecycle<>'cancelled' then false else enabled end,revision=revision+1,sync_status='pending',next_attempt_at=now(),attempts=0 where trip_id=new.id;
  elsif tg_table_name='caregiver_links' then
    update public.calendar_reminders r set revision=revision+1,sync_status='pending',next_attempt_at=now(),attempts=0
      where r.account_id=coalesce(new.caregiver_id,old.caregiver_id) and r.trip_id in(select id from public.trips where patient_id=coalesce(new.patient_id,old.patient_id));
  elsif tg_table_name='patients' then
    if new.status is not distinct from old.status then return new; end if;
    update public.calendar_reminders set revision=revision+1,sync_status='pending',next_attempt_at=now(),attempts=0 where trip_id in(select id from public.trips where patient_id=new.id);
  elsif tg_table_name='calendar_connections' then
    if row(new.status,new.version) is not distinct from row(old.status,old.version) then return new; end if;
    update public.calendar_reminders set revision=revision+1,sync_status='pending',next_attempt_at=now(),attempts=0 where account_id=new.account_id;
  else
    if row(new.status,new.role) is not distinct from row(old.status,old.role) then return new; end if;
    update public.calendar_reminders set revision=revision+1,sync_status='pending',next_attempt_at=now(),attempts=0
      where account_id=new.id or trip_id in(select t.id from public.trips t join public.patients p on p.id=t.patient_id where p.account_id=new.id);
  end if;
  return coalesce(new,old);
end;
$$;
revoke all on function private.calendar_dirty() from public,anon,authenticated;
drop trigger if exists calendar_trip_changed on public.trips;
create trigger calendar_trip_changed after update on public.trips for each row execute function private.calendar_dirty();
drop trigger if exists calendar_link_changed on public.caregiver_links;
create trigger calendar_link_changed after insert or update or delete on public.caregiver_links for each row execute function private.calendar_dirty();
drop trigger if exists calendar_account_changed on public.accounts;
create trigger calendar_account_changed after update on public.accounts for each row execute function private.calendar_dirty();
drop trigger if exists calendar_patient_changed on public.patients;
create trigger calendar_patient_changed after update on public.patients for each row execute function private.calendar_dirty();
drop trigger if exists calendar_connection_changed on public.calendar_connections;
create trigger calendar_connection_changed after update on public.calendar_connections for each row execute function private.calendar_dirty();

-- Called with the user's JWT as well as verified at the API, so opt-in cannot outlive link access.
create or replace function public.calendar_set_reminder(target uuid,reminder_minutes integer,desired boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare recipient uuid; saved public.calendar_reminders; journey public.trips;
begin
  select id into recipient from public.accounts where auth_user_id=(select auth.uid()) and status='active' and role in ('patient','caregiver');
  perform private.verified_email();
  if recipient is null or not private.calendar_trip_allowed(recipient,target) then raise exception 'Calendar access denied.' using errcode='42501'; end if;
  if (reminder_minutes is not null and reminder_minutes not in (15,30,60,120,1440)) or desired is null then raise exception 'Invalid reminder.' using errcode='22023'; end if;
  perform 1 from public.calendar_connections where account_id=recipient and status='connected' for update;
  if not found then raise exception 'Connect Calendar first.' using errcode='22023'; end if;
  select * into journey from public.trips where id=target for share;
  if journey.deleted_at is not null then raise exception 'Trip unavailable.' using errcode='22023'; end if;
  insert into public.calendar_reminders(account_id,trip_id,minutes,enabled) values(recipient,target,reminder_minutes,desired)
    on conflict(account_id,trip_id) do update set minutes=excluded.minutes,enabled=excluded.enabled,revision=calendar_reminders.revision+1,sync_status='pending',next_attempt_at=now(),attempts=0
    returning * into saved;
  return jsonb_build_object('enabled',saved.enabled,'minutes',saved.minutes,'sync_status',saved.sync_status);
end;
$$;
revoke all on function public.calendar_set_reminder(uuid,integer,boolean) from public,anon;
grant execute on function public.calendar_set_reminder(uuid,integer,boolean) to authenticated;

create or replace function public.calendar_claim_jobs() returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  if coalesce(current_setting('request.jwt.claims',true),'{}')::jsonb->>'role' is distinct from 'service_role' then raise exception 'Service access required.' using errcode='42501'; end if;
  with candidates as (
    select r.id from public.calendar_reminders r join public.calendar_connections c on c.account_id=r.account_id
      where r.revision<>r.synced_revision and r.next_attempt_at<=now() and (r.lease_until is null or r.lease_until<now())
        and c.status in ('connected','disconnecting') order by r.next_attempt_at,r.id limit 5 for update of r skip locked
  ), claimed as (
    update public.calendar_reminders r set lease_token=gen_random_uuid(),lease_until=now()+interval '2 minutes'
      from candidates c where r.id=c.id returning r.*
  ) select coalesce(jsonb_agg(to_jsonb(r)||jsonb_build_object('desired',r.enabled and c.status='connected' and private.calendar_trip_allowed(r.account_id,r.trip_id)
      and t.deleted_at is null,
      'pickup_at',t.pickup_at,'dropoff_at',t.dropoff_at,'session_date',t.session_date,'lifecycle',t.lifecycle,'origin',t.origin,'destination',t.destination)), '[]'::jsonb)
    into result from claimed r join public.trips t on t.id=r.trip_id join public.calendar_connections c on c.account_id=r.account_id;
  return result;
end;
$$;
revoke all on function public.calendar_claim_jobs() from public,anon,authenticated;
do $$ begin if exists(select 1 from pg_roles where rolname='service_role') then grant execute on function public.calendar_claim_jobs() to service_role; end if; end $$;

-- Disconnect cleanup has its own lease so only one backend can revoke a grant.
-- Final deletion and credential clearing are guarded together against a newer connection.
create or replace function public.calendar_claim_disconnects() returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  if coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb->>'role' is distinct from 'service_role' then raise exception 'Service access required.' using errcode='42501'; end if;
  with candidates as (
    select c.account_id from public.calendar_connections c where c.status='disconnecting'
      and (c.cleanup_until is null or c.cleanup_until<now())
      and not exists(select 1 from public.calendar_reminders r where r.account_id=c.account_id and (r.revision<>r.synced_revision or r.sync_status<>'synced'))
      order by c.updated_at,c.account_id limit 5 for update skip locked
  ), claimed as (
    update public.calendar_connections c set cleanup_token=gen_random_uuid(),cleanup_until=now()+interval '2 minutes'
      from candidates p where c.account_id=p.account_id returning c.*
  ) select coalesce(jsonb_agg(to_jsonb(c)),'[]'::jsonb) into result from claimed c;
  return result;
end;
$$;
create or replace function public.calendar_finish_disconnect(target uuid,expected_version integer,token uuid) returns boolean
language plpgsql security definer set search_path='' as $$
begin
  if coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb->>'role' is distinct from 'service_role' then raise exception 'Service access required.' using errcode='42501'; end if;
  perform 1 from public.calendar_connections where account_id=target and version=expected_version and status='disconnecting' and cleanup_token=token and cleanup_until>now() for update;
  if not found then return false; end if;
  delete from public.calendar_reminders where account_id=target;
  update public.calendar_connections set status='disconnected',encrypted_tokens=null,google_subject=null,version=version+1,cleanup_token=null,cleanup_until=null,updated_at=now() where account_id=target;
  return true;
end;
$$;
revoke all on function public.calendar_claim_disconnects(),public.calendar_finish_disconnect(uuid,integer,uuid) from public,anon,authenticated;
do $$ begin if exists(select 1 from pg_roles where rolname='service_role') then
  grant execute on function public.calendar_claim_disconnects(),public.calendar_finish_disconnect(uuid,integer,uuid) to service_role;
end if; end $$;

notify pgrst, 'reload schema';
commit;
