import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { ListError, Overlay, PageHeading } from '../components/DashboardUI';
import { Toast } from '../components/Toast';
import { ApiError, apiGet, apiRequest } from '../lib/api';

const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const time = (slot: number) => `${String(Math.floor(slot / 2)).padStart(2, '0')}:${slot % 2 ? '30' : '00'}`;
function singaporeClock() {
  const local = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return { day: (local.getUTCDay() + 6) % 7, minutes: local.getUTCHours() * 60 + local.getUTCMinutes() };
}
interface TimeRange { start: number; end: number }
function dayRanges(slots: Set<number>, day: number): TimeRange[] {
  const ranges: TimeRange[] = [];
  for (let slot = 0; slot < 48; slot++) {
    if (!slots.has(day * 48 + slot)) continue;
    const start = slot;
    while (slot + 1 < 48 && slots.has(day * 48 + slot + 1)) slot++;
    ranges.push({ start, end: slot + 1 });
  }
  return ranges;
}
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
  const [clock, setClock] = useState(singaporeClock);
  useEffect(() => {
    const update = () => setClock(singaporeClock());
    const timer = window.setInterval(update, 15000);
    document.addEventListener('visibilitychange', update);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', update); };
  }, []);
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
  const [chosenDay, setChosenDay] = useState(() => singaporeClock().day);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 760px)');
    const update = () => setMobile(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  const [rangeEditor, setRangeEditor] = useState<{ day: number; ranges: (TimeRange & { id: number })[] } | null>(null);
  const [rangeError, setRangeError] = useState('');
  const rangeId = useRef(0);
  const [focusSlot, setFocusSlot] = useState(() => singaporeClock().day * 48 + 10);
  const alive = useRef(false);
  const grid = useRef<HTMLDivElement>(null);
  const drag = useRef<{ start: number; base: Set<number>; available: boolean } | null>(null);
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
  const start = 10;
  const editable = editing && !saving && !conflict;
  function toggle(slot: number) {
    setDraft(current => {
      const next = new Set(current.weekly_slots);
      if (next.has(slot)) next.delete(slot); else next.add(slot);
      return { ...current, weekly_slots: [...next].sort((a, b) => a - b) };
    });
  }
  function paint(end: number) {
    const state = drag.current;
    if (!state) return;
    const next = new Set(state.base);
    for (let day = Math.min(Math.floor(state.start / 48), Math.floor(end / 48)); day <= Math.max(Math.floor(state.start / 48), Math.floor(end / 48)); day++) {
      for (let slot = Math.min(state.start % 48, end % 48); slot <= Math.max(state.start % 48, end % 48); slot++) {
        if (state.available) next.add(day * 48 + slot); else next.delete(day * 48 + slot);
      }
    }
    setDraft(current => ({ ...current, weekly_slots: [...next].sort((a, b) => a - b) }));
  }
  function pointerDown(event: PointerEvent<HTMLButtonElement>, slot: number) {
    if (!editable || event.pointerType !== 'mouse' || event.button !== 0) return;
    event.preventDefault(); event.currentTarget.focus();
    drag.current = { start: slot, base: selected, available: !selected.has(slot) };
    grid.current?.setPointerCapture(event.pointerId); paint(slot);
  }
  function move(event: PointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    const cell = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-availability-slot]');
    if (cell && grid.current?.contains(cell)) paint(Number(cell.dataset.availabilitySlot));
  }
  function keyDown(event: KeyboardEvent<HTMLButtonElement>, key: number) {
    const offsets: Partial<Record<string, number>> = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -48, ArrowRight: 48 };
    const offset = offsets[event.key];
    if (offset === undefined) return;
    event.preventDefault();
    const next = key + offset;
    if (next < 0 || next > 335 || next % 48 < start || (Math.abs(offset) === 1 && Math.floor(next / 48) !== Math.floor(key / 48))) return;
    setFocusSlot(next);
    requestAnimationFrame(() => grid.current?.querySelector<HTMLButtonElement>(`[data-availability-slot="${next}"]`)?.focus());
  }
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
          <div className="availability-mobile-days" role="region" aria-label="Weekly availability by day">
            {days.map((day, dayIndex) => { const ranges = dayRanges(selected, dayIndex); return <section className="availability-mobile-day" key={day} aria-labelledby={`mobile-availability-${dayIndex}`}>
              <h2 id={`mobile-availability-${dayIndex}`} aria-current={dayIndex === clock.day ? 'date' : undefined}>{day}</h2>
              {ranges.length ? <ul className="availability-mobile-ranges">{ranges.map(range => <li key={range.start}>{time(range.start)}–{time(range.end)}</li>)}</ul> : <p className="availability-unavailable">Unavailable</p>}
            </section>; })}
          </div>
          <div className="availability-grid" ref={grid} role="group" aria-label="Weekly availability" onPointerMove={move} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}>
            <div className="availability-time-column" aria-hidden="true"><div className="availability-day-heading">Time</div>{Array.from({ length: 48 - start }, (_, i) => <div className="availability-time" key={i}>{time(start + i)}</div>)}</div>
            {days.map((day, dayIndex) => <div key={day} className={`availability-day${dayIndex === clock.day ? ' availability-today' : ''}`}><div className="availability-day-heading" aria-current={dayIndex === clock.day ? 'date' : undefined}>{day}</div>
              {Array.from({ length: 48 - start }, (_, i) => { const slot = start + i; const key = dayIndex * 48 + slot; return <button type="button" className="availability-slot" key={key} data-availability-slot={key} aria-label={`${day} ${time(slot)}–${time(slot + 1)}`} aria-pressed={selected.has(key)} disabled={!editable} tabIndex={focusSlot === key ? 0 : -1} onFocus={() => setFocusSlot(key)} onKeyDown={event => keyDown(event, key)} onPointerDown={event => pointerDown(event, key)} onClick={event => { if (editable && (event.detail === 0 || (event.nativeEvent as globalThis.PointerEvent).pointerType !== 'mouse')) toggle(key); }} />; })}
            </div>)}
            {clock.minutes >= start * 30 && <div className="availability-now-marker" role="img" aria-label={`Current Singapore time ${String(Math.floor(clock.minutes / 60)).padStart(2, '0')}:${String(clock.minutes % 60).padStart(2, '0')}`} style={{ top: `min(100%, ${34 + (clock.minutes / 30 - start) * 26}px)` }}><span className="availability-now-time" aria-hidden="true">{String(Math.floor(clock.minutes / 60)).padStart(2, '0')}:{String(clock.minutes % 60).padStart(2, '0')}</span></div>}
          </div>
        </div>
        <div className="patient-actions availability-mobile-actions">
          {editing && !rangeEditor ? <><button className="patient-primary" type="button" disabled={!editable} onClick={() => void save()}>{saving ? 'Saving…' : 'Save availability'}</button><button type="button" disabled={saving} onClick={() => { setDraft(saved); setEditing(false); setConflict(false); setError(''); }}>Cancel</button></> : <button className="patient-primary" type="button" disabled={saving} onClick={() => { setError(''); setChosenDay(clock.day); setChoosingDay(true); }}>Edit availability</button>}
          {conflict && !rangeEditor && <button type="button" disabled={saving} onClick={() => setReload(value => value + 1)}>Reload latest availability</button>}
        </div>
      </div>}
    {choosingDay && <Overlay title="Edit availability" className="list-options-dialog availability-day-picker" onClose={() => setChoosingDay(false)} onSubmit={event => { event.preventDefault(); openDay(chosenDay); }} footer={<><button className="patient-primary" type="submit">Continue</button><button type="button" onClick={() => setChoosingDay(false)}>Cancel</button></>}>
      <div className="patient-form-fields"><div className="patient-field patient-form-wide"><label htmlFor="availability-edit-day">Day</label><select id="availability-edit-day" value={chosenDay} onChange={event => setChosenDay(Number(event.target.value))}>{days.map((day, index) => <option value={index} key={day}>{day}</option>)}</select></div></div>
    </Overlay>}
    {rangeEditor && <Overlay title={`${days[rangeEditor.day]} availability`} className="list-options-dialog" busy={saving} onClose={() => { setRangeEditor(null); setEditing(false); setConflict(false); }} error={rangeError} onDismissError={() => setRangeError('')} onSubmit={event => { event.preventDefault(); void applyRanges(); }} footer={<>{conflict ? <button className="patient-primary" type="button" onClick={() => { setRangeEditor(null); setEditing(false); setReload(value => value + 1); }}>Reload latest availability</button> : <button className="patient-primary" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save availability'}</button>}<button type="button" disabled={saving} onClick={() => { setRangeEditor(null); setEditing(false); setConflict(false); }}>Cancel</button></>}>
      <div className="availability-range-editor">
        {rangeEditor.ranges.map((range, index) => <fieldset className="patient-form-fields availability-range-fields" disabled={saving || conflict} key={range.id}><legend className="sr-only">Time range {index + 1}</legend>
          <div className="availability-range-heading"><span aria-hidden="true">Time range {index + 1}</span><button className="overlay-delete availability-remove-range" type="button" aria-label={`Remove time range ${index + 1}`} title="Delete time range" disabled={saving || conflict} onClick={() => setRangeEditor({ ...rangeEditor, ranges: rangeEditor.ranges.filter(item => item.id !== range.id) })}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6m4-6v6" /></svg></button></div>
          <div className="patient-field"><label htmlFor={`range-from-${range.id}`}>From</label><select id={`range-from-${range.id}`} value={range.start} onChange={event => setRangeEditor({ ...rangeEditor, ranges: rangeEditor.ranges.map(item => item.id === range.id ? { ...item, start: Number(event.target.value) } : item) })}>{range.start < 10 && <option value={range.start}>{time(range.start)}</option>}{Array.from({ length: 38 }, (_, i) => { const slot = i + 10; return <option key={slot} value={slot}>{time(slot)}</option>; })}</select></div>
          <div className="patient-field"><label htmlFor={`range-to-${range.id}`}>To</label><select id={`range-to-${range.id}`} value={range.end} onChange={event => setRangeEditor({ ...rangeEditor, ranges: rangeEditor.ranges.map(item => item.id === range.id ? { ...item, end: Number(event.target.value) } : item) })}>{range.end <= 10 && <option value={range.end}>{time(range.end)}</option>}{Array.from({ length: 38 }, (_, i) => { const slot = i + 11; return <option key={slot} value={slot}>{time(slot)}</option>; })}</select></div>
        </fieldset>)}
        {!rangeEditor.ranges.length && <p className="availability-unavailable">Unavailable</p>}
        <button type="button" disabled={saving || conflict} onClick={addRange}>Add time range</button>
      </div>
    </Overlay>}
    {error && <div className="toast-region"><Toast key={error} message={error} urgent onDismiss={() => setError('')} /></div>}
  </section>;
}
