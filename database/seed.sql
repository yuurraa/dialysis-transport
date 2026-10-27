-- Optional fictional accounts. Apply database/schema.sql first, then run this
-- file as project owner in Supabase SQL Editor. No real email accounts are needed.
-- This transaction DELETES the old generated demo_owner_id accounts and their
-- dependent fixtures/Auth identities, then seeds/enrolls ten realistic accounts.
-- Existing mock drivers and all other accounts/bookings are retained.
begin;
select pg_advisory_xact_lock(hashtextextended('seed:fictional-accounts',0));

drop table if exists pg_temp.retired_demo_accounts,pg_temp.retired_demo_auth_users,pg_temp.retired_demo_patients,
  pg_temp.retired_demo_trips,pg_temp.retired_demo_schedules,pg_temp.retired_demo_links;
create temporary table retired_demo_accounts on commit drop as
  select id,auth_user_id,email,demo_owner_id from public.accounts where demo_owner_id is not null;
-- Also capture an Auth create that committed before its account attach failed.
create temporary table retired_demo_auth_users on commit drop as
  select distinct u.id,a.id as account_id,a.email as expected_email,a.demo_owner_id
    from retired_demo_accounts a join auth.users u on u.id=a.auth_user_id or u.id=a.id;
create temporary table retired_demo_patients on commit drop as
  select id from public.patients where account_id in(select id from retired_demo_accounts);
create temporary table retired_demo_trips on commit drop as
  select id from public.trips where patient_id in(select id from retired_demo_patients);
create temporary table retired_demo_schedules on commit drop as
  select id from public.treatment_schedules where patient_id in(select id from retired_demo_patients);
create temporary table retired_demo_links on commit drop as
  select id from public.caregiver_links where patient_id in(select id from retired_demo_patients)
    or caregiver_id in(select id from retired_demo_accounts);

