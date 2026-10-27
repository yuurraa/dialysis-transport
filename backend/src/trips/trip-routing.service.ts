import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
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
interface RoutableTrip { id:string; version:number; origin:string; destination:string; duration_minutes:number; status:string; review_required:boolean; assigned_driver_id:string|null; route_snapshot:RoadRoute|null; lifecycle:string; pickup_at:string|null; dropoff_at:string|null; arrival_by:string|null }
const failed=()=>new ServiceUnavailableException({code:'route_unavailable',message:'Route assessment is unavailable.'});

@Injectable()
export class TripRoutingService {
  constructor(@Inject(SupabaseService) private readonly database:SupabaseService,@Inject(OneMapService) private readonly oneMap:OneMapService,@Inject(LtaService) private readonly lta:LtaService) {}

  private check(error:{code?:string}|null) {
    if(!error)return;
    if(['PT409','40001'].includes(error.code??''))throw new ConflictException('Trip changed. Reload before trying again.');
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
    const signal=AbortSignal.timeout(12000);
    const trip=await this.trip(client,id,signal,monitor);
    const pickup=trip.pickup_at?Date.parse(trip.pickup_at):NaN;
    // Background alerts stay tied to actionable journeys; an open map can always show roads now.
    if(monitor){
      if(!['scheduled','in-progress'].includes(trip.lifecycle))return {state:'ended'};
      if(!trip.assigned_driver_id||!Number.isFinite(pickup))return {state:'unassigned'};
      if(trip.lifecycle==='scheduled'&&pickup>Date.now()+3600000)return {state:'not_due'};
    }
    const assessArrival=trip.lifecycle==='in-progress'||(trip.lifecycle==='scheduled'&&!!trip.assigned_driver_id&&Number.isFinite(pickup)&&pickup<=Date.now()+3600000);
    try {
      const [saved,snapshot]=await Promise.all([this.route(trip.origin,trip.destination,signal),this.lta.getTraffic(signal,!monitor)]);
      let route={geometry:saved.geometry,distanceMetres:saved.distance_metres,durationSeconds:saved.duration_seconds,encodedPolyline:''};
      let departure=assessArrival&&trip.lifecycle==='scheduled'?Math.max(Date.now(),pickup):Date.now(),locationAvailable=true,estimateExpires=Date.now()+60000;
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
      const incidentTime=snapshot.incidentsRetrievedAt?Date.parse(snapshot.incidentsRetrievedAt):NaN;
      const speedTime=snapshot.speedBandsRetrievedAt?Date.parse(snapshot.speedBandsRetrievedAt):NaN;
      const complete=Number.isFinite(incidentTime)&&Number.isFinite(speedTime);
      if((monitor&&!complete)||(Number.isFinite(incidentTime)&&Date.now()-incidentTime>120000)||(Number.isFinite(speedTime)&&Date.now()-speedTime>300000))throw failed();
      estimateExpires=Math.min(estimateExpires,Number.isFinite(incidentTime)?incidentTime+120000:Infinity,Number.isFinite(speedTime)?speedTime+300000:Infinity);
      const matched=routeTraffic(route,snapshot);
      if(signal.aborted)throw failed();
      // Recheck caller visibility and version after external requests, including reassignment.
      const current=await this.trip(client,id,signal,monitor);
      if(current.version!==trip.version)throw new ConflictException('Trip changed. Reload before trying again.');
      locationAvailable=locationAvailable&&Date.now()<estimateExpires;
      const canEstimate=complete&&assessArrival&&locationAvailable&&matched.coverage_percent>0;
      const comparable=complete&&locationAvailable&&matched.coverage_percent>0;
      const baselineArrival=canEstimate?departure+route.durationSeconds*1000:null;
      const delayFrom=comparable?Math.max(0,Math.ceil((matched.minimum_seconds-route.durationSeconds)/60)):null;
      const delayUntil=comparable&&matched.maximum_seconds!==null?Math.max(0,Math.ceil((matched.maximum_seconds-route.durationSeconds)/60)):null;
      const earliest=canEstimate?departure+matched.minimum_seconds*1000:null;
      const latest=canEstimate&&matched.maximum_seconds!==null?departure+matched.maximum_seconds*1000:null;
      const expectedArrival=trip.arrival_by??trip.dropoff_at;
      const deadline=expectedArrival?Date.parse(expectedArrival):null;
      const roadDisruption=matched.incidents.length>0||matched.speed_bands.some(road=>road.speedBand<=3);
      const risk=!complete?'possible-delay':!assessArrival?(roadDisruption||matched.coverage_percent===0?'possible-delay':'no-delay-detected'):deadline!==null&&earliest!==null&&earliest>deadline?'at-risk'
        :matched.incidents.length||!canEstimate||matched.maximum_seconds===null||(deadline!==null&&latest!==null&&latest>deadline)?'possible-delay':'no-delay-detected';
      const assessedAt=new Date().toISOString();
      const requiresAttention=matched.incidents.length>0||(matched.maximum_seconds===null&&matched.coverage_percent>0)
        ||(deadline!==null&&((earliest!==null&&earliest>deadline)||(latest!==null&&latest>deadline)));
      const clearVerified=assessArrival&&risk==='no-delay-detected'&&comparable&&matched.coverage_fraction>=.9&&latest!==null;
      const overdue=trip.lifecycle==='scheduled'&&Number.isFinite(pickup)&&pickup<Date.now();
      const reason=overdue?'Pickup is overdue; the driver has not started the trip.'
        :risk==='at-risk'?(trip.arrival_by?'Traffic-adjusted arrival exceeds the treatment buffer.':'Traffic-adjusted arrival exceeds the planned arrival time.')
        :matched.incidents.length?'A road obstacle is reported along this route.'
        :!locationAvailable?'Driver location is unavailable.'
        :matched.maximum_seconds===null?'Very low observed speeds make arrival uncertain.':null;
      const impact=!comparable||matched.coverage_fraction<.5?'unknown':risk==='at-risk'||delayUntil===null||(delayFrom??0)>=10?'high'
        :matched.incidents.length>0||(delayUntil??0)>=5?'medium':'low';
      if(monitor){
        const savedCheck=await client.rpc('record_trip_traffic_check',{target:id,expected_version:trip.version,assessment:{
          assessed_at:assessedAt,expires_at:new Date(estimateExpires).toISOString(),
          risk,requires_attention:requiresAttention,clear_verified:clearVerified,coverage_percent:matched.coverage_fraction*100,
          incidents_retrieved_at:snapshot.incidentsRetrievedAt,speeds_retrieved_at:snapshot.speedBandsRetrievedAt,
          arrival_from:earliest===null?null:new Date(earliest).toISOString(),arrival_until:latest===null?null:new Date(latest).toISOString(),
        }}).abortSignal(signal);
        this.check(savedCheck.error);
      }
      return {state:'current',assessment_scope:assessArrival?'trip-arrival':'road-conditions',...matched,
        availability:snapshot.availability??{incidents:Number.isFinite(incidentTime)?'current':'unavailable',speeds:Number.isFinite(speedTime)?'current':'unavailable'},
        estimated_arrival_from:earliest===null?null:new Date(earliest).toISOString(),
        estimated_arrival_until:latest===null?null:new Date(latest).toISOString(),risk,
        baseline_arrival_at:baselineArrival===null?null:new Date(baselineArrival).toISOString(),delay_from_minutes:delayFrom,delay_until_minutes:delayUntil,
        impact,risk_reason:reason,departure_basis:trip.lifecycle==='in-progress'?'live-location':overdue?'now':'scheduled',
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

  private recoveryCheck(error:{code?:string}|null){
    if(error?.code==='22023')throw new BadRequestException('This journey is not eligible for recovery.');
    this.check(error);
  }

  private async recoveryAssessment(trip:RoutableTrip,signal:AbortSignal){
    const [route,snapshot]=await Promise.all([this.route(trip.origin,trip.destination,signal),this.lta.getTraffic(signal)]);
    if(!snapshot.incidentsRetrievedAt||!snapshot.speedBandsRetrievedAt)throw new ServiceUnavailableException({code:'recovery_unavailable',message:'Recovery needs current incident and speed observations.'});
    const expires=Math.min(Date.parse(snapshot.incidentsRetrievedAt)+120000,Date.parse(snapshot.speedBandsRetrievedAt)+300000);
    const matched=routeTraffic({geometry:route.geometry,distanceMetres:route.distance_metres,durationSeconds:route.duration_seconds,encodedPolyline:''},snapshot);
    // Unknown passage time is not proof that no driver/resource exists.
    if(expires<=Date.now()||matched.coverage_percent===0||signal.aborted)throw new ServiceUnavailableException({code:'recovery_unavailable',message:'Recovery needs a current route and usable traffic observations.'});
    const estimated=matched.maximum_seconds===null,bufferMinutes=estimated?15:0;
    // A planning reservation is explicit uncertainty, not a fabricated upper ETA bound.
    const seconds=matched.maximum_seconds??matched.minimum_seconds;
    const minutes=Math.max(5,Math.ceil(Math.max(route.duration_seconds,seconds)/300)*5)+bufferMinutes;
    if(minutes>360)throw new ServiceUnavailableException({code:'recovery_unavailable',message:'Recovery duration exceeds the supported booking window.'});
    return {minutes,expires,estimated,bufferMinutes};
  }

  private async recoveryConnections(integration:SupabaseClient,id:string,version:number,minutes:number,signal:AbortSignal,handoverOrigin?:string){
    const response=await integration.rpc(handoverOrigin?'trip_handover_candidates':'trip_recovery_candidates',{target:id,expected_version:version,reserved_minutes:minutes,...(handoverOrigin?{handover_origin:handoverOrigin}:{route_blocked:false})}).abortSignal(signal);
    this.recoveryCheck(response.error);
    const preview=response.data as {requirements:{origin:string;destination:string}[];options:{driver_id:string;pickup_at:string}[]}|null;
    if(!preview||!Array.isArray(preview.requirements)||!Array.isArray(preview.options))throw failed();
    const legs=preview.requirements;let index=0;
    await Promise.all(Array.from({length:Math.min(4,legs.length)},async()=>{
      while(index<legs.length){const leg=legs[index++];await this.route(leg.origin,leg.destination,signal);}
    }));
    return preview;
  }

  /** Server proposals leave the current reservation intact until explicit coordinator approval. */
  async recoveryOptions(client:SupabaseClient,id:string,version:number,handoverOrigin?:string){
    const trip=await this.trip(client,id);
    if(trip.version!==version)throw new ConflictException('Trip changed. Reload before assessing recovery.');
    if(trip.status!=='at-risk'||!trip.assigned_driver_id||trip.review_required
      ||(handoverOrigin?trip.lifecycle!=='in-progress':trip.lifecycle!=='scheduled'))throw new BadRequestException('Recovery requires an eligible At-Risk trip and a safe pickup point for an active journey.');
    return this.generateRecoveryOptions(trip,handoverOrigin);
  }

  /** Only the trusted worker calls this; approval still requires the coordinator's JWT. */
  async automaticRecovery(id:string,version:number){
    const integration=this.database.forIntegration(),signal=AbortSignal.timeout(5000);
    const trip=await this.trip(integration,id,signal,true);
    if(trip.version!==version)throw new ConflictException('Trip changed before recovery assessment.');
    if(trip.lifecycle!=='scheduled'||trip.status!=='at-risk'||!trip.assigned_driver_id||trip.review_required)return;
    return this.generateRecoveryOptions(trip);
  }

  private async generateRecoveryOptions(trip:RoutableTrip,handoverOrigin?:string){
    const {id,version}=trip,signal=AbortSignal.timeout(10000),integration=this.database.forIntegration();
    if(!handoverOrigin){
      const cached=await integration.rpc('pending_trip_recovery_options',{target:id,expected_version:version}).abortSignal(signal);
      this.recoveryCheck(cached.error);
      if(cached.data)return cached.data;
    }
    const assessment=await this.recoveryAssessment(handoverOrigin?{...trip,origin:handoverOrigin}:trip,signal);
    await this.recoveryConnections(integration,id,version,assessment.minutes,signal,handoverOrigin);
    const current=await this.trip(integration,id,signal,true);
    if(current.version!==version||assessment.expires<=Date.now())throw new ConflictException('Trip or traffic changed. Reassess recovery.');
    const result=await integration.rpc('store_assessed_trip_recovery_options',{target:id,expected_version:version,reserved_minutes:assessment.minutes,
      handover_origin:handoverOrigin??null,route_blocked:false,estimated_duration:assessment.estimated,buffer_minutes:assessment.bufferMinutes}).abortSignal(signal);
    this.recoveryCheck(result.error);
    return result.data;
  }

  async approveRecovery(client:SupabaseClient,id:string,version:number,optionId:string,safePickupConfirmed=false){
    const trip=await this.trip(client,id);
    if(trip.version!==version)throw new ConflictException('Trip changed. Reassess recovery.');
    const signal=AbortSignal.timeout(10000),integration=this.database.forIntegration();
    const result=await integration.rpc('trip_recovery_option',{proposal:optionId}).abortSignal(signal);
    this.recoveryCheck(result.error);
    const option=result.data?.option as {trip_id:string;trip_version:number;driver_id:string;pickup_at:string;duration_minutes:number;expires_at:string;handover_origin?:string|null;estimated_duration?:boolean}|undefined;
    if(!option||option.trip_id!==id||option.trip_version!==version||Date.parse(option.expires_at)<=Date.now())throw new ConflictException('Recovery option changed or expired. Reassess recovery.');
    const handoverOrigin=option.handover_origin??undefined;
    if(handoverOrigin&&!safePickupConfirmed)throw new BadRequestException('Confirm that the patient is at the safe pickup point before approving the handover.');
    const assessment=await this.recoveryAssessment(handoverOrigin?{...trip,origin:handoverOrigin}:trip,signal);
    if(assessment.minutes>option.duration_minutes||(assessment.estimated&&!option.estimated_duration))throw new ConflictException('Traffic changed. Reassess recovery.');
    const connecting=await integration.rpc('trip_recovery_validation',{proposal:optionId}).abortSignal(signal);
    this.recoveryCheck(connecting.error);
    const legs=connecting.data?.requirements as {origin:string;destination:string}[]|undefined;
    if(!Array.isArray(legs))throw failed();
    let index=0;
    await Promise.all(Array.from({length:Math.min(4,legs.length)},async()=>{
      while(index<legs.length){const leg=legs[index++];await this.route(leg.origin,leg.destination,signal);}
    }));
    const verified=await integration.rpc('trip_recovery_validation',{proposal:optionId}).abortSignal(signal);
    this.recoveryCheck(verified.error);
    if(verified.data?.feasible!==true)throw new ConflictException('Recovery option is no longer feasible.');
    const current=await this.trip(client,id,signal);
    if(current.version!==version||signal.aborted)throw new ConflictException('Trip changed. Reassess recovery.');
    const expires=Math.min(Date.now()+20000,Date.parse(option.expires_at),assessment.expires);
    if(expires<=Date.now())throw new ConflictException('Recovery assessment expired.');
    const attested=await integration.rpc('attest_trip_recovery_option',{proposal:optionId,valid_until:new Date(expires).toISOString()}).abortSignal(signal);
    this.recoveryCheck(attested.error);
    const saved=await client.rpc(handoverOrigin?'approve_trip_handover':'approve_trip_recovery',{proposal:optionId,expected_version:version,...(handoverOrigin?{safe_pickup_confirmed:safePickupConfirmed}:{})}).abortSignal(signal);
    this.recoveryCheck(saved.error);
    return saved.data;
  }
}
