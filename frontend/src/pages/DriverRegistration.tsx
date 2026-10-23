import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, apiGet, apiRequest } from '../lib/api';
import { ListError, PageHeading, Overlay } from '../components/DashboardUI';

export interface VehicleDetails {
  licence_number: string; plate_number: string; make: string; model: string;
  passenger_capacity: number; wheelchair_accessible: boolean;
}
export interface DriverVehicle extends VehicleDetails {
  id: string; driver_id: string; status: 'pending' | 'approved' | 'rejected'; version: number;
  registered_at?: string | null; review_reason: string; submitted_at: string; reviewed_at: string | null;
}
export const registrationLabels: Record<string, string> = { 'not-submitted': 'Not submitted', pending: 'Pending review', approved: 'Approved', rejected: 'Rejected' };
const emptyVehicle: VehicleDetails = { licence_number: '', plate_number: '', make: '', model: '', passenger_capacity: 3, wheelchair_accessible: false };

export function VehicleFields({ draft, onChange, disabled = false, status, feedback }: { draft: VehicleDetails; onChange: (value: VehicleDetails) => void; disabled?: boolean; status?: string; feedback?: string }) {
  return <fieldset className="patient-form-fields" disabled={disabled} aria-label="Vehicle registration details">
    {([['licence_number', 'Driving licence number', 50], ['plate_number', 'Vehicle plate number', 20], ['make', 'Vehicle make', 60], ['model', 'Vehicle model', 60]] as const).map(([key, label, max]) => <div className="patient-field" key={key}><label className="patient-required" htmlFor={`vehicle-${key}`}>{label}</label><input id={`vehicle-${key}`} required maxLength={max} value={draft[key]} onChange={event => onChange({ ...draft, [key]: event.target.value })} /></div>)}
    <div className="patient-field"><label className="patient-required" htmlFor="vehicle-capacity">Passenger capacity (excluding driver)</label><input id="vehicle-capacity" type="number" required min={1} max={12} step={1} value={Number.isNaN(draft.passenger_capacity) ? '' : draft.passenger_capacity} onChange={event => onChange({ ...draft, passenger_capacity: event.target.valueAsNumber })} /></div>
    <div className="patient-field"><label className="patient-required" htmlFor="vehicle-wheelchair">Wheelchair accessible</label><select id="vehicle-wheelchair" value={draft.wheelchair_accessible ? 'yes' : 'no'} onChange={event => onChange({ ...draft, wheelchair_accessible: event.target.value === 'yes' })}><option value="no">No</option><option value="yes">Yes</option></select></div>
    {status && <div className="patient-field"><label htmlFor="vehicle-status">Registration status</label><input id="vehicle-status" value={status} disabled readOnly /></div>}
    {feedback && <div className="patient-field patient-form-wide"><label htmlFor="vehicle-feedback">Coordinator feedback</label><textarea id="vehicle-feedback" rows={3} value={feedback} disabled readOnly /></div>}
  </fieldset>;
}

export function driverError(reason: unknown) {
  if (reason instanceof ApiError) {
    if (reason.status === 409) return reason.code === 'vehicle_plate_conflict' ? 'This vehicle plate is already registered. Check the plate number.' : 'Registration changed. Reload before trying again.';
    if (reason.status === 400) return 'Check your details and the current registration status.';
    if (reason.status === 403) return 'Your account cannot perform this action. Contact your transport coordinator.';
  }
  return 'Driver registration is unavailable. Please try again.';
}

