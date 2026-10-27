import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, apiGet, apiRequest } from '../lib/api';
import { ListError, PageHeading } from '../components/DashboardUI';
import { emptyPersonal, PersonalFields, type PersonalDetails } from '../components/PersonalFields';
import { Toast, ToastRegion } from '../components/Toast';

type Driver = PersonalDetails & { version: number };
/** Personal account edits are independent of vehicle registration and approval. */
export default function DriverProfile({ notify, onSessionExpired,role='driver',accountId }: { notify: (message: string) => void; onSessionExpired: () => void;role?:'driver'|'caregiver';accountId?:string }) {
  const label=role==='caregiver'?'Caregiver':'Driver';
  const [driver, setDriver] = useState<Driver | null>(null);
  const [draft, setDraft] = useState<PersonalDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const alive = useRef(false);
  const form = useRef<HTMLFormElement>(null);
  const edit = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (editing) form.current?.querySelector<HTMLInputElement>('input:not(:disabled)')?.focus({ preventScroll: true });
    else if (wasEditing.current) edit.current?.focus();
    wasEditing.current = editing;
  }, [editing]);
  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    apiGet<{ driver?: Driver | null;caregiver?:Driver|null }>(`/profiles/${role}`).then(result => {
      if (!active) return;
      const profile=result[role]??null;
      setDriver(profile); setDraft(profile??(role==='caregiver'?{...emptyPersonal}:null)); setEditing(!profile&&role==='caregiver'); setConflict(false); setSaveError('');
    }).catch(reason => {
      if (!active) return;
      if (reason instanceof ApiError && reason.status === 401) onSessionExpired();
      setError(`Your ${role} profile could not be loaded. Please try again.`);
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [attempt, onSessionExpired,role]);
  function cancel() {
    if (saving) return;
    setDraft(driver); setEditing(false); setSaveError(''); setConflict(false);
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if ((!driver&&role==='driver') || !draft || !editing || saving || conflict) return;
    setSaving(true); setSaveError('');
    try {
      const { full_name, phone, birth_date, gender } = draft;
      const result = await apiRequest<Driver>(`/profiles/${role}`, 'PATCH', { full_name, phone, birth_date, gender,...(driver?{version:driver.version}:{}) });
      if (!alive.current) return;
      setDriver(result); setDraft(result); setEditing(false); notify('Profile saved.');
    } catch (reason) {
      if (!alive.current) return;
      if (reason instanceof ApiError && reason.status === 401) onSessionExpired();
      const stale = reason instanceof ApiError && reason.status === 409;
      setConflict(stale);
      setSaveError(stale ? 'Your profile changed. Your edits are still here. Reload the latest details before saving.'
        : reason instanceof ApiError && reason.status === 400 ? 'Check your name, contact number, date of birth and gender.'
        : reason instanceof ApiError && reason.status === 403 ? 'Your profile cannot be updated. Contact your transport coordinator.'
        : 'Your profile could not be saved. Please try again.');
    } finally { if (alive.current) setSaving(false); }
  }
  return <section className="dashboard-trips patients-panel page-panel" aria-labelledby="driver-profile-title">
    <PageHeading id="driver-profile-title" title="Account Details" eyebrow="Account Management" description={role==='caregiver'&&accountId?<span className="profile-id">Caregiver ID: {accountId}</span>:undefined}/>
    {loading ? <div className="account-loading patients-loading" role="status"><span className="account-spinner" aria-hidden="true" /><span>Loading...</span></div>
      : error ? <ListError title={`${label} details could not be loaded`} message={error} onRetry={() => setAttempt(value => value + 1)} />
      : draft&&(driver||role==='caregiver') ? <form ref={form} className={`patient-profile-form${editing ? ' patient-editing' : ''}`} aria-label={`${label} profile`} aria-busy={saving} onSubmit={save} onKeyDown={event => { if (event.key === 'Escape' && editing && !saving) { event.preventDefault(); cancel(); } }}>
          <div className="patient-readonly-fields panel-scroll" role="region" aria-label={`Your ${role} details`} tabIndex={0}><fieldset className="patient-form-fields" disabled={!editing || saving} aria-label={`${label} personal information`}><PersonalFields prefix={`${role}-profile`} draft={draft} onChange={setDraft} /></fieldset></div>
          <div className="patient-profile-actions"><div className="patient-actions">
            {editing ? <><button key="save-profile" className="patient-primary" type="submit" disabled={saving || conflict}>{saving ? 'Saving…' : 'Save profile'}</button><button type="button" disabled={saving} onClick={cancel}>Cancel</button></> : <button key="edit-profile" ref={edit} className="patient-primary" type="button" onClick={() => setEditing(true)}>Edit profile</button>}
            {conflict && <button type="button" disabled={saving} onClick={() => setAttempt(value => value + 1)}>Reload latest details</button>}
          </div></div>
        </form>
      : <p role="status">Your {role} details are unavailable. Sign in again to finish creating your account.</p>}
    {saveError && <ToastRegion><Toast key={saveError} message={saveError} urgent onDismiss={() => setSaveError('')} /></ToastRegion>}
  </section>;
}
