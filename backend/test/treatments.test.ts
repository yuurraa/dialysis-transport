import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { treatmentInput } from '../src/scheduling/treatment-input';
import { SchedulingService } from '../src/scheduling/scheduling.service';
import type { AuthService } from '../src/auth/auth.service';
import type { SupabaseService } from '../src/supabase.module';
const details = { centre_id: '77777777-7777-4777-8777-777777777777', days: [1], start_time: '09:00', end_time: '13:00', effective_from: '2026-10-20', effective_to: '2026-12-31' };
test('treatment input rejects malformed, conflicting and ownership fields', () => {
  assert.deepEqual(treatmentInput(details).days,[1]);
  for (const body of [null, {}, { ...details, days: [] }, { ...details, days: [1,3] }, { ...details, days: [1,1] }, { ...details, days: [8] }, { ...details, end_time: '08:00' }, { ...details, start_time: '24:00' }, { ...details, effective_from: '2026-02-30' }, { ...details, effective_to: '2025-01-01' }, { ...details, patient_id: 'other' }]) assert.throws(() => treatmentInput(body));
});
test('treatment service rejects missing authentication, caregivers, drivers and coordinator writes', async () => {
  let role = 'driver'; let status = 'active';
  const auth = { verifyIdentity: async () => ({ account: { id: 'fixture', role, status } }) } as unknown as AuthService;
  const database = { forUser: () => { throw new Error('unauthorised database access'); } } as unknown as SupabaseService;
  const service = new SchedulingService(auth,database);
  await assert.rejects(service.treatments(),/Sign-in required/);
  for (const denied of ['driver','caregiver']) { role=denied; await assert.rejects(service.treatments('Bearer fixture'),/access denied/); }
  role='coordinator'; await assert.rejects(service.saveTreatment('Bearer fixture',details),/access denied/);
  role='patient'; status='inactive'; await assert.rejects(service.saveTreatment('Bearer fixture',details),/access denied/);
});
test('treatment writes derive the Patient from the session and constrain edits to that Patient', async () => {
  const filters: Array<[string,unknown]> = []; let saved: unknown; let fail = false;
  const query = {
    select: () => query, eq: (key: string,value: unknown) => { filters.push([key,value]); return query; },
    update: (body: unknown) => { saved=body; return query; },
    insert: (body: unknown) => { saved=body; return query; },
    maybeSingle: async () => ({ data: { id: 'owned-patient' }, error: fail ? { code: '23P01' } : null }),
  };
  const service = new SchedulingService(
    { verifyIdentity: async () => ({ account: { id: 'trusted-account', role: 'patient', status: 'active' } }) } as unknown as AuthService,
    { forUser: () => ({ from: () => query }) } as unknown as SupabaseService);
  await service.saveTreatment('Bearer fixture',details);
  assert.equal((saved as Record<string,unknown>).patient_id,'owned-patient');
  assert.ok(filters.some(([key,value]) => key==='account_id' && value==='trusted-account'));
  await service.saveTreatment('Bearer fixture',details,details.centre_id);
  assert.ok(filters.some(([key,value]) => key==='patient_id' && value==='owned-patient'));
  assert.ok(filters.some(([key,value]) => key==='id' && value===details.centre_id));
  assert.ok(!Object.hasOwn(saved as object,'patient_id'));
  fail=true;
  await assert.rejects(service.saveTreatment('Bearer fixture',details),/overlap/);
});

