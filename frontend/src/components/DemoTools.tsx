import { tripNow, type TripClock } from '../lib/tripClock';
import { useEffect, useRef, useState } from 'react';
import { Overlay } from './DashboardUI';
import { apiRequest, ApiError } from '../lib/api';
import { supabase } from '../lib/supabase';
import { setDemoSession, type DemoSession } from '../lib/demoSession';
import type { Account } from '../pages/AccountPanel';
import { roleNames } from '../pages/AccountPanel';

interface DemoState {
  actors:(Account&{auth_user_id:string|null})[];
  visible_actor_ids?:string[];
  scenario:{trip_id:string;traffic:'normal'|'delay';progress:number}|null;
  trip:TripClock&{id:string;lifecycle:string;assigned_driver_id:string|null;pickup_at:string|null;confirmed_at:string|null}|null;
}

/** Controls always use the original coordinator token, never the selected actor token. */
export default function DemoTools({account,open,onClose,onOpen,onNavigate,notify}:{account:Account;open:boolean;onClose:()=>void;onOpen:()=>void;onNavigate:(path:string)=>void;notify:(message:string)=>void}) {
  const accessOwner=account.demo_access_owner_id??account.demo_owner_id;
  const demo=Boolean(accessOwner);
  const [state,setState]=useState<DemoState|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [now,setNow]=useState(Date.now);
  const [confirmReset,setConfirmReset]=useState(false),[playing,setPlaying]=useState(false),[percent,setPercent]=useState(0);
  const alive=useRef(true),locked=useRef(false),reads=useRef(0),latest=useRef(state);latest.current=state;
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  async function request<T>(path:string,body?:unknown):Promise<T>{
    const token=(await supabase?.auth.getSession())?.data.session?.access_token;
    if(!alive.current)throw new DOMException('Demo controls closed.','AbortError');
    if(!token)throw new ApiError(401);
    return apiRequest<T>(path,body===undefined?'GET':'POST',body,token);
  }
  function failure(reason:unknown){
    setPlaying(false);
    const text=reason instanceof ApiError&&reason.code==='demo_disabled'?'Demo tools are disabled on this server.'
      :reason instanceof ApiError&&reason.code==='dummy_seed_missing'?'Apply the updated database seed before preparing these accounts.'
      :reason instanceof ApiError&&reason.status===403?'Demo administrator access is no longer available.'
      :reason instanceof ApiError&&reason.code==='demo_action_unavailable'?'This action is unavailable. Check the trip, assignment and availability, then try again.'
      :'Demo tools could not be loaded. Please try again.';
    setError(text);
  }
  useEffect(()=>{
    if(!open&&!demo)return;
    let live=true;const read=++reads.current;setError('');setBusy(true);
    request<DemoState>('/demo').then(result=>{if(live&&read===reads.current){setState(result);setNow(Date.now());setPercent(result.scenario?.progress??0);}}).catch(reason=>{if(live&&read===reads.current)failure(reason);}).finally(()=>{if(live&&read===reads.current)setBusy(false);});
    return()=>{live=false;};
  },[open,demo]);
  useEffect(()=>{
    if(!open&&!demo)return;
    const timer=window.setInterval(()=>setNow(Date.now()),1000);
    return()=>window.clearInterval(timer);
  },[open,demo]);
  const demoTime=state?.trip?.demo_clock_at?new Intl.DateTimeFormat('en-SG',{dateStyle:'full',timeStyle:'medium',timeZone:'Asia/Singapore'}).format(tripNow(state.trip,now)):null;
  // Closing the controls reveals the map; the visible strip retains Pause.
  // Hidden tabs, switches, completion and unmounting stop the player.
  useEffect(()=>{
    if(!playing)return;
    const stopHidden=()=>{if(document.visibilityState!=='visible')setPlaying(false);};
    document.addEventListener('visibilitychange',stopHidden);
    const timer=window.setInterval(()=>{
      if(document.visibilityState!=='visible'){setPlaying(false);return;}
      const next=Math.min(100,(latest.current?.scenario?.progress??0)+5);
      void control('move',{percent:next});
      if(next===100)setPlaying(false);
    },5000);
    return()=>{window.clearInterval(timer);document.removeEventListener('visibilitychange',stopHidden);};
  },[playing]);
  async function run(work:()=>Promise<void>){
    if(locked.current||!alive.current)return;
    locked.current=true;reads.current++;setBusy(true);setError('');
    try{await work();}catch(reason){if(alive.current)failure(reason);}finally{locked.current=false;if(alive.current)setBusy(false);}
  }
  async function setup(){await run(async()=>{const result=await request<DemoState>('/demo/setup',{});if(alive.current){setState(result);setNow(Date.now());setPercent(result.scenario?.progress??0);notify('Demo scenario ready. Assign its trip as coordinator.');}});}
  async function switchActor(actor:Account){
    setPlaying(false);
    await run(async()=>{
      const result=await request<DemoSession>('/demo/switch',{account_id:actor.id});
      if(!alive.current)return;
      onClose();setDemoSession(result);onNavigate('/dashboard/trips');
    });
  }
  function returnToCoordinator(){setPlaying(false);onClose();setDemoSession(null);onNavigate('/dashboard/trips');}
  async function control(action:string,extra:Record<string,unknown>={}){
    await run(async()=>{
      const result=await request<DemoState>('/demo/control',{action,...extra});
      if(!alive.current)return;
      setState(result);setNow(Date.now());setPercent(result.scenario?.progress??0);
      if(action!=='move')window.dispatchEvent(new Event('demo-trip-changed'));
      if(action==='reset'){setConfirmReset(false);setPlaying(false);notify('Demo reset. Assign the new trip to begin again.');}
      else if(action==='due')notify('Demo time advanced to pickup. The assigned driver can start the trip.');
    });
  }
  return <>
    {demo&&<aside className="demo-session-strip" aria-label="Demo session"><span><strong>Demo</strong> · {account.display_name}{demoTime&&<> · {demoTime} SGT</>}</span><div>{playing&&<button type="button" onClick={()=>setPlaying(false)}>Pause Movement</button>}<button type="button" onClick={onOpen}>Controls</button><button type="button" onClick={returnToCoordinator}>Return</button></div></aside>}
    {open&&<Overlay title="Demo Tools" onClose={onClose} busy={busy} error={error} onDismissError={()=>setError('')} className="demo-tools-dialog" footer={<>
      {state?.scenario&&<button type="button" className={`demo-reset-control${confirmReset?' button-danger':''}`} disabled={busy} onClick={()=>{setPlaying(false);if(confirmReset)void control('reset',{confirmed:true});else setConfirmReset(true);}}>{confirmReset?'Confirm Reset':'Reset Scenario'}</button>}
      {confirmReset&&<button type="button" disabled={busy} onClick={()=>setConfirmReset(false)}>Cancel</button>}
      <button type="button" onClick={onClose} disabled={busy}>Close</button>
    </>}>
      {!state?.scenario?<div className="demo-tools-empty"><p>Prepare the seeded accounts and a trip for the walkthrough.</p><div className="patient-actions"><button type="button" className="patient-primary" disabled={busy||!!error} onClick={()=>void setup()}>{busy?'Preparing…':'Prepare Demo'}</button>{error&&<button type="button" onClick={()=>{setError('');void setup();}}>Retry</button>}</div></div>:<>
        <section className="demo-tools-section">
          {state.actors.some(actor=>actor.auth_user_id!==actor.id)&&<div className="demo-tools-empty"><p>Some demo accounts are not ready yet.</p><div className="patient-actions"><button type="button" disabled={busy} onClick={()=>void setup()}>Finish Demo Setup</button></div></div>}
          <div className="patient-form-fields"><div className="patient-field patient-form-wide"><label htmlFor="demo-account">View as</label><select id="demo-account" value={account.id} disabled={busy} onChange={event=>{const target=event.target.value;if(target===(accessOwner??account.id))returnToCoordinator();else{const actor=state.actors.find(row=>row.id===target);if(actor)void switchActor(actor);}}}>
            <option value={accessOwner??account.id}>Your coordinator account</option>
            {state.actors.map(actor=><option key={actor.id} value={actor.id} disabled={actor.status!=='active'||actor.auth_user_id!==actor.id}>{actor.display_name} · {roleNames[actor.role]}</option>)}
          </select></div></div>
        </section>
        {demoTime&&<p className="trip-map-note" role="status">Demo time · {demoTime} SGT · {state.trip?.demo_clock_started_at?'Running':'Paused'}</p>}
        <section className="demo-tools-section demo-tools-row"><div><h3>Scenario</h3><p className="trip-map-note">{state.trip?.lifecycle==='in-progress'?'In progress':state.trip?.lifecycle==='completed'?'Completed':state.trip?.lifecycle==='cancelled'?'Cancelled':state.trip?.assigned_driver_id?'Driver assigned':'Awaiting assignment'}{state.trip?.confirmed_at?' · Acknowledged':''}</p></div><div className="patient-actions">
          <button type="button" disabled={busy||!state.trip||(demo&&!state.visible_actor_ids?.includes(account.id))} onClick={()=>{onClose();onNavigate(`/dashboard/trips/${state.trip!.id}`);}}>Open Trip</button>
          <button type="button" disabled={busy||!state.trip?.assigned_driver_id||state.trip.lifecycle!=='scheduled'} onClick={()=>void control('due')}>Make Pickup Due</button>
        </div></section>
        <p className="trip-map-note">Make pickup due advances demo time to the assigned pickup without changing the booking. Time then runs at normal speed.</p>
        <section className="demo-tools-section demo-tools-row"><h3>Simulated traffic</h3><div className="patient-actions">{(['normal','delay'] as const).map(value=><button type="button" key={value} aria-pressed={state.scenario?.traffic===value} disabled={busy||!['scheduled','in-progress'].includes(state.trip?.lifecycle??'')} onClick={()=>void control('traffic',{scenario:value})}>{value==='normal'?'Normal':'15-Minute Delay'}</button>)}</div></section>
        <section className="demo-tools-section"><h3>Simulated movement</h3><div className="demo-movement-controls"><div className="demo-position-field"><label className="demo-position-label" htmlFor="demo-route-position">Route position · {percent}%</label><input id="demo-route-position" type="range" min="0" max="100" step="5" value={percent} disabled={busy||playing||state.trip?.lifecycle!=='in-progress'} onChange={event=>setPercent(Number(event.target.value))}/></div><div className="patient-actions"><button type="button" disabled={busy||playing||state.trip?.lifecycle!=='in-progress'} onClick={()=>void control('move',{percent})}>Set Position</button><button type="button" disabled={busy||state.trip?.lifecycle!=='in-progress'} onClick={()=>setPlaying(value=>!value)}>{playing?'Pause':'Play Movement'}</button></div></div></section>
        {confirmReset&&<p className="demo-reset-note" role="status">Reset this demo trip? The current run will be archived. Real records are unchanged.</p>}
      </>}
    </Overlay>}
  </>;
}
