import { useEffect, useState } from 'react';
import { ApiError, apiGet } from '../lib/api';
import { ListError, PageHeading } from '../components/DashboardUI';
import { PersonalFields, type PersonalDetails } from '../components/PersonalFields';

/** Personal signup information only; vehicle registration is a later milestone. */
export default function DriverProfile({ onSessionExpired }: { onSessionExpired: () => void }) {
  const [driver, setDriver] = useState<PersonalDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    apiGet<{ driver: PersonalDetails | null }>('/profiles/driver').then(result => {
      if (active) setDriver(result.driver);
    }).catch(reason => {
      if (!active) return;
      if (reason instanceof ApiError && reason.status === 401) onSessionExpired();
      setError('Your driver profile could not be loaded. Please try again.');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [attempt, onSessionExpired]);
  return <section className="dashboard-trips patients-panel patient-form-panel page-panel" aria-labelledby="driver-profile-title">
    <PageHeading id="driver-profile-title" title="Account Details" />
    {loading ? <div className="account-loading patients-loading" role="status"><span className="account-spinner" aria-hidden="true" /><span>Loading...</span></div>
      : error ? <ListError title="Driver details could not be loaded" message={error} onRetry={() => setAttempt(value => value + 1)} />
      : driver ? <fieldset className="patient-form-fields" disabled aria-label="Your driver details"><PersonalFields prefix="driver-profile" draft={driver} onChange={() => {}} /></fieldset>
      : <p role="status">Your driver details are unavailable. Sign in again to finish creating your account.</p>}
  </section>;
}
