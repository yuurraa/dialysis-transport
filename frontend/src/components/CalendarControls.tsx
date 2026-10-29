import type { Trip } from '../pages/TripsPage';
import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import { apiGet, apiRequest, ApiError } from '../lib/api';
import { Overlay } from './DashboardUI';

interface CalendarState { configured:boolean; connected:boolean; status?:string; enabled?:boolean; minutes?:number|null; sync_status?:string }
interface Props { notify:(message:string)=>void; onSessionExpired:()=>void }
const timings=[{value:15,label:'15 minutes before'},{value:30,label:'30 minutes before'},{value:60,label:'1 hour before'},{value:120,label:'2 hours before'},{value:1440,label:'1 day before'}];
function message(reason:unknown) {
  return reason instanceof ApiError&&reason.code==='calendar_unconfigured'?'Google Calendar is not configured yet.':'Google Calendar is unavailable. Please try again.';
}
function useCalendar(path:string,{notify,onSessionExpired}:Props) {
  const [state,setState]=useState<CalendarState|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[attempt,setAttempt]=useState(0);
  const alive=useRef(false);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useEffect(()=>{
    let live=true;setError('');setState(null);
    apiGet<CalendarState>(path).then(value=>{if(live)setState(value);}).catch(reason=>{if(live){if(reason instanceof ApiError&&reason.status===401)onSessionExpired();setError(message(reason));}});
    return()=>{live=false;};
  },[path,attempt,onSessionExpired]);
  async function run(work:()=>Promise<void>) {
    if(busy)return;setBusy(true);setError('');
    try{await work();}catch(reason){if(alive.current){if(reason instanceof ApiError&&reason.status===401)onSessionExpired();setError(message(reason));}}finally{if(alive.current)setBusy(false);}
  }
  async function connect(){await run(async()=>{const result=await apiRequest<{url:string}>('/calendar/authorize','POST');if(alive.current)window.location.assign(result.url);});}
  return {state,setState,busy,error,setError,run,connect,reload:()=>setAttempt(value=>value+1),notify};
}

/** A separate opt-in connection: signing in never requests Calendar permission. */
export function CalendarConnection(props:Props) {
  const c=useCalendar('/calendar',props),[confirm,setConfirm]=useState(false);
  useEffect(()=>{
    const url=new URL(window.location.href),result=url.searchParams.get('calendar');if(!result)return;
    const ticket=url.searchParams.get('ticket');url.searchParams.delete('calendar');url.searchParams.delete('ticket');window.history.replaceState(window.history.state,'',url.pathname+url.search+url.hash);
    if(result==='confirm'&&ticket){
      void apiRequest('/calendar/confirm','POST',{ticket}).then(()=>{props.notify('Google Calendar connected.');c.reload();}).catch(reason=>{if(reason instanceof ApiError&&reason.status===401)props.onSessionExpired();props.notify('Calendar could not be connected. Sign in with the account that started the connection and try again.');});
    }else props.notify(result==='cancelled'?'Calendar connection cancelled.':result==='account_mismatch'?'Reconnect the same Google account, or disconnect the previous calendar first.':'Calendar could not be connected. Please try again.');
  },[props.notify,props.onSessionExpired]);
  async function disconnect(){await c.run(async()=>{const result=await apiRequest<CalendarState>('/calendar','DELETE');c.setState({...result,configured:true});setConfirm(false);props.notify('Calendar disconnecting. App reminders will be removed.');});}
  return <section className="dashboard-trips page-panel calendar-connection" aria-labelledby="calendar-title" onKeyDown={event=>{if(event.key==='Escape')event.stopPropagation();}}>
    <h2 id="calendar-title">Google Calendar</h2>
    <div className="calendar-connection-field">
      <p className="trip-map-note" role="status">{c.error||(!c.state?'Loading…':!c.state.configured?'Not configured':c.state.connected?'Connected':c.state.status==='disconnecting'?'Removing reminders and disconnecting…':c.state.status==='reconnect'?'Reconnect to resume reminders':'Not connected')}</p>
      <div className="patient-actions">{c.error?<button type="button" onClick={c.reload}>Retry</button>:c.state?.configured&&(c.state.connected?<button type="button" disabled={c.busy} onClick={()=>setConfirm(true)}>Disconnect</button>:c.state.status==='disconnecting'?<button type="button" onClick={c.reload}>Check Status</button>:<button type="button" className="patient-primary" disabled={c.busy} onClick={()=>void c.connect()}>{c.state.status==='reconnect'?'Reconnect':'Connect Google Calendar'}</button>)}</div>
    </div>
    {confirm&&createPortal(<Overlay title="Disconnect Google Calendar" onClose={()=>setConfirm(false)} busy={c.busy} error={c.error} onDismissError={()=>c.setError('')} footer={<><button type="button" className="button-danger" disabled={c.busy} onClick={()=>void disconnect()}>Disconnect</button><button type="button" disabled={c.busy} onClick={()=>setConfirm(false)}>Cancel</button></>}><p>Remove this app’s reminders from your calendar and disconnect?</p></Overlay>,document.body)}
  </section>;
}

