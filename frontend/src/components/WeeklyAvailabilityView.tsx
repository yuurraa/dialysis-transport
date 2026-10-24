import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

export const availabilityDays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
export const availabilityTime = (slot: number) => `${String(Math.floor(slot / 2)).padStart(2, '0')}:${slot % 2 ? '30' : '00'}`;
function singaporeClock() {
  const local = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return { day: (local.getUTCDay() + 6) % 7, minutes: local.getUTCHours() * 60 + local.getUTCMinutes() };
}
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
export default function WeeklyAvailabilityView({ slots, clock, editable = false, onChange }: {
  slots: number[]; clock: ReturnType<typeof useAvailabilityClock>; editable?: boolean; onChange?: (slots: number[]) => void;
}) {
  const selected = new Set(slots);
  const start = 10;
  const [focusSlot, setFocusSlot] = useState(() => clock.day * 48 + start);
  const grid = useRef<HTMLDivElement>(null);
  const drag = useRef<{ start: number; base: Set<number>; available: boolean } | null>(null);
  function toggle(slot: number) {
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
        if (state.available) next.add(day * 48 + slot); else next.delete(day * 48 + slot);
      }
    }
    onChange?.([...next].sort((a, b) => a - b));
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
  return <div className="weekly-availability-view">
          <div className="availability-mobile-days" role="region" aria-label="Weekly availability by day">
            {availabilityDays.map((day, dayIndex) => { const ranges = availabilityDayRanges(selected, dayIndex); return <section className="availability-mobile-day" key={day} aria-labelledby={`mobile-availability-${dayIndex}`}>
              <h2 id={`mobile-availability-${dayIndex}`} aria-current={dayIndex === clock.day ? 'date' : undefined}>{day}</h2>
              {ranges.length ? <ul className="availability-mobile-ranges">{ranges.map(range => <li key={range.start}>{availabilityTime(range.start)}–{availabilityTime(range.end)}</li>)}</ul> : <p className="availability-unavailable">Unavailable</p>}
            </section>; })}
          </div>
          <div className="availability-grid" ref={grid} role="group" aria-label="Weekly availability" onPointerMove={move} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}>
            <div className="availability-time-column" aria-hidden="true"><div className="availability-day-heading">Time</div>{Array.from({ length: 48 - start }, (_, i) => <div className="availability-time" key={i}>{availabilityTime(start + i)}</div>)}</div>
            {availabilityDays.map((day, dayIndex) => <div key={day} className={`availability-day${dayIndex === clock.day ? ' availability-today' : ''}`}><div className="availability-day-heading" aria-current={dayIndex === clock.day ? 'date' : undefined}>{day}</div>
              {Array.from({ length: 48 - start }, (_, i) => { const slot = start + i; const key = dayIndex * 48 + slot; return <button type="button" className="availability-slot" key={key} data-availability-slot={key} aria-label={`${day} ${availabilityTime(slot)}–${availabilityTime(slot + 1)}`} aria-pressed={selected.has(key)} disabled={!editable} tabIndex={focusSlot === key ? 0 : -1} onFocus={() => setFocusSlot(key)} onKeyDown={event => keyDown(event, key)} onPointerDown={event => pointerDown(event, key)} onClick={event => { if (editable && (event.detail === 0 || (event.nativeEvent as globalThis.PointerEvent).pointerType !== 'mouse')) toggle(key); }} />; })}
            </div>)}
            {clock.minutes >= start * 30 && <div className="availability-now-marker" role="img" aria-label={`Current Singapore time ${String(Math.floor(clock.minutes / 60)).padStart(2, '0')}:${String(clock.minutes % 60).padStart(2, '0')}`} style={{ top: `min(100%, ${34 + (clock.minutes / 30 - start) * 26}px)` }}><span className="availability-now-line" aria-hidden="true" /></div>}
          </div>
  </div>;
}
