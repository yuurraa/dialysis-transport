import { useDashboardViewState } from '../components/DashboardViewState';
import TripProgress from '../components/TripProgress';
import TripHistoryDialog from '../components/TripHistoryDialog';
import TripAssignmentDialog from '../components/TripAssignmentDialog';
import TripRecoveryDialog from '../components/TripRecoveryDialog';
import { Toast, ToastRegion } from '../components/Toast';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { InfoButton, Overlay, PageHeading, ListToolbar, ListPagination, ChoiceGroup, SortOverlay, ListError, sortSummary } from '../components/DashboardUI';
import { ApiError, apiGet, apiRequest } from '../lib/api';

export interface Trip {
  id: string; version: number; patient_id: string; patient_name: string; source_schedule_id: string; session_date: string;
  direction: 'outbound' | 'return'; origin: string; destination: string; treatment_start: string; treatment_end: string;
  started_at?: string | null; completed_at?: string | null; first_started_at?:string|null; handover_at?:string|null;
  duration_minutes?: number;
  driver_unavailable_at?: string | null;
  review_required?: boolean;
  traffic_review_required?: boolean;
  lifecycle?: 'scheduled' | 'in-progress' | 'completed' | 'cancelled'; confirmed_at?: string | null; cancelled_at?: string | null;
  assigned_driver_id?: string | null; dropoff_at?: string | null;
  assignment?: { driver_name: string; driver_phone: string; plate: string; make: string; model: string; patient_phone: string; mobility?: string; assistance_required?: boolean } | null;
  cancelled_assignment?: { driver_name?: string; driver_phone?: string; plate?: string; make?: string; model?: string } | null;
  arrival_by: string | null; pickup_not_before: string | null; pickup_at: string | null; status: string;
}
interface TripsData { trips: Trip[]; total: number; page: number; pageSize: number; counts: Record<string, number>; next_trip: Trip | null; active_trip?: Trip | null }
const categories = [{ key: 'unfilled', label: 'Unfilled' }, { key: 'at-risk', label: 'At-Risk' }, { key: 'on-track', label: 'On-Track' }, { key: 'resolved', label: 'Resolved' }, { key: 'cancelled', label: 'Cancelled' }];
const tripSortOptions = [{ value: 'treatment_start', label: 'Treatment date', ascending: 'Earliest first', descending: 'Latest first' }, { value: 'patient_name', label: 'Patient name' }, { value: 'direction', label: 'Direction', ascending: 'Outbound first', descending: 'Return first' }, { value: 'status', label: 'Status', ascending: 'At-Risk → Cancelled → On-Track → Resolved → Unfilled', descending: 'Unfilled → Resolved → On-Track → Cancelled → At-Risk' }];
const journeyCategories = [{ key: 'upcoming', label: 'Upcoming' }, { key: 'in-progress', label: 'In progress' }, { key: 'completed', label: 'Completed' }, { key: 'cancelled', label: 'Cancelled' }];
const assignmentIcon=<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="9" cy="7" r="3" /><path d="M3 21v-3a6 6 0 0 1 12 0v3M17 8h6m-3-3v6" /></svg>;
function TripStatus({ status, lifecycle, coordinator = false, driver = false }: { status: string; lifecycle?: Trip['lifecycle']; coordinator?: boolean; driver?: boolean }) {
  const category = categories.find(item => item.key === status);
  return <span className={`trip-status-badge trip-status-${lifecycle === 'cancelled' ? 'cancelled' : category?.key ?? 'unknown'}`}>{lifecycle === 'cancelled' ? 'Cancelled' : lifecycle === 'completed' ? 'Completed' : lifecycle === 'in-progress' ? coordinator && status === 'at-risk' ? 'In progress · At-Risk' : 'In progress' : !category ? 'Status unavailable' : coordinator ? category.label : status === 'unfilled' ? 'Awaiting driver' : status === 'at-risk' ? 'Under review' : driver ? 'Assigned' : 'Driver assigned'}</span>;
}
export const singaporeToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
export const addDays = (date: string, days: number) => {
  const timestamp = Date.parse(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(timestamp) || !Number.isFinite(days)) return '9999-12-31';
  return new Date(Math.max(Date.parse('0001-01-01T00:00:00Z'), Math.min(Date.parse('9999-12-31T00:00:00Z'), timestamp + days * 86400000))).toISOString().slice(0, 10);
};
function tripTimestamp(value: string, options: Intl.DateTimeFormatOptions) {
  const date = new Date(value);
  const year = new Date(date.getTime() + 8 * 3600000).getUTCFullYear();
  if (!Number.isFinite(date.getTime()) || year < 1 || year > 9999) return 'Unavailable';
  return new Intl.DateTimeFormat('en-SG', { ...options, timeZone: 'Asia/Singapore' }).format(date);
}
const tripDate = (value: string) => tripTimestamp(value, { day: 'numeric', month: 'short', year: 'numeric' });
const tripTime = (value: string) => tripTimestamp(value, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
// Short list labels only; the API values remain intact for desktop and the details dialog.
function compactRouteLabel(address: string) {
  const original = address.trim().replace(/\s+/g, ' ');
  const label = original
    .replace(/,?\s*Singapore\s+\d{6}\s*$/i, '')
    .replace(/,?\s*\d{6}\s*$/, '')
    .split(/,\s*(?=(?:Blk|Block)\b|\d|#)/i)[0]
    .replace(/\s*#.*$/, '')
    .replace(/^(?:Blk|Block)\s+\d+[A-Za-z]?\s+/i, '')
    .replace(/\bNKF Dialysis Centre Supported by\s+/i, 'NKF ')
    .replace(/\bNKF Dialysis Centre\b/gi, 'NKF')
    .replace(/\bDialysis Centre\b/gi, 'Dialysis')
    .replace(/[\s,]+$/, '');
  return label || original || 'Address unavailable';
}
function RouteAddress({ address }: { address: string }) {
  return <><span className="trip-address-full">{address}</span><span className="trip-address-short">{compactRouteLabel(address)}</span></>;
}
function InlineTripTiming({ trip }: { trip: Trip }) {
  const timing = trip.pickup_at ? `Pickup at ${tripTime(trip.pickup_at)}` : null;
  return timing ? <span className="trip-mobile-timing">{timing}</span> : null;
}
function JourneyDetails({ trip }: { trip: Trip }) {
  return <div className="trip-journey-details">
    <section className="trip-detail-section trip-detail-journey"><h2>Journey</h2>
      <ol className="trip-detail-route" aria-label="Journey route"><li><div><span>From</span><p>{trip.origin}</p></div></li><li><div><span>To</span><p>{trip.destination}</p></div></li></ol>
    </section>
    <section className="trip-detail-section trip-detail-treatment"><h2>Treatment</h2>
      <dl className="trip-detail-timings">
        <div><dt>Session time</dt><dd>{tripTime(trip.treatment_start)} – {tripTime(trip.treatment_end)}</dd></div>
        {trip.pickup_at&&<div><dt>Pickup</dt><dd>{tripTime(trip.pickup_at)}</dd></div>}
        {trip.arrival_by&&<div><dt>Arrival by</dt><dd>{tripTime(trip.arrival_by)}</dd></div>}
        {trip.pickup_not_before&&<div><dt>Earliest return pickup</dt><dd>{tripTime(trip.pickup_not_before)}</dd></div>}
      </dl>
    </section>
  </div>;
}

const validTripDate = (value: string) => /^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
interface Filters { page: number; from: string; until: string; status: string; search: string; direction: string; sort: string; order: string }
export default function TripsPage({ coordinator, driver = false,caregiver=false, onSessionExpired, tripId, onNavigate }: { coordinator: boolean; driver?: boolean;caregiver?:boolean; onSessionExpired: () => void; tripId?:string; onNavigate:(path:string)=>void }) {
  const statusOptions = coordinator ? categories : journeyCategories;
  const defaultStatus = coordinator ? 'unfilled,at-risk,on-track' : 'upcoming,in-progress';
  const sortOptions = [{ value: 'pickup_time', label: 'Pickup date/time', ascending: 'Earliest first', descending: 'Latest first' }, ...tripSortOptions.filter(option => (coordinator || driver || caregiver || option.value !== 'patient_name')).map(option => option.value === 'status' && !coordinator ? { ...option, ascending: 'Cancelled → Completed → In progress → Upcoming', descending: 'Upcoming → In progress → Completed → Cancelled' } : option)];
  const [defaultRange] = useState(() => { const from = singaporeToday(); return { from, until: '' }; });
  const [historyTrip, setHistoryTrip] = useState<string | null>(null);
  const [pickupAction, setPickupAction] = useState<'confirm' | 'cancel' | 'unavailable' | null>(null);
  const [pickupBusy, setPickupBusy] = useState(false);
  const [pickupError, setPickupError] = useState('');
  const [pickupConflict, setPickupConflict] = useState(false);
  const [filters, setFilters] = useDashboardViewState<Filters>('trips',() => ({ page: 1, ...defaultRange, status: defaultStatus, search: '', direction: 'all', sort: 'pickup_time', order: 'asc' }));
  const [search, setSearch] = useState(filters.search);
  const [filterDraft, setFilterDraft] = useState<Filters | null>(null);
  const [sorting, setSorting] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selectedTrips, setSelectedTrips] = useState<Set<string>>(() => new Set());
  const [filterError, setFilterError] = useState('');
  const [assigning, setAssigning] = useState<Trip | null>(null);
  const [recovering,setRecovering]=useState<Trip|null>(null);
  const [details, setDetails] = useState<Trip | null>(null);
  const navigation=useRef({id:tripId,generation:0});
  if(navigation.current.id!==tripId)navigation.current={id:tripId,generation:navigation.current.generation+1};
  const renderGeneration=navigation.current.generation;
  const [detailTab,setDetailTab]=useState<'details'|'journey'>('details');
  const [detailLoading,setDetailLoading]=useState(false),[detailError,setDetailError]=useState('');
  const [detailRetry,setDetailRetry]=useState(0);
  const detailPanel=useRef<HTMLElement>(null);
  useEffect(()=>{
    let active=true;
    setDetails(null);setHistoryTrip(null);setPickupAction(null);setAssigning(null);setRecovering(null);setDeleting(null);setBulkDeleting(null);setFilterDraft(null);setSorting(false);setSelecting(false);setSelectedTrips(new Set());setBusy(false);setPickupBusy(false);setDetailTab('details');setDetailError('');
    if(!tripId){setDetailLoading(false);return;}
    setDetailLoading(true);detailPanel.current?.focus();
    apiGet<Trip>(`/trips/${tripId}`).then(trip=>{if(active)setDetails(trip);}).catch(reason=>{
      if(!active)return;
      if(reason instanceof ApiError&&reason.status===401)onSessionExpired();
      setDetailError(reason instanceof ApiError&&[403,404].includes(reason.status)?'This trip is no longer available to your account.':'Trip details could not be loaded. Please try again.');
    }).finally(()=>{if(active)setDetailLoading(false);});
    return()=>{active=false;};
  },[tripId,detailRetry,onSessionExpired]);
  const [deleting, setDeleting] = useState<Trip | null>(null);
  const [bulkDeleting, setBulkDeleting] = useState<Trip[] | null>(null);
  const [bulkDeleteResult, setBulkDeleteResult] = useState('');
  const [bulkDeleteError, setBulkDeleteError] = useState('');
  const [busy, setBusy] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [toast, setToastMessage] = useState('');
  const [toastUrgent, setToastUrgent] = useState(false);
  function setToast(message:string) { setToastMessage(message); setToastUrgent(false); }
  function notifyProgress(message:string,urgent:boolean) { setToastMessage(message); setToastUrgent(urgent); }
  const [data, setData] = useState<TripsData | null>(null);
  const loadedListQuery = useRef<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [syncError, setSyncError] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const syncSequence = useRef(0);
  const [reload, setReload] = useState(0);
  const alive = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => setFilters(current => current.search === search.trim() ? current : { ...current, page: 1, search: search.trim() }), 300);
    return () => window.clearTimeout(timer);
  }, [search]);
  const params = new URLSearchParams({ ...filters, page: String(filters.page) });
  if (!filters.until) params.delete('until');
  const query = params.toString();
  const currentQuery = useRef(query); currentQuery.current = query;
  const listInteractionBusy=useRef(false);
  listInteractionBusy.current=loading||busy||syncing||selecting||!!details||!!assigning||!!deleting||!!bulkDeleting||!!filterDraft||sorting;

  useEffect(() => {
    let active = true;
    syncSequence.current++; setSyncError(false); setSyncing(false);
    if(tripId)return;
    const refreshing = loadedListQuery.current === query;
    setLoading(!refreshing); setSyncing(refreshing); setError(false); setSelectedTrips(new Set());
    apiGet<TripsData>(`/trips?${query}`)
      .then(result => {
        if (!active) return;
        const lastPage = Math.max(1, Math.ceil(result.total / result.pageSize));
        if (filters.page > lastPage) { setFilters(current => ({ ...current, page: lastPage })); return; }
        loadedListQuery.current = query;
        setData(result);
      })
      .catch(reason => { if (active) { if(refreshing)setSyncError(true);else{loadedListQuery.current=null;setData(null);setError(true);} if (reason instanceof ApiError && reason.status === 401) onSessionExpired(); } })
      .finally(() => { if (active) {setLoading(false);setSyncing(false);} });
    return () => { active = false; };
  }, [query, reload, onSessionExpired, filters.page,tripId]);
  function applyFilters(event: FormEvent) {
    event.preventDefault();
    if (!filterDraft) return;
    const { from, until } = filterDraft;
    if (!validTripDate(from) || (until !== '' && (!validTripDate(until) || until < from))) { setFilterError('Choose a valid start date and an optional end date on or after it.'); return; }
    setFilters(current => ({ ...current, page: 1, from, until, direction: filterDraft.direction, status: filterDraft.status })); setFilterDraft(null); setFilterError('');
  }
  function confirmDelete(trip: Trip) { setDeleting(trip); setDeleteError(''); setConflict(false); }
  async function removeTrip() {
    const generation=navigation.current.generation;
    if (!deleting || busy || conflict) return;
    setBusy(true); setDeleteError('');
    try {
      await apiRequest(`/trips/${deleting.id}`, 'DELETE', { version: deleting.version });
      if (!alive.current||generation!==navigation.current.generation) return;
      setDeleting(null); setDetails(null); setToast('Trip deleted.'); setReload(value => value + 1); if(tripId)onNavigate('/dashboard/trips');
    } catch (reason) {
      if (!alive.current||generation!==navigation.current.generation) return;
      if (reason instanceof ApiError && reason.status === 401) onSessionExpired();
      if (reason instanceof ApiError && [404, 409].includes(reason.status)) { setConflict(true); setDeleteError('This trip changed or is no longer available. Reload trips before deleting again.'); }
      else setDeleteError('This trip could not be deleted. Please try again.');
    } finally { if (alive.current&&generation===navigation.current.generation) setBusy(false); }
  }
  async function reloadForDelete() {
    const generation=navigation.current.generation;
    if (!deleting || busy) return;
    setBusy(true);
    try {
      const result = tripId?null:await apiGet<TripsData>(`/trips?${query}`);
      if (!alive.current||generation!==navigation.current.generation) return;
      if(result)setData(result);
      const latest = tripId?await apiGet<Trip>(`/trips/${tripId}`): [...result!.trips, ...(result!.next_trip ? [result!.next_trip] : [])].find(trip => trip.id === deleting.id);
      if(!alive.current||generation!==navigation.current.generation)return;
      if (!latest) { setDeleteError('This trip is no longer in the current results. Cancel and reopen its latest details.'); return; }
      setDeleting(latest); if (details) setDetails(latest); setConflict(false); setDeleteError('');
    } catch (reason) {
      if (!alive.current||generation!==navigation.current.generation) return;
      if (reason instanceof ApiError && reason.status === 401) onSessionExpired();
      setDeleteError('Trips could not be reloaded. Please try again.');
    } finally { if (alive.current&&generation===navigation.current.generation) setBusy(false); }
  }
  function closeBulkDelete() {
    if (busy) return;
    setBulkDeleting(null); setBulkDeleteError('');
    if (bulkDeleteResult) {
      setBulkDeleteResult(''); setSelecting(false); setSelectedTrips(new Set()); setReload(value => value + 1);
    }
  }
  async function removeSelectedTrips() {
    const generation=navigation.current.generation;
    if (!bulkDeleting?.length || busy || bulkDeleteResult) return;
    setBusy(true); setBulkDeleteError('');
    let deleted = 0;
    for (const trip of bulkDeleting) {
      try {
        await apiRequest(`/trips/${trip.id}`, 'DELETE', { version: trip.version });
        deleted++;
      } catch (reason) {
        if (!alive.current||generation!==navigation.current.generation) return;
        if (reason instanceof ApiError && reason.status === 401) { onSessionExpired(); break; }
      }
      if (!alive.current||generation!==navigation.current.generation) return;
    }
    if (!alive.current||generation!==navigation.current.generation) return;
    setBusy(false);
    const failed = bulkDeleting.length - deleted;
    if (failed) {
      setBulkDeleteResult(`${deleted} ${deleted === 1 ? 'trip' : 'trips'} deleted. ${failed} ${failed === 1 ? 'trip could' : 'trips could'} not be deleted.`);
      setBulkDeleteError('Some trips may have changed or are no longer eligible. Reload trips before selecting them again.');
    } else {
      setBulkDeleting(null); setSelecting(false); setSelectedTrips(new Set());
      setToast(`${deleted} ${deleted === 1 ? 'trip' : 'trips'} deleted.`); setReload(value => value + 1);
    }
  }
  function openPickupAction(action: 'confirm' | 'cancel' | 'unavailable') {
    setPickupAction(action); setPickupError(''); setPickupConflict(false);
  }
  async function submitPickupAction(reloadOnly = false) {
    const generation=navigation.current.generation;
    if (!details || !pickupAction || pickupBusy) return;
    setPickupBusy(true); setPickupError('');
    try {
      const saved = reloadOnly ? await apiGet<Trip>(`/trips/${details.id}`)
        : await apiRequest<Trip>(`/trips/${details.id}/${pickupAction}`, 'PATCH', { version: details.version });
      if (!alive.current||generation!==navigation.current.generation) return;
      setDetails(saved); setPickupConflict(false); setReload(value => value + 1);
      if (!reloadOnly) { setPickupAction(null); setToast(pickupAction === 'confirm' ? 'Trip acknowledged.' : pickupAction === 'cancel' ? 'Trip cancelled.' : 'Unavailability reported.'); }
    } catch (reason) {
      if (!alive.current||generation!==navigation.current.generation) return;
      if (reason instanceof ApiError && reason.status === 401) onSessionExpired();
      const stale = reason instanceof ApiError && [404,409].includes(reason.status);
      setPickupConflict(stale);
      setPickupError(stale ? 'This trip changed or is no longer available. Reload its details before continuing.'
        : reason instanceof ApiError && reason.status === 400 ? 'This trip is no longer eligible. Reload its details to see the current pickup.'
        : 'Trip details could not be saved or loaded. Please try again.');
      if (reason instanceof ApiError && reason.status === 400) setPickupConflict(true);
    } finally { if (alive.current&&generation===navigation.current.generation) setPickupBusy(false); }
  }
  const patientActions = !coordinator && !driver;
  const upcomingDetails = !!details && !details.first_started_at && (!details.lifecycle || details.lifecycle === 'scheduled')
    && Date.parse(details.pickup_at ?? details.pickup_not_before ?? new Date(Date.parse(details.arrival_by!) - (details.duration_minutes ?? 30) * 60000).toISOString()) > Date.now();
  const canConfirmPickup = upcomingDetails && !!details?.assigned_driver_id && !details.confirmed_at && !details.review_required && !details.driver_unavailable_at;
  const canReportUnavailability = driver && !!details?.assigned_driver_id && !details.driver_unavailable_at
    && ((!details.lifecycle || details.lifecycle === 'scheduled') && Date.parse(details.dropoff_at ?? '') > Date.now() || details.lifecycle === 'in-progress');
  const actionLabel = pickupAction === 'unavailable' ? 'Report unavailability' : pickupAction === 'cancel' ? 'Cancel trip' : 'Acknowledge trip';
  const canRecover=coordinator&&!!details&&details.status==='at-risk'&&(details.lifecycle==='scheduled'||details.lifecycle==='in-progress')&&!!details.assigned_driver_id&&!details.review_required;
  async function refreshProgressMetadata(quiet=false) {
    if(tripId)return;
    const requestedQuery=query, request=++syncSequence.current;
    if(!quiet)setSyncing(true);
    try {
      const result=await apiGet<TripsData>(`/trips?${requestedQuery}`);
      if(!alive.current||request!==syncSequence.current||currentQuery.current!==requestedQuery||(quiet&&listInteractionBusy.current))return;
      const lastPage=Math.max(1,Math.ceil(result.total/result.pageSize));
      if(filters.page>lastPage){setFilters(current=>({...current,page:lastPage}));return;}
      setData(previous=>previous&&result.trips.some(row=>previous.trips.some(current=>current.id===row.id&&current.version>row.version))?previous:result);
      setSelectedTrips(new Set());setSyncError(false);
    } catch(reason) {
      if(!alive.current||request!==syncSequence.current||currentQuery.current!==requestedQuery)return;
      setSyncError(true);if(reason instanceof ApiError&&reason.status===401)onSessionExpired();
    } finally {if(alive.current&&request===syncSequence.current)setSyncing(false);}
  }
  const refreshVisibleList=useRef(()=>{});
  refreshVisibleList.current=()=>{
    if(!tripId&&document.visibilityState==='visible'&&!listInteractionBusy.current)void refreshProgressMetadata(true);
  };
  useEffect(()=>{
    const refresh=()=>refreshVisibleList.current();
    const timer=window.setInterval(refresh,30000);
    document.addEventListener('visibilitychange',refresh);
    return()=>{window.clearInterval(timer);document.removeEventListener('visibilitychange',refresh);};
  },[]);
  function updateTripProgress(saved:Trip) {
    if(tripId&&navigation.current.id!==saved.id)return;
    const previous=data?.trips.find(item=>item.id===saved.id)??(data?.next_trip?.id===saved.id?data.next_trip:data?.active_trip?.id===saved.id?data.active_trip:null);
    if(previous&&previous.lifecycle!==saved.lifecycle)void refreshProgressMetadata();
    setDetails(current=>current?.id===saved.id&&saved.version>current.version?saved:current);
    setData(current=>{
      if(!current)return current;
      const previous=current.trips.find(item=>item.id===saved.id)??(current.next_trip?.id===saved.id?current.next_trip:current.active_trip?.id===saved.id?current.active_trip:null);
      if(previous&&saved.version<=previous.version)return current;
      const counts={...current.counts};
      const previousLifecycle=previous?.lifecycle==='scheduled'?'upcoming':previous?.lifecycle;
      const savedLifecycle=saved.lifecycle==='scheduled'?'upcoming':saved.lifecycle;
      if(previousLifecycle&&savedLifecycle&&previousLifecycle!==savedLifecycle){
        for(const key of ['upcoming','in-progress','completed']){
          if(key===previousLifecycle)counts[key]=Math.max(0,(counts[key]??0)-1);
          if(key===savedLifecycle)counts[key]=(counts[key]??0)+1;
        }
      }
      const previousStatus=previous?.lifecycle==='cancelled'?'cancelled':previous?.status;
      const savedStatus=saved.lifecycle==='cancelled'?'cancelled':saved.status;
      if(previousStatus&&previousStatus!==savedStatus){counts[previousStatus]=Math.max(0,(counts[previousStatus]??0)-1);counts[savedStatus]=(counts[savedStatus]??0)+1;}
      return {...current,counts,trips:current.trips.map(item=>item.id===saved.id?saved:item),
        active_trip:saved.lifecycle==='in-progress'?saved:current.active_trip?.id===saved.id?null:current.active_trip,
        next_trip:current.next_trip?.id===saved.id?(saved.lifecycle==='scheduled'?saved:null):current.next_trip};
    });
  }
  const activeFilterCount = Number(filters.from !== defaultRange.from || filters.until !== defaultRange.until) + Number(filters.direction !== 'all') + Number(filters.status !== defaultStatus);
  const selected = statusOptions.find(category => category.key === filters.status);
  const tripTitle = coordinator ? selected ? `${selected.label} trips` : filters.from === singaporeToday() && filters.until === filters.from ? "Today's trips" : 'Trip List' : driver ? 'Trips' : caregiver?'Patient trips':'Your rides';
  const driverDetails = details?.assignment ?? (details?.lifecycle==='cancelled' ? details.cancelled_assignment : null);
  const activeTrip = data?.active_trip;
  const next = activeTrip ?? data?.next_trip;
  const pending = loading || search.trim() !== filters.search;
  const selectionButton = coordinator && <button className="list-tool-button trip-selection-toggle" type="button" aria-label="Select trips" title="Select trips" aria-pressed={selecting} disabled={!selecting && (pending || error || !data?.trips.length)} onClick={() => { setSelecting(value => !value); setSelectedTrips(new Set()); }}>
          <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="m3 6 2 2 3-4M11 6h10M3 13h5M11 13h10M3 20h5M11 20h10" /></svg>
        </button>;
  return <div className="trips-workspace">
    {tripId?<section ref={detailPanel} tabIndex={-1} className="dashboard-trips page-panel trip-detail-page" aria-labelledby="trip-details-title" aria-busy={detailLoading}>
      <PageHeading id="trip-details-title" title="Trip details" eyebrow={coordinator?'Trip management':'Your journey'} actions={<>
        {details?.id===tripId&&coordinator&&(!details.lifecycle||details.lifecycle==='scheduled')&&<button className="list-info-control" type="button" aria-label={details.assigned_driver_id?'Manage driver assignment':'Assign driver'} title={details.assigned_driver_id?'Manage driver assignment':'Assign driver'} disabled={Date.parse(details.pickup_at??details.treatment_start)<=Date.now()} onClick={()=>setAssigning(details)}>{assignmentIcon}</button>}
        {details?.id===tripId&&<button className="list-info-control" type="button" aria-label="History" title="History" onClick={()=>setHistoryTrip(details.id)}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 11a9 9 0 1 1 2.5 7M3 4v7h7M12 7v5l3 2"/></svg></button>}
        <button className="list-info-control" type="button" aria-label="Close trip details" title="Close trip details" onClick={()=>onNavigate('/dashboard/trips')}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button>
      </>}/>
      {detailLoading?<div className="account-loading" role="status">Loading trip details…</div>:detailError?<ListError title="Trip details unavailable" message={detailError} onRetry={()=>setDetailRetry(value=>value+1)}/>:details?.id===tripId&&<>
        <div className="trip-detail-summary"><div className="trip-detail-summary-main">
          <div className="trip-detail-identity"><p className="trip-detail-person">{details.patient_name}</p><span aria-hidden="true">·</span><p className="trip-detail-id">Patient ID: {details.patient_id}</p></div>
          <div className="trip-detail-heading"><span>{tripDate(details.treatment_start)}</span><span aria-hidden="true">·</span><span>{details.direction==='outbound'?'Outbound':'Return'}</span><TripStatus lifecycle={details.lifecycle} status={details.status} coordinator={coordinator} driver={driver}/></div>
        </div>{(coordinator||canReportUnavailability||patientActions&&(canConfirmPickup||upcomingDetails))&&<div className="patient-actions trip-detail-page-actions">{coordinator&&<button className="patient-primary trip-recovery-control" type="button" disabled={!canRecover} onClick={()=>setRecovering(details)}>Generate recovery options</button>}{canReportUnavailability && <button className="button-danger" type="button" onClick={() => openPickupAction('unavailable')}>Report unavailability</button>}{patientActions && canConfirmPickup && <button className="patient-primary" type="button" onClick={() => openPickupAction('confirm')}>Acknowledge trip</button>}{patientActions && upcomingDetails && <button className="button-danger" type="button" onClick={() => openPickupAction('cancel')}>Cancel trip</button>}{coordinator && (!details.lifecycle || details.lifecycle === 'scheduled') && !details.assigned_driver_id && <button className="button-danger" type="button" aria-label="Delete Trip" title="Delete Trip" onClick={() => confirmDelete(details)}>Delete Trip</button>}</div>}</div>
        <nav className="trip-detail-tabs" aria-label="Trip views">{(['details','journey'] as const).map(tab=><button key={tab} type="button" aria-pressed={detailTab===tab} onClick={()=>setDetailTab(tab)}>{tab==='details'?'Details':'Journey'}</button>)}</nav>
        {detailTab==='details'&&<section className="trip-detail-overview" aria-label="Trip information">
          <JourneyDetails trip={details}/>
          {details.driver_unavailable_at&&<p className="trip-action-note">Driver unavailability reported. The coordinator needs to review this assignment.</p>}
          {details.assigned_driver_id&&details.confirmed_at&&<p className="trip-action-note">Trip acknowledged.</p>}
          {driverDetails&&<section className="trip-detail-section trip-detail-assignment"><h2>Driver and vehicle</h2>
            <dl className="trip-detail-timings">
              <div><dt>Driver</dt><dd>{driverDetails.driver_name || '—'}</dd></div>
              <div><dt>Driver contact</dt><dd>{driverDetails.driver_phone || '—'}</dd></div>
              <div><dt>Car</dt><dd>{[driverDetails.make,driverDetails.model].filter(Boolean).join(' ') || '—'}</dd></div>
              <div><dt>Vehicle plate</dt><dd>{driverDetails.plate || '—'}</dd></div>
            </dl>
          </section>}
          {driver&&details.assignment&&<section className="trip-detail-section trip-detail-assignment trip-detail-passenger"><h2>Passenger needs</h2>
            <dl className="trip-detail-timings">
              <div><dt>Patient contact</dt><dd>{details.assignment.patient_phone}</dd></div>
              <div><dt>Mobility</dt><dd>{details.assignment.mobility==='wheelchair'?'Wheelchair':details.assignment.mobility==='walking-aid'?'Walking aid':'Ambulant'}</dd></div>
              <div><dt>Assistance required</dt><dd>{details.assignment.assistance_required?'Yes':'No'}</dd></div>
            </dl>
          </section>}
        </section>}

        <TripProgress key={details.id} display={detailTab==='details'?'overview':detailTab} onNotify={notifyProgress} trip={details} driver={driver} onChanged={updateTripProgress} onUnavailable={()=>{setDetails(null);setHistoryTrip(null);setPickupAction(null);setRecovering(null);setDetailError('This trip is no longer available to your account.');}} onSessionExpired={onSessionExpired}/>
      </>}
    </section>:<>
    {!coordinator && <section className="dashboard-trips patient-next-pickup trip-next-summary" aria-labelledby="patient-pickup-title"><h2 id="patient-pickup-title">{activeTrip?'Current trip':'Next pickup'}</h2>
      {next ? <><div className="trip-next-reading"><strong>{tripDate(next.treatment_start)} · {next.direction === 'outbound' ? 'Outbound' : 'Return'}</strong>{(driver||caregiver) && <span>{next.patient_name}</span>}<span className={next.pickup_at ? 'trip-next-confirmed' : 'trip-next-note'}>{activeTrip ? 'In progress' : next.pickup_at ? `Pickup at ${tripTime(next.pickup_at)}` : 'Pickup time to be confirmed'}</span></div><InfoButton label="View details" onClick={() => onNavigate(`/dashboard/trips/${next.id}`)} /></> : <p className="patient-overview-note">{loading ? 'Loading pickup details…' : error || syncError ? 'Your pickup details are currently unavailable.' : syncing ? 'Refreshing pickup details…' : driver ? 'No upcoming pickups assigned.' : 'Your upcoming journeys will appear here.'}</p>}
    </section>}
    <section className={`dashboard-trips page-panel trips-panel${coordinator ? ' coordinator-trips-panel' : ''}`} aria-labelledby="trips-title" aria-busy={loading}>
      <PageHeading id="trips-title" title={tripTitle} eyebrow={coordinator ? 'Trip management' : 'Upcoming transport'} level={2}
        actions={<ListToolbar search={search} onSearch={setSearch} label="Search trips" placeholder={coordinator || driver || caregiver ? 'Patient or trip details' : 'Route, date, time or type'} filterCount={activeFilterCount} onFilter={() => { setFilterDraft({ ...filters }); setFilterError(''); }} onSort={() => setSorting(true)} sortLabel={sortSummary(sortOptions, filters.sort, filters.order)} />} />
      {syncError && !error && <ListError title="Trip list needs refreshing" message="The latest pickups and trip statuses could not be loaded." onRetry={() => void refreshProgressMetadata()} />}
      {loading ? <div className="account-loading" role="status"><span className="account-spinner" aria-hidden="true" /><span>Loading...</span></div> : error ? <ListError title="Trips could not be loaded" message="Please try again to load your journeys and trip statuses." onRetry={() => setReload(value => value + 1)} /> : !data?.trips.length ? <div className="dashboard-data-status patients-status" role="status"><div><h3>{driver && !activeFilterCount && !filters.search ? 'No trips assigned.' : 'No trips scheduled.'}</h3><p>{driver && !activeFilterCount && !filters.search ? 'Assigned trips will appear here.' : 'No trips match these filters.'}</p></div></div>
        : <div className="trip-records panel-scroll" role="region" aria-label="Trip list" tabIndex={0}>{data.trips.map((trip, index) => <article className="trip-record" key={trip.id}>
          <div className="trip-record-heading">
            <h3 className="trip-record-title"><span className="trip-date-status"><span>{tripDate(trip.treatment_start)}</span><TripStatus lifecycle={trip.lifecycle} status={trip.status} coordinator={coordinator} driver={driver} /></span><span className="trip-direction-status"><span>{trip.direction === 'outbound' ? 'Outbound' : 'Return'}</span><InlineTripTiming trip={trip} /></span></h3>
            {(coordinator || driver || caregiver) && <p className="trip-patient-identity">{trip.patient_name}</p>}
          </div>
          <div className="trip-route">
            <div className="trip-stop"><div className="trip-stop-heading"><strong>From:</strong></div><p><RouteAddress address={trip.origin} /></p></div>
            <div className="trip-stop"><div className="trip-stop-heading"><strong>To:</strong></div>
              <p><RouteAddress address={trip.destination} /></p>
            </div>
          </div>
          <div className="patient-actions trip-stop-actions">{coordinator && (!trip.lifecycle || trip.lifecycle === 'scheduled') && <button className="list-info-control trip-assignment-control" type="button" aria-label={trip.assigned_driver_id ? 'Manage driver assignment' : 'Assign driver'} title={trip.assigned_driver_id ? 'Manage driver assignment' : 'Assign driver'} disabled={Date.parse(trip.pickup_at ?? trip.treatment_start) <= Date.now()} onClick={() => setAssigning(trip)}>{assignmentIcon}</button>}<InfoButton label="View trip details" onClick={() => onNavigate(`/dashboard/trips/${trip.id}`)} /></div>
          {coordinator && selecting ? <label className="trip-selection-cell"><input type="checkbox" aria-label={`Select ${trip.patient_name}, ${tripDate(trip.treatment_start)}, ${trip.direction === 'outbound' ? 'outbound' : 'return'}`} checked={selectedTrips.has(trip.id)} onChange={() => setSelectedTrips(current => { const updated = new Set(current); if (updated.has(trip.id)) updated.delete(trip.id); else updated.add(trip.id); return updated; })} /></label> : <span className="record-number" title="Row number">{(data.page - 1) * data.pageSize + index + 1}</span>}
        </article>)}</div>}

      {!error && <ListPagination leadingActions={!selecting && coordinator ? <span className="trip-pagination-selection">{selectionButton}</span> : undefined} label={selecting ? 'Trip selection' : 'Trip pages'} actions={coordinator && selecting ? <><button className="trip-selection-delete" type="button" aria-label="Delete selected trips" title="Delete selected trips" disabled={pending || selectedTrips.size === 0} onClick={() => { setBulkDeleting(data?.trips.filter(trip => selectedTrips.has(trip.id)) ?? []); setBulkDeleteResult(''); setBulkDeleteError(''); }}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6m4-6v6" /></svg></button><button className="trip-selection-action trip-select-all" type="button" disabled={pending || !data?.trips.length} onClick={() => setSelectedTrips(current => current.size === data?.trips.length ? new Set() : new Set(data?.trips.map(trip => trip.id)))}><span>{selectedTrips.size > 0 && selectedTrips.size === data?.trips.length ? 'Clear' : 'Select all'}</span></button><button className="trip-selection-action" type="button" onClick={() => { setSelecting(false); setSelectedTrips(new Set()); }}>Cancel</button></> : undefined} page={filters.page} disabled={pending || error} hasNext={!!data && filters.page * data.pageSize < data.total} onPageChange={page => setFilters(current => ({ ...current, page }))}>{coordinator && selecting ? <span role="status">{selectedTrips.size} selected</span> : data && !error ? `${data.total} ${data.total === 1 ? 'trip' : 'trips'} · Page ${filters.page} of ${Math.max(1, Math.ceil(data.total / data.pageSize))}` : loading ? 'Loading...' : 'Trip count unavailable'}</ListPagination>}
    </section>
    </>}
    {sorting && <SortOverlay sort={filters.sort} order={filters.order} options={sortOptions} defaultSort="pickup_time" defaultOrder="asc" onClose={() => setSorting(false)} onApply={(sort, order) => { setFilters(current => ({ ...current, page: 1, sort, order })); setSorting(false); }} />}
    {filterDraft && <Overlay title="Trip filters" description="Choose the journeys to show." className="list-options-dialog" onClose={() => setFilterDraft(null)} onSubmit={applyFilters} noValidate error={filterError} onDismissError={() => setFilterError('')} footer={<><button className="patient-primary" type="submit">Apply Filters</button><button type="button" onClick={() => setFilterDraft(current => current && ({ ...current, ...defaultRange, status: defaultStatus, direction: 'all' }))}>Reset</button><button type="button" onClick={() => setFilterDraft(null)}>Cancel</button></>}><fieldset className="patient-form-fields"><div className="patient-form-wide"><ChoiceGroup label="Status" multiple value={filterDraft.status} options={statusOptions.map(category => ({ value: category.key, label: `${category.label} (${data && !error && !pending ? (data.counts[category.key]??'-') : '-'})` }))} onChange={status => setFilterDraft(current => current && ({ ...current, status }))} /></div><div className="patient-field"><label className="patient-required" htmlFor="trips-from">From date</label><input required id="trips-from" type="date" value={filterDraft.from} max="9999-12-31" onChange={event => { const from = event.target.value; setFilterDraft(current => current ? { ...current, from, until: current.until && current.until < from ? from : current.until } : null); }} /></div><div className="patient-field"><label htmlFor="trips-until">Until date (optional)</label><input id="trips-until" type="date" value={filterDraft.until} min={filterDraft.from} max="9999-12-31" onChange={event => setFilterDraft(current => current ? { ...current, until: event.target.value } : null)} /></div><div className="patient-form-wide"><ChoiceGroup label="Direction" multiple value={filterDraft.direction} options={[{ value: 'outbound', label: 'Outbound' }, { value: 'return', label: 'Return' }]} onChange={direction => setFilterDraft(current => current && ({ ...current, direction }))} /></div></fieldset></Overlay>}
    {bulkDeleting && <Overlay className="trip-delete-dialog" title="Delete selected trips" description={bulkDeleteResult || `Delete ${bulkDeleting.length} selected ${bulkDeleting.length === 1 ? 'trip' : 'trips'}?`} busy={busy} onClose={closeBulkDelete} error={bulkDeleteError} onDismissError={() => setBulkDeleteError('')} footer={bulkDeleteResult ? <button className="patient-primary" type="button" onClick={closeBulkDelete}>Reload trips</button> : <><button className="button-danger" type="button" disabled={busy} onClick={() => void removeSelectedTrips()}>{busy ? 'Deleting…' : `Delete ${bulkDeleting.length} ${bulkDeleting.length === 1 ? 'trip' : 'trips'}`}</button><button type="button" disabled={busy} onClick={closeBulkDelete}>Cancel</button></>}>
      <p className="trip-delete-scope">Only selected, unassigned journeys will be removed. You can restore deleted journeys by generating their trips again.</p>
      <ul className="trip-bulk-delete-list">{bulkDeleting.map(trip => <li key={trip.id}><strong>{trip.patient_name}</strong><span>{tripDate(trip.treatment_start)} · {trip.direction === 'outbound' ? 'Outbound' : 'Return'}</span></li>)}</ul>
    </Overlay>}
    {deleting && <Overlay className="trip-delete-dialog" title="Delete Trip" description="Permanently remove this journey?" busy={busy} onClose={() => { setDeleting(null); setDeleteError(''); }} error={deleteError} onDismissError={() => setDeleteError('')} footer={<><button className={conflict ? 'patient-primary' : 'button-danger'} type="button" disabled={busy} onClick={() => void (conflict ? reloadForDelete() : removeTrip())}>{busy ? 'Loading…' : conflict ? 'Reload trips' : 'Delete Trip'}</button><button type="button" disabled={busy} onClick={() => { setDeleting(null); setDeleteError(''); }}>Cancel</button></>}><div className="trip-delete-summary"><p className="trip-delete-person">{deleting.patient_name}</p><p>{tripDate(deleting.treatment_start)} · {deleting.direction === 'outbound' ? 'Outbound' : 'Return'}</p><p className="trip-delete-destination"><span>Destination</span>{deleting.destination}</p><p className="trip-delete-scope">This deletes one journey only. Its other outbound or return journey stays unchanged.</p></div></Overlay>
}
    {recovering&&<TripRecoveryDialog trip={recovering} onClose={()=>setRecovering(null)} onSessionExpired={onSessionExpired} onAssessed={saved=>{if(renderGeneration===navigation.current.generation)updateTripProgress(saved);}} onChanged={saved=>{if(renderGeneration!==navigation.current.generation)return;setRecovering(null);updateTripProgress(saved);setReload(value=>value+1);setToast('Recovery approved.');}}/>}
    {historyTrip && <TripHistoryDialog tripId={historyTrip} onClose={() => setHistoryTrip(null)} onSessionExpired={onSessionExpired} />}
    {pickupAction && details && <Overlay title={actionLabel} className="trip-delete-dialog" description={`${tripDate(details.treatment_start)} · ${details.direction === 'outbound' ? 'Outbound' : 'Return'}`} busy={pickupBusy} onClose={() => { setPickupAction(null); setPickupError(''); }} error={pickupError} onDismissError={() => setPickupError('')} footer={<>{pickupConflict ? <button className="patient-primary" type="button" disabled={pickupBusy} onClick={() => void submitPickupAction(true)}>Reload trip</button> : <button className={pickupAction === 'confirm' ? 'patient-primary' : 'button-danger'} type="button" disabled={pickupBusy || (pickupAction === 'confirm' ? !canConfirmPickup : pickupAction === 'unavailable' ? !canReportUnavailability : !upcomingDetails)} onClick={() => void submitPickupAction()}>{pickupBusy ? 'Saving…' : actionLabel}</button>}<button type="button" disabled={pickupBusy} onClick={() => { setPickupAction(null); setPickupError(''); }}>Back</button></>}>
      <dl className="schedule-detail-fields"><div><dt>From</dt><dd>{details.origin}</dd></div><div><dt>To</dt><dd>{details.destination}</dd></div>{details.pickup_at && <div><dt>Pickup</dt><dd>{tripTime(details.pickup_at)}</dd></div>}{details.assignment && <div><dt>Driver</dt><dd>{details.assignment.driver_name}</dd></div>}</dl>
      <p className="trip-action-note">{pickupAction === 'cancel' ? 'Cancel this journey? Your other journeys and treatment schedule will stay unchanged.' : pickupAction === 'unavailable' ? 'Report that you cannot fulfil this journey? Your coordinator will be notified. The assignment stays reserved until they resolve it.' : 'Acknowledge your pickup time and driver details.'}</p>
    </Overlay>}
    {assigning && <TripAssignmentDialog trip={assigning} onClose={() => setAssigning(null)} onSessionExpired={onSessionExpired} onChanged={(saved, message) => { if(renderGeneration!==navigation.current.generation)return; setAssigning(null); setDetails(tripId?saved:null); setData(current => current && ({ ...current, trips: current.trips.map(trip => trip.id === saved.id ? saved : trip) })); setReload(value => value + 1); setToast(message); }} />}
    {toast && <ToastRegion announce><Toast key={toast} urgent={toastUrgent} message={toast} onDismiss={() => setToast('')} /></ToastRegion>}
  </div>;
}
