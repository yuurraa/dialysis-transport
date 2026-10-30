import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OneMapService } from '../src/integrations/onemap/onemap.service';
import { LtaService, type TrafficSnapshot } from '../src/integrations/lta/lta.service';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseService } from '../src/infrastructure/database/supabase.module';
import { TripRoutingService, type RoadRoute } from '../src/trips/routing/trip-routing.service';
import { routeTraffic } from '../src/trips/traffic/route-traffic';

test('OneMap validates provider responses, caches authentication and refuses ambiguous addresses', async context => {
  const previousEmail=process.env.ONEMAP_EMAIL,previousPassword=process.env.ONEMAP_PASSWORD;
  process.env.ONEMAP_EMAIL='routing@example.test';process.env.ONEMAP_PASSWORD='fixture-only';
  context.after(()=>{if(previousEmail===undefined)delete process.env.ONEMAP_EMAIL;else process.env.ONEMAP_EMAIL=previousEmail;if(previousPassword===undefined)delete process.env.ONEMAP_PASSWORD;else process.env.ONEMAP_PASSWORD=previousPassword;});
  let tokenRequests=0;let invalid=false;let ambiguous=false;let hold=false;let release:(()=>void)|undefined;
  context.mock.method(globalThis,'fetch',async(input:string|URL,options?:RequestInit)=>{
    const url=new URL(String(input));
    if(url.pathname.endsWith('/getToken')){tokenRequests++;assert.equal(options?.method,'POST');if(hold)return new Promise<Response>(resolve=>{release=()=>resolve(Response.json({access_token:'fixture-token',expiry_timestamp:Math.floor(Date.now()/1000)+3600}));});return Response.json({access_token:'fixture-token',expiry_timestamp:Math.floor(Date.now()/1000)+3600});}
    assert.equal((options?.headers as Record<string,string>).Authorization,'fixture-token');
    if(url.pathname.endsWith('/search'))return Response.json({totalNumPages:1,results:[{ADDRESS:'Fixture location',POSTAL:'123456',LATITUDE:'1.3',LONGITUDE:'103.8'},...(ambiguous?[{ADDRESS:'Other location',POSTAL:'123456',LATITUDE:'1.4',LONGITUDE:'103.9'}]:[])]});
    return Response.json(invalid?{error:'Provider failed'}:{status:0,route_geometry:'_||F_mpxRgEgE',route_summary:{total_distance:2500,total_time:901}});
  });
  const service=new OneMapService();
  const origin=await service.resolveAddress('Fixture street, Singapore 123456');
  assert.deepEqual(origin,{latitude:1.3,longitude:103.8});
  const route=await service.getRoute(origin,{latitude:1.301,longitude:103.801});
  assert.equal(route.durationSeconds,901);assert.equal(route.distanceMetres,2500);assert.equal(route.geometry.length,2);
  assert.equal(tokenRequests,1);
  invalid=true;await assert.rejects(service.getRoute(origin,{latitude:1.301,longitude:103.801}));
  ambiguous=true;await assert.rejects(service.resolveAddress('Fixture street, Singapore 123456'));
  hold=true;
  const fresh=new OneMapService();const authentication=fresh.getAccessToken();
  const deadline=new AbortController();const waiting=fresh.getAccessToken(deadline.signal);deadline.abort();
  await assert.rejects(waiting);release!();await authentication;
  delete process.env.ONEMAP_EMAIL;delete process.env.ONEMAP_PASSWORD;
  await assert.rejects(new OneMapService().getAccessToken());
});


