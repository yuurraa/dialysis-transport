import { Toast } from '../components/Toast';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { InfoButton, Overlay, PageHeading, ListToolbar, ListPagination, ChoiceGroup, SortOverlay, ListError, sortSummary } from '../components/DashboardUI';
import { ApiError, apiGet, apiRequest } from '../lib/api';

interface Trip {
  id: string; version: number; patient_id: string; patient_name: string; source_schedule_id: string; session_date: string;
  direction: 'outbound' | 'return'; origin: string; destination: string; treatment_start: string; treatment_end: string;
  arrival_by: string | null; pickup_not_before: string | null; pickup_at: string | null; status: string;
}
interface TripsData { trips: Trip[]; total: number; page: number; pageSize: number; counts: Record<string, number>; next_trip: Trip | null }
const categories = [{ key: 'unfilled', label: 'Unfilled' }, { key: 'at-risk', label: 'At-Risk' }, { key: 'on-track', label: 'On-Track' }, { key: 'resolved', label: 'Resolved' }];
const tripSortOptions = [{ value: 'treatment_start', label: 'Treatment date', ascending: 'Earliest first', descending: 'Latest first' }, { value: 'patient_name', label: 'Patient name' }, { value: 'direction', label: 'Direction', ascending: 'Outbound first', descending: 'Return first' }, { value: 'status', label: 'Status', ascending: 'At-Risk → On-Track → Resolved → Unfilled', descending: 'Unfilled → Resolved → On-Track → At-Risk' }];
function TripStatus({ status }: { status: string }) {
  const category = categories.find(item => item.key === status);
  return <span className={`trip-status-badge trip-status-${category?.key ?? 'unknown'}`}>{category?.label ?? (status || 'Status unavailable')}</span>;
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
function MobileTripTiming({ trip }: { trip: Trip }) {
  const timing = trip.pickup_at ? `Pickup at ${tripTime(trip.pickup_at)}`
    : trip.direction === 'outbound' && trip.arrival_by ? `Arrive by ${tripTime(trip.arrival_by)}`
    : trip.direction === 'return' && trip.pickup_not_before ? `Earliest pickup ${tripTime(trip.pickup_not_before)}` : null;
  return timing ? <p className="trip-mobile-timing">{timing}</p> : null;
}
function JourneyDetails({ trip }: { trip: Trip }) {
  return <div className="trip-journey-details"><ol className="trip-detail-route" aria-label="Journey route"><li><div><span>From</span><p>{trip.origin}</p></div></li><li><div><span>To</span><p>{trip.destination}</p></div></li></ol>
    <dl className="trip-detail-timings"><div><dt>Treatment</dt><dd>{tripTime(trip.treatment_start)} - {tripTime(trip.treatment_end)}</dd></div>
      {trip.arrival_by && <div><dt>Arrival by</dt><dd>{tripTime(trip.arrival_by)}</dd></div>}
      {trip.pickup_not_before && <div><dt>Earliest return pickup</dt><dd>{tripTime(trip.pickup_not_before)}</dd></div>}
    </dl></div>;

}

interface Filters { page: number; from: string; until: string; status: string; search: string; direction: string; sort: string; order: string }
export default function TripsPage({ coordinator, onSessionExpired }: { coordinator: boolean; onSessionExpired: () => void }) {
  const [defaultRange] = useState(() => { const from = singaporeToday(); return { from, until: addDays(from, 30) }; });
  const [filters, setFilters] = useState<Filters>(() => ({ page: 1, ...defaultRange, status: 'all', search: '', direction: 'all', sort: 'treatment_start', order: 'asc' }));
  const [search, setSearch] = useState('');
  const [filterDraft, setFilterDraft] = useState<Filters | null>(null);
  const [sorting, setSorting] = useState(false);
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
  return <div className="trips-workspace">
    {!coordinator && <section className="dashboard-trips patient-next-pickup trip-next-summary" aria-labelledby="patient-pickup-title"><h2 id="patient-pickup-title">Next pickup</h2>
      {next ? <><div className="trip-next-reading"><strong>{tripDate(next.treatment_start)} · {next.direction === 'outbound' ? 'Outbound' : 'Return'}</strong><span className={next.pickup_at ? 'trip-next-confirmed' : 'trip-next-note'}>{next.pickup_at ? `Pickup at ${tripTime(next.pickup_at)}` : 'Pickup time to be confirmed'}</span></div><InfoButton label="View details" onClick={() => setDetails(next)} /></> : <p className="patient-overview-note">{loading ? 'Loading pickup details…' : error ? 'Your pickup details are currently unavailable.' : 'Your next journey will appear once transport is generated.'}</p>}
    </section>}
    <section className="dashboard-trips page-panel trips-panel" aria-labelledby="trips-title" aria-busy={loading}>
      <PageHeading id="trips-title" title={coordinator ? selected ? `${selected.label} trips` : filters.from === singaporeToday() && filters.until === filters.from ? "Today's trips" : 'Trip List' : 'Your rides'} eyebrow={coordinator ? 'Trip management' : 'Upcoming transport'} level={2}
        actions={<ListToolbar search={search} onSearch={setSearch} label="Search trips" placeholder={coordinator ? 'Patient or trip details' : 'Route, date, time or type'} filterCount={activeFilterCount} onFilter={() => { setFilterDraft({ ...filters }); setFilterError(''); }} onSort={() => setSorting(true)} sortLabel={sortSummary(tripSortOptions, filters.sort, filters.order)} />} />
      {loading ? <div className="account-loading" role="status"><span className="account-spinner" aria-hidden="true" /><span>Loading...</span></div> : error ? <ListError title="Trips could not be loaded" message="Please try again to load your journeys and trip statuses." onRetry={() => setReload(value => value + 1)} /> : !data?.trips.length ? <div className="dashboard-data-status patients-status" role="status"><div><h3>No trips scheduled.</h3><p>No trips match these filters.</p></div></div>
        : <div className="trip-records panel-scroll" role="region" aria-label="Trip list" tabIndex={0}>{data.trips.map((trip, index) => <article className="trip-record" key={trip.id}>
          <div className="trip-record-heading">
            <h3 className="trip-record-title"><span>{tripDate(trip.treatment_start)}</span><span className="trip-direction-status"><span>{trip.direction === 'outbound' ? 'Outbound' : 'Return'}</span><TripStatus status={trip.status} /></span></h3>
            {coordinator && <p className="trip-patient-identity">{trip.patient_name}</p>}
            <MobileTripTiming trip={trip} />
          </div>
          <div className="trip-route">
            <div className="trip-stop"><div className="trip-stop-heading"><strong>From:</strong></div><p><RouteAddress address={trip.origin} /></p></div>
            <div className="trip-stop"><div className="trip-stop-heading"><strong>To:</strong></div>
              <p><RouteAddress address={trip.destination} /></p>
            </div>
          </div>
          <div className="patient-actions trip-stop-actions"><InfoButton label="View trip details" onClick={() => setDetails(trip)} /></div>
          <span className="record-number" title="Row number">{(data.page - 1) * data.pageSize + index + 1}</span>
        </article>)}</div>}

      {!error && <ListPagination label="Trip pages" page={filters.page} disabled={pending || error} hasNext={!!data && filters.page * data.pageSize < data.total} onPageChange={page => setFilters(current => ({ ...current, page }))}>{data && !error ? `${data.total} ${data.total === 1 ? 'trip' : 'trips'} · Page ${filters.page} of ${Math.max(1, Math.ceil(data.total / data.pageSize))}` : loading ? 'Loading...' : 'Trip count unavailable'}</ListPagination>}
    </section>
    {sorting && <SortOverlay sort={filters.sort} order={filters.order} options={tripSortOptions.filter(option => coordinator || option.value !== 'patient_name')} defaultSort="treatment_start" defaultOrder="asc" onClose={() => setSorting(false)} onApply={(sort, order) => { setFilters(current => ({ ...current, page: 1, sort, order })); setSorting(false); }} />}
    {filterDraft && <Overlay title="Trip filters" description="Choose the journeys to show." className="list-options-dialog" onClose={() => setFilterDraft(null)} onSubmit={applyFilters} noValidate error={filterError} onDismissError={() => setFilterError('')} footer={<><button className="patient-primary" type="submit">Apply Filters</button><button type="button" onClick={() => setFilterDraft(current => current && ({ ...current, ...defaultRange, status: 'all', direction: 'all' }))}>Reset</button><button type="button" onClick={() => setFilterDraft(null)}>Cancel</button></>}><fieldset className="patient-form-fields">{coordinator && <div className="patient-form-wide"><ChoiceGroup label="Status" multiple value={filterDraft.status} options={categories.map(category => ({ value: category.key, label: `${category.label} (${data && !error && !pending ? data.counts[category.key] : '-'})` }))} onChange={status => setFilterDraft(current => current && ({ ...current, status }))} /></div>}<div className="patient-field"><label htmlFor="trips-from">From date</label><input id="trips-from" type="date" value={filterDraft.from} max="9999-12-31" onChange={event => { const from = event.target.value; setFilterDraft(current => current ? { ...current, from, until: current.until < from ? from : current.until > addDays(from, 89) ? addDays(from, 89) : current.until } : null); }} /></div><div className="patient-field"><label htmlFor="trips-until">Until date</label><input id="trips-until" type="date" value={filterDraft.until} min={filterDraft.from} max={addDays(filterDraft.from, 89)} onChange={event => setFilterDraft(current => current ? { ...current, until: event.target.value } : null)} /></div><div className="patient-form-wide"><ChoiceGroup label="Direction" multiple value={filterDraft.direction} options={[{ value: 'outbound', label: 'Outbound' }, { value: 'return', label: 'Return' }]} onChange={direction => setFilterDraft(current => current && ({ ...current, direction }))} /></div></fieldset></Overlay>}
    {deleting ? <Overlay className="trip-delete-dialog" title="Delete Trip" description="Permanently remove this journey?" busy={busy} onClose={() => { setDeleting(null); setDeleteError(''); }} error={deleteError} onDismissError={() => setDeleteError('')} footer={<><button className={conflict ? 'patient-primary' : 'button-danger'} type="button" disabled={busy} onClick={() => void (conflict ? reloadForDelete() : removeTrip())}>{busy ? 'Loading…' : conflict ? 'Reload trips' : 'Delete Trip'}</button><button type="button" disabled={busy} onClick={() => { setDeleting(null); setDeleteError(''); }}>Cancel</button></>}><div className="trip-delete-summary"><p className="trip-delete-person">{deleting.patient_name}</p><p>{tripDate(deleting.treatment_start)} · {deleting.direction === 'outbound' ? 'Outbound' : 'Return'}</p><p className="trip-delete-destination"><span>Destination</span>{deleting.destination}</p><p className="trip-delete-scope">This deletes one journey only. Its other outbound or return journey stays unchanged.</p></div></Overlay>
      : details && <Overlay className="trip-details-dialog" title="Trip details" description={<span className="trip-detail-heading"><span>{tripDate(details.treatment_start)}</span><span className="trip-direction-status"><span>{details.direction === 'outbound' ? 'Outbound' : 'Return'}</span><TripStatus status={details.status} /></span></span>} onClose={() => setDetails(null)} footer={<>{coordinator && <button className="button-danger" type="button" aria-label="Delete Trip" title="Delete Trip" onClick={() => confirmDelete(details)}>Delete Trip</button>}<button type="button" aria-label="Close Trip details" onClick={() => setDetails(null)}>Close</button></>}>
        <div className="trip-detail-identity"><p className="trip-detail-name">{details.patient_name}</p><p className="trip-detail-id">Patient ID: {details.patient_id}</p>{details.pickup_at && <p>Pickup {tripTime(details.pickup_at)}</p>}</div><JourneyDetails trip={details} />
      </Overlay>}
    {toast && <div className="toast-region" role="status" aria-live="polite" aria-atomic="true"><Toast key={toast} message={toast} onDismiss={() => setToast('')} /></div>}
  </div>;
}
