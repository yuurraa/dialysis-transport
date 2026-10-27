import 'reflect-metadata';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AuthController } from '../src/auth/auth.controller';
import { AuthService } from '../src/auth/auth.service';
import { SupabaseService } from '../src/supabase.module';
import { DemoService } from '../src/demo/demo.module';
import type { TripsService } from '../src/trips/trips.service';

const account = { id: '11111111-1111-4111-8111-111111111111', auth_user_id: 'user', email: 'person@example.test', display_name: 'Test Person', role: 'patient', status: 'active' };
const profile = { full_name: 'Test Patient', birth_date: '1990-04-12', gender: 'female', phone: '+65 81234567', pickup_address: 'Test street', postal_code: '560123', mobility: 'ambulant', assistance_required: false };
let current: typeof account | null = null;
let dbFailure = false;
let authFailure: number | undefined | null = null;
const gateway = {
  forUser: (token: string) => ({
    auth: { getUser: async () => authFailure !== null ? { data: { user: null }, error: { code: 'unexpected_failure', status: authFailure } } : token !== 'invalid' ? { data: { user: { id: 'user', email: 'person@example.test', email_confirmed_at: token === 'unverified' ? null : '2026-01-01', identities: token === 'email-only' ? [] : [{ provider: 'google' }], user_metadata: { role: 'coordinator' } } }, error: null } : { data: { user: null }, error: { code: 'bad_jwt', status: 401 } } },
    rpc: async (name: string, args?: Record<string, unknown>) => {
      if (dbFailure) return { data: null, error: { code: 'XX000', message: 'PRIVATE_DATABASE_DETAIL' } };
      if (name === 'current_account') return { data: current, error: null };
      if (name === 'register_account' || name === 'register_patient_account' || name === 'register_driver_account' || name==='register_caregiver_account') {
        if (current) return { data: null, error: { code: '23505' } };
        current = { ...account, role: name === 'register_patient_account' ? 'patient' : name === 'register_driver_account' ? 'driver' : name==='register_caregiver_account'?'caregiver':String(args?.requested_role), display_name: String(args?.requested_name) };
      }
      return { data: current, error: null };
    },
  }),
};
@Module({ controllers: [AuthController], providers: [AuthService, { provide: SupabaseService, useValue: gateway }] })
class TestModule {}
let app: Awaited<ReturnType<typeof NestFactory.create>>;
let origin: string;
before(async () => { app = await NestFactory.create(TestModule, { logger: false }); app.setGlobalPrefix('api'); await app.listen(0, '127.0.0.1'); origin = await app.getUrl(); });
after(async () => { await app?.close(); });
async function request(path: string, method = 'GET', body?: unknown, token = 'valid') {
  const response = await fetch(`${origin}/api/auth${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
test('requires a verified session and returns persisted account separately from identity metadata', async () => {
  assert.equal((await request('/me', 'GET', undefined, 'invalid')).status, 401);
  for (const token of ['email-only', 'unverified']) {
    assert.equal((await request('/me', 'GET', undefined, token)).status, 403);
    assert.equal((await request('/register', 'POST', { role: 'patient', displayName: 'Test' }, token)).status, 403);
  }
  current = null;
  const result = await request('/me');
  assert.equal(result.status, 200);
  assert.equal(result.body.account, null);
  assert.equal(result.body.role, undefined);
  const previous=process.env.DEMO_ENABLED;
  let role='coordinator',status='active',demo_admin=false;
  const calls:unknown[]=[];
  const service=new DemoService({verifyIdentity:async()=>({account:{id:account.id,role,status,demo_admin}})} as unknown as AuthService,
    {forIntegration:()=>({rpc:async(name:string,args:unknown)=>{calls.push([name,args]);return {data:{actors:[],scenario:null,trip:null},error:null};}})} as unknown as SupabaseService,{} as TripsService);
  try {
    process.env.DEMO_ENABLED='false';await assert.rejects(service.state('Bearer fixture'));assert.equal(calls.length,0);
    process.env.DEMO_ENABLED='true';await assert.rejects(service.state('Bearer fixture'));assert.equal(calls.length,0);
    demo_admin=true;
    for(const invalid of ['patient','driver','caregiver']){role=invalid;await assert.rejects(service.state('Bearer fixture'));}
    role='coordinator';status='inactive';await assert.rejects(service.state('Bearer fixture'));assert.equal(calls.length,0);
    status='active';await service.state('Bearer fixture');
    assert.deepEqual(calls,[['demo_manage',{owner:account.id,action:'state',details:{}}]]);
    await assert.rejects(service.switchActor('Bearer fixture',{account_id:account.id}));
    await assert.rejects(service.control('Bearer fixture',{action:'move',percent:101}));
    await assert.rejects(service.control('Bearer fixture',{action:'reset',owner_id:account.id,confirmed:true}));
  } finally {if(previous===undefined)delete process.env.DEMO_ENABLED;else process.env.DEMO_ENABLED=previous;}
});
test('registration validates public roles, privilege fields and complete personal profiles', async () => {
  for (const body of [{ role: 'coordinator', displayName: 'Someone' }, { role: 'patient', displayName: '' }, { role: 'driver', displayName: 'Test', status: 'approved' }, { role: 'caregiver', displayName: 42 }, { role: ['patient'], displayName: 'Test' }]) {
    assert.equal((await request('/register', 'POST', body)).status, 400);
  }
  current=null;
  const personal={full_name:profile.full_name,phone:profile.phone,birth_date:profile.birth_date,gender:profile.gender};
  for(const details of [undefined,{...personal,role:'coordinator'},{...personal,gender:''}])assert.equal((await request('/register','POST',{role:'caregiver',displayName:'Caregiver',...(details?{profile:details}:{})})).status,400);
  const registered=await request('/register','POST',{role:'caregiver',displayName:'Caregiver',profile:personal});
  assert.equal(registered.status,201);assert.equal(registered.body.role,'caregiver');
  current=null;
});

test('temporary identity-provider failures return 503 without treating the session as invalid', async () => {
  try {
    for (const status of [undefined, 0, 408, 429, 500, 503]) {
      authFailure = status;
      for (const [path, method, body] of [['/me', 'GET', undefined], ['/register', 'POST', { role: 'patient', displayName: 'Test' }]] as const) {
        const result = await request(path, method, body);
        assert.equal(result.status, 503);
        assert.doesNotMatch(JSON.stringify(result.body), /Invalid or expired|unexpected_failure/);
      }
    }
  } finally { authFailure = null; }
});
