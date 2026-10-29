import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite, types } from '@electric-sql/pglite';

// Disposable PostgreSQL engine; this suite never connects to Supabase.
const schema = await readFile(new URL('../schema.sql', import.meta.url), 'utf8');
async function databaseWithAuth() {
  // Match Supabase's date-only strings; timestamps retain their normal parser.
  const database = new PGlite({parsers:{[types.DATE]:value=>value}});
  await database.exec(`-- FICTIONAL AUTH FIXTURE FOR DISPOSABLE LOCAL DATABASES ONLY. Never run on Supabase.
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create table auth.users (id uuid primary key, email text, email_confirmed_at timestamptz);
    create table auth.identities (user_id uuid, provider text);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to authenticated;
    grant execute on function auth.uid() to authenticated;
    insert into auth.users values
      ('11111111-1111-4111-8111-111111111111', 'patient@example.test', now()),
      ('22222222-2222-4222-8222-222222222222', 'coordinator@example.test', now()),
      ('33333333-3333-4333-8333-333333333333', 'driver@example.test', now()),
      ('44444444-4444-4444-8444-444444444444', 'stranger@example.test', null),
      ('66666666-6666-4666-8666-666666666666', 'emailonly@example.test', now());
    insert into auth.identities values ('11111111-1111-4111-8111-111111111111', 'google'), ('22222222-2222-4222-8222-222222222222', 'google'), ('33333333-3333-4333-8333-333333333333', 'google'), ('44444444-4444-4444-8444-444444444444', 'google');
`);
  return database;
}
let db;
const patient = '11111111-1111-4111-8111-111111111111';
const coordinator = '22222222-2222-4222-8222-222222222222';
const driver = '33333333-3333-4333-8333-333333333333';
const emailOnly = '66666666-6666-4666-8666-666666666666';
const stranger = '44444444-4444-4444-8444-444444444444';
const signupDetails = { full_name: 'Test Patient', birth_date: '1990-04-12', gender: 'female', phone: '+65 81234567', pickup_address: 'Test street', postal_code: '560123', mobility: 'ambulant', assistance_required: false };
before(async () => {
  db = await databaseWithAuth();
  await db.exec(schema);
});
after(async () => { await db?.close(); });
async function asUser(id, sql, params = []) {
  await db.exec('begin; set local role authenticated;');
  try {
    await db.query("select set_config('request.jwt.claim.sub', $1, true)", [id]);
    const result = await db.query(sql, params);
    await db.exec('commit');
    return result.rows;
  } catch (error) { await db.exec('rollback'); throw error; }
}
test('rejects coordinator signup and unverified identities at the database boundary', async () => {
  await assert.rejects(asUser(patient, "select public.register_account('coordinator', 'Patient')"), /Invalid registration/);
  await assert.rejects(asUser(stranger, "select public.register_account('driver', 'Stranger')"), /verified Google/);
});
test('verified email without a Google identity cannot look up or register an account', async () => {
  await assert.rejects(asUser(emailOnly, 'select public.current_account()'), /verified Google/);
  await assert.rejects(asUser(emailOnly, "select public.register_account('patient', 'Email Only')"), /verified Google/);
});

test('registration persists the verified email, allowed role and active status; duplicates fail', async () => {
  const [{ account }] = await asUser(patient, "select public.register_patient_account(' Test Patient ', $1::jsonb) as account", [JSON.stringify(signupDetails)]);
  assert.equal(account.email, 'patient@example.test');
  assert.equal(account.display_name, 'Test Patient');
  assert.equal(account.role, 'patient');
  assert.equal(account.status, 'active');
  assert.equal(account.auth_user_id, patient);
  await assert.rejects(asUser(patient, "select public.register_account('driver', 'Other')"), /already registered/);
  assert.equal((await asUser(patient, 'select public.current_account() as account'))[0].account.role, 'patient');
});
test('users cannot write roles/status directly or access other accounts', async () => {
  await assert.rejects(asUser(patient, "update public.accounts set role = 'coordinator'"), /permission denied/);
  await assert.rejects(asUser(patient, 'update public.accounts set demo_admin=true'), /permission denied/);
  await assert.rejects(asUser(patient, "select public.demo_manage('22222222-2222-4222-8222-222222222222','setup','{}')"), /permission denied/);
  await assert.rejects(asUser(patient, "select public.demo_trip_context('11111111-1111-4111-8111-111111111111')"), /permission denied/);
  await assert.rejects(asUser(patient, "insert into public.accounts(email, display_name, role, status) values ('hacker@example.test', 'Hacker', 'coordinator', 'active')"), /permission denied/);
  assert.equal((await asUser(driver, 'select * from public.accounts')).length, 0);
  assert.equal((await asUser(patient, 'select * from public.accounts')).length, 1);
});
test('preconfigured coordinator links by verified email once, without letting registration change the role', async () => {
  await db.query("insert into public.accounts(email, display_name, role, status) values ('coordinator@example.test', 'Test Coordinator', 'coordinator', 'active')");
  const [{ account }] = await asUser(coordinator, 'select public.current_account() as account');
  assert.equal(account.auth_user_id, coordinator);
  assert.equal(account.role, 'coordinator');
  await assert.rejects(asUser(coordinator, "select public.register_account('patient', 'Changed')"), /already registered/);
  // Demo provisioning is owner-managed and service-only; keep fixtures local to this transaction.
  await db.exec('begin; alter table auth.users add column raw_app_meta_data jsonb;');
  try {
    await db.query('update public.accounts set demo_admin=true where id=$1',[account.id]);
    const other=(await db.query("insert into public.accounts(email,display_name,role) values('other.coordinator@example.test','Other Coordinator','coordinator') returning id")).rows[0].id;
    const seed=(await readFile(new URL('../seed.sql',import.meta.url),'utf8')).replace(/^begin;$/m,'').replace(/^commit;$/m,'');
    await db.exec(seed);
    const driversBefore=(await db.query("select to_jsonb(a) as account,to_jsonb(d) as profile,to_jsonb(v) as vehicle,to_jsonb(s) as availability from private.seeded_accounts r join public.accounts a on a.id=r.account_id join public.drivers d on d.account_id=a.id join public.driver_vehicles v on v.driver_id=a.id join public.driver_availability s on s.driver_id=a.id where r.seed_key like 'driver%' order by a.id")).rows;
    await db.query("select set_config('request.jwt.claim.sub',$1,true)",[coordinator]);
    const legacyId=(await db.query('select gen_random_uuid() as id')).rows[0].id;
    await db.query("insert into auth.users(id,email,email_confirmed_at,raw_app_meta_data) values($1,'legacy.demo@example.test',now(),$2::jsonb)",[legacyId,JSON.stringify({demo_account_id:legacyId,demo_owner_id:account.id})]);
    await db.query("insert into public.accounts(id,auth_user_id,email,display_name,role,demo_owner_id,demo_key) values($1,null,'legacy.demo@example.test','Demo Patient','patient',$2,'patient')",[legacyId,account.id]);
    const legacyPatient=(await db.query("insert into public.patients(account_id,full_name,phone,pickup_address,mobility) values($1,'Demo Patient','80000999','Fictional address','ambulant') returning id",[legacyId])).rows[0].id;
    const legacySchedule=(await db.query("insert into public.treatment_schedules(patient_id,centre_id,days,start_time,end_time,effective_from,effective_to,kind) select $1,id,array[extract(isodow from (now() at time zone 'Asia/Singapore')::date)::integer],'10:00','11:00',(now() at time zone 'Asia/Singapore')::date,(now() at time zone 'Asia/Singapore')::date,'single' from public.dialysis_centres limit 1 returning id",[legacyPatient])).rows[0].id;
    const legacyTrip=(await db.query("insert into public.trips(patient_id,patient_name,source_schedule_id,root_schedule_id,occurrence_key,original_session_date,session_date,direction,origin,destination,treatment_start,treatment_end,arrival_by,source_version,patient_version,created_by) values($1,'Demo Patient',$2,$2,'legacy-fixture',current_date,current_date,'outbound','Old home','Old centre',now()+interval '2 hours',now()+interval '3 hours',now()+interval '105 minutes',1,1,$3) returning id",[legacyPatient,legacySchedule,account.id])).rows[0].id;
    await db.query("insert into public.trip_history(trip_id,actor_id,event,details) values($1,$2,'generated','{}')",[legacyTrip,account.id]);
    await db.query('insert into private.demo_scenarios(owner_id,schedule_id,trip_id) values($1,$2,$3)',[account.id,legacySchedule,legacyTrip]);
    await db.exec(seed);
    for(const [table,id] of [['public.accounts',legacyId],['auth.users',legacyId],['public.patients',legacyPatient],['public.treatment_schedules',legacySchedule],['public.trips',legacyTrip]])assert.equal((await db.query(`select count(*)::integer as count from ${table} where id=$1`,[id])).rows[0].count,0);
    assert.deepEqual((await db.query("select to_jsonb(a) as account,to_jsonb(d) as profile,to_jsonb(v) as vehicle,to_jsonb(s) as availability from private.seeded_accounts r join public.accounts a on a.id=r.account_id join public.drivers d on d.account_id=a.id join public.driver_vehicles v on v.driver_id=a.id join public.driver_availability s on s.driver_id=a.id where r.seed_key like 'driver%' order by a.id")).rows,driversBefore);
    await db.exec('set local role service_role;');
    await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({role:'service_role'})]);
    const manage=async(action,details={})=>(await db.query('select public.demo_manage($1,$2,$3::jsonb) as state',[account.id,action,JSON.stringify(details)])).rows[0].state;
    const first=await manage('setup');
    assert.equal(first.actors.length,10);assert.equal(first.trip.demo_owner_id,account.id);
    assert.equal(first.actors.filter(actor=>actor.role==='driver').length,3);
    assert.equal(first.actors.filter(actor=>actor.role==='patient').length,3);assert.equal(first.actors.filter(actor=>actor.role==='caregiver').length,3);
    assert.equal(first.actors.find(actor=>actor.role==='coordinator').demo_admin,false);
    assert.ok(first.actors.every(actor=>actor.demo_access_owner_id===account.id&&actor.demo_owner_id===null&&!actor.display_name.includes('Demo')));
    const again=await manage('setup');assert.equal(again.trip.id,first.trip.id);assert.deepEqual(again.actors.map(actor=>actor.id),first.actors.map(actor=>actor.id));
    const reset=await manage('reset',{confirmed:true});assert.notEqual(reset.trip.id,first.trip.id);assert.equal(reset.scenario.traffic,'normal');
    await db.exec('reset role;');
    assert.ok((await db.query('select deleted_at from public.trips where id=$1',[first.trip.id])).rows[0].deleted_at);
    await db.query("insert into public.trip_history(trip_id,actor_id,event,details) values($1,$2,'confirmed','{}')",[reset.trip.id,account.id]);
    assert.equal((await db.query('select count(*)::integer as count from public.trip_notifications where recipient_id=$1',[other])).rows[0].count,0);
    assert.ok((await db.query('select message from public.trip_notifications where recipient_id=$1',[account.id])).rows.every(row=>row.message.startsWith('Demo · ')));
  } finally {await db.exec('rollback');}
});
test('anonymous callers cannot execute account functions or read accounts', async () => {
  await db.exec('set role anon');
  try {
    await assert.rejects(db.query('select public.current_account()'), /permission denied/);
    await assert.rejects(db.query('select * from public.accounts'), /permission denied/);
  } finally { await db.exec('reset role'); }
});

test('reapplying the schema preserves account status, roles and first-login links', async () => {
  const before = (await db.query('select * from public.accounts order by email')).rows;
  await db.exec(schema);
  assert.deepEqual((await db.query('select * from public.accounts order by email')).rows, before);
  assert.equal((await db.query("select to_regprocedure('public.review_account(uuid,text)') as fn")).rows[0].fn, null);
});

test('patient-owned profiles are unique, private, shared with coordinators and cannot self-reactivate', async () => {
  const local = await databaseWithAuth();
  try {
    await local.exec(schema);
    await local.query("insert into public.accounts(auth_user_id,email,display_name,role) values ($1,'patient@example.test','Patient','patient'),($2,'coordinator@example.test','Coordinator','coordinator'),($3,'driver@example.test','Driver','driver')", [patient, coordinator, driver]);
    async function act(id, sql, args = []) {
      await local.exec('begin; set local role authenticated');
      try {
        await local.query("select set_config('request.jwt.claim.sub',$1,true)", [id]);
        const result = await local.query(sql, args); await local.exec('commit'); return result.rows;
      } catch (e) { await local.exec('rollback'); throw e; }
    }
    const details = { full_name: 'Test Patient', birth_date: '1990-04-12', gender: 'female', phone: '81234567', pickup_address: 'Test address', mobility: 'wheelchair', assistance_required: true };
    const save = (id, body = details) => act(id, 'select public.save_my_patient($1::jsonb) as patient', [JSON.stringify(body)]);
    const [{ patient: record }] = await save(patient);
    assert.equal(record.status, 'active');
    assert.equal((await act(patient, 'select public.current_account() as account'))[0].account.full_name, 'Test Patient');
    assert.equal((await act(coordinator, 'select public.current_account() as account'))[0].account.full_name, null);
    assert.ok(record.account_id);
    assert.equal((await act(patient, 'select * from public.patients')).length, 1);
    assert.equal((await act(coordinator, 'select * from public.patients'))[0].id, record.id);
    assert.deepEqual(await act(driver, 'select * from public.patients'), []);
    for (const id of [driver, stranger, coordinator]) await assert.rejects(save(id), /Patient access required/);
    for (const body of [{ ...details, status: 'active' }, { ...details, account_id: record.account_id }, { ...details, id: record.id }, { ...details, assistance_required: 'true' }]) await assert.rejects(save(patient, body), /Invalid patient/);
    await assert.rejects(act(patient, "insert into public.patients(full_name,phone,pickup_address,mobility) values ('Other','81234567','Other address','ambulant')"), /(row-level security|permission denied)/);
    await assert.rejects(act(patient, "update public.patients set status='inactive' returning *"), /permission denied/);
    await assert.rejects(save(patient), /version/);
    const [{ patient: updated }] = await save(patient, { ...details, version: record.version, phone: '87654321', unit_no: '#05-12', postal_code: '560123', notes: 'Call on arrival.' });
    assert.equal(updated.version, record.version + 1);
    await assert.rejects(save(patient, { ...details, version: record.version }), error => error.code === 'PT409');
    assert.equal(updated.id, record.id);
    assert.equal(updated.phone, '87654321');
    assert.equal(updated.unit_no, '#05-12');
    assert.equal(updated.postal_code, '560123');
    assert.equal(updated.notes, 'Call on arrival.');
    const [{ patient: compatible }] = await save(patient, { ...details, version: updated.version });
    assert.equal(compatible.notes, 'Call on arrival.');
    await assert.rejects(act(coordinator, 'select public.save_patient($1,$2::jsonb)', [record.id, JSON.stringify({ notes: 'Stale coordinator', version: record.version })]), error => error.code === 'PT409');
    await assert.rejects(save(patient, { ...details, version: compatible.version, postal_code: '123' }), /check constraint/);
    await assert.rejects(save(patient, { ...details, version: compatible.version, notes: 'x'.repeat(1001) }), /check constraint/);
    assert.equal((await act(coordinator, 'select * from public.patients')).length, 1);
    await local.query("update auth.users set email_confirmed_at=now() where id=$1", [stranger]);
    await local.query("insert into public.accounts(auth_user_id,email,display_name,role) values ($1,'stranger@example.test','Other Patient','patient')", [stranger]);
    const [{ patient: other }] = await save(stranger, { ...details, full_name: 'Other Patient' });
    assert.notEqual(other.id, record.id);
    assert.equal((await act(patient, 'select * from public.patients')).length, 1);
    assert.equal((await act(stranger, 'select * from public.patients'))[0].id, other.id);
    // A separate manually-created record is neither claimed nor overwritten by a matching name.
    await local.query("insert into public.patients(full_name,phone,pickup_address,mobility) values ('Test Patient','81234567','Legacy address','ambulant')");
    assert.equal((await act(patient, 'select * from public.patients')).length, 1);
    await local.exec(schema);
    assert.equal((await act(patient, 'select * from public.patients'))[0].id, record.id);
    await act(coordinator, 'select public.save_patient($1,$2::jsonb)', [record.id, JSON.stringify({ status: 'inactive', version: compatible.version })]);
    await assert.rejects(save(patient), /Patient profile is inactive/);
    await local.query("update public.accounts set status='inactive' where auth_user_id=$1", [patient]);
    assert.deepEqual(await act(patient, 'select * from public.patients'), []);
    await assert.rejects(save(patient), /Patient access required/);
    await local.exec('set role anon');
    await assert.rejects(local.query('select public.save_my_patient($1::jsonb)', [JSON.stringify(details)]), /permission denied/);
    await local.exec('reset role');
  } finally { await local.close(); }
});

test('patient registration creates account and profile atomically and rejects incomplete signup', async () => {
  const local = await databaseWithAuth();
  try {
    await local.exec(schema);
    async function register(details) {
      await local.exec('begin; set local role authenticated');
      try {
        await local.query("select set_config('request.jwt.claim.sub',$1,true)", [patient]);
        const result = await local.query("select public.register_patient_account('Test Patient',$1::jsonb) as account", [JSON.stringify(details)]);
        await local.exec('commit'); return result.rows[0].account;
      } catch (error) { await local.exec('rollback'); throw error; }
    }
    const details = { full_name: 'Test Patient', birth_date: '1990-04-12', gender: 'female', phone: '+65 81234567', pickup_address: 'Test street', unit_no: '', postal_code: '560123', notes: '', mobility: 'ambulant', assistance_required: false };
    for (const body of [null, {}, { ...details, birth_date: undefined }, { ...details, birth_date: '2020-02-30' }, { ...details, birth_date: '2999-01-01' }, { ...details, gender: null }, { ...details, notes: 'x'.repeat(1001) }, { ...details, postal_code: '123' }, { ...details, status: 'active' }]) {
      await assert.rejects(register(body));
      assert.equal((await local.query('select count(*)::int as count from public.accounts')).rows[0].count, 0);
      assert.equal((await local.query('select count(*)::int as count from public.patients')).rows[0].count, 0);
    }
    const account = await register(details);
    assert.equal(account.profile_complete, true);
    assert.equal(account.role, 'patient');
    assert.equal((await local.query('select account_id from public.patients')).rows[0].account_id, account.id);
    await assert.rejects(register(details), /already registered/);
    assert.equal((await local.query('select count(*)::int as count from public.patients')).rows[0].count, 1);
  } finally { await local.close(); }
});

test('treatment schedules enforce ownership, overlap checks and coordinator read-only access', async () => {
  const local = await databaseWithAuth();
  try {
    await local.exec(schema);
    await local.exec(`insert into public.accounts(auth_user_id,email,display_name,role) values
      ('${patient}','patient@example.test','Patient','patient'),
      ('${coordinator}','coordinator@example.test','Coordinator','coordinator'),
      ('${driver}','driver@example.test','Driver','driver');`);
    await local.exec(`insert into public.patients(account_id,full_name,phone,pickup_address,mobility,assistance_required,status)
      select id,'Patient','81234567','Test street','ambulant',false,'active' from public.accounts where role='patient';
      insert into public.dialysis_centres(name,address,postal_code) values ('Test Centre','Test address','560123');`);
    const own = async (who, sql) => {
      await local.exec('begin; set local role authenticated;');
      try { await local.query("select set_config('request.jwt.claim.sub',$1,true)",[who]); const r=await local.query(sql); await local.exec('commit'); return r.rows; }
      catch(e) { await local.exec('rollback'); throw e; }
    };
    const insert = `insert into public.treatment_schedules(patient_id,centre_id,days,start_time,end_time,effective_from,effective_to)
      select p.id,c.id,array[1],'09:00','13:00','2026-10-20','2026-12-31' from public.patients p cross join public.dialysis_centres c where c.name='Test Centre' returning *`;
    assert.equal((await own(patient,insert)).length,1);
    await assert.rejects(own(patient,insert),/overlap/i);
    assert.equal((await own(coordinator,'select * from public.treatment_schedules')).length,1);
    assert.equal((await own(driver,'select * from public.treatment_schedules')).length,0);
    assert.equal((await own(driver,insert)).length,0);
    const ids=(await local.query('select p.id as patient_id,c.id as centre_id from public.patients p cross join public.dialysis_centres c where c.name=\'Test Centre\'')).rows[0];
    await assert.rejects(own(driver,`insert into public.treatment_schedules(patient_id,centre_id,days,start_time,end_time,effective_from,effective_to)
      values ('${ids.patient_id}','${ids.centre_id}',array[2],'09:00','13:00','2026-10-20','2026-12-31')`),/policy|access/i);
    await assert.rejects(own(patient,"update public.treatment_schedules set patient_id=gen_random_uuid()"),/permission denied/i);
    // A valid occurrence outside the other schedule range is not an overlap.
    await own(patient,insert.replace("'2026-10-20','2026-12-31'","'2027-01-04','2027-01-04'"));
    await assert.rejects(own(coordinator,"update public.treatment_schedules set start_time='10:00' returning id"),/permission/i);
    await assert.rejects(own(patient,"update public.treatment_schedules set end_time='08:00'"),/permission/i);
    const [future] = await own(patient,`insert into public.treatment_schedules(patient_id,centre_id,kind,days,start_time,end_time,effective_from,effective_to)
      select '${ids.patient_id}','${ids.centre_id}','single',array[extract(isodow from day)::integer],'15:00','16:00',day,day
      from (select (now() at time zone 'Asia/Singapore')::date+1 as day) fixture returning *`);
    for (const generated of [false,true]) {
      if (generated) await own(coordinator,`select public.generate_treatment_trips('${future.id}',(now() at time zone 'Asia/Singapore')::date+1,(now() at time zone 'Asia/Singapore')::date+1,1)`);
      await assert.rejects(own(patient,`select public.update_my_treatment('${future.id}','{"start_time":"16:00","end_time":"17:00"}'::jsonb,1)`),/permission/i);
      await assert.rejects(own(patient,`select public.delete_my_treatment('${future.id}',1)`),/permission/i);
      await assert.rejects(own(patient,`select private.update_my_treatment('${future.id}','{}'::jsonb,1)`),/permission/i);
      await assert.rejects(own(patient,`insert into public.treatment_schedules(patient_id,centre_id,kind,days,start_time,end_time,effective_from,effective_to,replaces_schedule_id,replaces_date)
        values('${ids.patient_id}','${ids.centre_id}','single',array[1],'16:00','17:00','2026-10-26','2026-10-26','${future.id}','2026-10-26')`),/permission|policy/i);
    }
    await local.exec(`update public.accounts set status='inactive' where role='patient'`);
    assert.equal((await own(patient,'select * from public.treatment_schedules')).length,0);
    await local.exec(schema);
    assert.equal((await local.query('select * from public.treatment_schedules')).rows.length,3);
  } finally { await local.close(); }
});


