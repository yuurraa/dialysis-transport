import { InfoButton, Overlay, PageHeading, ListToolbar, ListPagination, ChoiceGroup, SortOverlay, ListError, sortSummary } from '../components/DashboardUI';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { PersonalFields } from '../components/PersonalFields';
import { ApiError, apiGet, apiRequest } from '../lib/api';

export interface Patient {
  id: string;
  version: number;
  birth_date?: string | null;
  gender?: string | null;
  full_name: string;
  phone: string;
  pickup_address: string;
  unit_no: string;
  postal_code: string;
  notes: string;
  mobility: 'ambulant' | 'walking-aid' | 'wheelchair';
  assistance_required: boolean;
  status: 'active' | 'inactive';
}
type PatientInput = Omit<Patient, 'id' | 'version'> & { birth_date: string; gender: string };
interface PatientList { patients: Patient[]; total: number; page: number; pageSize: number }
export function patientDraft(patient?: Patient | null): PatientInput {
  return { birth_date: patient?.birth_date ?? '', gender: patient?.gender ?? '', full_name: patient?.full_name ?? '', phone: patient?.phone ?? '', pickup_address: patient?.pickup_address ?? '', unit_no: patient?.unit_no ?? '', postal_code: patient?.postal_code ?? '', notes: patient?.notes ?? '', mobility: patient?.mobility ?? 'ambulant', assistance_required: patient?.assistance_required ?? false, status: patient?.status ?? 'active' };
}
const patientColumns = [{ key: 'id', label: 'Patient ID' }, { key: 'full_name', label: 'Name' }, { key: 'phone', label: 'Contact' }, { key: 'mobility', label: 'Mobility' }, { key: 'status', label: 'Status' }] as const;
const patientSortOptions = [{ value: 'created_at', label: 'Created date', ascending: 'Oldest first', descending: 'Newest first' }, ...patientColumns.map(column => ({ value: column.key, label: column.label,
  ...(column.key === 'status' ? { ascending: 'Active first', descending: 'Inactive first' } : column.key === 'phone' ? { ascending: '0–9', descending: '9–0' } : {}) }))];
type PatientSort = typeof patientColumns[number]['key'] | 'created_at';
export const mobilityLabels = { ambulant: 'Ambulant', 'walking-aid': 'Walking aid', wheelchair: 'Wheelchair' };

