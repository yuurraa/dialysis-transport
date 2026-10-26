import { planningDateOffset, planningWindow } from '../lib/planningWindow';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

export const availabilityDays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
export const availabilityTime = (slot: number) => `${String(Math.floor(slot / 2)).padStart(2, '0')}:${slot % 2 ? '30' : '00'}`;
function singaporeClock() {
  const local = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return { day: (local.getUTCDay() + 6) % 7, minutes: local.getUTCHours() * 60 + local.getUTCMinutes() };
}
export interface CalendarTrip { id: string; patient_name: string; pickup_at: string; dropoff_at: string; direction: 'outbound' | 'return'; origin: string; destination: string; status: string }
export interface TimeRange { start: number; end: number }
export function availabilityDayRanges(slots: Set<number>, day: number): TimeRange[] {
  const ranges: TimeRange[] = [];
  for (let slot = 0; slot < 48; slot++) {
    if (!slots.has(day * 48 + slot)) continue;
    const start = slot;
    while (slot + 1 < 48 && slots.has(day * 48 + slot + 1)) slot++;
    ranges.push({ start, end: slot + 1 });
  }
  return ranges;
}

export function useAvailabilityClock() {
  const [clock, setClock] = useState(singaporeClock);
  useEffect(() => {
    const update = () => setClock(singaporeClock());
    const timer = window.setInterval(update, 15000);
    document.addEventListener('visibilitychange', update);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', update); };
  }, []);
  return clock;
}

