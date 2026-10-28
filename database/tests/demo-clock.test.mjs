import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

for (const timing of ['future','past']) test(`demo ${timing} pickup uses its booked clock, preserves the reservation and starts within saved availability`, async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role;
      create schema auth;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,raw_app_meta_data jsonb);
      create table auth.identities(user_id uuid,provider text);
      create function auth.uid() returns uuid language sql stable as
        $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      grant usage on schema auth to authenticated;
      grant execute on function auth.uid() to authenticated;
      insert into auth.users values('22222222-2222-4222-8222-222222222222','coordinator@example.test',now(),'{}');
      insert into auth.identities values('22222222-2222-4222-8222-222222222222','google');`);
    await db.exec(await readFile(new URL('../schema.sql',import.meta.url),'utf8'));
    const owner=(await db.query(`insert into public.accounts(auth_user_id,email,display_name,role,demo_admin)
      values('22222222-2222-4222-8222-222222222222','coordinator@example.test','Fixture Coordinator','coordinator',true) returning id`)).rows[0].id;
    await db.exec(await readFile(new URL('../seed.sql',import.meta.url),'utf8'));
    const manage=async (action,details={}) => {
      await db.exec('begin; set local role service_role');
      try {
        await db.query("select set_config('request.jwt.claims','{\"role\":\"service_role\"}',true)");
        const state=(await db.query('select public.demo_manage($1,$2,$3::jsonb) as state',[owner,action,JSON.stringify({confirmed:true,...details})])).rows[0].state;
        await db.exec('commit'); return state;
      } catch(error) { await db.exec('rollback'); throw error; }
    };
    const scene=await manage('setup');
    const max=scene.actors.find(actor=>actor.email==='mock.max@example.test');
    const vehicle=(await db.query('select id from public.driver_vehicles where driver_id=$1',[max.id])).rows[0].id;
    // A Thursday on either side of real now; Max covers 08:00–14:00. No other booking exists.
    const pickup=(await db.query(`select ((date_trunc('week',now() at time zone 'Asia/Singapore')::date+$1::integer)+time '08:30') at time zone 'Asia/Singapore' as pickup`,[timing==='future'?17:-11])).rows[0].pickup.toISOString();
    await db.query(`update public.trips set assigned_driver_id=$2,assigned_vehicle_id=$3,assignment='{}',
      session_date=($4::timestamptz at time zone 'Asia/Singapore')::date,
      pickup_at=$4,dropoff_at=$4::timestamptz+interval '30 minutes',
      treatment_start=$4::timestamptz+interval '60 minutes',treatment_end=$4::timestamptz+interval '120 minutes',
      arrival_by=$4::timestamptz+interval '45 minutes',status='on-track' where id=$1`,[scene.trip.id,max.id,vehicle,pickup]);
    await db.query('update public.trips set confirmed_at=now(),confirmed_by=$2 where id=$1',[scene.trip.id,owner]);
    const booked=(await manage('state')).trip;
    const week=(await db.query("select date_trunc('week',$1::timestamptz at time zone 'Asia/Singapore')::date::text as week",[pickup])).rows[0].week;
    await db.query("insert into public.driver_week_availability(driver_id,week_start,weekly_slots) values($1,$2,'{}')",[max.id,week]);
    await assert.rejects(manage('due'),/availability or another booking/,'weekly availability must still be enforced');
    await db.query('delete from public.driver_week_availability where driver_id=$1',[max.id]);
    const conflictId=(await db.query('select gen_random_uuid() as id')).rows[0].id;
    await db.query('insert into public.trips select (jsonb_populate_record(null::public.trips,$1::jsonb)).*',
      [JSON.stringify({...booked,id:conflictId,occurrence_key:'fixture-overlap'})]);
    await assert.rejects(manage('due'),/availability or another booking/,'another booking must still block activation');
    await db.query('delete from public.trips where id=$1',[conflictId]);
    // Availability edits flag affected assignments for review; restore this isolated fixture.
    await db.query("update public.trips set status='on-track' where id=$1",[scene.trip.id]);
    const due=(await manage('due')).trip;
    for(const field of ['pickup_at','dropoff_at','treatment_start','treatment_end','arrival_by','session_date','confirmed_at','confirmed_by'])
      assert.equal(due[field],booked[field],`due must preserve ${field}`);
    assert.equal(due.demo_clock_at,booked.pickup_at);
    assert.ok(due.demo_clock_started_at);
    const repeated=(await manage('due')).trip;
    assert.equal(repeated.demo_clock_started_at,due.demo_clock_started_at,'repeated activation must not rewind');
    const elapsed=(await db.query(`select private.trip_now(jsonb_populate_record(null::public.trips,$1::jsonb))-
      $2::timestamptz as elapsed`,[JSON.stringify({...due,demo_clock_started_at:new Date(Date.now()-60000).toISOString()}),pickup])).rows[0].elapsed;
    assert.ok(elapsed,'running demo time must advance');

    await db.query('insert into auth.users values($1,$2,now(),$3::jsonb)',[max.id,max.email,JSON.stringify({demo_account_id:max.id,demo_owner_id:owner})]);
    await db.query('update public.accounts set auth_user_id=id where id=$1',[max.id]);
    const execute=async action => {
      await db.exec('begin; set local role authenticated');
      try {
        await db.query("select set_config('request.jwt.claim.sub',$1,true)",[max.id]);
        const version=(await db.query('select version from public.trips where id=$1',[due.id])).rows[0].version;
        const trip=(await db.query('select private.execute_trip($1,$2,$3) as trip',[due.id,action,version])).rows[0].trip;
        await db.exec('commit');return trip;
      } catch(error) {await db.exec('rollback');throw error;}
    };
    const started=await execute('start');
    assert.equal(started.lifecycle,'in-progress');assert.equal(started.status,'on-track');
    assert.ok(Math.abs(Date.parse(started.started_at)-Date.parse(pickup))<5000);
    const completed=await execute('complete');
    assert.equal(completed.lifecycle,'completed');assert.ok(Date.parse(completed.completed_at)>=Date.parse(started.started_at));
    const reset=await manage('reset');
    assert.notEqual(reset.trip.id,due.id);assert.equal(reset.trip.demo_clock_started_at,null);
    assert.ok(reset.trip.demo_clock_at);
    const asCoordinator=async(sql,args=[])=>{
      await db.exec('begin; set local role authenticated');
      try {
        await db.query("select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',true)");
        const result=await db.query(sql,args);await db.exec('commit');return result.rows;
      } catch(error) {await db.exec('rollback');throw error;}
    };
    // Route planning can discover a 75-minute drive. Its pickup precedes the old
    // fixed session-minus-90 clock, so prepare must pause before the planned pickup.
    await db.query(`update public.trips set session_date=($2::timestamptz at time zone 'Asia/Singapore')::date,
      treatment_start=$2::timestamptz+interval '95 minutes',treatment_end=$2::timestamptz+interval '155 minutes',
      arrival_by=$2::timestamptz+interval '80 minutes',demo_clock_at=$2::timestamptz+interval '5 minutes' where id=$1`,[reset.trip.id,pickup]);
    await db.query('select public.cache_driving_route($1,$2,$3::jsonb)',[reset.trip.origin,reset.trip.destination,JSON.stringify({
      geometry:[[1.3,103.8],[1.31,103.81]],duration_seconds:4500,distance_metres:10000,
      origin_coordinates:{latitude:1.3,longitude:103.8},destination_coordinates:{latitude:1.31,longitude:103.81}
    })]);
    let planned=(await asCoordinator('select public.prepare_trip_route($1,$2) as trip',[reset.trip.id,(await manage('state')).trip.version]))[0].trip;
    planned=(await asCoordinator('select public.assign_trip($1,$2,$3,$4) as trip',[planned.id,max.id,pickup,planned.version]))[0].trip;
    assert.equal(planned.duration_minutes,75);
    await db.query("update public.drivers set phone='80000123' where account_id=$1",[max.id]);
    assert.equal((await manage('state')).trip.assignment.driver_phone,'80000123','paused past-date demos must receive resource updates');
    let risky=(await manage('traffic',{scenario:'delay'})).trip;
    const proposals=(await db.query('select public.store_assessed_trip_recovery_options($1,$2,80,false,null,true,5) as data',[risky.id,risky.version])).rows[0].data;
    const option=proposals.options.find(row=>row.driver_id===max.id);
    assert.ok(option,'recovery must use the paused demo time for past as well as future reservations');
    assert.ok(Date.parse(option.expires_at)>Date.now(),'proposal expiry must remain real');
    await db.query("select public.attest_trip_recovery_option($1,clock_timestamp()+interval '20 seconds')",[option.id]);
    await asCoordinator('select public.approve_trip_recovery($1,$2)',[option.id,proposals.trip.version]);
    await manage('traffic',{scenario:'normal'});
    await manage('due');
    await db.query("update public.drivers set phone='80000456' where account_id=$1",[max.id]);
    assert.equal((await manage('state')).trip.status,'on-track','a contact edit must not flag an already-due demo as late');
    // Merely having clock fields cannot give an ordinary trip a simulated clock.
    const real=(await db.query(`select abs(extract(epoch from (private.trip_now(jsonb_populate_record(null::public.trips,
      '{"demo_clock_at":"2099-01-01T00:00:00Z"}'::jsonb))-now())))<1 as real`)).rows[0].real;
    assert.equal(real,true);
    await db.query('update public.trips set demo_owner_id=null where id=$1',[reset.trip.id]);
    assert.equal((await manage('state')).trip.demo_owner_id,owner,'the scope trigger must preserve demo ownership');
    // Reapplying the canonical schema must retain a prepared clock and reservation.
    const beforeReapply=(await manage('state')).trip;
    await db.exec(await readFile(new URL('../schema.sql',import.meta.url),'utf8'));
    assert.equal((await manage('state')).trip.demo_clock_at,beforeReapply.demo_clock_at);
  } finally {await db.close();}
});