test('schedule date bounds and nonempty recurrence are enforced for direct authenticated writes', async () => {
  const local = await databaseWithAuth();
  try {
    await local.exec(schema);
    await local.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${patient}',false);`);
    await local.query("select public.register_patient_account('Fixture',$1::jsonb)", [JSON.stringify(signupDetails)]);
    const insert = (date, day=1) => local.query(`insert into public.treatment_schedules(patient_id,centre_id,days,start_time,end_time,effective_from,effective_to)
      select p.id,c.id,array[$1::integer],'09:00','10:00',$2::date,$2::date from public.patients p cross join public.dialysis_centres c limit 1 returning id`, [day,date]);
    for(const date of ['10000-01-01','0001-01-01 BC','infinity','-infinity']) await assert.rejects(insert(date), /date|range|finite|check/i);
    await assert.rejects(insert('2026-10-20'), /weekday|occurrence|check/i);
    assert.equal((await insert('2026-10-19')).rows.length,1);
  } finally { await local.close(); }
});

// Opt-in integration proof against a disposable local PostgreSQL cluster. Supply
// PG_CONCURRENCY_BIN (absolute psql path), PG_CONCURRENCY_SOCKET (Unix socket
// directory), and optionally PG_CONCURRENCY_PORT. The connected local role must
// create/drop databases; fixture roles anon/authenticated must already exist.
// Each race uses independent connections and verifies an actual lock wait.
test('real PostgreSQL serializes overlaps, trip generation and stale patient writes', {
  skip: !process.env.PG_CONCURRENCY_BIN && !process.env.PG_CONCURRENCY_SOCKET,
  timeout: 30000,
}, async () => {
  const { execFile, spawn } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { isAbsolute, join } = await import('node:path');
  const { stat } = await import('node:fs/promises');
  const binary = process.env.PG_CONCURRENCY_BIN;
  const socket = process.env.PG_CONCURRENCY_SOCKET;
  const port = process.env.PG_CONCURRENCY_PORT ?? '5432';
  assert.ok(binary && isAbsolute(binary), 'PG_CONCURRENCY_BIN must be an absolute psql path.');
  assert.ok(socket && isAbsolute(socket), 'Only an absolute local Unix socket directory is allowed.');
  assert.match(port, /^\d+$/);
  assert.ok(Number(port) > 0 && Number(port) <= 65535);
  assert.ok((await stat(join(socket, `.s.PGSQL.${port}`))).isSocket(), 'A live local PostgreSQL Unix socket is required.');
  // Inherited PGHOSTADDR/PGSERVICE can override libpq host handling. Remove all
  // PG settings so this opt-in test cannot accidentally use a remote database.
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PG')));
  environment.PGCONNECT_TIMEOUT = '3';
  const database = `dialysis_race_${process.pid}_${Date.now()}`;
  const args = name => ['-X', '-w', '-qAt', '-h', socket, '-p', port, '-d', name, '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose'];
  const execute = promisify(execFile);
  const processes = new Set();
  const literal = value => `'${String(value).replaceAll("'", "''")}'`;
  async function query(sql, name = database, application = 'dialysis-concurrency-probe') {
    try {
      const result = await execute(binary, [...args(name), '-c', sql], {
        env: { ...environment, PGAPPNAME: application }, timeout: 10000, maxBuffer: 4 * 1024 * 1024,
      });
      return { ...result, code: 0 };
    } catch (error) { return { stdout: error.stdout ?? '', stderr: error.stderr ?? '', code: error.code }; }
  }
  async function checked(sql, name = database) {
    const result = await query(sql, name);
    assert.equal(result.code, 0, result.stderr);
    return result.stdout.trim();
  }
  const authenticated = (sql, user = patient) => `begin; set local role authenticated;
    select set_config('request.jwt.claim.sub',${literal(user)},true);
    set local statement_timeout='8s'; set local idle_in_transaction_session_timeout='8s'; ${sql}`;
  async function race(label, leaderSql, followerSql, expectedState, user = patient, followerUser = user) {
    const leader = spawn(binary, [...args(database), '-f', '-'], {
      env: { ...environment, PGAPPNAME: `${database}_leader` }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    processes.add(leader);
    let stderr = ''; let output = '';
    leader.stderr.on('data', chunk => { stderr += chunk; });
    const finished = new Promise(resolve => {
      leader.once('error', error => resolve({ code: error.code }));
      leader.once('close', code => { processes.delete(leader); resolve({ code }); });
    });
    const ready = new Promise((resolve, reject) => {
      leader.stdout.on('data', chunk => { output += chunk; if (output.includes('PROBE_LOCK_HELD')) resolve(); });
      leader.once('error', reject);
      leader.once('close', () => { if (!output.includes('PROBE_LOCK_HELD')) reject(new Error(stderr || 'Leader exited before taking its lock.')); });
    });
    // Keep the leader transaction open until pg_stat_activity proves the other
    // connection is blocked. No sleep-based assumption about overlap is needed.
    leader.stdin.write(`${authenticated(leaderSql, user)} select 'PROBE_LOCK_HELD';\n`);
    try {
      await ready;
      const follower = query(`${authenticated(followerSql, followerUser)} commit;`, database, `${database}_follower`);
      let blocked = false;
      for (let attempt = 0; attempt < 60; attempt++) {
        if (await checked(`select count(*) from pg_stat_activity where application_name=${literal(`${database}_follower`)} and wait_event_type='Lock'`) === '1') {
          blocked = true; break;
        }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      leader.stdin.end('commit;\n');
      assert.equal((await finished).code, 0, `${label}: ${stderr}`);
      const result = await follower;
      assert.ok(blocked, `${label}: independent connections must demonstrably overlap on a lock.`);
      if (expectedState) {
        assert.notEqual(result.code, 0, `${label}: stale/conflicting write unexpectedly succeeded.`);
        assert.ok(result.stderr.includes(expectedState), `${label}: ${result.stderr}`);
      } else assert.equal(result.code, 0, `${label}: ${result.stderr}`);
    } finally {
      if (processes.has(leader)) { leader.stdin.end('rollback;\n'); await finished; }
    }
  }
  await checked("select case when count(*)=2 then 'ready' else 'missing fixture roles' end from pg_roles where rolname in ('anon','authenticated')", 'postgres').then(value => assert.equal(value, 'ready'));
  await checked(`create database ${database}`, 'postgres');
  try {
    await checked(`create schema auth;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
      create table auth.identities(user_id uuid,provider text);
      create function auth.uid() returns uuid language sql stable as
        $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;
      insert into auth.users values (${literal(patient)},'patient@example.test',now()),(${literal(coordinator)},'coordinator@example.test',now());
      insert into auth.identities values (${literal(patient)},'google'),(${literal(coordinator)},'google');`);
    await checked(schema);
    await checked(`insert into public.accounts(auth_user_id,email,display_name,role) values
      (${literal(patient)},'patient@example.test','Fixture Patient','patient'),(${literal(coordinator)},'coordinator@example.test','Fixture Coordinator','coordinator');
      insert into public.patients(account_id,full_name,phone,pickup_address,mobility)
      select id,'Fixture Patient','81234567','Fixture street','ambulant' from public.accounts where role='patient';`);
    const patientId = await checked('select id from public.patients limit 1');
    const centreId = await checked('select id from public.dialysis_centres order by id limit 1');
    const insert = `insert into public.treatment_schedules(patient_id,centre_id,days,start_time,end_time,effective_from,effective_to)
      values (${literal(patientId)},${literal(centreId)},array[1],'09:00','10:00','2026-10-19','2026-12-28');`;
    await race('overlapping inserts', insert, insert, '23P01');
    assert.equal(await checked('select count(*) from public.treatment_schedules'), '1');
    await checked('truncate public.treatment_schedules cascade;');
    const future = await checked("select ((now() at time zone 'Asia/Singapore')::date+8)::text");
    await checked(`${authenticated(`insert into public.treatment_schedules(patient_id,centre_id,kind,days,start_time,end_time,effective_from,effective_to)
      values (${literal(patientId)},${literal(centreId)},'single',array[extract(isodow from ${literal(future)}::date)::integer],
        '09:00','10:00',${literal(future)},${literal(future)});`)} commit;`);
    const [tripSource, tripVersion] = (await checked('select id,version from public.treatment_schedules limit 1')).split('|');
    const generate = version => `select public.generate_treatment_trips(${literal(tripSource)},${literal(future)},${literal(future)},${version});`;
    await race('simultaneous duplicate trip generation', generate(tripVersion), generate(tripVersion), undefined, coordinator);
    assert.equal(await checked('select count(*) from public.trips'), '2');
    assert.equal(await checked('select count(*) from public.trip_history'), '2', 'Idempotent generation must not duplicate generated history.');
    const [outboundId, outboundVersion] = (await checked("select id,version from public.trips where direction='outbound'")).split('|');
    const deleteTrip = (id, version) => `select public.delete_trip(${literal(id)},${version});`;
    const profileChange = `select public.save_patient(${literal(patientId)},jsonb_build_object('version',(select version from public.patients where id=${literal(patientId)}),'notes','Updated fixture'));`;
    await race('profile changes block stale trip deletion', profileChange, deleteTrip(outboundId, outboundVersion), 'PT409', coordinator);
    const refreshedSourceVersion = tripVersion;
    const staleTripVersion = await checked(`select version from public.trips where id=${literal(outboundId)}`);
    await race('generation refresh blocks stale trip deletion', generate(refreshedSourceVersion), deleteTrip(outboundId, staleTripVersion), 'PT409', coordinator);
    assert.equal(await checked('select count(*) from public.trips where deleted_at is null'), '2');
    const currentTripVersion = await checked(`select version from public.trips where id=${literal(outboundId)}`);
    await race('manual regeneration restores a concurrently deleted trip', deleteTrip(outboundId, currentTripVersion), generate(refreshedSourceVersion), undefined, coordinator);
    assert.equal(await checked('select count(*) from public.trips'), '2', 'Restoration reuses the existing journey identity.');
    assert.equal(await checked('select count(*) from public.trips where deleted_at is null'), '2', 'Manual generation restores the deleted journey and preserves its other leg.');
    assert.equal(await checked("select count(*) from public.trip_history where event='deleted'"), '1');
    const coordinatorRead = sql => `set role authenticated; select set_config('request.jwt.claim.sub',${literal(coordinator)},false); ${sql}`;
    assert.equal(await checked("select count(*) from public.trip_history where event='restored'"), '1');
    assert.equal(await checked(coordinatorRead(`select public.list_trips(1,${literal(future)},${literal(future)},'all')->>'total'`)), '2');
    const repeated = await checked(coordinatorRead(generate(refreshedSourceVersion)));
    assert.ok(repeated.includes('"unchanged": 2'), 'Repeated generation must leave both restored journeys unchanged.');
    const restoredVersion = await checked(`select version from public.trips where id=${literal(outboundId)}`);
    await race('deletion after generation remains deleted until another manual generation', generate(refreshedSourceVersion), deleteTrip(outboundId, restoredVersion), undefined, coordinator);
    assert.equal(await checked('select count(*) from public.trips where deleted_at is null'), '1');
    await checked(coordinatorRead(generate(refreshedSourceVersion)));
    assert.equal(await checked('select count(*) from public.trips where deleted_at is null'), '2');
    const version = Number(await checked(`select version from public.patients where id=${literal(patientId)}`));
    const update = (status, notes) => `select public.save_patient(${literal(patientId)},${literal(JSON.stringify({ version, status, notes }))}::jsonb);`;
    await race('stale patient status', update('inactive', 'First coordinator'), update('active', 'Stale notes edit'), 'PT409', coordinator);
    assert.equal(await checked(`select status from public.patients where id=${literal(patientId)}`), 'inactive');
  } finally {
    for (const child of processes) child.kill();
    await checked(`drop database ${database} with (force)`, 'postgres');
  }
});


test('coordinators generate idempotent unfilled journeys with buffers, exceptions and private history', async () => {
  const local=await databaseWithAuth();
  try {
    await local.exec(schema);
    await local.exec(`insert into public.accounts(auth_user_id,email,display_name,role) values
      ('${patient}','patient@example.test','Patient','patient'),('${coordinator}','coordinator@example.test','Coordinator','coordinator'),('${driver}','driver@example.test','Driver','driver'),('${stranger}','stranger@example.test','Other','patient');
      insert into public.patients(account_id,full_name,phone,pickup_address,mobility,postal_code)
      select id,display_name,'81234567','Fixture street','ambulant','560123' from public.accounts where role='patient';`);
    const own=async(who,sql,params=[],trustedFixture=false)=>{
      await local.exec(trustedFixture ? 'begin;' : 'begin; set local role authenticated;');
      try {await local.query("select set_config('request.jwt.claim.sub',$1,true)",[who]);const result=await local.query(sql,params);await local.exec('commit');return result.rows;}
      catch(error){await local.exec('rollback');throw error;}
    };
    const first=(await local.query(`select ((now() at time zone 'Asia/Singapore')::date+1+
      ((1-extract(isodow from (now() at time zone 'Asia/Singapore')::date+1)::integer+7)%7))::text as date`)).rows[0].date;
    const dates=(await local.query("select ($1::date+1)::text as moved,($1::date+14)::text as until",[first])).rows[0];
    const ids=(await own(patient,'select p.id as patient,c.id as centre from public.patients p cross join public.dialysis_centres c order by c.id limit 1'))[0];
    const [series]=await own(patient,`insert into public.treatment_schedules(patient_id,centre_id,days,start_time,end_time,effective_from,effective_to)
      values($1,$2,array[1],'09:00','13:00',$3,$4) returning *`,[ids.patient,ids.centre,first,dates.until]);
    // Database-owner fixture models an already-approved historical replacement.
    const [moved]=await own(patient,`insert into public.treatment_schedules(patient_id,centre_id,kind,days,start_time,end_time,effective_from,effective_to,replaces_schedule_id,replaces_date)
      values($1,$2,'single',array[2],'10:00','14:00',$3,$3,$4,$5) returning *`,[ids.patient,ids.centre,dates.moved,series.id,first],true);
    const generate=async(who,version)=>(await own(who,'select public.generate_treatment_trips($1,$2,$3,$4) as result',[series.id,first,dates.until,version]))[0].result;
    const coverage=async()=> (await own(coordinator,'select private.treatment_trip_coverage($1) as result',[series.id]))[0].result;
    assert.equal((await coverage()).status,'not_generated');assert.equal((await coverage()).expected_sessions,3);
    await assert.rejects(own(patient,'select private.treatment_trip_coverage($1)',[series.id]),/Coordinator/);
    const patientList=(await own(patient,'select public.list_treatments() as result'))[0].result;
    assert.ok(patientList.schedules.every(row=>!('trip_generation' in row)));

    for(const who of [patient,driver,stranger]) await assert.rejects(generate(who,2),/Coordinator|denied/i);
    assert.equal((await generate(coordinator,2)).created,6);
    const [again]=await own(coordinator,'select public.list_trips($1,$2,$3,$4) as result',[1,first,dates.until,'all']);
    assert.equal(again.result.total,6);
    assert.equal(again.result.counts.unfilled,6);
    assert.equal(again.result.trips.filter(trip=>trip.session_date===first).length,0);
    assert.ok(again.result.trips.every(trip=>trip.pickup_at===null&&trip.status==='unfilled'&&!trip.review_required));
    for(const trip of again.result.trips) {
      if(trip.direction==='outbound') assert.equal(Date.parse(trip.treatment_start)-Date.parse(trip.arrival_by),15*60000);
      else assert.equal(Date.parse(trip.pickup_not_before)-Date.parse(trip.treatment_end),15*60000);
    }
    assert.equal((await generate(coordinator,2)).unchanged,6);
    const complete=await coverage();assert.equal(complete.status,'generated');assert.equal(complete.through,dates.until);
    assert.deepEqual(complete.generated_ranges,[{from_date:dates.moved,until_date:dates.until}]);
    const coordinatorList=(await own(coordinator,'select public.list_treatments() as result'))[0].result;
    assert.equal(coordinatorList.schedules.find(row=>row.id===series.id).trip_generation.status,'generated');
    const firstJourney=again.result.trips.find(trip=>trip.source_schedule_id===moved.id&&trip.direction==='return');
    await local.query('update public.trips set deleted_at=now() where id=$1',[firstJourney.id]);
    const hole=await coverage();assert.equal(hole.status,'partial');assert.equal(hole.through,null);
    assert.equal(hole.generated_ranges.length,1);assert.equal(hole.generated_ranges[0].until_date,dates.until);
    assert.notEqual(hole.generated_ranges[0].from_date,dates.moved);
    await local.query('update public.trips set deleted_at=null where id=$1',[firstJourney.id]);
    await local.query('update public.trips set review_required=true where source_schedule_id=$1',[moved.id]);
    assert.equal((await coverage()).status,'partial');
    await local.query('update public.trips set review_required=false where source_schedule_id=$1',[moved.id]);
    assert.equal((await coverage()).status,'generated');

    assert.equal((await own(patient,'select * from public.trips')).length,6);
    assert.equal((await own(stranger,'select * from public.trips')).length,0);
    assert.equal((await own(driver,'select * from public.trips')).length,0);
    await assert.rejects(own(coordinator,"update public.trips set status='unfilled'"),/permission/i);
    const edit={start_time:'10:00',end_time:'14:00'};
    await own(patient,'select public.update_my_treatment($1,$2::jsonb,$3)',[series.id,JSON.stringify(edit),2],true);
    assert.equal((await own(coordinator,'select * from public.trips where review_required')).length,6);
    await assert.rejects(generate(coordinator,2),/changed/i);
    assert.equal((await generate(coordinator,3)).updated,6);
    assert.equal((await own(coordinator,'select * from public.trips where review_required')).length,0);
    await own(patient,'select public.save_my_patient($1::jsonb)',[JSON.stringify({...signupDetails,pickup_address:'Updated fixture street',version:1})]);
    assert.equal((await own(coordinator,'select * from public.trips where review_required')).length,6);
    assert.equal((await generate(coordinator,3)).updated,6);
    assert.ok((await own(patient,"select * from public.trips where direction='outbound'")).every(trip=>trip.origin.includes('Updated fixture street')));
    await own(patient,'select public.delete_my_treatment($1,$2)',[moved.id,1],true);
    assert.equal((await generate(coordinator,4)).updated,6);
    assert.equal((await own(coordinator,'select * from public.trips')).length,6);
    await own(patient,'select public.delete_my_treatment($1,$2)',[series.id,4],true);
    assert.equal((await own(coordinator,'select * from public.trips where review_required')).length,6);
    assert.ok((await own(patient,'select * from public.trip_history')).length>=12);
    assert.equal((await own(stranger,'select * from public.trip_history')).length,0);
    await assert.rejects(generate(coordinator,4),/not found/i);
    // A return pickup is still pending after treatment ends, and Next pickup is
    // independent of the list's chosen date window.
    await local.query(`update public.trips set session_date=((now()-interval '1 hour') at time zone 'Asia/Singapore')::date,
      treatment_start=now()-interval '1 hour',treatment_end=now()-interval '5 minutes',pickup_not_before=now()+interval '10 minutes',review_required=false
      where id=(select id from public.trips where direction='return' limit 1)`);
    const upcoming=(await own(patient,'select public.list_trips($1,$2,$3,$4) as result',[1,first,dates.until,'all']))[0].result.next_trip;
    assert.equal(upcoming.direction,'return');
    assert.equal(upcoming.review_required,false);
    await own(patient,'select public.save_my_patient($1::jsonb)',[JSON.stringify({...signupDetails,pickup_address:'Another fixture street',version:2})]);
    assert.equal((await own(patient,'select review_required from public.trips where id=$1',[upcoming.id]))[0].review_required,true);
  } finally {await local.close();}
});


test('trip search precedes pagination and manual generation restores deleted trips with history',async()=>{
  const local=await databaseWithAuth();
  try {
    await local.exec(schema);
    await local.exec(`insert into public.accounts(auth_user_id,email,display_name,role) values
      ('${patient}','patient@example.test','Fixture Patient','patient'),('${coordinator}','coordinator@example.test','Coordinator','coordinator'),('${driver}','driver@example.test','Driver','driver');
      insert into public.patients(account_id,full_name,phone,pickup_address,mobility) select id,'Fixture Patient','81234567','Fixture street','ambulant' from public.accounts where role='patient';`);
    const own=async(who,sql,params=[])=>{await local.exec('begin; set local role authenticated;');try{
      await local.query("select set_config('request.jwt.claim.sub',$1,true)",[who]); const result=await local.query(sql,params); await local.exec('commit');return result.rows;
    }catch(error){await local.exec('rollback');throw error;}};
    const dates=(await local.query(`select ((now() at time zone 'Asia/Singapore')::date+1)::text as first,
      ((now() at time zone 'Asia/Singapore')::date+13)::text as until`)).rows[0];
    const ids=(await own(patient,'select p.id as patient,c.id as centre from public.patients p cross join public.dialysis_centres c limit 1'))[0];
    const sources=await own(patient,`insert into public.treatment_schedules(patient_id,centre_id,kind,days,start_time,end_time,effective_from,effective_to)
      select $1,$2,'single',array[extract(isodow from day)::integer],'09:00','13:00',day::date,day::date
      from generate_series($3::date::timestamp,$4::date::timestamp,interval '1 day') day returning *`,[ids.patient,ids.centre,dates.first,dates.until]);
    const gen=async()=>{
      const total={created:0,updated:0,unchanged:0,skipped:0,total:0};
      for(const source of sources) {
        const result=(await own(coordinator,'select public.generate_treatment_trips($1,$2,$2,1) as result',[source.id,source.effective_from]))[0].result;
        for(const key of Object.keys(total)) total[key]+=result[key];
      }
      return total;
    };
    await gen();
    const list=async(who=coordinator,term='',direction='all')=>(await own(who,'select public.list_trips(1,$1,$2,$3,$4,$5) as result',[dates.first,dates.until,'all',term,direction]))[0].result;
    const descending = (await own(coordinator, "select public.list_trips(1,$1,$2,'all','','all','treatment_start','desc') as result", [dates.first,dates.until]))[0].result;
    assert.equal(descending.trips[0].session_date,dates.until);
    assert.equal(descending.total,26);
    assert.equal(descending.trips.length,10);
    const upcoming=(await own(patient,"select public.list_trips(1,$1,$2,'upcoming,in-progress','','all','pickup_time','asc') as result",[dates.first,dates.until]))[0].result;
    assert.equal(upcoming.total,26);assert.equal(upcoming.counts.upcoming,26);
    const pickupTime=trip=>Date.parse(trip.pickup_at??trip.pickup_not_before??trip.arrival_by)-(trip.pickup_at||trip.pickup_not_before?0:trip.duration_minutes*60000);
    assert.ok(upcoming.trips.every((trip,index)=>index===0||pickupTime(upcoming.trips[index-1])<=pickupTime(trip)));
    const middlePage = (await own(coordinator, "select public.list_trips(2,$1,$2,'all','','all','treatment_start','desc') as result", [dates.first,dates.until]))[0].result;
    const lastPage = (await own(coordinator, "select public.list_trips(3,$1,$2,'all','','all','treatment_start','desc') as result", [dates.first,dates.until]))[0].result;
    assert.equal(middlePage.trips.length, 10);
    assert.equal(lastPage.trips.length, 6);
    assert.equal(new Set([...descending.trips, ...middlePage.trips, ...lastPage.trips].map(trip => trip.id)).size, 26);
    for (const args of [['notes', 'asc'], ['status', 'bad']]) await assert.rejects(own(coordinator, "select public.list_trips(1,$1,$2,'all','','all',$3,$4)", [dates.first, dates.until, ...args]), /Invalid/);
    assert.equal((await own(driver, "select public.list_trips(1,$1,$2,'all','','all','patient_name','desc') as result", [dates.first, dates.until]))[0].result.total,0);

    assert.equal((await list(coordinator,' RETURN ')).total,13);
    assert.equal((await list(coordinator,'09:00')).total,26);
    assert.equal((await list(coordinator,'Fixture street')).total,26);
    assert.equal((await list(coordinator,'Fixture Patient')).total,26);
    assert.equal((await list(coordinator,ids.patient)).total,26);
    assert.equal((await list(patient,ids.patient)).total,26,'Patient-ID search matches the patient’s own permitted trips.');
    assert.equal((await list(coordinator,'','outbound')).total,13);
    assert.equal((await list(coordinator,'','outbound,return')).total,26);
    for (const direction of ['', 'outbound,unknown', 'all,return', 'outbound,']) await assert.rejects(list(coordinator,'',direction), /Invalid/);
    assert.equal((await list(coordinator,'%')).total,0);
    const trip=(await list()).trips[0];
    const remove=(who,version)=>own(who,'select public.delete_trip($1,$2) as id',[trip.id,version]);
    for(const who of [patient,driver]) await assert.rejects(remove(who,trip.version),/Coordinator|denied/i);
    await assert.rejects(own(coordinator,'delete from public.trips where id=$1',[trip.id]),/permission/i);
    await assert.rejects(remove(coordinator,trip.version+1),/changed/i);
    assert.equal((await remove(coordinator,trip.version))[0].id,trip.id);
    assert.equal((await list()).total,25);
    assert.equal((await list()).counts.unfilled,25);
    assert.notEqual((await list()).next_trip?.id,trip.id);
    assert.ok((await own(coordinator,"select * from public.trip_history where trip_id=$1 and event='deleted'",[trip.id])).length===1);
    await assert.rejects(remove(coordinator,trip.version),/not found|deleted/i);
    const remainingBefore = (await own(coordinator,'select * from public.trips where id<>$1 order by id',[trip.id]));
    const again=await gen();
    assert.equal(again.created,0);
    assert.equal(again.updated,1);
    assert.equal(again.unchanged,25);
    assert.equal(again.skipped,0);
    assert.equal((await list()).total,26);
    assert.equal((await list()).counts.unfilled,26);
    const [restored] = await own(coordinator,'select * from public.trips where id=$1',[trip.id]);
    assert.equal(restored.deleted_at,null);
    assert.ok(restored.version>trip.version);
    assert.equal(restored.status,'unfilled');
    assert.equal(restored.pickup_at,null);
    assert.deepEqual(await own(coordinator,'select * from public.trips where id<>$1 order by id',[trip.id]),remainingBefore);
    assert.equal((await own(coordinator,"select * from public.trip_history where trip_id=$1 and event='deleted'",[trip.id])).length,1);
    assert.equal((await own(coordinator,"select * from public.trip_history where trip_id=$1 and event='restored'",[trip.id])).length,1);
    await assert.rejects(remove(coordinator,trip.version),/changed/i);
    const repeat=await gen();
    assert.equal(repeat.updated,0);
    assert.equal(repeat.unchanged,26);
    assert.equal((await own(coordinator,"select * from public.trip_history where trip_id=$1 and event='restored'",[trip.id])).length,1);
    await assert.rejects(list(coordinator,'x'.repeat(101)),/Invalid/i);
    await assert.rejects(list(coordinator,'','unknown'),/Invalid/i);
    await local.exec(schema);
    assert.equal((await list()).total,26);
  }finally{await local.close();}
});

test('driver personal signup is atomic, owns its profile and preserves the existing login boundary', async () => {
  const local = await databaseWithAuth();
  try {
    await local.exec(schema);
    async function act(who, sql, params = []) {
      await local.exec('begin; set local role authenticated;');
      try {
        await local.query("select set_config('request.jwt.claim.sub',$1,true)",[who]);
        const result = await local.query(sql,params);
        await local.exec('commit'); return result.rows;
      } catch (error) { await local.exec('rollback'); throw error; }
    }
    const personal = { full_name: 'Fixture Driver', phone: '+65 81234567', birth_date: '1990-04-12', gender: 'prefer-not-to-say' };
    const register = details => act(driver,"select public.register_driver_account('Driver',$1::jsonb) as account",[JSON.stringify(details)]);
    await assert.rejects(act(driver,"select public.register_account('driver','Driver')"), /details.*required/i);
    for (const details of [{}, {...personal,birth_date:'2999-01-01'}, {...personal,birth_date:'2020-02-30'}, {...personal,gender:null}, {...personal,status:'approved'}]) {
      await assert.rejects(register(details));
      assert.equal((await local.query('select count(*)::integer as total from public.accounts')).rows[0].total,0);
    }
    const [{ account }] = await register(personal);
    assert.equal(account.profile_complete,true);
    assert.equal(account.status,'active');
    assert.equal(account.full_name,personal.full_name);
    assert.equal((await act(driver,'select * from public.drivers')).length,1);
    assert.deepEqual(await act(patient,'select * from public.drivers'),[]);
    await assert.rejects(act(driver,"update public.drivers set full_name='Other'"),/permission denied/);
    await assert.rejects(act(driver,'select public.save_my_driver($1::jsonb)',[JSON.stringify(personal)]),/already exists/);
    const update=(who,details,version)=>act(who,'select public.update_my_driver($1::jsonb,$2) as driver',[JSON.stringify(details),version]);
    const [{driver:edited}]=await update(driver,{...personal,full_name:'Updated Driver'},1);
    assert.equal(edited.full_name,'Updated Driver');assert.equal(edited.version,2);
    await assert.rejects(update(driver,personal,1),/changed/);
    await assert.rejects(update(patient,personal,2),/Driver access/);
    await assert.rejects(update(driver,{...personal,status:'active'},2),/Invalid/);
    await assert.rejects(update(driver,{...personal,birth_date:'2999-01-01'},2),/Invalid/);
    assert.equal((await act(driver,'select * from public.drivers'))[0].version,2);

    await local.exec(schema);
    assert.equal((await act(driver,'select public.current_account() as account'))[0].account.profile_complete,true);
    await local.query("update public.accounts set status='inactive' where id=$1",[account.id]);
    assert.deepEqual(await act(driver,'select * from public.drivers'),[]);
    await assert.rejects(act(driver,'select public.save_my_driver($1::jsonb)',[JSON.stringify(personal)]),/Driver access/);

    // Caregiver code possession alone grants no access: the patient must confirm.
    await local.query("insert into auth.identities(user_id,provider) values($1,'google')",[emailOnly]);
    await assert.rejects(act(emailOnly,"select public.register_account('caregiver','Caregiver')"),/details.*required/i);
    const caregiver=(await act(emailOnly,"select public.register_caregiver_account('Caregiver',$1::jsonb) as account",[JSON.stringify({...personal,full_name:'Fixture Caregiver'})]))[0].account;
    assert.equal(caregiver.profile_complete,true);assert.equal(caregiver.full_name,'Fixture Caregiver');
    await local.query("insert into public.accounts(auth_user_id,email,display_name,role) values($1,'patient@example.test','Patient','patient'),($2,'coordinator@example.test','Coordinator','coordinator')",[patient,coordinator]);
    const person=(await local.query("insert into public.patients(account_id,full_name,phone,pickup_address,mobility) select id,'Fixture Patient','81234567','Fixture home','ambulant' from public.accounts where role='patient' returning id")).rows[0].id;
    const invitation=(await act(emailOnly,'select public.create_caregiver_invitation() as data'))[0].data;
    assert.ok(invitation.code);
    const storedHash=(await local.query('select code_hash from private.caregiver_invitations')).rows[0].code_hash;
    assert.notEqual(storedHash,invitation.code);assert.equal(storedHash,(await local.query('select md5($1) as hash',[invitation.code])).rows[0].hash);
    const preview=(await act(patient,'select public.review_caregiver_invitation($1,null) as data',[invitation.code]))[0].data;
    assert.equal(preview.caregiver_id,caregiver.id);assert.equal(preview.full_name,'Fixture Caregiver');
    assert.equal((await act(emailOnly,'select private.caregiver_can_access_patient($1) as allowed',[person]))[0].allowed,false);
    await assert.rejects(act(emailOnly,'select public.review_caregiver_invitation($1,null)',[invitation.code]),/Patient access/);
    let link=(await act(patient,'select public.review_caregiver_invitation($1,$2) as data',[invitation.code,caregiver.id]))[0].data.link;
    assert.equal(link.active,true);assert.equal((await act(emailOnly,'select private.caregiver_can_access_patient($1) as allowed',[person]))[0].allowed,true);
    const notices=async who=>(await act(who,'select public.list_trip_notifications(1) as data'))[0].data;
    for(const who of [patient,emailOnly])assert.equal((await notices(who)).notifications.filter(row=>row.event==='caregiver_authorised').length,1);
    assert.equal((await act(patient,'select public.review_caregiver_invitation($1,$2) as data',[invitation.code,caregiver.id]))[0].data.error,'invalid_invitation');
    assert.equal((await act(emailOnly,'select public.list_caregiver_links(null) as data'))[0].data.links.length,1);
    assert.equal((await act(coordinator,"select public.list_coordinator_caregivers(1,'Fixture','active','full_name','asc') as data"))[0].data.caregivers[0].id,caregiver.id);
    assert.equal((await act(coordinator,'select public.coordinator_caregiver_links($1) as data',[caregiver.id]))[0].data.links[0].patient_name,'Fixture Patient');
    for(const who of [patient,emailOnly,driver]){
      await assert.rejects(act(who,"select public.list_coordinator_caregivers(1,'','all','created_at','desc')"),/Coordinator/i);
      await assert.rejects(act(who,'select public.coordinator_caregiver_links($1)',[caregiver.id]),/Coordinator/i);
      await assert.rejects(act(who,"select public.set_caregiver_status($1,'inactive',1)",[caregiver.id]),/Coordinator/i);
    }
    await assert.rejects(act(driver,'select public.list_caregiver_links(null)'),/denied/);
    // Linked caregivers share transport workflows, never patient profile ownership.
    assert.deepEqual(await act(emailOnly,'select * from public.patients'),[]);
    await assert.rejects(act(emailOnly,"update public.patients set full_name='Changed' where id=$1",[person]),/permission denied|row.level/i);
    const setup=(await local.query("select id as centre,((now() at time zone 'Asia/Singapore')::date+1)::text as day from public.dialysis_centres limit 1")).rows[0];
    const create="insert into public.treatment_schedules(patient_id,centre_id,kind,days,start_time,end_time,effective_from,effective_to) values($1,$2,'single',array[extract(isodow from $3::date)::integer],'10:00','11:00',$3,$3) returning *";
    const source=(await act(emailOnly,create,[person,setup.centre,setup.day]))[0];
    assert.ok((await notices(patient)).notifications.some(row=>row.event==='schedule_created'&&row.message==='Caregiver created a treatment schedule'));
    assert.ok(!(await notices(emailOnly)).notifications.some(row=>row.event==='schedule_created'),'Do not notify the acting caregiver.');
    await act(patient,create.replace("'10:00','11:00'","'13:00','14:00'"),[person,setup.centre,setup.day]);
    assert.ok((await notices(emailOnly)).notifications.some(row=>row.event==='schedule_created'&&row.message==='Patient created a treatment schedule'));
    assert.equal((await act(emailOnly,'select public.list_treatments() as data'))[0].data.schedules[0].patients.full_name,'Fixture Patient');
    await local.query("insert into public.accounts(auth_user_id,email,display_name,role) values($1,'unlinked@example.test','Unlinked','patient')",[stranger]);
    const unlinkedPerson=(await local.query("insert into public.patients(account_id,full_name,phone,pickup_address,mobility) select id,'Unlinked Patient','80000009','Fixture other home','ambulant' from public.accounts where auth_user_id=$1 returning id",[stranger])).rows[0].id;
    await assert.rejects(act(emailOnly,create,[unlinkedPerson,setup.centre,setup.day]),/denied|row.level/i);
    const otherSource=(await act(stranger,create,[unlinkedPerson,setup.centre,setup.day]))[0];
    const change=(await act(emailOnly,"select public.request_treatment_change($1,'delete','{}'::jsonb,null,'Fixture change',$2) as data",[source.id,source.version]))[0].data;
    assert.equal(change.requested_by,caregiver.id);
    await act(emailOnly,'select public.withdraw_treatment_change($1,$2)',[change.id,change.version]);
    for(const event of ['schedule_change_pending','schedule_change_withdrawn'])assert.ok((await notices(patient)).notifications.some(row=>row.event===event));
    await assert.rejects(act(emailOnly,"select public.request_treatment_change($1,'delete','{}'::jsonb,null,'Other patient',$2)",[otherSource.id,otherSource.version]),/denied/i);
    for(const selected of [source,otherSource])await act(coordinator,'select public.generate_treatment_trips($1,$2,$2,$3)',[selected.id,setup.day,selected.version]);
    assert.equal((await act(emailOnly,'select public.list_trips(1,$1,null) as data',[setup.day]))[0].data.total,2);
    let journey=(await act(emailOnly,"select * from public.trips where source_schedule_id=$1 and direction='outbound'",[source.id]))[0];
    await local.query("update public.accounts set status='active' where id=$1",[account.id]);
    await local.query("insert into public.driver_vehicles(driver_id,licence_number,plate_number,make,model,passenger_capacity,wheelchair_accessible,status,reviewed_at,reviewed_by) values($1,'CG-FIXTURE','CGLINK1','Fixture','Car',3,false,'approved',now(),(select id from public.accounts where role='coordinator'))",[account.id]);
    await local.query('insert into public.driver_availability(driver_id,weekly_slots) values($1,array(select generate_series(0,335)))',[account.id]);
    await local.query('select public.cache_driving_route($1,$2,$3::jsonb)',[journey.origin,journey.destination,JSON.stringify(fixtureRoadRoute)]);
    journey=(await act(coordinator,'select public.prepare_trip_route($1,$2) as data',[journey.id,journey.version]))[0].data;
    journey=(await act(coordinator,"select public.assign_trip($1,$2,$3::timestamptz-interval '30 minutes',$4) as data",[journey.id,account.id,journey.arrival_by,journey.version]))[0].data;
    journey=(await act(emailOnly,'select public.confirm_trip($1,$2) as data',[journey.id,journey.version]))[0].data;
    assert.equal(journey.confirmed_by,caregiver.id);
    assert.equal((await act(emailOnly,'select public.trip_progress($1) as data',[journey.id]))[0].data.trip.id,journey.id);
    assert.ok((await act(emailOnly,'select public.list_trip_notifications(1) as data'))[0].data.notifications.some(row=>row.event==='assigned'));
    assert.ok(!(await act(emailOnly,'select public.list_trip_notifications(1) as data'))[0].data.notifications.some(row=>row.event==='confirmed'));
    journey=(await act(emailOnly,'select public.cancel_trip($1,$2) as data',[journey.id,journey.version]))[0].data;
    assert.equal(journey.cancelled_by,caregiver.id);assert.equal(journey.lifecycle,'cancelled');
    await assert.rejects(act(emailOnly,'select public.trip_feedback($1)',[journey.id]),/Patient feedback access denied/i);
    assert.ok((await notices(patient)).notifications.some(row=>row.event==='cancelled'&&row.message.startsWith('Caregiver cancelled trip')));
    assert.ok(!(await notices(emailOnly)).notifications.some(row=>row.event==='cancelled'),'Do not notify the acting caregiver.');
    link=(await act(emailOnly,'select public.manage_caregiver_link($1,$2,false,$3,false) as data',[person,caregiver.id,link.version]))[0].data;
    assert.equal(link.active,false);assert.equal((await act(emailOnly,'select private.caregiver_can_access_patient($1) as allowed',[person]))[0].allowed,false);
    assert.deepEqual(await act(emailOnly,'select * from public.treatment_schedules'),[]);
    assert.deepEqual(await act(emailOnly,'select * from public.trips'),[]);
    assert.ok((await notices(emailOnly)).notifications.every(row=>row.notice_kind==='link'),'Only safe relationship notices remain after unlinking.');
    assert.ok((await notices(patient)).notifications.some(row=>row.event==='caregiver_revoked'));
    await act(patient,'select public.read_all_trip_notifications()');
    assert.equal((await notices(patient)).unread,0);
    assert.ok((await act(patient,'select public.delete_read_trip_notifications() as data'))[0].data.deleted>0);
    await assert.rejects(act(emailOnly,'select public.trip_progress($1)',[journey.id]),/denied/i);
    await assert.rejects(act(emailOnly,'select public.trip_history_page($1,1)',[journey.id]),/denied/i);
    await assert.rejects(act(emailOnly,create,[person,setup.centre,setup.day]),/denied|row.level/i);
    await assert.rejects(act(coordinator,'select public.manage_caregiver_link($1,$2,true,$3,false)',[person,caregiver.id,link.version]),/denied/);
    link=(await act(coordinator,'select public.manage_caregiver_link($1,$2,true,$3,true) as data',[person,caregiver.id,link.version]))[0].data;
    assert.equal(link.active,true);
    await assert.rejects(act(emailOnly,'select public.manage_caregiver_link($1,$2,false,$3,false)',[person,caregiver.id,link.version-1]),/changed/);
    const statusVersion=(await local.query('select status_version from public.accounts where id=$1',[caregiver.id])).rows[0].status_version;
    await assert.rejects(act(coordinator,"select public.set_caregiver_status($1,'inactive',$2)",[caregiver.id,statusVersion+1]),/changed/i);
    const changedStatus=(await act(coordinator,"select public.set_caregiver_status($1,'inactive',$2) as data",[caregiver.id,statusVersion]))[0].data;
    assert.equal(changedStatus.status,'inactive');assert.equal(changedStatus.status_version,statusVersion+1);
    assert.equal((await act(coordinator,"select public.list_coordinator_caregivers(1,'','inactive','created_at','desc') as data"))[0].data.total,1);
    assert.equal((await local.query('select full_name from public.caregivers where account_id=$1',[caregiver.id])).rows[0].full_name,'Fixture Caregiver');
    assert.equal((await act(emailOnly,'select private.caregiver_can_access_patient($1) as allowed',[person]))[0].allowed,false);
    // Invalid responses commit the rate limit rather than rolling it back.
    for(let i=0;i<10;i++)await act(patient,"select public.review_caregiver_invitation('00000000-0000-4000-8000-000000000000',null)");
    assert.equal((await act(patient,'select public.review_caregiver_invitation($1,null) as data',[invitation.code]))[0].data.error,'invitation_rate_limited');
    assert.equal((await local.query('select count(*)::int as total from private.caregiver_link_events')).rows[0].total,3);
    const noticeCount=(await local.query('select count(*)::int as total from public.trip_notifications')).rows[0].total;
    await local.exec(schema);
    assert.equal((await local.query('select count(*)::int as total from public.trip_notifications')).rows[0].total,noticeCount,'Reapplying the schema must not replay link or schedule notices.');
    assert.equal((await local.query('select version from public.caregiver_links where id=$1',[link.id])).rows[0].version,link.version);
    await act(coordinator,"select public.set_caregiver_status($1,'active',$2)",[caregiver.id,changedStatus.status_version]);
    const makePerson=async(role,index)=>{
      const owner=(await local.query('insert into public.accounts(email,display_name,role) values($1,$2,$3) returning id',[`capacity.${role}.${index}@example.test`,`Fixture ${role} ${index}`,role])).rows[0].id;
      if(role==='caregiver'){await local.query("insert into public.caregivers(account_id,full_name,phone,birth_date,gender) values($1,$2,'80000001','1990-01-01','female')",[owner,`Fixture caregiver ${index}`]);return owner;}
      return (await local.query("insert into public.patients(account_id,full_name,phone,pickup_address,mobility) values($1,$2,'80000002','Fixture home','ambulant') returning id",[owner,`Fixture patient ${index}`])).rows[0].id;
    };
    const extraCaregivers=[];
    for(let index=0;index<5;index++)extraCaregivers.push(await makePerson('caregiver',index));
    const extraLinks=[];
    for(const extra of extraCaregivers.slice(0,4))extraLinks.push((await act(coordinator,'select public.manage_caregiver_link($1,$2,true,null,true) as data',[person,extra]))[0].data);
    await assert.rejects(act(coordinator,'select public.manage_caregiver_link($1,$2,true,null,true)',[person,extraCaregivers[4]]),error=>error.code==='P5001');
    assert.equal((await act(coordinator,'select public.manage_caregiver_link($1,$2,true,$3,true) as data',[person,caregiver.id,link.version]))[0].data.id,link.id,'An existing pair remains idempotent at capacity.');
    const removed=(await act(coordinator,'select public.manage_caregiver_link($1,$2,false,$3,false) as data',[person,extraCaregivers[0],extraLinks[0].version]))[0].data;
    await act(coordinator,'select public.manage_caregiver_link($1,$2,true,null,true)',[person,extraCaregivers[4]]);
    await assert.rejects(act(coordinator,'select public.manage_caregiver_link($1,$2,true,$3,true)',[person,extraCaregivers[0],removed.version]),error=>error.code==='P5001');
    const extraPatients=[];
    for(let index=0;index<4;index++){
      const patientId=await makePerson('patient',index);
      extraPatients.push((await act(coordinator,'select public.manage_caregiver_link($1,$2,true,null,true) as data',[patientId,caregiver.id]))[0].data);
    }
    const capacityCode='55555555-5555-4555-8555-555555555555';
    await local.query("insert into private.caregiver_invitations(caregiver_id,code_hash,expires_at) values($1,md5($2),now()+interval '15 minutes')",[caregiver.id,capacityCode]);
    await assert.rejects(act(stranger,'select public.review_caregiver_invitation($1,$2)',[capacityCode,caregiver.id]),error=>error.code==='P5002');
    assert.equal((await local.query('select used_at from private.caregiver_invitations where code_hash=md5($1)',[capacityCode])).rows[0].used_at,null);
    await act(coordinator,'select public.manage_caregiver_link($1,$2,false,$3,false)',[extraPatients[0].patient_id,caregiver.id,extraPatients[0].version]);
    assert.equal((await act(stranger,'select public.review_caregiver_invitation($1,$2) as data',[capacityCode,caregiver.id]))[0].data.link.active,true);
    assert.equal((await local.query('select count(*)::int as count from public.caregiver_links where patient_id=$1 and active',[person])).rows[0].count,5);
    assert.equal((await local.query('select count(*)::int as count from public.caregiver_links where caregiver_id=$1 and active',[caregiver.id])).rows[0].count,5);
  } finally { await local.close(); }
});

test('vehicle submissions and reviews enforce ownership, pending-only decisions, resubmission and concurrency versions', async () => {
  const local = await databaseWithAuth();
  try {
    await local.exec(schema);
    async function act(who, sql, params = []) {
      await local.exec('begin; set local role authenticated;');
      try {
        await local.query("select set_config('request.jwt.claim.sub',$1,true)",[who]);
        const result = await local.query(sql,params);
        await local.exec('commit'); return result.rows;
      } catch (error) { await local.exec('rollback'); throw error; }
    }
    const personal = { full_name:'Fixture Driver', phone:'81234567', birth_date:'1990-04-12', gender:'male' };
    const [{account}] = await act(driver,"select public.register_driver_account('Driver',$1::jsonb) as account",[JSON.stringify(personal)]);
    await local.query("insert into public.accounts(auth_user_id,email,display_name,role) values ($1,'coordinator@example.test','Coordinator','coordinator'),($2,'patient@example.test','Patient','patient')",[coordinator,patient]);
    const list = (who=coordinator,filter='all',search='') => act(who,'select public.list_drivers(1,$1,$2) as result',[search,filter]);
    assert.equal((await list())[0].result.drivers[0].vehicle,null);
    assert.equal((await list(coordinator,'not-submitted'))[0].result.total,1);
    const details = { licence_number:'MOCK123', plate_number:'test123', make:'Fixture', model:'Car', passenger_capacity:3, wheelchair_accessible:false };
    const submit = (who,version,body=details) => act(who,'select public.submit_driver_vehicle($1::jsonb,$2) as vehicle',[JSON.stringify(body),version]);
    const review = (who,version,decision,reason='') => act(who,'select public.review_driver_vehicle($1,$2,$3,$4) as vehicle',[account.id,version,decision,reason]);
    await assert.rejects(submit(patient,null),/Driver access/);
    await assert.rejects(list(driver),/Coordinator/);
    await assert.rejects(submit(driver,null,{...details,status:'approved'}),/Invalid/);
    await assert.rejects(submit(driver,null,{...details,passenger_capacity:0}),/Invalid/);
    let [{vehicle}] = await submit(driver,null);
    assert.equal(vehicle.status,'pending'); assert.equal(vehicle.plate_number,'TEST123');
    const previousVersion=vehicle.version;
    [{vehicle}]=await submit(driver,vehicle.version,{...details,model:'Updated while pending'});
    assert.equal(vehicle.status,'pending');assert.equal(vehicle.version,previousVersion+1);
    await assert.rejects(review(coordinator,previousVersion,'approved'),/changed/i);
    await assert.rejects(review(driver,vehicle.version,'approved'),/Coordinator/);
    await assert.rejects(review(coordinator,vehicle.version,'rejected'),/reason/i);
    await assert.rejects(review(coordinator,vehicle.version+1,'approved'),/changed/i);
    [{vehicle}] = await review(coordinator,vehicle.version,'rejected','Correct the plate');
    assert.equal(vehicle.review_reason,'Correct the plate');
    await assert.rejects(submit(driver,1),/changed/i);
    [{vehicle}] = await submit(driver,vehicle.version);
    assert.equal(vehicle.status,'pending'); assert.equal(vehicle.reviewed_by,null);
    [{vehicle}] = await review(coordinator,vehicle.version,'approved');
    assert.equal(vehicle.status,'approved');
    await assert.rejects(review(coordinator,vehicle.version,'rejected','Again'),/pending/i);
    const approvedVersion=vehicle.version;
    [{vehicle}] = await submit(driver,vehicle.version,{...details,model:'Replacement'});
    assert.equal(vehicle.status,'pending'); assert.equal(vehicle.review_reason,'');
    assert.equal(vehicle.version,approvedVersion+1);
    assert.deepEqual(await act(patient,'select * from public.driver_vehicles'),[]);
    await assert.rejects(act(driver,"update public.driver_vehicles set status='approved'"),/permission/);
    assert.equal((await list(coordinator,'pending','TEST123'))[0].result.total,1);
    assert.equal((await list(coordinator,'all','%'))[0].result.total,0);
    await local.exec(schema);
    assert.equal((await list())[0].result.drivers[0].vehicle.version,vehicle.version);
    assert.equal((await local.query('select count(*)::integer as total from private.driver_registration_events')).rows[0].total,6);
    assert.equal((await list(coordinator,'pending','81234567'))[0].result.total,1);
    await local.query("insert into public.accounts(email,display_name,role) select 'sort-driver-'||i||'@example.test','Sort Driver '||lpad(i::text,2,'0'),'driver' from generate_series(1,12) i");
    const sorted = (page,field,order) => act(coordinator,'select public.list_drivers($1,$2,$3,$4,$5) as result',[page,'','all',field,order]);
    const ascending=(await sorted(1,'full_name','asc'))[0].result;
    const secondPage=(await sorted(2,'full_name','asc'))[0].result;
    const descending=(await sorted(1,'full_name','desc'))[0].result;
    assert.equal(ascending.total,13);
    assert.equal(ascending.drivers[0].profile.full_name,'Fixture Driver');
    assert.deepEqual(secondPage.drivers.map(row=>row.display_name),['Sort Driver 10','Sort Driver 11','Sort Driver 12']);
    assert.equal(descending.drivers[0].display_name,'Sort Driver 12');
    assert.equal(ascending.drivers[0].list_position,undefined);
    await assert.rejects(sorted(1,'licence_number','asc'),/Invalid/);
    await assert.rejects(sorted(1,'full_name','sideways'),/Invalid/);
    await local.query("update public.accounts set status='inactive' where id=$1",[account.id]);
    await assert.rejects(submit(driver,vehicle.version),/Driver access/);
    await assert.rejects(review(coordinator,vehicle.version,'approved'),/Active driver/);
    const [{version:statusVersion}]= (await local.query('select status_version as version from public.accounts where id=$1',[account.id])).rows;
    const saveStatus=(who,version,value)=>act(who,'select public.save_driver_status($1,$2,$3) as driver',[account.id,version,value]);
    for(const other of [driver,patient]) await assert.rejects(saveStatus(other,statusVersion,'active'),/Coordinator/);
    await assert.rejects(saveStatus(coordinator,statusVersion,'approved'),/Invalid/);
    const [{driver:reactivated}]=await saveStatus(coordinator,statusVersion,'active');
    assert.equal(reactivated.account_status,'active');
    assert.equal(reactivated.status_version,statusVersion+1);
    await assert.rejects(saveStatus(coordinator,statusVersion,'inactive'),/changed/);
    const [{driver:deactivated}]=await saveStatus(coordinator,reactivated.status_version,'inactive');
    assert.equal(deactivated.account_status,'inactive');
    assert.deepEqual(await act(driver,'select * from public.driver_vehicles'),[]);
    const missingProfile=(await local.query("select id from public.accounts where email='sort-driver-1@example.test'")).rows[0].id;
    assert.equal((await act(coordinator,'select public.save_driver_status($1,1,$2) as driver',[missingProfile,'inactive']))[0].driver.account_status,'inactive');

  } finally { await local.close(); }
});

test('driver availability is approved-owner-only, versioned and validates weekly slots without date overrides', async () => {
  const local=await databaseWithAuth();
  try {
    await local.exec(schema);
    async function act(who,sql,params=[]) {
      await local.exec('begin; set local role authenticated');
      try {await local.query("select set_config('request.jwt.claim.sub',$1,true)",[who]);const result=await local.query(sql,params);await local.exec('commit');return result.rows;}
      catch(error){await local.exec('rollback');throw error;}
    }
    const personal={full_name:'Availability Driver',phone:'81234567',birth_date:'1990-01-01',gender:'male'};
    const [{account}]=await act(driver,"select public.register_driver_account('Driver',$1::jsonb) as account",[JSON.stringify(personal)]);
    await local.query("insert into public.accounts(auth_user_id,email,display_name,role) values ($1,'coordinator@example.test','Coordinator','coordinator')",[coordinator]);
    const get=()=>act(driver,'select public.get_my_availability() as result');
    const save=(who,version,slots=[])=>act(who,'select public.save_my_availability($1,$2) as availability',[slots,version]);
    assert.equal((await get())[0].result.eligible,false);
    await assert.rejects(save(driver,0),/approved/i);
    const [{vehicle}]=await act(driver,'select public.submit_driver_vehicle($1::jsonb,null) as vehicle',[JSON.stringify({licence_number:'MOCK',plate_number:'AVAIL123',make:'Fixture',model:'Car',passenger_capacity:3,wheelchair_accessible:false})]);
    await act(coordinator,"select public.review_driver_vehicle($1,$2,'approved','')",[account.id,vehicle.version]);
    assert.deepEqual((await get())[0].result,{eligible:true,availability:null});
    await act(driver,'select public.update_my_driver($1::jsonb,1)',[JSON.stringify({...personal,full_name:'Updated Availability Driver'})]);
    assert.equal((await local.query('select status from public.driver_vehicles where driver_id=$1',[account.id])).rows[0].status,'approved');

    const [{availability}]=await save(driver,0,[10,11,60,335]);
    assert.deepEqual(availability.weekly_slots,[10,11,60,335]);assert.equal(availability.version,1);
    const inspect=target=>act(coordinator,'select public.get_driver_availability($1) as result',[target]);
    assert.deepEqual((await inspect(account.id))[0].result.availability.weekly_slots,[10,11,60,335]);
    assert.equal((await inspect(account.id))[0].result.eligible,true);
    assert.equal((await act(coordinator,'select * from public.driver_availability')).length,1);
    for(const who of [patient,driver]) await assert.rejects(act(who,'select public.get_driver_availability($1)',[account.id]),/Coordinator/);
    await assert.rejects(inspect(patient),/Driver not found/);
    await assert.rejects(act(coordinator,'update public.driver_availability set weekly_slots=array[1]'),/permission/i);

    await assert.rejects(save(driver,0),/changed/i);
    for(const who of [patient,coordinator]) await assert.rejects(save(who,0),/Driver|approved/i);
    for(const slots of [[-1],[336],[10,10],[1,null]]) await assert.rejects(save(driver,1,slots),/Invalid/i);
    const [{availability:cleared}]=await save(driver,1,[]);assert.equal(cleared.version,2);assert.deepEqual(cleared.weekly_slots,[]);
    assert.deepEqual(await act(patient,'select * from public.driver_availability'),[]);
    await assert.rejects(act(driver,'update public.driver_availability set weekly_slots=array[1]'),/permission/i);
    await local.exec("alter table public.driver_availability add column exceptions jsonb not null default '[]';");
    await local.query('update public.driver_availability set weekly_slots=array[10],exceptions=$1::jsonb',[JSON.stringify([{date:'2027-01-02',start_slot:10,end_slot:14,available:false}])]);
    await local.exec(schema);assert.equal((await get())[0].result.availability.version,2);
    assert.equal('exceptions' in (await get())[0].result.availability,false);
    assert.deepEqual((await get())[0].result.availability.weekly_slots,[10]);
    assert.equal((await local.query("select to_regprocedure('public.save_my_availability(integer[],jsonb,integer)') as legacy")).rows[0].legacy,null);
    await act(driver,'select public.submit_driver_vehicle($1::jsonb,$2)',[JSON.stringify({licence_number:'MOCK',plate_number:'AVAIL123',make:'Fixture',model:'Updated',passenger_capacity:3,wheelchair_accessible:false}),vehicle.version+1]);
    assert.equal((await get())[0].result.eligible,false);await assert.rejects(save(driver,2),/approved/i);
    const reviewed=(await inspect(account.id))[0].result;
    assert.equal(reviewed.eligible,false);assert.deepEqual(reviewed.availability.weekly_slots,[10]);
    await local.query("update public.accounts set status='inactive' where id=$1",[account.id]);
    assert.equal((await inspect(account.id))[0].result.eligible,false);
    await local.query("update public.accounts set status='inactive' where auth_user_id=$1",[coordinator]);
    await assert.rejects(inspect(account.id),/Coordinator/);
    await local.query("update public.accounts set status='active' where auth_user_id=$1",[coordinator]);

    const originalApproval=(await local.query('select registered_at from public.driver_vehicles where driver_id=$1',[account.id])).rows[0].registered_at;
    assert.ok(originalApproval, 'Resubmitting retains the previous approval date');
    await local.query('update public.driver_vehicles set registered_at=null where driver_id=$1',[account.id]);
    await local.exec(schema);
    assert.equal(String((await local.query('select registered_at from public.driver_vehicles where driver_id=$1',[account.id])).rows[0].registered_at),String(originalApproval));

  } finally {await local.close();}
});

test('automatic trip generation is coordinator-controlled, rolling, idempotent and preserves deletions', async () => {
  const local = await databaseWithAuth();
  try {
    await local.exec(schema);
    await local.exec(`insert into public.accounts(auth_user_id,email,display_name,role) values
      ('${patient}','patient@example.test','Fixture Patient','patient'),('${coordinator}','coordinator@example.test','Coordinator','coordinator'),('${driver}','driver@example.test','Driver','driver');
      insert into public.patients(account_id,full_name,phone,pickup_address,mobility) select id,'Fixture Patient','81234567','Fixture street','ambulant' from public.accounts where role='patient';`);
    const own = async (who, sql, params = [], trustedFixture = false) => {
      await local.exec(trustedFixture ? 'begin;' : 'begin; set local role authenticated;');
      try { await local.query("select set_config('request.jwt.claim.sub',$1,true)", [who]); const result = await local.query(sql,params); await local.exec('commit'); return result.rows; }
      catch (error) { await local.exec('rollback'); throw error; }
    };
    const dates = (await local.query(`select ((now() at time zone 'Asia/Singapore')::date+1)::text as first,
      ((now() at time zone 'Asia/Singapore')::date+36)::text as last,
      extract(isodow from (now() at time zone 'Asia/Singapore')::date+1)::integer as day`)).rows[0];
    const ids = (await own(patient,'select p.id as patient,c.id as centre from public.patients p cross join public.dialysis_centres c limit 1'))[0];
    const [source] = await own(patient,`insert into public.treatment_schedules(patient_id,centre_id,days,start_time,end_time,effective_from,effective_to)
      values($1,$2,array[$3::integer],'09:00','13:00',$4,$5) returning *`,[ids.patient,ids.centre,dates.day,dates.first,dates.last]);
    const setting = async (who, enabled, version) => (await own(who,'select public.set_treatment_auto_generation($1,$2,$3,$4) as result',[source.id,enabled,source.version,version]))[0].result;
    const listed = async () => (await own(coordinator,'select public.list_treatments() as result'))[0].result.schedules.find(row => row.id === source.id);
    assert.deepEqual((await listed()).auto_generation,{enabled:false,version:0,last_run_at:null,last_error:null});
    await local.query('select private.run_automatic_trip_generation()');
    assert.equal((await local.query('select count(*)::integer as n from public.trips')).rows[0].n,0);
    for (const who of [patient,driver]) await assert.rejects(setting(who,true,0),/Coordinator|denied/i);
    await assert.rejects(own(patient,'insert into public.treatment_trip_generation(schedule_id,enabled,enabled_by) select $1,true,id from public.accounts where role=\'coordinator\'',[source.id]),/permission/i);
    await assert.rejects(own(coordinator,'select private.run_automatic_trip_generation()'),/permission/i);
    await assert.rejects(own(coordinator,'select private.generate_treatment_trips_internal($1,$2,$3,1,null,true)',[source.id,dates.first,dates.last]),/permission/i);
    const on = await setting(coordinator,true,0);
    assert.equal(on.enabled,true); assert.equal(on.version,1); assert.ok(on.last_run_at);
    const count = async () => (await local.query('select count(*)::integer as n from public.trips where deleted_at is null')).rows[0].n;
    const expected=(await local.query(`select count(*)::integer*2 as n from generate_series($1::date::timestamp,private.planning_window_end()::timestamp,interval '7 days') d`,[dates.first])).rows[0].n;
    assert.equal(await count(),expected,'Only sessions through the fourth Sunday are generated.');
    await assert.rejects(own(coordinator,'select public.generate_treatment_trips($1,$2,$3,1)',[source.id,dates.first,dates.last]),/fourth Sunday/);
    assert.equal((await local.query(`select count(*)::integer as n from public.trips where session_date>private.planning_window_end()`)).rows[0].n,0);
    assert.equal((await listed()).version,source.version,'Preference changes must not stale the treatment snapshot.');
    await assert.rejects(setting(coordinator,false,0),/changed/i);
    await local.query('select private.run_automatic_trip_generation()');
    assert.equal(await count(),expected);
    assert.equal((await local.query('select count(*)::integer as n from public.trip_history')).rows[0].n,expected);
    const trip = (await own(coordinator,'select * from public.trips order by id limit 1'))[0];
    await own(coordinator,'select public.delete_trip($1,$2)',[trip.id,trip.version]);
    await local.query('select private.run_automatic_trip_generation()');
    assert.equal(await count(),expected-1,'Automatic runs preserve deliberate deletions.');
    const disabled = await setting(coordinator,false,1);
    assert.equal(disabled.version,2); assert.equal(await count(),expected-1);
    assert.equal((await local.query('select private.run_automatic_trip_generation() as result')).rows[0].result.processed,0);
    await setting(coordinator,true,2);
    assert.equal(await count(),expected-1,'Enabling also preserves deleted trips.');
    await own(coordinator,'select public.generate_treatment_trips($1,$2,$2,$3)',[source.id,trip.session_date,source.version]);
    assert.equal(await count(),expected,'Explicit manual generation can restore deleted trips.');
    await local.query("update public.accounts set status='inactive' where auth_user_id=$1",[patient]);
    assert.equal((await local.query('select private.run_automatic_trip_generation() as result')).rows[0].result.processed,0);
    await local.query("update public.accounts set status='active' where auth_user_id=$1",[patient]);
    await local.exec(schema);
    assert.equal((await listed()).auto_generation.enabled,true,'Schema reapplication preserves the opted-in setting.');
    assert.equal(await count(),expected);
    // An occurrence originally outside the window but moved into it inherits the root setting.
    // Trusted fixture only; patients cannot create replacement records.
    const [replacement] = await own(patient,`insert into public.treatment_schedules(patient_id,centre_id,kind,days,start_time,end_time,effective_from,effective_to,replaces_schedule_id,replaces_date)
      select $1,$2,'single',array[extract(isodow from day)::integer],'09:00','13:00',day,day,$3,$4::date
      from (select (now() at time zone 'Asia/Singapore')::date+16 as day) d returning *`,[ids.patient,ids.centre,source.id,dates.last],true);
    const replacementView = (await own(coordinator,'select public.list_treatments() as result'))[0].result.schedules.find(row => row.id === replacement.id);
    assert.equal(replacementView.auto_generation.enabled,true);
    await assert.rejects(own(coordinator,'select public.set_treatment_auto_generation($1,false,$2,0)',[replacement.id,replacement.version]),/original recurring/i);
    await local.query('select private.run_automatic_trip_generation()');
    assert.equal((await local.query('select count(*)::integer as n from public.trips where source_schedule_id=$1',[replacement.id])).rows[0].n,2);
    assert.equal(await count(),expected+2);
    const [other] = await own(patient,`insert into public.treatment_schedules(patient_id,centre_id,kind,days,start_time,end_time,effective_from,effective_to)
      select $1,$2,'single',array[extract(isodow from day)::integer],'15:00','16:00',day,day
      from (select (now() at time zone 'Asia/Singapore')::date+2 as day) d returning *`,[ids.patient,ids.centre]);
    await own(coordinator,'select public.set_treatment_auto_generation($1,true,$2,0)',[other.id,other.version]);
    // A failed source rolls back independently; a second opted-in schedule still runs.
    await local.query('update public.trips set review_required=true where source_schedule_id=$1',[source.id]);
    await local.exec(`create function public.fixture_fail_trip_refresh() returns trigger language plpgsql as $$ begin
      if new.source_schedule_id='${source.id}'::uuid then raise exception 'fixture refresh failure'; end if; return new; end; $$;
      create trigger fixture_fail_trip_refresh before update on public.trips for each row execute function public.fixture_fail_trip_refresh();`);
    const outcome = (await local.query('select private.run_automatic_trip_generation() as result')).rows[0].result;
    assert.equal(outcome.failed,1); assert.equal(outcome.processed,1);
    assert.ok((await listed()).auto_generation.last_error);
    await local.exec('drop trigger fixture_fail_trip_refresh on public.trips; drop function public.fixture_fail_trip_refresh();');
    await local.query('select private.run_automatic_trip_generation()');
    assert.equal((await listed()).auto_generation.last_error,null);
    await local.query("update public.patients set status='inactive' where id=$1",[ids.patient]);
    assert.equal((await local.query('select private.run_automatic_trip_generation() as result')).rows[0].result.processed,0);
    await local.query("update public.patients set status='active' where id=$1",[ids.patient]);
    const latestSource = (await own(patient,'select version from public.treatment_schedules where id=$1',[source.id]))[0];
    const beforeDelete = await count();
    await own(patient,'select public.delete_my_treatment($1,$2)',[source.id,latestSource.version],true);
    assert.equal((await local.query('select count(*)::integer as n from public.treatment_trip_generation where schedule_id=$1',[source.id])).rows[0].n,0);
    assert.equal(await count(),beforeDelete,'Deleting a treatment removes its setting, not its existing trips.');
  } finally { await local.close(); }
});

test('patient change requests preserve schedules until a versioned coordinator decision', async () => {
  const centre = (await db.query('select id from public.dialysis_centres order by id limit 1')).rows[0].id;
  const [source] = await asUser(patient,`insert into public.treatment_schedules(patient_id,centre_id,kind,days,start_time,end_time,effective_from,effective_to)
    select p.id,$1,'single',array[extract(isodow from day)::integer],'09:00','10:00',day,day
    from public.patients p cross join (select (now() at time zone 'Asia/Singapore')::date+7 as day) d where p.account_id=(select id from public.accounts where auth_user_id=$2) returning *`,[centre,patient]);
  const proposal = { kind: 'single', centre_id: centre, days: source.days, start_time: '12:00', end_time: '13:00', effective_from: source.effective_from, effective_to: source.effective_to };
  const request = async (who = patient) => (await asUser(who,'select public.request_treatment_change($1,$2,$3::jsonb,null,$4,$5) as request',[source.id,'update',JSON.stringify(proposal),'Appointment changed',source.version]))[0].request;
  const review = async (id,decision,version=1,note='') => (await asUser(coordinator,'select public.review_treatment_change($1,$2,$3,$4) as request',[id,decision,note,version]))[0].request;
  for (const who of [coordinator,driver,stranger]) await assert.rejects(request(who),/denied/i);
  const pending = await request();
  assert.equal(pending.status,'pending');
  assert.equal((await db.query('select start_time from public.treatment_schedules where id=$1',[source.id])).rows[0].start_time,'09:00:00');
  await assert.rejects(request(),/already pending/i);
  await assert.rejects(asUser(patient,"update public.treatment_change_requests set status='approved' where id=$1",[pending.id]),/permission/i);
  await assert.rejects(asUser(patient,"select public.review_treatment_change($1,'approved','',1)",[pending.id]),/Coordinator/i);
  await assert.rejects(review(pending.id,'rejected'),/reason/i);
  assert.equal((await review(pending.id,'rejected',1,'Please confirm with the centre')).status,'rejected');
  assert.equal((await db.query('select version from public.treatment_schedules where id=$1',[source.id])).rows[0].version,1);
  const withdrawal = await request();
  assert.equal((await asUser(patient,'select public.withdraw_treatment_change($1,1) as request',[withdrawal.id]))[0].request.status,'withdrawn');
  const accepted = await request();
  await assert.rejects(review(accepted.id,'approved',2),/changed/i);
  assert.equal((await review(accepted.id,'approved')).status,'approved');
  const changed = (await db.query('select * from public.treatment_schedules where id=$1',[source.id])).rows[0];
  assert.equal(changed.start_time,'12:00:00'); assert.equal(changed.version,2);
  await assert.rejects(review(accepted.id,'approved'),/changed/i);
  assert.equal((await asUser(driver,'select * from public.treatment_change_requests')).length,0);
  const visible = (await asUser(patient,'select public.list_treatments() as result'))[0].result.schedules.find(row=>row.id===source.id);
  assert.equal(visible.change_request.status,'approved');
  assert.equal((await db.query('select count(*)::integer as count from public.trips where root_schedule_id=$1',[source.id])).rows[0].count,0,'Approval without generated trips must not manufacture trips.');
});

test('approved rescheduling and deletion reconcile future trips atomically and preserve historical snapshots', async () => {
  const centre = (await db.query('select id from public.dialysis_centres order by id limit 1')).rows[0].id;
  const dates = (await db.query(`select ((now() at time zone 'Asia/Singapore')::date+1)::text as first,
    ((now() at time zone 'Asia/Singapore')::date+8)::text as original,((now() at time zone 'Asia/Singapore')::date+9)::text as moved,
    ((now() at time zone 'Asia/Singapore')::date+15)::text as last`)).rows[0];
  const [source] = await asUser(patient,`insert into public.treatment_schedules(patient_id,centre_id,days,start_time,end_time,effective_from,effective_to)
    select id,$1,array[extract(isodow from $2::date)::integer],'09:00','10:00',$2,$3 from public.patients where account_id=(select id from public.accounts where auth_user_id=$4) returning *`,[centre,dates.first,dates.last,patient]);
  await asUser(coordinator,'select public.generate_treatment_trips($1,$2,$3,1)',[source.id,dates.first,dates.last]);
  const [first] = await asUser(coordinator,"select * from public.trips where root_schedule_id=$1 and session_date=$2 and direction='outbound'",[source.id,dates.first]);
  await asUser(coordinator,'select public.delete_trip($1,$2)',[first.id,first.version]);
  // A historical snapshot can outlive changes to the current treatment definition.
  const historical = (await db.query(`insert into public.trips(patient_id,patient_name,source_schedule_id,root_schedule_id,occurrence_key,original_session_date,session_date,direction,origin,destination,treatment_start,treatment_end,arrival_by,source_version,patient_version,created_by)
    select patient_id,patient_name,source_schedule_id,root_schedule_id,'historical-fixture',(now() at time zone 'Asia/Singapore')::date,(now() at time zone 'Asia/Singapore')::date,'outbound',origin,destination,
      now()-interval '2 hours',now()-interval '1 hour',now()-interval '135 minutes',source_version,patient_version,created_by from public.trips where id=$1 returning *`,[first.id])).rows[0];
  const movedIds = (await db.query('select id from public.trips where root_schedule_id=$1 and session_date=$2 order by id',[source.id,dates.original])).rows.map(row=>row.id);
  const proposal = { kind:'single',centre_id:centre,days:[new Date(`${dates.moved}T00:00:00Z`).getUTCDay()||7],start_time:'11:00',end_time:'12:00',effective_from:dates.moved,effective_to:dates.moved };
  const make = async (id,operation,details,original=null) => {
    const version=(await db.query('select version from public.treatment_schedules where id=$1',[id])).rows[0].version;
    return (await asUser(patient,'select public.request_treatment_change($1,$2,$3::jsonb,$4,$5,$6) as request',[id,operation,JSON.stringify(details),original,'Treatment changed',version]))[0].request;
  };
  const approve = request => asUser(coordinator,"select public.review_treatment_change($1,'approved','',1)",[request.id]);
  await approve(await make(source.id,'reschedule',proposal,dates.original));
  const moved = (await db.query('select * from public.treatment_schedules where replaces_schedule_id=$1',[source.id])).rows[0];
  assert.equal(moved.effective_from,dates.moved);
  const journeys = (await db.query('select * from public.trips where id=any($1::uuid[]) order by id',[movedIds])).rows;
  assert.ok(journeys.every(trip=>trip.session_date===dates.moved && trip.source_schedule_id===moved.id && !trip.deleted_at));
  assert.ok((await db.query('select deleted_at from public.trips where id=$1',[first.id])).rows[0].deleted_at,'Approval must not restore a deliberately deleted journey.');
  await approve(await make(moved.id,'delete',{}));
  assert.ok((await db.query('select * from public.trips where id=any($1::uuid[])',[movedIds])).rows.every(trip=>trip.session_date===dates.original && trip.source_schedule_id===source.id));
  const recurring = {kind:'recurring',centre_id:centre,days:source.days,start_time:'09:00',end_time:'10:00',effective_from:source.effective_from,effective_to:source.effective_to};
  await approve(await make(source.id,'update',{...recurring,days:[source.days[0] % 7 + 1]}));
  assert.ok((await db.query('select * from public.trips where id=any($1::uuid[])',[movedIds])).rows.every(trip=>trip.deleted_at && trip.schedule_change_cancelled));
  await approve(await make(source.id,'update',recurring));
  assert.ok((await db.query('select * from public.trips where id=any($1::uuid[])',[movedIds])).rows.every(trip=>!trip.deleted_at && !trip.schedule_change_cancelled),'Schedule cancellations should be restored when the original weekday returns.');
  assert.ok((await db.query('select deleted_at from public.trips where id=$1',[first.id])).rows[0].deleted_at,'Deliberate deletions remain protected after changing the weekday back.');
  await asUser(patient,`insert into public.treatment_schedules(patient_id,centre_id,kind,days,start_time,end_time,effective_from,effective_to)
    values($1,$2,'single',array[extract(isodow from $3::date)::integer],'11:00','12:00',$3,$3)`,[source.patient_id,centre,dates.last]);
  const conflict = await make(source.id,'update',{kind:'recurring',centre_id:centre,days:source.days,start_time:'11:00',end_time:'12:00',effective_from:source.effective_from,effective_to:source.effective_to});
  await assert.rejects(approve(conflict),/overlap/i);
  assert.equal((await db.query('select status from public.treatment_change_requests where id=$1',[conflict.id])).rows[0].status,'pending');
  assert.equal((await db.query('select start_time from public.treatment_schedules where id=$1',[source.id])).rows[0].start_time,'09:00:00');
  await asUser(coordinator,"select public.review_treatment_change($1,'rejected','Conflicting appointment',1)",[conflict.id]);
  await approve(await make(source.id,'delete',{}));
  assert.equal((await db.query('select count(*)::integer as count from public.trips where root_schedule_id=$1 and deleted_at is null and treatment_start>now()',[source.id])).rows[0].count,0);
  assert.deepEqual((await db.query('select * from public.trips where id=$1',[historical.id])).rows[0],historical);
});

const fixtureRoadRoute={geometry:[[1.3,103.8],[1.301,103.801]],origin_coordinates:{latitude:1.3,longitude:103.8},destination_coordinates:{latitude:1.301,longitude:103.801},duration_seconds:1800,distance_metres:5000};
async function assignmentFixture() {
  const local = await databaseWithAuth();
  await local.exec(schema);
  await local.exec(`insert into public.accounts(auth_user_id,email,display_name,role) values
    ('${patient}','patient@example.test','Patient','patient'),('${coordinator}','coordinator@example.test','Coordinator','coordinator'),('${driver}','driver@example.test','Driver','driver');
    insert into public.patients(account_id,full_name,phone,pickup_address,mobility) select id,'Fixture Patient','81234567','Fixture home','ambulant' from public.accounts where role='patient';
    insert into public.drivers(account_id,full_name,phone,birth_date,gender) select id,'Fixture Driver','82345678','1990-01-01','male' from public.accounts where role='driver';
    insert into public.driver_vehicles(driver_id,licence_number,plate_number,make,model,passenger_capacity,wheelchair_accessible,status,reviewed_at,reviewed_by)
      select account_id,'MOCK','TEST123','Fixture','Car',1,false,'approved',now(),(select id from public.accounts where role='coordinator') from public.drivers;
    insert into public.driver_availability(driver_id,weekly_slots) select account_id,array(select generate_series(0,335)) from public.drivers;`);
  const own = async (who, sql, params=[]) => {
    await local.exec('begin; set local role authenticated;');
    try { await local.query("select set_config('request.jwt.claim.sub',$1,true)",[who]); const result=await local.query(sql,params); await local.exec('commit');return result.rows; }
    catch(error) {await local.exec('rollback');throw error;}
  };
  const [ids] = (await local.query(`select p.id as patient_id,d.account_id as driver_id,c.id as centre_id,
    ((now() at time zone 'Asia/Singapore')::date+1)::text as first,((now() at time zone 'Asia/Singapore')::date+8)::text as last,
    ((now() at time zone 'Asia/Singapore')::date+2)::text as moved from public.patients p cross join public.drivers d cross join public.dialysis_centres c limit 1`)).rows;
  const [source] = await own(patient,`insert into public.treatment_schedules(patient_id,centre_id,days,start_time,end_time,effective_from,effective_to)
    values($1,$2,array[extract(isodow from $3::date)::integer],'10:00','11:00',$3,$4) returning *`,[ids.patient_id,ids.centre_id,ids.first,ids.last]);
  await own(coordinator,'select public.generate_treatment_trips($1,$2,$3,1)',[source.id,ids.first,ids.last]);
  const pending=(await local.query('select * from public.trips where root_schedule_id=$1',[source.id])).rows;
  for(const trip of pending) {
    await local.query('select public.cache_driving_route($1,$2,$3::jsonb)',[trip.origin,trip.destination,JSON.stringify(fixtureRoadRoute)]);
    await own(coordinator,'select public.prepare_trip_route($1,$2)',[trip.id,trip.version]);
  }
  const trips=(await local.query('select * from public.trips where root_schedule_id=$1 order by session_date,direction',[source.id])).rows;
  const assign=async trip=>(await own(coordinator,`select public.assign_trip($1,$2,case when $3='outbound' then $4::timestamptz-interval '30 minutes' else $5::timestamptz end,$6) as trip`,[trip.id,ids.driver_id,trip.direction,trip.arrival_by,trip.pickup_not_before,trip.version]))[0].trip;
  return {local,own,ids,source,trips,assign};
}

test('assignment enforces eligibility, conflicts, ownership and fresh versions while resource changes flag retained trips', async () => {
  const {local,own,ids,source,trips,assign}=await assignmentFixture();
  try {
    const trip=trips.find(item=>item.direction==='outbound');
    const pickup=new Date(Date.parse(trip.arrival_by)-30*60000).toISOString();
    await assert.rejects(own(patient,'select public.trip_assignment_options($1,$2)',[trip.id,pickup]),/Coordinator/);
    await assert.rejects(own(driver,'select public.assign_trip($1,$2,$3,1)',[trip.id,ids.driver_id,pickup]),/Coordinator/);
    await assert.rejects(own(coordinator,'select public.assign_trip($1,$2,$3,99)',[trip.id,ids.driver_id,pickup]),/changed/i);
    await local.query("update public.driver_availability set weekly_slots='{}' where driver_id=$1",[ids.driver_id]);
    assert.equal((await own(coordinator,'select public.trip_assignment_options($1,$2) as options',[trip.id,pickup]))[0].options.drivers.length,0);
    await assert.rejects(assign(trip),/eligible/);
    await local.query('update public.driver_availability set weekly_slots=array(select generate_series(0,335)) where driver_id=$1',[ids.driver_id]);
    const assigned=await assign(trip);
    assert.equal(assigned.status,'on-track');assert.equal(assigned.assignment.driver_name,'Fixture Driver');
    assert.equal((await own(driver,'select id from public.trips')).length,1);
    const week=(await local.query(`select ($1::date-extract(isodow from $1::date)::integer+1)::text as monday`,[ids.first])).rows[0].monday;
    const dated=async()=>(await own(coordinator,'select public.get_driver_week($1,$2) as data',[ids.driver_id,week]))[0].data;
    assert.equal((await dated()).trips.length,1);assert.equal((await dated()).availability.weekly_slots.length,336);
    await assert.rejects(own(patient,'select public.get_driver_week($1,$2)',[ids.driver_id,week]),/denied/);
    const driverList=(await own(driver,"select public.list_trips(1,$1,null) as data",[ids.first]))[0].data;
    assert.equal(driverList.total,1);assert.equal(driverList.next_trip.id,assigned.id);
    await assert.rejects(own(driver,"update public.trips set status='unfilled' where id=$1",[trip.id]),/permission denied/);
    await assert.rejects(own(coordinator,'select public.delete_trip($1,$2)',[trip.id,assigned.version]),/unassigned/);
    await local.query(`insert into public.trips(patient_id,patient_name,source_schedule_id,root_schedule_id,occurrence_key,original_session_date,session_date,direction,origin,destination,treatment_start,treatment_end,arrival_by,pickup_not_before,source_version,patient_version,created_by)
      select patient_id,patient_name,source_schedule_id,root_schedule_id,'conflict-fixture',original_session_date,session_date,direction,origin,destination,treatment_start,treatment_end,arrival_by,pickup_not_before,source_version,patient_version,created_by from public.trips where id=$1`,[trip.id]);
    const conflict=(await local.query("select * from public.trips where occurrence_key='conflict-fixture'")).rows[0];
    await assert.rejects(assign(conflict),/eligible/);
    await local.query("update public.patients set mobility='wheelchair',assistance_required=true,phone='83456789' where id=$1",[ids.patient_id]);
    await own(coordinator,'select public.generate_treatment_trips($1,$2,$3,1)',[source.id,ids.first,ids.last]);
    const retained=(await local.query('select * from public.trips where id=$1',[trip.id])).rows[0];
    assert.equal(retained.assigned_driver_id,ids.driver_id);assert.equal(retained.status,'at-risk');assert.equal(retained.assignment.patient_phone,'83456789');
    await local.query("update public.driver_vehicles set passenger_capacity=2,wheelchair_accessible=true,plate_number='NEW123',model='Updated car' where driver_id=$1",[ids.driver_id]);
    const updated=(await local.query('select * from public.trips where id=$1',[trip.id])).rows[0];assert.equal(updated.status,'on-track');assert.equal(updated.assignment.plate,'NEW123');assert.equal(updated.assignment.model,'Updated car');
    await assert.rejects(own(coordinator,'select public.unassign_trip($1,$2)',[trip.id,assigned.version]),/changed/);
    await own(coordinator,'select public.unassign_trip($1,$2)',[trip.id,updated.version]);
    assert.equal((await own(driver,'select id from public.trips')).length,0);
    assert.equal((await own(driver,'select public.list_trips(1,$1,null) as data',[ids.first]))[0].data.next_trip,null);
    assert.equal((await dated()).trips.length,0);assert.equal((await dated()).availability.weekly_slots.length,336);
    await local.exec(schema);
    assert.equal((await local.query('select status from public.trips where id=$1',[trip.id])).rows[0].status,'unfilled');
  } finally {await local.close();}
});

test('schedule approval requires fresh assignment acknowledgement and releases only changed journeys', async () => {
  const {local,own,ids,source,trips,assign}=await assignmentFixture();
  try {
    const originals=trips.filter(item=>item.session_date===ids.first);
    for(const trip of originals) await assign(trip);
    const unaffected=await assign(trips.find(item=>item.session_date===ids.last && item.direction==='outbound'));
    const proposal={kind:'single',centre_id:ids.centre_id,days:[new Date(`${ids.moved}T00:00:00Z`).getUTCDay()||7],start_time:'10:00',end_time:'11:00',effective_from:ids.moved,effective_to:ids.moved};
    const request=(await own(patient,"select public.request_treatment_change($1,'reschedule',$2::jsonb,$3,'Session moved',1) as request",[source.id,JSON.stringify(proposal),ids.first]))[0].request;
    await assert.rejects(own(patient,'select public.treatment_assignment_impact($1)',[request.id]),/Coordinator/);
    const impact=(await own(coordinator,'select public.treatment_assignment_impact($1) as impact',[request.id]))[0].impact;
    assert.equal(impact.trips.length,2);
    await assert.rejects(own(coordinator,"select public.review_treatment_change($1,'approved','',1)",[request.id]),/assignments changed/i);
    await local.query('update public.trips set updated_at=now() where id=$1',[originals[0].id]);
    await assert.rejects(own(coordinator,"select public.review_treatment_change($1,'approved','',1,$2)",[request.id,impact.token]),/assignments changed/i);
    const fresh=(await own(coordinator,'select public.treatment_assignment_impact($1) as impact',[request.id]))[0].impact;
    await own(coordinator,"select public.review_treatment_change($1,'approved','',1,$2)",[request.id,fresh.token]);
    const changed=(await local.query('select * from public.trips where id=any($1::uuid[])',[originals.map(item=>item.id)])).rows;
    assert.ok(changed.every(item=>item.assigned_driver_id===null && item.pickup_at===null && item.status==='unfilled' && item.session_date===ids.moved));
    assert.equal((await local.query('select assigned_driver_id from public.trips where id=$1',[unaffected.id])).rows[0].assigned_driver_id,ids.driver_id);
    assert.equal((await own(driver,'select id from public.trips')).length,1);
    assert.equal((await local.query("select count(*)::integer as count from public.trip_history where event='unassigned'")).rows[0].count,2);
  } finally {await local.close();}
});

test('driver week edits are owned, isolated, versioned and protect assigned windows until unassignment', async () => {
  const {local,own,ids,trips,assign}=await assignmentFixture();
  try {
    const monday=(await local.query(`select ($1::date-extract(isodow from $1::date)::integer+1)::text as day`,[ids.first])).rows[0].day;
    const weeks=(await local.query(`select ($1::date+7)::text as next,($1::date+14)::text as later,($1::date-28)::text as past`,[monday])).rows[0];
    const get=async week=>(await own(driver,'select public.get_driver_week($1,$2) as data',[ids.driver_id,week]))[0].data;
    const save=async(week,slots,version,template=1)=>(await own(driver,'select public.save_my_week_availability($1,$2, $3,$4) as data',[week,slots,version,template]))[0].data;
    const original=await get(monday);assert.equal(original.availability.version,0);assert.equal(original.availability.weekly_slots.length,336);
    await assert.rejects(own(patient,'select public.get_driver_week($1,$2)',[ids.driver_id,monday]),/denied/);
    await assert.rejects(own(driver,'select public.get_driver_week($1,$2)',[ids.patient_id,monday]),/denied/);
    await assert.rejects(own(patient,'select public.save_my_week_availability($1,$2,0,1)',[monday,[]]),/Driver/);
    await assert.rejects(own(driver,'insert into public.driver_week_availability(driver_id,week_start,weekly_slots) values($1,$2,$3)',[ids.driver_id,monday,[]]),/permission/);
    const booked=await assign(trips.find(trip=>trip.session_date===ids.first&&trip.direction==='outbound'));
    await assert.rejects(save(monday,[],0),/Assigned trip times/);
    await assert.rejects(own(driver,'select public.save_my_availability($1,1)',[[]]),/Assigned trip times/);
    assert.equal((await get(monday)).availability.version,0);
    const initial=await save(monday,original.availability.weekly_slots,0);assert.equal(initial.version,1);
    await assert.rejects(save(monday,[],1),/Assigned trip times/);
    await own(coordinator,'select public.unassign_trip($1,$2)',[booked.id,booked.version]);
    await save(monday,[],1);
    assert.deepEqual((await get(monday)).availability.weekly_slots,[]);
    assert.equal((await get(weeks.next)).availability.weekly_slots.length,336);
    assert.equal((await get(weeks.later)).availability.version,0);
    await assert.rejects(save(weeks.later,[],0,999),/changed/);
    await save(weeks.next,[18,19],0);
    assert.deepEqual((await get(weeks.next)).availability.weekly_slots,[18,19]);
    assert.deepEqual((await get(monday)).availability.weekly_slots,[]);
    await assert.rejects(save(monday,[],1),/changed/);
    await assert.rejects(save(weeks.past,[],0),/week/i);
    const pickup=booked.pickup_at;
    assert.equal((await own(coordinator,'select public.trip_assignment_options($1,$2) as data',[booked.id,pickup]))[0].data.drivers.length,0);
    await local.exec(schema);
    assert.equal((await get(monday)).availability.version,2);
    assert.deepEqual((await get(weeks.next)).availability.weekly_slots,[18,19]);
  } finally {await local.close();}
});

test('patient pickup actions are owned, versioned and preserve cancellation through regeneration', async () => {
  const {local,own,ids,source,trips,assign}=await assignmentFixture();
  try {
    let trip=await assign(trips.find(row=>row.direction==='outbound'));
    for (const who of [driver,coordinator,stranger]) {
      await assert.rejects(own(who,'select public.confirm_trip($1,$2)',[trip.id,trip.version]),/Patient access|Trip access/);
      await assert.rejects(own(who,'select public.cancel_trip($1,$2)',[trip.id,trip.version]),/Patient access|Trip access/);
    }
    await local.exec(`insert into public.accounts(auth_user_id,email,display_name,role) values ('${stranger}','stranger@example.test','Other Patient','patient');
      insert into public.patients(account_id,full_name,phone,pickup_address,mobility) select id,'Other Patient','83456789','Other home','ambulant' from public.accounts where auth_user_id='${stranger}';`);
    await assert.rejects(own(stranger,'select public.cancel_trip($1,$2)',[trip.id,trip.version]),/Trip access/);
    await assert.rejects(own(patient,'select public.confirm_trip($1,$2)',[trip.id,trip.version+1]),/changed/);
    const originalVersion=trip.version;
    trip=(await own(patient,'select public.confirm_trip($1,$2) as trip',[trip.id,trip.version]))[0].trip;
    assert.ok(trip.confirmed_at);assert.equal(trip.lifecycle,'scheduled');assert.equal(trip.status,'on-track');
    await assert.rejects(own(patient,'select public.cancel_trip($1,$2)',[trip.id,originalVersion]),/changed/);
    // Changing transport arrangements invalidates the old acknowledgement.
    trip=(await own(coordinator,'select public.unassign_trip($1,$2) as trip',[trip.id,trip.version]))[0].trip;
    assert.equal(trip.confirmed_at,null);
    await assert.rejects(own(patient,'select public.confirm_trip($1,$2)',[trip.id,trip.version]),/assigned upcoming/);
    trip=await assign(trip);
    trip=(await own(patient,'select public.cancel_trip($1,$2) as trip',[trip.id,trip.version]))[0].trip;
    assert.equal(trip.lifecycle,'cancelled');assert.equal(trip.status,'resolved');assert.ok(trip.cancelled_at);
    assert.equal(trip.assigned_driver_id,null);assert.equal(trip.pickup_at,null);assert.equal(trip.assignment,null);
    assert.equal(trip.cancelled_driver_id,ids.driver_id);
    assert.equal(trip.cancelled_assignment.driver_name,'Fixture Driver');
    assert.equal(trip.cancelled_assignment.plate,'TEST123');
    assert.equal(trip.cancelled_assignment.patient_phone,undefined);
    assert.equal((await own(driver,'select * from public.trips where id=$1',[trip.id])).length,1);
    assert.equal((await own(driver,"select public.list_trips(1,$1,null,'cancelled') as data",[ids.first]))[0].data.trips[0].id,trip.id);
    const progress=(await own(driver,'select public.trip_progress($1) as data',[trip.id]))[0].data;
    assert.equal(progress.trip.lifecycle,'cancelled');assert.equal(progress.location,null);assert.equal(progress.sharing,false);
    await assert.rejects(own(driver,"select public.execute_trip($1,'start',$2)",[trip.id,trip.version]),/Trip access/);
    await assert.rejects(own(driver,'select public.begin_trip_sharing($1)',[trip.id]),/active assigned|access|in-progress/i);
    await assert.rejects(own(driver,'update public.trips set cancelled_driver_id=null where id=$1',[trip.id]),/permission denied/);
    assert.equal((await own(stranger,'select * from public.trips where id=$1',[trip.id])).length,0);
    assert.equal((await own(patient,'select public.list_trips(1,$1,null) as data',[ids.first]))[0].data.trips.find(row=>row.id===trip.id).lifecycle,'cancelled');
    const cancelled=(await own(coordinator,"select public.list_trips(1,$1,null,'cancelled','','all','status','asc') as data",[ids.first]))[0].data;
    assert.equal(cancelled.total,1);assert.equal(cancelled.trips[0].id,trip.id);
    assert.equal(cancelled.counts.cancelled,1);assert.equal(cancelled.counts.resolved,0);
    const active=(await own(patient,"select public.list_trips(1,$1,null,'upcoming,in-progress') as data",[ids.first]))[0].data;
    assert.ok(active.trips.every(row=>row.lifecycle==='scheduled'||row.lifecycle==='in-progress'));
    assert.ok(!active.trips.some(row=>row.id===trip.id));
    assert.equal((await own(patient,"select public.list_trips(1,$1,null,'completed') as data",[ids.first]))[0].data.total,0);
    assert.equal((await own(coordinator,"select public.list_trips(1,$1,null,'resolved') as data",[ids.first]))[0].data.total,0);
    assert.notEqual((await own(patient,'select public.list_trips(1,$1,null) as data',[ids.first]))[0].data.next_trip?.id,trip.id);
    await assert.rejects(own(patient,'select public.confirm_trip($1,$2)',[trip.id,trip.version]),/assigned upcoming/);
    await assert.rejects(own(patient,'select public.cancel_trip($1,$2)',[trip.id,trip.version]),/upcoming/);
    await assert.rejects(own(coordinator,'select public.delete_trip($1,$2)',[trip.id,trip.version]),/unassigned/);
    await own(coordinator,'select public.generate_treatment_trips($1,$2,$3,1)',[source.id,ids.first,ids.last]);
    assert.equal((await local.query('select lifecycle from public.trips where id=$1',[trip.id])).rows[0].lifecycle,'cancelled');
    const events=(await own(patient,'select event,details from public.trip_history where trip_id=$1 order by created_at,id',[trip.id]));
    assert.ok(events.some(event=>event.event==='confirmed'));
    assert.equal(events.filter(event=>event.event==='cancelled').length,1);
    assert.equal(events.find(event=>event.event==='cancelled').details.driver_id,ids.driver_id);
    // A passed pickup is not proof of execution, but it is the cancellation cutoff.
    let past=await assign(trips.find(row=>row.direction==='return'));
    await local.query("update public.trips set pickup_at=now()-interval '1 minute',dropoff_at=now()+interval '29 minutes',pickup_not_before=now()-interval '2 minutes',treatment_start=now()-interval '1 hour',treatment_end=now()-interval '17 minutes' where id=$1",[past.id]);
    past=(await local.query('select * from public.trips where id=$1',[past.id])).rows[0];
    await assert.rejects(own(patient,'select public.cancel_trip($1,$2)',[past.id,past.version]),/upcoming/);
    assert.equal(past.lifecycle,'scheduled');
    // An older cancellation has only its immutable event link; schema reapply restores access.
    await local.query('update public.trips set cancelled_driver_id=null,cancelled_assignment=null where id=$1',[trip.id]);
    await local.query("update public.trip_history set details=details-'assignment' where trip_id=$1 and event='cancelled'",[trip.id]);
    assert.equal((await own(driver,'select * from public.trips where id=$1',[trip.id])).length,0);
    await local.exec(schema);
    const recovered=(await own(driver,'select cancelled_driver_id,cancelled_assignment from public.trips where id=$1',[trip.id]))[0];
    assert.equal(recovered.cancelled_driver_id,ids.driver_id);
    assert.equal(recovered.cancelled_assignment.driver_name,'Fixture Driver');assert.equal(recovered.cancelled_assignment.plate,'TEST123');
    assert.equal((await local.query('select lifecycle from public.trips where id=$1',[trip.id])).rows[0].lifecycle,'cancelled');
  } finally {await local.close();}
});

test('trip notifications are recipient-only, durable and history respects current trip access', async () => {
  const {local,own,ids,trips,assign}=await assignmentFixture();
  try {
    let trip=await assign(trips.find(row=>row.direction==='outbound'));
    const calendarOwner=(await local.query("select id from public.accounts where auth_user_id=$1",[patient])).rows[0].id;
    await local.query("insert into public.calendar_connections(account_id,status,encrypted_tokens) values($1,'connected','encrypted-fixture')",[calendarOwner]);
    const unassigned=trips.find(row=>row.direction==='return'&&!row.assigned_driver_id);
    const dateEvent=(await own(patient,'select public.calendar_set_reminder($1,null,true) as event',[unassigned.id]))[0].event;
    assert.equal(dateEvent.enabled,true,'An unassigned trip can be manually added as an all-day event.');
    await local.query('delete from public.calendar_reminders where trip_id=$1',[unassigned.id]);
    const reminder=(await own(patient,'select public.calendar_set_reminder($1,30,true) as reminder',[trip.id]))[0].reminder;
    assert.equal(reminder.enabled,true);assert.equal(reminder.sync_status,'pending');
    const eventOnly=(await own(patient,'select public.calendar_set_reminder($1,null,true) as event',[trip.id]))[0].event;
    assert.equal(eventOnly.enabled,true);assert.equal(eventOnly.minutes,null,'An event can be created without a popup notification.');
    await assert.rejects(own(driver,'select public.calendar_set_reminder($1,30,true)',[trip.id]),/Calendar access/);
    await assert.rejects(own(coordinator,'select public.calendar_set_reminder($1,30,true)',[trip.id]),/Calendar access/);
    await assert.rejects(own(patient,'select encrypted_tokens from public.calendar_connections'),/permission denied/);
    await assert.rejects(own(patient,'select public.calendar_claim_jobs()'),/permission denied/);
    const claimCalendar=async()=>{
      await local.exec('begin');
      try{
        await local.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({role:'service_role'})]);
        const rows=(await local.query('select public.calendar_claim_jobs() as jobs')).rows[0].jobs;
        await local.exec('commit');return rows;
      }catch(error){await local.exec('rollback');throw error;}
    };
    const beforeGrant=(await local.query('select revision from public.calendar_reminders where account_id=$1',[calendarOwner])).rows[0].revision;
    await local.query('update public.calendar_connections set version=version+1 where account_id=$1',[calendarOwner]);
    const afterGrant=(await local.query('select revision from public.calendar_reminders where account_id=$1',[calendarOwner])).rows[0].revision;
    assert.ok(afterGrant>beforeGrant,'Replacing a connected grant must enqueue previously synced reminders.');
    const calendarJobs=await claimCalendar();assert.equal(calendarJobs.length,1);assert.equal(calendarJobs[0].desired,true);
    assert.equal(calendarJobs[0].origin,trip.origin);assert.equal(calendarJobs[0].patient_name,undefined,'Calendar jobs exclude patient identity and treatment details.');
    assert.equal((await claimCalendar()).length,0,'An active lease prevents duplicate work.');
    const inbox=async who=>(await own(who,'select public.list_trip_notifications(1) as inbox'))[0].inbox;
    const patientInbox=await inbox(patient);const driverInbox=await inbox(driver);
    assert.equal(patientInbox.unread,1);assert.equal(driverInbox.unread,1);
    assert.match(patientInbox.notifications[0].message,/assigned/i);
    assert.match(driverInbox.notifications[0].message,/^Trip assigned to you · /);
    const item=patientInbox.notifications[0];
    trip=(await own(patient,'select public.confirm_trip($1,$2) as trip',[trip.id,trip.version]))[0].trip;
    assert.equal((await inbox(patient)).total,1,'Patients do not receive their own acknowledgement.');
    assert.ok((await inbox(coordinator)).notifications.some(row=>row.event==='confirmed'));
    assert.ok((await inbox(driver)).notifications.some(row=>row.event==='confirmed'));
    assert.ok((await inbox(driver)).notifications.some(row=>row.message.startsWith('Patient acknowledged trip · ')));
    assert.equal((await own(driver,'select * from public.trip_notifications where id=$1',[item.id])).length,0);
    await assert.rejects(own(driver,'select public.read_trip_notification($1)',[item.id]),/Notification access/);
    await own(patient,'select public.read_trip_notification($1)',[item.id]);
    assert.equal((await inbox(patient)).unread,0);
    await own(patient,'select public.read_trip_notification($1)',[item.id]);
    await assert.rejects(own(patient,'update public.trip_notifications set read_at=null where id=$1',[item.id]),/permission denied/);
    const history=(await own(driver,'select public.trip_history_page($1,1) as history',[trip.id]))[0].history;
    assert.ok(history.events.some(event=>event.event==='assigned'&&event.actor==='coordinator'));
    await assert.rejects(own(stranger,'select public.trip_history_page($1,1)',[trip.id]),/Trip access/);
    trip=(await own(patient,'select public.cancel_trip($1,$2) as trip',[trip.id,trip.version]))[0].trip;
    await local.query("update public.calendar_reminders set lease_until=now()-interval '1 minute'");
    const cancelledJobs=await claimCalendar();assert.equal(cancelledJobs.length,1);assert.equal(cancelledJobs[0].desired,false,'Cancellation queues Calendar event removal.');
    assert.ok(cancelledJobs[0].revision>calendarJobs[0].revision);
    assert.ok((await inbox(driver)).notifications.some(item=>item.event==='cancelled'));
    assert.ok((await own(driver,'select public.trip_history_page($1,1) as data',[trip.id]))[0].data.events.some(event=>event.event==='cancelled'));
    assert.ok((await inbox(coordinator)).notifications.some(item=>item.event==='cancelled'));
    assert.ok(!(await inbox(patient)).notifications.some(item=>item.event==='cancelled'),'Patients do not receive their own cancellation.');
    await local.query("insert into public.trip_history(trip_id,event,details) values($1,'refreshed','{}'::jsonb)",[trip.id]);
    const driverUnread=(await inbox(driver)).unread;
    const driverTotal=(await inbox(driver)).total;
    await assert.rejects(own(stranger,'select public.delete_read_trip_notifications()'),/Notification access/);
    await assert.rejects(own(patient,'delete from public.trip_notifications'),/permission denied/);
    const cleaned=(await own(patient,'select public.delete_read_trip_notifications() as data'))[0].data;
    assert.equal(cleaned.deleted,1);assert.equal(cleaned.unread,1);assert.equal(cleaned.total,1);
    assert.equal(cleaned.notifications.length,1);assert.equal(cleaned.notifications[0].read_at,null);
    assert.equal((await inbox(driver)).total,driverTotal,'Deleting read notices must never affect another recipient.');
    assert.ok((await own(driver,'select public.trip_history_page($1,1) as history',[trip.id]))[0].history.events.some(event=>event.event==='assigned'));
    await assert.rejects(own(stranger,'select public.read_all_trip_notifications()'),/Notification access/);
    const marked=(await own(patient,'select public.read_all_trip_notifications() as data'))[0].data;
    assert.ok(marked.read_at);assert.equal(marked.unread,0);assert.equal((await inbox(patient)).unread,0);
    assert.equal((await inbox(driver)).unread,driverUnread,'Mark all must never change another recipient.');
    assert.equal((await own(patient,'select public.read_all_trip_notifications() as data'))[0].data.unread,0);
    assert.equal((await own(patient,'select public.delete_read_trip_notifications() as data'))[0].data.deleted,1);
    assert.equal((await own(patient,'select public.delete_read_trip_notifications() as data'))[0].data.deleted,0);
    const count=(await inbox(patient)).total;
    const details={previous_driver_id:ids.driver_id,driver_id:ids.driver_id,previous_pickup_at:'2026-10-27T08:00:00Z',pickup_at:'2026-10-27T08:15:00Z'};
    for(const event of ['traffic_risk_detected','recovery_approved','recovery_critical'])await local.query('insert into public.trip_history(trip_id,event,details) values($1,$2,$3::jsonb)',[trip.id,event,JSON.stringify(details)]);
    const patientNotices=(await inbox(patient)).notifications;
    assert.ok(patientNotices.some(row=>row.message.startsWith('Your trip may be delayed · ')));
    assert.ok(patientNotices.some(row=>row.message.startsWith('Your pickup time has changed · ')));
    assert.ok(patientNotices.some(row=>row.message.startsWith('Your trip needs attention. Your coordinator is arranging transport. · ')));
    assert.ok((await inbox(coordinator)).notifications.some(row=>row.message.startsWith('Recovery approved · ')));
    const driverNotices=(await inbox(driver)).notifications;
    assert.ok(driverNotices.some(row=>row.message.startsWith('Traffic may delay your trip · ')));
    assert.ok(driverNotices.some(row=>row.message.startsWith('Your pickup time has changed · ')));
    assert.ok(driverNotices.some(row=>row.message.startsWith('Your trip needs attention. Await coordinator instructions. · ')));
    for(const event of ['recovery_approved','handover_approved']){
      const changed={...details,previous_driver_id:stranger};
      assert.equal((await local.query('select private.driver_trip_event_label($1,$2,$3::jsonb) as label',[ids.driver_id,event,JSON.stringify(changed)])).rows[0].label,'Trip assigned to you');
      assert.equal((await local.query('select private.driver_trip_event_label($1,$2,$3::jsonb) as label',[stranger,event,JSON.stringify(changed)])).rows[0].label,'Trip reassigned to another driver');
    }
    for(const [changes,label] of [[{previous_driver_id:'old-driver'},'Your driver and pickup time have changed'],[{previous_driver_id:'old-driver',pickup_at:details.previous_pickup_at},'Your driver has changed'],[{pickup_at:details.previous_pickup_at},'Your trip details have changed']]){
      assert.equal((await local.query("select private.patient_trip_event_label('recovery_approved',$1::jsonb) as label",[JSON.stringify({...details,...changes})])).rows[0].label,label);
    }
    const retained=patientNotices.find(row=>row.event==='recovery_approved');
    await own(patient,'select public.read_trip_notification($1)',[retained.id]);
    await local.query("update public.trip_notifications set message='Recovery approved · 27 Oct 2026 · Outbound' where id=$1",[retained.id]);
    await local.query("insert into public.trip_notifications(recipient_id,trip_id,event_id,event,message) select actor_id,trip_id,id,event,'Trip acknowledged' from public.trip_history where trip_id=$1 and event='confirmed' limit 1",[trip.id]);
    const driverRetained=driverNotices.find(row=>row.event==='recovery_approved');
    await own(driver,'select public.read_trip_notification($1)',[driverRetained.id]);
    await local.query("update public.trip_notifications set message='Recovery approved · 27 Oct 2026 · Outbound' where id=$1",[driverRetained.id]);
    for(const event of ['started','completed','driver_unavailable']){
      const recorded=(await local.query('insert into public.trip_history(trip_id,actor_id,event,details) values($1,$2,$3,$4::jsonb) returning id',[trip.id,ids.driver_id,event,JSON.stringify({driver_id:ids.driver_id})])).rows[0];
      assert.equal((await local.query('select count(*)::int as count from public.trip_notifications where event_id=$1 and recipient_id=$2',[recorded.id,ids.driver_id])).rows[0].count,0);
      assert.ok((await inbox(coordinator)).notifications.some(row=>row.event===event));
      // Recreate a legacy self-notice to verify schema reapplication removes it.
      await local.query('insert into public.trip_notifications(recipient_id,trip_id,event_id,event,message) values($1,$2,$3,$4,$4)',[ids.driver_id,trip.id,recorded.id,event]);
    }
    await local.exec(schema);
    assert.equal((await inbox(patient)).total,count+6);
    const restored=(await inbox(patient)).notifications.find(row=>row.id===retained.id);
    assert.equal(restored.message,'Your pickup time has changed · 27 Oct 2026 · Outbound');assert.ok(restored.read_at);
    assert.ok(!(await inbox(patient)).notifications.some(row=>row.event==='confirmed'));
    const driverRestored=(await inbox(driver)).notifications.find(row=>row.id===driverRetained.id);
    assert.equal(driverRestored.message,'Your pickup time has changed · 27 Oct 2026 · Outbound');assert.ok(driverRestored.read_at);
    assert.ok(!(await inbox(driver)).notifications.some(row=>['started','completed','driver_unavailable'].includes(row.event)));
    await assert.rejects(own(patient,'select public.list_trip_notifications(0)'),/Invalid/);
  } finally {await local.close();}
});

test('driver unavailability is owned, stays at risk and requires coordinator resolution', async () => {
  const {local,own,ids,trips,assign}=await assignmentFixture();
  try {
    let trip=await assign(trips.find(row=>row.direction==='outbound'));
    for(const who of [patient,coordinator,stranger]) await assert.rejects(own(who,'select public.report_driver_unavailability($1,$2)',[trip.id,trip.version]),/Driver access|Trip access/);
    await assert.rejects(own(driver,'select public.report_driver_unavailability($1,$2)',[trip.id,trip.version+1]),/changed/);
    trip=(await own(driver,'select public.report_driver_unavailability($1,$2) as trip',[trip.id,trip.version]))[0].trip;
    assert.ok(trip.driver_unavailable_at);assert.equal(trip.status,'at-risk');assert.equal(trip.assigned_driver_id,ids.driver_id);
    await own(driver,'select public.report_driver_unavailability($1,$2)',[trip.id,trip.version]);
    assert.equal((await local.query("select count(*)::int as count from public.trip_history where trip_id=$1 and event='driver_unavailable'",[trip.id])).rows[0].count,1);
    await own(driver,"select public.update_my_driver($1,1)",[JSON.stringify({full_name:'Updated Driver',phone:'82345678',birth_date:'1990-01-01',gender:'male'})]);
    trip=(await local.query('select * from public.trips where id=$1',[trip.id])).rows[0];
    assert.equal(trip.status,'at-risk');
    await assert.rejects(own(patient,'select public.confirm_trip($1,$2)',[trip.id,trip.version]),/assigned upcoming/);
    const inbox=(await own(coordinator,'select public.list_trip_notifications(1) as data'))[0].data;
    assert.ok(inbox.notifications.some(item=>item.event==='driver_unavailable'));
    trip=(await own(coordinator,'select public.unassign_trip($1,$2) as trip',[trip.id,trip.version]))[0].trip;
    assert.equal(trip.driver_unavailable_at,null);
    await assert.rejects(own(driver,'select public.report_driver_unavailability($1,$2)',[trip.id,trip.version]),/Trip access/);
    trip=await assign(trip);assert.equal(trip.status,'on-track');
    trip=(await own(patient,'select public.cancel_trip($1,$2) as trip',[trip.id,trip.version]))[0].trip;
    await assert.rejects(own(driver,'select public.report_driver_unavailability($1,$2)',[trip.id,trip.version]),/Trip access/);
    await local.exec(schema);
    assert.equal((await local.query("select count(*)::int as count from public.trip_history where trip_id=$1 and event='driver_unavailable'",[trip.id])).rows[0].count,1);
  } finally {await local.close();}
});

test('verified routes set variable reservations and require travel time between driver bookings', async () => {
  const {local,own,ids,trips}=await assignmentFixture();
  try {
    let trip=trips.find(row=>row.direction==='outbound');
    for(const who of [patient,driver,coordinator])await assert.rejects(own(who,'select public.cache_driving_route($1,$2,$3::jsonb)',[trip.origin,trip.destination,JSON.stringify(fixtureRoadRoute)]),/permission denied/);
    await assert.rejects(own(patient,'select public.prepare_trip_route($1,$2)',[trip.id,trip.version]),/Coordinator/);
    await local.query('select public.cache_driving_route($1,$2,$3::jsonb)',[trip.origin,trip.destination,JSON.stringify({...fixtureRoadRoute,duration_seconds:2401})]);
    trip=(await own(coordinator,'select public.prepare_trip_route($1,$2) as trip',[trip.id,trip.version]))[0].trip;
    assert.equal(trip.duration_minutes,45);
    const starts=new Date(Date.parse(trip.arrival_by)-45*60000).toISOString();
    trip=(await own(coordinator,'select public.assign_trip($1,$2,$3,$4) as trip',[trip.id,ids.driver_id,starts,trip.version]))[0].trip;
    assert.equal(Date.parse(trip.dropoff_at)-Date.parse(trip.pickup_at),45*60000);
    await local.query('select public.cache_driving_route($1,$2,$3::jsonb)',[trip.origin,trip.destination,JSON.stringify({...fixtureRoadRoute,duration_seconds:3600})]);
    assert.equal((await own(coordinator,'select public.prepare_trip_route($1,$2) as trip',[trip.id,trip.version]))[0].trip.duration_minutes,45);
    const next=(await local.query(`insert into public.trips(patient_id,patient_name,source_schedule_id,root_schedule_id,occurrence_key,original_session_date,session_date,direction,origin,destination,treatment_start,treatment_end,arrival_by,source_version,patient_version,created_by)
      select patient_id,patient_name,source_schedule_id,root_schedule_id,'route-next',original_session_date,session_date,direction,'Other pickup',destination,treatment_start+interval '2 hours',treatment_end+interval '2 hours',arrival_by+interval '2 hours',source_version,patient_version,created_by from public.trips where id=$1 returning *`,[trip.id])).rows[0];
    await local.query('select public.cache_driving_route($1,$2,$3::jsonb)',[next.origin,next.destination,JSON.stringify(fixtureRoadRoute)]);
    let planned=(await own(coordinator,'select public.prepare_trip_route($1,$2) as trip',[next.id,next.version]))[0].trip;
    const short=new Date(Date.parse(trip.dropoff_at)+10*60000).toISOString();
    const suitable=new Date(Date.parse(trip.dropoff_at)+60*60000).toISOString();
    await assert.rejects(own(coordinator,'select public.assign_trip($1,$2,$3,$4)',[planned.id,ids.driver_id,short,planned.version]),/eligible/);
    await local.query('select public.cache_driving_route($1,$2,$3::jsonb)',[trip.destination,next.origin,JSON.stringify({...fixtureRoadRoute,duration_seconds:1200})]);
    assert.equal((await own(coordinator,'select public.trip_assignment_options($1,$2) as data',[planned.id,short]))[0].data.drivers.length,0);
    const bridgeSlot=(await local.query(`select (extract(isodow from $1::date)::int-1)*48+20 as slot`,[ids.first])).rows[0].slot;
    await local.query('update public.driver_availability set weekly_slots=array_remove(weekly_slots,$2) where driver_id=$1',[ids.driver_id,bridgeSlot]);
    assert.equal((await own(coordinator,'select public.trip_assignment_options($1,$2) as data',[planned.id,suitable]))[0].data.drivers.length,0);
    await local.query('update public.driver_availability set weekly_slots=array(select generate_series(0,335)) where driver_id=$1',[ids.driver_id]);
    planned=(await own(coordinator,'select public.assign_trip($1,$2,$3,$4) as trip',[planned.id,ids.driver_id,suitable,planned.version]))[0].trip;
    const availability=(await local.query('select * from public.driver_availability where driver_id=$1',[ids.driver_id])).rows[0];
    await assert.rejects(own(driver,'select public.save_my_availability($1,$2)',[availability.weekly_slots.filter(slot=>slot!==bridgeSlot),availability.version]),/remain available/);

    assert.equal(planned.duration_minutes,30);
    const monday=(await local.query(`select ($1::date-extract(isodow from $1::date)::integer+1)::text as monday`,[ids.first])).rows[0].monday;
    const calendar=(await own(driver,'select public.get_driver_week($1,$2) as data',[ids.driver_id,monday]))[0].data;
    assert.ok(calendar.trips.some(row=>row.kind==='transfer'&&row.destination===planned.origin));

    await local.exec(schema);
    assert.equal((await local.query('select duration_minutes from public.trips where id=$1',[trip.id])).rows[0].duration_minutes,45);
  } finally {await local.close();}
});

test('driver execution is explicit and live location is scoped to an assigned active journey', async () => {
  const {local,own,ids,trips,assign}=await assignmentFixture();
  try {
    let trip=await assign(trips.find(row=>row.direction==='outbound'));
    const other=await assign(trips.find(row=>row.direction==='return'));
    for(const who of [patient,coordinator,stranger])await assert.rejects(own(who,"select public.execute_trip($1,'start',$2)",[trip.id,trip.version]),/Driver access|Trip access/);
    await assert.rejects(own(driver,"select public.execute_trip($1,'start',$2)",[trip.id,trip.version]),/pickup/);
    await local.query(`update public.trips set pickup_at=now()-interval '5 minutes',dropoff_at=now()+interval '25 minutes',treatment_start=now()+interval '40 minutes',treatment_end=now()+interval '100 minutes',arrival_by=now()+interval '25 minutes' where id=$1`,[trip.id]);
    trip=(await local.query('select * from public.trips where id=$1',[trip.id])).rows[0];
    const oldVersion=trip.version;
    trip=(await own(driver,"select public.execute_trip($1,'start',$2) as trip",[trip.id,trip.version]))[0].trip;
    assert.equal(trip.lifecycle,'in-progress');assert.ok(trip.started_at);assert.equal(trip.completed_at,null);
    assert.equal((await own(driver,"select public.execute_trip($1,'start',$2) as trip",[trip.id,trip.version]))[0].trip.version,trip.version);
    await local.query(`update public.trips set pickup_at=now()-interval '1 minute',dropoff_at=now()+interval '29 minutes',pickup_not_before=now()-interval '1 minute',treatment_start=now()-interval '76 minutes',treatment_end=now()-interval '16 minutes' where id=$1`,[other.id]);
    const otherVersion=(await local.query('select version from public.trips where id=$1',[other.id])).rows[0].version;
    await assert.rejects(own(driver,"select public.execute_trip($1,'start',$2)",[other.id,otherVersion]),/already has an active/);

    await assert.rejects(own(driver,"select public.execute_trip($1,'complete',$2)",[trip.id,oldVersion]),/changed/);
    await assert.rejects(own(patient,'select public.cancel_trip($1,$2)',[trip.id,trip.version]),/upcoming/);
    const recorded=new Date().toISOString();
    let sharing=(await own(driver,'select public.begin_trip_sharing($1) as data',[trip.id]))[0].data.sharing_id;
    for(const who of [patient,coordinator,stranger])await assert.rejects(own(who,'select public.report_trip_location($1,$2,1.3,103.8,10,$3)',[trip.id,sharing,recorded]),/Driver access|Trip access/);
    await own(driver,'select public.report_trip_location($1,$2,1.3,103.8,10,$3)',[trip.id,sharing,recorded]);
    const progress=(await own(patient,'select public.trip_progress($1) as data',[trip.id]))[0].data;
    assert.equal(progress.trip.lifecycle,'in-progress');assert.equal(progress.location.latitude,1.3);
    await assert.rejects(own(stranger,'select public.trip_progress($1)',[trip.id]),/Trip access|not found/);
    await assert.rejects(own(driver,'select public.report_trip_location($1,$2,91,103.8,10,$3)',[trip.id,sharing,recorded]),/Invalid/);
    await assert.rejects(own(driver,'select public.report_trip_location($1,$2,1.3,103.8,10,$3)',[trip.id,sharing,new Date(Date.now()+120000).toISOString()]),/Invalid/);
    await own(driver,'select public.clear_trip_location($1,$2)',[trip.id,sharing]);
    assert.equal((await own(patient,'select public.trip_progress($1) as data',[trip.id]))[0].data.location,null);
    await assert.rejects(own(driver,'select public.report_trip_location($1,$2,1.3,103.8,10,$3)',[trip.id,sharing,new Date().toISOString()]),/session ended/);
    sharing=(await own(driver,'select public.begin_trip_sharing($1) as data',[trip.id]))[0].data.sharing_id;
    await own(driver,'select public.report_trip_location($1,$2,1.3,103.8,10,$3)',[trip.id,sharing,new Date().toISOString()]);
    trip=(await own(driver,"select public.execute_trip($1,'complete',$2) as trip",[trip.id,trip.version]))[0].trip;
    assert.equal(trip.lifecycle,'completed');assert.equal(trip.status,'resolved');assert.ok(trip.completed_at);
    const completedNotices=(await own(patient,'select public.list_trip_notifications(1) as data'))[0].data.notifications.filter(notice=>notice.trip_id===trip.id&&notice.event==='completed');
    assert.equal(completedNotices.length,1);assert.match(completedNotices[0].message,/^Rate your driver · /);
    const coordinatorCompletion=(await own(coordinator,'select public.list_trip_notifications(1) as data'))[0].data.notifications.find(notice=>notice.trip_id===trip.id&&notice.event==='completed');
    assert.match(coordinatorCompletion.message,/^Trip completed · /);
    for(const who of [driver,coordinator,stranger]){
      await assert.rejects(own(who,'select public.trip_feedback($1)',[trip.id]),/access denied/i);
      await assert.rejects(own(who,'select public.rate_driver($1,5)',[trip.id]),/access denied/i);
      await assert.rejects(own(who,'select public.set_driver_preference($1,0)',[ids.driver_id]),/access denied/i);
    }
    await assert.rejects(own(patient,'select public.rate_driver($1,5)',[other.id]),/completed/i);
    await assert.rejects(own(patient,'select public.rate_driver($1,6)',[trip.id]),/rating/i);
    assert.equal((await own(patient,'select public.rate_driver($1,5) as data',[trip.id]))[0].data.rating,5);
    assert.equal((await own(patient,'select public.rate_driver($1,5) as data',[trip.id]))[0].data.rating,5);
    await assert.rejects(own(patient,'select public.rate_driver($1,4)',[trip.id]),error=>error.code==='PT409');
    const feedback=(await own(patient,'select public.trip_feedback($1) as data',[trip.id]))[0].data;
    assert.equal(feedback.driver_id,ids.driver_id);assert.equal(feedback.rating,5);assert.equal(feedback.preference.version,0);
    let preference=(await own(patient,'select public.set_driver_preference($1,0) as data',[ids.driver_id]))[0].data;
    assert.equal(preference.driver_id,ids.driver_id);
    await assert.rejects(own(patient,'select public.set_driver_preference(null,0)'),error=>error.code==='PT409');
    preference=(await own(patient,'select public.set_driver_preference(null,$1) as data',[preference.version]))[0].data;
    assert.equal(preference.driver_id,null);
    preference=(await own(patient,'select public.set_driver_preference($1,$2) as data',[ids.driver_id,preference.version]))[0].data;
    const statistics=(await own(driver,'select public.my_driver_statistics() as data'))[0].data;
    assert.deepEqual(statistics,{completed_trips:1,average_rating:5,rating_count:1});
    await assert.rejects(own(patient,'select public.my_driver_statistics()'),/Driver access/i);
    await assert.rejects(own(driver,'select * from private.driver_ratings'),/permission/i);
    const resolved=(await own(coordinator,"select public.list_trips(1,$1,null,'resolved') as data",[ids.first]))[0].data;
    assert.equal(resolved.total,1);assert.equal(resolved.trips[0].id,trip.id);
    assert.equal(resolved.counts.resolved,1);assert.equal(resolved.counts.cancelled,0);
    assert.equal((await local.query('select * from public.trip_locations where trip_id=$1',[trip.id])).rows.length,0);
    await local.query('insert into public.trip_locations(trip_id,driver_id,latitude,longitude,accuracy_metres,recorded_at,received_at) values($1,$2,1.3,103.8,10,now(),now())',[trip.id,ids.driver_id]);
    for(const who of [patient,driver,coordinator])assert.deepEqual(await own(who,'select latitude,longitude from public.trip_locations where trip_id=$1',[trip.id]),[]);
    await local.query('delete from public.trip_locations where trip_id=$1',[trip.id]);

    assert.equal((await own(patient,'select public.trip_progress($1) as data',[trip.id]))[0].data.location,null);
    await assert.rejects(own(driver,'select public.report_trip_location($1,$2,1.3,103.8,10,$3)',[trip.id,sharing,new Date().toISOString()]),/active/);
    await assert.rejects(own(driver,"select public.execute_trip($1,'start',$2)",[trip.id,trip.version]),/scheduled|completed/);
    assert.equal((await local.query('select lifecycle from public.trips where id=$1',[other.id])).rows[0].lifecycle,'scheduled');
    await local.exec(schema);
    assert.equal((await local.query('select lifecycle from public.trips where id=$1',[trip.id])).rows[0].lifecycle,'completed');
    assert.equal((await own(patient,'select public.trip_feedback($1) as data',[trip.id]))[0].data.rating,5);
    assert.equal((await own(patient,'select public.trip_feedback($1) as data',[trip.id]))[0].data.preference.driver_id,ids.driver_id);
  } finally {await local.close();}
});


test('trusted traffic monitoring leases work and flags a trip once without clearing independent risks', async () => {
  const {local,own,trips,assign}=await assignmentFixture();
  const service=async(sql,params=[])=>{
    await local.exec('begin; set local role service_role;');
    try {const result=await local.query(sql,params);await local.exec('commit');return result.rows;}
    catch(error){await local.exec('rollback');throw error;}
  };
  try {
    let trip=await assign(trips.find(row=>row.direction==='outbound'));
    await local.query(`update public.trips set pickup_at=now()+interval '10 minutes',dropoff_at=now()+interval '40 minutes',treatment_start=now()+interval '55 minutes',treatment_end=now()+interval '115 minutes',arrival_by=now()+interval '40 minutes' where id=$1`,[trip.id]);
    trip=(await local.query('select * from public.trips where id=$1',[trip.id])).rows[0];
    const assessment={assessed_at:new Date().toISOString(),expires_at:new Date(Date.now()+60000).toISOString(),risk:'possible-delay',requires_attention:true,coverage_percent:50};
    for(const who of [patient,driver,coordinator]){
      await assert.rejects(own(who,'select public.claim_trip_traffic_checks()'),/permission/i);
      await assert.rejects(own(who,'select public.trip_traffic_context($1)',[trip.id]),/permission/i);
      await assert.rejects(own(who,'select public.record_trip_traffic_check($1,$2,$3::jsonb)',[trip.id,trip.version,JSON.stringify(assessment)]),/permission/i);
    }
    assert.ok((await service('select public.claim_trip_traffic_checks() as ids'))[0].ids.includes(trip.id));
    assert.ok(!(await service('select public.claim_trip_traffic_checks() as ids'))[0].ids.includes(trip.id));
    assert.equal((await service('select public.trip_traffic_context($1) as data',[trip.id]))[0].data.location,null);
    await assert.rejects(service('select public.record_trip_traffic_check($1,$2,$3::jsonb)',[trip.id,trip.version+1,JSON.stringify(assessment)]),/changed/i);
    const expired={...assessment,assessed_at:new Date(Date.now()-60000).toISOString(),expires_at:new Date(Date.now()-1000).toISOString()};
    await assert.rejects(service('select public.record_trip_traffic_check($1,$2,$3::jsonb)',[trip.id,trip.version,JSON.stringify(expired)]),error=>error.code==='PT409'&&/expired/i.test(error.message));
    assert.equal((await local.query('select traffic_review_required from public.trips where id=$1',[trip.id])).rows[0].traffic_review_required,false,'Rejected assessments must not change review flags.');
    await service('select public.record_trip_traffic_check($1,$2,$3::jsonb)',[trip.id,trip.version,JSON.stringify(assessment)]);
    trip=(await local.query('select * from public.trips where id=$1',[trip.id])).rows[0];
    assert.equal(trip.traffic_review_required,true);assert.equal(trip.status,'at-risk');
    await service('select public.record_trip_traffic_check($1,$2,$3::jsonb)',[trip.id,trip.version,JSON.stringify(assessment)]);
    await service('select public.record_trip_traffic_check($1,$2,$3::jsonb)',[trip.id,trip.version,JSON.stringify({...assessment,risk:'no-delay-detected',requires_attention:false})]);
    assert.equal((await local.query('select traffic_review_required from public.trips where id=$1',[trip.id])).rows[0].traffic_review_required,true);
    assert.equal((await local.query("select count(*)::int as count from public.trip_history where trip_id=$1 and event='traffic_risk_detected'",[trip.id])).rows[0].count,1);
    for(const who of [patient,driver,coordinator])assert.ok((await own(who,'select public.list_trip_notifications(1) as data'))[0].data.notifications.some(row=>row.event==='traffic_risk_detected'));
    const clear={...assessment,risk:'no-delay-detected',requires_attention:false,clear_verified:true,coverage_percent:99,arrival_until:new Date(trip.dropoff_at).toISOString()};
    await assert.rejects(service('select public.record_trip_traffic_check($1,$2,$3::jsonb)',[trip.id,trip.version,JSON.stringify({...clear,coverage_percent:20})]),/clearance/i);
    await service('select public.record_trip_traffic_check($1,$2,$3::jsonb)',[trip.id,trip.version,JSON.stringify(clear)]);
    trip=(await local.query('select * from public.trips where id=$1',[trip.id])).rows[0];
    assert.equal(trip.traffic_review_required,false);assert.equal(trip.status,'on-track');
    await service('select public.record_trip_traffic_check($1,$2,$3::jsonb)',[trip.id,trip.version,JSON.stringify(clear)]);
    assert.equal((await local.query("select count(*)::int as count from public.trip_history where trip_id=$1 and event='traffic_risk_cleared'",[trip.id])).rows[0].count,1);
    await service('select public.record_trip_traffic_check($1,$2,$3::jsonb)',[trip.id,trip.version,JSON.stringify(assessment)]);
    trip=(await local.query('select * from public.trips where id=$1',[trip.id])).rows[0];
    await own(driver,'select public.report_driver_unavailability($1,$2)',[trip.id,trip.version]);
    trip=(await local.query('select * from public.trips where id=$1',[trip.id])).rows[0];
    await service('select public.record_trip_traffic_check($1,$2,$3::jsonb)',[trip.id,trip.version,JSON.stringify(clear)]);
    await local.exec(schema);
    trip=(await local.query('select * from public.trips where id=$1',[trip.id])).rows[0];
    assert.equal(trip.traffic_review_required,false);assert.equal(trip.status,'at-risk');assert.ok(trip.driver_unavailable_at);
    trip=(await own(coordinator,'select public.unassign_trip($1,$2) as trip',[trip.id,trip.version]))[0].trip;
    assert.equal(trip.traffic_review_required,false);assert.equal(trip.status,'unfilled');
    assert.equal((await local.query('select count(*)::int as count from private.trip_traffic_checks where trip_id=$1',[trip.id])).rows[0].count,0);
  } finally {await local.close();}
});


test('recovery proposals preserve reservations and require trusted validation plus coordinator approval', async () => {
  const {local,own,trips,assign,source,ids}=await assignmentFixture();
  const service=async(sql,params=[])=>{
    await local.exec('begin; set local role service_role;');
    try {const result=await local.query(sql,params);await local.exec('commit');return result.rows;}
    catch(error){await local.exec('rollback');throw error;}
  };
  try {
    let trip=await assign(trips.find(row=>row.direction==='outbound'));
    await local.query("update public.trips set traffic_review_required=true,status='at-risk' where id=$1",[trip.id]);
    trip=(await local.query('select * from public.trips where id=$1',[trip.id])).rows[0];
    for(const who of [patient,driver,coordinator]){
      await assert.rejects(own(who,'select public.trip_recovery_candidates($1,$2,$3,false)',[trip.id,trip.version,trip.duration_minutes]),/permission/i);
      await assert.rejects(own(who,'select public.store_trip_recovery_options($1,$2,$3,false)',[trip.id,trip.version,trip.duration_minutes]),/permission/i);
      await assert.rejects(own(who,'select public.store_assessed_trip_recovery_options($1,$2,45,false,null,true,15)',[trip.id,trip.version]),/permission/i);
      await assert.rejects(own(who,'select public.claim_trip_recovery_checks()'),/permission/i);
      await assert.rejects(own(who,'select public.pending_trip_recovery_options($1,$2)',[trip.id,trip.version]),/permission/i);
    }
    const claimed=(await service('select public.claim_trip_recovery_checks() as work'))[0].work;
    assert.ok(claimed.some(row=>row.id===trip.id&&row.version===trip.version));
    assert.ok(!(await service('select public.claim_trip_recovery_checks() as work'))[0].work.some(row=>row.id===trip.id));
    await assert.rejects(service('select public.store_assessed_trip_recovery_options($1,$2,30,false,null,true,0)',[trip.id,trip.version]),/Invalid recovery estimate/i);
    await assert.rejects(service('select public.store_assessed_trip_recovery_options($1,$2,30,false,null,true,15)',[trip.id,trip.version]),/include its planning buffer/i);
    const proposed=(await service('select public.store_assessed_trip_recovery_options($1,$2,45,false,null,true,15) as data',[trip.id,trip.version]))[0].data;
    assert.ok(proposed.options.length);assert.equal(proposed.critical,false);
    assert.equal(proposed.trip.assigned_driver_id,trip.assigned_driver_id);assert.equal(proposed.trip.version,trip.version);
    const option=proposed.options[0];
    assert.equal(option.estimated_duration,true);assert.equal(option.buffer_minutes,15);assert.equal(option.duration_minutes,45);
    const reused=(await service('select public.store_trip_recovery_options($1,$2,$3,false) as data',[trip.id,trip.version,trip.duration_minutes]))[0].data;
    assert.deepEqual(reused.options.map(row=>row.id),proposed.options.map(row=>row.id));
    const pending=(await service('select public.pending_trip_recovery_options($1,$2) as data',[trip.id,trip.version]))[0].data;
    assert.equal(pending.options[0].id,option.id);
    assert.equal(pending.options[0].estimated_duration,true);assert.equal(pending.options[0].buffer_minutes,15);
    await local.query('insert into private.driver_preferences(patient_id,driver_id) values($1,$2)',[ids.patient_id,option.driver_id]);
    const preferredCache=(await service('select public.pending_trip_recovery_options($1,$2) as data',[trip.id,trip.version]))[0].data;
    assert.ok(preferredCache.options.filter(row=>row.driver_id===option.driver_id).every(row=>row.preferred===true),'Cached proposals retain current preference metadata and ranking.');
    // Even an elapsed worker lease cannot replace proposals being reviewed.
    await local.query("update private.trip_recovery_checks set next_check_at=now()-interval '1 minute' where trip_id=$1",[trip.id]);
    assert.ok(!(await service('select public.claim_trip_recovery_checks() as work'))[0].work.some(row=>row.id===trip.id));
    await assert.rejects(own(coordinator,'select public.approve_trip_recovery($1,$2)',[option.id,trip.version]),/expired|changed/i);
    for(const who of [patient,driver,coordinator])await assert.rejects(own(who,"select public.attest_trip_recovery_option($1,clock_timestamp()+interval '20 seconds')",[option.id]),/permission/i);
    await service("select public.attest_trip_recovery_option($1,clock_timestamp()+interval '20 seconds')",[option.id]);
    for(const who of [patient,driver])await assert.rejects(own(who,'select public.approve_trip_recovery($1,$2)',[option.id,trip.version]),/Coordinator/i);
    trip=(await own(coordinator,'select public.approve_trip_recovery($1,$2) as trip',[option.id,trip.version]))[0].trip;
    assert.equal(trip.status,'on-track');assert.equal(trip.traffic_review_required,false);assert.equal(trip.confirmed_at,null);
    await assert.rejects(own(coordinator,'select public.approve_trip_recovery($1,$2)',[option.id,trip.version]),/expired|changed/i);
    assert.equal((await local.query("select count(*)::int as count from public.trip_history where trip_id=$1 and event='recovery_approved'",[trip.id])).rows[0].count,1);
    const estimate=(await local.query("select details from public.trip_history where trip_id=$1 and event='recovery_approved'",[trip.id])).rows[0].details;
    assert.equal(estimate.estimated_duration,true);assert.equal(estimate.buffer_minutes,15);assert.equal(trip.duration_minutes,45);
    trip=(await own(driver,'select public.report_driver_unavailability($1,$2) as trip',[trip.id,trip.version]))[0].trip;
    const critical=(await service('select public.store_trip_recovery_options($1,$2,$3,false) as data',[trip.id,trip.version,trip.duration_minutes]))[0].data;
    assert.equal(critical.options.length,0);assert.equal(critical.critical,true);
    assert.equal(critical.trip.assigned_driver_id,trip.assigned_driver_id);assert.equal(critical.trip.status,'at-risk');
    await local.exec(schema);
    assert.equal((await local.query('select recovery_critical from public.trips where id=$1',[trip.id])).rows[0].recovery_critical,true);
    assert.ok((await own(coordinator,'select public.list_trip_notifications(1) as data'))[0].data.notifications.some(row=>row.event==='recovery_critical'));

    // Active recovery requires a separately confirmed safe pickup and a replacement driver.
    const replacement=(await local.query("insert into public.accounts(auth_user_id,email,display_name,role) values($1,'replacement@example.test','Replacement','driver') returning id",[stranger])).rows[0].id;
    await local.query("insert into public.drivers(account_id,full_name,phone,birth_date,gender) values($1,'Replacement Driver','80000002','1990-01-01','male')",[replacement]);
    await local.query("insert into public.driver_vehicles(driver_id,licence_number,plate_number,make,model,passenger_capacity,wheelchair_accessible,status,reviewed_at,reviewed_by) values($1,'HANDOVER','HAND001','Fixture','Replacement',4,false,'approved',now(),(select id from public.accounts where role='coordinator'))",[replacement]);
    await local.query('insert into public.driver_availability(driver_id,weekly_slots) values($1,array(select generate_series(0,335)))',[replacement]);
    await local.query("update public.trips set pickup_at=now()-interval '5 minutes',dropoff_at=now()+interval '25 minutes',duration_minutes=30,treatment_start=now()+interval '2 hours',treatment_end=now()+interval '3 hours',arrival_by=now()+interval '105 minutes',driver_unavailable_at=null,recovery_critical=false where id=$1",[trip.id]);
    trip=(await local.query('select * from public.trips where id=$1',[trip.id])).rows[0];
    trip=(await own(driver,"select public.execute_trip($1,'start',$2) as trip",[trip.id,trip.version]))[0].trip;
    const firstStart=trip.started_at,originalOrigin=trip.origin;
    trip=(await own(driver,'select public.report_driver_unavailability($1,$2) as trip',[trip.id,trip.version]))[0].trip;
    const safePoint='Fixture safe pickup point';
    await local.query('select public.cache_driving_route($1,$2,$3::jsonb)',[safePoint,trip.destination,JSON.stringify(fixtureRoadRoute)]);
    for(const who of [patient,driver,coordinator])await assert.rejects(own(who,'select public.store_trip_handover_options($1,$2,$3,$4)',[trip.id,trip.version,30,safePoint]),/permission/i);
    const handover=(await service('select public.store_trip_handover_options($1,$2,$3,$4) as data',[trip.id,trip.version,30,safePoint]))[0].data;
    assert.ok(handover.options.length);assert.ok(handover.options.every(row=>row.driver_id!==ids.driver_id));
    assert.equal(handover.trip.lifecycle,'in-progress');assert.equal(handover.trip.assigned_driver_id,ids.driver_id);assert.equal(handover.trip.origin,originalOrigin);
    const handoverOption=handover.options.find(row=>row.driver_id===replacement);
    assert.ok(handoverOption);
    // An eligible saved pickup stays valid even when it is outside a freshly rounded grid.
    await local.query("update private.trip_recovery_options set pickup_at=pickup_at+interval '1 minute' where id=$1",[handoverOption.id]);
    assert.equal((await service('select public.trip_recovery_validation($1) as data',[handoverOption.id]))[0].data.feasible,true);
    await service("select public.attest_trip_recovery_option($1,clock_timestamp()+interval '20 seconds')",[handoverOption.id]);
    await assert.rejects(own(coordinator,'select public.approve_trip_recovery($1,$2)',[handoverOption.id,handover.trip.version]),/eligible/i);
    await assert.rejects(own(coordinator,'select public.approve_trip_handover($1,$2,false)',[handoverOption.id,handover.trip.version]),/eligible/i);
    await assert.rejects(own(patient,'select public.approve_trip_handover($1,$2,true)',[handoverOption.id,handover.trip.version]),/Coordinator/i);
    trip=(await own(coordinator,'select public.approve_trip_handover($1,$2,true) as trip',[handoverOption.id,handover.trip.version]))[0].trip;
    assert.equal(trip.lifecycle,'scheduled');assert.equal(trip.started_at,null);assert.equal(trip.first_started_at,firstStart);
    assert.equal(trip.origin,safePoint);assert.equal(trip.assigned_driver_id,replacement);assert.equal(trip.route_snapshot.origin,safePoint);assert.ok(trip.handover_at);
    await assert.rejects(own(patient,'select public.cancel_trip($1,$2)',[trip.id,trip.version]),/before pickup|handover/i);
    await assert.rejects(local.query('update public.trips set origin=$2 where id=$1',[trip.id,originalOrigin]),/handover/i);
    await own(coordinator,'select public.generate_treatment_trips($1,$2,$3,$4)',[source.id,ids.first,ids.last,source.version]);
    assert.equal((await local.query('select origin from public.trips where id=$1',[trip.id])).rows[0].origin,safePoint);
    const record=(await local.query("select details from public.trip_history where trip_id=$1 and event='handover_approved'",[trip.id])).rows[0].details;
    assert.equal(record.previous_driver_id,ids.driver_id);assert.equal(record.previous_started_at,firstStart);
    assert.ok((await own(coordinator,'select public.list_trip_notifications(1) as data'))[0].data.notifications.some(row=>row.event==='handover_approved'));
    const handoverNotices=(await local.query("select recipient_id,message from public.trip_notifications where trip_id=$1 and event='handover_approved'",[trip.id])).rows;
    assert.ok(handoverNotices.some(row=>row.recipient_id===ids.driver_id&&row.message.startsWith('Trip reassigned to another driver · ')));
    assert.ok(handoverNotices.some(row=>row.recipient_id===replacement&&row.message.startsWith('Trip assigned to you · ')));
    await local.exec(schema);
    assert.equal(new Date((await local.query('select first_started_at from public.trips where id=$1',[trip.id])).rows[0].first_started_at).toISOString(),new Date(firstStart).toISOString());
  } finally {await local.close();}
});
