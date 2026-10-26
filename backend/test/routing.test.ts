import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OneMapService } from '../src/integrations/onemap.service';
import { LtaService, type TrafficSnapshot } from '../src/integrations/lta.service';
import { routeTraffic } from '../src/trips/route-traffic';

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
  let malformed=false,fail=false,hold=false,release:(()=>void)|undefined;
  context.mock.method(globalThis,'fetch',async(input:string|URL,options?:RequestInit)=>{
    const url=new URL(String(input));requests.push(url.pathname+url.search);
    assert.equal(url.origin,'https://datamall2.mytransport.sg');
    assert.equal((options?.headers as Record<string,string>).AccountKey,'fixture-only');
    assert.equal(options?.redirect,'error');
    if(fail)return new Response('private provider diagnostics',{status:503});
    if(hold)return new Promise<Response>(resolve=>{release=()=>resolve(Response.json({value:[]}));});
    if(url.pathname.endsWith('/TrafficIncidents'))return Response.json({value:url.searchParams.get('$skip')==='0'?Array.from({length:500},()=>incident):[incident]});
    return Response.json({value:[{...speed,...(malformed?{MinimumSpeed:''}:{})},{...speed,LinkID:'open-ended',SpeedBand:8,MinimumSpeed:70,MaximumSpeed:999}]});
  });
  const service=new LtaService();
  const [first,second]=await Promise.all([service.getTraffic(),service.getTraffic()]);
  assert.equal(first.incidents.length,501);assert.equal(first.speedBands[0].minimumSpeedKmh,10);
  assert.deepEqual(second,first);assert.equal(requests.length,3);
  first.incidents.length=0;
  assert.equal((await service.getTraffic()).incidents.length,501);
  assert.equal(requests.length,3);
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


test('Route traffic uses nearby forward links, preserves uncovered baseline and leaves stopped traffic unbounded', () => {
  const route={geometry:[[1.3,103.8],[1.3,103.81]] as [number,number][],distanceMetres:1112,durationSeconds:120,encodedPolyline:''};
  const forward={linkId:'forward',roadName:'Fixture road',speedBand:2,minimumSpeedKmh:10,maximumSpeedKmh:19,start:{latitude:1.3,longitude:103.8},end:{latitude:1.3,longitude:103.805}};
  const reverse={...forward,linkId:'reverse',start:forward.end,end:forward.start};
  const snapshot:TrafficSnapshot={incidents:[{latitude:1.3,longitude:103.802,type:'Obstacle',message:'Fixture obstacle'},{latitude:1.4,longitude:103.9,type:'Roadwork',message:'Unrelated work'}],speedBands:[forward,reverse],retrievedAt:new Date().toISOString(),incidentsRetrievedAt:new Date().toISOString(),speedBandsRetrievedAt:new Date().toISOString()};
  const result=routeTraffic(route,snapshot);
  assert.equal(result.incidents.length,1);assert.deepEqual(result.speed_bands.map(road=>road.linkId),['forward']);
  assert.ok(result.coverage_percent>40&&result.coverage_percent<65);
  assert.ok(result.minimum_seconds>120);assert.ok(result.maximum_seconds!>result.minimum_seconds);
  const stopped=routeTraffic(route,{...snapshot,speedBands:[{...forward,minimumSpeedKmh:0,maximumSpeedKmh:9,speedBand:1}]});
  assert.equal(stopped.maximum_seconds,null);
  const missing=routeTraffic(route,{...snapshot,speedBands:[reverse]});
  assert.equal(missing.coverage_percent,0);assert.equal(missing.minimum_seconds,120);
});
