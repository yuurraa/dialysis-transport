import { Dropdown } from '../components/Dropdown';
import { Overlay, PageHeading } from '../components/DashboardUI';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ApiError, apiGet, apiRequest } from '../lib/api';
import { addDays, singaporeToday } from './TripsPage';

interface Centre { id: string; name: string; address: string; postal_code: string }
interface Details { kind: 'recurring' | 'single'; centre_id: string; days: number[]; start_time: string; end_time: string; effective_from: string; effective_to: string }
interface Schedule extends Omit<Details, 'kind'> { kind?: 'recurring' | 'single'; id: string; version: number; patient_id: string; patients: { full_name: string }; replaces_schedule_id?: string | null; replaces_date?: string | null }
interface Data { centres: Centre[]; schedules: Schedule[]; context: Schedule[]; total: number; page: number; pageSize: number }
const scheduleIcon = <span className="dashboard-data-status-icon" aria-hidden="true"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="5" width="16" height="16" rx="3" /><path d="M8 3v4m8-4v4M4 11h16m-10 4 4 4m0-4-4 4" /></svg></span>;
const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const blank = (): Details => ({ kind: 'recurring', centre_id: '', days: [], start_time: '', end_time: '', effective_from: '', effective_to: '' });
const dayFor = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
const supportedDate = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date) && !date.startsWith('0000') && Number.isFinite(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0,10) === date;
const formatDayDate = (date: string) => !supportedDate(date) ? 'Invalid date' : new Intl.DateTimeFormat('en-SG', { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Singapore' }).format(new Date(`${date}T00:00:00+08:00`));
const formatDate = (date: string) => !supportedDate(date) ? 'Invalid date' : new Intl.DateTimeFormat('en-SG', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Singapore' }).format(new Date(`${date}T00:00:00+08:00`));

export default function TreatmentSchedules({ coordinator, notify, onSessionExpired }: {
  coordinator: boolean; notify: (message: string) => void; onSessionExpired: () => void;
}) {
  const [data, setData] = useState<Data | null>(null);
  const [reload, setReload] = useState(0);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [generatingSchedule, setGeneratingSchedule] = useState<Schedule | null>(null);
  const [generationDates, setGenerationDates] = useState({ from: '', until: '' });
  const [generating, setGenerating] = useState(false);
  const [generationError, setGenerationError] = useState('');
  const [generationConflict, setGenerationConflict] = useState(false);
  const [filters, setFilters] = useState({page: 1, search: ''});
  useEffect(() => {
    const timer = window.setTimeout(() => setFilters(current => current.search === search.trim() ? current : {page:1,search:search.trim()}),300);
    return () => window.clearTimeout(timer);
  },[search]);
  const searchTerm = filters.search;
  const visibleSchedules = data?.schedules ?? [];
  const context = useMemo(() => [...new Map([...(data?.schedules ?? []),...(data?.context ?? [])].map(schedule => [schedule.id,schedule])).values()],[data]);
  useEffect(() => {
    if (!data || loading) return;
    const lastPage=Math.max(1,Math.ceil((data.total ?? data.schedules.length)/(data.pageSize ?? 25)));
    if (filters.page>lastPage) setFilters(current => ({...current,page:lastPage}));
  },[data,filters.page,loading]);
  const [draftVersion, setDraftVersion] = useState<number>();
  const [editingSchedule, setEditingSchedule] = useState<Schedule | null>(null);
  const [editorContext, setEditorContext] = useState<Schedule[]>([]);
  const [conflict, setConflict] = useState(false);
  const [draft, setDraft] = useState<Details | null>(null);
  const [id, setId] = useState<string>();
  const [rescheduling, setRescheduling] = useState<Schedule | null>(null);
  const [originalDate, setOriginalDate] = useState('');
  const [occurrenceMonth, setOccurrenceMonth] = useState('');
  const selectedCentre = data?.centres.find(centre => centre.id === draft?.centre_id);
  const occurrences = useMemo(() => {
    const dates: string[] = [];
    if (!rescheduling) return { dates, month: '', needsMonth: false };
    const day = 86400000;
    const start = Date.parse(`${rescheduling.effective_from}T00:00:00Z`);
    const end = Date.parse(`${rescheduling.effective_to}T00:00:00Z`);
    const first = start + ((rescheduling.days[0] - (new Date(start).getUTCDay() || 7) + 7) % 7) * day;
    const needsMonth = Math.floor((end - first) / (7 * day)) + 1 > 52;
    const month = occurrenceMonth || rescheduling.effective_from.slice(0, 7);
    const monthStart = Date.parse(`${month}-01T00:00:00Z`);
    const nextMonth = new Date(monthStart);
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
    const from = needsMonth ? Math.max(start, monthStart) : start;
    const until = needsMonth ? Math.min(end, nextMonth.getTime() - day) : end;
    const firstInWindow = from + ((rescheduling.days[0] - (new Date(from).getUTCDay() || 7) + 7) % 7) * day;
    const replaced = new Set(editorContext.filter(schedule => schedule.replaces_schedule_id === rescheduling.id).map(schedule => schedule.replaces_date));
    for (let time = firstInWindow; time <= until; time += 7 * day) {
      const date = new Date(time).toISOString().slice(0, 10);
      if (!replaced.has(date)) dates.push(date);
    }
    return { dates, month, needsMonth };
  }, [rescheduling, occurrenceMonth, editorContext]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const alive = useRef(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [historySchedule, setHistorySchedule] = useState<Schedule | null>(null);
  const replacements = useMemo(() => {
    const grouped = new Map<string, Schedule[]>();
    for (const schedule of context) {
      if (!schedule.replaces_schedule_id) continue;
      const list = grouped.get(schedule.replaces_schedule_id) ?? [];
      list.push(schedule); grouped.set(schedule.replaces_schedule_id, list);
    }
    for (const list of grouped.values()) list.sort((a,b) => (a.replaces_date ?? '').localeCompare(b.replaces_date ?? ''));
    return grouped;
  }, [context]);
  const currentSchedule = editingSchedule;
  const addButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    apiGet<Data>(`/schedules?${new URLSearchParams({page:String(filters.page),search:filters.search})}`).then(result => { if (active) setData(result); })
      .catch(reason => { if (active) { if (reason instanceof ApiError && reason.status === 401) onSessionExpired(); setError('Treatment schedules could not be loaded. Please try again.'); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [reload, onSessionExpired, filters]);
  function open(schedule?: Schedule, reschedule = false) {
    setConflict(false); setDraftVersion(schedule?.version); setEditingSchedule(schedule ?? null);
    setEditorContext(draft ? editorContext : context);
    setConfirmingDelete(false); setError(''); setId(reschedule ? undefined : schedule?.id); setRescheduling(reschedule && schedule ? schedule : null); setOriginalDate(''); setOccurrenceMonth('');
    setDraft(schedule ? { kind: reschedule ? 'single' : schedule.kind ?? 'recurring', centre_id: schedule.centre_id, days: reschedule ? [] : [...schedule.days], start_time: schedule.start_time.slice(0,5), end_time: schedule.end_time.slice(0,5), effective_from: reschedule ? '' : schedule.effective_from, effective_to: reschedule ? '' : schedule.effective_to } : blank());
  }
  function close() { setConflict(false); setEditingSchedule(null); setEditorContext([]); setDraft(null); setRescheduling(null); setOriginalDate(''); setConfirmingDelete(false); setError(''); }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft || saving || conflict) return;
    if (rescheduling && !occurrences.dates.includes(originalDate)) { setError('Choose the session you want to change.'); return; }
    if (!draft.centre_id || !draft.effective_from || !draft.start_time || !draft.end_time || (draft.kind === 'recurring' && (draft.days.length !== 1 || draft.effective_to < draft.effective_from)) || draft.end_time <= draft.start_time) { setError('Check the centre, dates and session times.'); return; }
    if (draft.kind==='recurring') {
      const first=Date.parse(draft.effective_from)+((draft.days[0]-dayFor(draft.effective_from)+7)%7)*86400000;
      if (first>Date.parse(draft.effective_to)) { setError('Choose a date range that includes the selected treatment day.'); return; }
    }
    if (rescheduling) {
      if (!originalDate || originalDate < rescheduling.effective_from || originalDate > rescheduling.effective_to || dayFor(originalDate) !== rescheduling.days[0]) { setError('Select a valid occurrence of the recurring schedule.'); return; }
      if (editorContext.some(schedule => schedule.replaces_schedule_id === rescheduling.id && schedule.replaces_date === originalDate)) { setError('This occurrence has already been rescheduled. Edit its replacement instead.'); return; }
    }
    if (id && draft.kind === 'recurring' && editorContext.some(schedule => schedule.replaces_schedule_id === id && schedule.replaces_date
      && (schedule.replaces_date < draft.effective_from || schedule.replaces_date > draft.effective_to || dayFor(schedule.replaces_date) !== draft.days[0]))) { setError('These changes would remove a rescheduled occurrence. Keep its original date within the recurring schedule.'); return; }
    const payload = draft.kind === 'single' ? { kind: draft.kind, centre_id: draft.centre_id, session_date: draft.effective_from, start_time: draft.start_time, end_time: draft.end_time,
      ...(rescheduling ? { replaces_schedule_id: rescheduling.id, replaces_date: originalDate } : {}) } : draft;
    setSaving(true); setError('');
    try {
      await apiRequest(`/schedules${id ? `/${id}` : ''}`, id ? 'PATCH' : 'POST', id ? {...payload,version:draftVersion} : payload);
      if (!alive.current) return;
      close(); notify('Treatment schedule saved.'); setReload(value => value + 1);
    } catch (reason) {
      if (!alive.current) return;
      if (reason instanceof ApiError && reason.status === 401) onSessionExpired();
      if (reason instanceof ApiError && reason.status === 409) { setConflict(true); setError('This schedule changed in another session. Reload schedules before saving again.'); return; }
      setError(reason instanceof ApiError && reason.status === 400 ? 'Check the dates, times and existing sessions for conflicts.' : 'The schedule could not be saved. Please try again.');
    } finally { if (alive.current) setSaving(false); }
  }
  async function remove() {
    if (!currentSchedule || saving || conflict) return;
    setSaving(true); setError('');
    try {
      await apiRequest(`/schedules/${currentSchedule.id}`, 'DELETE', {version:draftVersion});
      if (!alive.current) return;
      close(); notify('Treatment schedule deleted.'); setReload(value => value + 1);
      requestAnimationFrame(() => addButton.current?.focus());
    } catch (reason) {
      if (!alive.current) return;
      if (reason instanceof ApiError && reason.status === 401) onSessionExpired();
      if (reason instanceof ApiError && reason.status === 409) { setConflict(true); setError('This schedule changed in another session. Reload schedules before deleting.'); return; }
      setError(reason instanceof ApiError && reason.status === 400
        ? 'The original session would overlap another schedule. Edit that conflict before removing this replacement.'
        : 'The schedule could not be deleted. Please try again.');
    } finally { if (alive.current) setSaving(false); }
  }
  function openGeneration(schedule: Schedule) {
    const from = schedule.effective_from > singaporeToday() ? schedule.effective_from : singaporeToday();
    setGeneratingSchedule(schedule); setGenerationError(''); setGenerationConflict(false);
    const until = schedule.kind === 'single' ? from : schedule.effective_to >= from && schedule.effective_to < addDays(from, 30) ? schedule.effective_to : addDays(from, 30);
    setGenerationDates({ from, until });
  }
  async function reloadGeneration() {
    if (!generatingSchedule || generating) return;
    setGenerating(true);
    try {
      const result = await apiGet<Data>(`/schedules?${new URLSearchParams({ page: String(filters.page), search: filters.search })}`);
      if (!alive.current) return;
      setData(result);
      const latest = [...result.schedules, ...(result.context ?? [])].find(schedule => schedule.id === generatingSchedule.id);
      if (!latest) { setGenerationError('This schedule is no longer available. Cancel and choose another schedule.'); return; }
      setGeneratingSchedule(latest); setGenerationConflict(false); setGenerationError('');
    } catch (reason) {
      if (!alive.current) return;
      if (reason instanceof ApiError && reason.status === 401) onSessionExpired();
      setGenerationError('Schedules could not be reloaded. Please try again.');
    } finally { if (alive.current) setGenerating(false); }
  }
  async function generateTrips(event: FormEvent) {
    event.preventDefault();
    if (!generatingSchedule || generating || generationConflict) return;
    const { from, until } = generationDates;
    if (!supportedDate(from) || !supportedDate(until) || from < singaporeToday() || until < from || until > addDays(from, 89)) { setGenerationError('Choose dates from today within a maximum of 90 days.'); return; }
    setGenerating(true); setGenerationError('');
    try {
      const result = await apiRequest<{ created: number; updated: number; unchanged: number; skipped?: number; total: number }>('/trips/generate', 'POST', { schedule_id: generatingSchedule.id, from_date: from, until_date: until, version: generatingSchedule.version });
      if (!alive.current) return;
      setGeneratingSchedule(null);
      notify(`Trips generated: ${result.created} created, ${result.updated} updated, ${result.unchanged} unchanged (${result.total} total).${result.skipped ? ` ${result.skipped} deleted ${result.skipped === 1 ? 'trip' : 'trips'} skipped.` : ''} No duplicate trips created.`);
    } catch (reason) {
      if (!alive.current) return;
      if (reason instanceof ApiError && reason.status === 401) onSessionExpired();
      if (reason instanceof ApiError && reason.status === 409) { setGenerationConflict(true); setGenerationError('This schedule changed. Reload schedules before generating again.'); }
      else setGenerationError(reason instanceof ApiError && reason.status === 400 ? 'Check the selected schedule and dates before trying again.' : 'Trips could not be generated. Please try again.');
    } finally { if (alive.current) setGenerating(false); }
  }
  return <section className="dashboard-trips treatment-panel page-panel" aria-labelledby="treatment-title" aria-busy={loading}>
    <PageHeading id="treatment-title" title={coordinator ? "Treatment Schedule List" : "Treatment Schedules"} eyebrow={coordinator ? "Schedule Management" : "Treatment planning"}
      actions={<><label className="patient-search"><svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></svg><input type="search" aria-label="Search treatment schedules" placeholder={coordinator ? "Patient or schedule details" : "Centre, day, date or type"} title={coordinator ? "Search by patient name, ID, centre, day, date or schedule type" : "Search by centre, day, date or schedule type"} maxLength={100} value={search} onChange={event => setSearch(event.target.value)} /></label>{!coordinator && <button ref={addButton} className="patient-primary" type="button" disabled={loading || !data?.centres.length} onClick={() => open()}>Add Schedule</button>}</>} />
    {loading ? <div className="account-loading" role="status"><span className="account-spinner" aria-hidden="true" /><span>Loading...</span></div> : <>
      {error && !draft ? <div className="dashboard-data-status patients-status">{scheduleIcon}<div role="alert"><h3>{error}</h3><p>Schedule information is currently unavailable.</p></div><button type="button" onClick={() => setReload(value => value+1)}>Try again</button></div> : <>
        {!data?.centres.length && <div className="dashboard-data-status patients-status" role="status">{scheduleIcon}<div><h3>No dialysis centres are available.</h3><p>{coordinator ? 'The dialysis centre directory has not been loaded yet.' : 'Contact your Transport Coordinator.'}</p></div></div>}
        {(data?.total ?? data?.schedules.length) === 0 ? (data?.centres.length ?? 0) > 0 && <div className="dashboard-data-status patients-status" role="status">{scheduleIcon}<div><h3>{searchTerm ? 'No matching schedules.' : 'No treatment schedules yet.'}</h3><p>{searchTerm ? 'Try another search.' : coordinator ? 'Patient treatment schedules will appear here once submitted.' : 'Add your treatment schedule to share your dialysis requirements.'}</p></div></div> : searchTerm && visibleSchedules.length === 0 ? <div className="dashboard-data-status patients-status" role="status">{scheduleIcon}<div><h3>No matching schedules.</h3><p>{coordinator ? 'Try another patient name, ID, centre, day, date or schedule type.' : 'Try another centre, day, date or schedule type.'}</p></div></div> : <div className="treatment-records panel-scroll" tabIndex={0} role="region" aria-label="Treatment schedules">{visibleSchedules.map(schedule => <article className="treatment-record" key={schedule.id}>
          <div><div className="treatment-identity"><p>{schedule.patients.full_name}</p>{coordinator && <p className="treatment-patient-id"><span className="treatment-identity-separator" aria-hidden="true">·</span>Patient ID: {schedule.patient_id}</p>}<p className="treatment-kind">{schedule.replaces_schedule_id ? 'Rescheduled Session' : schedule.kind === 'single' ? 'Single Session' : 'Recurring'}</p></div><h2><span>{schedule.kind === 'single' ? formatDayDate(schedule.effective_from) : `Every ${schedule.days.map(day => weekdays[day-1]).join(', ')}`}</span><span className="treatment-time">{schedule.start_time.slice(0,5)}–{schedule.end_time.slice(0,5)}</span></h2><p>{data?.centres.find(c => c.id === schedule.centre_id)?.name}</p>{schedule.kind !== 'single' && <p>From {formatDate(schedule.effective_from)} until {formatDate(schedule.effective_to)}</p>}{schedule.replaces_date && <p>Replaces {formatDate(schedule.replaces_date)}</p>}{replacements.has(schedule.id) && <button className="reschedule-summary" type="button" onClick={() => setHistorySchedule(schedule)}>{replacements.get(schedule.id)!.length} rescheduled {replacements.get(schedule.id)!.length === 1 ? 'session' : 'sessions'}</button>}</div>
          <div className="patient-actions">{coordinator ? <button type="button" disabled={!schedule.version || !supportedDate(schedule.effective_from) || (schedule.kind === 'single' && schedule.effective_from < singaporeToday())} onClick={() => openGeneration(schedule)}>Generate Trips</button> : <button type="button" onClick={() => open(schedule)}>Edit Schedule</button>}</div>
        </article>)}</div>}
      </>}
    </>}
    <div className="patients-pagination" aria-label="Schedule pages"><span>{data ? <>{data.total ?? visibleSchedules.length} {(data.total ?? visibleSchedules.length)===1 ? 'schedule' : 'schedules'} · Page {filters.page} of {Math.max(1,Math.ceil((data.total ?? visibleSchedules.length)/(data.pageSize ?? 25)))}</> : loading ? 'Loading...' : 'Schedule count unavailable'}</span><div className="patient-actions"><button type="button" aria-label="Previous" title="Previous page" disabled={loading || !!error || search.trim()!==filters.search || filters.page===1} onClick={() => setFilters(current => ({...current,page:current.page-1}))}>{'<'}</button><button type="button" aria-label="Next" title="Next page" disabled={loading || !!error || search.trim()!==filters.search || !data || filters.page*(data.pageSize ?? 25)>=(data.total ?? visibleSchedules.length)} onClick={() => setFilters(current => ({...current,page:current.page+1}))}>{'>'}</button></div></div>
    {generatingSchedule && coordinator && <Overlay title="Generate Trips" description="Create outbound and return journeys from treatment requirements." busy={generating} onClose={() => setGeneratingSchedule(null)} onSubmit={generateTrips} noValidate error={generationError} onDismissError={() => setGenerationError('')}
      footer={<><button className="patient-primary" type={generationConflict ? 'button' : 'submit'} disabled={generating} onClick={generationConflict ? () => void reloadGeneration() : undefined}>{generating ? 'Loading…' : generationConflict ? 'Reload schedules' : 'Generate Trips'}</button><button type="button" disabled={generating} onClick={() => setGeneratingSchedule(null)}>Cancel</button></>}>
      <dl className="signup-review"><div><dt>Patient</dt><dd>{generatingSchedule.patients.full_name}</dd></div><div><dt>Patient ID</dt><dd>{generatingSchedule.patient_id}</dd></div><div><dt>Dialysis centre</dt><dd>{data?.centres.find(centre => centre.id === generatingSchedule.centre_id)?.name}</dd></div><div><dt>Source</dt><dd>{generatingSchedule.kind === 'single' ? `Single session · ${formatDate(generatingSchedule.effective_from)}` : 'Recurring series, including rescheduled sessions in this date range'}</dd></div></dl>
      <fieldset className="patient-form-fields trip-generation-dates" disabled={generating}><div className="patient-field"><label htmlFor="generation-from">From date</label><input id="generation-from" type="date" min={singaporeToday()} max={generationDates.until} value={generationDates.from} onChange={event => setGenerationDates(current => ({ ...current, from: event.target.value }))} /></div><div className="patient-field"><label htmlFor="generation-until">Until date</label><input id="generation-until" type="date" min={generationDates.from} max={supportedDate(generationDates.from) ? addDays(generationDates.from, 89) : undefined} value={generationDates.until} onChange={event => setGenerationDates(current => ({ ...current, until: event.target.value }))} /></div></fieldset>
      <p className="patient-overview-note">Trips start as Unfilled. Home pickup time, driver and vehicle assignment are pending. Outbound arrival is 15 minutes before treatment; return pickup is no earlier than 15 minutes after treatment ends. Existing trips are updated without duplicates.</p>
    </Overlay>}
    {draft && !coordinator && <Overlay title={confirmingDelete ? 'Delete Schedule' : id || rescheduling ? 'Edit Schedule' : 'Add Schedule'}
      description={confirmingDelete ? 'Review what will be removed before confirming.' : rescheduling ? 'Change one session. Other weeks stay unchanged.' : currentSchedule?.kind !== 'single' && currentSchedule ? 'Changes apply to the entire recurring schedule.' : 'Record the centre, date and treatment times.'}
      className={confirmingDelete ? '' : 'schedule-editor'} busy={saving} onClose={close} onSubmit={confirmingDelete ? undefined : save} noValidate error={error} onDismissError={() => setError('')}
      footer={conflict ? <><button className="patient-primary" type="button" onClick={() => { close(); setReload(value => value+1); }}>Reload schedules</button><button type="button" onClick={close}>Cancel</button></> : confirmingDelete ? <><button type="button" disabled={saving} onClick={() => { setConfirmingDelete(false); setError(''); }}>Keep Schedule</button><button className="button-danger" type="button" disabled={saving} onClick={() => void remove()}>{saving ? 'Deleting…' : 'Confirm Delete'}</button></>
        : <><button className="patient-primary" type="submit" disabled={saving || conflict}>{saving ? 'Saving…' : 'Save Schedule'}</button><button type="button" disabled={saving} onClick={close}>Cancel</button>{currentSchedule && <button className="overlay-delete" type="button" aria-label="Delete Schedule" title="Delete Schedule" disabled={saving} onClick={() => { setConfirmingDelete(true); setError(''); }}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6m4-6v6" /></svg><span className="delete-label">Delete Schedule</span></button>}</>}>
      {confirmingDelete ? <div className="delete-summary"><p>{currentSchedule?.kind === 'recurring'
        ? 'This removes the entire recurring schedule and all its rescheduled sessions.'
        : currentSchedule?.replaces_schedule_id ? 'This removes the replacement and restores the original recurring session, provided it does not overlap another session.' : 'This removes this single treatment session.'}</p><p>This cannot be undone. This changes treatment requirements, not transport bookings.</p></div> : <>
      {currentSchedule && currentSchedule.kind !== 'single' && <div className="patient-field scope-field"><label htmlFor="schedule-scope">Apply changes to</label><Dropdown id="schedule-scope" label="Apply changes to" disabled={saving} value={rescheduling ? 'occurrence' : 'series'} onChange={value => open(currentSchedule, value === 'occurrence')} options={[{value:'series',label:'Entire recurring schedule'},{value:'occurrence',label:'One session only'}]} /></div>}
      <fieldset className="patient-form-fields" disabled={saving}>
        {!currentSchedule && <div className="patient-field patient-form-wide"><label className="patient-required" htmlFor="schedule-kind">Schedule type</label><Dropdown id="schedule-kind" label="Schedule type" required disabled={saving} value={draft.kind} onChange={value => setDraft({ ...draft, kind: value as Details['kind'], days: [], effective_from: '', effective_to: '' })} options={[{value:'recurring',label:'Recurring'},{value:'single',label:'Single Session'}]} /><p className="treatment-hint">{draft.kind === 'recurring' ? 'Repeats weekly between the effective dates.' : 'Occurs once on the selected date.'}</p></div>}
        {rescheduling && <div className="occurrence-dates patient-form-wide">
          <div className="patient-field">
            {occurrences.needsMonth && <><label htmlFor="occurrence-month">Show sessions in</label><input id="occurrence-month" type="month" min={rescheduling.effective_from.slice(0,7)} max={rescheduling.effective_to.slice(0,7)} value={occurrences.month} onChange={event => {
              setOccurrenceMonth(event.target.value); setOriginalDate(''); setError('');
              if (draft.effective_from === originalDate) setDraft({ ...draft, effective_from: '', effective_to: '', days: [] });
            }} /></>}
            <label className="patient-required" htmlFor="original-session-date">Session to change</label>
            <Dropdown id="original-session-date" label="Session to change" required disabled={saving} value={originalDate} placeholder="Choose a session"
              onChange={date => {
                const nextDate = !draft.effective_from || draft.effective_from === originalDate ? date : draft.effective_from;
                setOriginalDate(date); setError('');
                setDraft({ ...draft, effective_from: nextDate, effective_to: nextDate, days: nextDate ? [dayFor(nextDate)] : [] });
              }} options={occurrences.dates.map(date => ({value:date,label:formatDayDate(date)}))} />
            <p className="treatment-hint">{occurrences.dates.length ? `Available ${weekdays[rescheduling.days[0]-1]} sessions at ${rescheduling.start_time.slice(0,5)}. Already moved sessions are excluded.` : 'No unchanged sessions are available in this period.'}</p>
          </div>
          <div className="patient-field"><label className="patient-required" htmlFor="new-session-date">New session date</label><input id="new-session-date" type="date" required value={draft.effective_from} onChange={event => setDraft({ ...draft, effective_from: event.target.value, effective_to: event.target.value, days: event.target.value ? [dayFor(event.target.value)] : [] })} /><p className="treatment-hint">Keep the date to change only the time or centre.</p></div>
        </div>}
        <div className="patient-field patient-form-wide"><CentrePicker centres={data?.centres ?? []} value={draft.centre_id} onChange={centre_id => setDraft({ ...draft, centre_id })} disabled={saving} /><p className="treatment-hint">Centre not listed? Contact your Transport Coordinator.</p></div>
        <div className="patient-field patient-form-wide"><label htmlFor="treatment-address">Centre address</label><textarea id="treatment-address" rows={2} disabled placeholder="Select a centre to view its address" value={selectedCentre ? `${selectedCentre.address}, Singapore ${selectedCentre.postal_code}` : ''} /></div>
        {draft.kind === 'recurring' ? <div className="patient-field patient-form-wide"><label className="patient-required" htmlFor="treatment-day">Treatment day</label><Dropdown id="treatment-day" label="Treatment day" required disabled={saving} value={draft.days[0] ? String(draft.days[0]) : ''} placeholder="Select a day" onChange={value => setDraft({ ...draft, days: [Number(value)] })} options={weekdays.map((label,index) => ({value:String(index+1),label}))} /></div>
          : !rescheduling && <div className="patient-field patient-form-wide"><label className="patient-required" htmlFor="single-session-date">Session date</label><input id="single-session-date" type="date" required value={draft.effective_from} onChange={event => setDraft({ ...draft, effective_from: event.target.value, effective_to: event.target.value, days: event.target.value ? [dayFor(event.target.value)] : [] })} /></div>}
        <div className="patient-field"><label className="patient-required" htmlFor="treatment-start">Session start</label><input id="treatment-start" type="time" required value={draft.start_time} onChange={e => setDraft({ ...draft, start_time: e.target.value })} /></div>
        <div className="patient-field"><label className="patient-required" htmlFor="treatment-end">Session end</label><input id="treatment-end" type="time" required value={draft.end_time} onChange={e => setDraft({ ...draft, end_time: e.target.value })} /></div>
        {draft.kind === 'recurring' && <><div className="patient-field"><label className="patient-required" htmlFor="treatment-from">Effective from</label><input id="treatment-from" type="date" required value={draft.effective_from} onChange={e => setDraft({ ...draft, effective_from: e.target.value })} /></div>
        <div className="patient-field"><label className="patient-required" htmlFor="treatment-to">Effective to</label><input id="treatment-to" type="date" required min={draft.effective_from} value={draft.effective_to} onChange={e => setDraft({ ...draft, effective_to: e.target.value })} /></div></>}
      </fieldset>

      </>}
    </Overlay>}
    {historySchedule && <Overlay title="Rescheduled sessions" description={`Every ${historySchedule.days.map(day => weekdays[day-1]).join(', ')}`} onClose={() => setHistorySchedule(null)} footer={<button type="button" onClick={() => setHistorySchedule(null)}>Close</button>}>
      <ul className="reschedule-history">{(replacements.get(historySchedule.id) ?? []).map(session => <li key={session.id}><dl><div><dt>Original session</dt><dd>{session.replaces_date && formatDayDate(session.replaces_date)}</dd></div><div><dt>Rescheduled to</dt><dd>{formatDayDate(session.effective_from)}<br />{session.start_time.slice(0,5)} - {session.end_time.slice(0,5)}</dd></div></dl><p>{data?.centres.find(centre => centre.id === session.centre_id)?.name}</p></li>)}</ul>
    </Overlay>}
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