/** UC-02: operational patient records; this form never creates or approves a login account. */
export default function PatientsPage({ notify, onSessionExpired }: { notify: (message: string) => void; onSessionExpired: () => void }) {
  const [filters, setFilters] = useState<{ page: number; search: string; sort: PatientSort; direction: 'asc' | 'desc'; status: string; mobility: string }>({ page: 1, search: '', sort: 'created_at', direction: 'desc', status: 'all', mobility: 'all' });
  const { page, search, sort, direction, status, mobility } = filters;
  const [filterDraft, setFilterDraft] = useState<{ status: string; mobility: string } | null>(null);
  const [sorting, setSorting] = useState(false);
  const [searchText, setSearchText] = useState('');
  useEffect(() => {
    const timer = window.setTimeout(() => setFilters(current => current.search === searchText.trim() ? current : { ...current, page: 1, search: searchText.trim() }), 300);
    return () => window.clearTimeout(timer);
  }, [searchText]);
  const [reload, setReload] = useState(0);
  const [list, setList] = useState<PatientList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<PatientInput | null>(null);
  const [editingId, setEditingId] = useState<string>();
  const [selectedPatient, setSelectedPatient] = useState<Patient | null>(null);
  const [editing, setEditing] = useState(false);
  const detailsEditButton = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  useEffect(() => {
    if (editing) document.getElementById('patient-status')?.focus();
    else if (wasEditing.current) detailsEditButton.current?.focus();
    wasEditing.current = editing;
  }, [editing]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [conflict, setConflict] = useState(false);
  const alive = useRef(false);
  const editButton = useRef<HTMLButtonElement | null>(null);
  const formWasOpen = useRef(false);
  const restoreFocus = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!draft && formWasOpen.current) restoreFocus.current = true;
    if (!draft && !loading && restoreFocus.current) {
      editButton.current?.focus();
      restoreFocus.current = false;
    }
    formWasOpen.current = Boolean(draft);
  }, [draft, loading, editingId]);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    const query = new URLSearchParams({ page: String(page), search, sort, direction, status, mobility });
    apiGet<PatientList>(`/profiles/patients?${query}`).then(result => {
      if (active) setList(result);
    }).catch(reason => {
      if (!active) return;
      if (reason instanceof ApiError && reason.status === 401) onSessionExpired();
      setError(reason instanceof ApiError && reason.status === 403 ? 'Coordinator access is required to view patients.' : 'Patients could not be loaded. Please try again.');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [page, search, sort, direction, status, mobility, reload, onSessionExpired]);

  function sortPatients(column: typeof patientColumns[number]['key']) {
    setFilters(current => current.sort === column && current.direction === 'desc'
      ? { ...current, page: 1, sort: 'created_at', direction: 'desc' }
      : { ...current, page: 1, sort: column, direction: current.sort === column ? 'desc' : 'asc' });
  }

  function open(patient: Patient) {
    setConflict(false);
    setEditingId(patient.id);
    setSelectedPatient(patient);
    setEditing(false);
    setSaveError('');
    setDraft(patientDraft(patient));
  }
  function close() { setConflict(false); setSelectedPatient(null); setDraft(null); setEditing(false); setSaveError(''); }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || !editingId || !editing || saving) return;
    setSaving(true);
    setSaveError('');
    try {
      const patient = await apiRequest<Patient>(`/profiles/patients/${editingId}`, 'PATCH', { status: draft.status, notes: draft.notes, version: selectedPatient?.version });
      if (!alive.current) return;
      notify('Patient details updated.');
      setSelectedPatient(patient);
      setDraft(patientDraft(patient));
      setEditing(false);
      setConflict(false);
      setReload(value => value + 1);
    } catch (reason) {
      if (!alive.current) return;
      if (reason instanceof ApiError && reason.status === 401) onSessionExpired();
      setConflict(reason instanceof ApiError && reason.status === 409);
      setSaveError(reason instanceof ApiError && reason.status === 400 ? 'Check the required patient details.'
        : reason instanceof ApiError && reason.status === 403 ? 'Coordinator access is required to save patients.'
        : reason instanceof ApiError && reason.status === 404 ? 'This patient record is no longer available. Cancel and reload the list.'
        : reason instanceof ApiError && reason.status === 409 ? 'This patient changed since you opened it. Your edits are still here. Reload the latest details before saving.'
        : 'Patient could not be saved. Please try again.');
    } finally { if (alive.current) setSaving(false); }
  }

  async function reloadSelected() {
    if (!editingId || saving) return;
    setSaving(true);
    try {
      const result = await apiGet<PatientList>(`/profiles/patients?search=${encodeURIComponent(editingId)}`);
      if (!alive.current) return;
      const patient = result.patients.find(item => item.id === editingId);
      if (!patient) { setSaveError('This patient record is no longer available.'); return; }
      setSelectedPatient(patient); setDraft(patientDraft(patient)); setConflict(false); setSaveError('');
      setReload(value => value + 1);
    } catch (reason) {
      if (!alive.current) return;
      if (reason instanceof ApiError && reason.status === 401) onSessionExpired();
      setSaveError('Latest patient details could not be loaded. Your edits are still here.');
    } finally { if (alive.current) setSaving(false); }
  }

  const updating = loading || searchText.trim() !== search;

  const patientIcon = <span className="dashboard-data-status-icon" aria-hidden="true"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><circle cx="12" cy="8" r="4" /><path d="M4 21v-2a8 8 0 0 1 16 0v2" /></svg></span>;

  return <section className="dashboard-trips patients-panel page-panel" aria-labelledby="patients-title" aria-busy={updating}>
    <PageHeading id="patients-title" eyebrow="Patient Management" title="Patient List" actions={<ListToolbar search={searchText} onSearch={setSearchText} label="Search patients" placeholder="Patient name, phone or ID"
      filterCount={Number(status !== 'all') + Number(mobility !== 'all')} onFilter={() => setFilterDraft({ status, mobility })} onSort={() => setSorting(true)} sortLabel={sortSummary(patientSortOptions, sort, direction)} />} />
    {loading && !list ? <div className="account-loading patients-loading" role="status" aria-label="Loading patients"><span className="account-spinner" aria-hidden="true" /><span>Loading...</span></div>
      : error ? <ListError title="Patients could not be loaded" message={error.includes('Coordinator') ? error : 'Please try again to load the patient records.'} onRetry={() => setReload(value => value + 1)} />
      : list && <>
        {list.total === 0 ? <div className="dashboard-data-status patients-status" role="status">{patientIcon}<div><h3>{search || status !== 'all' || mobility !== 'all' ? 'No matching patients.' : 'No patients yet.'}</h3><p>{search || status !== 'all' || mobility !== 'all' ? 'Try another search or change the filters.' : 'Patients appear here after completing account creation.'}</p></div></div> : <>
          <div className="patients-table-scroll" tabIndex={0} role="region" aria-label="Patient records"><table className="patients-table" role="table"><colgroup>{[5, 26, 20, 17, 14, 12, 6].map((width, index) => <col key={index} style={{ width: `${width}%` }} />)}</colgroup><thead role="rowgroup"><tr role="row"><th scope="col" role="columnheader" className="record-number-heading" aria-label="Row number">#</th>{patientColumns.map(column => <th key={column.key} role="columnheader" scope="col" aria-label={column.label} aria-sort={sort === column.key ? direction === 'asc' ? 'ascending' : 'descending' : 'none'}><button type="button" className="patient-sort-button" aria-label={sort === column.key && direction === 'desc' ? `Reset ${column.label} ordering` : `Sort by ${column.label} ${sort === column.key ? 'descending' : 'ascending'}`} onClick={() => sortPatients(column.key)}>{column.label}{sort === column.key && <span aria-hidden="true">{direction === 'asc' ? '▲' : '▼'}</span>}</button></th>)}<th scope="col" role="columnheader" aria-label="Details" /></tr></thead><tbody role="rowgroup">
            {list.patients.map((patient, index) => <tr key={patient.id} role="row"><td role="cell" className="record-number">{(list.page - 1) * list.pageSize + index + 1}</td><td role="cell" className="patient-record-id">{patient.id}</td><td role="cell" className="patient-record-name">{patient.full_name}</td><td role="cell" data-label="Contact">{patient.phone}</td><td role="cell" data-label="Mobility">{mobilityLabels[patient.mobility]}</td><td role="cell" data-label="Status">{patient.status === 'active' ? 'Active' : 'Inactive'}</td><td role="cell" className="patient-record-action"><InfoButton label={`View ${patient.full_name}`} disabled={updating} buttonRef={patient.id === editingId ? editButton : undefined} onClick={() => open(patient)} /></td></tr>)}
          </tbody></table></div>
        </>}
      </>}
    {!error && <ListPagination label="Patient pages" page={page} disabled={updating || !!error} hasNext={!!list && page * list.pageSize < list.total} onPageChange={page => setFilters(current => ({ ...current, page }))}>{list ? <>{list.total} {list.total === 1 ? 'patient' : 'patients'} · Page {list.page} of {Math.max(1, Math.ceil(list.total / list.pageSize))}</> : loading ? 'Loading...' : 'Patient count unavailable'}</ListPagination>}
    {sorting && <SortOverlay sort={sort} order={direction} options={patientSortOptions} defaultSort="created_at" defaultOrder="desc" onClose={() => setSorting(false)} onApply={(sort, direction) => { setFilters(current => ({ ...current, page: 1, sort: sort as PatientSort, direction })); setSorting(false); }} />}
    {filterDraft && <Overlay title="Patient filters" description="Choose the patients to show." className="list-options-dialog" onClose={() => setFilterDraft(null)} onSubmit={event => { event.preventDefault(); setFilters(current => ({ ...current, ...filterDraft, page: 1 })); setFilterDraft(null); }}
      footer={<><button className="patient-primary" type="submit">Apply Filters</button><button type="button" onClick={() => setFilterDraft({ status: 'all', mobility: 'all' })}>Reset</button><button type="button" onClick={() => setFilterDraft(null)}>Cancel</button></>}>
      <ChoiceGroup label="Status" multiple value={filterDraft.status} options={[ { value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }]} onChange={status => setFilterDraft(current => current && ({ ...current, status }))} />
      <ChoiceGroup label="Mobility" multiple value={filterDraft.mobility} options={Object.entries(mobilityLabels).map(([value, label]) => ({ value, label }))} onChange={mobility => setFilterDraft(current => current && ({ ...current, mobility }))} />
    </Overlay>}
    {draft && selectedPatient && <Overlay title="Patient Details" description={<span className="profile-id">Patient ID: {selectedPatient.id}</span>} className={`patient-dialog${editing ? ' patient-editing' : ''}`} busy={saving} onClose={close} onSubmit={editing ? save : undefined} error={saveError} onDismissError={() => setSaveError('')}
      footer={editing ? <><button className="patient-primary" type="submit" disabled={saving || conflict}>{saving ? 'Saving…' : 'Save Patient'}</button><button type="button" disabled={saving} onClick={() => { setDraft(patientDraft(selectedPatient)); setSaveError(''); setEditing(false); }}>Cancel</button></>
        : <><button ref={detailsEditButton} className="patient-primary" type="button" onClick={() => { setDraft(patientDraft(selectedPatient)); setSaveError(''); setEditing(true); }}>Edit Patient</button><button type="button" aria-label="Close Patient Details" onClick={close}>Close</button></>}>
      {conflict && <button type="button" disabled={saving} onClick={reloadSelected}>Reload latest details</button>}
      <PatientFields draft={draft} onChange={setDraft} disabled={saving || !editing} showStatus personalDetailsReadOnly={editing} />
    </Overlay>}
  </section>;
}

