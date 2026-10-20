import { Overlay, PageHeading } from '../components/DashboardUI';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, apiGet, apiRequest } from '../lib/api';

export interface Patient {
  id: string;
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
type PatientInput = Omit<Patient, 'id'>;
interface PatientList { patients: Patient[]; total: number; page: number; pageSize: number }
export function patientDraft(patient?: Patient | null): PatientInput {
  return { full_name: patient?.full_name ?? '', phone: patient?.phone ?? '', pickup_address: patient?.pickup_address ?? '', unit_no: patient?.unit_no ?? '', postal_code: patient?.postal_code ?? '', notes: patient?.notes ?? '', mobility: patient?.mobility ?? 'ambulant', assistance_required: patient?.assistance_required ?? false, status: patient?.status ?? 'active' };
}
const patientColumns = [{ key: 'id', label: 'Patient ID' }, { key: 'full_name', label: 'Name' }, { key: 'phone', label: 'Contact' }, { key: 'mobility', label: 'Mobility' }, { key: 'status', label: 'Status' }] as const;
type PatientSort = typeof patientColumns[number]['key'] | 'created_at';
export const mobilityLabels = { ambulant: 'Ambulant', 'walking-aid': 'Walking aid', wheelchair: 'Wheelchair' };

/** UC-02: operational patient records; this form never creates or approves a login account. */
export default function PatientsPage({ notify, onSessionExpired }: { notify: (message: string) => void; onSessionExpired: () => void }) {
  const [filters, setFilters] = useState<{ page: number; search: string; sort: PatientSort; direction: 'asc' | 'desc' }>({ page: 1, search: '', sort: 'created_at', direction: 'desc' });
  const { page, search, sort, direction } = filters;
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
    const query = new URLSearchParams({ page: String(page), search, sort, direction });
    apiGet<PatientList>(`/profiles/patients?${query}`).then(result => {
      if (active) setList(result);
    }).catch(reason => {
      if (!active) return;
      if (reason instanceof ApiError && reason.status === 401) onSessionExpired();
      setError(reason instanceof ApiError && reason.status === 403 ? 'Coordinator access is required to view patients.' : 'Patients could not be loaded. Please try again.');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [page, search, sort, direction, reload, onSessionExpired]);

  function sortPatients(column: typeof patientColumns[number]['key']) {
    setFilters(current => current.sort === column && current.direction === 'desc'
      ? { ...current, page: 1, sort: 'created_at', direction: 'desc' }
      : { ...current, page: 1, sort: column, direction: current.sort === column ? 'desc' : 'asc' });
  }

  function open(patient: Patient) {
    setEditingId(patient.id);
    setSelectedPatient(patient);
    setEditing(false);
    setSaveError('');
    setDraft(patientDraft(patient));
  }
  function close() { setSelectedPatient(null); setDraft(null); setEditing(false); setSaveError(''); }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || !editingId || !editing || saving) return;
    setSaving(true);
    setSaveError('');
    try {
      const patient = await apiRequest<Patient>(`/profiles/patients/${editingId}`, 'PATCH', { status: draft.status, notes: draft.notes });
      if (!alive.current) return;
      notify('Patient details updated.');
      setSelectedPatient(patient);
      setDraft(patientDraft(patient));
      setEditing(false);
      setReload(value => value + 1);
    } catch (reason) {
      if (!alive.current) return;
      if (reason instanceof ApiError && reason.status === 401) onSessionExpired();
      setSaveError(reason instanceof ApiError && reason.status === 400 ? 'Check the required patient details.'
        : reason instanceof ApiError && reason.status === 403 ? 'Coordinator access is required to save patients.'
        : reason instanceof ApiError && reason.status === 404 ? 'This patient record is no longer available. Cancel and reload the list.'
        : 'Patient could not be saved. Please try again.');
    } finally { if (alive.current) setSaving(false); }
  }

  const updating = loading || searchText.trim() !== search;

  const patientIcon = <span className="dashboard-data-status-icon" aria-hidden="true"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><circle cx="12" cy="8" r="4" /><path d="M4 21v-2a8 8 0 0 1 16 0v2" /></svg></span>;

