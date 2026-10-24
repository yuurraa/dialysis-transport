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
    { forUser: () => ({ from: () => query, rpc: async (_name: string,args: {details: unknown}) => { saved=args.details; return query.maybeSingle(); } }) } as unknown as SupabaseService);
  await service.saveTreatment('Bearer fixture',details);
  assert.equal((saved as Record<string,unknown>).patient_id,'owned-patient');
  assert.ok(filters.some(([key,value]) => key==='account_id' && value==='trusted-account'));
  await service.saveTreatment('Bearer fixture',{...details,version:1},details.centre_id);
  // Updates use the owner-checked versioned database RPC.

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
    setAutoGeneration: async (header: string,id: string,body: unknown)=>{calls.push({header,id,body});return {enabled:true,version:1};},
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
    assert.equal((await fetch(`${origin}/api/schedules/${details.centre_id}/auto-generation`,{method:'PATCH',headers,body:JSON.stringify({enabled:true,version:1,setting_version:0})})).status,200);
    assert.equal(calls.length,5);
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
  for (const denied of ['coordinator', 'driver', 'caregiver']) { role = denied; await assert.rejects(service.deleteTreatment('Bearer fixture', details.centre_id,{version:1}), /denied/); }
  role = 'patient'; status = 'inactive';
  await assert.rejects(service.deleteTreatment('Bearer fixture', details.centre_id,{version:1}), /denied/);
  status = 'active';
  await assert.rejects(service.deleteTreatment('Bearer fixture', 'bad-id'), /Invalid schedule/);
  assert.equal(calls.length, 0);
  assert.deepEqual(await service.deleteTreatment('Bearer fixture', details.centre_id,{version:1}), { id: details.centre_id });
  assert.deepEqual(calls, [['delete_my_treatment', { target: details.centre_id, expected_version:1 }]]);
  result = { data: null, error: null };
  await assert.rejects(service.deleteTreatment('Bearer fixture', details.centre_id,{version:1}), /not found/);
  result = { data: null, error: { code: '23P01' } };
  await assert.rejects(service.deleteTreatment('Bearer fixture', details.centre_id,{version:1}), /overlap/);
});


test('schedule reads validate filters and paginate search in the database before returning results', async () => {
  const calls: unknown[]=[];
  const service=new SchedulingService(
    {verifyIdentity:async()=>({account:{role:'coordinator',status:'active'}})} as unknown as AuthService,
    {forUser:()=>({rpc:async(...args:unknown[])=>{calls.push(args);return {data:{schedules:[],total:26,page:2,pageSize:10},error:null};}})} as unknown as SupabaseService);
  assert.equal((await service.treatments('Bearer fixture','2','  Monday  ')).page,2);
  assert.deepEqual(calls,[['list_treatments',{search_text:'Monday',page_no:2,kind_filter:'all',centre_filter:'all',sort_by:'effective_from',sort_order:'asc'}]]);
  for(const [page,search] of [['0',''],['1.5',''],['1000001',''],['1','x'.repeat(101)],['1','\n']]) await assert.rejects(service.treatments('Bearer fixture',page,search),/Invalid/);
});

test('schedule mutations require versions and surface stale conflicts', async () => {
  const service=new SchedulingService(
    {verifyIdentity:async()=>({account:{id:'fixture',role:'patient',status:'active'}})} as unknown as AuthService,
    {forUser:()=>({from:()=>({select(){return this;},eq(){return this;},maybeSingle:async()=>({data:{id:'owned'},error:null})}),rpc:async()=>({data:null,error:{code:'40001'}})})} as unknown as SupabaseService);
  await assert.rejects(service.saveTreatment('Bearer fixture',details,details.centre_id),/version/);
  await assert.rejects(service.deleteTreatment('Bearer fixture',details.centre_id),/version/);
  await assert.rejects(service.saveTreatment('Bearer fixture',{...details,version:1},details.centre_id),error => (error as {status:number}).status===409);
  await assert.rejects(service.deleteTreatment('Bearer fixture',details.centre_id,{version:1}),error => (error as {status:number}).status===409);
});