export function CalendarEvent({trip,onClose,onSaved,...props}:Props&{trip:Trip;onClose:()=>void;onSaved?:(enabled:boolean)=>void}) {
  const c=useCalendar(`/calendar/trips/${trip.id}`,props),[minutes,setMinutes]=useState<number|null>(null);
  useEffect(()=>{if(c.state)setMinutes(c.state.minutes??null);},[c.state?.minutes]);
  async function save(enabled:boolean){await c.run(async()=>{await apiRequest(`/calendar/trips/${trip.id}`,'POST',{enabled,minutes});onSaved?.(enabled);props.notify(enabled?'Google Calendar event queued.':'Calendar event removal queued.');onClose();});}
  return <Overlay title="Google Calendar event" onClose={onClose} busy={c.busy} error={c.error} onDismissError={()=>c.setError('')} className="calendar-reminder-dialog" footer={<>
    {c.state?.configured&&!c.state.connected&&c.state.status!=='disconnecting'&&<button className="patient-primary" type="button" disabled={c.busy} onClick={()=>void c.connect()}>Connect Google Calendar</button>}
    {c.state?.connected&&<button className="patient-primary" type="button" disabled={c.busy} onClick={()=>void save(true)}>{c.state.enabled?'Save Event':'Add to Google Calendar'}</button>}
    {c.state?.connected&&c.state.enabled&&<button className="button-danger" type="button" disabled={c.busy} onClick={()=>void save(false)}>Remove Event</button>}
    {c.error&&<button type="button" onClick={c.reload}>Retry</button>}
    <button type="button" disabled={c.busy} onClick={onClose}>Close</button>
  </>}>
    {!c.state?<p className="trip-map-note" role="status">{c.error?'Calendar event could not be loaded.':'Loading…'}</p>:!c.state.configured?<p>Google Calendar is not configured yet.</p>:!c.state.connected?<p>{c.state.status==='disconnecting'?'Calendar is disconnecting.':'Connect your Google Calendar to add this trip as an event.'}</p>:<>
      <dl className="schedule-detail-fields"><div><dt>Event</dt><dd>{trip.lifecycle==='cancelled'?'Transport pickup (cancelled)':'Transport pickup'}</dd></div><div><dt>{trip.pickup_at?'Pickup':'Date'}</dt><dd>{new Intl.DateTimeFormat('en-SG',{dateStyle:'medium',...(trip.pickup_at?{timeStyle:'short' as const}:{}),timeZone:'Asia/Singapore'}).format(new Date(trip.pickup_at??`${trip.session_date}T00:00:00+08:00`))}</dd></div></dl>
      <div className="patient-form-fields"><div className="patient-field"><label htmlFor="calendar-event-notification">Notification</label><select id="calendar-event-notification" value={minutes??''} disabled={c.busy} onChange={event=>setMinutes(event.target.value===''?null:Number(event.target.value))}><option value="">None</option>{timings.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}</select></div></div>
      {!trip.pickup_at&&<p className="trip-map-note">All-day event · Pickup time to be confirmed.</p>}
      {c.state.enabled&&<p className="trip-map-note" role="status">{c.state.sync_status==='synced'?'Added to your calendar.':c.state.sync_status==='retry'?'Sync delayed. Retrying automatically.':c.state.sync_status==='reconnect'?'Reconnect Google Calendar to resume syncing.':'Waiting to sync.'}</p>}
    </>}
  </Overlay>;
}

/** The indicator only advertises an available action; GET and opening never create an event. */
export function CalendarEventButton({trip,...props}:Props&{trip:Trip}) {
  const [open,setOpen]=useState(false),[offered,setOffered]=useState(false);
  useEffect(()=>{
    let live=true;
    apiGet<CalendarState>(`/calendar/trips/${trip.id}`).then(state=>{if(live)setOffered(state.configured&&!state.enabled);}).catch(()=>{if(live)setOffered(false);});
    return()=>{live=false;};
  },[trip.id,trip.version]);
  return <>
    <button className="list-info-control calendar-event-control" type="button" aria-label={offered?'Add to Google Calendar':'Google Calendar event'} title={offered?'Add to Google Calendar':'Google Calendar event'} onClick={()=>setOpen(true)}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 11h18m-13 5h2m4 0h2"/></svg>
      {offered&&<span className="calendar-event-dot" aria-hidden="true"/>}
    </button>
    {open&&<CalendarEvent trip={trip} {...props} onClose={()=>setOpen(false)} onSaved={enabled=>setOffered(!enabled)}/>}
  </>;
}
