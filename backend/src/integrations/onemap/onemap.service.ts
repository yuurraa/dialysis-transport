import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { Coordinates } from '../../common/types';

export const ONEMAP_API = {
  token:'https://www.onemap.gov.sg/api/auth/post/getToken',
  search:'https://www.onemap.gov.sg/api/common/elastic/search',
  route:'https://www.onemap.gov.sg/api/public/routingsvc/route',
} as const;
export interface AddressMatch extends Coordinates { address:string; postalCode:string }
export interface DrivingRoute { encodedPolyline:string; geometry:[number,number][]; distanceMetres:number; durationSeconds:number }
const unavailable=()=>new ServiceUnavailableException({code:'route_unavailable',message:'Route information is unavailable.'});
function object(value:unknown):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value))throw unavailable();
  return value as Record<string,unknown>;
}
export function validCoordinates(value:Coordinates) {
  return Number.isFinite(value.latitude)&&Number.isFinite(value.longitude)&&value.latitude>=1.144&&value.latitude<=1.494&&value.longitude>=103.535&&value.longitude<=104.502;
}
/** Decode the provider's polyline, rejecting truncated, excessive or out-of-area geometry. */
function geometry(encoded:string):[number,number][] {
  if(!encoded||encoded.length>200000)throw unavailable();
  const points:[number,number][]=[];let index=0;let latitude=0;let longitude=0;
  function delta(){
    let result=0,shift=0,byte:number;
    do {
      if(index>=encoded.length||shift>30)throw unavailable();
      byte=encoded.charCodeAt(index++)-63;
      if(byte<0||byte>63)throw unavailable();
      result|=(byte&31)<<shift;shift+=5;
    } while(byte>=32);
    return result&1?~(result>>1):result>>1;
  }
  while(index<encoded.length){
    latitude+=delta();longitude+=delta();
    const coordinate={latitude:latitude/100000,longitude:longitude/100000};
    if(!validCoordinates(coordinate)||points.length>=20000)throw unavailable();
    points.push([coordinate.latitude,coordinate.longitude]);
  }
  if(points.length<2)throw unavailable();
  return points;
}

function waitForToken(pending:Promise<string>,signal:AbortSignal):Promise<string> {
  if(signal.aborted)return Promise.reject(unavailable());
  return new Promise((resolve,reject)=>{
    const abort=()=>{signal.removeEventListener('abort',abort);reject(unavailable());};
    signal.addEventListener('abort',abort,{once:true});
    pending.then(value=>{signal.removeEventListener('abort',abort);resolve(value);},()=>{signal.removeEventListener('abort',abort);reject(unavailable());});
  });
}

/** Only fixed official endpoints are fetched; credentials and provider errors never reach clients. */
@Injectable()
export class OneMapService {
  private token:{value:string;expires:number}|null=null;
  private authentication:Promise<string>|null=null;

  async getAccessToken(signal:AbortSignal=AbortSignal.timeout(5000)):Promise<string> {
    if(this.token&&this.token.expires>Date.now()+60000)return this.token.value;
    if(this.authentication)return waitForToken(this.authentication,signal);
    const email=process.env.ONEMAP_EMAIL,password=process.env.ONEMAP_PASSWORD;
    if(!email||!password)throw new ServiceUnavailableException({code:'routing_unconfigured',message:'Routing is not configured.'});
    this.authentication=(async()=>{
      const response=await fetch(ONEMAP_API.token,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password}),signal:AbortSignal.timeout(5000)});
      if(!response.ok)throw unavailable();
      const body=object(await response.json());
      const expires=Number(body.expiry_timestamp)*1000;
      if(typeof body.access_token!=='string'||!body.access_token||!Number.isFinite(expires)||expires<=Date.now()+60000)throw unavailable();
      this.token={value:body.access_token,expires};return body.access_token;
    })().catch(()=>{throw unavailable();}).finally(()=>{this.authentication=null;});
    return waitForToken(this.authentication,signal);
  }

  private async request(url:URL,signal:AbortSignal) {
    try {
      for(let attempt=0;attempt<2;attempt++){
        const token=await this.getAccessToken(signal);
        const response=await fetch(url,{headers:{Authorization:token},redirect:'error',signal});
        if(response.status===401&&attempt===0){this.token=null;continue;}
        if(!response.ok)throw unavailable();
        const body=object(await response.json());
        if(body.error||body.Error||body.error_description)throw unavailable();
        return body;
      }
    } catch(reason) {if(reason instanceof ServiceUnavailableException)throw reason;}
    throw unavailable();
  }

  async searchAddresses(query:string,page=1,signal:AbortSignal=AbortSignal.timeout(5000)):Promise<{results:AddressMatch[];totalPages:number}> {
    if(!query.trim()||query.length>500||!Number.isInteger(page)||page<1||page>100)throw unavailable();
    const url=new URL(ONEMAP_API.search);url.search=new URLSearchParams({searchVal:query,returnGeom:'Y',getAddrDetails:'Y',pageNum:String(page)}).toString();
    const body=await this.request(url,signal);
    if(!Array.isArray(body.results)||body.results.length>100||!Number.isSafeInteger(body.totalNumPages)||Number(body.totalNumPages)<0)throw unavailable();
    const results=body.results.map(value=>{
      const row=object(value);const coordinate={latitude:Number(row.LATITUDE),longitude:Number(row.LONGITUDE)};
      if(!validCoordinates(coordinate)||typeof row.ADDRESS!=='string'||typeof row.POSTAL!=='string')throw unavailable();
      return {...coordinate,address:row.ADDRESS,postalCode:row.POSTAL};
    });
    return {results,totalPages:Number(body.totalNumPages)};
  }

  async resolveAddress(address:string,signal:AbortSignal=AbortSignal.timeout(5000)):Promise<Coordinates> {
    const postal=[...address.matchAll(/\bSingapore\s+(\d{6})\b/gi)].at(-1)?.[1];
    const query=postal??address.replace(/#[\w-]+/g,'').replace(/,\s*,/g,',').trim();
    const result=await this.searchAddresses(query,1,signal);
    const matches=result.results.filter(row=>!postal||row.postalCode===postal);
    const unique=new Map(matches.map(row=>[`${row.latitude},${row.longitude}`,row]));
    if(result.totalPages>1||unique.size!==1)throw new ServiceUnavailableException({code:'route_address_unresolved',message:'A route address could not be resolved uniquely.'});
    const match=[...unique.values()][0];return {latitude:match.latitude,longitude:match.longitude};
  }

  async getRoute(origin:Coordinates,destination:Coordinates,signal:AbortSignal=AbortSignal.timeout(5000)):Promise<DrivingRoute> {
    if(!validCoordinates(origin)||!validCoordinates(destination))throw unavailable();
    const url=new URL(ONEMAP_API.route);url.search=new URLSearchParams({start:`${origin.latitude},${origin.longitude}`,end:`${destination.latitude},${destination.longitude}`,routeType:'drive'}).toString();
    const body=await this.request(url,signal);const summary=object(body.route_summary);
    if(body.status!==0||typeof body.route_geometry!=='string'||typeof summary.total_time!=='number'||!Number.isFinite(summary.total_time)||summary.total_time<=0||summary.total_time>21600
      ||typeof summary.total_distance!=='number'||!Number.isFinite(summary.total_distance)||summary.total_distance<0||summary.total_distance>300000)throw unavailable();
    return {encodedPolyline:body.route_geometry,geometry:geometry(body.route_geometry),distanceMetres:summary.total_distance,durationSeconds:summary.total_time};
  }
}