test('trip reads and generation enforce active account roles before database access', async () => {
  let role='patient'; let status='active'; let accountPresent=true; let verified=0;
  const service=new TripsService(
    {verifyIdentity:async()=>{verified++;return {account:accountPresent?{role,status}:null};}} as unknown as AuthService,
    {forUser:()=>({rpc:async()=>({data:{trips:[]},error:null})})} as unknown as SupabaseService);
  await assert.rejects(service.listTrips(),error=>(error as {status:number}).status===401);
  for(const denied of ['driver','caregiver']) {role=denied;await assert.rejects(service.listTrips('Bearer fixture'),error=>(error as {status:number}).status===403);}
  role='patient'; await assert.rejects(service.generateTrips('Bearer fixture',{}),error=>(error as {status:number}).status===403);
  status='inactive'; await assert.rejects(service.listTrips('Bearer fixture'),error=>(error as {status:number}).status===403);
  status='active';accountPresent=false;await assert.rejects(service.listTrips('Bearer fixture'),error=>(error as {status:number}).status===403);
  accountPresent=true;await service.listTrips('Bearer fixture');role='coordinator';await service.listTrips('Bearer fixture');
  assert.equal(verified,7);
});

test('trip searches validate real dates and optional end dates and default to Singapore today onwards', async context => {
  context.mock.timers.enable({apis:['Date'],now:new Date('2026-10-20T17:00:00Z')});
  const calls:unknown[]=[];
  const service=new TripsService(
    {verifyIdentity:async()=>({account:{role:'patient',status:'active'}})} as unknown as AuthService,
    {forUser:()=>({rpc:async(...args:unknown[])=>{calls.push(args);return {data:{trips:[],total:0},error:null};}})} as unknown as SupabaseService);
  assert.deepEqual(await service.listTrips('Bearer fixture'),{trips:[],total:0});
  await service.listTrips('Bearer fixture','2','2028-02-29','2028-05-28','at-risk');
  assert.deepEqual(calls,[['list_trips',{page_no:1,from_date:'2026-10-21',until_date:null,status_filter:'all',search_text:'',direction_filter:'all',sort_by:'treatment_start',sort_order:'asc'}],['list_trips',{page_no:2,from_date:'2028-02-29',until_date:'2028-05-28',status_filter:'at-risk',search_text:'',direction_filter:'all',sort_by:'treatment_start',sort_order:'asc'}]]);
  await service.listTrips('Bearer fixture','2','2028-02-29','2028-05-28','unfilled,at-risk');
  assert.deepEqual(calls.at(-1), ['list_trips',{page_no:2,from_date:'2028-02-29',until_date:'2028-05-28',status_filter:'unfilled,at-risk',search_text:'',direction_filter:'all',sort_by:'treatment_start',sort_order:'asc'}]);
  for(const [page,from,until,status] of [
    ['0','2026-10-20','2026-10-20','all'],['1.5','2026-10-20','2026-10-20','all'],['1000001','2026-10-20','2026-10-20','all'],
    ['1','2026-02-30','2026-03-01','all'],['1','0000-01-01','0000-01-02','all'],['1','2026-10-21','2026-10-20','all'],
    ['1','2028-02-29','2028-02-30','all'],['1','2026-1-01','2026-01-02','all'],['1','2026-10-20','2026-10-20','unknown'],
    ...['', 'all,unfilled', 'unfilled,unknown', 'unfilled,', ',at-risk', 'unfilled\n', 'unfilled,at-risk,on-track,resolved,unfilled'].map(status => ['1','2026-10-20','2026-10-20',status]),
  ]) await assert.rejects(service.listTrips('Bearer fixture',page,from,until,status),error=>(error as {status:number}).status===400);
  assert.equal(calls.length,3);
  await service.listTrips('Bearer fixture','1','2028-02-29','','all');
  assert.deepEqual(calls.at(-1),['list_trips',{page_no:1,from_date:'2028-02-29',until_date:null,status_filter:'all',search_text:'',direction_filter:'all',sort_by:'treatment_start',sort_order:'asc'}]);
  await service.listTrips('Bearer fixture','1','2028-02-29','2029-12-31','all');
  assert.deepEqual((calls.at(-1) as [string,{until_date:string}])[1].until_date,'2029-12-31');

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

test('trip search and direction are validated and sent to the database before pagination', async () => {
  const calls:unknown[]=[];
  const service=new TripsService(
    {verifyIdentity:async()=>({account:{role:'patient',status:'active'}})} as unknown as AuthService,
    {forUser:()=>({rpc:async(...args:unknown[])=>{calls.push(args);return {data:{trips:[],total:0},error:null};}})} as unknown as SupabaseService);
  await service.listTrips('Bearer fixture','2','2090-01-01','2090-01-02','all','  Fixture  ','return');
  assert.deepEqual(calls,[['list_trips',{page_no:2,from_date:'2090-01-01',until_date:'2090-01-02',status_filter:'all',search_text:'Fixture',direction_filter:'return',sort_by:'treatment_start',sort_order:'asc'}]]);
  for(const [search,direction] of [['x'.repeat(101),'all'],['bad\nsearch','all'],['bad\u007fsearch','all'],['','other']]) {
    await assert.rejects(service.listTrips('Bearer fixture','1','2090-01-01','2090-01-02','all',search,direction),error=>(error as {status:number}).status===400);
  }
  assert.equal(calls.length,1);
});

test('trip deletion requires an active coordinator and a strict versioned trip command', async () => {
  let role='patient';let status='active';let present=true;const calls:unknown[]=[];
  const service=new TripsService(
    {verifyIdentity:async()=>({account:present?{role,status}:null})} as unknown as AuthService,
    {forUser:()=>({rpc:async(...args:unknown[])=>{calls.push(args);return {data:details.centre_id,error:null};}})} as unknown as SupabaseService);
  await assert.rejects(service.deleteTrip(undefined,details.centre_id,{version:1}),error=>(error as {status:number}).status===401);
  for(const denied of ['patient','driver','caregiver']) {role=denied;await assert.rejects(service.deleteTrip('Bearer fixture',details.centre_id,{version:1}),error=>(error as {status:number}).status===403);}
  role='coordinator';status='inactive';await assert.rejects(service.deleteTrip('Bearer fixture',details.centre_id,{version:1}),error=>(error as {status:number}).status===403);
  status='active';present=false;await assert.rejects(service.deleteTrip('Bearer fixture',details.centre_id,{version:1}),error=>(error as {status:number}).status===403);present=true;
  for(const body of [null,undefined,[],{}, {version:0},{version:1.5},{version:'1'},{version:2147483648},{version:1,patient_id:'other'}]) await assert.rejects(service.deleteTrip('Bearer fixture',details.centre_id,body),error=>(error as {status:number}).status===400);
  await assert.rejects(service.deleteTrip('Bearer fixture','invalid',{version:1}),error=>(error as {status:number}).status===400);
  assert.equal(calls.length,0);
  assert.deepEqual(await service.deleteTrip('Bearer fixture',details.centre_id,{version:3}),{id:details.centre_id});
  assert.deepEqual(calls,[['delete_trip',{target:details.centre_id,expected_version:3}]]);
});

test('trip deletion HTTP route maps database failures and search filters without allowing patient deletion', async () => {
  let role='coordinator';let code:string|undefined;const calls:unknown[]=[];
  const service=new TripsService(
    {verifyIdentity:async()=>({account:{role,status:'active'}})} as unknown as AuthService,
    {forUser:()=>({rpc:async(...args:unknown[])=>{calls.push(args);return {data:details.centre_id,error:code?{code}:null};}})} as unknown as SupabaseService);
  @Module({controllers:[TripsController],providers:[{provide:TripsService,useValue:service}]}) class TestModule {}
  const app=await NestFactory.create(TestModule,{logger:false});app.setGlobalPrefix('api');await app.listen(0,'127.0.0.1');
  try {
    const origin=await app.getUrl();const headers={Authorization:'Bearer fixture','Content-Type':'application/json'};
    assert.equal((await fetch(`${origin}/api/trips?from=2090-01-01&until=2090-01-02&search=%20Fixture%20&direction=outbound`,{headers})).status,200);
    assert.deepEqual(calls.shift(),['list_trips',{page_no:1,from_date:'2090-01-01',until_date:'2090-01-02',status_filter:'all',search_text:'Fixture',direction_filter:'outbound',sort_by:'treatment_start',sort_order:'asc'}]);
    for(const query of ['search=a&search=b','direction=outbound&direction=return']) assert.equal((await fetch(`${origin}/api/trips?${query}`,{headers})).status,400);
    const remove=()=>fetch(`${origin}/api/trips/${details.centre_id}`,{method:'DELETE',headers,body:JSON.stringify({version:2})});
    const success=await remove();assert.equal(success.status,200);assert.deepEqual(await success.json(),{id:details.centre_id});
    assert.deepEqual(calls.shift(),['delete_trip',{target:details.centre_id,expected_version:2}]);
    for(const [errorCode,status] of [['42501',403],['40001',409],['22023',400],['23514',400],['22P02',400],['P0002',404],['unknown',503]] as const) {code=errorCode;assert.equal((await remove()).status,status);}
    role='patient';assert.equal((await remove()).status,403);
  } finally {await app.close();}
});

test('list services forward validated sort and filter choices', async () => {
  const calls: unknown[] = [];
  const auth = { verifyIdentity: async () => ({ account: { role: 'coordinator', status: 'active' } }) } as unknown as AuthService;
  const database = { forUser: () => ({ rpc: async (...args: unknown[]) => { calls.push(args); return { data: {}, error: null }; } }) } as unknown as SupabaseService;
  const schedules = new SchedulingService(auth, database);
  const trips = new TripsService(auth, database);
  await schedules.treatments('Bearer fixture', '2', '', 'recurring', 'all', 'start_time', 'desc');
  assert.deepEqual(calls.pop(), ['list_treatments', { search_text: '', page_no: 2, kind_filter: 'recurring', centre_filter: 'all', sort_by: 'start_time', sort_order: 'desc' }]);
  await trips.listTrips('Bearer fixture', '2', '2026-10-21', '2026-11-20', 'all', '', 'return', 'patient_name', 'desc');
  assert.deepEqual(calls.pop(), ['list_trips', { page_no: 2, from_date: '2026-10-21', until_date: '2026-11-20', status_filter: 'all', search_text: '', direction_filter: 'return', sort_by: 'patient_name', sort_order: 'desc' }]);
  for (const until of [undefined, '']) {
    await trips.listTrips('Bearer fixture', '2', '2026-10-21', until, 'all', '', 'return', 'patient_name', 'desc');
    assert.deepEqual(calls.pop(), ['list_trips', { page_no: 2, from_date: '2026-10-21', until_date: null, status_filter: 'all', search_text: '', direction_filter: 'return', sort_by: 'patient_name', sort_order: 'desc' }]);
  }
  await schedules.treatments('Bearer fixture', '1', '', 'recurring,rescheduled');
  assert.equal((calls.pop() as [string, { kind_filter: string }])[1].kind_filter, 'recurring,rescheduled');
  await trips.listTrips('Bearer fixture', '1', '2026-10-21', '2026-10-21', 'all', '', 'outbound,return');
  assert.equal((calls.pop() as [string, { direction_filter: string }])[1].direction_filter, 'outbound,return');
  for (const kind of ['', 'recurring,unknown', 'all,single', 'single,']) await assert.rejects(schedules.treatments('Bearer fixture', '1', '', kind), /Invalid/);
  for (const direction of ['', 'outbound,unknown', 'all,return', 'outbound,']) await assert.rejects(trips.listTrips('Bearer fixture', '1', '2026-10-21', '2026-10-21', 'all', '', direction), /Invalid/);
  await assert.rejects(schedules.treatments('Bearer fixture', '1', '', 'unknown'), /Invalid/);
  await assert.rejects(schedules.treatments('Bearer fixture', '1', '', 'all', 'invalid'), /Invalid/);
  await assert.rejects(trips.listTrips('Bearer fixture', '1', '2026-10-21', '2026-10-21', 'all', '', 'all', 'notes'), /Invalid/);
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
