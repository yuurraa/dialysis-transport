import { useEffect, useRef, useState } from 'react';
import { ListError, Overlay, PageHeading } from '../components/DashboardUI';
import { Toast, ToastRegion } from '../components/Toast';
import { ApiError, apiGet, apiRequest } from '../lib/api';

import WeeklyAvailabilityView, { availabilityDays as days, availabilityTime as time, availabilityDayRanges as dayRanges, useAvailabilityClock, type TimeRange } from '../components/WeeklyAvailabilityView';

interface Availability { weekly_slots: number[]; version: number }
const empty: Availability = { weekly_slots: [], version: 0 };
function message(reason: unknown) {
  if (reason instanceof ApiError) {
    if (reason.status === 409) return 'Availability changed in another session. Reload the latest availability before saving.';
    if (reason.status === 403) return 'Vehicle approval is required to manage availability.';
    if (reason.status === 400) return 'Check the selected weekly slots.';
  }
  return 'Availability could not be saved or loaded. Please try again.';
}

/** Weekly slots use Singapore time, with midnight ending the selected day. */
export default function DriverAvailability({ notify, onSessionExpired, onViewVehicle, vehicleRegistered }: { notify: (text: string) => void; onSessionExpired: () => void; onViewVehicle: () => void; vehicleRegistered: boolean }) {
  const clock = useAvailabilityClock();
  const [saved, setSaved] = useState<Availability>(empty);
  const [draft, setDraft] = useState<Availability>(empty);
  const [eligible, setEligible] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [reload, setReload] = useState(0);
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 760px)').matches);
  const [choosingDay, setChoosingDay] = useState(false);
  const [chosenDay, setChosenDay] = useState(() => clock.day);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 760px)');
    const update = () => setMobile(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  const [rangeEditor, setRangeEditor] = useState<{ day: number; ranges: (TimeRange & { id: number })[] } | null>(null);
  const [rangeError, setRangeError] = useState('');
  const rangeId = useRef(0);
  const alive = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    let active = true;
    setLoading(true); setLoadError('');
    apiGet<{ eligible: boolean; availability: Availability | null }>('/drivers/me/availability').then(result => {
      if (!active) return;
      setEligible(result.eligible); setSaved(result.availability ?? empty); setDraft(result.availability ?? empty);
      setEditing(false); setConflict(false); setError('');
    }).catch(reason => {
      if (!active) return;
      if (reason instanceof ApiError && reason.status === 401) onSessionExpired();
      setLoadError(message(reason));
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [reload, onSessionExpired]);
  const selected = new Set(draft.weekly_slots);
  const editable = editing && !saving && !conflict;
  function openDay(day: number) {
    setRangeError(''); setChoosingDay(false); setEditing(true);
    setRangeEditor({ day, ranges: dayRanges(selected, day).map(range => ({ ...range, id: rangeId.current++ })) });
  }
  function addRange() {
    if (!rangeEditor) return;
    const occupied = new Set<number>();
    for (const range of rangeEditor.ranges) for (let slot = range.start; slot < range.end; slot++) occupied.add(slot);
    const available = Array.from({ length: 38 }, (_, i) => i + 10).find(slot => !occupied.has(slot));
    if (available === undefined) { setRangeError('This day is already fully available.'); return; }
    const end = available + 1 < 48 && !occupied.has(available + 1) ? available + 2 : available + 1;
    setRangeEditor({ ...rangeEditor, ranges: [...rangeEditor.ranges, { start: available, end, id: rangeId.current++ }] });
  }
  async function applyRanges() {
    if (!rangeEditor || !editable) return;
    const ranges = [...rangeEditor.ranges].sort((a, b) => a.start - b.start);
    if (ranges.some(range => range.end <= range.start)) { setRangeError('To must be later than From.'); return; }
    if (ranges.some((range, index) => index > 0 && ranges[index - 1].end > range.start)) { setRangeError('Time ranges cannot overlap.'); return; }
    const day = rangeEditor.day;
    const slots = new Set(draft.weekly_slots.filter(slot => Math.floor(slot / 48) !== day));
    for (const range of ranges) for (let slot = range.start; slot < range.end; slot++) slots.add(day * 48 + slot);
    if (await save([...slots].sort((a, b) => a - b))) setRangeEditor(null);
  }
  async function save(slots = draft.weekly_slots) {
    if (!editable) return false;
    setSaving(true); setError(''); setRangeError('');
    try {
      const result = await apiRequest<Availability>('/drivers/me/availability', 'PATCH', { weekly_slots: slots, version: draft.version });
      if (!alive.current) return false;
      setSaved(result); setDraft(result); setEditing(false); notify('Availability saved.');
      return true;
    } catch (reason) {
      if (!alive.current) return false;
      if (reason instanceof ApiError && reason.status === 401) onSessionExpired();
      setConflict(reason instanceof ApiError && reason.status === 409);
      if (rangeEditor) setRangeError(message(reason)); else setError(message(reason));
      if (reason instanceof ApiError && reason.status === 403) { setRangeEditor(null); setReload(value => value + 1); }
      return false;
    } finally { if (alive.current) setSaving(false); }
  }
  return <section className="dashboard-trips patients-panel page-panel availability-panel" aria-labelledby="availability-title">
    <PageHeading id="availability-title" title="Weekly Availability"
      eyebrow={!loading && !loadError && eligible ? <span className="availability-hours">Hours per week: {draft.weekly_slots.length / 2}h</span> : 'Driver Schedule'}
      actions={!mobile && !loading && !loadError && eligible ? <div className="patient-actions availability-edit-actions">{editing && !mobile ? <><button className="patient-primary" type="button" disabled={!editable} onClick={() => void save()}>{saving ? 'Saving…' : 'Save availability'}</button><button type="button" disabled={saving} onClick={() => { setDraft(saved); setEditing(false); setConflict(false); setError(''); }}>Cancel</button></> : <button className="patient-primary" type="button" disabled={saving} onClick={() => { setError(''); if (mobile) { setChosenDay(clock.day); setChoosingDay(true); } else setEditing(true); }}>Edit availability</button>}{conflict && !mobile && <button type="button" disabled={saving} onClick={() => setReload(value => value + 1)}>Reload latest availability</button>}</div> : undefined} />
    {loading ? <div className="account-loading patients-loading" role="status"><span className="account-spinner" aria-hidden="true" /><span>Loading...</span></div>
      : loadError ? <ListError title="Availability could not be loaded" message={loadError} onRetry={() => setReload(value => value + 1)} />
      : !eligible ? <section className="availability-approval" aria-labelledby="availability-approval-title">
          <div className="availability-approval-icon" aria-hidden="true"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="m5 7 1.5-4h11L19 7M4 14H3V9a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v3M6 17v2H3v-5h9M6 11h2m8 0h2" /><circle cx="18" cy="18" r="4" /><path d="M18 16v2l1 1" /></svg></div>
          <h2 id="availability-approval-title">Vehicle approval required</h2>
          <p>Once your vehicle is approved, you can set your weekly availability.</p>
          <div className="patient-actions availability-approval-actions"><button className="patient-primary" type="button" onClick={onViewVehicle}>{vehicleRegistered ? 'View My Vehicle' : 'View registration'}</button></div>
        </section>
      : <div className={`patient-profile-form${editing ? ' patient-editing' : ''}`} aria-busy={saving}>
        <div className="panel-scroll availability-content">
          <WeeklyAvailabilityView slots={draft.weekly_slots} clock={clock} editable={editable} onChange={slots => setDraft(current => ({ ...current, weekly_slots: slots }))} />
        </div>
        <div className="patient-actions availability-mobile-actions">
          {editing && !rangeEditor ? <><button className="patient-primary" type="button" disabled={!editable} onClick={() => void save()}>{saving ? 'Saving…' : 'Save availability'}</button><button type="button" disabled={saving} onClick={() => { setDraft(saved); setEditing(false); setConflict(false); setError(''); }}>Cancel</button></> : <button className="patient-primary" type="button" disabled={saving} onClick={() => { setError(''); setChosenDay(clock.day); setChoosingDay(true); }}>Edit availability</button>}
          {conflict && !rangeEditor && <button type="button" disabled={saving} onClick={() => setReload(value => value + 1)}>Reload latest availability</button>}
        </div>
      </div>}
    {choosingDay && <Overlay title="Edit availability" className="list-options-dialog availability-day-picker" onClose={() => setChoosingDay(false)} onSubmit={event => { event.preventDefault(); openDay(chosenDay); }} footer={<><button className="patient-primary" type="submit">Continue</button><button type="button" onClick={() => setChoosingDay(false)}>Cancel</button></>}>
      <div className="patient-form-fields"><div className="patient-field patient-form-wide"><label className="patient-required" htmlFor="availability-edit-day">Day</label><select id="availability-edit-day" required value={chosenDay} onChange={event => setChosenDay(Number(event.target.value))}>{days.map((day, index) => <option value={index} key={day}>{day}</option>)}</select></div></div>
    </Overlay>}
    {rangeEditor && <Overlay title={`${days[rangeEditor.day]} availability`} className="list-options-dialog" busy={saving} onClose={() => { setRangeEditor(null); setEditing(false); setConflict(false); }} error={rangeError} onDismissError={() => setRangeError('')} onSubmit={event => { event.preventDefault(); void applyRanges(); }} footer={<>{conflict ? <button className="patient-primary" type="button" onClick={() => { setRangeEditor(null); setEditing(false); setReload(value => value + 1); }}>Reload latest availability</button> : <button className="patient-primary" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save availability'}</button>}<button type="button" disabled={saving} onClick={() => { setRangeEditor(null); setEditing(false); setConflict(false); }}>Cancel</button></>}>
      <div className="availability-range-editor">
        {rangeEditor.ranges.map((range, index) => <fieldset className="patient-form-fields availability-range-fields" disabled={saving || conflict} key={range.id}><legend className="sr-only">Time range {index + 1}</legend>
          <div className="availability-range-heading"><span aria-hidden="true">Time range {index + 1}</span><button className="overlay-delete availability-remove-range" type="button" aria-label={`Remove time range ${index + 1}`} title="Delete time range" disabled={saving || conflict} onClick={() => setRangeEditor({ ...rangeEditor, ranges: rangeEditor.ranges.filter(item => item.id !== range.id) })}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6m4-6v6" /></svg></button></div>
          <div className="patient-field"><label className="patient-required" htmlFor={`range-from-${range.id}`}>From</label><select required id={`range-from-${range.id}`} value={range.start} onChange={event => setRangeEditor({ ...rangeEditor, ranges: rangeEditor.ranges.map(item => item.id === range.id ? { ...item, start: Number(event.target.value) } : item) })}>{range.start < 10 && <option value={range.start}>{time(range.start)}</option>}{Array.from({ length: 38 }, (_, i) => { const slot = i + 10; return <option key={slot} value={slot}>{time(slot)}</option>; })}</select></div>
          <div className="patient-field"><label className="patient-required" htmlFor={`range-to-${range.id}`}>To</label><select required id={`range-to-${range.id}`} value={range.end} onChange={event => setRangeEditor({ ...rangeEditor, ranges: rangeEditor.ranges.map(item => item.id === range.id ? { ...item, end: Number(event.target.value) } : item) })}>{range.end <= 10 && <option value={range.end}>{time(range.end)}</option>}{Array.from({ length: 38 }, (_, i) => { const slot = i + 11; return <option key={slot} value={slot}>{time(slot)}</option>; })}</select></div>
        </fieldset>)}
        {!rangeEditor.ranges.length && <p className="availability-unavailable">Unavailable</p>}
        <button type="button" disabled={saving || conflict} onClick={addRange}>Add time range</button>
      </div>
    </Overlay>}
    {error && <ToastRegion><Toast key={error} message={error} urgent onDismiss={() => setError('')} /></ToastRegion>}
  </section>;
}