test('LTA publishes only complete validated feeds and shares refreshes without sharing caller cancellation', async context => {
  const previous=process.env.LTA_ACCOUNT_KEY;
  process.env.LTA_ACCOUNT_KEY='fixture-only';
  context.after(()=>{if(previous===undefined)delete process.env.LTA_ACCOUNT_KEY;else process.env.LTA_ACCOUNT_KEY=previous;});
  const incident={Type:'Heavy Traffic',Latitude:1.3,Longitude:103.8,Message:'Fixture congestion'};
  const speed={LinkID:'123',RoadName:'Fixture road',SpeedBand:2,MinimumSpeed:'10',MaximumSpeed:'19',StartLat:1.3,StartLon:103.8,EndLat:1.301,EndLon:103.801};
  const requests:string[]=[];
  let malformed=false,large=false,fail=false,hold=false,quota=false,release:(()=>void)|undefined;
  context.mock.method(globalThis,'fetch',async(input:string|URL,options?:RequestInit)=>{
    const url=new URL(String(input));requests.push(url.pathname+url.search);
    assert.equal(url.origin,'https://datamall2.mytransport.sg');
    assert.equal((options?.headers as Record<string,string>).AccountKey,'fixture-only');
    assert.equal(options?.redirect,'error');
    if(fail)return new Response('private provider diagnostics',{status:503});
    if(hold)return new Promise<Response>(resolve=>{release=()=>resolve(Response.json({value:[]}));});
    if(url.pathname.endsWith('/TrafficIncidents'))return Response.json({value:url.searchParams.get('$skip')==='0'?Array.from({length:500},()=>incident):[incident]});
    if(quota)return Response.json({fault:{faultstring:'Private account identifier',detail:{errorcode:'policies.ratelimit.QuotaViolation'}}},{status:500});
    if(large)return Response.json({value:Number(url.searchParams.get('$skip'))<=50000?Array.from({length:500},()=>speed):[]});
    return Response.json({value:[{...speed,...(malformed?{MinimumSpeed:''}:{})},{...speed,LinkID:'open-ended',SpeedBand:8,MinimumSpeed:70,MaximumSpeed:999},{...speed,LinkID:'no-observation',SpeedBand:0,MinimumSpeed:'',MaximumSpeed:''}]});
  });
  const service=new LtaService();
  const [first,second]=await Promise.all([service.getTraffic(),service.getTraffic()]);
  assert.equal(first.incidents.length,501);assert.equal(first.speedBands[0].minimumSpeedKmh,10);assert.equal(first.speedBands.length,2);
  assert.deepEqual(second,first);assert.equal(requests.length,3);
  assert.equal(Reflect.set(first.incidents,'length',0),false);
  assert.equal(Reflect.set(first.speedBands[0].start,'latitude',0),false);
  assert.equal(second.speedBands,first.speedBands,'Concurrent assessments share immutable feed rows instead of copying the island-wide feed.');
  assert.equal((await service.getTraffic()).incidents.length,501);
  assert.equal(requests.length,3);
  large=true;assert.equal((await new LtaService().getSpeedBands()).length,50500);large=false;
  quota=true;
  const limited=new LtaService(),partial=await limited.getTraffic(undefined,true);
  assert.equal(partial.incidents.length,501);assert.equal(partial.speedBands.length,0);
  assert.equal(partial.speedBandsRetrievedAt,null);assert.deepEqual(partial.availability,{incidents:'current',speeds:'rate-limited'});
  const afterQuota=requests.length;
  await assert.rejects(limited.getTraffic());
  await limited.getTraffic(undefined,true);assert.equal(requests.length,afterQuota);
  quota=false;
  const realNow=Date.now;let elapsed=300001;
  context.mock.method(Date,'now',()=>realNow()+elapsed);
  assert.equal((await limited.getTraffic()).speedBands.length,2);
  assert.ok(requests.length>afterQuota);elapsed=0;
  malformed=true;await assert.rejects(new LtaService().getTraffic());
  fail=true;await assert.rejects(new LtaService().getIncidents(),error=>{
    assert.ok(error instanceof Error);assert.ok(!error.message.includes('private provider'));return true;
  });
  fail=false;hold=true;
  const shared=new LtaService(),waiting=shared.getIncidents();
  const deadline=new AbortController(),cancelled=shared.getIncidents(deadline.signal);
  deadline.abort();await assert.rejects(cancelled);
  release!();assert.deepEqual(await waiting,[]);
  hold=false;delete process.env.LTA_ACCOUNT_KEY;
  await assert.rejects(new LtaService().getTraffic());
});


