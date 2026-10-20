import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

// Disposable PostgreSQL engine; this suite never connects to Supabase.
const schema = await readFile(new URL('../schema.sql', import.meta.url), 'utf8');
async function databaseWithAuth() {
  const database = new PGlite();
  await database.exec(`-- FICTIONAL AUTH FIXTURE FOR DISPOSABLE LOCAL DATABASES ONLY. Never run on Supabase.
    create role anon; create role authenticated;
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
const signupDetails = { full_name: 'Test Patient', phone: '+65 81234567', pickup_address: 'Test street', postal_code: '560123', mobility: 'ambulant', assistance_required: false };
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
test('verified new user has no account until registration; client metadata grants nothing', async () => {
  const rows = await asUser(patient, 'select public.current_account() as account');
  assert.equal(rows[0].account, null);
});
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
});
test('each public role registers directly as active; coordinator role never comes from signup', async () => {
  const [{ account }] = await asUser(driver, "select public.register_account('driver', 'Test Driver') as account");
  assert.equal(account.role, 'driver');
  assert.equal(account.status, 'active');
  await db.query("update auth.users set email_confirmed_at = now() where id = $1", [stranger]);
  const [{ account: caregiver }] = await asUser(stranger, "select public.register_account('caregiver', 'Test Caregiver') as account");
  assert.equal(caregiver.role, 'caregiver');
  assert.equal(caregiver.status, 'active');
});
test('deactivated accounts stay inactive and cannot re-register to reactivate themselves', async () => {
  await db.query("update public.accounts set status = 'inactive' where auth_user_id = $1", [patient]);
  assert.equal((await asUser(patient, 'select public.current_account() as account'))[0].account.status, 'inactive');
  await assert.rejects(asUser(patient, "select public.register_account('driver', 'Changed')"), /already registered/);
  await db.query("update public.accounts set status = 'inactive' where auth_user_id = $1", [coordinator]);
  assert.equal((await asUser(coordinator, 'select * from public.accounts')).length, 1);
});
test('no account approval RPC is exposed, including to coordinators', async () => {
  assert.equal((await db.query("select to_regprocedure('public.review_account(uuid,text)') as fn")).rows[0].fn, null);
  assert.equal((await db.query("select to_regprocedure('private.review_account(uuid,text)') as fn")).rows[0].fn, null);
});
test('anonymous callers cannot execute account functions or read accounts', async () => {
  await db.exec('set role anon');
  try {
    await assert.rejects(db.query('select public.current_account()'), /permission denied/);
    await assert.rejects(db.query('select * from public.accounts'), /permission denied/);
  } finally { await db.exec('reset role'); }
});

test('schema upgrades and reruns preserve existing accounts and access restrictions', async () => {
  const db = await databaseWithAuth();
  try {
    // Model only the old storage/API contract needed to prove a safe upgrade.
    await db.exec(`
      create schema private;
      create table public.accounts (
        id uuid primary key default gen_random_uuid(),
        auth_user_id uuid unique references auth.users(id),
        email text not null unique,
        display_name text not null,
        role text not null check (role in ('coordinator','patient','caregiver','driver')),
        status text not null default 'pending' check (status in ('pending','approved','rejected','inactive')),
        created_at timestamptz not null default now(),
        reviewed_at timestamptz,
        reviewed_by uuid references public.accounts(id)
      );
      create index accounts_pending_created on public.accounts(created_at) where status='pending';
      create function private.review_account(uuid,text) returns jsonb language sql as 'select null::jsonb';
      create function public.review_account(uuid,text) returns jsonb language sql as 'select private.review_account($1,$2)';
    `);
    await db.exec(`insert into public.accounts(email, display_name, role, status, auth_user_id) values
      ('coordinator@example.test', 'Coordinator', 'coordinator', 'approved', '22222222-2222-4222-8222-222222222222'),
      ('patient@example.test', 'Patient', 'patient', 'pending', '11111111-1111-4111-8111-111111111111'),
      ('driver@example.test', 'Driver', 'driver', 'rejected', '33333333-3333-4333-8333-333333333333'),
      ('inactive@example.test', 'Inactive', 'patient', 'inactive', null);`);
    const before = (await db.query('select id, email, role, auth_user_id, created_at from public.accounts order by email')).rows;
    await db.exec(schema);
    assert.deepEqual((await db.query('select id, email, role, auth_user_id, created_at from public.accounts order by email')).rows, before);
    assert.deepEqual((await db.query('select email,status from public.accounts order by email')).rows, [
      { email: 'coordinator@example.test', status: 'active' },
      { email: 'driver@example.test', status: 'inactive' },
      { email: 'inactive@example.test', status: 'inactive' },
      { email: 'patient@example.test', status: 'active' },
    ]);
    assert.equal((await db.query("select to_regprocedure('public.review_account(uuid,text)') as fn")).rows[0].fn, null);
    assert.equal((await db.query("select to_regprocedure('private.review_account(uuid,text)') as fn")).rows[0].fn, null);
    // Running again is safe and does not reactivate deliberately inactive users.
    await db.exec(schema);
    await db.exec("set role authenticated; select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',false)");
    assert.equal((await db.query('select * from public.accounts')).rows.length, 4);
    await db.exec("select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false)");
    assert.equal((await db.query('select * from public.accounts')).rows.length, 1);
    await assert.rejects(db.query("update public.accounts set role='coordinator'"), /permission denied/);
    await db.exec("select set_config('request.jwt.claim.sub','44444444-4444-4444-8444-444444444444',false); reset role; update auth.users set email_confirmed_at=now() where email='stranger@example.test'; set role authenticated;");
    const [{ account }] = (await db.query("select public.register_account('caregiver','New Caregiver') as account")).rows;
    assert.equal(account.role, 'caregiver');
    assert.equal(account.status, 'active');
  } finally { await db.close(); }
});

test('reapplying the schema preserves account status, roles and first-login links', async () => {
  const before = (await db.query('select * from public.accounts order by email')).rows;
  await db.exec(schema);
  assert.deepEqual((await db.query('select * from public.accounts order by email')).rows, before);
  assert.equal((await db.query("select to_regprocedure('public.review_account(uuid,text)') as fn")).rows[0].fn, null);
});

test('patient records persist independently of login accounts and are coordinator-only', async () => {
  const local = await databaseWithAuth();
  try {
    await local.exec(schema);
    await local.query("insert into public.accounts(auth_user_id,email,display_name,role) values ($1,'coordinator@example.test','Coordinator','coordinator'),($2,'patient@example.test','Patient','patient')", [coordinator, patient]);
    async function act(id, sql, args = []) {
      await local.exec('begin; set local role authenticated');
      try {
        await local.query("select set_config('request.jwt.claim.sub',$1,true)", [id]);
        const result = await local.query(sql, args);
        await local.exec('commit');
        return result.rows;
      } catch (e) { await local.exec('rollback'); throw e; }
    }
    const insert = "insert into public.patients(full_name,phone,pickup_address,mobility,assistance_required) values ($1,$2,$3,$4,$5) returning *";
    const args = ['Test Patient', '81234567', 'Test pickup address', 'wheelchair', true];
    const { rows: [record] } = await local.query(insert, args);
    assert.equal(record.status, 'active');
    assert.equal(record.assistance_required, true);
    assert.equal((await act(coordinator, 'select * from public.patients')).length, 1);
    for (const id of [patient, driver, stranger]) {
      assert.deepEqual(await act(id, 'select * from public.patients'), []);
      await assert.rejects(act(id, insert, args), /(row-level security|permission denied)/);
      await assert.rejects(act(id, "update public.patients set full_name='Not allowed' returning *"), /permission denied/);
    }
    await assert.rejects(act(coordinator, insert, args), /permission denied/);
    for (const field of ['full_name', 'phone', 'pickup_address', 'mobility', 'unit_no', 'postal_code', 'account_id', 'assistance_required', 'id', 'created_at']) {
      await assert.rejects(act(coordinator, `update public.patients set ${field} = ${field} where id=$1`, [record.id]), /permission denied/);
    }
    await act(coordinator, "update public.patients set notes='Coordinator note' where id=$1", [record.id]);
    await act(coordinator, "update public.patients set status='inactive' where id=$1", [record.id]);
    await assert.rejects(act(coordinator, 'delete from public.patients'), /permission denied/);
    await local.exec(schema);
    assert.equal((await act(coordinator, 'select * from public.patients'))[0].status, 'inactive');
    await local.query("update public.accounts set status='inactive' where auth_user_id=$1", [coordinator]);
    assert.deepEqual(await act(coordinator, 'select * from public.patients'), []);
    await assert.rejects(act(coordinator, insert, args), /(row-level security|permission denied)/);
    await local.exec('set role anon');
    await assert.rejects(local.query('select * from public.patients'), /permission denied/);
    await local.exec('reset role');
  } finally { await local.close(); }
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
    const details = { full_name: 'Test Patient', phone: '81234567', pickup_address: 'Test address', mobility: 'wheelchair', assistance_required: true };
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
    assert.deepEqual(await act(patient, "update public.patients set status='inactive' returning *"), []);
    const [{ patient: updated }] = await save(patient, { ...details, phone: '87654321', unit_no: '#05-12', postal_code: '560123', notes: 'Call on arrival.' });
    assert.equal(updated.id, record.id);
    assert.equal(updated.phone, '87654321');
    assert.equal(updated.unit_no, '#05-12');
    assert.equal(updated.postal_code, '560123');
    assert.equal(updated.notes, 'Call on arrival.');
    const [{ patient: compatible }] = await save(patient);
    assert.equal(compatible.notes, 'Call on arrival.');
    await assert.rejects(save(patient, { ...details, postal_code: '123' }), /check constraint/);
    await assert.rejects(save(patient, { ...details, notes: 'x'.repeat(1001) }), /check constraint/);
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
    await act(coordinator, "update public.patients set status='inactive' where id=$1", [record.id]);
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
    const details = { full_name: 'Test Patient', phone: '+65 81234567', pickup_address: 'Test street', unit_no: '', postal_code: '560123', notes: '', mobility: 'ambulant', assistance_required: false };
    for (const body of [null, {}, { ...details, notes: 'x'.repeat(1001) }, { ...details, postal_code: '123' }, { ...details, status: 'active' }]) {
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
    // A shared weekday outside the intersecting date range is not a real overlap.
    await own(patient,insert.replace("'2026-10-20','2026-12-31'","'2026-10-20','2026-10-20'"));
    assert.equal((await own(coordinator,"update public.treatment_schedules set start_time='10:00' returning id")).length,0);
    await assert.rejects(own(patient,"update public.treatment_schedules set end_time='08:00'"),/constraint/i);
    await local.exec(`update public.accounts set status='inactive' where role='patient'`);
    assert.equal((await own(patient,'select * from public.treatment_schedules')).length,0);
    await local.exec(schema);
    assert.equal((await local.query('select * from public.treatment_schedules')).rows.length,2);
  } finally { await local.close(); }
});

test('NKF reference import preserves centre IDs, custom records and existing schedule references on rerun', async () => {
  const local = await databaseWithAuth();
  try {
    await local.exec(schema);
    const centres = (await local.query('select * from public.dialysis_centres order by id')).rows;
    assert.equal(centres.length,45);
    assert.equal(new Set(centres.map(c => c.postal_code)).size,45);
    for (const c of centres) { assert.match(c.postal_code,/^\d{6}$/); assert.ok(c.address.length); assert.ok(c.name.length); }
    await local.exec("insert into public.dialysis_centres(name,address,postal_code) values ('Custom Centre','Custom street','123456')");
    await local.exec(`insert into public.accounts(auth_user_id,email,display_name,role)
      values ('${patient}','patient@example.test','Patient','patient');
      insert into public.patients(account_id,full_name,phone,pickup_address,mobility,assistance_required,status)
      select id,'Patient','81234567','Test street','ambulant',false,'active' from public.accounts where role='patient';`);
    await local.query("select set_config('request.jwt.claim.sub',$1,false)",[patient]);
    await local.query(`insert into public.treatment_schedules(patient_id,centre_id,days,start_time,end_time,effective_from,effective_to)
      select id,$1::uuid,array[1],'09:00','13:00','2026-10-20','2026-12-31' from public.patients`,[centres[1].id]);
    const before=(await local.query('select id,centre_id from public.treatment_schedules')).rows;
    await local.exec(schema);
    assert.deepEqual((await local.query('select id,centre_id from public.treatment_schedules')).rows,before);
    assert.equal((await local.query('select * from public.dialysis_centres')).rows.length,46);
    assert.deepEqual((await local.query("select * from public.dialysis_centres where name<>'Custom Centre' order by id")).rows,centres);
    // A manually entered matching centre is adopted without replacing its UUID.
    const first=centres[0];
    const manual='99999999-9999-4999-8999-999999999999';
    await local.query('update public.dialysis_centres set id=$1 where id=$2',[manual,first.id]);
    await local.exec(schema);
    assert.equal((await local.query('select id from public.dialysis_centres where name=$1 and postal_code=$2',[first.name,first.postal_code])).rows[0].id,manual);
    assert.equal((await local.query('select * from public.dialysis_centres')).rows.length,46);
  } finally { await local.close(); }
});

test('single-day schedule upgrade preserves every old treatment day and is repeatable', async () => {
  const local=await databaseWithAuth();
  try {
    await local.exec(schema);
    await local.exec(`insert into public.accounts(auth_user_id,email,display_name,role)
      values ('${patient}','patient@example.test','Patient','patient');
      insert into public.patients(account_id,full_name,phone,pickup_address,mobility,assistance_required,status)
      select id,'Patient','81234567','Test street','ambulant',false,'active' from public.accounts where role='patient';
      alter table public.treatment_schedules drop constraint treatment_schedules_days_check;`);
    await local.query("select set_config('request.jwt.claim.sub',$1,false)",[patient]);
    const old=(await local.query(`insert into public.treatment_schedules(patient_id,centre_id,days,start_time,end_time,effective_from,effective_to)
      select p.id,c.id,array[1,3,5],'09:00','13:00','2026-10-20','2026-12-31' from public.patients p cross join public.dialysis_centres c limit 1 returning *`)).rows[0];
    await local.exec(schema);
    const rows=(await local.query('select * from public.treatment_schedules order by days')).rows;
    assert.deepEqual(rows.map(r=>r.days),[[1],[3],[5]]);
    assert.equal(rows[0].id,old.id);
    for(const r of rows) for(const key of ['patient_id','centre_id','start_time','end_time','effective_from','effective_to','created_at']) assert.deepEqual(r[key],old[key]);
    await assert.rejects(local.query('update public.treatment_schedules set days=array[2,4]'),/constraint/i);
    await local.exec(schema);
    assert.deepEqual((await local.query('select * from public.treatment_schedules order by days')).rows,rows);
  } finally { await local.close(); }
});

test('single sessions and recurring exceptions reject real conflicts and reschedule atomically', async () => {
  const local=await databaseWithAuth();
  try {
    await local.exec(schema);
    await local.exec(`insert into public.accounts(auth_user_id,email,display_name,role) values
      ('${patient}','patient@example.test','Patient','patient'),('${coordinator}','coordinator@example.test','Coordinator','coordinator'),
      ('${driver}','driver@example.test','Driver','driver');
      insert into public.patients(account_id,full_name,phone,pickup_address,mobility,assistance_required,status)
      select id,'Patient','81234567','Test street','ambulant',false,'active' from public.accounts where role='patient';`);
    const own=async (who,sql,params=[])=>{
      await local.exec('begin; set local role authenticated;');
      try {await local.query("select set_config('request.jwt.claim.sub',$1,true)",[who]);const r=await local.query(sql,params);await local.exec('commit');return r.rows;}
      catch(e){await local.exec('rollback');throw e;}
    };
    const ids=(await local.query('select p.id as patient,c.id as centre from public.patients p cross join public.dialysis_centres c limit 1')).rows[0];
    const insert=async (kind,date,day,start='09:00',end='13:00',parent=null,original=null)=>own(patient,
      `insert into public.treatment_schedules(patient_id,centre_id,kind,days,start_time,end_time,effective_from,effective_to,replaces_schedule_id,replaces_date)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
      [ids.patient,ids.centre,kind,[day],start,end,date,kind==='recurring'?'2026-12-31':date,parent,original]);
    const [series]=await insert('recurring','2026-10-19',1);
    await assert.rejects(insert('single','2026-10-26',1),/overlap/i);
    const [extra]=await insert('single','2026-10-27',2);
    await insert('single','2026-10-27',2,'13:00','14:00');
    await assert.rejects(insert('single','2026-10-27',2,'10:00','12:00',series.id,'2026-10-26'),/overlap/i);
    assert.equal((await own(patient,'select * from public.treatment_schedules where replaces_schedule_id is not null')).length,0);
    const [replacement]=await insert('single','2026-10-26',1,'10:00','14:00',series.id,'2026-10-26');
    await assert.rejects(insert('single','2026-10-26',1,'15:00','16:00',series.id,'2026-10-26'),/rescheduled|duplicate/i);
    await assert.rejects(insert('single','2026-11-02',1),/overlap/i);
    await assert.rejects(insert('single','2026-10-28',3,'09:00','13:00',series.id,'2026-10-27'),/occurrence/i);
    // Moving the replacement keeps its original exception and frees its former date.
    await own(patient,`update public.treatment_schedules set effective_from='2026-10-28',effective_to='2026-10-28',days=array[3] where id=$1`,[replacement.id]);
    // Overlap after an excluded week must still be detected in later weeks.
    await assert.rejects(insert('recurring','2026-10-26',1,'10:00','12:00'),/overlap/i);
    await insert('single','2026-10-26',1);
    await assert.rejects(own(patient,`update public.treatment_schedules set days=array[2] where id=$1`,[series.id]),/rescheduled|occurrence/i);
    await assert.rejects(own(patient,`update public.treatment_schedules set replaces_date='2026-11-02' where id=$1`,[replacement.id]),/permission/i);
    await assert.rejects(own(patient,`update public.treatment_schedules set kind='recurring' where id=$1`,[extra.id]),/type|kind/i);
    await assert.rejects(insert('single','2026-10-29',1),/constraint/i);
    assert.equal((await own(coordinator,'select * from public.treatment_schedules')).length,5);
    assert.equal((await own(driver,'select * from public.treatment_schedules')).length,0);
    // A patient's replacement cannot reference another patient's recurring schedule.
    await local.exec(`insert into public.accounts(auth_user_id,email,display_name,role) values ('${stranger}','stranger@example.test','Other Patient','patient');
      insert into public.patients(account_id,full_name,phone,pickup_address,mobility,assistance_required,status)
      select id,'Other Patient','81234567','Other street','ambulant',false,'active' from public.accounts where auth_user_id='${stranger}';`);
    const [otherSeries]=await own(stranger,`insert into public.treatment_schedules(patient_id,centre_id,days,start_time,end_time,effective_from,effective_to)
      select p.id,$1,array[4],'09:00','13:00','2026-10-19','2026-12-31' from public.patients p returning *`,[ids.centre]);
    await assert.rejects(insert('single','2026-10-29',4,'09:00','13:00',otherSeries.id,'2026-10-29'),/occurrence/i);
    assert.equal((await own(patient,'select * from public.treatment_schedules where id=$1',[otherSeries.id])).length,0);
    const before=(await local.query('select * from public.treatment_schedules order by id')).rows;
    await local.exec(schema);
    assert.deepEqual((await local.query('select * from public.treatment_schedules order by id')).rows,before);
  } finally {await local.close();}
});
