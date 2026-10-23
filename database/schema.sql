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
    where auth_user_id = (select auth.uid()) and role = 'coordinator' and status = 'active');
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
    and exists(select 1 from auth.identities i where i.user_id = u.id and i.provider = 'google');
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
  if found then return to_jsonb(account) || jsonb_build_object('profile_complete', case account.role when 'patient' then exists(select 1 from public.patients where account_id = account.id) when 'driver' then exists(select 1 from public.drivers where account_id = account.id) else true end, 'full_name', case when account.role = 'patient' then (select full_name from public.patients where account_id = account.id) when account.role = 'driver' then (select full_name from public.drivers where account_id = account.id) else null end); end if;
  -- An administrator can preconfigure coordinator emails before their first Google login.
  update public.accounts set auth_user_id = (select auth.uid())
    where email = verified and auth_user_id is null returning * into account;
  if found then return to_jsonb(account) || jsonb_build_object('profile_complete', case account.role when 'patient' then exists(select 1 from public.patients where account_id = account.id) when 'driver' then exists(select 1 from public.drivers where account_id = account.id) else true end, 'full_name', case when account.role = 'patient' then (select full_name from public.patients where account_id = account.id) when account.role = 'driver' then (select full_name from public.drivers where account_id = account.id) else null end); end if;
  -- Another first-login request may have linked the same user while UPDATE waited.
  select * into account from public.accounts where auth_user_id = (select auth.uid());
  if found then return to_jsonb(account) || jsonb_build_object('profile_complete', case account.role when 'patient' then exists(select 1 from public.patients where account_id = account.id) when 'driver' then exists(select 1 from public.drivers where account_id = account.id) else true end, 'full_name', case when account.role = 'patient' then (select full_name from public.patients where account_id = account.id) when account.role = 'driver' then (select full_name from public.drivers where account_id = account.id) else null end); end if;
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
  if requested_role in ('patient','driver') then raise exception 'Personal details are required.' using errcode = '22023'; end if;
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
  select id from public.accounts where auth_user_id = (select auth.uid()) and role = 'patient' and status = 'active';
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
  if saved.version <> (details->>'version')::numeric then raise exception 'Patient has changed. Reload before saving.' using errcode = '40001'; end if;
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
    if saved.version <> (details->>'version')::numeric then raise exception 'Patient has changed. Reload before saving.' using errcode = '40001'; end if;
  elsif details ? 'version' then
    raise exception 'Patient profile has changed. Reload before saving.' using errcode = '40001';
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

-- Driver personal signup only. Vehicle registration and approval are a later milestone.
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
  select id from public.accounts where auth_user_id=(select auth.uid()) and role='driver' and status='active';
$$;
revoke all on function private.driver_account_id() from public, anon;
grant execute on function private.driver_account_id() to authenticated;
drop policy if exists drivers_read on public.drivers;
create policy drivers_read on public.drivers for select to authenticated
  using (account_id=(select private.driver_account_id()));

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
  if not found then raise exception 'Driver profile already exists. Reload before continuing.' using errcode='40001'; end if;
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
grant insert(patient_id,centre_id,kind,days,start_time,end_time,effective_from,effective_to,replaces_schedule_id,replaces_date),
  update(centre_id,kind,days,start_time,end_time,effective_from,effective_to) on public.treatment_schedules to authenticated;
-- Updates require a version-checked RPC; INSERT still validates through RLS/triggers.
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
drop policy if exists centres_read on public.dialysis_centres;
create policy centres_read on public.dialysis_centres for select to authenticated using (
  exists(select 1 from public.accounts where auth_user_id=(select auth.uid()) and status='active' and role in ('patient','coordinator')));
drop policy if exists treatment_read on public.treatment_schedules;
create policy treatment_read on public.treatment_schedules for select to authenticated
  using ((select private.is_coordinator()) or private.owns_active_patient(patient_id));
drop policy if exists treatment_insert on public.treatment_schedules;
create policy treatment_insert on public.treatment_schedules for insert to authenticated
  with check (private.owns_active_patient(patient_id));
