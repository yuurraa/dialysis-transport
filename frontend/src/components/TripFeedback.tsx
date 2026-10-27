import { useEffect, useRef, useState } from 'react';
import { ApiError, apiGet, apiRequest } from '../lib/api';
import { RefreshButton } from './DashboardUI';

interface Preference { driver_id:string|null; driver_name?:string|null; version:number }
interface Feedback { trip_id:string; driver_id:string; rating:number|null; can_prefer:boolean; preference:Preference }

/** Patients rate completed journeys; caregivers do not submit feedback on their behalf. */
export default function TripFeedback({tripId,notify,onSessionExpired}:{tripId:string;notify:(message:string)=>void;onSessionExpired:()=>void}) {
  const [data,setData]=useState<Feedback|null>(null),[draft,setDraft]=useState(0),[loading,setLoading]=useState(true);
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[retry,setRetry]=useState(0);
  const alive=useRef(false),working=useRef(false);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useEffect(()=>{
    let active=true;setLoading(true);setError('');
    apiGet<Feedback>(`/trips/${tripId}/feedback`).then(result=>{if(active){setData(result);setDraft(result.rating??0);}})
      .catch(reason=>{if(active){if(reason instanceof ApiError&&reason.status===401)onSessionExpired();setError('Driver feedback could not be loaded.');}})
      .finally(()=>{if(active)setLoading(false);});
    return()=>{active=false;};
  },[tripId,retry,onSessionExpired]);
  async function save(kind:'rating'|'preference',driverId:string|null=null){
    if(working.current||loading||!data||(kind==='rating'&&(!draft||data.rating!==null)))return;
    working.current=true;setBusy(true);
    try {
      if(kind==='rating'){
        const saved=await apiRequest<{rating:number}>(`/trips/${tripId}/rating`,'POST',{rating:draft});
        if(alive.current){setData(current=>current&&({...current,rating:saved.rating}));notify('Rating submitted.');}
      }else{
        const preference=await apiRequest<Preference>('/trips/driver-preference','PATCH',{driver_id:driverId,version:data.preference.version});
        if(alive.current){setData(current=>current&&({...current,preference}));notify(driverId?'Preferred driver updated.':'Driver preference removed.');}
      }
    }catch(reason){
      if(alive.current){
        if(reason instanceof ApiError&&reason.status===401)onSessionExpired();
        notify(reason instanceof ApiError&&reason.status===409?'Feedback or preference changed. Review the latest details.':'Your changes could not be saved. Please try again.');
        if(reason instanceof ApiError&&[403,404,409].includes(reason.status)){setData(null);setRetry(value=>value+1);}
      }
    }finally{working.current=false;if(alive.current)setBusy(false);}
  }
  return <section className="trip-detail-section trip-detail-assignment trip-feedback" aria-label="Driver feedback" aria-busy={loading||busy}>
    <h2>Driver feedback</h2>
    {loading?<p className="trip-map-note" role="status">Loading feedback…</p>:error?<p className="trip-map-note trip-map-feedback" role="status">{error}<RefreshButton label="Reload driver feedback" busy={loading} onClick={()=>setRetry(value=>value+1)}/></p>:data&&<>
      {data.rating!==null?<p className="trip-feedback-rating">Your rating: <strong>{data.rating} / 5</strong></p>:<div className="trip-feedback-form">
        <div className="trip-feedback-rating-row">
        <fieldset disabled={busy}><legend className="patient-required">Rate your driver</legend><div className="trip-rating-choices">{[1,2,3,4,5].map(value=><button key={value} type="button" className="trip-rating-choice" aria-label={`${value} ${value===1?'star':'stars'}`} aria-pressed={draft===value} data-filled={draft>=value} onClick={()=>setDraft(value)}>★</button>)}</div></fieldset>
        <button type="button" className="patient-primary" disabled={busy||!draft} onClick={()=>void save('rating')}>Submit rating</button>
        </div><p className="trip-map-note trip-feedback-note">Ratings cannot be changed once submitted.</p>
      </div>}
      <div className="trip-feedback-preference"><p>Preferred driver: <strong>{data.preference.driver_name??'None'}</strong></p><div className="patient-actions">
        {data.can_prefer&&data.preference.driver_id!==data.driver_id&&<button type="button" disabled={busy} onClick={()=>void save('preference',data.driver_id)}>Make this driver preferred</button>}
        {data.preference.driver_id&&<button type="button" disabled={busy} onClick={()=>void save('preference')}>Remove preference</button>}
      </div></div>
    </>}
  </section>;
}