  return <section className="dashboard-trips patients-panel page-panel" aria-labelledby="patients-title" aria-busy={updating}>
    <PageHeading id="patients-title" eyebrow="Patient Management" title="Patients List" actions={<label className="patient-search"><svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></svg><input type="search" aria-label="Search patients" placeholder="Patient name, phone or ID" maxLength={100} value={searchText} onChange={event => setSearchText(event.target.value)} /></label>} />
    {loading && !list ? <div className="account-loading patients-loading" role="status" aria-label="Loading patients"><span className="account-spinner" aria-hidden="true" /><span>Loading...</span></div>
      : error ? <div className="dashboard-data-status patients-status">{patientIcon}<div><h3 role="alert">{error}</h3><p>Patient records are currently unavailable.</p></div><button type="button" onClick={() => setReload(value => value + 1)}>Try again</button></div>
      : list && <>
        {list.total === 0 ? <div className="dashboard-data-status patients-status" role="status">{patientIcon}<div><h3>{search ? 'No matching patients.' : 'No patients yet.'}</h3><p>{search ? 'Try another patient name, phone number or full patient ID.' : 'Patients appear here after completing account creation.'}</p></div></div> : <>
          <div className="patients-table-scroll" tabIndex={0} role="region" aria-label="Patient records"><table className="patients-table"><colgroup>{[26, 20, 17, 13, 12, 12].map((width, index) => <col key={index} style={{ width: `${width}%` }} />)}</colgroup><thead><tr>{patientColumns.map(column => <th key={column.key} scope="col" aria-label={column.label} aria-sort={sort === column.key ? direction === 'asc' ? 'ascending' : 'descending' : 'none'}><button type="button" className="patient-sort-button" aria-label={sort === column.key && direction === 'desc' ? `Reset ${column.label} ordering` : `Sort by ${column.label} ${sort === column.key ? 'descending' : 'ascending'}`} onClick={() => sortPatients(column.key)}>{column.label}{sort === column.key && <span aria-hidden="true">{direction === 'asc' ? '▲' : '▼'}</span>}</button></th>)}<th scope="col">Actions</th></tr></thead><tbody>
            {list.patients.map(patient => <tr key={patient.id}><td className="patient-record-id">{patient.id}</td><td>{patient.full_name}</td><td>{patient.phone}</td><td>{mobilityLabels[patient.mobility]}</td><td>{patient.status === 'active' ? 'Active' : 'Inactive'}</td><td><button type="button" aria-label={`View ${patient.full_name}`} disabled={updating} ref={patient.id === editingId ? editButton : undefined} onClick={() => open(patient)}>View</button></td></tr>)}
          </tbody></table></div>
        </>}
          <div className="patients-pagination"><span>{list.total} {list.total === 1 ? 'patient' : 'patients'} · Page {list.page}</span><div className="patient-actions"><button type="button" disabled={updating || page === 1} onClick={() => setFilters(current => ({ ...current, page: current.page - 1 }))}>Previous</button><button type="button" disabled={updating || page * list.pageSize >= list.total} onClick={() => setFilters(current => ({ ...current, page: current.page + 1 }))}>Next</button></div></div>
      </>}
    {draft && selectedPatient && <Overlay title="Patient Details" description={<span className="profile-id">Patient ID: {selectedPatient.id}</span>} className="patient-dialog" busy={saving} onClose={close} onSubmit={editing ? save : undefined} error={saveError} onDismissError={() => setSaveError('')}
      footer={editing ? <><button className="patient-primary" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save Patient'}</button><button type="button" disabled={saving} onClick={() => { setDraft(patientDraft(selectedPatient)); setSaveError(''); setEditing(false); }}>Cancel</button></>
        : <><button ref={detailsEditButton} className="patient-primary" type="button" onClick={() => { setDraft(patientDraft(selectedPatient)); setSaveError(''); setEditing(true); }}>Edit Patient</button><button type="button" onClick={close}>Close</button></>}>
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
        <div className="patient-field"><label className="patient-required" htmlFor="patient-full-name">Full name</label><input id="patient-full-name" disabled={personalDetailsReadOnly} required maxLength={100} value={draft.full_name} onChange={event => onChange({ ...draft, full_name: event.target.value })} autoComplete="off" /></div>
        <div className="patient-field"><label className="patient-required" htmlFor="patient-phone">Contact number</label><input id="patient-phone" disabled={personalDetailsReadOnly} type="tel" required maxLength={17} pattern={String.raw`(?:[0-9]{8}|\+65 [0-9]{8}|\+(?!65 )[1-9][0-9]{0,2} [0-9]{6,14})`} title="Enter 8 digits, or a country code and number, e.g. +65 81234567." placeholder="e.g. +65 81234567" value={draft.phone} onChange={event => onChange({ ...draft, phone: event.target.value })} autoComplete="tel" /></div>
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