do $$
declare owner uuid; scope record; actor public.accounts; fixture record; person uuid; caregiver uuid; vehicle public.driver_vehicles;
begin
  select a.id into owner from public.accounts a
    join auth.users u on u.id=a.auth_user_id
    where a.role='coordinator' and a.status='active' and a.demo_admin and a.demo_owner_id is null
      and u.email_confirmed_at is not null
      and exists(select 1 from auth.identities i where i.user_id=u.id and i.provider='google')
      and not exists(select 1 from private.seeded_accounts s where s.account_id=a.id)
    order by a.created_at,a.id limit 1;
  if owner is null then raise exception 'Sign in as a real coordinator and enable its demo_admin flag before applying the seed.'; end if;
  if exists(select 1 from private.seeded_accounts where owner_id<>owner) then
    raise exception 'Seed accounts already belong to a different administrator. Ownership was not changed.';
  end if;
  for scope in select distinct demo_owner_id from retired_demo_accounts order by demo_owner_id loop
    perform pg_advisory_xact_lock(hashtextextended('demo:'||scope.demo_owner_id::text,0));
  end loop;
  perform pg_advisory_xact_lock(hashtextextended('demo:'||owner::text,0));
  -- A trusted fixture tag alone never authorizes deleting a Google identity.
  if exists(select 1 from retired_demo_auth_users a join auth.users u on u.id=a.id
    where u.email is distinct from a.expected_email or u.id is distinct from a.account_id
      or u.raw_app_meta_data->>'demo_account_id' is distinct from a.account_id::text
      or u.raw_app_meta_data->>'demo_owner_id' is distinct from a.demo_owner_id::text
      or exists(select 1 from auth.identities i where i.user_id=u.id and i.provider='google')) then
    raise exception 'A generated Demo account has an unexpected Auth identity. Cleanup was cancelled.';
  end if;
  if exists(select 1 from public.trips t where t.patient_id not in(select id from retired_demo_patients)
    and (t.assigned_driver_id in(select id from retired_demo_accounts) or t.cancelled_driver_id in(select id from retired_demo_accounts))) then
    raise exception 'A generated Demo driver is attached to a retained patient trip. Cleanup was cancelled.';
  end if;

  -- Children first. Unexpected references to retained records fail/roll back,
  -- rather than deleting or rewriting those records to force cleanup through.
  delete from private.demo_scenarios where trip_id in(select id from retired_demo_trips) or schedule_id in(select id from retired_demo_schedules);
  delete from public.trip_notifications where recipient_id in(select id from retired_demo_accounts)
    or patient_id in(select id from retired_demo_patients) or trip_id in(select id from retired_demo_trips)
    or event_id in(select id from public.trip_history where trip_id in(select id from retired_demo_trips));
  delete from private.driver_ratings where trip_id in(select id from retired_demo_trips) or patient_id in(select id from retired_demo_patients);
  delete from private.driver_preferences where patient_id in(select id from retired_demo_patients);
  delete from public.trip_locations where trip_id in(select id from retired_demo_trips);
  delete from private.trip_recovery_options where trip_id in(select id from retired_demo_trips);
  delete from private.trip_recovery_checks where trip_id in(select id from retired_demo_trips);
  delete from private.trip_traffic_checks where trip_id in(select id from retired_demo_trips);
  delete from public.trip_history where trip_id in(select id from retired_demo_trips);
  delete from public.trips where id in(select id from retired_demo_trips);
  delete from public.treatment_change_requests where patient_id in(select id from retired_demo_patients);
  delete from public.treatment_trip_generation where schedule_id in(select id from retired_demo_schedules);
  delete from public.treatment_schedules where id in(select id from retired_demo_schedules) and replaces_schedule_id is not null;
  delete from public.treatment_schedules where id in(select id from retired_demo_schedules);
  delete from private.caregiver_link_events where link_id in(select id from retired_demo_links);
  delete from public.caregiver_links where id in(select id from retired_demo_links);
  delete from private.caregiver_invitations where caregiver_id in(select id from retired_demo_accounts);
  delete from private.caregiver_code_attempts where account_id in(select id from retired_demo_accounts);
  delete from public.caregivers where account_id in(select id from retired_demo_accounts);
  delete from public.patients where id in(select id from retired_demo_patients);
  delete from private.driver_registration_events where driver_id in(select id from retired_demo_accounts);
  delete from public.driver_week_availability where driver_id in(select id from retired_demo_accounts);
  delete from public.driver_availability where driver_id in(select id from retired_demo_accounts);
  delete from public.driver_vehicles where driver_id in(select id from retired_demo_accounts);
  delete from public.drivers where account_id in(select id from retired_demo_accounts);
  delete from public.accounts where id in(select id from retired_demo_accounts);
  -- Only the captured, metadata-verified synthetic users; never delete by email/name.
  delete from auth.users where id in(select id from retired_demo_auth_users);

  for fixture in select * from (values
    ('patient1','patient','mock.tan.wee.kiat@example.test','Tan Wee Kiat','80001001',date '1962-04-12','male','Blk 459 Jurong West Street 41','#04-112','640459','ambulant',false),
    ('patient2','patient','mock.lim.mei.ling@example.test','Lim Mei Ling','80001002',date '1958-09-23','female','Blk 209 Ang Mo Kio Avenue 3','#05-128','560209','walking-aid',false),
    ('patient3','patient','mock.rajesh.kumar@example.test','Rajesh Kumar','80001003',date '1967-01-18','male','Blk 122 Bedok North Street 2','#03-210','460122','wheelchair',true),
    ('caregiver1','caregiver','mock.tan.jia.hui@example.test','Tan Jia Hui','80002001',date '1994-08-15','female','','','','',false),
    ('caregiver2','caregiver','mock.lim.wei.ming@example.test','Lim Wei Ming','80002002',date '1989-03-07','male','','','','',false),
    ('caregiver3','caregiver','mock.priya.kumar@example.test','Priya Kumar','80002003',date '1992-06-21','female','','','','',false),
    ('coordinator','coordinator','mock.coordinator@example.test','Sophia Tan','',date '1988-01-01','female','','','','',false)
  ) f(key,role,email,name,phone,born,gender,address,unit,postal,mobility,assistance)
  loop
    select * into actor from public.accounts where email=fixture.email;
    if found then
      if actor.role<>fixture.role or actor.demo_owner_id is not null
        or not exists(select 1 from private.seeded_accounts s where s.account_id=actor.id and s.owner_id=owner and s.seed_key=fixture.key) then
        raise exception 'Seed email % belongs to an unrelated account. Nothing was changed.',fixture.email;
      end if;
      if fixture.role='coordinator' and actor.demo_admin then
        update public.accounts set demo_admin=false where id=actor.id;
      end if;
    else
      if exists(select 1 from auth.users where lower(email)=fixture.email) then
        raise exception 'Seed email % already has an unrelated Auth identity. Nothing was changed.',fixture.email;
      end if;
      insert into public.accounts(email,display_name,role,demo_admin)
        values(fixture.email,fixture.name,fixture.role,false) returning * into actor;
      if fixture.role='patient' then
        insert into public.patients(account_id,full_name,phone,birth_date,gender,pickup_address,unit_no,postal_code,mobility,assistance_required)
          values(actor.id,fixture.name,fixture.phone,fixture.born,fixture.gender,fixture.address,fixture.unit,fixture.postal,fixture.mobility,fixture.assistance);
      elsif fixture.role='caregiver' then
        insert into public.caregivers(account_id,full_name,phone,birth_date,gender)
          values(actor.id,fixture.name,fixture.phone,fixture.born,fixture.gender);
      end if;
      insert into private.seeded_accounts(account_id,owner_id,seed_key) values(actor.id,owner,fixture.key);
    end if;
  end loop;

  -- Reuse these exact three drivers, preserving every existing field and booking.
  -- New installations can create the same fixtures if the original seed was not run.
  for fixture in select * from (values
    ('driver1','mock.max@example.test','Max Verstappen','80000001',date '1990-01-01','MOCK-MAX-001','BOXBOX1','Honda','Fit',3,false,array[0,1,2,3,4],16,28),
    ('driver2','mock.lewis@example.test','Lewis Hamilton','80000002',date '1985-01-01','MOCK-LEWIS-044','HAMMER44','Mercedes-Benz','Vito',6,true,array[0,2,4],20,36),
    ('driver3','mock.lando@example.test','Lando Norris','80000003',date '1995-01-01','MOCK-LANDO-004','PLANB04','Perodua','Myvi',4,false,array[1,3,5],32,44)
  ) f(key,email,name,phone,born,licence,plate,make,model,capacity,accessible,weekdays,from_slot,to_slot)
  loop
    select * into actor from public.accounts where email=fixture.email;
    if found then
      if actor.role<>'driver' or actor.demo_owner_id is not null
        or (actor.auth_user_id is not null and not exists(select 1 from auth.users u where u.id=actor.auth_user_id and u.id=actor.id
          and u.email=actor.email and u.raw_app_meta_data->>'demo_account_id'=actor.id::text and u.raw_app_meta_data->>'demo_owner_id'=owner::text))
        or exists(select 1 from private.seeded_accounts s where s.account_id=actor.id and (s.owner_id<>owner or s.seed_key<>fixture.key)) then
        raise exception 'Mock driver % has an unrelated identity or seed owner. Nothing was changed.',fixture.email;
      end if;
      if actor.auth_user_id is null and exists(select 1 from auth.users u where lower(u.email)=actor.email) then
        raise exception 'Mock driver % already has an unrelated Auth identity. Nothing was changed.',fixture.email;
      end if;
    else
      if exists(select 1 from auth.users where lower(email)=fixture.email) then raise exception 'Mock driver email % is already used by Auth.',fixture.email; end if;
      insert into public.accounts(email,display_name,role) values(fixture.email,fixture.name,'driver') returning * into actor;
      insert into public.drivers(account_id,full_name,phone,birth_date,gender) values(actor.id,fixture.name,fixture.phone,fixture.born,'male');
      insert into public.driver_vehicles(driver_id,licence_number,plate_number,make,model,passenger_capacity,wheelchair_accessible,status,reviewed_at,reviewed_by,registered_at)
        values(actor.id,fixture.licence,fixture.plate,fixture.make,fixture.model,fixture.capacity,fixture.accessible,'approved',now(),owner,now()) returning * into vehicle;
      insert into private.driver_registration_events(driver_id,actor_id,snapshot) values(actor.id,owner,to_jsonb(vehicle)||jsonb_build_object('mock_seed',true));
      insert into public.driver_availability(driver_id,weekly_slots) values(actor.id,array(
        select weekday*48+slot from unnest(fixture.weekdays) weekday cross join generate_series(fixture.from_slot,fixture.to_slot-1) slot order by weekday,slot));
    end if;
    if not exists(select 1 from public.drivers where account_id=actor.id) then raise exception 'Mock driver % is missing its profile.',fixture.email; end if;
    insert into private.seeded_accounts(account_id,owner_id,seed_key) values(actor.id,owner,fixture.key) on conflict(account_id) do nothing;
  end loop;

  for fixture in select * from (values('patient1','caregiver1'),('patient2','caregiver2'),('patient3','caregiver3')) f(patient_key,caregiver_key) loop
    select p.id into person from public.patients p join private.seeded_accounts s on s.account_id=p.account_id where s.owner_id=owner and s.seed_key=fixture.patient_key;
    select account_id into caregiver from private.seeded_accounts where owner_id=owner and seed_key=fixture.caregiver_key;
    insert into public.caregiver_links(patient_id,caregiver_id,authorised_by) values(person,caregiver,owner)
      on conflict(patient_id,caregiver_id) do nothing;
  end loop;
  raise notice 'Removed % generated Demo accounts. Seeded accounts are ready for the administrator switcher.',(select count(*) from retired_demo_accounts);
end;
$$;
commit;

select a.id,a.display_name,a.email,a.role,a.demo_admin,a.auth_user_id,s.seed_key
from private.seeded_accounts s join public.accounts a on a.id=s.account_id
order by s.seed_key;
