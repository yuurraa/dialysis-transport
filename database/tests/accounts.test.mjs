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
    await assert.rejects(save(patient, { ...details, version: record.version }), error => error.code === '40001');
    assert.equal(updated.id, record.id);
    assert.equal(updated.phone, '87654321');
    assert.equal(updated.unit_no, '#05-12');
    assert.equal(updated.postal_code, '560123');
    assert.equal(updated.notes, 'Call on arrival.');
    const [{ patient: compatible }] = await save(patient, { ...details, version: updated.version });
    assert.equal(compatible.notes, 'Call on arrival.');
    await assert.rejects(act(coordinator, 'select public.save_patient($1,$2::jsonb)', [record.id, JSON.stringify({ notes: 'Stale coordinator', version: record.version })]), error => error.code === '40001');
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
    await race('profile changes block stale trip deletion', profileChange, deleteTrip(outboundId, outboundVersion), '40001', coordinator);
    const refreshedSourceVersion = tripVersion;
    const staleTripVersion = await checked(`select version from public.trips where id=${literal(outboundId)}`);
    await race('generation refresh blocks stale trip deletion', generate(refreshedSourceVersion), deleteTrip(outboundId, staleTripVersion), '40001', coordinator);
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
    await race('stale patient status', update('inactive', 'First coordinator'), update('active', 'Stale notes edit'), '40001', coordinator);
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
    assert.equal((await list(patient,ids.patient)).total,0);
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
