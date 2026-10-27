import { useEffect, useRef, useState } from 'react';
import { apiGet, apiRequest, ApiError } from '../lib/api';
import { watchDriverLocation } from '../lib/location';
import type { Trip } from '../pages/TripsPage';
import { Overlay, RefreshButton } from './DashboardUI';
import TripRouteMap, { type TrackingPoint } from './TripRouteMap';

interface Progress { trip:Trip; sharing:boolean; location:TrackingPoint|null }
const timestamp=(value:string)=>new Intl.DateTimeFormat('en-SG',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Singapore'}).format(new Date(value));

/** Location consent is separate from execution; failure to share never blocks the trip. */
export default function TripProgress({trip,driver,onChanged,onUnavailable,onSessionExpired,onNotify,display='journey'}:{display?:'overview'|'journey';trip:Trip;driver:boolean;onChanged:(trip:Trip)=>void;onNotify:(message:string,urgent:boolean)=>void;onUnavailable:()=>void;onSessionExpired:()=>void}) {
  const [progress,setProgress]=useState<Progress|null>(null);
  const [readError,setReadError]=useState(false);
  const [retry,setRetry]=useState(0);
  const [action,setAction]=useState<'start'|'complete'|null>(null);
  const [busy,setBusy]=useState(false);
  const [conflict,setConflict]=useState(false);
  const [actionError,setActionError]=useState('');
  const [sharingBusy,setSharingBusy]=useState(false);
  const [session,setSession]=useState<string|null>(null);
  const [pendingStop,setPendingStop]=useState<string|null>(null);
  const [now,setNow]=useState(Date.now);
  const callbacks=useRef({onChanged,onUnavailable,onSessionExpired,onNotify});callbacks.current={onChanged,onUnavailable,onSessionExpired,onNotify};
  const active=useRef(false);
  const sequence=useRef(0);
  const latestTrip=useRef(trip);if(trip.version>=latestTrip.current.version)latestTrip.current=trip;
  const version=useRef(trip.version);version.current=Math.max(version.current,trip.version);
  const busyRef=useRef(busy);busyRef.current=busy;
  const currentSession=useRef(session);currentSession.current=session;
  const closing=useRef(new Set<string>());
  useEffect(()=>{active.current=true;return()=>{active.current=false;sequence.current++;};},[]);
  function setToast(message:string){callbacks.current.onNotify(message,!['Trip started.','Trip completed.'].includes(message));}
  function accept(result:Progress){
    if(result.trip.version<version.current)return;
    version.current=result.trip.version;latestTrip.current=result.trip;setProgress(result);setReadError(false);callbacks.current.onChanged(result.trip);
    if(result.trip.lifecycle!=='in-progress')setSession(null);
  }
  useEffect(()=>{
    let live=true;
    async function load(){
      if(document.visibilityState!=='visible'||busyRef.current||closing.current.size)return;
      const request=++sequence.current;
      try {
        const result=await apiGet<Progress>(`/trips/${trip.id}/progress`);
        if(live&&request===sequence.current)accept(result);
      } catch(reason){
        if(!live||request!==sequence.current)return;
        setReadError(true);setProgress(null);setSession(null);
        if(reason instanceof ApiError&&reason.status===401)callbacks.current.onSessionExpired();
        else if(reason instanceof ApiError&&[403,404].includes(reason.status))callbacks.current.onUnavailable();
      }
    }
    void load();const timer=window.setInterval(()=>{setNow(Date.now());void load();},5000);
    const visible=()=>{if(document.visibilityState==='visible')void load();else setSession(null);};
    document.addEventListener('visibilitychange',visible);
    return()=>{live=false;window.clearInterval(timer);document.removeEventListener('visibilitychange',visible);};
  },[trip.id,retry]);

  async function clearSession(id:string,quiet=false){
    if(closing.current.has(id))return;
    closing.current.add(id);sequence.current++;
    try {
      await apiRequest(`/trips/${trip.id}/sharing`,'DELETE',{sharing_id:id});
      sequence.current++;
      if(active.current){setPendingStop(old=>old===id?null:old);if(!currentSession.current||currentSession.current===id)setProgress(old=>old?{...old,sharing:false,location:null}:old);}
    } catch {
      if(active.current&&!quiet){setPendingStop(id);setToast('Sharing stopped on this device, but the last point could not be cleared. Please retry.');}
    } finally {closing.current.delete(id);}
  }
  useEffect(()=>{
    if(!session||latestTrip.current.lifecycle!=='in-progress')return;
    let live=true,sending=false,lastSent=0;
    const stop=watchDriverLocation(point=>{
      if(!live||sending||document.visibilityState!=='visible'||Date.now()-lastSent<5000)return;
      sending=true;lastSent=Date.now();
      void apiRequest(`/trips/${trip.id}/location`,'POST',{sharing_id:session,latitude:point.latitude,longitude:point.longitude,accuracy_metres:point.accuracyMetres,recorded_at:point.recordedAt})
        .catch(reason=>{
          if(!live||latestTrip.current.lifecycle!=='in-progress')return;
          if(reason instanceof ApiError&&reason.status===401)callbacks.current.onSessionExpired();
          if(reason instanceof ApiError&&[403,404,409].includes(reason.status))setSession(null);
          setToast('Location could not be updated. Your trip is still in progress.');
        }).finally(()=>{sending=false;});
    },message=>{if(live&&latestTrip.current.lifecycle==='in-progress'){setSession(null);setToast(message);}});
    return()=>{live=false;stop();void clearSession(session);};
  },[session,trip.id]);

  async function beginSharing(){
    if(sharingBusy||session)return;
    setSharingBusy(true);
    try {
      const result=await apiRequest<{sharing_id:string}>(`/trips/${trip.id}/sharing`,'POST',{});
      if(!active.current||document.visibilityState!=='visible'||latestTrip.current.lifecycle!=='in-progress'){void clearSession(result.sharing_id,true);return;}
      sequence.current++;setSession(result.sharing_id);setPendingStop(null);setProgress(old=>old?{...old,sharing:true,location:null}:old);
    } catch(reason){
      if(active.current){setToast('Location sharing could not be started. Please try again.');if(reason instanceof ApiError&&reason.status===401)callbacks.current.onSessionExpired();}
    } finally {if(active.current)setSharingBusy(false);}
  }
  async function execute(reloadOnly=false){
    if(!action||busy)return;
    setBusy(true);sequence.current++;setActionError('');
    try {
      const saved=reloadOnly?await apiGet<Trip>(`/trips/${trip.id}`):await apiRequest<Trip>(`/trips/${trip.id}/${action}`,'PATCH',{version:version.current});
      if(!active.current)return;
      accept({trip:saved,sharing:progress?.sharing??false,location:progress?.location??null});setConflict(false);
      if(!reloadOnly){setAction(null);setToast(action==='start'?'Trip started.':'Trip completed.');if(action==='complete'){setSession(null);setProgress({trip:saved,sharing:false,location:null});}}
    } catch(reason){
      if(!active.current)return;
      if(reason instanceof ApiError&&reason.status===401)callbacks.current.onSessionExpired();
      setConflict(reason instanceof ApiError&&[400,404,409].includes(reason.status));
      setActionError(reason instanceof ApiError&&reason.status===400?'This trip is not ready for this action. Check its pickup time and assignment.':reason instanceof ApiError&&reason.status===409?'This trip changed. Reload before continuing.':'The trip could not be updated. Please try again.');
    } finally {if(active.current)setBusy(false);}
  }
  const current=progress&&progress.trip.version>=trip.version?progress.trip:trip;
  const running=current.lifecycle==='in-progress';
  const canStart=driver&&(!current.lifecycle||current.lifecycle==='scheduled')&&!!current.assigned_driver_id&&!current.driver_unavailable_at&&!current.review_required&&!!current.pickup_at&&Date.parse(current.pickup_at)<=now;
  const location=running&&!readError?progress?.location??null:null;
  const stale=!!location&&(now-Date.parse(location.recorded_at)>30000||now-Date.parse(location.received_at)>30000);
  return <>
    {display==='journey'&&(current.started_at||current.completed_at||current.handover_at||running||driver&&(canStart||pendingStop))&&<section className="trip-progress" aria-label="Journey progress">
        {(current.started_at||current.completed_at)&&<dl className="schedule-detail-fields">{current.started_at&&<div><dt>Started</dt><dd>{timestamp(current.started_at)}</dd></div>}{current.completed_at&&<div><dt>Completed</dt><dd>{timestamp(current.completed_at)}</dd></div>}</dl>}
        {current.handover_at&&current.lifecycle==='scheduled'&&<p className="trip-map-note" role="status">Awaiting replacement pickup.</p>}
        {running&&<p className="trip-map-note" role="status">{readError?'Location unavailable.':location?`${stale?'Last known location':'Location updated'}: ${timestamp(location.received_at)} · Accuracy ±${Math.round(location.accuracy_metres)} m`:progress?.sharing?'Waiting for the driver’s location.':'Location is not being shared.'}</p>}
      {driver&&<div className="patient-actions trip-progress-actions">{canStart&&<button className="patient-primary" type="button" onClick={()=>{setAction('start');setConflict(false);setActionError('');}}>Start trip</button>}{running&&<>
        <button className="patient-primary" type="button" onClick={()=>{setAction('complete');setConflict(false);setActionError('');}}>Complete trip</button>
        <button type="button" disabled={sharingBusy||readError} onClick={()=>{if(session){const old=session;setSession(null);void clearSession(old);}else void beginSharing();}}>{sharingBusy?'Starting sharing…':session?'Stop sharing':'Share location'}</button>
      </>}{pendingStop&&<button type="button" onClick={()=>void clearSession(pendingStop)}>Retry stop sharing</button>}</div>}
    </section>}
    {display!=='overview'&&<TripRouteMap tripId={trip.id} routeKey={JSON.stringify([current.origin,current.destination])} version={current.version} activeTrip={running} location={location} locationStale={stale} onSessionExpired={onSessionExpired}/>}
    {display==='journey'&&readError&&<p className="trip-map-note trip-map-feedback trip-progress-feedback" role="status"><span>Progress unavailable.</span><RefreshButton label="Refresh progress" onClick={()=>setRetry(value=>value+1)}/></p>}
    {action&&<Overlay title={action==='start'?'Start trip':'Complete trip'} description={current.patient_name} busy={busy} onClose={()=>setAction(null)} error={actionError} onDismissError={()=>setActionError('')} footer={<><button className="patient-primary" type="button" disabled={busy||(!conflict&&(action==='start'?!canStart:!running))} onClick={()=>void execute(conflict)}>{busy?'Saving…':conflict?'Reload trip':action==='start'?'Start trip':'Complete trip'}</button><button type="button" disabled={busy} onClick={()=>setAction(null)}>Back</button></>}>
      <dl className="schedule-detail-fields"><div><dt>From</dt><dd>{current.origin}</dd></div><div><dt>To</dt><dd>{current.destination}</dd></div></dl>
      <p className="trip-action-note">{action==='start'?'Start this assigned journey now? Location sharing is a separate choice.':'Confirm that this journey has finished? Location sharing will stop.'}</p>
    </Overlay>}
  </>;
}
