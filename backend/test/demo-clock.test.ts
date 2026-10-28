import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tripNow as backendNow } from '../src/trips/trip-clock';
import { tripNow as frontendNow } from '../../frontend/src/lib/tripClock';
import { TripRoutingService } from '../src/trips/trip-routing.service';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { SupabaseService } from '../src/supabase.module';
import type { OneMapService } from '../src/integrations/onemap.service';
import type { LtaService } from '../src/integrations/lta.service';

for(const [name,clock] of [['backend',backendNow],['frontend',frontendNow]] as const) {
  test(`${name} clock isolates real trips and advances only an activated demo`,()=>{
    const real=Date.parse('2026-10-28T09:40:00Z');
    const fixture={demo_owner_id:'fixture-owner',demo_clock_at:'2026-10-29T00:30:00Z',demo_clock_started_at:null};
    assert.equal(clock({},real),real);
    assert.equal(clock({...fixture,demo_owner_id:null},real),real);
    assert.equal(clock(fixture,real),Date.parse(fixture.demo_clock_at));
    assert.equal(clock({...fixture,demo_clock_started_at:'2026-10-28T09:39:00Z'},real),Date.parse(fixture.demo_clock_at)+60000);
    assert.equal(clock({...fixture,demo_clock_started_at:'2026-10-28T09:41:00Z'},real),Date.parse(fixture.demo_clock_at));
    assert.equal(clock({...fixture,demo_clock_at:'invalid'},real),real);
  });
}

test('demo traffic calculates arrivals on simulated time while freshness expires on real time',async()=>{
  const previous=process.env.DEMO_ENABLED;process.env.DEMO_ENABLED='true';
  try {
    const real=Date.now(),simulated=Date.parse('2026-10-29T00:30:00Z');
    const trip={id:'fixture',version:1,demo_owner_id:'fixture-owner',demo_clock_at:new Date(simulated).toISOString(),demo_clock_started_at:new Date(real).toISOString(),
      origin:'Fixture home',destination:'Fixture centre',lifecycle:'in-progress',assigned_driver_id:'fixture-driver',pickup_at:new Date(simulated).toISOString(),
      route_snapshot:{geometry:[[1.3,103.8],[1.31,103.81]],duration_seconds:1800,distance_metres:10000}};
    const chain={select(){return this;},eq(){return this;},is(){return this;},abortSignal(){return this;},async maybeSingle(){return {data:trip,error:null};}};
    const client={from:()=>chain} as unknown as SupabaseClient;
    const database={forIntegration:()=>({rpc:()=>({abortSignal:async()=>({data:{traffic:'delay',progress:50},error:null})})})} as unknown as SupabaseService;
    const service=new TripRoutingService(database,{} as OneMapService,{} as LtaService);
    const result=await service.traffic(client,trip.id);
    assert.ok('estimated_arrival_from' in result&&result.estimated_arrival_from);
    assert.ok(Math.abs(Date.parse(result.estimated_arrival_from)-(simulated+30*60000))<2000);
    assert.ok('estimate_expires_at' in result&&Date.parse(result.estimate_expires_at)>real);
    assert.ok('assessed_at' in result&&Math.abs(Date.parse(result.assessed_at)-real)<2000);
  } finally {if(previous===undefined)delete process.env.DEMO_ENABLED;else process.env.DEMO_ENABLED=previous;}
});