test('schedule HTTP routes use /api/schedules for reads and writes', async () => {
  const { Module } = await import('@nestjs/common');
  const { NestFactory } = await import('@nestjs/core');
  const { SchedulingController } = await import('../src/scheduling/scheduling.controller');
  const calls: unknown[]=[];
  @Module({controllers:[SchedulingController],providers:[{provide:SchedulingService,useValue:{
    deleteTreatment: async (header: string,id: string)=>{calls.push({header,id});return {id};},
    treatments: async (header: string)=>{calls.push(header);return {centres:[],schedules:[]};},
    saveTreatment: async (header: string,body: unknown,id?: string)=>{calls.push({header,body,id});return {id:id ?? 'new'};},
  }}]}) class TestModule {}
  const app=await NestFactory.create(TestModule,{logger:false});
  app.setGlobalPrefix('api');
  await app.listen(0,'127.0.0.1');
  try {
    const origin=await app.getUrl();
    const headers={Authorization:'Bearer fixture','Content-Type':'application/json'};
    assert.equal((await fetch(`${origin}/api/schedules`,{headers})).status,200);
    assert.equal((await fetch(`${origin}/api/schedules`,{method:'POST',headers,body:JSON.stringify(details)})).status,201);
    assert.equal((await fetch(`${origin}/api/schedules/${details.centre_id}`,{method:'PATCH',headers,body:JSON.stringify(details)})).status,200);
    assert.equal((await fetch(`${origin}/api/scheduling/treatments`,{headers})).status,404);
    assert.equal((await fetch(`${origin}/api/schedules/${details.centre_id}`,{method:'DELETE',headers})).status,200);
    assert.equal(calls.length,4);
    assert.equal(calls[0],'Bearer fixture');
  } finally {await app.close();}
});

test('single session input uses one date and rescheduling validates its source', () => {
  const single={kind:'single',centre_id:details.centre_id,session_date:'2026-10-27',start_time:'09:00',end_time:'13:00'};
  const parsed=treatmentInput(single);
  assert.equal(parsed.kind,'single');
  assert.deepEqual(parsed.days,[2]);
  assert.equal(parsed.effective_from,'2026-10-27');
  assert.equal(parsed.effective_to,'2026-10-27');
  for(const body of [{...single,session_date:'2026-02-30'},{...single,days:[1]},{...single,replaces_schedule_id:details.centre_id},{...single,replaces_date:'2026-10-26'},{...details,kind:'single'},{...details,kind:'other'}]) assert.throws(()=>treatmentInput(body));
  const replacement=treatmentInput({...single,replaces_schedule_id:details.centre_id,replaces_date:'2026-10-26'});
  assert.equal(replacement.replaces_schedule_id,details.centre_id);
});

test('schedule deletion verifies active patient access and calls the atomic owner operation', async () => {
  let role = 'patient'; let status = 'active'; let result: { data: unknown; error: { code: string } | null } = { data: details.centre_id, error: null };
  const calls: unknown[] = [];
  const service = new SchedulingService(
    { verifyIdentity: async () => ({ account: { role, status } }) } as unknown as AuthService,
    { forUser: () => ({ rpc: async (...args: unknown[]) => { calls.push(args); return result; } }) } as unknown as SupabaseService);
  await assert.rejects(service.deleteTreatment(undefined, details.centre_id), /Sign-in/);
  for (const denied of ['coordinator', 'driver', 'caregiver']) { role = denied; await assert.rejects(service.deleteTreatment('Bearer fixture', details.centre_id), /denied/); }
  role = 'patient'; status = 'inactive';
  await assert.rejects(service.deleteTreatment('Bearer fixture', details.centre_id), /denied/);
  status = 'active';
  await assert.rejects(service.deleteTreatment('Bearer fixture', 'bad-id'), /Invalid schedule/);
  assert.equal(calls.length, 0);
  assert.deepEqual(await service.deleteTreatment('Bearer fixture', details.centre_id), { id: details.centre_id });
  assert.deepEqual(calls, [['delete_my_treatment', { target: details.centre_id }]]);
  result = { data: null, error: null };
  await assert.rejects(service.deleteTreatment('Bearer fixture', details.centre_id), /not found/);
  result = { data: null, error: { code: '23P01' } };
  await assert.rejects(service.deleteTreatment('Bearer fixture', details.centre_id), /overlap/);
});
