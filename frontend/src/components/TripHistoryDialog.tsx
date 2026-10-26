import { useEffect, useState } from 'react';
import { ApiError, apiGet } from '../lib/api';
import { ListError, Overlay } from './DashboardUI';

interface HistoryEvent { id: string; event: string; actor: string; created_at: string }
interface HistoryPage { events: HistoryEvent[]; total: number; page: number; pageSize: number }
const labels: Record<string,string> = {
  started:'Trip started',completed:'Trip completed',traffic_risk_detected:'Traffic disruption reported',driver_unavailable:'Driver unavailable',generated:'Trip added',refreshed:'Trip details updated',requirements_changed:'Requirements changed',deleted:'Trip deleted',
  restored:'Trip restored',schedule_change_approved:'Schedule change approved',assigned:'Driver assigned',unassigned:'Driver unassigned',confirmed:'Pickup confirmed',cancelled:'Trip cancelled',
};
const actors: Record<string,string> = {coordinator:'Transport coordinator',patient:'Patient',driver:'Driver',caregiver:'Caregiver',system:'System'};
const timestamp = (value: string) => new Intl.DateTimeFormat('en-SG',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Singapore'}).format(new Date(value));

export default function TripHistoryDialog({tripId,onClose,onSessionExpired}:{tripId:string;onClose:()=>void;onSessionExpired:()=>void}) {
  const [page,setPage]=useState(1);
  const [data,setData]=useState<HistoryPage|null>(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState(false);
  const [retry,setRetry]=useState(0);
  useEffect(()=>{
    let active=true;setLoading(true);setError(false);
    apiGet<HistoryPage>(`/trips/${tripId}/history?page=${page}`).then(value=>{if(active)setData(value);})
      .catch(reason=>{if(!active)return;setError(true);if(reason instanceof ApiError&&reason.status===401)onSessionExpired();})
      .finally(()=>{if(active)setLoading(false);});
    return()=>{active=false;};
  },[tripId,page,retry,onSessionExpired]);
  return <Overlay title="Trip history" onClose={onClose} className="trip-history-dialog" footer={<><button type="button" aria-label="Previous history page" disabled={loading||page===1} onClick={()=>setPage(value=>value-1)}>‹</button><button type="button" aria-label="Next history page" disabled={loading||error||!data||page*data.pageSize>=data.total} onClick={()=>setPage(value=>value+1)}>›</button><button type="button" onClick={onClose}>Close</button></>}>
    {loading?<p role="status">Loading history…</p>:error?<ListError title="History could not be loaded" message="Please try again to view this trip’s events." onRetry={()=>setRetry(value=>value+1)}/>:data?.events.length?<ol className="trip-history-list">{data.events.map(event=><li key={event.id}><strong>{labels[event.event]??'Trip updated'}</strong><span>{actors[event.actor]??'Authorised user'}</span><time dateTime={event.created_at}>{timestamp(event.created_at)}</time></li>)}</ol>:<p>No trip events recorded.</p>}
  </Overlay>;
}
