import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Overlay, PageHeading } from '../components/DashboardUI';
import { Dropdown } from '../components/Dropdown';
import { ApiError, apiGet, apiRequest } from '../lib/api';

interface Trip {
  id: string; version: number; patient_id: string; patient_name: string; source_schedule_id: string; session_date: string;
  direction: 'outbound' | 'return'; origin: string; destination: string; treatment_start: string; treatment_end: string;
  arrival_by: string | null; pickup_not_before: string | null; pickup_at: string | null; review_required: boolean; status: string;
}
interface TripsData { trips: Trip[]; total: number; page: number; pageSize: number; counts: Record<string, number>; next_trip: Trip | null }
const categories = [{ key: 'unfilled', label: 'Unfilled' }, { key: 'at-risk', label: 'At-Risk' }, { key: 'on-track', label: 'On-Track' }, { key: 'resolved', label: 'Resolved' }];
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
function JourneyDetails({ trip }: { trip: Trip }) {
  return <div className="trip-journey-details"><ol className="trip-detail-route" aria-label="Journey route"><li><div><span>From</span><p>{trip.origin}</p></div></li><li><div><span>To</span><p>{trip.destination}</p></div></li></ol>
    <dl className="trip-detail-timings"><div><dt>Treatment</dt><dd>{tripTime(trip.treatment_start)} - {tripTime(trip.treatment_end)}</dd></div>
      {trip.arrival_by && <div><dt>Arrival by</dt><dd>{tripTime(trip.arrival_by)}</dd></div>}
      {trip.pickup_not_before && <div><dt>Earliest return pickup</dt><dd>{tripTime(trip.pickup_not_before)}</dd></div>}
    </dl>{trip.review_required && <p className="trip-detail-review">Treatment requirements changed; timings need review.</p>}</div>;

}

interface Filters { page: number; from: string; until: string; status: string; search: string; direction: string }
function Timing({ trip }: { trip: Trip }) {
  return <span>{trip.arrival_by ? `Arrival by ${tripTime(trip.arrival_by)}` : trip.pickup_not_before ? `Earliest return pickup ${tripTime(trip.pickup_not_before)}` : 'Timing pending'}</span>;
}

