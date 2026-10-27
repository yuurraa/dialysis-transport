import { useEffect, useRef, useState } from 'react';
import { RefreshButton } from './DashboardUI';
import { ApiError, apiGet } from '../lib/api';

export interface TrafficView {
  availability?:{incidents:'current'|'unavailable'|'rate-limited';speeds:'current'|'unavailable'|'rate-limited'};
  state:'current'|'ended'|'unassigned'|'not_due';
  assessment_scope?:'road-conditions'|'trip-arrival';
  risk?:'at-risk'|'possible-delay'|'no-delay-detected';
  coverage_percent?:number;
  estimated_departure_at?:string;
  estimate_expires_at?:string;
  estimated_arrival_from?:string|null;
  estimated_arrival_until?:string|null;
  baseline_arrival_at?:string|null;
  delay_from_minutes?:number|null;
  delay_until_minutes?:number|null;
  slow_route_percent?:number;
  impact?:'low'|'medium'|'high'|'unknown';
  risk_reason?:string|null;
  departure_basis?:'scheduled'|'now'|'live-location';
  estimate_basis?:'location_unavailable'|'no_speed_coverage'|'partial_traffic';
  assessed_at?:string;
  incidents_retrieved_at?:string|null;
  speeds_retrieved_at?:string|null;
  incidents?:{latitude:number;longitude:number;type:string;message:string}[];
  speed_bands?:{linkId:string;roadName:string;speedBand:number;minimumSpeedKmh:number;maximumSpeedKmh:number;start:{latitude:number;longitude:number};end:{latitude:number;longitude:number};route_geometry?:[number,number][][]}[];
}
export type TrafficIncident=NonNullable<TrafficView['incidents']>[number];
export function incidentKey(incident:TrafficIncident){
  return `${incident.latitude}:${incident.longitude}:${incident.type}:${incident.message}`;
}
function incidentReport(message:string){
  const match=message.match(/^\((\d{1,2}\/\d{1,2})\)\s*(\d{1,2}:\d{2})\s*/);
  return {message:match?message.slice(match[0].length):message,reported:match?`${match[1]} · ${match[2]}`:null};
}
const arrival=(value:string)=>new Intl.DateTimeFormat('en-SG',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',timeZone:'Asia/Singapore'}).format(new Date(value));
const time=(value:string)=>new Intl.DateTimeFormat('en-SG',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Singapore'}).format(new Date(value));
const delay=(from:number|null|undefined,until:number|null|undefined)=>from==null?'Unavailable':until==null?`+${from} min or more`:from===until?`${from?'+':''}${from} min`:`+${from}–${until} min`;

/** Refresh observations while visible; failed reads never become a clear-road claim. */
export default function TripTraffic({tripId,version,activeTrip,locationAvailable,onSessionExpired,onUpdate,selectedIncident,onSelectIncident}:{tripId:string;version:number;activeTrip:boolean;locationAvailable:boolean;onSessionExpired:()=>void;onUpdate:(value:TrafficView|null)=>void;selectedIncident:string|null;onSelectIncident:(key:string)=>void}) {
  const [assessment,setData]=useState<TrafficView|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true);
  const refresh=useRef<()=>void>(()=>{});
  const [now,setNow]=useState(Date.now);
  useEffect(()=>{const timer=window.setInterval(()=>setNow(Date.now()),1000);return()=>window.clearInterval(timer);},[]);
  const failedExpired=!!error&&!!assessment&&(!assessment.estimate_expires_at||Date.parse(assessment.estimate_expires_at)<=now);
  const unsupported=assessment?.state==='current'&&((activeTrip&&!locationAvailable)||!assessment.estimate_expires_at||Date.parse(assessment.estimate_expires_at)<=now);
  const data:TrafficView|null=failedExpired?null:unsupported?{...assessment,risk:'possible-delay',baseline_arrival_at:null,estimated_arrival_from:null,estimated_arrival_until:null,delay_from_minutes:null,delay_until_minutes:null,impact:'unknown',risk_reason:activeTrip?'Driver location is unavailable.':'Traffic assessment is being refreshed.',estimate_basis:activeTrip?'location_unavailable':assessment.estimate_basis}:assessment;
  const callbacks=useRef({onSessionExpired,onUpdate});callbacks.current={onSessionExpired,onUpdate};
  useEffect(()=>{if(failedExpired)callbacks.current.onUpdate(null);},[failedExpired]);
  useEffect(()=>{
    let live=true,busy=false,timer:number|undefined,nextReadAt=0,last:TrafficView|null=null;
    setData(null);setError('');setLoading(true);callbacks.current.onUpdate(null);
    async function load(){
      if(!live||busy||document.visibilityState==='hidden')return;
      busy=true;setLoading(true);window.clearTimeout(timer);
      let failed=false;
      try {
        const result=await apiGet<TrafficView>(`/trips/${tripId}/traffic`);
        if(live){last=result;setData(result);setError('');callbacks.current.onUpdate(result);}
      } catch(reason){
        failed=true;
        if(live){
          if(reason instanceof ApiError&&reason.status===401)callbacks.current.onSessionExpired();
          const retain=!(reason instanceof ApiError&&[401,403,404,409].includes(reason.status))&&last?.state==='current'&&Date.parse(last.estimate_expires_at??'')>Date.now();
          if(!retain){last=null;setData(null);callbacks.current.onUpdate(null);}
          setError(reason instanceof ApiError&&reason.status===409?'Trip changed. Waiting for updated details.':'Current traffic assessment is unavailable.');
        }
      } finally {busy=false;if(live){const interval=failed||activeTrip?15000:60000;nextReadAt=Date.now()+interval;setLoading(false);timer=window.setTimeout(()=>void load(),interval);}}
    }
    refresh.current=()=>void load();
    void load();
    const visible=()=>{if(document.visibilityState==='visible'){setNow(Date.now());if(Date.now()>=nextReadAt)void load();}};
    document.addEventListener('visibilitychange',visible);
    return()=>{live=false;window.clearTimeout(timer);document.removeEventListener('visibilitychange',visible);};
  },[tripId,version,activeTrip]);
  // GPS freshness changes affect arrival estimates, not the identity of the road observations.
  useEffect(()=>{refresh.current();},[locationAvailable]);
  const incidentsUnavailable=!!data?.availability&&data.availability.incidents!=='current';
  const speedsUnavailable=!!data?.availability&&data.availability.speeds!=='current';
  if(data?.state==='ended')return null;
  return <section className="trip-traffic" aria-label="Current traffic">
    <div className="trip-map-heading"><h3>Current traffic</h3></div>
    {error&&!data?<p className="trip-map-note trip-map-feedback" role="status"><span>{error}</span><RefreshButton label="Refresh traffic" busy={loading} onClick={()=>refresh.current()}/></p>
      :!data?<p className="trip-map-note" role="status">Checking traffic…</p>
      :data.state!=='current'?<p className="trip-map-note">Traffic is not available yet.</p>
      :<>
        <dl className="trip-traffic-comparison">
          <div><dt>Baseline ETA</dt><dd title={data.baseline_arrival_at?arrival(data.baseline_arrival_at):undefined}>{data.baseline_arrival_at?time(data.baseline_arrival_at):'—'}</dd></div><div><dt>Current ETA</dt><dd title={data.estimated_arrival_from?arrival(data.estimated_arrival_from):undefined}>{data.estimated_arrival_from?`${time(data.estimated_arrival_from)}${data.estimated_arrival_until?time(data.estimated_arrival_until)!==time(data.estimated_arrival_from)?` – ${time(data.estimated_arrival_until)}`:'':' or later'}`:'—'}</dd></div>
          <div><dt>Delay</dt><dd>{delay(data.delay_from_minutes,data.delay_until_minutes)}</dd></div>
          <div><dt>Impact</dt><dd>{data.impact&&data.impact!=='unknown'?data.impact[0].toUpperCase()+data.impact.slice(1):'Unavailable'}</dd></div>
        </dl>
        <div className="trip-obstacles-heading"><h4>Road obstacles</h4><span>{incidentsUnavailable?'—':data.incidents?.length??0}</span></div>
        {data.incidents?.length?<ol className="trip-obstacles">{data.incidents.map((incident,index)=>{
          const key=incidentKey(incident),report=incidentReport(incident.message);
          return <li key={key}><button type="button" className="trip-obstacle" aria-pressed={selectedIncident===key} onClick={()=>onSelectIncident(key)} aria-label={`Obstacle ${index+1}: ${incident.type}. ${report.message}`}>
            <span className="trip-obstacle-number" aria-hidden="true">{index+1}</span>
            <span className="trip-obstacle-content"><span className="trip-obstacle-title"><strong>{incident.type}</strong>{report.reported&&<span>{report.reported}</span>}</span><span className="trip-obstacle-message">{report.message}</span></span>
          </button></li>;
        })}</ol>:<p className="trip-map-note">{incidentsUnavailable?'Road obstacles are currently unavailable.':'No obstacles reported.'}</p>}
        <div className="trip-traffic-footer">{error&&<span className="trip-map-feedback" role="status"><span>Traffic update unavailable.</span><RefreshButton label="Refresh traffic" busy={loading} onClick={()=>refresh.current()}/></span>}{!speedsUnavailable&&<span>{`Speed data: ${data.coverage_percent??0}% of route${data.slow_route_percent!==undefined?` · Slow sections: ${data.slow_route_percent}%`:''}`}</span>}<span>Last checked: Incidents {data.incidents_retrieved_at?time(data.incidents_retrieved_at):'—'} · Speeds {data.speeds_retrieved_at?time(data.speeds_retrieved_at):'—'}</span></div>
      </>}
  </section>;
}
