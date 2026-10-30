import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, apiGet, apiRequest } from '../../../shared/lib/api';
import { InfoButton, ListError, ListToolbar, Overlay, PageHeading, SortOverlay, sortSummary } from '../../../shared/ui/DashboardUI';
import { useDashboardViewState } from '../../../app/components/DashboardViewState';

interface Link { id:string;patient_id:string;patient_name:string;caregiver_id:string;caregiver_name:string;active:boolean;version:number;authorised_at:string }
interface Invitation { code:string;expires_at:string }
interface Preview { caregiver_id:string;full_name:string;display_name:string;expires_at:string }
type Role='patient'|'caregiver'|'coordinator';
const sortOptions=[{value:'name',label:'Name'},{value:'authorised_at',label:'Linked date',ascending:'Oldest first',descending:'Newest first'}];
const linkedDate=(value:string)=>new Intl.DateTimeFormat('en-SG',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Singapore'}).format(new Date(value));
const dateKey=(value:string)=>new Date(Date.parse(value)+8*3600000).toISOString().slice(0,10);

/** Codes are kept only in this mounted account's memory; consent is checked by the server. */
export default function CaregiverConnections({role,patientId,notify,onSessionExpired,embedded=false}:{role:Role;patientId?:string;notify:(message:string)=>void;onSessionExpired:()=>void;embedded?:boolean}){
  const [links,setLinks]=useState<Link[]>([]),[loading,setLoading]=useState(true),[loadError,setLoadError]=useState(false),[retry,setRetry]=useState(0);
  const [filters,setFilters]=useDashboardViewState(`connections-${role}-${patientId??'own'}`,{search:'',from:'',until:'',sort:'authorised_at',direction:'desc' as 'asc'|'desc'});
  const [filterDraft,setFilterDraft]=useState<{from:string;until:string}|null>(null),[sorting,setSorting]=useState(false),[detailsId,setDetailsId]=useState<string|null>(null);
  const [modal,setModal]=useState<'invite'|'link'|'unlink'|'assisted'|null>(null),[chosen,setChosen]=useState<Link|null>(null);
  const [code,setCode]=useState(''),[preview,setPreview]=useState<Preview|null>(null),[invitation,setInvitation]=useState<Invitation|null>(null);
  const [caregiverId,setCaregiverId]=useState(''),[authorised,setAuthorised]=useState(false);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[stale,setStale]=useState(false),[now,setNow]=useState(Date.now);
  const alive=useRef(false),working=useRef(false),sequence=useRef(0);
  const callbacks=useRef({notify,onSessionExpired});callbacks.current={notify,onSessionExpired};
  const caregiver=role==='caregiver',coordinator=role==='coordinator';
  const endpoint=`/profiles/caregiver-links${patientId?`?patient=${encodeURIComponent(patientId)}`:''}`;
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;sequence.current++;};},[]);
  useEffect(()=>{
    const request=++sequence.current;if(!links.length)setLoading(true);setLoadError(false);
    apiGet<{links:Link[]}>(endpoint).then(result=>{if(alive.current&&request===sequence.current)setLinks(result.links);})
      .catch(reason=>{if(!alive.current||request!==sequence.current)return;setLoadError(true);if(reason instanceof ApiError&&reason.status===401)callbacks.current.onSessionExpired();})
      .finally(()=>{if(alive.current&&request===sequence.current)setLoading(false);});
    return()=>{sequence.current++;};
  },[endpoint,retry]);
  useEffect(()=>{if(!modal)return;setNow(Date.now());const timer=window.setInterval(()=>setNow(Date.now()),1000);return()=>window.clearInterval(timer);},[modal]);
  function open(next:typeof modal,link:Link|null=null){
    setNow(Date.now());setModal(next);setChosen(link);setError('');setStale(false);setCode('');setPreview(null);setCaregiverId(link?.caregiver_id??'');setAuthorised(false);
  }
  function fail(reason:unknown){
    if(reason instanceof ApiError&&reason.status===401)callbacks.current.onSessionExpired();
    if(reason instanceof ApiError&&['patient_link_limit','caregiver_link_limit'].includes(reason.code??'')){
      setError(reason.code==='patient_link_limit'?'This patient already has 5 linked caregivers. Unlink one before adding another.':'This caregiver already has 5 linked patients. Unlink one before adding another.');setRetry(value=>value+1);return;
    }
    const conflict=reason instanceof ApiError&&reason.status===409;setStale(conflict);
    if(conflict)setRetry(value=>value+1);
    if(reason instanceof ApiError&&reason.status===400&&modal==='link')setPreview(null);
    const invalid=modal==='link'?'This invitation is invalid, expired or already used.':modal==='assisted'?'Check the caregiver ID and confirm that both accounts are active.':'This relationship can no longer be changed. Reload and try again.';
    setError(conflict?'This relationship changed. Close and reopen it before trying again.':reason instanceof ApiError&&reason.status===429?'Too many attempts. Please wait before trying again.':reason instanceof ApiError&&reason.status===400?invalid:reason instanceof ApiError&&reason.status===403?'This action is not available to your account.':'This action could not be completed. Please retry.');
  }
  async function perform(action:()=>Promise<void>){
    if(working.current)return;working.current=true;setBusy(true);setError('');
    try{await action();}catch(reason){if(alive.current)fail(reason);}finally{working.current=false;if(alive.current)setBusy(false);}
  }
  function done(message:string){if(!alive.current)return;setModal(null);setDetailsId(null);setRetry(value=>value+1);callbacks.current.notify(message);}
  function showInvitation(){
    open('invite');
    if(invitation&&Date.parse(invitation.expires_at)>Date.now())return;
    void createInvitation();
  }
  async function createInvitation(){
    await perform(async()=>{if(alive.current)setInvitation(null);const result=await apiRequest<Invitation>('/profiles/caregiver-invitations','POST');if(alive.current)setInvitation(result);});
  }
  async function submit(event:FormEvent){
    event.preventDefault();
    if(stale)return;
    await perform(async()=>{
      if(modal==='link'){
        if(preview){
          await apiRequest('/profiles/caregiver-invitations/confirm','POST',{code:code.trim(),caregiver_id:preview.caregiver_id,confirmed:true});
          done('Caregiver linked.');
        }else{const result=await apiRequest<Preview>('/profiles/caregiver-invitations/preview','POST',{code:code.trim()});if(alive.current)setPreview(result);}
      }else if(modal==='unlink'&&chosen){
        await apiRequest('/profiles/caregiver-links','PATCH',{patient_id:chosen.patient_id,caregiver_id:chosen.caregiver_id,active:false,version:chosen.version});done('Relationship removed.');
      }else if(modal==='assisted'&&patientId&&authorised){
        await apiRequest('/profiles/caregiver-links','PATCH',{patient_id:patientId,caregiver_id:caregiverId.trim(),active:true,...(chosen?{version:chosen.version}:{}),patient_authorised:true});done('Caregiver linked.');
      }
    });
  }
  const expired=!!preview&&Date.parse(preview.expires_at)<=now;
  const inviteExpired=!!invitation&&Date.parse(invitation.expires_at)<=now;
  const canIssue=!invitation||now>=Date.parse(invitation.expires_at)-14*60000;
  const title=caregiver?'Patient':'Caregivers';
  const name=(link:Link)=>caregiver?link.patient_name:link.caregiver_name;
  const personId=(link:Link)=>caregiver?link.patient_id:link.caregiver_id;
  const details=links.find(link=>link.id===detailsId);
  const matching=links.filter(link=>{
    const term=filters.search.trim().toLocaleLowerCase();
    const day=link.authorised_at?dateKey(link.authorised_at):'';
    return (!term||name(link).toLocaleLowerCase().includes(term)||personId(link).toLowerCase().includes(term))&&(!filters.from||day>=filters.from)&&(!filters.until||!!day&&day<=filters.until);
  }).sort((a,b)=>{
    const compared=filters.sort==='name'?name(a).localeCompare(name(b),'en',{sensitivity:'base'}):(a.authorised_at??'').localeCompare(b.authorised_at??'');
    return (filters.direction==='asc'?compared:-compared)||a.id.localeCompare(b.id);
  });
  const filterCount=Number(!!filters.from)+Number(!!filters.until);
  const toolbar=<ListToolbar search={filters.search} onSearch={search=>setFilters(current=>({...current,search}))} label={caregiver?'Search linked patients':'Search linked caregivers'} placeholder={caregiver?'Patient name or ID':'Caregiver name or ID'} filterCount={filterCount} onFilter={()=>setFilterDraft({from:filters.from,until:filters.until})} onSort={()=>setSorting(true)} sortLabel={sortSummary(sortOptions,filters.sort,filters.direction)}/>;
  const activeLinks=links.filter(link=>link.active).length;
  const linkButton=<button className="patient-primary" type="button" disabled={activeLinks>=5} onClick={()=>caregiver?showInvitation():open(coordinator?'assisted':'link')}>{caregiver?'Link patient':'Link caregiver'}</button>;
  return <section className={embedded?'caregiver-connections connections-embedded':'dashboard-trips patients-panel page-panel caregiver-connections'} aria-labelledby={embedded?undefined:'connections-title'} aria-label={embedded?title:undefined}>
    {!embedded&&<PageHeading id="connections-title" title={title} eyebrow={caregiver?'Linked Patient Management':'Linked Caregiver Management'} actions={toolbar}/>}
    {loading?<div className="account-loading patients-loading" role="status"><span className="account-spinner" aria-hidden="true"/><span>Loading...</span></div>:loadError?<ListError title="Relationships could not be loaded" message="Please try again." onRetry={()=>setRetry(value=>value+1)}/>:links.length?matching.length?<div className="connections-list" role="region" aria-label={caregiver?'Linked patient records':'Linked caregiver records'}>
      {matching.map(link=><article key={link.id} className="connections-record">
        <span className="connections-avatar" aria-hidden="true">{name(link).trim().split(/\s+/).slice(0,2).map(part=>part[0]).join('').toUpperCase()}</span>
        <div><strong>{name(link)}</strong><span className="connections-record-caption">{!link.active?'Unlinked':link.authorised_at?`Linked ${linkedDate(link.authorised_at)}`:caregiver?'Patient':'Caregiver'}</span></div>
        <InfoButton label={`View ${name(link)}`} onClick={()=>setDetailsId(link.id)}/>
      </article>)}
    </div>:<div className="connections-empty" role="status"><h2>{caregiver?'No matching patients':'No matching caregivers'}</h2><p>Try another search or change the filters.</p></div>:<div className="connections-empty">
      <span className="connections-empty-icon" aria-hidden="true"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg></span>
      <h2>{caregiver?'No linked patients':'No linked caregivers'}</h2>
      <p>{caregiver?'Create an invitation and share the code with your patient.':coordinator?'Link a caregiver with the patient’s authorisation.':'Link a caregiver using their invitation code.'}</p>
    </div>}
    {!loading&&!loadError&&<footer className="connections-add-action"><span>{activeLinks}/5 {caregiver?'patients':'caregivers'} linked</span><div className="patient-actions">{linkButton}</div></footer>}
    {sorting&&<SortOverlay sort={filters.sort} order={filters.direction} options={sortOptions} defaultSort="authorised_at" defaultOrder="desc" onClose={()=>setSorting(false)} onApply={(sort,direction)=>{setFilters(current=>({...current,sort,direction}));setSorting(false);}}/>}
    {filterDraft&&<Overlay title={caregiver?'Patient filters':'Caregiver filters'} className="list-options-dialog" onClose={()=>setFilterDraft(null)} onSubmit={event=>{event.preventDefault();setFilters(current=>({...current,...filterDraft}));setFilterDraft(null);}} footer={<><button className="patient-primary" type="submit">Apply Filters</button><button type="button" onClick={()=>setFilterDraft({from:'',until:''})}>Reset</button><button type="button" onClick={()=>setFilterDraft(null)}>Cancel</button></>}>
      <div className="patient-form-fields"><div className="patient-field"><label htmlFor="connections-from">Linked from</label><input id="connections-from" type="date" max={filterDraft.until||undefined} value={filterDraft.from} onChange={event=>setFilterDraft({...filterDraft,from:event.target.value})}/></div><div className="patient-field"><label htmlFor="connections-until">Linked until</label><input id="connections-until" type="date" min={filterDraft.from||undefined} value={filterDraft.until} onChange={event=>setFilterDraft({...filterDraft,until:event.target.value})}/></div></div>
    </Overlay>}
    {details&&<Overlay title={caregiver?'Patient Details':'Caregiver Details'} className="patient-dialog" busy={busy} onClose={()=>setDetailsId(null)} footer={<>
      {details.active?<button type="button" className="button-danger connections-unlink-control" aria-label={`Unlink ${name(details)}`} title="Unlink" disabled={busy} onClick={()=>open('unlink',details)}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6m4-6v6"/></svg></button>:coordinator&&<button type="button" className="patient-primary" disabled={busy} onClick={()=>open('assisted',details)}>Authorise</button>}
      <button type="button" disabled={busy} onClick={()=>setDetailsId(null)}>Close</button>
    </>}>
      <fieldset className="patient-form-fields" disabled aria-label={caregiver?'Linked patient details':'Linked caregiver details'}>
        <div className="patient-field"><label htmlFor="connection-name">Name</label><input id="connection-name" readOnly value={name(details)}/></div>
        <div className="patient-field"><label htmlFor="connection-status">Link status</label><input id="connection-status" readOnly value={details.active?'Linked':'Unlinked'}/></div>
        <div className="patient-field patient-form-wide"><label htmlFor="connection-person-id">{caregiver?'Patient ID':'Caregiver ID'}</label><input id="connection-person-id" readOnly value={personId(details)}/></div>
        <div className="patient-field patient-form-wide"><label htmlFor="connection-date">Linked on</label><input id="connection-date" readOnly value={details.authorised_at?linkedDate(details.authorised_at):'—'}/></div>
      </fieldset>
    </Overlay>}
    {modal&&<Overlay title={modal==='invite'?'Caregiver invitation':modal==='unlink'?'Unlink relationship':modal==='assisted'?'Authorise caregiver':'Link caregiver'} busy={busy} onClose={()=>setModal(null)} error={error} onDismissError={()=>setError('')} footer={<>
      {modal==='invite'?<><button type="button" className="patient-primary" disabled={busy||!invitation||inviteExpired} onClick={()=>void perform(async()=>{if(!invitation)return;await navigator.clipboard.writeText(invitation.code);if(alive.current)callbacks.current.notify('Invitation code copied.');})}>Copy code</button><button type="button" disabled={busy||!canIssue} onClick={()=>void createInvitation()}>New code</button></>:<button type="submit" form="caregiver-link-form" className={modal==='unlink'?'button-danger':'patient-primary'} disabled={busy||stale||expired||(modal==='assisted'&&!authorised)}>{busy?'Saving…':modal==='unlink'?'Unlink':modal==='link'&&!preview?'Continue':modal==='assisted'?'Authorise':'Link caregiver'}</button>}
      <button type="button" disabled={busy} onClick={()=>setModal(null)}>Close</button>
    </>}>
      {modal==='invite'?invitation?<div className="patient-form-fields connections-form"><div className="patient-field"><label htmlFor="caregiver-invitation">Invitation code</label><input id="caregiver-invitation" autoComplete="off" readOnly value={invitation.code} onFocus={event=>event.currentTarget.select()}/><p className="treatment-hint">{inviteExpired?'Expired. Create a new code.':`Expires ${new Intl.DateTimeFormat('en-SG',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Singapore'}).format(new Date(invitation.expires_at))}`}</p></div></div>:<p role="status">{busy?'Creating invitation…':'Create a new invitation to continue.'}</p>:<form id="caregiver-link-form" className="patient-form-fields connections-form" onSubmit={submit}>
        {modal==='unlink'?<p>Remove the link with <strong>{caregiver?chosen?.patient_name:chosen?.caregiver_name}</strong>?</p>:modal==='assisted'?<><div className="patient-field"><label className="patient-required" htmlFor="assisted-caregiver">Caregiver ID</label><input id="assisted-caregiver" required maxLength={36} value={caregiverId} disabled={busy||!!chosen} onChange={event=>setCaregiverId(event.target.value)}/></div><label className="connections-consent"><input type="checkbox" required checked={authorised} disabled={busy} onChange={event=>setAuthorised(event.target.checked)}/><span className="patient-required">I have verified the patient's authorisation for this caregiver.</span></label></>:<>
          <div className="patient-field"><label className="patient-required" htmlFor="patient-invitation">Invitation code</label><input id="patient-invitation" required maxLength={36} autoComplete="off" value={code} disabled={busy} onChange={event=>{setCode(event.target.value);setPreview(null);setError('');}}/></div>
          {preview&&<dl className="schedule-detail-fields connections-preview"><div><dt>Name</dt><dd>{preview.full_name}</dd></div><div><dt>Username</dt><dd>{preview.display_name}</dd></div></dl>}
          {expired&&<p role="status">This invitation expired. Enter a new code.</p>}
        </>}
      </form>}
    </Overlay>}
  </section>;
}
