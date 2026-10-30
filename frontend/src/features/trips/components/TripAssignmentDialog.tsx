import { tripNow } from '../lib/tripClock';
import { useEffect, useRef, useState } from 'react';
import { Overlay, ListError } from '../../../shared/ui/DashboardUI';
import { apiGet, apiRequest, ApiError } from '../../../shared/lib/api';
import type { Trip } from '../pages/TripsPage';

interface DriverOption {
  id: string; name: string; phone: string; vehicle_id: string; plate: string; make: string; model: string;
  passenger_capacity: number; wheelchair_accessible: boolean;
  preferred?:boolean; continuity?:boolean; average_rating?:number|null; rating_count?:number;
}
interface Options { trip: Trip; duration_minutes: number; drivers: DriverOption[] }
const localPickup = (trip: Trip) => {
  const instant = trip.pickup_at ?? (trip.direction === 'outbound' ? new Date(Date.parse(trip.arrival_by!) - (trip.duration_minutes ?? 30) * 60000).toISOString() : trip.pickup_not_before!);
  return new Date(Date.parse(instant) + 8 * 3600000).toISOString().slice(0,16);
};
const pickupInstant = (value: string) => {
  const date = new Date(`${value}:00+08:00`);
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) && Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

/** Candidate lists are advisory; saving rechecks the whole journey under database locks. */
export default function TripAssignmentDialog({ trip, onClose, onChanged, onSessionExpired }: {
  trip: Trip; onClose: () => void; onChanged: (trip: Trip, message: string) => void; onSessionExpired: () => void;
}) {
  const [current, setCurrent] = useState(trip);
  const [pickup, setPickup] = useState(() => localPickup(trip));
  const [options, setOptions] = useState<Options | null>(null);
  const [loadedPickup, setLoadedPickup] = useState('');
  const [selected, setSelected] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const alive = useRef(false);
  const requestSequence = useRef(0);
  const pickupTouched = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; requestSequence.current++; }; }, [trip.id]);
  useEffect(() => {
    if (!pickupInstant(pickup)) { setLoading(false); return; }
    setLoading(true);
    const timer = window.setTimeout(() => { void findDrivers(pickup); }, 250);
    return () => { window.clearTimeout(timer); requestSequence.current++; };
  }, [pickup, trip.id]);
  function failure(reason: unknown) {
    if (reason instanceof ApiError && reason.status === 401) onSessionExpired();
    if (reason instanceof ApiError && [404,409].includes(reason.status)) {
      setConflict(true); setError('This trip or driver availability changed. Reload before trying again.');
    } else if (reason instanceof ApiError && ['routing_unconfigured','route_unavailable','route_address_unresolved'].includes(reason.code ?? '')) {
      setError(reason.code === 'route_address_unresolved' ? 'A route address could not be located. Check the patient and centre address.' : 'Route planning is unavailable. Please retry once routing is configured and available.');
    } else setError(reason instanceof ApiError && reason.status === 400 ? 'Choose an upcoming pickup time that meets the treatment requirements.' : 'Assignment details could not be saved or loaded. Please try again.');
  }
  async function findDrivers(value = pickup, resetPickup = false) {
    const instant = pickupInstant(value);
    if (!instant) { setError('Choose a pickup time.'); return; }
    const sequence = ++requestSequence.current;
    setLoading(true); setError(''); setSelected(''); setOptions(null);
    try {
      const result = await apiGet<Options>(`/trips/${trip.id}/assignment-options?${new URLSearchParams({ pickup_at: instant })}`);
      if (!alive.current || sequence !== requestSequence.current) return;
      setCurrent(result.trip); setConflict(false);
      if (resetPickup || !pickupTouched.current) {
        const latest = localPickup(result.trip);
        setPickup(latest);
        if (latest !== value) { setOptions(null); return; }
      }
      setOptions(result); setLoadedPickup(value);
    } catch (reason) { if (alive.current && sequence === requestSequence.current) failure(reason); }
    finally { if (alive.current && sequence === requestSequence.current) setLoading(false); }
  }
  async function save(unassign = false) {
    if (busy || loading || conflict) return;
    const instant = pickupInstant(pickup);
    if (!unassign && (!selected || !instant || pickup !== loadedPickup)) return;
    setBusy(true); setError('');
    try {
      const saved = await apiRequest<Trip>(`/trips/${trip.id}/${unassign ? 'unassign' : 'assignment'}`, unassign ? 'PATCH' : 'POST',
        { version: current.version, ...(!unassign ? { driver_id: selected, pickup_at: instant } : {}) });
      if (alive.current) onChanged(saved, unassign ? 'Driver unassigned. This trip is awaiting a driver.' : 'Driver assigned.');
    } catch (reason) { if (alive.current) failure(reason); }
    finally { if (alive.current) setBusy(false); }
  }
  const assigned = Boolean(current.assigned_driver_id);
  return <Overlay title={assigned ? 'Driver assignment' : 'Assign driver'} description={current.patient_name} className="trip-assignment-dialog" onClose={onClose} busy={busy} onSubmit={event => { event.preventDefault(); if (!assigned) void save(); }} noValidate error={error} onDismissError={() => setError('')}
    footer={<>{conflict ? <button className="patient-primary" type="button" disabled={busy || loading} onClick={() => void findDrivers(pickup || localPickup(current), true)}>Reload assignment</button>
      : assigned ? <button className="button-danger" type="button" disabled={busy || loading || !current.pickup_at || Date.parse(current.pickup_at) <= tripNow(current)} onClick={() => void save(true)}>{busy ? 'Saving…' : 'Unassign driver'}</button>
      : <button className="patient-primary" type="submit" disabled={busy || loading || !selected || pickup !== loadedPickup}>{busy ? 'Saving…' : 'Assign driver'}</button>}<button type="button" disabled={busy} onClick={onClose}>Close</button></>}>
    <dl className="schedule-detail-fields"><div><dt>From</dt><dd>{current.origin}</dd></div><div><dt>To</dt><dd>{current.destination}</dd></div><div><dt>{current.direction === 'outbound' ? 'Arrive by' : 'Earliest pickup'}</dt><dd>{new Intl.DateTimeFormat('en-SG',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Singapore'}).format(new Date((current.arrival_by ?? current.pickup_not_before)!))}</dd></div></dl>
    {assigned ? <><dl className="trip-detail-timings"><div><dt>Driver</dt><dd>{current.assignment?.driver_name}</dd></div><div><dt>Car</dt><dd>{current.assignment?.plate} · {current.assignment?.make} {current.assignment?.model}</dd></div><div><dt>Pickup (Singapore time)</dt><dd>{current.pickup_at && new Intl.DateTimeFormat('en-SG',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Singapore'}).format(new Date(current.pickup_at))}</dd></div></dl><p className="treatment-hint">Unassigning releases this driver and returns the trip to Unfilled.</p></>
      : <><fieldset className="patient-form-fields" disabled={busy}><div className="patient-field patient-form-wide"><label className="patient-required" htmlFor="assignment-pickup">Pickup (Singapore time)</label><input id="assignment-pickup" type="datetime-local" required min={`${localPickup(current).slice(0,10)}T00:00`} max={`${localPickup(current).slice(0,10)}T23:59`} value={pickup} onChange={event => { pickupTouched.current = true; setPickup(event.target.value); setSelected(''); setOptions(null); requestSequence.current++; setLoading(Boolean(pickupInstant(event.target.value))); setError(''); }} /><p className="treatment-hint">{options ? `Approximate journey duration: ${options.duration_minutes} minutes.` : loading ? 'Calculating journey duration…' : 'Journey duration unavailable.'}</p></div></fieldset>
        <section className="assignment-candidates" aria-label="Eligible drivers" aria-busy={loading}><h3 className="patient-required">Eligible drivers</h3>
          {loading ? <p role="status">Loading drivers…</p> : options && loadedPickup === pickup ? options.drivers.length ? <fieldset className="assignment-driver-list" disabled={busy} tabIndex={0}><legend className="sr-only">Choose a driver (required)</legend>{options.drivers.map(driver => <label className="assignment-driver" key={driver.id}><input type="radio" name="assigned-driver" required checked={selected === driver.id} value={driver.id} onChange={() => setSelected(driver.id)} /><span><strong>{driver.name}</strong>{(driver.preferred||driver.continuity)&&<span>{driver.preferred?'Preferred driver':'Previous driver'}</span>}{driver.average_rating!=null&&<span>{driver.average_rating.toFixed(1)} / 5 · {driver.rating_count??0} ratings</span>}<span>{driver.plate} · {driver.make} {driver.model}</span><span>{driver.passenger_capacity} passenger seats{driver.wheelchair_accessible ? ' · Wheelchair accessible' : ''}</span></span></label>)}</fieldset> : <p>No eligible drivers for this pickup time. Check availability or choose another time.</p> : error && !conflict ? <p>Drivers could not be loaded. <button type="button" disabled={busy} onClick={() => void findDrivers()}>Retry</button></p> : <p>Choose a valid pickup time to see eligible drivers.</p>}
        </section></>}
    {conflict && <ListError title="Assignment needs refreshing" message="Reload to get the current trip and eligible drivers." onRetry={() => void findDrivers(pickup || localPickup(current), true)} />}
  </Overlay>;
}
