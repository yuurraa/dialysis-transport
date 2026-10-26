import { ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { OneMapService } from '../integrations/onemap.service';
import { SupabaseService } from '../supabase.module';
import type { Coordinates } from '../types';
import { LtaService } from '../integrations/lta.service';
import { routeTraffic } from './route-traffic';

export interface RoadRoute {
  origin:string; destination:string; provider:'onemap'; geometry:[number,number][];
  origin_coordinates:Coordinates; destination_coordinates:Coordinates;
  distance_metres:number; duration_seconds:number; duration_minutes:number; assessed_at:string;
}
interface RoutableTrip { id:string; version:number; origin:string; destination:string; duration_minutes:number; assigned_driver_id:string|null; route_snapshot:RoadRoute|null; lifecycle:string; pickup_at:string|null; dropoff_at:string|null; arrival_by:string|null }
const failed=()=>new ServiceUnavailableException({code:'route_unavailable',message:'Route assessment is unavailable.'});

@Injectable()
export class TripRoutingService {
  constructor(@Inject(SupabaseService) private readonly database:SupabaseService,@Inject(OneMapService) private readonly oneMap:OneMapService,@Inject(LtaService) private readonly lta:LtaService) {}

  private check(error:{code?:string}|null) {
    if(!error)return;
    if(error.code==='40001')throw new ConflictException('Trip changed. Reload before trying again.');
    throw failed();
  }

  private async trip(client:SupabaseClient,id:string,signal?:AbortSignal,monitor=false):Promise<RoutableTrip> {
    if(monitor){
      const query=client.rpc('trip_traffic_context',{target:id});
      const result=await (signal?query.abortSignal(signal):query);
      this.check(result.error);if(!result.data?.trip)throw new NotFoundException('Trip not found.');
      return result.data.trip as RoutableTrip;
    }
    const query=client.from('trips').select('*').eq('id',id).is('deleted_at',null);
    const result=await (signal?query.abortSignal(signal):query).maybeSingle();
    this.check(result.error);if(!result.data)throw new NotFoundException('Trip not found.');
    return result.data as RoutableTrip;
  }

  private async route(origin:string,destination:string,signal:AbortSignal):Promise<RoadRoute> {
    const integration=this.database.forIntegration();
    const cached=await integration.rpc('cached_driving_route',{origin_text:origin,destination_text:destination}).abortSignal(signal);
    this.check(cached.error);if(cached.data)return cached.data as RoadRoute;
    const [from,to]=await Promise.all([this.oneMap.resolveAddress(origin,signal),this.oneMap.resolveAddress(destination,signal)]);
    const route=await this.oneMap.getRoute(from,to,signal);
    const saved=await integration.rpc('cache_driving_route',{origin_text:origin,destination_text:destination,route_data:{
      origin_coordinates:from,destination_coordinates:to,geometry:route.geometry,
      distance_metres:route.distanceMetres,duration_seconds:route.durationSeconds,
    }}).abortSignal(signal);
    this.check(saved.error);if(!saved.data)throw failed();return saved.data as RoadRoute;
  }

  /** Patient/driver reads first prove trip access; an assigned reservation is never retimed here. */
  async view(client:SupabaseClient,id:string) {
    const trip=await this.trip(client,id);
    if(trip.route_snapshot&&trip.route_snapshot.origin===trip.origin&&trip.route_snapshot.destination===trip.destination) {
      return {route:trip.route_snapshot,reserved_minutes:trip.assigned_driver_id?trip.duration_minutes:null,saved:true};
    }
    try {
      return {route:await this.route(trip.origin,trip.destination,AbortSignal.timeout(5000)),reserved_minutes:trip.assigned_driver_id?trip.duration_minutes:null,saved:false};
    } catch(reason) {if(reason instanceof ServiceUnavailableException)throw reason;throw failed();}
  }

  /** Browser reads stay advisory; only the server monitor may persist a review flag. */
  async traffic(client:SupabaseClient,id:string,monitor=false) {
    const signal=AbortSignal.timeout(5000);
    const trip=await this.trip(client,id,signal,monitor);
    const pickup=trip.pickup_at?Date.parse(trip.pickup_at):NaN;
    if(!['scheduled','in-progress'].includes(trip.lifecycle))return {state:'ended'};
    if(!trip.assigned_driver_id||!Number.isFinite(pickup))return {state:'unassigned'};
    if(trip.lifecycle==='scheduled'&&pickup>Date.now()+3600000)return {state:'not_due'};
    try {
      const [saved,snapshot]=await Promise.all([this.route(trip.origin,trip.destination,signal),this.lta.getTraffic(signal)]);
      let route={geometry:saved.geometry,distanceMetres:saved.distance_metres,durationSeconds:saved.duration_seconds,encodedPolyline:''};
      let departure=Math.max(Date.now(),pickup),locationAvailable=true,estimateExpires=Date.now()+60000;
      if(trip.lifecycle==='in-progress'){
        const progress=await client.rpc(monitor?'trip_traffic_context':'trip_progress',{target:id}).abortSignal(signal);
        this.check(progress.error);
        const location=progress.data?.location as {latitude:number;longitude:number;accuracy_metres:number;recorded_at:string;received_at:string}|null;
        locationAvailable=!!location&&location.accuracy_metres<=100&&Date.parse(location.recorded_at)>=Date.now()-30000&&Date.parse(location.received_at)>=Date.now()-30000;
        if(locationAvailable&&location){
          estimateExpires=Math.min(Date.parse(location.recorded_at),Date.parse(location.received_at))+30000;
          route=await this.oneMap.getRoute(location,saved.destination_coordinates,signal);
        }
        departure=Date.now();
      }
      if(Date.now()-Date.parse(snapshot.incidentsRetrievedAt)>120000||Date.now()-Date.parse(snapshot.speedBandsRetrievedAt)>300000)throw failed();
      const matched=routeTraffic(route,snapshot);
      if(signal.aborted)throw failed();
      // Recheck caller visibility and version after external requests, including reassignment.
      const current=await this.trip(client,id,signal,monitor);
      if(current.version!==trip.version)throw new ConflictException('Trip changed. Reload before trying again.');
      locationAvailable=locationAvailable&&Date.now()<estimateExpires;
      const canEstimate=locationAvailable&&matched.coverage_percent>0;
      const earliest=canEstimate?departure+matched.minimum_seconds*1000:null;
      const latest=canEstimate&&matched.maximum_seconds!==null?departure+matched.maximum_seconds*1000:null;
      const expectedArrival=trip.arrival_by??trip.dropoff_at;
      const deadline=expectedArrival?Date.parse(expectedArrival):null;
      const risk=deadline!==null&&earliest!==null&&earliest>deadline?'at-risk'
        :matched.incidents.length||!canEstimate||matched.maximum_seconds===null||(deadline!==null&&latest!==null&&latest>deadline)?'possible-delay':'no-delay-detected';
      const assessedAt=new Date().toISOString();
      const requiresAttention=matched.incidents.length>0||(matched.maximum_seconds===null&&matched.coverage_percent>0)
        ||(deadline!==null&&((earliest!==null&&earliest>deadline)||(latest!==null&&latest>deadline)));
      if(monitor){
        const savedCheck=await client.rpc('record_trip_traffic_check',{target:id,expected_version:trip.version,assessment:{
          assessed_at:assessedAt,expires_at:new Date(Math.min(estimateExpires,Date.parse(snapshot.incidentsRetrievedAt)+120000,Date.parse(snapshot.speedBandsRetrievedAt)+300000)).toISOString(),
          risk,requires_attention:requiresAttention,coverage_percent:matched.coverage_percent,
          incidents_retrieved_at:snapshot.incidentsRetrievedAt,speeds_retrieved_at:snapshot.speedBandsRetrievedAt,
          arrival_from:earliest===null?null:new Date(earliest).toISOString(),arrival_until:latest===null?null:new Date(latest).toISOString(),
        }}).abortSignal(signal);
        this.check(savedCheck.error);
      }
      return {state:'current',...matched,estimated_arrival_from:earliest===null?null:new Date(earliest).toISOString(),
        estimated_arrival_until:latest===null?null:new Date(latest).toISOString(),risk,
        estimate_basis:!locationAvailable?'location_unavailable':matched.coverage_percent===0?'no_speed_coverage':'partial_traffic',
        assessed_at:assessedAt,estimated_departure_at:new Date(departure).toISOString(),estimate_expires_at:new Date(estimateExpires).toISOString(),trip_version:trip.version};
    } catch(reason) {if(reason instanceof ConflictException||reason instanceof NotFoundException)throw reason;throw new ServiceUnavailableException({code:'traffic_unavailable',message:'Current traffic assessment is unavailable.'});}
  }

  /** Fetch relevant connecting legs, then let the locked database operation decide eligibility. */
  async prepare(client:SupabaseClient,id:string,starts:string,expectedVersion?:number) {
    const trip=await this.trip(client,id);
    if(expectedVersion!==undefined&&trip.version!==expectedVersion)throw new ConflictException('Trip changed. Reload before trying again.');
    // Viewing/removing a reservation must remain possible during provider failure.
    if(trip.assigned_driver_id)return trip;
    const signal=AbortSignal.timeout(5000);
    try {
      await this.route(trip.origin,trip.destination,signal);
      const prepared=await client.rpc('prepare_trip_route',{target:id,expected_version:trip.version}).abortSignal(signal);
      this.check(prepared.error);if(!prepared.data)throw failed();
      const current=prepared.data as RoutableTrip;
      if(expectedVersion!==undefined&&current.version!==expectedVersion)throw new ConflictException('Route planning changed. Reload before assigning.');
      const required=await client.rpc('assignment_route_requirements',{target:id,starts}).abortSignal(signal);
      this.check(required.error);
      if(!Array.isArray(required.data))throw failed();
      const legs=required.data as {origin:string;destination:string}[];
      let index=0;
      await Promise.all(Array.from({length:Math.min(4,legs.length)},async()=>{
        while(index<legs.length){const leg=legs[index++];await this.route(leg.origin,leg.destination,signal);}
      }));
      return current;
    } catch(reason) {if(reason instanceof ServiceUnavailableException||reason instanceof ConflictException)throw reason;throw failed();}
  }
}
