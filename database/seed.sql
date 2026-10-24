-- Optional, fictional demo drivers. Apply database/schema.sql first.
-- Run as project owner in Supabase SQL Editor. No Google/Auth users are created.
-- Reruns skip existing demo emails, preserving their subsequent edits.
begin;
do $$
declare
  reviewer_id uuid;
  driver_id uuid;
  existing public.accounts;
  vehicle public.driver_vehicles;
  fixture record;
begin
  select id into reviewer_id from public.accounts
    where role='coordinator' and status='active'
    order by created_at,id limit 1;
  if reviewer_id is null then
    raise exception 'An active coordinator is required for the mock vehicle approvals.';
  end if;

  for fixture in
    select * from (values
      ('mock.max@example.test','Max Verstappen','80000001',date '1990-01-01',
       'MOCK-MAX-001','BOXBOX1','Honda','Fit',3,false,array[0,1,2,3,4],16,28),
      ('mock.lewis@example.test','Lewis Hamilton','80000002',date '1985-01-01',
       'MOCK-LEWIS-044','HAMMER44','Mercedes-Benz','Vito',6,true,array[0,2,4],20,36),
      ('mock.lando@example.test','Lando Norris','80000003',date '1995-01-01',
       'MOCK-LANDO-004','PLANB04','Perodua','Myvi',4,false,array[1,3,5],32,44)
    ) as data(email,full_name,phone,birth_date,licence,plate,make,model,capacity,accessible,weekdays,from_slot,to_slot)
  loop
    select * into existing from public.accounts where email=fixture.email;
    if found then
      if existing.role<>'driver' or existing.auth_user_id is not null then
        raise exception 'Demo email % already belongs to another or linked account; nothing was changed.',fixture.email;
      end if;
      raise notice 'Skipping existing demo driver: %',fixture.full_name;
      continue;
    end if;

    insert into public.accounts(email,display_name,role,status)
      values(fixture.email,fixture.full_name,'driver','active') returning id into driver_id;
    insert into public.drivers(account_id,full_name,phone,birth_date,gender)
      values(driver_id,fixture.full_name,fixture.phone,fixture.birth_date,'male');
    insert into public.driver_vehicles(driver_id,licence_number,plate_number,make,model,
      passenger_capacity,wheelchair_accessible,status,reviewed_at,reviewed_by,registered_at)
      values(driver_id,fixture.licence,fixture.plate,fixture.make,fixture.model,
        fixture.capacity,fixture.accessible,'approved',now(),reviewer_id,now())
      returning * into vehicle;
    -- This is explicitly a fictional seeded approval, not a real review action.
    insert into private.driver_registration_events(driver_id,actor_id,snapshot)
      values(driver_id,reviewer_id,to_jsonb(vehicle)||jsonb_build_object('mock_seed',true));
    insert into public.driver_availability(driver_id,weekly_slots)
      values(driver_id,array(
        select weekday*48+slot from unnest(fixture.weekdays) weekday
          cross join generate_series(fixture.from_slot,fixture.to_slot-1) slot
          order by weekday,slot
      ));
  end loop;
end;
$$;
commit;

-- Inspect the demo records after insertion. Existing drivers are not selected or changed.
select a.display_name,a.email,a.auth_user_id,v.make,v.model,v.plate_number,
  v.passenger_capacity,v.wheelchair_accessible,v.status,
  cardinality(s.weekly_slots)/2.0 as hours_per_week
from public.accounts a
join public.driver_vehicles v on v.driver_id=a.id
join public.driver_availability s on s.driver_id=a.id
where a.email in ('mock.max@example.test','mock.lewis@example.test','mock.lando@example.test')
order by a.display_name;