export default function DriverRegistration({ notify, onSessionExpired, registered = false, onVehicleChange }: { notify: (message: string) => void; onSessionExpired: () => void; registered?: boolean; onVehicleChange?: (vehicle: DriverVehicle | null) => void }) {
  const [vehicle, setVehicle] = useState<DriverVehicle | null>(null);
  const [draft, setDraft] = useState<VehicleDetails>(emptyVehicle);
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reload, setReload] = useState(0);
  const alive = useRef(false);
  const form = useRef<HTMLFormElement>(null);
  const registeredOn = vehicle?.status === 'approved' ? vehicle.registered_at ?? vehicle.reviewed_at : null;
  useEffect(() => { if (editing) form.current?.querySelector<HTMLInputElement>('input:not(:disabled)')?.focus({ preventScroll: true }); }, [editing, loading]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    apiGet<{ vehicle: DriverVehicle | null }>('/drivers/me').then(result => {
      if (!active) return;
      onVehicleChange?.(result.vehicle); setVehicle(result.vehicle); setDraft(result.vehicle ?? emptyVehicle); setEditing(!result.vehicle); setConflict(false); setSaveError('');
    }).catch(reason => { if (active) { if (reason instanceof ApiError && reason.status === 401) onSessionExpired(); setError(driverError(reason)); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [reload, onSessionExpired, onVehicleChange]);
  function requestSubmission(event: FormEvent) {
    event.preventDefault();
    if (saving || !editing || conflict) return;
    setSaveError(''); setConfirming(true);
  }
  async function submit() {
    if (!confirming || saving || !editing || conflict) return;
    setSaving(true); setSaveError('');
    try {
      const { licence_number, plate_number, make, model, passenger_capacity, wheelchair_accessible } = draft;
      const saved = await apiRequest<DriverVehicle>('/drivers/me/vehicle', 'POST', { licence_number, plate_number, make, model, passenger_capacity, wheelchair_accessible, version: vehicle?.version ?? null });
      if (!alive.current) return;
      onVehicleChange?.(saved); setVehicle(saved); setDraft(saved); setEditing(false); notify('Vehicle submitted for review.');
    } catch (reason) {
      if (!alive.current) return;
      if (reason instanceof ApiError && reason.status === 401) onSessionExpired();
      setConflict(reason instanceof ApiError && reason.status === 409 && reason.code !== 'vehicle_plate_conflict'); setSaveError(driverError(reason));
    } finally { if (alive.current) { setSaving(false); setConfirming(false); } }
  }
  return <section className="dashboard-trips patients-panel page-panel" aria-labelledby="driver-registration-title">
    <PageHeading id="driver-registration-title" title={registered ? "My Vehicle" : "Register Vehicle"} eyebrow="Vehicle Management" />
    {loading ? <div className="account-loading patients-loading" role="status"><span className="account-spinner" aria-hidden="true" /><span>Loading...</span></div>
      : error ? <ListError title="Registration could not be loaded" message={error} onRetry={() => setReload(value => value + 1)} />
      : <form ref={form} className={`patient-profile-form${editing ? ' patient-editing' : ''}`} aria-label="Vehicle registration" onSubmit={requestSubmission} aria-busy={saving}>
        <div className="patient-readonly-fields panel-scroll" tabIndex={0} role="region" aria-label="Your vehicle details">
          {vehicle && <fieldset className="patient-form-fields vehicle-registration-dates" disabled aria-label="Registration dates">
            <div className="patient-field"><label htmlFor="vehicle-submitted-date">Submitted on</label><input id="vehicle-submitted-date" readOnly value={new Intl.DateTimeFormat('en-SG', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Singapore' }).format(new Date(vehicle.submitted_at))} /></div>
            <div className="patient-field"><label htmlFor="vehicle-registered-date">Registered on</label><input id="vehicle-registered-date" readOnly value={registeredOn ? new Intl.DateTimeFormat('en-SG', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Singapore' }).format(new Date(registeredOn)) : '—'} /></div>
          </fieldset>}
          <VehicleFields draft={draft} onChange={setDraft} disabled={!editing || saving} status={registrationLabels[vehicle?.status ?? 'not-submitted']} feedback={vehicle?.review_reason} />
        </div>
        <div className="patient-profile-actions">
          {saveError && <div className="profile-save-error" role="alert"><p>{saveError}</p><button type="button" onClick={() => setSaveError('')}>Dismiss</button></div>}
          <div className="patient-actions">
          {editing ? <><button type="submit" className="patient-primary" disabled={saving || conflict}>{saving ? 'Submitting…' : 'Submit for review'}</button>{vehicle && <button type="button" disabled={saving} onClick={() => { setDraft(vehicle); setEditing(false); setSaveError(''); setConflict(false); }}>Cancel</button>}</>
            : <button type="button" className="patient-primary" onClick={() => { setEditing(true); setSaveError(''); }}>Edit registration</button>}
          {conflict && <button type="button" disabled={saving} onClick={() => setReload(value => value + 1)}>Reload latest registration</button>}
          </div>
        </div>
      </form>}
    {confirming && <Overlay title="Confirm registration" className="list-options-dialog" busy={saving} onClose={() => setConfirming(false)} onSubmit={event => { event.preventDefault(); void submit(); }}
      footer={<><button type="submit" className="patient-primary" disabled={saving}>{saving ? 'Submitting…' : 'Confirm submission'}</button><button type="button" disabled={saving} onClick={() => setConfirming(false)}>Cancel</button></>}>
      <p>This submission will replace any previous vehicle registration and send these details for coordinator review.</p>
    </Overlay>}
  </section>;
}
