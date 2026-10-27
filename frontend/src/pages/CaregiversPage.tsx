import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useDashboardViewState } from '../components/DashboardViewState';
import { ChoiceGroup, InfoButton, ListError, ListPagination, ListToolbar, Overlay, PageHeading, SortOverlay, sortSummary } from '../components/DashboardUI';
import { PersonalFields, type PersonalDetails } from '../components/PersonalFields';
import CoordinatorLinks from '../components/CoordinatorLinks';
import { ApiError, apiGet, apiRequest } from '../lib/api';

interface Caregiver extends PersonalDetails { id:string;status:'active'|'inactive';status_version:number }
interface Directory { caregivers:Caregiver[];total:number;page:number;pageSize:number }
const columns=[{key:'id',label:'Caregiver ID'},{key:'full_name',label:'Name'},{key:'phone',label:'Contact'},{key:'status',label:'Status'}] as const;
const options=[{value:'created_at',label:'Created date',ascending:'Oldest first',descending:'Newest first'},...columns.map(column=>({value:column.key,label:column.label}))];

/** Coordinator directory: personal details are read-only; only account status can change. */
export default function CaregiversPage({notify,onSessionExpired}:{notify:(message:string)=>void;onSessionExpired:()=>void}){
  const [filters,setFilters]=useDashboardViewState('coordinator-caregivers',{page:1,search:'',sort:'created_at',direction:'desc' as 'asc'|'desc',status:'all'});
  const [search,setSearch]=useState(filters.search),[sorting,setSorting]=useState(false),[filterDraft,setFilterDraft]=useState<string|null>(null);
  const [data,setData]=useState<Directory|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState(false),[retry,setRetry]=useState(0);
  const [selected,setSelected]=useState<Caregiver|null>(null),[editing,setEditing]=useState(false),[status,setStatus]=useState<'active'|'inactive'>('active');
  const [busy,setBusy]=useState(false),[saveError,setSaveError]=useState(''),[conflict,setConflict]=useState(false);
  const alive=useRef(false),statusInput=useRef<HTMLSelectElement>(null),editButton=useRef<HTMLButtonElement>(null),wasEditing=useRef(false);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useEffect(()=>{if(editing)statusInput.current?.focus();else if(wasEditing.current)editButton.current?.focus();wasEditing.current=editing;},[editing]);
  useEffect(()=>{const timer=window.setTimeout(()=>setFilters(current=>current.search===search.trim()?current:{...current,search:search.trim(),page:1}),300);return()=>window.clearTimeout(timer);},[search]);
  useEffect(()=>{
    let live=true;setLoading(true);setError(false);
    apiGet<Directory>(`/profiles/caregivers?${new URLSearchParams({...filters,page:String(filters.page)})}`).then(result=>{
      if(!live)return;
      const last=Math.max(1,Math.ceil(result.total/result.pageSize));
      if(filters.page>last){setFilters(current=>({...current,page:last}));return;}
      setData(result);
    }).catch(reason=>{if(live){setError(true);if(reason instanceof ApiError&&reason.status===401)onSessionExpired();}}).finally(()=>{if(live)setLoading(false);});
    return()=>{live=false;};
  },[filters,retry,onSessionExpired]);
  function open(person:Caregiver){setSelected(person);setStatus(person.status);setEditing(false);setConflict(false);setSaveError('');}
  function close(){setSelected(null);setEditing(false);setConflict(false);setSaveError('');}
  function fail(reason:unknown){
    if(reason instanceof ApiError&&reason.status===401)onSessionExpired();
    const stale=reason instanceof ApiError&&reason.status===409;setConflict(stale);
    setSaveError(stale?'This caregiver changed. Reload the latest details before saving.':'Caregiver details could not be updated. Please try again.');
  }
  async function save(event:FormEvent){
    event.preventDefault();if(!selected||busy||conflict)return;setBusy(true);setSaveError('');
    try{
      const result=await apiRequest<Pick<Caregiver,'id'|'status'|'status_version'>>(`/profiles/caregivers/${selected.id}`,'PATCH',{status,version:selected.status_version});
      if(alive.current){setSelected({...selected,...result});setEditing(false);setRetry(value=>value+1);notify('Caregiver details updated.');}
    }catch(reason){if(alive.current)fail(reason);}finally{if(alive.current)setBusy(false);}
  }
  async function reloadSelected(){
    if(!selected||busy)return;setBusy(true);
    try{
      const result=await apiGet<Directory>(`/profiles/caregivers?search=${encodeURIComponent(selected.id)}`);
      if(!alive.current)return;
      const latest=result.caregivers.find(person=>person.id===selected.id);
      if(!latest){setSaveError('This caregiver is no longer available. Close and reload the list.');return;}
      setSelected(latest);setStatus(latest.status);setConflict(false);setSaveError('');setRetry(value=>value+1);
    }catch(reason){if(alive.current)fail(reason);}finally{if(alive.current)setBusy(false);}
  }
  function sortBy(key:string){setFilters(current=>current.sort===key&&current.direction==='desc'?{...current,page:1,sort:'created_at',direction:'desc'}:{...current,page:1,sort:key,direction:current.sort===key?'desc':'asc'});}
  const updating=loading||search.trim()!==filters.search;
  return <section className="dashboard-trips patients-panel page-panel" aria-labelledby="caregivers-title" aria-busy={updating}>
    <PageHeading id="caregivers-title" title="Caregiver List" eyebrow="Caregiver Management" actions={<ListToolbar search={search} onSearch={setSearch} label="Search caregivers" placeholder="Caregiver name, phone or ID" filterCount={Number(filters.status!=='all')} onFilter={()=>setFilterDraft(filters.status)} onSort={()=>setSorting(true)} sortLabel={sortSummary(options,filters.sort,filters.direction)}/>}/>
    {loading&&!data?<div className="account-loading patients-loading" role="status"><span className="account-spinner" aria-hidden="true"/><span>Loading...</span></div>:error?<ListError title="Caregivers could not be loaded" message="Please try again to load the caregiver records." onRetry={()=>setRetry(value=>value+1)}/>:data?.caregivers.length?<div className="patients-table-scroll" tabIndex={0} role="region" aria-label="Caregiver records"><table className="patients-table"><colgroup>{[5,32,24,21,12,6].map((width,index)=><col key={index} style={{width:`${width}%`}}/>)}</colgroup>
      <thead><tr><th scope="col" className="record-number-heading" aria-label="Row number">#</th>{columns.map(column=><th scope="col" key={column.key} aria-sort={filters.sort===column.key?filters.direction==='asc'?'ascending':'descending':'none'}><button type="button" className="patient-sort-button" onClick={()=>sortBy(column.key)}>{column.label}{filters.sort===column.key&&<span aria-hidden="true">{filters.direction==='asc'?'▲':'▼'}</span>}</button></th>)}<th scope="col" aria-label="Details"/></tr></thead>
      <tbody>{data.caregivers.map((person,index)=><tr key={person.id}><td className="record-number">{(data.page-1)*data.pageSize+index+1}</td><td className="patient-record-id">{person.id}</td><td className="patient-record-name">{person.full_name}</td><td data-label="Contact">{person.phone}</td><td data-label="Status">{person.status==='active'?'Active':'Inactive'}</td><td className="patient-record-action"><InfoButton label={`View ${person.full_name}`} disabled={updating} onClick={()=>open(person)}/></td></tr>)}</tbody>
    </table></div>:<div className="dashboard-data-status patients-status" role="status"><div><h3>{filters.search||filters.status!=='all'?'No matching caregivers.':'No caregivers yet.'}</h3><p>{filters.search||filters.status!=='all'?'Try another search or change the filters.':'Caregivers appear here after completing account creation.'}</p></div></div>}
    {!error&&<ListPagination label="Caregiver pages" page={filters.page} disabled={updating||busy} hasNext={!!data&&filters.page*data.pageSize<data.total} onPageChange={page=>setFilters(current=>({...current,page}))}>{data?`${data.total} ${data.total===1?'caregiver':'caregivers'} · Page ${data.page} of ${Math.max(1,Math.ceil(data.total/data.pageSize))}`:'Loading...'}</ListPagination>}
    {sorting&&<SortOverlay sort={filters.sort} order={filters.direction} options={options} defaultSort="created_at" defaultOrder="desc" onClose={()=>setSorting(false)} onApply={(sort,direction)=>{setFilters(current=>({...current,sort,direction,page:1}));setSorting(false);}}/>}
    {filterDraft!==null&&<Overlay title="Caregiver filters" className="list-options-dialog" onClose={()=>setFilterDraft(null)} onSubmit={event=>{event.preventDefault();setFilters(current=>({...current,status:filterDraft,page:1}));setFilterDraft(null);}} footer={<><button className="patient-primary" type="submit">Apply Filters</button><button type="button" onClick={()=>setFilterDraft('all')}>Reset</button><button type="button" onClick={()=>setFilterDraft(null)}>Cancel</button></>}><ChoiceGroup label="Status" multiple value={filterDraft} options={[{value:'active',label:'Active'},{value:'inactive',label:'Inactive'}]} onChange={setFilterDraft}/></Overlay>}
    {selected&&<Overlay title="Caregiver Details" description={<span className="profile-id">Caregiver ID: {selected.id}</span>} className={`patient-dialog${editing?' patient-editing':''}`} busy={busy} onClose={close} onSubmit={editing?save:undefined} error={saveError} onDismissError={()=>setSaveError('')} footer={editing?<><button className="patient-primary" type="submit" disabled={busy||conflict}>{busy?'Saving…':'Save Caregiver'}</button><button type="button" disabled={busy} onClick={()=>{setStatus(selected.status);setEditing(false);setSaveError('');setConflict(false);}}>Cancel</button></>:<><button ref={editButton} type="button" className="patient-primary" onClick={()=>setEditing(true)}>Edit Caregiver</button><button type="button" onClick={close}>Close</button></>}>
      {conflict&&<button type="button" disabled={busy} onClick={()=>void reloadSelected()}>Reload latest details</button>}
      <fieldset className="patient-form-fields" disabled={busy} aria-label="Caregiver details"><PersonalFields prefix="coordinator-caregiver" draft={{...selected,birth_date:selected.birth_date??'',gender:selected.gender??''}} disabled onChange={()=>{}}/><div className="patient-field"><label className="patient-required" htmlFor="coordinator-caregiver-status">Status</label><select ref={statusInput} id="coordinator-caregiver-status" required disabled={!editing} value={editing?status:selected.status} onChange={event=>setStatus(event.target.value as 'active'|'inactive')}><option value="active">Active</option><option value="inactive">Inactive</option></select></div></fieldset>
      <CoordinatorLinks kind="caregiver" id={selected.id} onSessionExpired={onSessionExpired}/>
    </Overlay>}
  </section>;
}
