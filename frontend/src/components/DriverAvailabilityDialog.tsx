import { useEffect, useState } from 'react';
import { ApiError, apiGet } from '../lib/api';
import { ListError, Overlay } from './DashboardUI';
import WeeklyAvailabilityView, { useAvailabilityClock } from './WeeklyAvailabilityView';

interface Schedule { eligible: boolean; availability: { weekly_slots: number[]; version: number } | null }
/** Coordinator inspection is read-only, including when a saved driver becomes ineligible. */
export default function DriverAvailabilityDialog({ driverId, name, onClose, onSessionExpired }: {
  driverId: string; name: string; onClose: () => void; onSessionExpired: () => void;
}) {
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const clock = useAvailabilityClock();
  useEffect(() => {
    let active = true;
    setLoading(true); setError(false); setSchedule(null);
    apiGet<Schedule>(`/drivers/${driverId}/availability`).then(result => {
      if (active) setSchedule(result);
    }).catch(reason => {
      if (!active) return;
      if (reason instanceof ApiError && reason.status === 401) onSessionExpired();
      setError(true);
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [driverId, retry, onSessionExpired]);
  return <Overlay title="Weekly Availability" className="driver-availability-dialog" description={name} onClose={onClose}>
    {loading ? <div className="account-loading patients-loading" role="status"><span className="account-spinner" aria-hidden="true" /><span>Loading...</span></div>
      : error ? <ListError title="Availability could not be loaded" message="Please try again." onRetry={() => setRetry(value => value + 1)} />
      : schedule?.availability ? <><p className="availability-hours">Hours per week: {schedule.availability.weekly_slots.length / 2}h</p>{!schedule.eligible && <p className="availability-eligibility" role="status">Not currently eligible for trip assignment.</p>}<WeeklyAvailabilityView slots={schedule.availability.weekly_slots} clock={clock} /></>
      : <p className="availability-unavailable" role="status">No availability set.</p>}
  </Overlay>;
}
