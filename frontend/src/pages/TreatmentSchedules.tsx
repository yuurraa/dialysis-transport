import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, apiGet, apiRequest } from '../lib/api';

interface Centre { id: string; name: string; address: string; postal_code: string }
interface Details { kind: 'recurring' | 'single'; centre_id: string; days: number[]; start_time: string; end_time: string; effective_from: string; effective_to: string }
interface Schedule extends Omit<Details, 'kind'> { kind?: 'recurring' | 'single'; id: string; patients: { full_name: string }; replaces_schedule_id?: string | null; replaces_date?: string | null }
interface Data { centres: Centre[]; schedules: Schedule[] }
const scheduleIcon = <span className="dashboard-data-status-icon" aria-hidden="true"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="5" width="16" height="16" rx="3" /><path d="M8 3v4m8-4v4M4 11h16m-10 4 4 4m0-4-4 4" /></svg></span>;
const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const blank = (): Details => ({ kind: 'recurring', centre_id: '', days: [], start_time: '', end_time: '', effective_from: '', effective_to: '' });
const dayFor = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
const formatDate = (date: string) => new Intl.DateTimeFormat('en-SG', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Singapore' }).format(new Date(`${date}T00:00:00+08:00`));

export default function TreatmentSchedules({ coordinator, notify, onSessionExpired }: {
  coordinator: boolean; notify: (message: string) => void; onSessionExpired: () => void;
}) {
  const [data, setData] = useState<Data | null>(null);
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<Details | null>(null);
  const [id, setId] = useState<string>();
  const [rescheduling, setRescheduling] = useState<Schedule | null>(null);
  const [originalDate, setOriginalDate] = useState('');
  const selectedCentre = data?.centres.find(centre => centre.id === draft?.centre_id);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const alive = useRef(false);
  const modalHeading = useRef<HTMLHeadingElement>(null);
  const modal = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const formOpen = draft !== null;
  useLayoutEffect(() => {
    if (!formOpen || !modal.current) return;
    const dialog = modal.current;
    const previousOverflow = document.body.style.overflow;
    dialog.showModal();
    modalHeading.current?.focus();
    document.body.style.overflow = 'hidden';
    return () => { if (dialog.open) dialog.close(); document.body.style.overflow = previousOverflow; };
  }, [formOpen]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    apiGet<Data>('/schedules').then(result => { if (active) setData(result); })
      .catch(reason => { if (active) { if (reason instanceof ApiError && reason.status === 401) onSessionExpired(); setError('Treatment schedules could not be loaded. Please try again.'); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [reload, onSessionExpired]);
  function open(schedule?: Schedule, reschedule = false) {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setError(''); setId(reschedule ? undefined : schedule?.id); setRescheduling(reschedule && schedule ? schedule : null); setOriginalDate('');
    setDraft(schedule ? { kind: reschedule ? 'single' : schedule.kind ?? 'recurring', centre_id: schedule.centre_id, days: reschedule ? [] : [...schedule.days], start_time: schedule.start_time.slice(0,5), end_time: schedule.end_time.slice(0,5), effective_from: reschedule ? '' : schedule.effective_from, effective_to: reschedule ? '' : schedule.effective_to } : blank());
  }
  function close() { setDraft(null); setRescheduling(null); setOriginalDate(''); setError(''); requestAnimationFrame(() => (opener.current?.isConnected ? opener.current : addButton.current)?.focus()); }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft || saving) return;
    if (!draft.centre_id || !draft.effective_from || (draft.kind === 'recurring' && (draft.days.length !== 1 || draft.effective_to < draft.effective_from)) || draft.end_time <= draft.start_time) { setError('Check the centre, dates and session times.'); return; }
    if (rescheduling) {
      if (!originalDate || originalDate < rescheduling.effective_from || originalDate > rescheduling.effective_to || dayFor(originalDate) !== rescheduling.days[0]) { setError('Select a valid occurrence of the recurring schedule.'); return; }
      if (data?.schedules.some(schedule => schedule.replaces_schedule_id === rescheduling.id && schedule.replaces_date === originalDate)) { setError('This occurrence has already been rescheduled. Edit its replacement instead.'); return; }
    }
    if (id && draft.kind === 'recurring' && data?.schedules.some(schedule => schedule.replaces_schedule_id === id && schedule.replaces_date
      && (schedule.replaces_date < draft.effective_from || schedule.replaces_date > draft.effective_to || dayFor(schedule.replaces_date) !== draft.days[0]))) { setError('These changes would remove a rescheduled occurrence. Keep its original date within the recurring schedule.'); return; }
    const payload = draft.kind === 'single' ? { kind: draft.kind, centre_id: draft.centre_id, session_date: draft.effective_from, start_time: draft.start_time, end_time: draft.end_time,
      ...(rescheduling ? { replaces_schedule_id: rescheduling.id, replaces_date: originalDate } : {}) } : draft;
    setSaving(true); setError('');
    try {
      await apiRequest(`/schedules${id ? `/${id}` : ''}`, id ? 'PATCH' : 'POST', payload);
      if (!alive.current) return;
      close(); notify('Treatment schedule saved.'); setReload(value => value + 1);
    } catch (reason) {
      if (!alive.current) return;
      if (reason instanceof ApiError && reason.status === 401) onSessionExpired();
      setError(reason instanceof ApiError && reason.status === 400 ? 'Check the dates, times and existing sessions for conflicts.' : 'The schedule could not be saved. Please try again.');
    } finally { if (alive.current) setSaving(false); }
  }
  return <section className={`dashboard-trips treatment-panel${!data?.schedules.length || error ? ' treatment-panel-empty' : ''}`} aria-labelledby="treatment-title" aria-busy={loading}>
    <header className="dashboard-section-heading patients-heading"><div><p className="dashboard-eyebrow">Schedule Management</p><h1 id="treatment-title">Treatment Schedules</h1></div>{!coordinator && <button ref={addButton} className="patient-primary" style={{ visibility: data ? undefined : 'hidden' }} type="button" disabled={loading || !data?.centres.length} onClick={() => open()}>Add Schedule</button>}</header>
    {loading ? <div className="account-loading" role="status"><span className="account-spinner" aria-hidden="true" /><span>Loading...</span></div> : <>
      {error && !draft ? <div className="dashboard-data-status patients-status">{scheduleIcon}<div role="alert"><h3>{error}</h3><p>Schedule information is currently unavailable.</p></div><button type="button" onClick={() => setReload(value => value+1)}>Try again</button></div> : <>
        {!coordinator && Boolean(data?.schedules.length) && <p className="treatment-hint">Treatment times are recorded here. Transport is arranged separately.</p>}
        {!data?.centres.length && <div className="dashboard-data-status patients-status" role="status">{scheduleIcon}<div><h3>No dialysis centres are available.</h3><p>{coordinator ? 'The dialysis centre directory has not been loaded yet.' : 'Contact your Transport Coordinator.'}</p></div></div>}
        {data?.schedules.length === 0 ? data.centres.length > 0 && <div className="dashboard-data-status patients-status" role="status">{scheduleIcon}<div><h3>No treatment schedules yet.</h3><p>{coordinator ? 'Patient treatment schedules will appear here once submitted.' : 'Add your treatment schedule to share your dialysis requirements.'}</p></div></div> : <div className="treatment-records">{data?.schedules.map(schedule => <article className="treatment-record" key={schedule.id}>
          <div><p className="treatment-kind">{schedule.replaces_schedule_id ? 'Rescheduled Session' : schedule.kind === 'single' ? 'Single Session' : 'Recurring'}</p>{coordinator && <p>{schedule.patients.full_name}</p>}<h2>{schedule.kind === 'single' ? formatDate(schedule.effective_from) : schedule.days.map(day => weekdays[day-1]).join(', ')} · {schedule.start_time.slice(0,5)}–{schedule.end_time.slice(0,5)}</h2><p>{data.centres.find(c => c.id === schedule.centre_id)?.name}</p>{schedule.kind !== 'single' && <p>{formatDate(schedule.effective_from)} – {formatDate(schedule.effective_to)}</p>}{schedule.replaces_date && <p>Replaces {formatDate(schedule.replaces_date)}</p>}{data.schedules.some(item => item.replaces_schedule_id === schedule.id) && <p>Rescheduled dates: {data.schedules.filter(item => item.replaces_schedule_id === schedule.id && item.replaces_date).map(item => formatDate(item.replaces_date!)).join(', ')}</p>}</div>
          {!coordinator && <div className="patient-actions"><button type="button" onClick={() => open(schedule)}>Edit Schedule</button>{schedule.kind !== 'single' && <button type="button" onClick={() => open(schedule, true)}>Reschedule Session</button>}</div>}
        </article>)}</div>}
      </>}
    </>}
    {draft && !coordinator && <dialog className="dashboard-dialog" ref={modal} aria-labelledby="schedule-dialog-title" aria-busy={saving}
      onCancel={event => { event.preventDefault(); if (!saving) close(); }}
      onKeyDown={event => {
        if (event.key !== 'Tab') return;
        const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('input:not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled)'));
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (!first) event.preventDefault();
        else if (event.shiftKey && (document.activeElement === first || document.activeElement === modalHeading.current)) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }}
      onClick={event => {
        if (event.target !== event.currentTarget || saving) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
      }}>
      <header className="dashboard-section-heading"><div><p className="dashboard-eyebrow">Schedule Management</p><h2 id="schedule-dialog-title" ref={modalHeading} tabIndex={-1}>{rescheduling ? 'Reschedule Session' : id ? 'Edit Schedule' : 'Add Schedule'}</h2></div></header>
      <form className="patient-form" onSubmit={save}>
      <fieldset className="patient-form-fields" disabled={saving}>
        <div className="patient-field patient-form-wide"><label className="patient-required" htmlFor="schedule-kind">Schedule type</label><select id="schedule-kind" disabled={Boolean(id) || Boolean(rescheduling)} value={draft.kind} onChange={event => setDraft({ ...draft, kind: event.target.value as Details['kind'], days: [], effective_from: '', effective_to: '' })}><option value="recurring">Recurring</option><option value="single">Single Session</option></select><p className="treatment-hint">{draft.kind === 'recurring' ? 'Repeats weekly between the effective dates.' : 'Occurs once on the selected date.'}</p></div>
        {rescheduling && <div className="patient-field patient-form-wide"><label className="patient-required" htmlFor="original-session-date">Original session date</label><input id="original-session-date" type="date" required min={rescheduling.effective_from} max={rescheduling.effective_to} value={originalDate} onChange={event => { const date = event.target.value; setOriginalDate(date); if (!draft.effective_from) setDraft({ ...draft, effective_from: date, effective_to: date, days: date ? [dayFor(date)] : [] }); }} /><p className="treatment-hint">Choose a {weekdays[rescheduling.days[0]-1]} to replace. Other weeks stay unchanged.</p></div>}
        <div className="patient-field patient-form-wide"><CentrePicker centres={data?.centres ?? []} value={draft.centre_id} onChange={centre_id => setDraft({ ...draft, centre_id })} disabled={saving} /><p className="treatment-hint">Centre not listed? Contact your Transport Coordinator.</p></div>
        <div className="patient-field patient-form-wide"><label htmlFor="treatment-address">Centre address</label><textarea id="treatment-address" rows={2} disabled placeholder="Select a centre to view its address" value={selectedCentre ? `${selectedCentre.address}, Singapore ${selectedCentre.postal_code}` : ''} /></div>
        {draft.kind === 'recurring' ? <div className="patient-field patient-form-wide"><label className="patient-required" htmlFor="treatment-day">Treatment day</label><select id="treatment-day" required value={draft.days[0] ?? ''} onChange={e => setDraft({ ...draft, days: e.target.value ? [Number(e.target.value)] : [] })}><option value="">Select a day</option>{weekdays.map((day,index) => <option key={day} value={index+1}>{day}</option>)}</select></div>
          : <div className="patient-field patient-form-wide"><label className="patient-required" htmlFor="single-session-date">Session date</label><input id="single-session-date" type="date" required value={draft.effective_from} onChange={event => setDraft({ ...draft, effective_from: event.target.value, effective_to: event.target.value, days: event.target.value ? [dayFor(event.target.value)] : [] })} /></div>}
        <div className="patient-field"><label className="patient-required" htmlFor="treatment-start">Session start</label><input id="treatment-start" type="time" required value={draft.start_time} onChange={e => setDraft({ ...draft, start_time: e.target.value })} /></div>
        <div className="patient-field"><label className="patient-required" htmlFor="treatment-end">Session end</label><input id="treatment-end" type="time" required value={draft.end_time} onChange={e => setDraft({ ...draft, end_time: e.target.value })} /></div>
        {draft.kind === 'recurring' && <><div className="patient-field"><label className="patient-required" htmlFor="treatment-from">Effective from</label><input id="treatment-from" type="date" required value={draft.effective_from} onChange={e => setDraft({ ...draft, effective_from: e.target.value })} /></div>
        <div className="patient-field"><label className="patient-required" htmlFor="treatment-to">Effective to</label><input id="treatment-to" type="date" required min={draft.effective_from} value={draft.effective_to} onChange={e => setDraft({ ...draft, effective_to: e.target.value })} /></div></>}
      </fieldset>
      {error && <p className="patient-error" role="alert">{error}</p>}
      <div className="patient-actions"><button type="button" disabled={saving} onClick={close}>Cancel</button><button className="patient-primary" type="submit" disabled={saving}>{saving ? <><span className="account-spinner" aria-hidden="true" />Loading...</> : 'Save Schedule'}</button></div>
    </form>
    </dialog>}
  </section>;
}

/** Keep the centre results bounded while retaining keyboard and touch selection. */
function CentrePicker({ centres, value, onChange, disabled }: { centres: Centre[]; value: string; onChange: (id: string) => void; disabled: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const selected = centres.find(centre => centre.id === value);
  const term = query.trim().toLocaleLowerCase('en-SG');
  const matches = centres.filter(centre => `${centre.name} ${centre.address} ${centre.postal_code}`.toLocaleLowerCase('en-SG').includes(term));
  const activeId = expanded && matches[active] ? `centre-option-${matches[active].id}` : undefined;
  useEffect(() => { if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' }); }, [activeId]);
  function choose(centre: Centre) { onChange(centre.id); setExpanded(false); setQuery(''); }
  return <div className="centre-picker" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setExpanded(false); }}>
    <label className="patient-required" htmlFor="treatment-centre">Dialysis centre</label>
    <input ref={input} id="treatment-centre" role="combobox" aria-label="Dialysis centre" aria-autocomplete="list" aria-expanded={expanded} aria-controls="centre-results" aria-activedescendant={activeId} autoComplete="off" required disabled={disabled}
      placeholder="Search by name, address or postal code" value={expanded ? query : selected?.name ?? ''}
      onFocus={() => { setQuery(''); setActive(0); setExpanded(true); }}
      onClick={() => { if (!expanded) { setQuery(''); setActive(0); setExpanded(true); } }}
      onChange={event => { setQuery(event.target.value); onChange(''); setActive(0); setExpanded(true); }}
      onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault(); setExpanded(true);
          setActive(current => !expanded || !matches.length ? 0 : (current + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length);
        } else if (event.key === 'Enter' && expanded) { event.preventDefault(); if (matches[active]) choose(matches[active]); }
        else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setExpanded(false); }
        else if (event.key === 'Tab') setExpanded(false);
      }} />
    {expanded && <div className="centre-results-panel"><ul id="centre-results" role="listbox" aria-label="Dialysis centres">
      {matches.map((centre,index) => <li id={`centre-option-${centre.id}`} key={centre.id} role="option" aria-selected={centre.id === value} className={index === active ? 'is-active' : undefined}
        onMouseDown={event => event.preventDefault()} onClick={() => choose(centre)}><span>{centre.name}</span><small>{centre.address}, Singapore {centre.postal_code}</small></li>)}
    </ul>{!matches.length && <p role="status">No matching centres. Try another search.</p>}</div>}
  </div>;
}
