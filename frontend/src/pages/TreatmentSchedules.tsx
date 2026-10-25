import { planningWindow } from '../lib/planningWindow';
import TreatmentChangeDialog, { type TreatmentChangeRequest } from '../components/TreatmentChangeDialog';
import { Dropdown } from '../components/Dropdown';
import { InfoButton, Overlay, PageHeading, ListToolbar, ListPagination, ChoiceGroup, SortOverlay, ListError, ScheduleActionIcon, sortSummary } from '../components/DashboardUI';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ApiError, apiGet, apiRequest } from '../lib/api';
import { singaporeToday } from './TripsPage';

interface Centre { id: string; name: string; address: string; postal_code: string }
interface Details { kind: 'recurring' | 'single'; centre_id: string; days: number[]; start_time: string; end_time: string; effective_from: string; effective_to: string }
interface TripCoverage { generated_ranges?: { from_date: string; until_date: string }[]; status: 'not_generated' | 'partial' | 'generated' | 'none' | 'unavailable'; through: string | null; window_start?: string; window_end?: string; expected_sessions?: number; generated_sessions?: number }
interface AutoGeneration { enabled: boolean; version: number; last_run_at?: string | null; last_error?: string | null }
interface Schedule extends Omit<Details, 'kind'> { change_request?: TreatmentChangeRequest | null; auto_generation?: AutoGeneration; trip_generation?: TripCoverage; kind?: 'recurring' | 'single'; id: string; version: number; patient_id: string; patients: { full_name: string }; replaces_schedule_id?: string | null; replaces_date?: string | null }
interface Data { centres: Centre[]; schedules: Schedule[]; context: Schedule[]; total: number; page: number; pageSize: number }
const scheduleIcon = <span className="dashboard-data-status-icon" aria-hidden="true"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="5" width="16" height="16" rx="3" /><path d="M8 3v4m8-4v4M4 11h16m-10 4 4 4m0-4-4 4" /></svg></span>;
const scheduleSortOptions = [{ value: 'effective_from', label: 'Start date', ascending: 'Earliest first', descending: 'Latest first' }, { value: 'start_time', label: 'Treatment time', ascending: 'Earliest time first', descending: 'Latest time first' }, { value: 'patient_name', label: 'Patient name' }, { value: 'centre_name', label: 'Dialysis centre' }, { value: 'kind', label: 'Schedule type', ascending: 'Recurring → Rescheduled → Single Session', descending: 'Single Session → Rescheduled → Recurring' }];
const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const coalesceRoot = (schedule: Schedule) => schedule.replaces_schedule_id ?? schedule.id;
const blank = (): Details => ({ kind: 'recurring', centre_id: '', days: [], start_time: '', end_time: '', effective_from: '', effective_to: '' });
const dayFor = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
const supportedDate = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date) && !date.startsWith('0000') && Number.isFinite(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0,10) === date;
const formatDayDate = (date: string) => !supportedDate(date) ? 'Invalid date' : new Intl.DateTimeFormat('en-SG', { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Singapore' }).format(new Date(`${date}T00:00:00+08:00`));
const formatDate = (date: string) => !supportedDate(date) ? 'Invalid date' : new Intl.DateTimeFormat('en-SG', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Singapore' }).format(new Date(`${date}T00:00:00+08:00`));

function GenerationStatus({ coverage }: { coverage?: TripCoverage }) {
  const status = coverage?.status ?? 'unavailable';
  const label = status === 'generated' ? 'Generated'
    : status === 'partial' ? 'Partially generated' : status === 'not_generated' ? 'Not generated'
    : status === 'none' ? 'No sessions in window' : 'Coverage unavailable';
  const window = coverage?.window_start && coverage.window_end ? `Coverage: ${formatDate(coverage.window_start)} – ${formatDate(coverage.window_end)}.` : 'Trip coverage could not be determined.';
  return <div className="treatment-generation"><span className="treatment-generation-label">Trips</span><div className="treatment-generation-summary"><span className={`treatment-generation-badge generation-${status}`} title={window}>{label}</span></div></div>;
}

function GeneratedCoverage({ coverage }: { coverage?: TripCoverage }) {
  const ranges = coverage?.generated_ranges;
  return <section className="generation-coverage" aria-label="Generated trip coverage"><h3>Trips already generated</h3>
    {ranges?.length ? <ul>{ranges.map(range => <li key={range.from_date}>{range.from_date === range.until_date ? formatDate(range.from_date) : `${formatDate(range.from_date)} – ${formatDate(range.until_date)}`}</li>)}</ul>
      : <p>{coverage?.status === 'not_generated' || coverage?.status === 'none' ? '—' : ranges ? 'Some trips are generated, but coverage is incomplete.' : 'Generated dates unavailable.'}</p>}
  </section>;
}

export default function TreatmentSchedules({ coordinator, notify, onSessionExpired }: {
  coordinator: boolean; notify: (message: string) => void; onSessionExpired: () => void;
}) {
  const [data, setData] = useState<Data | null>(null);
  const [viewingSchedule, setViewingSchedule] = useState<Schedule | null>(null);
  const [changingSchedule, setChangingSchedule] = useState<Schedule | null>(null);
  const [reload, setReload] = useState(0);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [generatingSchedule, setGeneratingSchedule] = useState<Schedule | null>(null);
  const [generationDates, setGenerationDates] = useState({ from: '', until: '' });
  const [generating, setGenerating] = useState(false);
  const [savingAutoGeneration, setSavingAutoGeneration] = useState(false);
  const quietReload = useRef(false);
  const [generationError, setGenerationError] = useState('');
  const [generationConflict, setGenerationConflict] = useState(false);
  const [autoGenerationDraft, setAutoGenerationDraft] = useState(false);
  const [filters, setFilters] = useState({ page: 1, search: '', kind: 'all', centre: 'all', sort: 'effective_from', order: 'asc' });
  const [sorting, setSorting] = useState(false);
  const [filterDraft, setFilterDraft] = useState<{ kind: string; centre: string } | null>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => setFilters(current => current.search === search.trim() ? current : {...current,page:1,search:search.trim()}),300);
    return () => window.clearTimeout(timer);
  },[search]);
  const searchTerm = filters.search;
  const visibleSchedules = data?.schedules ?? [];
  const context = useMemo(() => [...new Map([...(data?.schedules ?? []),...(data?.context ?? [])].map(schedule => [schedule.id,schedule])).values()],[data]);
  useEffect(() => {
    if (!data || loading) return;
    const lastPage=Math.max(1,Math.ceil((data.total ?? data.schedules.length)/(data.pageSize ?? 10)));
    if (filters.page>lastPage) setFilters(current => ({...current,page:lastPage}));
  },[data,filters.page,loading]);
  const [draft, setDraft] = useState<Details | null>(null);
  const [confirmingCreate, setConfirmingCreate] = useState(false);
  const selectedCentre = data?.centres.find(centre => centre.id === draft?.centre_id);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const alive = useRef(false);
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
  const addButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    let active = true;
    const quiet = quietReload.current;
    quietReload.current = false;
    if (!quiet) setLoading(true);
    setError('');
    apiGet<Data>(`/schedules?${new URLSearchParams({...filters,page:String(filters.page)})}`).then(result => { if (active) { setData(result); setGeneratingSchedule(current => current ? result.schedules.find(schedule => schedule.id === current.id) ?? current : null); } })
      .catch(reason => { if (active) { if (reason instanceof ApiError && reason.status === 401) onSessionExpired(); if (quiet) { notify('Changes saved, but schedules could not be refreshed. Please reload the page.'); } else setError('Treatment schedules could not be loaded. Please try again.'); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [reload, onSessionExpired, filters]);
  function open() { setDraft(blank()); setConfirmingCreate(false); setError(''); }
  function close() { setDraft(null); setConfirmingCreate(false); setError(''); }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft || saving) return;
    if (!draft.centre_id || !supportedDate(draft.effective_from) || !draft.start_time || !draft.end_time || (draft.kind === 'recurring' && (draft.days.length !== 1 || !supportedDate(draft.effective_to) || draft.effective_to < draft.effective_from)) || draft.end_time <= draft.start_time) { setError('Check the centre, dates and session times.'); return; }
    if (draft.kind === 'recurring') {
      const first = Date.parse(draft.effective_from) + ((draft.days[0] - dayFor(draft.effective_from) + 7) % 7) * 86400000;
      if (first > Date.parse(draft.effective_to)) { setError('Choose a date range that includes the selected treatment day.'); return; }
    }
    if (!confirmingCreate) { setConfirmingCreate(true); setError(''); return; }
    const payload = draft.kind === 'single' ? { kind: draft.kind, centre_id: draft.centre_id, session_date: draft.effective_from, start_time: draft.start_time, end_time: draft.end_time } : draft;
    setSaving(true); setError('');
    try {
      await apiRequest('/schedules', 'POST', payload);
      if (!alive.current) return;
      close(); notify('Treatment schedule created.'); setReload(value => value + 1);
    } catch (reason) {
      if (!alive.current) return;
      if (reason instanceof ApiError && reason.status === 401) onSessionExpired();
      setError(reason instanceof ApiError && reason.status === 400 ? 'Check the dates, times and existing sessions for conflicts.' : 'The schedule could not be created. Please try again.');
    } finally { if (alive.current) setSaving(false); }
  }
  function requestChanged(request: TreatmentChangeRequest, message: string) {
    setChangingSchedule(null); setViewingSchedule(null);
    setData(current => current && ({ ...current, schedules: current.schedules.map(schedule =>
      coalesceRoot(schedule) === request.root_schedule_id ? { ...schedule, change_request: request.status === 'pending' || schedule.id === request.schedule_id ? request : null } : schedule) }));
    quietReload.current = true; setReload(value => value + 1); notify(message);
  }
  function openGeneration(schedule: Schedule) {
    const { today, end } = planningWindow();
    const from = schedule.effective_from > today && schedule.effective_from <= end ? schedule.effective_from : today;
    setGeneratingSchedule(schedule); setGenerationError(''); setGenerationConflict(false);
    setAutoGenerationDraft(schedule.auto_generation?.enabled ?? false);
    const until = schedule.kind === 'single' && schedule.effective_from === from ? from : schedule.effective_to >= from && schedule.effective_to < end ? schedule.effective_to : end;
    setGenerationDates({ from, until });
  }
  async function reloadGeneration() {
    if (!generatingSchedule || generating || savingAutoGeneration) return;
    setGenerating(true);
    try {
      const result = await apiGet<Data>(`/schedules?${new URLSearchParams({ ...filters, page: String(filters.page) })}`);
      if (!alive.current) return;
      setData(result);
      const latest = [...result.schedules, ...(result.context ?? [])].find(schedule => schedule.id === generatingSchedule.id);
      if (!latest) { setGenerationError('This schedule is no longer available. Close and choose another schedule.'); return; }
      setGeneratingSchedule(latest); setAutoGenerationDraft(latest.auto_generation?.enabled ?? false); setGenerationConflict(false); setGenerationError('');
    } catch (reason) {
      if (!alive.current) return;
      if (reason instanceof ApiError && reason.status === 401) onSessionExpired();
      setGenerationError('Schedules could not be reloaded. Please try again.');
    } finally { if (alive.current) setGenerating(false); }
  }
  async function saveAutoGeneration() {
    if (!generatingSchedule || generating || savingAutoGeneration || generationConflict) return;
    const enabled = autoGenerationDraft;
    setSavingAutoGeneration(true); setGenerationError('');
    try {
      const setting = await apiRequest<AutoGeneration>(`/schedules/${generatingSchedule.id}/auto-generation`, 'PATCH', {
        enabled, version: generatingSchedule.version, setting_version: generatingSchedule.auto_generation?.version ?? 0,
      });
      if (!alive.current) return;
      setGeneratingSchedule(current => current && ({ ...current, auto_generation: setting }));
      setAutoGenerationDraft(setting.enabled);
      setData(current => current && ({ ...current, schedules: current.schedules.map(schedule =>
        schedule.id === generatingSchedule.id || schedule.replaces_schedule_id === generatingSchedule.id ? { ...schedule, auto_generation: setting } : schedule) }));
      quietReload.current = true;
      setReload(value => value + 1);
      notify(enabled ? 'Automatic trip generation enabled.' : 'Automatic trip generation disabled. Existing trips kept.');
    } catch (reason) {
      if (!alive.current) return;
      if (reason instanceof ApiError && reason.status === 401) onSessionExpired();
      if (reason instanceof ApiError && [404, 409].includes(reason.status)) {
        setGenerationConflict(true); setGenerationError('This schedule or setting changed. Reload schedules before trying again.');
      } else setGenerationError('Automatic generation could not be updated. Please try again.');
    } finally { if (alive.current) setSavingAutoGeneration(false); }
  }
  async function generateTrips(event: FormEvent) {
    event.preventDefault();
    if (!generatingSchedule || generating || savingAutoGeneration || generationConflict) return;
    const { from, until } = generationDates;
    if (!supportedDate(from) || !supportedDate(until) || from < singaporeToday() || until < from || until > planningWindow().end) { setGenerationError('Choose dates from today through the fourth Sunday.'); return; }
    setGenerating(true); setGenerationError('');
    try {
      const result = await apiRequest<{ created: number; updated: number; unchanged: number; skipped?: number; total: number }>('/trips/generate', 'POST', { schedule_id: generatingSchedule.id, from_date: from, until_date: until, version: generatingSchedule.version });
      if (!alive.current) return;
      setGeneratingSchedule(null); setReload(value => value + 1);
      notify(`Trips generated: ${result.created} created, ${result.updated} updated, ${result.unchanged} unchanged (${result.total} total). No duplicate trips created.`);
    } catch (reason) {
      if (!alive.current) return;
      if (reason instanceof ApiError && reason.status === 401) onSessionExpired();
      if (reason instanceof ApiError && reason.status === 409) { setGenerationConflict(true); setGenerationError('This schedule changed. Reload schedules before generating again.'); }
      else setGenerationError(reason instanceof ApiError && reason.status === 400 ? 'Check the selected schedule and dates before trying again.' : 'Trips could not be generated. Please try again.');
    } finally { if (alive.current) setGenerating(false); }
  }
  return <section className="dashboard-trips treatment-panel page-panel" aria-labelledby="treatment-title" aria-busy={loading}>
    <PageHeading id="treatment-title" title={coordinator ? "Treatment Schedule List" : "Treatment Schedules"} eyebrow={coordinator ? "Schedule Management" : "Treatment planning"}
      actions={<><ListToolbar search={search} onSearch={setSearch} label="Search treatment schedules" placeholder={coordinator ? 'Patient or schedule details' : 'Centre, day, date or type'} filterCount={Number(filters.kind !== 'all') + Number(filters.centre !== 'all')} onFilter={() => setFilterDraft({ kind: filters.kind, centre: filters.centre })} onSort={() => setSorting(true)} sortLabel={sortSummary(scheduleSortOptions, filters.sort, filters.order)} />{!coordinator && <button ref={addButton} className="patient-primary schedule-icon-action schedule-add-action" type="button" aria-label="Add Schedule" title="Add Schedule" disabled={loading || !data?.centres.length} onClick={() => open()}><ScheduleActionIcon action="add" /></button>}</>} />
    {loading ? <div className="account-loading" role="status"><span className="account-spinner" aria-hidden="true" /><span>Loading...</span></div> : <>
      {error && !draft ? <ListError title="Schedules could not be loaded" message="Please try again to load your treatment schedules." onRetry={() => setReload(value => value+1)} /> : <>
        {!data?.centres.length && <div className="dashboard-data-status patients-status" role="status">{scheduleIcon}<div><h3>No dialysis centres are available.</h3><p>{coordinator ? 'The dialysis centre directory has not been loaded yet.' : 'Contact your Transport Coordinator.'}</p></div></div>}
        {(data?.total ?? data?.schedules.length) === 0 ? (data?.centres.length ?? 0) > 0 && <div className="dashboard-data-status patients-status" role="status">{scheduleIcon}<div><h3>{searchTerm || filters.kind !== 'all' || filters.centre !== 'all' ? 'No matching schedules.' : 'No treatment schedules yet.'}</h3><p>{searchTerm || filters.kind !== 'all' || filters.centre !== 'all' ? 'Try another search or change the filters.' : coordinator ? 'Patient treatment schedules will appear here once submitted.' : 'Add your treatment schedule to share your dialysis requirements.'}</p></div></div> : searchTerm && visibleSchedules.length === 0 ? <div className="dashboard-data-status patients-status" role="status">{scheduleIcon}<div><h3>No matching schedules.</h3><p>{coordinator ? 'Try another patient name, ID, centre, day, date or schedule type.' : 'Try another centre, day, date or schedule type.'}</p></div></div> : <div className="treatment-records panel-scroll" tabIndex={0} role="region" aria-label="Treatment schedules">{visibleSchedules.map((schedule, index) => <article className={`treatment-record${schedule.change_request?.status === 'pending' ? ' treatment-change-pending' : ''}`} key={schedule.id}>
          <div className={`treatment-summary${coordinator ? ' treatment-summary-coordinator' : ''}`}>
            <div className="treatment-identity"><p>{schedule.patients.full_name}</p><div className="treatment-badges"><p className={`treatment-kind treatment-kind-${schedule.replaces_schedule_id ? 'rescheduled' : schedule.kind ?? 'recurring'}`}>{schedule.replaces_schedule_id ? 'Rescheduled Session' : schedule.kind === 'single' ? 'Single Session' : 'Recurring'}</p>{schedule.change_request && ['pending','rejected'].includes(schedule.change_request.status) && <button className={`treatment-change-badge change-${schedule.change_request.status}`} type="button" onClick={() => setChangingSchedule(schedule)}>{schedule.change_request.status === 'pending' ? 'Changes pending' : 'Changes rejected'}</button>}</div></div>
            <div className="treatment-session"><h2>{schedule.kind === 'single' ? formatDayDate(schedule.effective_from) : `Every ${schedule.days.map(day => weekdays[day-1]).join(', ')}`}</h2>{schedule.kind === 'single' ? <p className="treatment-time">{schedule.start_time.slice(0,5)}–{schedule.end_time.slice(0,5)}</p> : <p className="treatment-session-meta"><span>{formatDate(schedule.effective_from)} – {formatDate(schedule.effective_to)}</span><span className="treatment-session-clock"><span aria-hidden="true">·</span><span>{schedule.start_time.slice(0,5)}–{schedule.end_time.slice(0,5)}</span></span></p>}
              {schedule.replaces_date && <p className="treatment-date-range">Replaces {formatDate(schedule.replaces_date)}</p>}
              {replacements.has(schedule.id) && <button className="reschedule-summary" type="button" onClick={() => setHistorySchedule(schedule)}>{replacements.get(schedule.id)!.length} rescheduled {replacements.get(schedule.id)!.length === 1 ? 'session' : 'sessions'}</button>}
            </div>
            <div className="treatment-location"><span>Dialysis Centre</span><p>{data?.centres.find(c => c.id === schedule.centre_id)?.name}</p></div>
            {coordinator && <GenerationStatus coverage={schedule.trip_generation} />}
          </div>
          <div className="schedule-record-info">{coordinator && schedule.change_request?.status === 'pending' ? <button className="list-info-control schedule-icon-action" type="button" aria-label="Review schedule change" title="Review changes" onClick={() => setChangingSchedule(schedule)}><ScheduleActionIcon action="edit" /></button> : <InfoButton label="View schedule details" onClick={() => setViewingSchedule(schedule)} />}</div>
          <div className="patient-actions schedule-record-actions">{coordinator && <button className="list-info-control schedule-generate schedule-icon-action" type="button" aria-label="Generate Trips" title="Generate Trips" disabled={!schedule.version || !supportedDate(schedule.effective_from) || (schedule.kind === 'single' && schedule.effective_from < singaporeToday())} onClick={() => openGeneration(schedule)}><ScheduleActionIcon action="generate" /></button>}{!coordinator && <button className="list-info-control schedule-icon-action" type="button" aria-label={schedule.change_request?.status === 'pending' ? 'View change request' : 'Request schedule change'} title={schedule.change_request?.status === 'pending' ? 'View request' : 'Request changes'} onClick={() => setChangingSchedule(schedule)}><ScheduleActionIcon action="edit" /></button>}</div>
          <span className="record-number" title="Row number">{((data?.page ?? filters.page) - 1) * (data?.pageSize ?? 10) + index + 1}</span>
        </article>)}</div>}
      </>}
    </>}
    {(!error || !!draft) && <ListPagination label="Schedule pages" page={filters.page} disabled={loading || !!error || search.trim() !== filters.search} hasNext={!!data && filters.page * (data.pageSize ?? 10) < (data.total ?? visibleSchedules.length)} onPageChange={page => setFilters(current => ({ ...current, page }))}>{data ? <>{data.total ?? visibleSchedules.length} {(data.total ?? visibleSchedules.length)===1 ? 'schedule' : 'schedules'} · Page {filters.page} of {Math.max(1,Math.ceil((data.total ?? visibleSchedules.length)/(data.pageSize ?? 10)))}</> : loading ? 'Loading...' : 'Schedule count unavailable'}</ListPagination>}
    {sorting && <SortOverlay sort={filters.sort} order={filters.order} options={scheduleSortOptions.filter(option => coordinator || option.value !== 'patient_name')} defaultSort="effective_from" defaultOrder="asc" onClose={() => setSorting(false)} onApply={(sort, order) => { setFilters(current => ({ ...current, page: 1, sort, order })); setSorting(false); }} />}
    {filterDraft && <Overlay title="Schedule filters" description="Choose the schedules to show." className="list-options-dialog" onClose={() => setFilterDraft(null)} onSubmit={event => { event.preventDefault(); setFilters(current => ({ ...current, ...filterDraft, page: 1 })); setFilterDraft(null); }}
      footer={<><button className="patient-primary" type="submit">Apply Filters</button><button type="button" onClick={() => setFilterDraft({ kind: 'all', centre: 'all' })}>Reset</button><button type="button" onClick={() => setFilterDraft(null)}>Cancel</button></>}>
      <ChoiceGroup label="Schedule type" multiple value={filterDraft.kind} options={[ { value: 'recurring', label: 'Recurring' }, { value: 'single', label: 'Single Session' }, { value: 'rescheduled', label: 'Rescheduled Session' }]} onChange={kind => setFilterDraft(current => current && ({ ...current, kind }))} />
      <div className="patient-field"><label htmlFor="schedule-filter-centre">Dialysis centre</label><Dropdown id="schedule-filter-centre" label="Dialysis centre" searchable value={filterDraft.centre} options={[{ value: 'all', label: 'All centres' }, ...(data?.centres ?? []).map(centre => ({ value: centre.id, label: centre.name }))]} onChange={centre => setFilterDraft(current => current && ({ ...current, centre }))} /></div>
    </Overlay>}
    {viewingSchedule && <Overlay title="Schedule details" description={viewingSchedule.patients.full_name} onClose={() => setViewingSchedule(null)} footer={<>{(!coordinator || viewingSchedule.change_request?.status === 'pending') && <button className="patient-primary" type="button" onClick={() => { setChangingSchedule(viewingSchedule); setViewingSchedule(null); }}>{coordinator ? 'Review changes' : viewingSchedule.change_request?.status === 'pending' ? 'View request' : 'Request changes'}</button>}<button type="button" aria-label="Close Schedule details" onClick={() => setViewingSchedule(null)}>Close</button></>}>
      <dl className="schedule-detail-fields">
        {coordinator && <div><dt>Patient ID</dt><dd>{viewingSchedule.patient_id}</dd></div>}
        <div><dt>Schedule</dt><dd>{viewingSchedule.kind === 'single' ? formatDayDate(viewingSchedule.effective_from) : `Every ${viewingSchedule.days.map(day => weekdays[day - 1]).join(', ')}`}</dd></div>
        <div><dt>Treatment</dt><dd>{viewingSchedule.start_time.slice(0, 5)} - {viewingSchedule.end_time.slice(0, 5)}</dd></div>
        {viewingSchedule.kind !== 'single' && <div><dt>Date range</dt><dd>{formatDate(viewingSchedule.effective_from)} - {formatDate(viewingSchedule.effective_to)}</dd></div>}
        <div><dt>Dialysis centre</dt><dd>{data?.centres.find(centre => centre.id === viewingSchedule.centre_id)?.name ?? 'Unavailable'}</dd></div>
        {data?.centres.find(centre => centre.id === viewingSchedule.centre_id)?.address && <div><dt>Address</dt><dd>{data.centres.find(centre => centre.id === viewingSchedule.centre_id)?.address}</dd></div>}
        {viewingSchedule.replaces_date && <div><dt>Rescheduled from</dt><dd>{formatDate(viewingSchedule.replaces_date)}</dd></div>}
      </dl>
      {!coordinator && <p className="treatment-hint">Changes to this schedule require coordinator approval.</p>}
    </Overlay>}
    {changingSchedule && <TreatmentChangeDialog source={changingSchedule} existing={changingSchedule.change_request} coordinator={coordinator} name={changingSchedule.patients.full_name} centres={data?.centres ?? []} onClose={() => setChangingSchedule(null)} onChanged={requestChanged} onSessionExpired={onSessionExpired} />}
    {generatingSchedule && coordinator && <Overlay title="Generate Trips" description="Create outbound and return trips." className="trip-generation-dialog" busy={generating || savingAutoGeneration} onClose={() => setGeneratingSchedule(null)} onSubmit={generateTrips} noValidate error={generationError} onDismissError={() => setGenerationError('')}
      footer={<><button className="patient-primary" type={generationConflict ? 'button' : 'submit'} disabled={generating || savingAutoGeneration} onClick={generationConflict ? () => void reloadGeneration() : undefined}>{generating ? 'Loading…' : generationConflict ? 'Reload schedules' : 'Generate Trips'}</button><button type="button" disabled={generating || savingAutoGeneration} onClick={() => setGeneratingSchedule(null)}>Close</button></>}>
      <section className="generation-summary" aria-label="Treatment schedule">
        <div className="generation-patient"><h3>{generatingSchedule.patients.full_name}</h3><span className={`generation-kind generation-kind-${generatingSchedule.replaces_schedule_id ? 'rescheduled' : generatingSchedule.kind ?? 'recurring'}`}>{generatingSchedule.replaces_schedule_id ? 'Rescheduled' : generatingSchedule.kind === 'single' ? 'Single Session' : 'Recurring'}</span></div>
        <p className="generation-patient-id">Patient ID: {generatingSchedule.patient_id}</p>
        <p className="generation-session">{generatingSchedule.kind === 'single' ? formatDayDate(generatingSchedule.effective_from) : `Every ${generatingSchedule.days.map(day => weekdays[day-1]).join(', ')}`} · {generatingSchedule.start_time.slice(0,5)}–{generatingSchedule.end_time.slice(0,5)}</p>
        <dl><div><dt>Dialysis centre</dt><dd>{data?.centres.find(centre => centre.id === generatingSchedule.centre_id)?.name}</dd></div></dl>
      </section>
      <div className="generation-settings">
      <section className="generation-automatic" aria-label="Automatic trip generation">
        {generatingSchedule.replaces_schedule_id ? <p className="treatment-hint">Automatic generation is managed by the original recurring schedule.</p>
          : <div className="generation-auto-row"><label className="generation-auto-toggle"><span>Auto-generate trips</span><input type="checkbox" role="switch" aria-describedby="generation-auto-hint" checked={autoGenerationDraft} disabled={generating || savingAutoGeneration || generationConflict} onChange={event => setAutoGenerationDraft(event.target.checked)} /></label>
            {autoGenerationDraft !== (generatingSchedule.auto_generation?.enabled ?? false) && <button className="generation-auto-save" type="button" aria-label="Save" title="Save automatic generation setting" aria-busy={savingAutoGeneration} disabled={generating || savingAutoGeneration || generationConflict} onClick={() => void saveAutoGeneration()}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12l4 4v12a2 2 0 0 1-2 2Z" /><path d="M7 3v6h10V3M7 21v-8h10v8" /></svg></button>}
          </div>}
        {!generatingSchedule.replaces_schedule_id && <p className="treatment-hint" id="generation-auto-hint">Deleted trips won’t be regenerated automatically.</p>}
        {generatingSchedule.auto_generation?.last_error && <p className="generation-auto-error" role="status">The last automatic run failed. Switch off and on to retry.</p>}
      </section>
      <GeneratedCoverage coverage={generatingSchedule.trip_generation} />
      </div>
      <p className="treatment-hint">Generation window: {formatDate(singaporeToday())} – {formatDate(planningWindow().end)}</p>
      <fieldset className="patient-form-fields trip-generation-dates" disabled={generating}><div className="patient-field"><label className="patient-required" htmlFor="generation-from">From date</label><input id="generation-from" required type="date" min={singaporeToday()} max={generationDates.until < planningWindow().end ? generationDates.until : planningWindow().end} value={generationDates.from} onChange={event => setGenerationDates(current => ({ ...current, from: event.target.value }))} /></div><div className="patient-field"><label className="patient-required" htmlFor="generation-until">Until date</label><input id="generation-until" required type="date" min={generationDates.from} max={planningWindow().end} value={generationDates.until} onChange={event => setGenerationDates(current => ({ ...current, until: event.target.value }))} /></div></fieldset>
      <dl className="generation-timing"><div><dt>Outbound arrival</dt><dd>15 min before session starts</dd></div><div><dt>Return pickup</dt><dd>15+ min after session ends</dd></div></dl>
    </Overlay>}
    {draft && !coordinator && <Overlay title={confirmingCreate ? 'Confirm treatment schedule' : 'Add Schedule'} className={confirmingCreate ? 'schedule-create-confirmation' : undefined} description={confirmingCreate ? 'Double-check your details before creating this schedule.' : undefined} onClose={close} onSubmit={save} busy={saving} noValidate error={error} onDismissError={() => setError('')}
      footer={<><button className="patient-primary" type="submit" disabled={saving}>{saving ? 'Creating…' : 'Create Schedule'}</button><button type="button" disabled={saving} onClick={confirmingCreate ? () => { setConfirmingCreate(false); setError(''); } : close}>{confirmingCreate ? 'Back' : 'Cancel'}</button></>}>
      {confirmingCreate ? <>
        <p className="schedule-create-warning">Once created, any changes, rescheduling or deletion require coordinator approval, whether or not trips have been generated.</p>
        <dl className="schedule-detail-fields">
          <div><dt>Schedule</dt><dd>{draft.kind === 'single' ? 'Single Session' : `Every ${draft.days.map(day => weekdays[day - 1]).join(', ')}`}</dd></div>
          <div><dt>{draft.kind === 'single' ? 'Session date' : 'Date range'}</dt><dd>{draft.kind === 'single' ? formatDate(draft.effective_from) : `${formatDate(draft.effective_from)} – ${formatDate(draft.effective_to)}`}</dd></div>
          <div><dt>Treatment</dt><dd>{draft.start_time} – {draft.end_time}</dd></div>
          <div><dt>Dialysis centre</dt><dd>{selectedCentre?.name}</dd></div>
        </dl>
      </> : (
      <fieldset className="patient-form-fields" disabled={saving}>
        {<div className="patient-field patient-form-wide"><label className="patient-required" htmlFor="schedule-kind">Schedule type</label><Dropdown id="schedule-kind" label="Schedule type" required disabled={saving} value={draft.kind} onChange={value => setDraft({ ...draft, kind: value as Details['kind'], days: [], effective_from: '', effective_to: '' })} options={[{value:'recurring',label:'Recurring'},{value:'single',label:'Single Session'}]} /><p className="treatment-hint">{draft.kind === 'recurring' ? 'Repeats weekly between the effective dates.' : 'Occurs once on the selected date.'}</p></div>}
        <div className="patient-field patient-form-wide"><CentrePicker centres={data?.centres ?? []} value={draft.centre_id} onChange={centre_id => setDraft({ ...draft, centre_id })} disabled={saving} /><p className="treatment-hint">Centre not listed? Contact your Transport Coordinator.</p></div>
        <div className="patient-field patient-form-wide"><label htmlFor="treatment-address">Centre address</label><textarea id="treatment-address" rows={2} disabled placeholder="Select a centre to view its address" value={selectedCentre ? `${selectedCentre.address}, Singapore ${selectedCentre.postal_code}` : ''} /></div>
        {draft.kind === 'recurring' ? <div className="patient-field patient-form-wide"><label className="patient-required" htmlFor="treatment-day">Treatment day</label><Dropdown id="treatment-day" label="Treatment day" required disabled={saving} value={draft.days[0] ? String(draft.days[0]) : ''} placeholder="Select a day" onChange={value => setDraft({ ...draft, days: [Number(value)] })} options={weekdays.map((label,index) => ({value:String(index+1),label}))} /></div>
          : <div className="patient-field patient-form-wide"><label className="patient-required" htmlFor="single-session-date">Session date</label><input id="single-session-date" type="date" required value={draft.effective_from} onChange={event => setDraft({ ...draft, effective_from: event.target.value, effective_to: event.target.value, days: event.target.value ? [dayFor(event.target.value)] : [] })} /></div>}
        <div className="patient-field"><label className="patient-required" htmlFor="treatment-start">Session start</label><input id="treatment-start" type="time" required value={draft.start_time} onChange={e => setDraft({ ...draft, start_time: e.target.value })} /></div>
        <div className="patient-field"><label className="patient-required" htmlFor="treatment-end">Session end</label><input id="treatment-end" type="time" required value={draft.end_time} onChange={e => setDraft({ ...draft, end_time: e.target.value })} /></div>
        {draft.kind === 'recurring' && <><div className="patient-field"><label className="patient-required" htmlFor="treatment-from">Effective from</label><input id="treatment-from" type="date" required value={draft.effective_from} onChange={e => setDraft({ ...draft, effective_from: e.target.value })} /></div>
        <div className="patient-field"><label className="patient-required" htmlFor="treatment-to">Effective to</label><input id="treatment-to" type="date" required min={draft.effective_from} value={draft.effective_to} onChange={e => setDraft({ ...draft, effective_to: e.target.value })} /></div></>}
      </fieldset>
      )}
    </Overlay>}
    {historySchedule && <Overlay title="Rescheduled sessions" description={`Every ${historySchedule.days.map(day => weekdays[day-1]).join(', ')}`} onClose={() => setHistorySchedule(null)}>
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