export default function TripsPage({ coordinator, onSessionExpired }: { coordinator: boolean; onSessionExpired: () => void }) {
  const [defaultRange] = useState(() => { const from = singaporeToday(); return { from, until: addDays(from, 30) }; });
  const [filters, setFilters] = useState<Filters>(() => ({ page: 1, ...defaultRange, status: 'all', search: '', direction: 'all' }));
  const [search, setSearch] = useState('');
  const [filterDraft, setFilterDraft] = useState<Filters | null>(null);
  const [filterError, setFilterError] = useState('');
  const [details, setDetails] = useState<Trip | null>(null);
  const [deleting, setDeleting] = useState<Trip | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [toast, setToast] = useState('');
  const [data, setData] = useState<TripsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [reload, setReload] = useState(0);
  const alive = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => setFilters(current => current.search === search.trim() ? current : { ...current, page: 1, search: search.trim() }), 300);
    return () => window.clearTimeout(timer);
  }, [search]);
  const query = new URLSearchParams({ ...filters, page: String(filters.page) }).toString();
  useEffect(() => {
    let active = true;
    setLoading(true); setError(false);
    apiGet<TripsData>(`/trips?${query}`)
      .then(result => {
        if (!active) return;
        const lastPage = Math.max(1, Math.ceil(result.total / result.pageSize));
        if (filters.page > lastPage) { setFilters(current => ({ ...current, page: lastPage })); return; }
        setData(result);
      })
      .catch(reason => { if (active) { setData(null); setError(true); if (reason instanceof ApiError && reason.status === 401) onSessionExpired(); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [query, reload, onSessionExpired, filters.page]);
  function applyFilters(event: FormEvent) {
    event.preventDefault();
    if (!filterDraft) return;
    const { from, until } = filterDraft;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || from < '0001-01-01' || !/^\d{4}-\d{2}-\d{2}$/.test(until) || until < from || until > addDays(from, 89)) { setFilterError('Choose a valid date range of at most 90 days.'); return; }
    setFilters(current => ({ ...current, page: 1, from, until, direction: filterDraft.direction, status: filterDraft.status })); setFilterDraft(null); setFilterError('');
  }
  function confirmDelete(trip: Trip) { setDeleting(trip); setDeleteError(''); setConflict(false); }
  async function removeTrip() {
    if (!deleting || busy || conflict) return;
    setBusy(true); setDeleteError('');
    try {
      await apiRequest(`/trips/${deleting.id}`, 'DELETE', { version: deleting.version });
      if (!alive.current) return;
      setDeleting(null); setDetails(null); setToast('Trip deleted.'); setReload(value => value + 1);
    } catch (reason) {
      if (!alive.current) return;
      if (reason instanceof ApiError && reason.status === 401) onSessionExpired();
      if (reason instanceof ApiError && [404, 409].includes(reason.status)) { setConflict(true); setDeleteError('This trip changed or is no longer available. Reload trips before deleting again.'); }
      else setDeleteError('This trip could not be deleted. Please try again.');
    } finally { if (alive.current) setBusy(false); }
  }
  async function reloadForDelete() {
    if (!deleting || busy) return;
    setBusy(true);
    try {
      const result = await apiGet<TripsData>(`/trips?${query}`);
      if (!alive.current) return;
      setData(result);
      const latest = [...result.trips, ...(result.next_trip ? [result.next_trip] : [])].find(trip => trip.id === deleting.id);
      if (!latest) { setDeleteError('This trip is no longer in the current results. Cancel and reopen its latest details.'); return; }
      setDeleting(latest); if (details) setDetails(latest); setConflict(false); setDeleteError('');
    } catch (reason) {
      if (!alive.current) return;
      if (reason instanceof ApiError && reason.status === 401) onSessionExpired();
      setDeleteError('Trips could not be reloaded. Please try again.');
    } finally { if (alive.current) setBusy(false); }
  }
  const activeFilterCount = Number(filters.from !== defaultRange.from || filters.until !== defaultRange.until) + Number(filters.direction !== 'all') + Number(filters.status !== 'all');
  const selected = categories.find(category => category.key === filters.status);
  const next = data?.next_trip;
  const pending = loading || search.trim() !== filters.search;
  const trash = <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6m4-6v6" /></svg>;
  return <div className="trips-workspace">
    {!coordinator && <section className="dashboard-trips patient-next-pickup trip-next-summary" aria-labelledby="patient-pickup-title"><PageHeading id="patient-pickup-title" title="Next pickup" eyebrow="Your next journey" level={2} actions={next && <button type="button" onClick={() => setDetails(next)}>View details</button>} />
      {next ? <><div className="trip-next-reading"><strong className="trip-pickup-pending">{next.pickup_at ? tripTime(next.pickup_at) : 'Pickup pending'}</strong><span>{tripDate(next.treatment_start)} · {next.direction === 'outbound' ? 'Outbound' : 'Return'}</span><Timing trip={next} />{next.review_required && <span className="dashboard-access">Needs review</span>}</div><p className="trip-next-destination">To {next.destination}</p></> : <p className="patient-overview-note">{loading ? 'Loading pickup details…' : error ? 'Your pickup details are currently unavailable.' : 'Your next journey will appear once transport is generated.'}</p>}
    </section>}
    <section className="dashboard-trips page-panel trips-panel" aria-labelledby="trips-title" aria-busy={loading}>
      <PageHeading id="trips-title" title={coordinator ? selected ? `${selected.label} trips` : filters.from === singaporeToday() && filters.until === filters.from ? "Today's trips" : 'Trip List' : 'Your rides'} eyebrow={coordinator ? 'Trip management' : 'Upcoming transport'} level={2}
        actions={<div className="trip-search-tools"><label className="patient-search"><svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></svg><input type="search" aria-label="Search trips" placeholder={coordinator ? 'Patient or trip details' : 'Route, date, time or type'} maxLength={100} value={search} onChange={event => setSearch(event.target.value)} /></label><button className="trip-filter-button" type="button" aria-label="Filters" title={activeFilterCount ? `Filters (${activeFilterCount} active)` : 'Filters'} onClick={() => { setFilterDraft({ ...filters }); setFilterError(''); }}><svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M4 5h16l-6 7v6l-4 2v-8z" /></svg>{activeFilterCount > 0 && <span className="trip-filter-badge" aria-label={`${activeFilterCount} active filters`}>{activeFilterCount}</span>}</button></div>} />
      {loading ? <div className="account-loading" role="status"><span className="account-spinner" aria-hidden="true" /><span>Loading...</span></div> : error ? <div className="dashboard-data-status patients-status" role="status"><div><h3>Trip information is not available.</h3><p>Trip statuses and counts cannot be displayed right now.</p><button type="button" onClick={() => setReload(value => value + 1)}>Retry trips</button></div></div> : !data?.trips.length ? <div className="dashboard-data-status patients-status" role="status"><div><h3>No trips scheduled.</h3><p>No trips match these filters.</p></div></div>
        : <div className="trip-records panel-scroll" role="region" aria-label="Trip list" tabIndex={0}>{data.trips.map(trip => <article className="trip-record" key={trip.id}><div className="trip-record-heading"><h3>{tripDate(trip.treatment_start)} · {trip.direction === 'outbound' ? 'Outbound' : 'Return'}</h3><span className="dashboard-access">Unfilled</span>{trip.review_required && <span className="dashboard-access">Needs review</span>}</div>{coordinator && <p className="trip-patient-identity">{trip.patient_name} <span aria-hidden="true">·</span> Patient ID: {trip.patient_id}</p>}<p className="trip-route"><span><strong>From:</strong> {trip.origin}</span><span><strong>To:</strong> {trip.destination}</span></p><div className="trip-card-bottom"><div className="trip-key-times"><strong className="trip-pickup-pending">{trip.pickup_at ? `Pickup ${tripTime(trip.pickup_at)}` : 'Pickup pending'}</strong><Timing trip={trip} /></div><div className="patient-actions"><button type="button" onClick={() => setDetails(trip)}>View details</button>{coordinator && <button className="trip-delete-control" type="button" aria-label="Delete Trip" title="Delete Trip" onClick={() => confirmDelete(trip)}>{trash}</button>}</div></div></article>)}</div>}
      <div className="patients-pagination" aria-label="Trip pages"><span>{data && !error ? `${data.total} ${data.total === 1 ? 'trip' : 'trips'} · Page ${filters.page} of ${Math.max(1, Math.ceil(data.total / data.pageSize))}` : loading ? 'Loading...' : 'Trip count unavailable'}</span><div className="patient-actions"><button type="button" aria-label="Previous" title="Previous page" disabled={pending || error || filters.page === 1} onClick={() => setFilters(current => ({ ...current, page: current.page - 1 }))}>{'<'}</button><button type="button" aria-label="Next" title="Next page" disabled={pending || error || !data || filters.page * data.pageSize >= data.total} onClick={() => setFilters(current => ({ ...current, page: current.page + 1 }))}>{'>'}</button></div></div>
    </section>
    {filterDraft && <Overlay title="Trip filters" description="Choose the journeys to show." onClose={() => setFilterDraft(null)} onSubmit={applyFilters} noValidate error={filterError} onDismissError={() => setFilterError('')} footer={<><button className="patient-primary" type="submit">Apply Filters</button><button type="button" onClick={() => setFilterDraft(null)}>Cancel</button></>}><fieldset className="patient-form-fields">{coordinator && <div className="patient-field patient-form-wide"><label htmlFor="trips-status">Status</label><Dropdown id="trips-status" label="Status" value={filterDraft.status} options={[{ value: 'all', label: 'All trips' }, ...categories.map(category => ({ value: category.key, label: `${category.label} (${data && !error && !pending ? data.counts[category.key] : '-'})` }))]} onChange={status => setFilterDraft(current => current ? { ...current, status } : null)} /></div>}<div className="patient-field"><label htmlFor="trips-from">From date</label><input id="trips-from" type="date" value={filterDraft.from} max="9999-12-31" onChange={event => { const from = event.target.value; setFilterDraft(current => current ? { ...current, from, until: current.until < from ? from : current.until > addDays(from, 89) ? addDays(from, 89) : current.until } : null); }} /></div><div className="patient-field"><label htmlFor="trips-until">Until date</label><input id="trips-until" type="date" value={filterDraft.until} min={filterDraft.from} max={addDays(filterDraft.from, 89)} onChange={event => setFilterDraft(current => current ? { ...current, until: event.target.value } : null)} /></div><div className="patient-field patient-form-wide"><label htmlFor="trips-direction">Direction</label><Dropdown id="trips-direction" label="Direction" value={filterDraft.direction} options={[{ value: 'all', label: 'All directions' }, { value: 'outbound', label: 'Outbound' }, { value: 'return', label: 'Return' }]} onChange={direction => setFilterDraft(current => current ? { ...current, direction } : null)} /></div></fieldset></Overlay>}
    {deleting ? <Overlay title="Delete Trip" description="Review this journey before confirming." busy={busy} onClose={() => { setDeleting(null); setDeleteError(''); }} error={deleteError} onDismissError={() => setDeleteError('')} footer={<><button className={conflict ? 'patient-primary' : 'button-danger'} type="button" disabled={busy} onClick={() => void (conflict ? reloadForDelete() : removeTrip())}>{busy ? 'Loading…' : conflict ? 'Reload trips' : 'Delete Trip'}</button><button type="button" disabled={busy} onClick={() => { setDeleting(null); setDeleteError(''); }}>Cancel</button></>}><p>This deletes one journey only. Its other outbound or return journey stays unchanged.</p><p>{deleting.patient_name} · {tripDate(deleting.treatment_start)} · {deleting.direction === 'outbound' ? 'Outbound' : 'Return'}</p><JourneyDetails trip={deleting} /></Overlay>
      : details && <Overlay className="trip-details-dialog" title="Trip details" description={`${tripDate(details.treatment_start)} · ${details.direction === 'outbound' ? 'Outbound' : 'Return'}`} onClose={() => setDetails(null)} footer={<><button className="patient-primary" type="button" onClick={() => setDetails(null)}>Close</button>{coordinator && <button className="overlay-delete" type="button" aria-label="Delete Trip" title="Delete Trip" onClick={() => confirmDelete(details)}>{trash}<span className="delete-label">Delete Trip</span></button>}</>}><div className="trip-detail-identity"><p className="trip-detail-name">{details.patient_name}</p><p className="trip-detail-id">Patient ID: {details.patient_id}</p><div className="trip-detail-badges"><span className="dashboard-access">Unfilled</span><span className="dashboard-access">{details.pickup_at ? `Pickup ${tripTime(details.pickup_at)}` : 'Pickup pending'}</span></div></div><JourneyDetails trip={details} /></Overlay>}
    {toast && <div className="trip-toast-region"><div className="auth-toast" role="status"><p>{toast}</p><button type="button" aria-label="Dismiss notification" onClick={() => setToast('')}>×</button></div></div>}
  </div>;
}
