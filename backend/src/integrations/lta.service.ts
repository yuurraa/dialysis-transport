import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { Coordinates } from '../types';
import { validCoordinates } from './onemap.service';

/** DataMall guide v6.10 (1 October 2026), sections 2.18 and 2.19. */
export const LTA_API = {
  incidents: 'https://datamall2.mytransport.sg/ltaodataservice/TrafficIncidents',
  speedBands: 'https://datamall2.mytransport.sg/ltaodataservice/v4/TrafficSpeedBands',
} as const;

export interface TrafficIncident extends Coordinates { type: string; message: string }
export interface RoadSpeedBand {
  linkId: string;
  roadName: string;
  speedBand: number;
  minimumSpeedKmh: number;
  maximumSpeedKmh: number;
  start: Coordinates;
  end: Coordinates;
}
export interface TrafficSnapshot {
  incidents: TrafficIncident[];
  speedBands: RoadSpeedBand[];
  retrievedAt: string;
  incidentsRetrievedAt: string|null;
  speedBandsRetrievedAt: string|null;
  availability?: {incidents:'current'|'unavailable'|'rate-limited';speeds:'current'|'unavailable'|'rate-limited'};
}
interface Feed<T> { rows:T[]; retrievedAt:string; expires:number }
const unavailable=()=>new ServiceUnavailableException({code:'traffic_unavailable',message:'Current traffic information is unavailable.'});
class FeedFailure extends ServiceUnavailableException {
  constructor(readonly retryAt:number,readonly rateLimited=false){super({code:'traffic_unavailable',message:'Current traffic information is unavailable.'});}
}
function record(value:unknown):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value))throw unavailable();
  return value as Record<string,unknown>;
}
function number(value:unknown):number {
  if(typeof value!=='number'&&(typeof value!=='string'||!value.trim()))throw unavailable();
  const result=Number(value);
  if(!Number.isFinite(result))throw unavailable();
  return result;
}
function text(value:unknown,limit:number):string {
  if(typeof value!=='string'||!value.trim()||value.length>limit)throw unavailable();
  return value.trim();
}
function coordinates(latitude:unknown,longitude:unknown):Coordinates {
  const point={latitude:number(latitude),longitude:number(longitude)};
  if(!validCoordinates(point))throw unavailable();
  return point;
}
function incident(value:unknown):TrafficIncident {
  const row=record(value);
  return {...coordinates(row.Latitude,row.Longitude),type:text(row.Type,100),message:text(row.Message,4000)};
}
function speedBand(value:unknown):RoadSpeedBand|null {
  const row=record(value);
  // Band 8 is open-ended (70+); its upper field may be a provider sentinel.
  const band=number(row.SpeedBand);
  // Live v4 feeds include band 0 with empty speeds: no observation, not stopped traffic.
  const missing=(value:unknown)=>value===null||value===undefined||typeof value==='string'&&!value.trim();
  if(band===0&&missing(row.MinimumSpeed)&&missing(row.MaximumSpeed))return null;
  const minimum=number(row.MinimumSpeed),maximum=number(row.MaximumSpeed);
  if(!Number.isInteger(band)||band<1||band>8||minimum<0||minimum>300||maximum<=0||maximum<minimum||(band<8&&maximum>300))throw unavailable();
  const linkId=typeof row.LinkID==='number'?String(row.LinkID):row.LinkID;
  return {linkId:text(linkId,100),roadName:text(row.RoadName,300),speedBand:band,
    minimumSpeedKmh:minimum,maximumSpeedKmh:maximum,
    start:coordinates(row.StartLat,row.StartLon),end:coordinates(row.EndLat,row.EndLon)};
}

/** A viewer's deadline does not cancel another viewer's shared refresh. */
function wait<T>(pending:Promise<T>,signal:AbortSignal):Promise<T> {
  if(signal.aborted)return Promise.reject(unavailable());
  return new Promise((resolve,reject)=>{
    const abort=()=>{signal.removeEventListener('abort',abort);reject(unavailable());};
    signal.addEventListener('abort',abort,{once:true});
    pending.then(value=>{signal.removeEventListener('abort',abort);resolve(value);},reason=>{signal.removeEventListener('abort',abort);reject(reason instanceof FeedFailure?reason:unavailable());});
  });
}

/** Each published feed is complete and validated; advisory reads may use one available feed. */
@Injectable()
export class LtaService {
  private incidents:Feed<TrafficIncident>|null=null;
  private speeds:Feed<RoadSpeedBand>|null=null;
  private incidentRefresh:Promise<Feed<TrafficIncident>>|null=null;
  private speedRefresh:Promise<Feed<RoadSpeedBand>>|null=null;
  private incidentFailure:FeedFailure|null=null;
  private speedFailure:FeedFailure|null=null;