/** Shared transport fields keep coordinator and patient forms visually consistent. */
export function PatientFields({ draft, onChange, disabled = false, showStatus = false, personalDetailsReadOnly = false }: {
  draft: PatientInput; onChange: (value: PatientInput) => void; disabled?: boolean; showStatus?: boolean; personalDetailsReadOnly?: boolean;
}) {
  return (
      <fieldset className="patient-form-fields" disabled={disabled} aria-label="Patient details">
        <PersonalFields prefix="patient" draft={draft} disabled={personalDetailsReadOnly} onChange={personal => onChange({ ...draft, ...personal })} />
        <div className="patient-field patient-form-wide"><label className="patient-required" htmlFor="patient-address">Street</label><input id="patient-address" disabled={personalDetailsReadOnly} required maxLength={300} value={draft.pickup_address} onChange={event => onChange({ ...draft, pickup_address: event.target.value })} autoComplete="off" /></div>
        <div className="patient-field"><label htmlFor="patient-unit">Unit no.</label><input id="patient-unit" disabled={personalDetailsReadOnly} maxLength={20} placeholder="e.g. #05-12 (optional)" value={draft.unit_no} onChange={event => onChange({ ...draft, unit_no: event.target.value })} autoComplete="off" /></div>
        <div className="patient-field"><label className="patient-required" htmlFor="patient-postal">Postal code</label><input id="patient-postal" disabled={personalDetailsReadOnly} required inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="off" value={draft.postal_code} onChange={event => onChange({ ...draft, postal_code: event.target.value })} /></div>
        <div className="patient-field"><label className="patient-required" htmlFor="patient-mobility">Mobility</label><select id="patient-mobility" disabled={personalDetailsReadOnly} required value={draft.mobility} onChange={event => onChange({ ...draft, mobility: event.target.value as Patient['mobility'] })}>{Object.entries(mobilityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>

        <div className="patient-field"><label className="patient-required" htmlFor="patient-assistance">Assistance required</label><select id="patient-assistance" disabled={personalDetailsReadOnly} required value={draft.assistance_required ? 'yes' : 'no'} onChange={event => onChange({ ...draft, assistance_required: event.target.value === 'yes' })}><option value="no">No</option><option value="yes">Yes</option></select></div>
        {showStatus && <div className="patient-field"><label className="patient-required" htmlFor="patient-status">Status</label><select id="patient-status" required value={draft.status} onChange={event => onChange({ ...draft, status: event.target.value as Patient['status'] })}><option value="active">Active</option><option value="inactive">Inactive</option></select></div>}
        <div className="patient-field patient-form-wide"><label htmlFor="patient-notes">Notes</label><textarea id="patient-notes" rows={3} maxLength={1000} placeholder="Any additional information (optional)" value={draft.notes} onChange={event => onChange({ ...draft, notes: event.target.value })} /></div>
      </fieldset>
  );
}
