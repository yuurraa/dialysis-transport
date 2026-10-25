import 'reflect-metadata';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Module, UnauthorizedException } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AvailabilityController } from '../src/drivers/availability.controller';
import { AvailabilityService } from '../src/drivers/availability.service';
import { DriversController } from '../src/drivers/drivers.controller';
import { DriversService } from '../src/drivers/drivers.service';
import { AuthService } from '../src/auth/auth.service';
import { SupabaseService } from '../src/supabase.module';

const id = '33333333-3333-4333-8333-333333333333';
let role = 'driver'; let status = 'active'; let failure: string | null = null;
let calls: { name: string; args?: Record<string, unknown> }[] = [];
let ownership: unknown;
const vehicle = { licence_number:'MOCK123', plate_number:'TEST123', make:'Fixture', model:'Car', passenger_capacity:3, wheelchair_accessible:false, version:null };
const gateway = { forUser: () => ({
  rpc: async (name: string,args?: Record<string,unknown>) => {
    calls.push({name,args});
    return {data: name === 'list_drivers' ? {drivers:[],total:0,page:1,pageSize:10} : name === 'save_driver_status' ? {id,account_status:args?.new_status,status_version:Number(args?.expected_version)+1} : {...vehicle,version:1,status:'pending'},error:failure ? {code:failure,message:'PRIVATE_DETAIL'} : null};
  },
  from: () => {
    const query = {select: () => query,eq: (key: string,value: unknown) => {ownership=[key,value];return query;},maybeSingle:async () => ({data:null,error:failure ? {code:failure} : null})};
    return query;
  },
})};
@Module({controllers:[AvailabilityController,DriversController],providers:[AvailabilityService,DriversService,{provide:SupabaseService,useValue:gateway},{provide:AuthService,useValue:{verifyIdentity:async (token: string) => {
  if(token==='invalid') throw new UnauthorizedException();
  return {account:{id,role,status}};
}}}]})
class TestModule {}
let app: Awaited<ReturnType<typeof NestFactory.create>>; let origin: string;
before(async () => {app=await NestFactory.create(TestModule,{logger:false});app.setGlobalPrefix('api');await app.listen(0,'127.0.0.1');origin=await app.getUrl();});
after(async () => {await app?.close();});
async function request(path='',method='GET',body?:unknown,token:string|null='valid') {
  const response=await fetch(`${origin}/api/drivers${path}`,{method,headers:{...(token ? {Authorization:`Bearer ${token}`} : {}),'Content-Type':'application/json'},body:body===undefined ? undefined : JSON.stringify(body)});
  return {status:response.status,body:await response.json()};
}
test('driver and coordinator endpoints enforce active roles before database access',async () => {
  for(const token of [null,'invalid']) assert.equal((await request('/me','GET',undefined,token)).status,401);
  for(const other of ['patient','caregiver','coordinator']) {
    role=other;assert.equal((await request('/me')).status,403);assert.equal((await request('/me/vehicle','POST',vehicle)).status,403);
  }
  role='driver';assert.equal((await request()).status,403);assert.equal((await request(`/${id}/review`,'PATCH',{version:1,decision:'approved',reason:''})).status,403);
  status='inactive';assert.equal((await request('/me')).status,403);status='active';
  assert.equal(calls.length,0);
  assert.equal((await request('/me')).status,200);assert.deepEqual(ownership,['driver_id',id]);
});
test('coordinator reviews require an explicit decision, version and rejection reason',async () => {
  role='coordinator';calls=[];
  for(const body of [{version:1,decision:'rejected',reason:' '},{version:1,decision:'pending',reason:''},{version:0,decision:'approved',reason:''},{version:1,decision:'approved',reason:'',driver_id:id}]) {
    assert.equal((await request(`/${id}/review`,'PATCH',body)).status,400);
  }
  assert.equal(calls.length,0);
  assert.equal((await request(`/${id}/review`,'PATCH',{version:2,decision:'rejected',reason:' Correct details '})).status,200);
  assert.deepEqual(calls[0],{name:'review_driver_vehicle',args:{target:id,expected_version:2,decision:'rejected',reason:'Correct details'}});
  failure='40001';assert.equal((await request(`/${id}/review`,'PATCH',{version:1,decision:'approved',reason:''})).status,409);failure=null;
  for(const query of ['page=0','status=unknown','search='+'x'.repeat(101),'status=pending&status=approved','sort=licence_number','direction=sideways','sort=id&sort=full_name']) assert.equal((await request('?'+query)).status,400);
  assert.equal((await request('?page=2&status=not-submitted&search=Fixture&sort=full_name&direction=asc')).status,200);
  assert.deepEqual(calls.at(-1),{name:'list_drivers',args:{page_no:2,search_text:'Fixture',status_filter:'not-submitted',sort_by:'full_name',sort_order:'asc'}});
  failure='XX000';const unavailable=await request();assert.equal(unavailable.status,503);assert.doesNotMatch(JSON.stringify(unavailable.body),/PRIVATE_DETAIL/);failure=null;
});

test('availability routes enforce active driver ownership and validate bounded weekly slots',async () => {
  calls=[];failure=null;status='active';
  const body={weekly_slots:[10,11,335],version:0};
  for(const token of [null,'invalid']) assert.equal((await request('/me/availability','GET',undefined,token)).status,401);
  for(const other of ['patient','coordinator','caregiver']) {role=other;assert.equal((await request('/me/availability')).status,403);assert.equal((await request('/me/availability','PATCH',body)).status,403);}
  role='driver';status='inactive';assert.equal((await request('/me/availability')).status,403);status='active';
  assert.equal(calls.length,0);
  for(const extra of [{driver_id:id},{version:-1},{weekly_slots:[336]},{weekly_slots:[10,10]},{weekly_slots:[null]},{exceptions:[]}]) assert.equal((await request('/me/availability','PATCH',{...body,...extra})).status,400);
  assert.equal(calls.length,0);
  assert.equal((await request('/me/availability','PATCH',body)).status,200);
  assert.deepEqual(calls[0],{name:'save_my_availability',args:{slots:body.weekly_slots,expected_version:0}});
  assert.equal((await request('/me/availability')).status,200);assert.equal(calls.at(-1)?.name,'get_my_availability');
  const monday=new Date(Date.now()+8*3600000);monday.setUTCDate(monday.getUTCDate()+1-(monday.getUTCDay()||7));
  const week=monday.toISOString().slice(0,10);
  assert.equal((await request(`/${id}/week?start=${week}`)).status,403);
  assert.equal((await request(`/me/week?start=${week}`)).status,200);
  assert.deepEqual(calls.at(-1),{name:'get_driver_week',args:{target:id,week_start:week}});
  assert.equal((await request('/me/availability','PATCH',{...body,week_start:week,template_version:0})).status,200);
  assert.equal(calls.at(-1)?.name,'save_my_week_availability');
  role='coordinator';
  for(const start of ['bad','2026-02-30','2026-10-27']) assert.equal((await request(`/${id}/week?start=${start}`)).status,400);
  assert.equal((await request(`/${id}/week?start=${week}`)).status,200);
  assert.deepEqual(calls.at(-1),{name:'get_driver_week',args:{target:id,week_start:week}});
});
