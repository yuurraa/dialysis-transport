import 'reflect-metadata';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ProfilesController } from '../src/profiles/profiles.controller';
import { ProfilesService } from '../src/profiles/profiles.service';
import { AuthService } from '../src/auth/auth.service';
import { SupabaseService } from '../src/infrastructure/database/supabase.module';

const id = '11111111-1111-4111-8111-111111111111';
let role = 'coordinator';
let status = 'active';
let failure = false;
let conflict = false;
let linkFailure:string|undefined;
let missing = false;
let writes = 0;
let saved: unknown;
let driverVersion: number | undefined;
let filters = '';
let equalities: Array<[string, unknown]> = [];
let orders: Array<[string, boolean]> = [];
let bounds: number[] = [];
const record = { id, version: 1, full_name: 'Test Patient', birth_date: '1990-04-12', gender: 'female', phone: '81234567', pickup_address: 'Test address', mobility: 'wheelchair', assistance_required: true, status: 'active' };
const gateway = { forUser: () => ({
  auth: { getUser: async (token: string) => token === 'invalid' ? { data: { user: null }, error: { status: 401 } } : { data: { user: { id, email_confirmed_at: '2026-01-01', identities: [{ provider: 'google' }] } }, error: null } },
  rpc: async (name: string, args?: { details: unknown; expected_version?: number }) => {
    if(name==='manage_caregiver_link'&&linkFailure)return {data:null,error:{code:linkFailure}};
    if (name === 'update_my_driver') driverVersion = args?.expected_version;
    if (name === 'update_my_driver' || name === 'save_my_patient' || name === 'save_patient' || name === 'save_my_driver') { writes++; saved = args?.details; return { data: { ...record, ...(saved as object), account_id: id }, error: conflict ? { code: 'PT409' } : missing ? { code: 'P0002' } : null }; }
    return { data: { id, role, status }, error: null };
  },
  from: () => {
    filters = ''; orders = []; bounds = []; equalities = [];
    let writing = false;
    const result = () => ({ data: missing ? null : writing ? { ...record, ...(saved as object) } : [record], count: 1, error: failure ? { code: 'XX000', message: 'PRIVATE_DETAIL' } : null });
    const query = {
      select: () => query, or: (value: string) => { filters = value; return query; }, order: (column: string, options?: { ascending: boolean }) => { orders.push([column, options?.ascending ?? true]); return query; }, range: (from: number, to: number) => { bounds = [from, to]; return Promise.resolve(result()); }, eq: (key: string, value: unknown) => { equalities.push([key, value]); return query; }, in: (key: string, values: unknown[]) => { equalities.push([key, values]); return query; },
      insert: (body: unknown) => { writes++; writing = true; saved = body; return query; },
      update: (body: unknown) => { writes++; writing = true; saved = body; return query; },
      single: async () => result(), maybeSingle: async () => ({ ...result(), data: missing ? null : { ...record, ...(writing ? saved as object : {}), account_id: id } }),
    };
    return query;
  },
}) };
@Module({ controllers: [ProfilesController], providers: [ProfilesService, AuthService, { provide: SupabaseService, useValue: gateway }] })
class TestModule {}
let app: Awaited<ReturnType<typeof NestFactory.create>>;
let origin: string;
before(async () => { app = await NestFactory.create(TestModule, { logger: false }); app.setGlobalPrefix('api'); await app.listen(0, '127.0.0.1'); origin = await app.getUrl(); });
after(async () => { await app?.close(); });
async function request(path = '', method = 'GET', body?: unknown, token: string | null = 'valid') {
  const response = await fetch(`${origin}/api/profiles/patients${path}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
async function caregiverRequest(path='',method='GET',body?:unknown){return fetch(`${origin}/api/profiles/caregivers${path}`,{method,headers:{Authorization:'Bearer valid','Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});}
test('patient endpoints require an active coordinator and verified session', async () => {
  for (const token of [null, 'invalid']) assert.equal((await request('', 'GET', undefined, token)).status, 401);
  for (const other of ['patient', 'driver', 'caregiver']) {
    role = other;
    assert.equal((await request()).status, 403);
    assert.equal((await request('', 'POST', record)).status, 404);
    assert.equal((await request(`/${id}`, 'PATCH', record)).status, 403);
    assert.equal((await caregiverRequest()).status,403);
    assert.equal((await caregiverRequest(`/${id}/links`)).status,403);
    assert.equal((await caregiverRequest(`/${id}`,'PATCH',{status:'inactive',version:1})).status,403);
  }
  role = 'coordinator'; status = 'inactive';
  assert.equal((await request()).status, 403);
  status = 'active';
  assert.equal(writes, 0);
  const linking=async(path:string,body?:unknown)=>fetch(`${origin}/api/profiles/${path}`,{method:'POST',headers:{Authorization:'Bearer valid','Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  for(const other of ['patient','driver','coordinator']){
    role=other;assert.equal((await linking('caregiver-invitations')).status,403);
  }
  role='caregiver';
  assert.equal((await linking('caregiver-invitations/preview',{code:id})).status,403);
  role='patient';
  for(const body of [{code:'bad'},{code:id,caregiver_id:id},{code:id,role:'coordinator'}])assert.equal((await linking('caregiver-invitations/preview',body)).status,400);
  assert.equal((await linking('caregiver-invitations/confirm',{code:id,caregiver_id:id,confirmed:false})).status,400);
  const unauthorised=await fetch(`${origin}/api/profiles/caregiver-links`,{method:'PATCH',headers:{Authorization:'Bearer valid','Content-Type':'application/json'},body:JSON.stringify({patient_id:id,caregiver_id:id,active:true,patient_authorised:true})});
  assert.equal(unauthorised.status,403);
  role='coordinator';
  assert.equal((await caregiverRequest()).status,200);
  assert.equal((await caregiverRequest(`/${id}/links`)).status,200);
  for(const query of ['?page=0','?sort=email','?status=deleted','?direction=sideways'])assert.equal((await caregiverRequest(query)).status,400);
  for(const body of [{status:'inactive',version:1,full_name:'Changed'},{status:'inactive',version:0},{status:'deleted',version:1}])assert.equal((await caregiverRequest(`/${id}`,'PATCH',body)).status,400);
  for(const [dbCode,code] of [['P5001','patient_link_limit'],['P5002','caregiver_link_limit']]){
    linkFailure=dbCode;
    const response=await fetch(`${origin}/api/profiles/caregiver-links`,{method:'PATCH',headers:{Authorization:'Bearer valid','Content-Type':'application/json'},body:JSON.stringify({patient_id:id,caregiver_id:id,active:true,patient_authorised:true})});
    assert.equal(response.status,409);assert.equal((await response.json()).code,code);
  }
  linkFailure=undefined;
});
test('coordinators may update only Status and Notes, never create or overwrite personal details', async () => {
  assert.equal((await request('', 'POST', record)).status, 404);
  const result = await request(`/${id}`, 'PATCH', { status: 'inactive', notes: 'Call coordinator.', version: 1 });
  assert.equal(result.status, 200);
  assert.deepEqual(saved, { status: 'inactive', notes: 'Call coordinator.', version: 1 });
  const before = writes;
  for (const body of [{ full_name: 'Changed' }, { phone: '87654321' }, { pickup_address: 'Changed' }, { mobility: 'ambulant' }, { assistance_required: false }, { unit_no: '#01-01' }, { postal_code: '123456' }, { account_id: id }, { status: 'deleted' }, { notes: 'x'.repeat(1001) }, {}]) {
    assert.equal((await request(`/${id}`, 'PATCH', { ...body, version: 1 })).status, 400);
  }
  assert.equal(writes, before);
  assert.equal((await request('/not-an-id', 'PATCH', { status: 'active' })).status, 400);
});

async function selfRequest(method = 'GET', body?: unknown, token = 'valid') {
  const response = await fetch(`${origin}/api/profiles/patient`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
test('patients read and save only their own profile without accepting ownership or status', async () => {
  role = 'patient';
  const { id: unused, status: ignored, ...details } = record;
  missing = true;
  assert.equal((await selfRequest()).body.patient, null);
  missing = false;
  assert.equal((await selfRequest()).body.patient.account_id, id);
  assert.equal((await selfRequest('PATCH', details)).body.account_id, id);
  for (const phone of ['+0 81234567', '+1234 81234567', '+65 8123456', '+65 812345678', '+44 abc12345', '+123 1234567890123']) assert.equal((await selfRequest('PATCH', { ...details, phone })).status, 400);
  assert.equal((await selfRequest('PATCH', { ...details, phone: '+44 2071234567' })).status, 200);
  const extended = await selfRequest('PATCH', { ...details, unit_no: '#05-12', postal_code: '560123', notes: 'Call on arrival.' });
  assert.equal(extended.status, 200);
  assert.equal(extended.body.notes, 'Call on arrival.');
  for (const extra of [{ postal_code: 'abc' }, { unit_no: 12 }, { notes: 'x'.repeat(1001) }, { status: 'active' }, { account_id: id }, { id }, { role: 'coordinator' }]) assert.equal((await selfRequest('PATCH', { ...details, ...extra })).status, 400);
  assert.equal((await selfRequest('PATCH', { ...details, phone: '+65 1234567' })).status, 400);
  for (const other of ['coordinator', 'caregiver', 'driver']) {
    role = other;
    assert.equal((await selfRequest()).status, 403);
    assert.equal((await selfRequest('PATCH', details)).status, 403);
  }
  role = 'patient'; status = 'inactive';
  assert.equal((await selfRequest()).status, 403);
  status = 'active';
  assert.equal((await selfRequest('GET', undefined, 'invalid')).status, 401);
  role = 'coordinator';
});
