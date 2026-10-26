import { useDashboardViewState } from '../components/DashboardViewState';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import DriverAvailabilityDialog from '../components/DriverAvailabilityDialog';
import { ApiError, apiGet, apiRequest } from '../lib/api';
import { ChoiceGroup, InfoButton, ListError, ListPagination, ListToolbar, Overlay, PageHeading, SortOverlay, sortSummary } from '../components/DashboardUI';
import { PersonalFields, emptyPersonal, type PersonalDetails } from '../components/PersonalFields';
import { driverError, registrationLabels, type DriverVehicle } from './DriverRegistration';

interface Driver {
  id: string; display_name: string; email: string; account_status: 'active' | 'inactive'; status_version: number;
  profile: PersonalDetails | null; vehicle: DriverVehicle | null;
}
interface DriverList { drivers: Driver[]; total: number; page: number; pageSize: number }
const driverColumns = [{ key: 'id', label: 'Driver ID' }, { key: 'full_name', label: 'Name' }, { key: 'phone', label: 'Contact' }, { key: 'plate_number', label: 'Vehicle' }, { key: 'status', label: 'Registration' }] as const;
type DriverSort = typeof driverColumns[number]['key'] | 'created_at';
const driverSortOptions = [{ value: 'created_at', label: 'Created date', ascending: 'Oldest first', descending: 'Newest first' }, ...driverColumns.map(column => ({ value: column.key, label: column.label, ...(column.key === 'phone' ? { ascending: '0–9', descending: '9–0' } : {}) }))];
const reviewDate = (value: string) => new Intl.DateTimeFormat('en-SG', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Singapore' }).format(new Date(value));

export default function DriversPage({ notify, onSessionExpired }: { notify: (message: string) => void; onSessionExpired: () => void }) {
  const [filters, setFilters] = useDashboardViewState<{ page: number; search: string; status: string; sort: DriverSort; direction: 'asc' | 'desc' }>('drivers',{ page: 1, search: '', status: 'all', sort: 'created_at', direction: 'desc' });
  const [sorting, setSorting] = useState(false);
  const [search, setSearch] = useState(filters.search);
  const [filterDraft, setFilterDraft] = useState<string | null>(null);
  const [list, setList] = useState<DriverList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [detailView, setDetailView] = useState<'driver' | 'car' | 'schedule'>('driver');
  const [selected, setSelected] = useState<Driver | null>(null);
  const [editing, setEditing] = useState(false);
  const [statusDraft, setStatusDraft] = useState<'active' | 'inactive'>('active');
  const editButton = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  useEffect(() => {
    if (editing) document.getElementById('driver-status')?.focus();
    else if (wasEditing.current) editButton.current?.focus();
    wasEditing.current = editing;
  }, [editing]);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [reviewError, setReviewError] = useState('');
  const [conflict, setConflict] = useState(false);
  const alive = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => setFilters(current => current.search === search.trim() ? current : { ...current, page: 1, search: search.trim() }), 300);
    return () => window.clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    let active = true; setLoading(true); setError('');
    apiGet<DriverList>(`/drivers?${new URLSearchParams({ page: String(filters.page), search: filters.search, status: filters.status, sort: filters.sort, direction: filters.direction })}`).then(result => {
      if (!active) return;
      const lastPage = Math.max(1, Math.ceil(result.total / result.pageSize));
      if (filters.page > lastPage) { setFilters(current => ({ ...current, page: lastPage })); return; }
      setList(result);
    }).catch(reason => {
      if (!active) return;
      if (reason instanceof ApiError && reason.status === 401) onSessionExpired();
      setError(driverError(reason));
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [filters, reload, onSessionExpired]);

  function open(driver: Driver, view: 'driver' | 'car' | 'schedule' = 'driver') {
    setDetailView(view);
    setSelected(driver); setStatusDraft(driver.account_status); setEditing(false);
    setReason(''); setReviewError(''); setConflict(false);
  }
  function close() { setSelected(null); setEditing(false); setReviewError(''); setConflict(false); }
  async function saveStatus(event: FormEvent) {
    event.preventDefault();
    if (!selected || !editing || saving || conflict) return;
    setSaving(true); setReviewError('');
    try {
      const saved = await apiRequest<Pick<Driver, 'id' | 'account_status' | 'status_version'>>(`/drivers/${selected.id}`, 'PATCH', { status: statusDraft, version: selected.status_version });
      if (!alive.current) return;
      setSelected(current => current && ({ ...current, ...saved }));
      setEditing(false); setReload(value => value + 1); notify('Driver details updated.');
    } catch (reason) {
      if (!alive.current) return;
      if (reason instanceof ApiError && reason.status === 401) onSessionExpired();
      setConflict(reason instanceof ApiError && reason.status === 409);
      setReviewError(reason instanceof ApiError && reason.status === 409 ? 'This driver changed since you opened it. Your edits are still here. Reload the latest details before saving.' : driverError(reason));
    } finally { if (alive.current) setSaving(false); }
  }
  async function reloadSelected() {
    if (!selected || saving) return;
    setSaving(true);
    try {
      const result = await apiGet<DriverList>(`/drivers?search=${encodeURIComponent(selected.id)}`);
      if (!alive.current) return;
      const latest = result.drivers.find(driver => driver.id === selected.id);
      if (!latest) { setReviewError('This driver record is no longer available.'); return; }
      setSelected(latest); setStatusDraft(latest.account_status); setConflict(false); setReviewError(''); setReload(value => value + 1);
    } catch (reason) {
      if (!alive.current) return;
      if (reason instanceof ApiError && reason.status === 401) onSessionExpired();
      setReviewError('Latest driver details could not be loaded. Your edits are still here.');
    } finally { if (alive.current) setSaving(false); }
  }

  async function review(decision: 'approved' | 'rejected') {
    if (!selected?.vehicle || saving || conflict) return;
    if (decision === 'rejected' && !reason.trim()) { setReviewError('Enter a reason before rejecting this registration.'); return; }
    setSaving(true); setReviewError('');
    try {
      await apiRequest(`/drivers/${selected.id}/review`, 'PATCH', { version: selected.vehicle.version, decision, reason });
      if (!alive.current) return;
      notify(decision === 'approved' ? 'Driver registration approved.' : 'Driver registration rejected.');
      setSelected(null); setReload(value => value + 1);
    } catch (reason) {
      if (!alive.current) return;
      if (reason instanceof ApiError && reason.status === 401) onSessionExpired();
      setConflict(reason instanceof ApiError && reason.status === 409); setReviewError(driverError(reason));
    } finally { if (alive.current) setSaving(false); }
  }
  function sortDrivers(column: typeof driverColumns[number]['key']) {
    setFilters(current => current.sort === column && current.direction === 'desc'
      ? { ...current, page: 1, sort: 'created_at', direction: 'desc' }
      : { ...current, page: 1, sort: column, direction: current.sort === column ? 'desc' : 'asc' });
  }
  const updating = loading || search.trim() !== filters.search;
  const driverIcon = <span className="dashboard-data-status-icon" aria-hidden="true"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><circle cx="12" cy="8" r="4" /><path d="M4 21v-2a8 8 0 0 1 16 0v2" /></svg></span>;
  const canReview = selected?.vehicle?.status === 'pending' && selected.account_status === 'active';
  return <section className="dashboard-trips patients-panel drivers-panel page-panel" aria-labelledby="drivers-title" aria-busy={updating}>
    <PageHeading id="drivers-title" title="Driver List" eyebrow="Driver Management" actions={<ListToolbar search={search} onSearch={setSearch} label="Search drivers" placeholder="Driver name, phone, ID or vehicle plate" filterCount={Number(filters.status !== 'all')} onFilter={() => setFilterDraft(filters.status)} onSort={() => setSorting(true)} sortLabel={sortSummary(driverSortOptions, filters.sort, filters.direction)} />} />
    {loading && !list ? <div className="account-loading patients-loading" role="status" aria-label="Loading drivers"><span className="account-spinner" aria-hidden="true" /><span>Loading...</span></div>
      : error ? <ListError title="Drivers could not be loaded" message={error} onRetry={() => setReload(value => value + 1)} />
      : list?.drivers.length ? <div className="patients-table-scroll" tabIndex={0} role="region" aria-label="Driver records">
        <table className="patients-table"><colgroup>{[5, 24, 19, 16, 12, 12, 0].map((width, index) => <col key={index} style={{ width: index === 6 ? '176px' : `${width}%` }} />)}</colgroup>
          <thead><tr><th scope="col" className="record-number-heading" aria-label="Row number">#</th>{driverColumns.map(column => <th key={column.key} scope="col" aria-label={column.label} aria-sort={filters.sort === column.key ? filters.direction === 'asc' ? 'ascending' : 'descending' : 'none'}>
            <button type="button" className="patient-sort-button" aria-label={filters.sort === column.key && filters.direction === 'desc' ? `Reset ${column.label} ordering` : `Sort by ${column.label} ${filters.sort === column.key ? 'descending' : 'ascending'}`} onClick={() => sortDrivers(column.key)}>{column.label}{filters.sort === column.key && <span aria-hidden="true">{filters.direction === 'asc' ? '▲' : '▼'}</span>}</button>
          </th>)}<th scope="col" aria-label="Details" /></tr></thead>
          <tbody>{list.drivers.map((driver, index) => <tr key={driver.id}>
            <td className="record-number">{(list.page - 1) * list.pageSize + index + 1}</td><td className="patient-record-id">{driver.id}</td>
            <td className="patient-record-name">{driver.profile?.full_name ?? driver.display_name}{driver.account_status === 'inactive' && ' (Account inactive)'}</td>
            <td data-label="Contact">{driver.profile?.phone ?? 'Not provided'}</td><td data-label="Vehicle">{driver.vehicle?.plate_number ?? 'Not submitted'}</td>
            <td data-label="Registration">{registrationLabels[driver.vehicle?.status ?? 'not-submitted']}</td>
            <td className="patient-record-action"><div className="driver-record-actions">
              <button className="list-info-control" type="button" aria-label={`View availability for ${driver.profile?.full_name ?? driver.display_name}`} title="Weekly availability" disabled={updating} onClick={() => open(driver, 'schedule')}><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M7 3v4m10-4v4M3 11h18M7 15h2m3 0h2m3 0h.01M7 18h2" /></svg></button>
              <button className="list-info-control" type="button" aria-label={`View car for ${driver.profile?.full_name ?? driver.display_name}`} title="Car details" disabled={updating} onClick={() => open(driver, 'car')}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m5 10 2-6h10l2 6M5 10h14a2 2 0 0 1 2 2v6H3v-6a2 2 0 0 1 2-2ZM5 18v2m14-2v2M7 14h.01M17 14h.01" /></svg>
              </button>
              <InfoButton label={`View ${driver.profile?.full_name ?? driver.display_name}`} disabled={updating} onClick={() => open(driver)} />
            </div></td>
          </tr>)}</tbody>
        </table>
      </div> : <div className="dashboard-data-status patients-status" role="status">{driverIcon}<div><h3>{filters.search || filters.status !== 'all' ? 'No matching drivers.' : 'No drivers yet.'}</h3><p>{filters.search || filters.status !== 'all' ? 'Try another search or change the filters.' : 'Drivers appear here after completing account creation.'}</p></div></div>}
    {!error && <ListPagination label="Driver pages" page={filters.page} disabled={updating || saving} hasNext={!!list && filters.page * list.pageSize < list.total} onPageChange={page => setFilters(current => ({ ...current, page }))}>{list ? `${list.total} ${list.total === 1 ? 'driver' : 'drivers'} · Page ${list.page} of ${Math.max(1, Math.ceil(list.total / list.pageSize))}` : 'Loading...'}</ListPagination>}
    {sorting && <SortOverlay sort={filters.sort} order={filters.direction} options={driverSortOptions} defaultSort="created_at" defaultOrder="desc" onClose={() => setSorting(false)} onApply={(sort, direction) => { setFilters(current => ({ ...current, page: 1, sort: sort as DriverSort, direction })); setSorting(false); }} />}
    {filterDraft !== null && <Overlay title="Driver filters" description="Choose the drivers to show." className="list-options-dialog" onClose={() => setFilterDraft(null)} onSubmit={event => { event.preventDefault(); setFilters(current => ({ ...current, status: filterDraft, page: 1 })); setFilterDraft(null); }}
      footer={<><button className="patient-primary" type="submit">Apply Filters</button><button type="button" onClick={() => setFilterDraft('all')}>Reset</button><button type="button" onClick={() => setFilterDraft(null)}>Cancel</button></>}>
      <ChoiceGroup label="Registration" value={filterDraft} onChange={setFilterDraft} options={[{ value: 'all', label: 'All drivers' }, ...Object.entries(registrationLabels).map(([value, label]) => ({ value, label }))]} />
    </Overlay>}
    {selected && detailView === 'schedule' && <DriverAvailabilityDialog driverId={selected.id} name={selected.profile?.full_name ?? selected.display_name} onClose={close} onSessionExpired={onSessionExpired} />}
    {selected && detailView === 'driver' && <Overlay title="Driver Details" className={`patient-dialog${editing ? ' patient-editing' : ''}`} description={<span className="profile-id">Driver ID: {selected.id}</span>} busy={saving} onClose={close} onSubmit={editing ? saveStatus : undefined} error={reviewError} onDismissError={() => setReviewError('')}
      footer={editing ? <>
        <button className="patient-primary" type="submit" disabled={saving || conflict}>{saving ? 'Saving…' : 'Save Driver'}</button>
        <button type="button" disabled={saving} onClick={() => { setStatusDraft(selected.account_status); setEditing(false); setReviewError(''); setConflict(false); }}>Cancel</button>
      </> : <>
        <button ref={editButton} type="button" className="patient-primary" disabled={saving} onClick={() => { setStatusDraft(selected.account_status); setEditing(true); setReviewError(''); setConflict(false); }}>Edit Driver</button>
        <button type="button" disabled={saving} aria-label="Close Driver Details" onClick={close}>Close</button>
      </>}>
      {conflict && <button type="button" disabled={saving} onClick={() => void reloadSelected()}>Reload latest details</button>}
      <fieldset className="patient-form-fields" disabled={saving} aria-label="Driver details">
        <PersonalFields prefix="review-driver" draft={selected.profile ?? emptyPersonal} disabled onChange={() => {}} />
        <div className="patient-field patient-form-wide"><label htmlFor="driver-email">Email</label><input id="driver-email" type="email" value={selected.email} disabled readOnly /></div>
        <div className="patient-field"><label className="patient-required" htmlFor="driver-status">Status</label><select id="driver-status" required disabled={!editing} value={editing ? statusDraft : selected.account_status} onChange={event => setStatusDraft(event.target.value as 'active' | 'inactive')}><option value="active">Active</option><option value="inactive">Inactive</option></select></div>

      </fieldset>
    </Overlay>}
    {selected && detailView === 'car' && <Overlay title="Car Details" className="patient-dialog" description={<span className="profile-id">{selected.profile?.full_name ?? selected.display_name} · Driver ID: {selected.id}</span>} busy={saving} onClose={close} error={reviewError} onDismissError={() => setReviewError('')}
      footer={<>
        {canReview && <><button type="button" className="patient-primary" disabled={saving || conflict} onClick={() => void review('approved')}>{saving ? 'Saving…' : 'Approve'}</button><button type="button" disabled={saving || conflict} onClick={() => void review('rejected')}>Reject</button></>}
        <button type="button" disabled={saving} aria-label="Close Car Details" onClick={close}>Close</button>
      </>}>
      {conflict && <button type="button" disabled={saving} onClick={() => void reloadSelected()}>Reload latest details</button>}
      <fieldset className="patient-form-fields" disabled={saving} aria-label="Vehicle details">
        {selected.vehicle ? <>
          <div className="patient-field"><label htmlFor="driver-licence">Driving licence number</label><input id="driver-licence" value={selected.vehicle.licence_number} disabled readOnly /></div>
          <div className="patient-field"><label htmlFor="driver-registration-date">{selected.vehicle.status === 'approved' ? 'Registered on' : 'Submitted on'}</label><input id="driver-registration-date" value={selected.vehicle.status === 'approved' ? selected.vehicle.reviewed_at ? reviewDate(selected.vehicle.reviewed_at) : 'Unavailable' : reviewDate(selected.vehicle.submitted_at)} disabled readOnly /></div>
          <div className="patient-field patient-form-wide"><label htmlFor="driver-car-details">Car details</label><textarea id="driver-car-details" rows={4} disabled readOnly value={`Plate: ${selected.vehicle.plate_number}
Make/model: ${selected.vehicle.make} ${selected.vehicle.model}
Passenger capacity: ${selected.vehicle.passenger_capacity}
Wheelchair accessible: ${selected.vehicle.wheelchair_accessible ? 'Yes' : 'No'}`} /></div>
          {selected.vehicle.review_reason && <div className="patient-field patient-form-wide"><label htmlFor="driver-feedback">Coordinator feedback</label><textarea id="driver-feedback" rows={3} value={selected.vehicle.review_reason} disabled readOnly /></div>}
          {canReview && !editing && <div className="patient-field patient-form-wide"><label className="patient-required" htmlFor="driver-review-reason">Review notes (required when rejecting)</label><textarea id="driver-review-reason" maxLength={1000} rows={3} disabled={conflict} value={reason} onChange={event => setReason(event.target.value)} /></div>}
        </> : <div className="patient-field patient-form-wide"><label htmlFor="driver-car-details">Car details</label><textarea id="driver-car-details" rows={2} value="Not submitted" disabled readOnly /></div>}
      </fieldset>
    </Overlay>}
  </section>;
}
