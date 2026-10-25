import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { treatmentInput } from '../src/scheduling/treatment-input';
import { SchedulingService } from '../src/scheduling/scheduling.service';
import type { AuthService } from '../src/auth/auth.service';
import type { SupabaseService } from '../src/supabase.module';
import { TripsService } from '../src/trips/trips.service';
import { TripsController } from '../src/trips/trips.controller';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
const details = { centre_id: '77777777-7777-4777-8777-777777777777', days: [1], start_time: '09:00', end_time: '13:00', effective_from: '2026-10-20', effective_to: '2026-12-31' };
test('treatment input rejects malformed, conflicting and ownership fields', () => {
  assert.deepEqual(treatmentInput(details).days,[1]);
  for (const body of [null, {}, { ...details, days: [] }, { ...details, days: [1,3] }, { ...details, days: [1,1] }, { ...details, days: [8] }, { ...details, end_time: '08:00' }, { ...details, start_time: '24:00' }, { ...details, effective_from: '2026-02-30' }, { ...details, effective_to: '2025-01-01' }, { ...details, patient_id: 'other' }, { ...details, effective_from:'2026-10-20',effective_to:'2026-10-20' }]) assert.throws(() => treatmentInput(body));
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
  status='active';
  await assert.rejects(service.saveTreatment('Bearer fixture', { ...details, version: 1 }, details.centre_id), /coordinator approval/);
  await assert.rejects(service.deleteTreatment('Bearer fixture', details.centre_id, { version: 1 }), /coordinator approval/);
});

test('trip generation permits only bounded versioned coordinator commands and maps database failures', async context => {
  context.mock.timers.enable({apis:['Date'],now:new Date('2026-10-20T17:00:00Z')});
  const calls:unknown[]=[];let code:string|undefined;
  const service=new TripsService(
    {verifyIdentity:async()=>({account:{role:'coordinator',status:'active'}})} as unknown as AuthService,
    {forUser:()=>({rpc:async(...args:unknown[])=>{calls.push(args);return {data:{created:2,updated:0,unchanged:0,total:2},error:code?{code}:null};}})} as unknown as SupabaseService);
  const body={schedule_id:details.centre_id,from_date:'2026-10-21',until_date:'2026-10-21',version:1};
  for(const invalid of [null,{}, {...body,schedule_id:'bad'}, {...body,version:0},{...body,version:1.5},{...body,version:2147483648},{...body,patient_id:'other'},{...body,from_date:'2026-10-20'},{...body,until_date:'2027-01-19'},{...body,until_date:'2026-10-20'},{...body,until_date:'2026-02-30'}]) await assert.rejects(service.generateTrips('Bearer fixture',invalid),error=>(error as {status:number}).status===400);
  assert.equal(calls.length,0);
  assert.deepEqual(await service.generateTrips('Bearer fixture',body),{created:2,updated:0,unchanged:0,total:2});
  assert.deepEqual(calls,[['generate_treatment_trips',{target:details.centre_id,from_date:'2026-10-21',until_date:'2026-10-21',expected_version:1}]]);
  for(const [errorCode,status] of [['42501',403],['40001',409],['22023',400],['23514',400],['22P02',400],['P0002',404],['unknown',503]] as const) {
    code=errorCode;
    await assert.rejects(service.generateTrips('Bearer fixture',body),error=>(error as {status:number}).status===status);
    await assert.rejects(service.listTrips('Bearer fixture'),error=>(error as {status:number}).status===status);
  }
});

test('trip HTTP routes authenticate and map list filters and generation bodies into atomic RPC operations', async () => {
  const calls:unknown[]=[];
  const service=new TripsService(
    {verifyIdentity:async(token:string)=>{assert.equal(token,'fixture');return {account:{role:'coordinator',status:'active'}};}} as unknown as AuthService,
    {forUser:()=>({rpc:async(...args:unknown[])=>{calls.push(args);return {data:{created:2,total:2},error:null};}})} as unknown as SupabaseService);
  @Module({controllers:[TripsController],providers:[{provide:TripsService,useValue:service}]}) class TestModule {}
  const app=await NestFactory.create(TestModule,{logger:false});
  app.setGlobalPrefix('api');await app.listen(0,'127.0.0.1');
  try {
    const origin=await app.getUrl();
    const headers={Authorization:'Bearer fixture','Content-Type':'application/json'};
    assert.equal((await fetch(`${origin}/api/trips`)).status,401);
    assert.equal((await fetch(`${origin}/api/trips?page=2&from=2090-01-01&until=2090-01-01&status=unfilled`,{headers})).status,200);
    const response=await fetch(`${origin}/api/trips/generate`,{method:'POST',headers,body:JSON.stringify({schedule_id:details.centre_id,from_date:'2090-01-01',until_date:'2090-01-01',version:3})});
    assert.equal(response.status,201);assert.deepEqual(await response.json(),{created:2,total:2});
    assert.equal((await fetch(`${origin}/api/trips?from=2090-01-01&from=2090-01-02`,{headers})).status,400);
    assert.deepEqual(calls,[['list_trips',{page_no:2,from_date:'2090-01-01',until_date:'2090-01-01',status_filter:'unfilled',search_text:'',direction_filter:'all',sort_by:'treatment_start',sort_order:'asc'}],['generate_treatment_trips',{target:details.centre_id,from_date:'2090-01-01',until_date:'2090-01-01',expected_version:3}]]);
  } finally {await app.close();}
});

