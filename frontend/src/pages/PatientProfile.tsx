import { Overlay, PageHeading } from '../components/DashboardUI';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, apiGet, apiRequest } from '../lib/api';
import { PatientFields, patientDraft, type Patient } from './PatientsPage';

type Details = Omit<Patient, 'id' | 'version'>;


/** Ownership is derived on the server; the browser cannot select another patient's record. */
export default function PatientProfile({ notify, onSessionExpired, onProfileResolved }: {
  notify: (message: string) => void; onSessionExpired: () => void; onProfileResolved: (complete: boolean, fullName?: string) => void;
}) {
  const [profile, setProfile] = useState<Patient | null>(null);
  const [draft, setDraft] = useState<Details | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const alive = useRef(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  useEffect(() => {
    if (wasEditing.current && !editing) editButton.current?.focus();
    wasEditing.current = editing;
  }, [editing]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    apiGet<{ patient: Patient | null }>('/profiles/patient').then(({ patient }) => {
      if (!active) return;
      setProfile(patient);
      onProfileResolved(Boolean(patient), patient?.full_name);
      setDraft(patientDraft(patient));
    }).catch(reason => {
      if (!active) return;
      if (reason instanceof ApiError && reason.status === 401) onSessionExpired();
      setError(reason instanceof ApiError && reason.status === 403 ? 'Your profile is unavailable. Contact your transport coordinator.' : 'Your profile could not be loaded. Please try again.');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [attempt, onSessionExpired, onProfileResolved]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || !editing || saving || profile?.status !== 'active') return;
    setSaving(true); setSaveError('');
    const { status: unused, ...details } = draft;
    try {
      const patient = await apiRequest<Patient>('/profiles/patient', 'PATCH', { ...details, version: profile.version });
      if (!alive.current) return;
      setProfile(patient);
      onProfileResolved(true, patient.full_name);
      notify('Profile saved.');
      setDraft(patientDraft(patient));
      setEditing(false); setConflict(false);
    } catch (reason) {
      if (!alive.current) return;
      if (reason instanceof ApiError && reason.status === 401) onSessionExpired();
      setConflict(reason instanceof ApiError && reason.status === 409);
      setSaveError(reason instanceof ApiError && reason.status === 400 ? 'Check the required profile details.'
        : reason instanceof ApiError && reason.status === 403 ? 'Your profile cannot be updated. Contact your transport coordinator.'
        : reason instanceof ApiError && reason.status === 409 ? 'Your profile changed since you opened it. Your edits are still here. Reload the latest details before saving.'
        : 'Your profile could not be saved. Please try again.');
    } finally { if (alive.current) setSaving(false); }
  }
  const form = !loading && !error && draft && profile;
  return <><section className="dashboard-trips patients-panel page-panel" aria-labelledby="patient-profile-title">
    <PageHeading id="patient-profile-title" title="Account Details" description={profile ? <span className="profile-id">Patient ID: {profile.id}</span> : undefined} />
    {loading ? <div className="account-loading patients-loading" role="status" aria-label="Loading profile"><span className="account-spinner" aria-hidden="true" /><span>Loading...</span></div>
      : error ? <div className="dashboard-data-status patients-status"><div><h3 role="alert">{error}</h3></div><button type="button" onClick={() => setAttempt(value => value + 1)}>Try again</button></div>
      : form ? <>
          <div className="patient-readonly-fields panel-scroll" tabIndex={0} role="region" aria-label="Your patient details">{!editing && <PatientFields draft={draft} onChange={setDraft} disabled />}</div>
          {profile.status === 'inactive' ? <p role="status" className="patient-error">Your patient profile is inactive. Contact your transport coordinator.</p>
            : <div className="patient-actions"><button ref={editButton} className="patient-primary" type="button" onClick={() => { setConflict(false); setDraft(patientDraft(profile)); setSaveError(''); setEditing(true); }}>Edit profile</button></div>}
      </> : null}
  </section>
  {editing && draft && profile && <Overlay title="Edit profile" description="Update your contact and transport details." busy={saving}
    onClose={() => { setConflict(false); setDraft(patientDraft(profile)); setSaveError(''); setEditing(false); }} onSubmit={save} error={saveError} onDismissError={() => setSaveError('')}
    footer={<><button className="patient-primary" type="submit" disabled={saving || conflict}>{saving ? 'Saving…' : 'Save profile'}</button><button type="button" disabled={saving} onClick={() => { setConflict(false); setDraft(patientDraft(profile)); setSaveError(''); setEditing(false); }}>Cancel</button></>}>
    {conflict && <button type="button" disabled={saving} onClick={() => { setEditing(false); setConflict(false); setSaveError(''); setAttempt(value => value + 1); }}>Reload latest details</button>}
    <PatientFields draft={draft} onChange={setDraft} disabled={saving} />
  </Overlay>}
  </>;
}
