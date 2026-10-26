import { useEffect, useRef, useState } from 'react';
import { ApiError, apiGet } from '../lib/api';

export interface TrafficView {
  state:'current'|'ended'|'unassigned'|'not_due';
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
  speed_bands?:{linkId:string;roadName:string;speedBand:number;minimumSpeedKmh:number;maximumSpeedKmh:number;start:{latitude:number;longitude:number};end:{latitude:number;longitude:number}}[];
}
const arrival=(value:string)=>new Intl.DateTimeFormat('en-SG',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',timeZone:'Asia/Singapore'}).format(new Date(value));
const time=(value:string)=>new Intl.DateTimeFormat('en-SG',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Singapore'}).format(new Date(value));

/** Refresh observations while visible; failed reads never become a clear-road claim. */
export default function TripTraffic({tripId,version,activeTrip,locationAvailable,onSessionExpired,onUpdate}:{tripId:string;version:number;activeTrip:boolean;locationAvailable:boolean;onSessionExpired:()=>void;onUpdate:(value:TrafficView|null)=>void}) {
  const [assessment,setData]=useState<TrafficView|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true),[retry,setRetry]=useState(0);
  const [now,setNow]=useState(Date.now);
  useEffect(()=>{const timer=window.setInterval(()=>setNow(Date.now()),1000);return()=>window.clearInterval(timer);},[]);
  const unsupported=assessment?.state==='current'&&((activeTrip&&!locationAvailable)||!assessment.estimate_expires_at||Date.parse(assessment.estimate_expires_at)<=now);
  const data:TrafficView|null=unsupported?{...assessment,risk:'possible-delay',estimated_arrival_from:null,estimated_arrival_until:null,estimate_basis:activeTrip?'location_unavailable':assessment.estimate_basis}:assessment;
  const callbacks=useRef({onSessionExpired,onUpdate});callbacks.current={onSessionExpired,onUpdate};
  useEffect(()=>{
    let live=true,busy=false;
    setData(null);setError('');setLoading(true);callbacks.current.onUpdate(null);
    async function load(){
      if(busy||document.visibilityState==='hidden')return;
      busy=true;
      try {
        const result=await apiGet<TrafficView>(`/trips/${tripId}/traffic`);
        if(live){setData(result);setError('');callbacks.current.onUpdate(result);}
      } catch(reason){
        if(live){
          if(reason instanceof ApiError&&reason.status===401)callbacks.current.onSessionExpired();
          setData(null);callbacks.current.onUpdate(null);
          setError(reason instanceof ApiError&&reason.status===409?'Trip changed. Waiting for updated details.':'Current traffic assessment is unavailable.');
        }
      } finally {busy=false;if(live)setLoading(false);}
    }
    void load();
    const timer=window.setInterval(()=>void load(),activeTrip?15000:60000);
    const visible=()=>{if(document.visibilityState==='visible')void load();};
    document.addEventListener('visibilitychange',visible);
    return()=>{live=false;window.clearInterval(timer);document.removeEventListener('visibilitychange',visible);};
  },[tripId,version,retry,activeTrip,locationAvailable]);
  if(data?.state==='ended')return null;
  return <section className="trip-traffic" aria-label="Current traffic">
    <div className="trip-map-heading"><h3>Current traffic</h3>{data?.state==='current'&&<span className={`trip-status-badge ${data.risk==='at-risk'?'trip-status-unfilled':data.risk==='possible-delay'?'trip-status-at-risk':'trip-status-on-track'}`}>{data.risk==='at-risk'?'Arrival at risk':data.risk==='possible-delay'?'Possible delay':'No delay detected in observed sections'}</span>}</div>
    {error?<p className="trip-map-note" role="status">{error} <button type="button" disabled={loading} onClick={()=>setRetry(value=>value+1)}>Retry traffic</button></p>
      :!data?<p className="trip-map-note" role="status">Checking traffic…</p>
      :data.state==='not_due'?<p className="trip-map-note">Traffic assessment starts one hour before pickup. Current conditions cannot predict traffic on the trip date.</p>
      :data.state==='unassigned'?<p className="trip-map-note">Traffic assessment is available after a driver and pickup time are assigned.</p>
      :<>
        <dl className="schedule-detail-fields">
          <div><dt>Indicative arrival</dt><dd>{data.estimated_arrival_from?`${arrival(data.estimated_arrival_from)}${data.estimated_arrival_until?arrival(data.estimated_arrival_until)!==arrival(data.estimated_arrival_from)?` – ${arrival(data.estimated_arrival_until)}`:'':' or later'}`:'Unavailable'}</dd></div>
          <div><dt>Route with speed observations</dt><dd>{data.coverage_percent}%</dd></div>
        </dl>
        {data.estimate_basis==='location_unavailable'&&<p className="trip-map-note">A fresh location assessment is needed to estimate the remaining journey.</p>}
        {data.estimate_basis==='no_speed_coverage'&&<p className="trip-map-note">No matching speed observations are available for this route.</p>}
        {!!data.incidents?.length&&<ul className="trip-traffic-incidents">{data.incidents.map((incident,index)=><li key={`${incident.latitude}-${incident.longitude}-${index}`}><strong>{incident.type}</strong> · {incident.message}</li>)}</ul>}
        <p className="trip-map-note">Estimates assume {data.estimated_departure_at?`departure at ${time(data.estimated_departure_at)}`:'current departure'}. Uncovered sections use baseline timing; incident delays are not quantified. Bookings stay unchanged.</p>
        <p className="trip-map-note">LTA feeds retrieved: incidents {data.incidents_retrieved_at?time(data.incidents_retrieved_at):'—'} · speeds {data.speeds_retrieved_at?time(data.speeds_retrieved_at):'—'}.</p>
      </>}
  </section>;
}