test('Route traffic preserves observed coverage and shows roads for future/unassigned/ended trips without forecasting arrivals', async () => {
  const route={geometry:[[1.3,103.8],[1.3,103.81]] as [number,number][],distanceMetres:1112,durationSeconds:120,encodedPolyline:''};
  const forward={linkId:'forward',roadName:'Fixture road',speedBand:2,minimumSpeedKmh:10,maximumSpeedKmh:19,start:{latitude:1.3001,longitude:103.8},end:{latitude:1.3001,longitude:103.805}};
  const reverse={...forward,linkId:'reverse',start:forward.end,end:forward.start};
  const snapshot:TrafficSnapshot={incidents:[{latitude:1.3,longitude:103.802,type:'Obstacle',message:'Fixture obstacle'},{latitude:1.4,longitude:103.9,type:'Roadwork',message:'Unrelated work'}],speedBands:[forward,reverse],retrievedAt:new Date().toISOString(),incidentsRetrievedAt:new Date().toISOString(),speedBandsRetrievedAt:new Date().toISOString()};
  const result=routeTraffic(route,snapshot);
  assert.equal(result.incidents.length,1);assert.deepEqual(result.speed_bands.map(road=>road.linkId),['forward']);
  assert.ok(result.speed_bands[0].route_geometry.length>0);
  assert.ok(result.speed_bands[0].route_geometry.every(piece=>piece.length>=2&&piece.every(([latitude])=>latitude===1.3)));
  assert.ok(result.coverage_percent>40&&result.coverage_percent<65);
  assert.equal(result.slow_route_percent,result.coverage_percent);
  assert.ok(result.minimum_seconds>120);assert.ok(result.maximum_seconds!>result.minimum_seconds);
  const unrelated=Array.from({length:2000},(_,index)=>({...forward,linkId:`unrelated-${index}`,start:{latitude:1.4,longitude:103.9},end:{latitude:1.401,longitude:103.901}}));
  assert.deepEqual(routeTraffic(route,{...snapshot,speedBands:[...unrelated,...snapshot.speedBands]}),result,'Island-wide observations outside the route must not affect its assessment.');
  const crossing={...forward,linkId:'crossing',start:{latitude:1.3001,longitude:103.79},end:{latitude:1.3001,longitude:103.82}};
  assert.equal(routeTraffic(route,{...snapshot,speedBands:[crossing]}).coverage_percent,100,'A matching link remains eligible when its endpoints lie beyond the route bounds.');
  const stopped=routeTraffic(route,{...snapshot,speedBands:[{...forward,minimumSpeedKmh:0,maximumSpeedKmh:9,speedBand:1}]});
  assert.equal(stopped.maximum_seconds,null);
  const missing=routeTraffic(route,{...snapshot,speedBands:[reverse]});
  assert.equal(missing.coverage_percent,0);assert.equal(missing.minimum_seconds,120);
  const boundary=routeTraffic({...route,geometry:[[1.3,103.8],[1.3,103.809],[1.30102,103.809]]},{...snapshot,speedBands:[{...forward,end:{latitude:1.3001,longitude:103.809}}]});
  assert.equal(boundary.coverage_percent,90);assert.ok(boundary.coverage_fraction<.9);
  const saved={...route,origin:'Fixture home',destination:'Fixture centre',origin_coordinates:forward.start,destination_coordinates:forward.end,distance_metres:route.distanceMetres,duration_seconds:route.durationSeconds};
  let trip={id:'fixture-trip',version:1,origin:saved.origin,destination:saved.destination,route_snapshot:null as RoadRoute|null,lifecycle:'scheduled',assigned_driver_id:'fixture-driver' as string|null,pickup_at:new Date(Date.now()+5*86400000).toISOString() as string|null,dropoff_at:null,arrival_by:new Date(Date.now()+5*86400000+1800000).toISOString()};
  const chain={select(){return this;},eq(){return this;},is(){return this;},abortSignal(){return this;},async maybeSingle(){return {data:trip,error:null};}};
  const client={from:()=>chain,rpc:()=>({abortSignal:async()=>({data:{trip},error:null})})} as unknown as SupabaseClient;
  let feedReads=0;
  let routeReads=0;
  const database={forIntegration:()=>({rpc:()=>{routeReads++;return {abortSignal:async()=>({data:saved,error:null})};}})} as unknown as SupabaseService;
  let observations=snapshot;
  const lta={getTraffic:async()=>{feedReads++;return observations;}} as unknown as LtaService;
  const service=new TripRoutingService(database,{} as OneMapService,lta);
  for(const lifecycle of ['scheduled','cancelled','completed']){
    trip={...trip,lifecycle};
    const current=await service.traffic(client,trip.id);
    assert.equal(current.state,'current');
    assert.ok('assessment_scope' in current&&current.assessment_scope==='road-conditions');
    assert.ok('estimated_arrival_from' in current&&current.estimated_arrival_from===null);
    assert.ok('speed_bands' in current&&current.speed_bands.length>0);
    assert.ok('baseline_arrival_at' in current&&current.baseline_arrival_at===null);
    assert.ok('delay_from_minutes' in current&&typeof current.delay_from_minutes==='number');
  }
  trip={...trip,lifecycle:'scheduled',assigned_driver_id:null,pickup_at:null};
  assert.equal((await service.traffic(client,trip.id)).state,'current');
  const lookups=routeReads;
  trip={...trip,route_snapshot:{...saved,provider:'onemap',duration_minutes:5,assessed_at:new Date().toISOString()}};
  await service.traffic(client,trip.id);
  assert.equal(routeReads,lookups,'A fresh matching reservation route needs no cache RPC.');
  trip={...trip,route_snapshot:{...trip.route_snapshot!,assessed_at:new Date(Date.now()-86400001).toISOString()}};
  await service.traffic(client,trip.id);
  assert.equal(routeReads,lookups+1,'An expired reservation route must use the normal cache/provider path.');
  trip={...trip,route_snapshot:null};
  observations={...snapshot,speedBands:[],speedBandsRetrievedAt:null,availability:{incidents:'current',speeds:'rate-limited'}};
  const incidentOnly=await service.traffic(client,trip.id);
  assert.equal(incidentOnly.state,'current');
  assert.ok('incidents' in incidentOnly&&incidentOnly.incidents.length===1);
  assert.ok('availability' in incidentOnly&&incidentOnly.availability.speeds==='rate-limited');
  assert.ok('delay_from_minutes' in incidentOnly&&incidentOnly.delay_from_minutes===null);
  assert.ok('impact' in incidentOnly&&incidentOnly.impact==='unknown');
  assert.ok('risk' in incidentOnly&&incidentOnly.risk==='possible-delay');
  observations=snapshot;
  const before=feedReads;
  assert.equal((await service.traffic(client,trip.id,true)).state,'unassigned');
  trip={...trip,assigned_driver_id:'fixture-driver',pickup_at:new Date(Date.now()+5*86400000).toISOString()};
  assert.equal((await service.traffic(client,trip.id,true)).state,'not_due');
  assert.equal(feedReads,before);

  // A background proposal is reused without provider calls or booking approval.
  const proposal={trip:{...trip,version:7},options:[{id:'proposal-1'}],critical:false};
  const recoveryCalls:string[]=[];
  const recoveryDatabase={forIntegration:()=>({rpc:(name:string)=>({abortSignal:async()=>{
    recoveryCalls.push(name);
    if(name==='trip_traffic_context')return {data:{trip:{...trip,version:7,status:'at-risk',review_required:false}},error:null};
    if(name==='pending_trip_recovery_options')return {data:proposal,error:null};
    throw new Error(`Unexpected recovery mutation: ${name}`);
  }})})} as unknown as SupabaseService;
  const recovering=new TripRoutingService(recoveryDatabase,{} as OneMapService,lta);
  assert.deepEqual(await recovering.automaticRecovery(trip.id,7),proposal);
  assert.deepEqual(recoveryCalls,['trip_traffic_context','pending_trip_recovery_options']);
  assert.equal(feedReads,before);
  await assert.rejects(recovering.automaticRecovery(trip.id,6),/changed/i);

  // A zero lower speed bound reserves an explicitly approximate slot, not a false finite ETA.
  observations={...snapshot,speedBands:[{...forward,minimumSpeedKmh:0,maximumSpeedKmh:9,speedBand:1}]};
  const eligibleTrip={...trip,status:'at-risk',review_required:false};
  const recoveryClient={from:()=>({...chain,async maybeSingle(){return {data:eligibleTrip,error:null};}})} as unknown as SupabaseClient;
  let stored:Record<string,unknown>|undefined;
  const approximateDatabase={forIntegration:()=>({rpc:(name:string,args:Record<string,unknown>)=>({abortSignal:async()=>{
    if(name==='pending_trip_recovery_options')return {data:null,error:null};
    if(name==='cached_driving_route')return {data:saved,error:null};
    if(name==='trip_traffic_context')return {data:{trip:eligibleTrip},error:null};
    if(name==='trip_recovery_candidates')return {data:{requirements:[],options:[]},error:null};
    if(name==='store_assessed_trip_recovery_options'){stored=args;return {data:{options:[],critical:true},error:null};}
    if(name==='trip_recovery_option')return {data:{option:{trip_id:trip.id,trip_version:trip.version,driver_id:trip.assigned_driver_id,pickup_at:trip.pickup_at,duration_minutes:360,expires_at:new Date(Date.now()+60000).toISOString(),estimated_duration:false}},error:null};
    throw new Error(`Unexpected recovery RPC: ${name}`);
  }})})} as unknown as SupabaseService;
  const approximate=new TripRoutingService(approximateDatabase,{} as OneMapService,lta);
  await approximate.recoveryOptions(recoveryClient,trip.id,trip.version);
  assert.equal(stored?.estimated_duration,true);assert.equal(stored?.buffer_minutes,15);
  assert.equal(stored?.reserved_minutes,Math.max(5,Math.ceil(Math.max(saved.duration_seconds,stopped.minimum_seconds)/300)*5)+15);
  // A previously bounded proposal must be reassessed before approving newly uncertain traffic.
  await assert.rejects(approximate.approveRecovery(recoveryClient,trip.id,trip.version,'bounded-proposal'),/Traffic changed/i);
  observations={...snapshot,speedBands:[]};stored=undefined;
  await assert.rejects(approximate.recoveryOptions(recoveryClient,trip.id,trip.version),/current route and usable traffic/i);
  assert.equal(stored,undefined);
});
