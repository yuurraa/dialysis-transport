import { useEffect, useState } from 'react';
import { ApiError, apiGet } from '../../../shared/lib/api';
import { RefreshButton } from '../../../shared/ui/DashboardUI';

/** Current relationship names are loaded only through coordinator-authorised endpoints. */
export default function CoordinatorLinks({kind,id,onSessionExpired,refreshKey=0}:{kind:'patient'|'caregiver';id:string;onSessionExpired:()=>void;refreshKey?:number}){
  const [links,setLinks]=useState<{id:string;patient_name:string;caregiver_name?:string;active:boolean}[]|null>(null);
  const [error,setError]=useState(false),[retry,setRetry]=useState(0);
  useEffect(()=>{
    let live=true;setLinks(null);setError(false);
    const endpoint=kind==='patient'?`/profiles/caregiver-links?patient=${encodeURIComponent(id)}`:`/profiles/caregivers/${id}/links`;
    apiGet<{links:NonNullable<typeof links>}>(endpoint).then(result=>{if(live)setLinks(result.links.filter(link=>link.active));})
      .catch(reason=>{if(live){setError(true);if(reason instanceof ApiError&&reason.status===401)onSessionExpired();}});
    return()=>{live=false;};
  },[kind,id,retry,refreshKey,onSessionExpired]);
  return <section className="coordinator-links" aria-label={kind==='patient'?'Linked caregivers':'Linked patients'}>
    <h3>{kind==='patient'?'Linked caregivers':'Linked patients'}</h3>
    {error?<p className="trip-map-feedback" role="status"><span>Links could not be loaded.</span><RefreshButton label="Refresh links" onClick={()=>setRetry(value=>value+1)}/></p>:links===null?<p role="status">Loading links…</p>:links.length?<ul>{links.map(link=><li key={link.id}>{kind==='patient'?link.caregiver_name:link.patient_name}</li>)}</ul>:<p>None</p>}
  </section>;
}