test('auto-generation settings require an active coordinator and versioned boolean input', async () => {
  let role = 'coordinator'; let status = 'active'; let error: { code: string } | null = null;
  const calls: unknown[] = [];
  const service = new SchedulingService(
    { verifyIdentity: async () => ({ account: { id: 'coordinator', role, status } }) } as unknown as AuthService,
    { forUser: () => ({ rpc: async (name: string, args: unknown) => { calls.push({ name, args }); return { data: { enabled: true, version: 1 }, error }; } }) } as unknown as SupabaseService);
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const input = { enabled: true, version: 1, setting_version: 0 };
  assert.deepEqual(await service.setAutoGeneration('Bearer fixture', id, input), { enabled: true, version: 1 });
  assert.deepEqual(calls[0], { name: 'set_treatment_auto_generation', args: { target: id, enabled: true, expected_version: 1, expected_setting_version: 0 } });
  for (const body of [null, {}, { ...input, enabled: 'true' }, { ...input, setting_version: -1 }, { ...input, actor: id }]) await assert.rejects(service.setAutoGeneration('Bearer fixture', id, body));
  for (const other of ['patient', 'driver', 'caregiver']) { role = other; await assert.rejects(service.setAutoGeneration('Bearer fixture', id, input), /access denied/i); }
  role = 'coordinator'; status = 'inactive'; await assert.rejects(service.setAutoGeneration('Bearer fixture', id, input), /access denied/i);
  status = 'active'; error = { code: '40001' }; await assert.rejects(service.setAutoGeneration('Bearer fixture', id, input), /changed/i);
});

test('schedule-change requests and decisions enforce roles, strict proposals and version conflicts', async () => {
  let role = 'patient'; let code: string | undefined;
  const calls: Array<[string, Record<string, unknown>]> = [];
  const service = new SchedulingService(
    { verifyIdentity: async () => ({ account: { id: 'trusted', role, status: 'active' } }) } as unknown as AuthService,
    { forUser: () => ({ rpc: async (name: string, args: Record<string, unknown>) => { calls.push([name,args]); return { data: { id: details.centre_id, status: name === 'review_treatment_change' ? args.decision : 'pending' }, error: code ? { code } : null }; } }) } as unknown as SupabaseService);
  const id = details.centre_id;
  const input = { action: 'update', details, reason: 'Appointment changed', version: 1 };
  await service.requestChange('Bearer fixture', id, input);
  assert.equal(calls[0][0], 'request_treatment_change');
  assert.equal(calls[0][1].expected_version, 1);
  assert.equal((calls[0][1].proposal as { kind: string }).kind, 'recurring');
  for (const body of [{ ...input, requested_by: id }, { ...input, version: 0 }, { ...input, reason: '' }, { ...input, action: 'approved' }, { ...input, action: 'delete' }, { ...input, details: { ...details, patient_id: id } }]) await assert.rejects(service.requestChange('Bearer fixture', id, body));
  await assert.rejects(service.reviewChange('Bearer fixture', id, { decision: 'approved', version: 1 }), /Coordinator/);
  role = 'driver'; await assert.rejects(service.requestChange('Bearer fixture', id, input), /denied/);
  role = 'coordinator'; await assert.rejects(service.requestChange('Bearer fixture', id, input), /denied/);
  await assert.rejects(service.reviewChange('Bearer fixture', id, { decision: 'rejected', version: 1, note: '' }), /reason/);
  await service.reviewChange('Bearer fixture', id, { decision: 'approved', version: 1 });
  assert.equal(calls.at(-1)?.[0], 'review_treatment_change');
  assert.equal(calls.at(-1)?.[1].note, '');
  code = '40001'; await assert.rejects(service.reviewChange('Bearer fixture', id, { decision: 'approved', version: 1 }), /changed/);
});
