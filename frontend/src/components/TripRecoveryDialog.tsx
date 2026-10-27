import { useEffect, useRef, useState } from 'react';
import { Overlay } from './DashboardUI';
import { ApiError, apiGet, apiRequest } from '../lib/api';
import type { Trip } from '../pages/TripsPage';

interface RecoveryOption { id:string;driver_id:string;vehicle_id?:string;driver_name:string;plate:string;make:string;model:string;pickup_at:string;dropoff_at:string;duration_minutes:number;same_driver:boolean;expires_at:string;estimated_duration?:boolean;buffer_minutes?:number;preferred?:boolean;continuity?:boolean }
interface RecoveryOptions { trip:Trip;options:RecoveryOption[];critical:boolean;handover_origin?:string|null }
const time=(value:string)=>new Intl.DateTimeFormat('en-SG',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',timeZone:'Asia/Singapore'}).format(new Date(value));

/** Proposals do not release the original booking. Approval rechecks traffic and resources. */
export default function TripRecoveryDialog({trip,onClose,onChanged,onAssessed,onSessionExpired}:{trip:Trip;onClose:()=>void;onChanged:(trip:Trip)=>void;onAssessed:(trip:Trip)=>void;onSessionExpired:()=>void}){
  const [current,setCurrent]=useState(trip),[data,setData]=useState<RecoveryOptions|null>(null);
  const handover=trip.lifecycle==='in-progress';
  const [origin,setOrigin]=useState(''),[safeConfirmed,setSafeConfirmed]=useState(false);
  const [loading,setLoading]=useState(!handover),[busy,setBusy]=useState(false),[error,setError]=useState(''),[conflict,setConflict]=useState(false);
  const [assessmentError,setAssessmentError]=useState('');
  const [selected,setSelected]=useState(''),[now,setNow]=useState(Date.now);
  const alive=useRef(false),working=useRef(false);
  const callbacks=useRef({onChanged,onAssessed,onSessionExpired});callbacks.current={onChanged,onAssessed,onSessionExpired};
  function failure(reason:unknown,assessment=false){
    if(reason instanceof ApiError&&reason.status===401)callbacks.current.onSessionExpired();
    const stale=reason instanceof ApiError&&[404,409].includes(reason.status);setConflict(stale);
    const message=stale?'Trip or resources changed. Refresh the options.':reason instanceof ApiError&&reason.status===400?'This trip is not eligible for recovery.':'Recovery options are currently unavailable.';
    if(assessment)setAssessmentError(message);else setError(message);
  }
  async function generate(reload=false){
    if(handover&&!origin.trim())return;
    if(working.current)return;working.current=true;setLoading(true);setError('');setAssessmentError('');setSelected('');setData(null);
    setSafeConfirmed(false);
    try{
      const latest=reload?await apiGet<Trip>(`/trips/${trip.id}`):current;
      if(!alive.current)return;
      setCurrent(latest);
      const result=await apiRequest<RecoveryOptions>(`/trips/${trip.id}/recovery-options`,'POST',{version:latest.version,...(handover?{handover_origin:origin.trim()}:{})});
      if(!alive.current)return;
      setData(result);setCurrent(result.trip);setConflict(false);setNow(Date.now());callbacks.current.onAssessed(result.trip);
    }catch(reason){if(alive.current)failure(reason,true);}
    finally{working.current=false;if(alive.current)setLoading(false);}
  }
  useEffect(()=>{
    alive.current=true;
    const start=handover?undefined:window.setTimeout(()=>void generate(),0),clock=window.setInterval(()=>setNow(Date.now()),1000);
    return()=>{alive.current=false;window.clearTimeout(start);window.clearInterval(clock);};
  },[trip.id]);
  const option=data?.options.find(row=>row.id===selected);
  const drivers=new Map<string,RecoveryOption[]>();
  for(const row of data?.options??[]){
    const key=JSON.stringify([row.driver_id,row.vehicle_id??row.plate]);
    const choices=drivers.get(key);
    if(choices)choices.push(row);else drivers.set(key,[row]);
  }
  const expired=!!option&&Date.parse(option.expires_at)<=now;
  async function approve(){
    if(!option||expired||working.current||(handover&&!safeConfirmed))return;working.current=true;setBusy(true);setError('');
    try{
      const saved=await apiRequest<Trip>(`/trips/${trip.id}/recovery-approval`,'POST',{option_id:option.id,version:current.version,...(handover?{safe_pickup_confirmed:safeConfirmed}:{})});
      if(alive.current)callbacks.current.onChanged(saved);
    }catch(reason){if(alive.current)failure(reason);}
    finally{working.current=false;if(alive.current)setBusy(false);}
  }
  return <Overlay title={handover?'Safe handover':'Recovery options'} description={current.patient_name} className="trip-recovery-dialog" busy={busy} onClose={onClose} error={error} onDismissError={()=>setError('')} footer={<>
    {(!handover||data)&&<button type="button" className="patient-primary" disabled={loading||busy||!option||expired||conflict||(handover&&!safeConfirmed)} onClick={()=>void approve()}>{busy?'Approving…':handover?'Approve handover':'Approve recovery'}</button>}
    <button type="button" className={handover&&!data?'patient-primary':undefined} disabled={busy||loading||(handover&&!origin.trim())} onClick={()=>void generate(true)}>{handover&&!data?'Find replacements':'Refresh options'}</button><button type="button" disabled={busy} onClick={onClose}>Close</button>
  </>}>
    {handover&&<div className="patient-field trip-handover-field"><label className="patient-required" htmlFor="handover-origin">Safe pickup point</label><input id="handover-origin" required maxLength={500} disabled={busy||loading} value={origin} onChange={event=>{setOrigin(event.target.value);setData(null);setSelected('');setSafeConfirmed(false);setAssessmentError('');}} placeholder="Address or postal code"/></div>}
    {loading?<p role="status">Finding recovery options…</p>:assessmentError?<p role="status">{assessmentError}</p>:data?.options.length?<fieldset className="trip-recovery-options"><legend className="sr-only">Choose a recovery option</legend>{Array.from(drivers,([key,choices])=>{
      const driver=choices[0];
      return <div key={key} className="trip-recovery-driver">
        <div className="trip-recovery-driver-heading"><strong>{driver.driver_name}{driver.same_driver?' · Same driver':driver.preferred?' · Preferred driver':driver.continuity?' · Previous driver':''}</strong><span>{driver.plate} · {driver.make} {driver.model}</span></div>
        {choices.map(row=><label key={row.id} className="trip-recovery-option"><input type="radio" name="recovery-option" value={row.id} aria-label={`${driver.driver_name}, ${driver.plate}, pickup ${time(row.pickup_at)}, arrival ${time(row.dropoff_at)}`} checked={selected===row.id} disabled={busy} onChange={()=>setSelected(row.id)}/><span><span>Pickup {time(row.pickup_at)} → Arrival {time(row.dropoff_at)}</span><span>{row.duration_minutes} min{row.estimated_duration?` approx. (includes ${row.buffer_minutes} min buffer)`:null}</span></span></label>)}
      </div>;
    })}</fieldset>:data?<p role="status">No feasible recovery options. Manual coordination is required.</p>:null}
    {expired&&<p className="trip-map-note" role="status">Options expired. Refresh before approving.</p>}
    {handover&&data?.options.length?<label className="trip-handover-confirm"><input type="checkbox" checked={safeConfirmed} disabled={busy||loading} onChange={event=>setSafeConfirmed(event.target.checked)}/><span>I confirm the patient is at this safe pickup point and the current driver can be released.</span></label>:null}
  </Overlay>;
}