  private async fetchFeed<T>(endpoint:string,parse:(value:unknown)=>T|null,ttl:number):Promise<Feed<T>> {
    const key=process.env.LTA_ACCOUNT_KEY;
    if(!key)throw new ServiceUnavailableException({code:'traffic_unconfigured',message:'Traffic information is not configured.'});
    const pending=new AbortController(),signal=AbortSignal.any([pending.signal,AbortSignal.timeout(20000)]),rows:T[]=[];
    // Freshness begins before paging, so a slow refresh cannot extend old data's life.
    const started=Date.now();
    try {
      const pageSize=500,maxRecords=200000;
      const concurrency=endpoint===LTA_API.speedBands?8:1;
      const page=async(skip:number)=>{
        const url=new URL(endpoint);url.searchParams.set('$skip',String(skip));
        const response=await fetch(url,{headers:{AccountKey:key,Accept:'application/json'},redirect:'error',signal});
        if(!response.ok){
          // DataMall reports quota exhaustion as HTTP 500 as well as 429.
          const fault=await response.json().catch(()=>null);
          const limited=response.status===429||fault?.fault?.detail?.errorcode==='policies.ratelimit.QuotaViolation';
          const retry=response.headers.get('retry-after');
          const requested=retry?(Number.isFinite(Number(retry))?Date.now()+Number(retry)*1000:Date.parse(retry)):NaN;
          throw new FeedFailure(Math.max(Date.now()+(limited?300000:30000),Number.isFinite(requested)?requested:0),limited);
        }
        const body=record(await response.json());
        if(!Array.isArray(body.value)||body.value.length>pageSize)throw unavailable();
        return body.value;
      };
      // Fetch the first page alone; only the large speed feed needs concurrent pagination.
      let skip=0;
      while(skip<maxRecords){
        const count=skip===0?1:Math.min(concurrency,(maxRecords-skip)/pageSize);
        const pages=await Promise.all(Array.from({length:count},(_,index)=>page(skip+index*pageSize)));
        for(const values of pages){
          for(const value of values){const parsed=parse(value);if(parsed!==null)rows.push(parsed);}
          if(values.length<pageSize)return {rows,retrievedAt:new Date(started).toISOString(),expires:started+ttl};
        }
        skip+=count*pageSize;
      }
      // A capped or incomplete feed must not look like a successful empty/partial snapshot.
      throw unavailable();
    } catch(reason) {pending.abort();throw reason instanceof FeedFailure?reason:new FeedFailure(Date.now()+30000);}
  }

  private incidentFeed(signal:AbortSignal):Promise<Feed<TrafficIncident>> {
    if(signal.aborted)return Promise.reject(unavailable());
    if(this.incidents&&this.incidents.expires>Date.now())return Promise.resolve(this.incidents);
    if(this.incidentFailure&&this.incidentFailure.retryAt>Date.now())return Promise.reject(this.incidentFailure);
    if(!this.incidentRefresh)this.incidentRefresh=this.fetchFeed(LTA_API.incidents,incident,120000)
      .then(feed=>{this.incidents=feed;this.incidentFailure=null;return feed;})
      .catch(reason=>{this.incidentFailure=reason;throw reason;}).finally(()=>{this.incidentRefresh=null;});
    return wait(this.incidentRefresh,signal);
  }

  private speedFeed(signal:AbortSignal):Promise<Feed<RoadSpeedBand>> {
    if(signal.aborted)return Promise.reject(unavailable());
    if(this.speeds&&this.speeds.expires>Date.now())return Promise.resolve(this.speeds);
    if(this.speedFailure&&this.speedFailure.retryAt>Date.now())return Promise.reject(this.speedFailure);
    if(!this.speedRefresh)this.speedRefresh=this.fetchFeed(LTA_API.speedBands,speedBand,300000)
      .then(feed=>{this.speeds=feed;this.speedFailure=null;return feed;})
      .catch(reason=>{this.speedFailure=reason;throw reason;}).finally(()=>{this.speedRefresh=null;});
    return wait(this.speedRefresh,signal);
  }

  async getIncidents(signal:AbortSignal=AbortSignal.timeout(5000)):Promise<TrafficIncident[]> {
    return structuredClone((await this.incidentFeed(signal)).rows);
  }

  async getSpeedBands(signal:AbortSignal=AbortSignal.timeout(5000)):Promise<RoadSpeedBand[]> {
    return structuredClone((await this.speedFeed(signal)).rows);
  }

  async getTraffic(signal:AbortSignal=AbortSignal.timeout(5000),allowPartial=false):Promise<TrafficSnapshot> {
    if(allowPartial){
      const results=await Promise.allSettled([this.incidentFeed(signal),this.speedFeed(signal)]);
      const incidents=results[0].status==='fulfilled'?results[0].value:null;
      const speeds=results[1].status==='fulfilled'?results[1].value:null;
      if(!incidents&&!speeds)throw unavailable();
      const times=[incidents?.retrievedAt,speeds?.retrievedAt].filter((time):time is string=>!!time).sort();
      const state=(result:PromiseSettledResult<unknown>)=>result.status==='fulfilled'?'current':result.reason instanceof FeedFailure&&result.reason.rateLimited?'rate-limited':'unavailable';
      return {incidents:structuredClone(incidents?.rows??[]),speedBands:structuredClone(speeds?.rows??[]),retrievedAt:times[0],
        incidentsRetrievedAt:incidents?.retrievedAt??null,speedBandsRetrievedAt:speeds?.retrievedAt??null,
        availability:{incidents:state(results[0]),speeds:state(results[1])}};
    }
    const [incidents,speeds]=await Promise.all([this.incidentFeed(signal),this.speedFeed(signal)]);
    return {incidents:structuredClone(incidents.rows),speedBands:structuredClone(speeds.rows),
      retrievedAt:incidents.retrievedAt<speeds.retrievedAt?incidents.retrievedAt:speeds.retrievedAt,
      incidentsRetrievedAt:incidents.retrievedAt,speedBandsRetrievedAt:speeds.retrievedAt};
  }
}
