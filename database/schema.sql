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
  if found then return to_jsonb(account) || jsonb_build_object('profile_complete', account.role <> 'patient' or exists(select 1 from public.patients where account_id = account.id), 'full_name', case when account.role = 'patient' then (select full_name from public.patients where account_id = account.id) else null end); end if;
  -- An administrator can preconfigure coordinator emails before their first Google login.
  update public.accounts set auth_user_id = (select auth.uid())
    where email = verified and auth_user_id is null returning * into account;
  if found then return to_jsonb(account) || jsonb_build_object('profile_complete', account.role <> 'patient' or exists(select 1 from public.patients where account_id = account.id), 'full_name', case when account.role = 'patient' then (select full_name from public.patients where account_id = account.id) else null end); end if;
  -- Another first-login request may have linked the same user while UPDATE waited.
  select * into account from public.accounts where auth_user_id = (select auth.uid());
  if found then return to_jsonb(account) || jsonb_build_object('profile_complete', account.role <> 'patient' or exists(select 1 from public.patients where account_id = account.id), 'full_name', case when account.role = 'patient' then (select full_name from public.patients where account_id = account.id) else null end); end if;
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
  if requested_role = 'patient' then raise exception 'Patient details are required.' using errcode = '22023'; end if;
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
-- Structured address additions preserve the original address as the street field.
alter table public.patients add column if not exists unit_no text not null default '' check (length(unit_no) <= 20);
alter table public.patients add column if not exists postal_code text not null default '' check (postal_code = '' or postal_code ~ '^[0-9]{6}$');
alter table public.patients add column if not exists notes text not null default '' check (length(notes) <= 1000);
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
grant update (status, notes) on public.patients to authenticated;
drop policy if exists patients_read on public.patients;
create policy patients_read on public.patients for select to authenticated
  using ((select private.is_coordinator()) or account_id = (select private.patient_account_id()));
drop policy if exists patients_create on public.patients;
drop policy if exists patients_update on public.patients;
create policy patients_update on public.patients for update to authenticated
  using ((select private.is_coordinator())) with check ((select private.is_coordinator()));
create index if not exists patients_created on public.patients(created_at desc, id);

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
  if details - array['full_name','phone','pickup_address','mobility','assistance_required','unit_no','postal_code','notes'] <> '{}'::jsonb
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
  candidate := jsonb_populate_record(null::public.patients, details);
  insert into public.patients(account_id, full_name, phone, pickup_address, mobility, assistance_required, unit_no, postal_code, notes)
    values (owner_id, btrim(candidate.full_name), btrim(candidate.phone), btrim(candidate.pickup_address), candidate.mobility, candidate.assistance_required, coalesce(btrim(candidate.unit_no), ''), coalesce(btrim(candidate.postal_code), ''), coalesce(btrim(candidate.notes), ''))
    on conflict (account_id) do update set full_name = excluded.full_name, phone = excluded.phone,
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

notify pgrst, 'reload schema';
commit;
