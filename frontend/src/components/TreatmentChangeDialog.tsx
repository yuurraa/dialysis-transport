import { useRef, useState, useEffect, type FormEvent } from 'react';
import { Dropdown } from './Dropdown';
import { Overlay } from './DashboardUI';
import { ApiError, apiGet, apiRequest } from '../lib/api';

export interface ChangeSource {
  id: string; patient_id: string; version: number; kind?: 'recurring' | 'single'; centre_id: string;
  days: number[]; start_time: string; end_time: string; effective_from: string; effective_to: string;
  replaces_schedule_id?: string | null; replaces_date?: string | null;
}
interface Proposal {
  kind: 'recurring' | 'single'; centre_id: string; days: number[]; start_time: string; end_time: string; effective_from: string; effective_to: string;
}
export interface TreatmentChangeRequest {
  id: string; schedule_id: string; root_schedule_id: string; version: number;
  action: 'update' | 'reschedule' | 'delete'; proposal: Proposal; original_date: string | null;
  before_snapshot: ChangeSource; reason: string; requested_at: string;
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn'; review_note: string; reviewed_at: string | null;
}
interface Centre { id: string; name: string }
const days = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const validDate = (value: string) => /^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0,10) === value;
const weekday = (value: string) => new Date(`${value}T00:00:00Z`).getUTCDay() || 7;
const dateLabel = (value: string) => validDate(value) ? new Intl.DateTimeFormat('en-SG', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${value}T00:00:00Z`)) : 'Unavailable';
const draftFor = (source: ChangeSource): Proposal => ({ kind: source.kind ?? 'recurring', centre_id: source.centre_id, days: [...source.days], start_time: source.start_time.slice(0,5), end_time: source.end_time.slice(0,5), effective_from: source.effective_from, effective_to: source.effective_to });
function Summary({ details, centres }: { details: Proposal | ChangeSource; centres: Centre[] }) {
  return <dl className="schedule-detail-fields">
    <div><dt>Schedule</dt><dd>{details.kind === 'single' ? 'Single Session' : `Every ${details.days.map(day => days[day - 1]).join(', ')}`}</dd></div>
    <div><dt>{details.kind === 'single' ? 'Session date' : 'Date range'}</dt><dd>{details.kind === 'single' ? dateLabel(details.effective_from) : `${dateLabel(details.effective_from)} – ${dateLabel(details.effective_to)}`}</dd></div>
    <div><dt>Treatment</dt><dd>{details.start_time.slice(0,5)} – {details.end_time.slice(0,5)}</dd></div>
    <div><dt>Dialysis centre</dt><dd>{centres.find(centre => centre.id === details.centre_id)?.name ?? 'Unavailable'}</dd></div>
  </dl>;
}

/** Patient proposals and coordinator decisions share the same versioned, read-before-write workflow. */
export default function TreatmentChangeDialog({ source, existing, coordinator, centres, name, onClose, onChanged, onSessionExpired }: {
  source: ChangeSource; existing?: TreatmentChangeRequest | null; coordinator: boolean; centres: Centre[]; name: string;
  onClose: () => void; onChanged: (request: TreatmentChangeRequest, message: string) => void; onSessionExpired: () => void;
}) {
  const [current, setCurrent] = useState(source);
  const [request, setRequest] = useState(existing ?? null);
  const [draft, setDraft] = useState(() => draftFor(source));
  const [action, setAction] = useState<'update' | 'reschedule' | 'delete'>('update');
  const [original, setOriginal] = useState('');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const alive = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const pending = request?.status === 'pending';
  const editing = !coordinator && !pending;
  function changeAction(value: string) {
    const operation = value as typeof action;
    setAction(operation); setError('');
    setDraft(draftFor(current)); setOriginal('');
    if (operation === 'reschedule') {
      setDraft({ ...draftFor(current), kind: 'single', days: [], effective_from: '', effective_to: '' });
    }
  }
  function failure(value: unknown) {
    if (value instanceof ApiError && value.status === 401) onSessionExpired();
    if (value instanceof ApiError && [404,409].includes(value.status)) {
      setConflict(true); setError('This schedule or request changed. Reload before trying again.');
    } else if (value instanceof ApiError && value.status === 400) {
      setError(coordinator ? 'These changes conflict with another session or cannot be applied. Reject the request or ask for corrected details.' : 'Check the treatment details and original session date.');
    } else setError('The request could not be saved. Please try again.');
  }
  async function reload() {
    if (busy) return;
    setBusy(true);
    try {
      const result = await apiGet<{ schedule: ChangeSource; request: TreatmentChangeRequest | null }>(`/schedules/${source.id}/change-request`);
      if (!alive.current) return;
      setCurrent(result.schedule); setRequest(result.request); setDraft(draftFor(result.schedule)); setAction('update'); setOriginal(''); setNote(''); setConflict(false); setError('');
    } catch (value) { if (alive.current) failure(value); }
    finally { if (alive.current) setBusy(false); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || conflict || !editing) return;
    if (!reason.trim()) { setError('Give a reason for this change.'); return; }
    if (action !== 'delete' && (!draft.centre_id || !validDate(draft.effective_from) || !validDate(draft.effective_to) || draft.effective_to < draft.effective_from || draft.days.length !== 1 || !draft.start_time || !draft.end_time || draft.end_time <= draft.start_time)) { setError('Check the centre, dates and treatment times.'); return; }
    if (action === 'reschedule' && (!validDate(original) || original < today() || original < current.effective_from || original > current.effective_to || weekday(original) !== current.days[0])) { setError('Choose an upcoming occurrence on the schedule’s treatment day.'); return; }
    const details = draft.kind === 'single' ? { kind: 'single', centre_id: draft.centre_id, session_date: draft.effective_from, start_time: draft.start_time, end_time: draft.end_time } : draft;
    setBusy(true); setError('');
    try {
      const saved = await apiRequest<TreatmentChangeRequest>(`/schedules/${current.id}/change-requests`, 'POST', { action, version: current.version, reason: reason.trim(), ...(action !== 'delete' ? { details } : {}), ...(action === 'reschedule' ? { original_date: original } : {}) });
      if (alive.current) onChanged(saved, 'Change request submitted. Your current schedule stays in effect until approved.');
    } catch (value) { if (alive.current) failure(value); }
    finally { if (alive.current) setBusy(false); }
  }
  async function decide(decision: 'approved' | 'rejected' | 'withdrawn') {
    if (!request || busy || conflict) return;
    if (decision === 'rejected' && !note.trim()) { setError('Give a reason for rejecting this request.'); return; }
    setBusy(true); setError('');
    try {
      const saved = await apiRequest<TreatmentChangeRequest>(`/schedules/change-requests/${request.id}/${decision === 'withdrawn' ? 'withdraw' : 'review'}`, 'PATCH', { version: request.version, ...(decision !== 'withdrawn' ? { decision, note: note.trim() } : {}) });
      if (alive.current) onChanged(saved, decision === 'approved' ? 'Change approved. The schedule and affected future trips have been updated.' : decision === 'rejected' ? 'Change request rejected. The schedule is unchanged.' : 'Change request withdrawn.');
    } catch (value) { if (alive.current) failure(value); }
    finally { if (alive.current) setBusy(false); }
  }
  return <Overlay title={editing ? 'Request schedule change' : coordinator ? 'Review schedule change' : 'Schedule change request'} description={name} className="treatment-change-dialog" busy={busy} onClose={onClose} onSubmit={editing ? submit : undefined} noValidate error={error} onDismissError={() => setError('')}
    footer={<>{conflict ? <button className="patient-primary" type="button" disabled={busy} onClick={() => void reload()}>Reload request</button>
      : editing ? <button className="patient-primary" type="submit" disabled={busy}>{busy ? 'Submitting…' : 'Submit request'}</button>
      : pending && coordinator ? <><button className={request.action === 'delete' ? 'button-danger' : 'patient-primary'} type="button" disabled={busy} onClick={() => void decide('approved')}>{busy ? 'Saving…' : 'Approve'}</button><button className="button-danger" type="button" disabled={busy} onClick={() => void decide('rejected')}>Reject</button></>
      : pending ? <button type="button" disabled={busy} onClick={() => void decide('withdrawn')}>Withdraw request</button> : null}<button type="button" disabled={busy} onClick={onClose}>Close</button></>}>
    {editing ? <>
      {request?.status === 'rejected' && <p className="treatment-change-outcome">Previous request rejected: {request.review_note}</p>}
      <p className="treatment-hint">Your saved schedule stays in effect until a coordinator approves this request.</p>
      <fieldset className="patient-form-fields" disabled={busy}>
        <div className="patient-field patient-form-wide"><label className="patient-required" htmlFor="schedule-change-action">Requested change</label><Dropdown id="schedule-change-action" required label="Requested change" value={action} onChange={changeAction} options={[{ value: 'update', label: 'Edit schedule' }, ...(current.kind !== 'single' && !current.replaces_schedule_id ? [{ value: 'reschedule', label: 'Reschedule one session' }] : []), { value: 'delete', label: 'Delete schedule' }]} /></div>
        {action === 'delete' ? <p className="patient-form-wide treatment-hint">Approval will remove this schedule{current.replaces_schedule_id ? '' : ' and its linked replacements'}. Past trip history will be preserved.</p> : <>
          {action === 'reschedule' && <div className="patient-field patient-form-wide"><label className="patient-required" htmlFor="schedule-change-original">Original session date</label><input id="schedule-change-original" required type="date" min={current.effective_from > today() ? current.effective_from : today()} max={current.effective_to} value={original} onChange={event => { const date = event.target.value; setOriginal(date); if (!draft.effective_from || draft.effective_from === original) setDraft(value => ({ ...value, effective_from: date, effective_to: date, days: date ? [weekday(date)] : [] })); }} /><p className="treatment-hint">Choose a scheduled {days[current.days[0] - 1]}.</p></div>}
          <div className="patient-field patient-form-wide"><label className="patient-required" htmlFor="schedule-change-centre">Dialysis centre</label><Dropdown id="schedule-change-centre" required label="Dialysis centre" searchable value={draft.centre_id} onChange={centre_id => setDraft(value => ({ ...value, centre_id }))} options={centres.map(centre => ({ value: centre.id, label: centre.name }))} /></div>
          {draft.kind === 'single' ? <div className="patient-field patient-form-wide"><label className="patient-required" htmlFor="schedule-change-date">{action === 'reschedule' ? 'New session date' : 'Session date'}</label><input id="schedule-change-date" required type="date" min={today()} value={draft.effective_from} onChange={event => { const date = event.target.value; setDraft(value => ({ ...value, effective_from: date, effective_to: date, days: date ? [weekday(date)] : [] })); }} /></div>
            : <><div className="patient-field patient-form-wide"><label className="patient-required" htmlFor="schedule-change-day">Treatment day</label><Dropdown id="schedule-change-day" required label="Treatment day" value={String(draft.days[0])} onChange={value => setDraft(current => ({ ...current, days: [Number(value)] }))} options={days.map((label,index) => ({ value: String(index + 1), label }))} /></div><div className="patient-field"><label className="patient-required" htmlFor="schedule-change-from">Effective from</label><input id="schedule-change-from" required type="date" value={draft.effective_from} onChange={event => setDraft(value => ({ ...value, effective_from: event.target.value }))} /></div><div className="patient-field"><label className="patient-required" htmlFor="schedule-change-until">Effective to</label><input id="schedule-change-until" required type="date" min={draft.effective_from} value={draft.effective_to} onChange={event => setDraft(value => ({ ...value, effective_to: event.target.value }))} /></div></>}
          <div className="patient-field"><label className="patient-required" htmlFor="schedule-change-start">Session start</label><input id="schedule-change-start" required type="time" value={draft.start_time} onChange={event => setDraft(value => ({ ...value, start_time: event.target.value }))} /></div><div className="patient-field"><label className="patient-required" htmlFor="schedule-change-end">Session end</label><input id="schedule-change-end" required type="time" value={draft.end_time} onChange={event => setDraft(value => ({ ...value, end_time: event.target.value }))} /></div>
        </>}
        <div className="patient-field patient-form-wide"><label className="patient-required" htmlFor="schedule-change-reason">Reason for change</label><textarea id="schedule-change-reason" required rows={3} maxLength={1000} value={reason} onChange={event => setReason(event.target.value)} /></div>
      </fieldset>
    </> : request ? <>
      <p className="treatment-change-outcome">{pending ? 'Awaiting coordinator approval. The saved schedule has not changed.' : `Request ${request.status}.`}</p>
      {request.original_date && <p className="treatment-hint">Original session: {dateLabel(request.original_date)}</p>}
      <div className="treatment-change-comparison"><section><h3>Current schedule</h3><Summary details={request.before_snapshot} centres={centres} /></section><section><h3>Requested change</h3>{request.action === 'delete' ? <p>Delete this schedule{request.before_snapshot.replaces_schedule_id ? '.' : ' and its linked replacements.'}</p> : <Summary details={request.proposal} centres={centres} />}</section></div>
      <dl className="schedule-detail-fields"><div><dt>Reason for change</dt><dd>{request.reason}</dd></div>{request.review_note && <div><dt>Coordinator’s response</dt><dd>{request.review_note}</dd></div>}</dl>
      {coordinator && pending && <><p className="treatment-hint">Approval updates affected future unfilled trips. Past trip history stays unchanged.</p><fieldset className="patient-form-fields" disabled={busy}><div className="patient-field patient-form-wide"><label className="patient-required" htmlFor="schedule-change-review">Review note (required to reject)</label><textarea id="schedule-change-review" rows={3} maxLength={1000} value={note} onChange={event => setNote(event.target.value)} /></div></fieldset></>}
    </> : <p>No change request is awaiting review.</p>}
  </Overlay>;
}