/** Shared read-only or editable weekly presentation, with mobile time ranges. */
export default function WeeklyAvailabilityView({ slots, clock, editable = false, onChange, weekStart, bookings = [], onBooking, onBookingGroup }: {
  slots: number[]; clock: ReturnType<typeof useAvailabilityClock>; editable?: boolean; onChange?: (slots: number[]) => void; weekStart?: string; bookings?: CalendarTrip[]; onBooking?: (trip: CalendarTrip) => void; onBookingGroup?: (trips: CalendarTrip[]) => void;
}) {
  const headingId = useId();
  const selected = new Set(slots);
  const booked = new Map<number, CalendarTrip>();
  const grouped = new Map<number, CalendarTrip[]>();
  if (weekStart) for (let key=0;key<336;key++) {
    const day = planningDateOffset(weekStart,Math.floor(key/48));
    const begins = Date.parse(`${day}T${availabilityTime(key%48)}:00+08:00`);
    const matches = bookings.filter(trip => Date.parse(trip.pickup_at)<begins+1800000 && Date.parse(trip.dropoff_at)>begins);
    if (matches.length) { booked.set(key,matches[0]); grouped.set(key,matches); }
  }
  const free = new Set(slots.filter(slot => !booked.has(slot)));
  const start = [...booked.keys()].some(key => key%48<10) ? 0 : 10;
  const currentWeek = !weekStart || weekStart === planningWindow().weekStart;
  const dayDate = (day: number) => weekStart ? new Intl.DateTimeFormat('en-SG',{day:'numeric',month:'short',timeZone:'UTC'}).format(new Date(`${planningDateOffset(weekStart,day)}T00:00:00Z`)) : null;
  const tripTime = (value: string) => new Intl.DateTimeFormat('en-SG',{hour:'2-digit',minute:'2-digit',hourCycle:'h23',timeZone:'Asia/Singapore'}).format(new Date(value));
  const tripLabel = (trip: CalendarTrip) => `${trip.patient_name} · ${trip.direction === 'outbound' ? 'Outbound' : 'Return'} · ${tripTime(trip.pickup_at)}–${tripTime(trip.dropoff_at)}`;
  const [focusSlot, setFocusSlot] = useState(() => clock.day * 48 + start);
  const grid = useRef<HTMLDivElement>(null);
  const drag = useRef<{ start: number; base: Set<number>; available: boolean } | null>(null);
  function toggle(slot: number) {
    if (booked.has(slot)) return;
    const next = new Set(selected);
    if (next.has(slot)) next.delete(slot); else next.add(slot);
    onChange?.([...next].sort((a, b) => a - b));
  }

  function paint(end: number) {
    const state = drag.current;
    if (!state) return;
    const next = new Set(state.base);
    for (let day = Math.min(Math.floor(state.start / 48), Math.floor(end / 48)); day <= Math.max(Math.floor(state.start / 48), Math.floor(end / 48)); day++) {
      for (let slot = Math.min(state.start % 48, end % 48); slot <= Math.max(state.start % 48, end % 48); slot++) {
        if (booked.has(day * 48 + slot)) continue;
        if (state.available) next.add(day * 48 + slot); else next.delete(day * 48 + slot);
      }
    }
    onChange?.([...next].sort((a, b) => a - b));
  }
  function pointerDown(event: PointerEvent<HTMLButtonElement>, slot: number) {
    if (booked.has(slot) || !editable || event.pointerType !== 'mouse' || event.button !== 0) return;
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
  return <div className={`weekly-availability-view${weekStart ? ' availability-dated' : ''}`}>
          <div className="availability-mobile-days" role="region" aria-label="Weekly availability by day">
            {availabilityDays.map((day, dayIndex) => { const ranges = availabilityDayRanges(free, dayIndex); return <section className="availability-mobile-day" key={day} aria-labelledby={`${headingId}-mobile-availability-${dayIndex}`}>
              <h2 id={`${headingId}-mobile-availability-${dayIndex}`} aria-current={currentWeek && dayIndex === clock.day ? 'date' : undefined}>{day}{weekStart && <span className="availability-heading-date">{dayDate(dayIndex)}</span>}</h2>
              {ranges.length || [...booked.keys()].some(key => Math.floor(key/48)===dayIndex) ? <ul className="availability-mobile-ranges">{ranges.map(range => <li key={range.start}>{availabilityTime(range.start)}–{availabilityTime(range.end)}</li>)}{bookings.filter(trip => [...grouped].some(([key,matches]) => Math.floor(key/48)===dayIndex && matches.some(booking => booking.id===trip.id))).map(trip => <li className="availability-booked-range" key={trip.id}><button type="button" onClick={() => onBooking?.(trip)}>{tripLabel(trip)}</button></li>)}</ul> : <p className="availability-unavailable">Unavailable</p>}
            </section>; })}
          </div>
          <div className="availability-grid" ref={grid} role="group" aria-label="Weekly availability" onPointerMove={move} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}>
            <div className="availability-time-column" aria-hidden="true"><div className="availability-day-heading">Time</div>{Array.from({ length: 48 - start }, (_, i) => <div className="availability-time" key={i}>{availabilityTime(start + i)}</div>)}</div>
            {availabilityDays.map((day, dayIndex) => <div key={day} className={`availability-day${currentWeek && dayIndex === clock.day ? ' availability-today' : ''}`}><div className="availability-day-heading" aria-current={currentWeek && dayIndex === clock.day ? 'date' : undefined}>{day}{weekStart && <span className="availability-heading-date">{dayDate(dayIndex)}</span>}</div>
              {Array.from({ length: 48 - start }, (_, i) => { const slot = start + i; const key = dayIndex * 48 + slot; const booking = booked.get(key); return <button type="button" className={`availability-slot${booking ? ' availability-booked' : ''}`} key={key} data-availability-slot={key} title={booking ? grouped.get(key)!.map(tripLabel).join(' / ') : undefined} aria-label={`${day}${weekStart ? ` ${dayDate(dayIndex)}` : ''} ${availabilityTime(slot)}–${availabilityTime(slot + 1)}${booking ? ` · ${grouped.get(key)!.map(tripLabel).join(' / ')}` : ''}`} aria-pressed={!booking && selected.has(key)} disabled={!editable && !booking} tabIndex={booking || focusSlot === key ? 0 : -1} onFocus={() => setFocusSlot(key)} onKeyDown={event => keyDown(event, key)} onPointerDown={event => pointerDown(event, key)} onClick={event => { if (booking) { const matches = grouped.get(key)!; if (matches.length > 1 && onBookingGroup) onBookingGroup(matches); else onBooking?.(booking); return; } if (editable && (event.detail === 0 || (event.nativeEvent as globalThis.PointerEvent).pointerType !== 'mouse')) toggle(key); }}>{booking && (grouped.get(key)!.length > 1 ? `${grouped.get(key)!.length} trips` : booking.patient_name)}</button>; })}
            </div>)}
            {currentWeek && clock.minutes >= start * 30 && <div className="availability-now-marker" role="img" aria-label={`Current Singapore time ${String(Math.floor(clock.minutes / 60)).padStart(2, '0')}:${String(clock.minutes % 60).padStart(2, '0')}`} style={{ top: `min(100%, ${(weekStart ? 46 : 34) + (clock.minutes / 30 - start) * 26}px)` }}><span className="availability-now-line" aria-hidden="true" /></div>}
          </div>
  </div>;
}