drop policy if exists treatment_update on public.treatment_schedules;
create policy treatment_update on public.treatment_schedules for update to authenticated
  using (private.owns_active_patient(patient_id)) with check (private.owns_active_patient(patient_id));

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
  if not private.owns_active_patient(new.patient_id) then
    raise exception 'Treatment access denied.' using errcode='42501';
  end if;
  perform 1 from public.patients where id=new.patient_id for update;
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

-- A narrow owner operation keeps linked replacements and restored occurrences atomic.
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
  if not private.owns_active_patient(selected.patient_id) then
    raise exception 'Treatment access denied.' using errcode='42501';
  end if;
  perform 1 from public.patients where id=selected.patient_id for update;
  -- Recheck after the lock: another request may have deleted the schedule.
  select * into selected from public.treatment_schedules where id=target for update;
  if not found then return null; end if;
  if selected.version <> expected_version then raise exception 'Schedule changed. Reload before deleting.' using errcode='40001'; end if;
  if not private.owns_active_patient(selected.patient_id) then
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
grant execute on function private.delete_my_treatment(uuid,integer), public.delete_my_treatment(uuid,integer) to authenticated;

-- Serialize owner edits and compare the version while holding the same Patient lock
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
  if not private.owns_active_patient(selected.patient_id) then raise exception 'Treatment access denied.' using errcode='42501'; end if;
  perform 1 from public.patients where id=selected.patient_id for update;
  select * into selected from public.treatment_schedules where id=target for update;
  if not found then return null; end if;
  if not private.owns_active_patient(selected.patient_id) then raise exception 'Treatment access denied.' using errcode='42501'; end if;
  if selected.version<>expected_version then raise exception 'Schedule changed. Reload before saving.' using errcode='40001'; end if;
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
grant execute on function private.update_my_treatment(uuid,jsonb,integer), public.update_my_treatment(uuid,jsonb,integer) to authenticated;

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
    select s.*,jsonb_build_object('full_name',p.full_name) as patients,c.name as centre_name
    from public.treatment_schedules s join public.patients p on p.id=s.patient_id join public.dialysis_centres c on c.id=s.centre_id
  ), matched as materialized (
    select * from visible s where (kind_filter='all' or ('recurring'=any(string_to_array(kind_filter,',')) and s.kind='recurring')
      or ('single'=any(string_to_array(kind_filter,',')) and s.kind='single' and s.replaces_schedule_id is null)
      or ('rescheduled'=any(string_to_array(kind_filter,',')) and s.replaces_schedule_id is not null))
      and (centre_filter='all' or s.centre_id::text=centre_filter)
      and (btrim(search_text)='' or exists (
      select 1 from unnest(array[
        case when private.is_coordinator() then s.patients->>'full_name' else '' end,
        case when private.is_coordinator() then s.patient_id::text else '' end,
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
    'schedules',(select coalesce(jsonb_agg(to_jsonb(p)-'centre_name'-'list_order' order by list_order),'[]'::jsonb) from page p),
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
create or replace function private.increment_trip_version() returns trigger
language plpgsql security definer set search_path = '' as $$
begin new.version:=old.version+1; return new; end;
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
alter table public.trip_history add constraint trip_history_event_check check (event in ('generated','refreshed','requirements_changed','deleted'));
alter table public.trips enable row level security;
alter table public.trip_history enable row level security;
revoke all on public.trips,public.trip_history from public,anon,authenticated;
grant select on public.trips,public.trip_history to authenticated;
drop policy if exists trips_read on public.trips;
create policy trips_read on public.trips for select to authenticated
  using ((select private.is_coordinator()) or private.owns_active_patient(patient_id));
drop policy if exists trip_history_read on public.trip_history;
create policy trip_history_read on public.trip_history for select to authenticated
  using (exists(select 1 from public.trips t where t.id=trip_id));

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
  for changed in update public.trips set review_required=true,updated_at=now()
    where deleted_at is null and (coalesce(pickup_not_before,treatment_end) at time zone 'Asia/Singapore')::date >= (now() at time zone 'Asia/Singapore')::date
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

create or replace function private.generate_treatment_trips(target uuid,from_date date,until_date date,expected_version integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare chosen public.treatment_schedules; person public.patients; old_trip public.trips; saved public.trips;
  session record; leg text; actor uuid; source_root uuid; key text; origin_text text; destination_text text;
  session_start timestamptz; session_end timestamptz; due timestamptz; ready timestamptz;
  inserted integer:=0; refreshed integer:=0; unchanged integer:=0; skipped integer:=0;
begin
  if not private.is_coordinator() then raise exception 'Coordinator access required.' using errcode='42501'; end if;
  if from_date is null or until_date is null or not isfinite(from_date) or not isfinite(until_date)
    or from_date<(now() at time zone 'Asia/Singapore')::date or until_date>date '9999-12-31'
    or until_date<from_date or until_date-from_date>89 or expected_version is null or expected_version<1 then
    raise exception 'Choose a future trip window of up to 90 days and a schedule version.' using errcode='22023';
  end if;
  select * into chosen from public.treatment_schedules where id=target;
  if not found then raise exception 'Treatment schedule not found.' using errcode='P0002'; end if;
  select * into person from public.patients where id=chosen.patient_id for update;
  if not found or person.status<>'active' then raise exception 'An active Patient profile is required.' using errcode='42501'; end if;
  select * into chosen from public.treatment_schedules where id=target for update;
  if not found then raise exception 'Treatment schedule not found.' using errcode='P0002'; end if;
  if chosen.version<>expected_version then raise exception 'Treatment schedule changed. Reload before generating Trips.' using errcode='40001'; end if;
  select id into actor from public.accounts where auth_user_id=(select auth.uid());
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
      if found and old_trip.deleted_at is not null then skipped:=skipped+1; continue; end if;
      if found and not old_trip.review_required and old_trip.source_version=session.version and old_trip.patient_version=person.version
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
        update public.trips set patient_name=person.full_name,source_schedule_id=session.id,session_date=session.actual_date,
          origin=origin_text,destination=destination_text,treatment_start=session_start,treatment_end=session_end,arrival_by=due,pickup_not_before=ready,
          source_version=session.version,patient_version=person.version,review_required=false,updated_at=now()
          where id=old_trip.id returning * into saved;
        refreshed:=refreshed+1;
      end if;
      insert into public.trip_history(trip_id,actor_id,event,details) values(saved.id,actor,
        case when old_trip.id is null then 'generated' else 'refreshed' end,
        jsonb_build_object('source_schedule_id',session.id,'source_version',session.version,'session_date',session.actual_date));
    end loop;
  end loop;
  return jsonb_build_object('created',inserted,'updated',refreshed,'unchanged',unchanged,'skipped',skipped,'total',inserted+refreshed+unchanged+skipped);
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
  if selected.version<>expected_version then raise exception 'Trip changed. Reload before deleting.' using errcode='40001'; end if;
  if selected.status<>'unfilled' or selected.pickup_at is not null then raise exception 'Only unassigned trips may be deleted.' using errcode='22023'; end if;
  select id into actor from public.accounts where auth_user_id=(select auth.uid());
  update public.trips set deleted_at=now(),updated_at=now() where id=target;
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
create or replace function private.list_trips(page_no integer,from_date date,until_date date,status_filter text default 'all',search_text text default '',direction_filter text default 'all',sort_by text default 'treatment_start',sort_order text default 'asc') returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare result jsonb;
begin
  if not private.is_coordinator() and private.patient_account_id() is null then raise exception 'Trip access denied.' using errcode='42501'; end if;
  if page_no is null or page_no<1 or page_no>1000000 or from_date is null or until_date is null or not isfinite(from_date) or not isfinite(until_date)
    or from_date<date '0001-01-01' or until_date>date '9999-12-31' or until_date<from_date or until_date-from_date>89
    or status_filter is null or status_filter !~ '^(all|(unfilled|at-risk|on-track|resolved)(,(unfilled|at-risk|on-track|resolved)){0,3})$'
    or direction_filter is null or direction_filter !~ '^(all|(outbound|return)(,(outbound|return)){0,1})$'
    or sort_by is null or sort_by not in ('treatment_start','patient_name','direction','status')
    or sort_order is null or sort_order not in ('asc','desc')
    or search_text is null or length(search_text)>100 or search_text ~ '[[:cntrl:]]' then raise exception 'Invalid trip filters.' using errcode='22023'; end if;
  with windowed as materialized (select * from public.trips t where deleted_at is null and session_date between from_date and until_date
    and (direction_filter='all' or direction=any(string_to_array(direction_filter,',')))
    and (btrim(search_text)='' or exists(select 1 from unnest(array[
      case when private.is_coordinator() then patient_name else '' end,
      case when private.is_coordinator() then patient_id::text else '' end,
      origin,destination,direction,status,case when review_required then 'Needs review' else '' end,
      case when pickup_at is null then 'Pickup pending' else '' end,
      session_date::text,to_char(session_date,'FMDD Mon YYYY'),to_char(session_date,'FMDay'),
      to_char(treatment_start at time zone 'Asia/Singapore','HH24:MI'),to_char(treatment_end at time zone 'Asia/Singapore','HH24:MI'),
      to_char(arrival_by at time zone 'Asia/Singapore','HH24:MI'),to_char(pickup_not_before at time zone 'Asia/Singapore','HH24:MI'),
      to_char(arrival_by at time zone 'Asia/Singapore','YYYY-MM-DD'),to_char(pickup_not_before at time zone 'Asia/Singapore','YYYY-MM-DD')
    ]) field where strpos(lower(field),lower(btrim(search_text)))>0))),
    filtered as materialized (select * from windowed where status_filter='all' or status=any(string_to_array(status_filter,','))),
    ordered as (select filtered.*,row_number() over (order by
      case when sort_by='treatment_start' and sort_order='asc' then treatment_start end asc,
      case when sort_by='treatment_start' and sort_order='desc' then treatment_start end desc,
      case when sort_order='asc' then case sort_by when 'patient_name' then lower(patient_name) when 'direction' then direction when 'status' then status end end asc,
      case when sort_order='desc' then case sort_by when 'patient_name' then lower(patient_name) when 'direction' then direction when 'status' then status end end desc,
      session_date,treatment_start,case direction when 'outbound' then 0 else 1 end,id) as list_order from filtered),
    page as (select * from ordered order by list_order limit 10 offset ((page_no::bigint-1)*10))
  select jsonb_build_object('trips',(select coalesce(jsonb_agg(to_jsonb(p)-'list_order' order by list_order),'[]'::jsonb) from page p),
    'total',(select count(*) from filtered),'page',page_no,'pageSize',10,
    'counts',jsonb_build_object('unfilled',(select count(*) from windowed where status='unfilled'),'at-risk',0,'on-track',0,'resolved',0),
    'next_trip',(select to_jsonb(t) from public.trips t where deleted_at is null and (
      (direction='outbound' and treatment_start>now()) or
      (direction='return' and (pickup_not_before at time zone 'Asia/Singapore')::date >= (now() at time zone 'Asia/Singapore')::date))
      order by session_date,coalesce(pickup_at,pickup_not_before,arrival_by),id limit 1)) into result;
  return result;
end;
$$;
create or replace function public.list_trips(page_no integer,from_date date,until_date date,status_filter text default 'all',search_text text default '',direction_filter text default 'all',sort_by text default 'treatment_start',sort_order text default 'asc') returns jsonb
language sql stable security invoker set search_path = '' as $$ select private.list_trips(page_no,from_date,until_date,status_filter,search_text,direction_filter,sort_by,sort_order); $$;
revoke all on function private.list_trips(integer,date,date,text,text,text,text,text),public.list_trips(integer,date,date,text,text,text,text,text) from public,anon;
grant execute on function private.list_trips(integer,date,date,text,text,text,text,text),public.list_trips(integer,date,date,text,text,text,text,text) to authenticated;

notify pgrst, 'reload schema';
commit;
