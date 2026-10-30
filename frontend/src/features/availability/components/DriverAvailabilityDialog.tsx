import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ApiError, apiGet } from '../../../shared/lib/api';
import { planningWindow, planningDateOffset } from '../lib/planningWindow';
import { ListError, Overlay } from '../../../shared/ui/DashboardUI';
import WeeklyAvailabilityView, { useAvailabilityClock, type CalendarTrip } from './WeeklyAvailabilityView';

export interface DriverCalendarSchedule { eligible: boolean; availability: { weekly_slots: number[]; version: number; template_version?: number } | null; trips: CalendarTrip[] }
interface CalendarView { schedule: DriverCalendarSchedule; week: string; driverId: string }
const dateLabel = (value: string) => new Intl.DateTimeFormat('en-SG',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}).format(new Date(`${value}T00:00:00Z`));
const timestamp = (value: string) => new Intl.DateTimeFormat('en-SG',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Singapore'}).format(new Date(value));
/** Dated coordinator inspection overlays actual assignments onto recurring weekly availability. */
export default function DriverAvailabilityDialog({ driverId, name = '', onClose = () => {}, onSessionExpired, own = false, inline = false, weekStart, onWeekChange, refreshKey = 0, onLoad, onLoading, editor }: {
  editor?: { slots: number[]; editable: boolean; onChange: (slots: number[]) => void };
  driverId?: string; name?: string; onClose?: () => void; onSessionExpired: () => void; own?: boolean; inline?: boolean; weekStart?: string; onWeekChange?: (week:string) => void; refreshKey?: number; onLoad?: (schedule:DriverCalendarSchedule, week:string) => void; onLoading?: (loading:boolean) => void;
}) {
  const ownerKey = own ? 'me' : driverId ?? '';
  const callbacks = useRef({onLoad,onLoading,onWeekChange});
  callbacks.current = {onLoad,onLoading,onWeekChange};
  const [view, setView] = useState<{ current: CalendarView | null; previous: CalendarView | null; direction: 'next' | 'previous' }>({ current:null, previous:null, direction:'next' });
  const current = view.current?.driverId === ownerKey ? view.current : null;
  const previous = view.previous?.driverId === ownerKey ? view.previous : null;
  const pane = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({width:0,height:0});
  const [week, setWeek] = useState(() => planningWindow().weekStart);
  const [selected, setSelected] = useState<CalendarTrip | null>(null);
  const [group, setGroup] = useState<CalendarTrip[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const clock = useAvailabilityClock();
  const horizon = planningWindow();
  const requestedWeek = weekStart ?? week;
  const shownWeek = requestedWeek < horizon.weekStart ? horizon.weekStart : requestedWeek > horizon.end ? planningDateOffset(horizon.weekStart,21) : requestedWeek;
  function changeWeek(value: string) { setWeek(value); callbacks.current.onWeekChange?.(value); }
  useEffect(() => { if (requestedWeek!==shownWeek) callbacks.current.onWeekChange?.(shownWeek); },[requestedWeek,shownWeek]);
  useEffect(() => {
    let active = true; let sequence = 0;
    setLoading(true); callbacks.current.onLoading?.(true); setError(false); setSelected(null); setGroup(null);
    async function load() {
      const request = ++sequence;
      try {
        const result = await apiGet<DriverCalendarSchedule>(`/drivers/${ownerKey}/week?${new URLSearchParams({ start:shownWeek })}`);
        if (!active || request !== sequence) return;
        const reduceMotion = globalThis.window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        setView(old => {
          const changed = old.current?.driverId === ownerKey && old.current.week !== shownWeek;
          const next = {schedule:result,week:shownWeek,driverId:ownerKey};
          if (!changed) return {...old,current:next,previous:old.current?.driverId===ownerKey ? old.previous : null};
          return {current:next,previous:!reduceMotion ? old.current : null,direction:old.current && shownWeek < old.current.week ? 'previous' : 'next'};
        });
        setError(false); callbacks.current.onLoad?.(result,shownWeek);
        setSelected(current => current ? result.trips.find(trip => trip.id === current.id) ?? null : null);
        setGroup(current => { const matches = current?.flatMap(item => result.trips.filter(trip => trip.id === item.id)) ?? []; return matches.length ? matches : null; });
      } catch (reason) {
        if (!active || request !== sequence) return;
        if (reason instanceof ApiError && reason.status === 401) onSessionExpired();
        setError(true); setSelected(null); setGroup(null);
      } finally { if (active && request === sequence) { setLoading(false); callbacks.current.onLoading?.(false); } }
    }
    void load();
    const refresh = () => { if (document.visibilityState === 'visible') void load(); };
    const timer = globalThis.window.setInterval(refresh,15000);
    document.addEventListener('visibilitychange',refresh);
    return () => { active = false; globalThis.window.clearInterval(timer); document.removeEventListener('visibilitychange',refresh); };
  }, [ownerKey, shownWeek, retry, refreshKey, onSessionExpired]);
  useLayoutEffect(() => {
    if (!pane.current) return;
    const observer = new ResizeObserver(([entry]) => {
      const {width,height} = entry.contentRect;
      setSize(old => ({width,height:Math.abs(old.width-width)<1 ? Math.max(old.height,height) : height}));
    });
    observer.observe(pane.current);
    return () => observer.disconnect();
  }, [current?.week]);
  useEffect(() => {
    if (!previous) return;
    const timer = globalThis.window.setTimeout(() => setView(old => ({...old,previous:null})),260);
    return () => globalThis.window.clearTimeout(timer);
  }, [previous]);
  function calendar(value: CalendarView) {
    return <>{!value.schedule.eligible && <p className="availability-eligibility" role="status">Not currently eligible for trip assignment.</p>}<WeeklyAvailabilityView slots={editor?.slots ?? value.schedule.availability?.weekly_slots ?? []} editable={editor?.editable} onChange={editor?.onChange} clock={clock} weekStart={value.week} bookings={value.schedule.trips} onBooking={setSelected} onBookingGroup={setGroup} />{!value.schedule.availability && <p className="availability-unavailable">No recurring availability set.</p>}</>;
  }
  const calendarContent = <>
      <div className={`driver-calendar-toolbar${editor ? ' availability-editor-toolbar' : ''}`}><div className="driver-calendar-week"><button className="list-tool-button" type="button" aria-label="Previous week" disabled={!!editor || shownWeek <= horizon.weekStart} onClick={() => changeWeek(planningDateOffset(shownWeek,-7))}>‹</button><strong aria-live="polite">{editor && 'Editing week: '}{dateLabel(current?.week ?? shownWeek)} – {dateLabel(planningDateOffset(current?.week ?? shownWeek,6))}</strong><button className="list-tool-button" type="button" aria-label="Next week" disabled={!!editor || planningDateOffset(shownWeek,7) > horizon.end} onClick={() => changeWeek(planningDateOffset(shownWeek,7))}>›</button></div></div>
        {error && <ListError title="Week could not be loaded" message="Please reload to view current assignments." onRetry={() => setRetry(value => value + 1)} />}
        {!current ? loading && <div className="account-loading patients-loading" role="status"><span className="account-spinner" aria-hidden="true" /><span>Loading...</span></div>
          : <div className="driver-calendar-viewport" style={{minHeight:size.height || undefined}} aria-busy={loading} data-slide={previous ? view.direction : undefined}>
            {previous && <div key={`previous-${previous.week}`} className="driver-calendar-pane driver-calendar-outgoing" aria-hidden="true" inert>{calendar(previous)}</div>}
            <div key={`current-${current.week}`} className="driver-calendar-pane driver-calendar-current" ref={pane} inert={loading || error} onAnimationEnd={event => { if (event.target===event.currentTarget && event.animationName.startsWith('driver-calendar-enter-')) setView(old => ({...old,previous:null})); }}>{calendar(current)}</div>
          </div>}

  </>;
  return <>
    {inline ? <div className="driver-calendar-inline">{calendarContent}</div> : <Overlay title="Driver calendar" className="driver-availability-dialog" description={name} onClose={onClose}>{calendarContent}</Overlay>}
    {group && <Overlay title="Assigned trips" description={name} onClose={() => setGroup(null)}>
      <ul className="driver-calendar-trip-choices">{group.map(trip => <li key={trip.id}><button type="button" onClick={() => setSelected(trip)}><strong>{trip.patient_name} · {trip.kind === 'transfer' ? 'Travel to pickup' : trip.direction === 'outbound' ? 'Outbound' : 'Return'}</strong><span>{timestamp(trip.pickup_at)} – {timestamp(trip.dropoff_at)}</span></button></li>)}</ul>
    </Overlay>}
    {selected && <Overlay title={selected.kind === 'transfer' ? 'Travel to pickup' : 'Assigned trip'} className="trip-details-dialog" description={name} onClose={() => setSelected(null)}>
      <h3>{selected.patient_name} · {selected.kind === 'transfer' ? 'Travel to pickup' : selected.direction === 'outbound' ? 'Outbound' : 'Return'}</h3>
      <dl className="schedule-detail-fields"><div><dt>Pickup</dt><dd>{timestamp(selected.pickup_at)}</dd></div><div><dt>{selected.kind === 'transfer' ? 'Pickup ready' : selected.lifecycle === 'in-progress' ? 'Estimated arrival' : 'Arrival'}</dt><dd>{timestamp(selected.dropoff_at)}</dd></div><div><dt>From</dt><dd>{selected.origin}</dd></div><div><dt>To</dt><dd>{selected.destination}</dd></div><div><dt>Status</dt><dd>{selected.lifecycle === 'completed' ? 'Completed' : selected.lifecycle === 'in-progress' ? selected.status === 'at-risk' ? 'In progress · At-Risk' : 'In progress' : selected.status === 'at-risk' ? 'At-Risk' : 'On-Track'}</dd></div></dl>
    </Overlay>}
  </>;
}
