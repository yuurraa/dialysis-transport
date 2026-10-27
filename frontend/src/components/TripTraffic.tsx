import { useEffect, useRef, useState } from 'react';
import { RefreshButton } from './DashboardUI';
import { ApiError, apiGet } from '../lib/api';

export interface TrafficView {
  state:'current'|'ended'|'unassigned'|'not_due';
  assessment_scope?:'road-conditions'|'trip-arrival';
  risk?:'at-risk'|'possible-delay'|'no-delay-detected';
  coverage_percent?:number;
  estimated_departure_at?:string;
  estimate_expires_at?:string;
  estimated_arrival_from?:string|null;
  estimated_arrival_until?:string|null;
  estimate_basis?:'location_unavailable'|'no_speed_coverage'|'partial_traffic';
  assessed_at?:string;
  incidents_retrieved_at?:string;
  speeds_retrieved_at?:string;
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

/** Refresh observations while visible; failed reads never become a clear-road claim. */
export default function TripTraffic({tripId,version,activeTrip,locationAvailable,onSessionExpired,onUpdate,selectedIncident,onSelectIncident}:{tripId:string;version:number;activeTrip:boolean;locationAvailable:boolean;onSessionExpired:()=>void;onUpdate:(value:TrafficView|null)=>void;selectedIncident:string|null;onSelectIncident:(key:string)=>void}) {
  const [assessment,setData]=useState<TrafficView|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true);
  const refresh=useRef<()=>void>(()=>{});
  const [now,setNow]=useState(Date.now);
  useEffect(()=>{const timer=window.setInterval(()=>setNow(Date.now()),1000);return()=>window.clearInterval(timer);},[]);
  const unsupported=assessment?.state==='current'&&((activeTrip&&!locationAvailable)||!assessment.estimate_expires_at||Date.parse(assessment.estimate_expires_at)<=now);
  const data:TrafficView|null=unsupported?{...assessment,risk:'possible-delay',estimated_arrival_from:null,estimated_arrival_until:null,estimate_basis:activeTrip?'location_unavailable':assessment.estimate_basis}:assessment;
  const callbacks=useRef({onSessionExpired,onUpdate});callbacks.current={onSessionExpired,onUpdate};
  useEffect(()=>{
    let live=true,busy=false,timer:number|undefined;
    setData(null);setError('');setLoading(true);callbacks.current.onUpdate(null);
    async function load(){
      if(!live||busy||document.visibilityState==='hidden')return;
      busy=true;setLoading(true);window.clearTimeout(timer);
      let failed=false;
      try {
        const result=await apiGet<TrafficView>(`/trips/${tripId}/traffic`);
        if(live){setData(result);setError('');callbacks.current.onUpdate(result);}
      } catch(reason){
        failed=true;
        if(live){
          if(reason instanceof ApiError&&reason.status===401)callbacks.current.onSessionExpired();
          setData(null);callbacks.current.onUpdate(null);
          setError(reason instanceof ApiError&&reason.status===409?'Trip changed. Waiting for updated details.':'Current traffic assessment is unavailable.');
        }
      } finally {busy=false;if(live){setLoading(false);timer=window.setTimeout(()=>void load(),failed||activeTrip?15000:60000);}}
    }
    refresh.current=()=>void load();
    void load();
    const visible=()=>{if(document.visibilityState==='visible')void load();};
    document.addEventListener('visibilitychange',visible);
    return()=>{live=false;window.clearTimeout(timer);document.removeEventListener('visibilitychange',visible);};
  },[tripId,version,activeTrip,locationAvailable]);
  const roadsOnly=data?.assessment_scope==='road-conditions';
  if(data?.state==='ended')return null;
  return <section className="trip-traffic" aria-label="Current traffic">
    <div className="trip-map-heading"><h3>Current traffic</h3></div>
    {error?<p className="trip-map-note trip-map-feedback" role="status"><span>{error}</span><RefreshButton label="Refresh traffic" busy={loading} onClick={()=>refresh.current()}/></p>
      :!data?<p className="trip-map-note" role="status">Checking traffic…</p>
      :data.state!=='current'?<p className="trip-map-note">Traffic is not available yet.</p>
      :<>
        {!roadsOnly&&<div className="trip-traffic-arrival"><span>Estimated arrival</span><strong>{data.estimated_arrival_from?`${arrival(data.estimated_arrival_from)}${data.estimated_arrival_until?arrival(data.estimated_arrival_until)!==arrival(data.estimated_arrival_from)?` – ${arrival(data.estimated_arrival_until)}`:'':' or later'}`:'Unavailable'}</strong>{data.estimate_basis==='location_unavailable'&&<span>Waiting for driver location</span>}</div>}
        <div className="trip-obstacles-heading"><h4>Road obstacles</h4><span>{data.incidents?.length??0}</span></div>
        {data.incidents?.length?<ol className="trip-obstacles">{data.incidents.map((incident,index)=>{
          const key=incidentKey(incident),report=incidentReport(incident.message);
          return <li key={key}><button type="button" className="trip-obstacle" aria-pressed={selectedIncident===key} onClick={()=>onSelectIncident(key)} aria-label={`Obstacle ${index+1}: ${incident.type}. ${report.message}`}>
            <span className="trip-obstacle-number" aria-hidden="true">{index+1}</span>
            <span className="trip-obstacle-content"><span className="trip-obstacle-title"><strong>{incident.type}</strong>{report.reported&&<span>{report.reported}</span>}</span><span className="trip-obstacle-message">{report.message}</span></span>
          </button></li>;
        })}</ol>:<p className="trip-map-note">No obstacles reported.</p>}
        <div className="trip-traffic-footer"><span>Speed data: {data.coverage_percent??0}% of route</span><span>Last checked: incidents {data.incidents_retrieved_at?time(data.incidents_retrieved_at):'—'} · speeds {data.speeds_retrieved_at?time(data.speeds_retrieved_at):'—'}</span></div>
      </>}
  </section>;
}
