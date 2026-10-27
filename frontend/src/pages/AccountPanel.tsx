import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, apiGet, apiRequest } from '../lib/api';
import type { SignupDraft } from '../lib/googleAccountSelection';
import { PersonalFields, emptyPersonal } from '../components/PersonalFields';
import { PatientFields, patientDraft } from './PatientsPage';

export interface Account {
  id: string;
  email: string;
  display_name: string;
  full_name?: string | null;
  role: 'coordinator' | 'patient' | 'caregiver' | 'driver';
  status: 'active' | 'inactive';
  profile_complete?: boolean;
}
interface Props {
  email?: string;
  onSignOut: () => void;
  onCancel: () => void;
  onLoadingChange: (loading: boolean) => void;
  onAccountResolved: (account: Account | null) => void;
  onSessionExpired: () => Promise<void>;
  signingOut: boolean;
  initialDraft?: SignupDraft;
  onChangeGoogleAccount: (draft: SignupDraft) => Promise<void>;
}
export const roleNames: Record<Account['role'], string> = { coordinator: 'Transport Coordinator', patient: 'Patient', caregiver: 'Caregiver', driver: 'Driver' };
const button = 'rounded-lg border border-slate-400 px-4 py-3 font-semibold disabled:opacity-50';

/** Google establishes identity; registration persists the username and one public role. */
export default function AccountPanel({ email, onSignOut, onCancel, onLoadingChange, onAccountResolved, onSessionExpired, signingOut, initialDraft, onChangeGoogleAccount }: Props) {
  const [account, setAccount] = useState<Account | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [username, setUsername] = useState(initialDraft?.username ?? '');
  const [role, setRole] = useState(initialDraft?.role ?? '');
  const generation = useRef(0);
  const [step, setStep] = useState<'account' | 'details'>('account');
  const [driverProfile, setDriverProfile] = useState({ ...emptyPersonal });
  const [profile, setProfile] = useState(() => patientDraft());
  const heading = useRef<HTMLHeadingElement>(null);
  const incompleteProfile = ['patient', 'driver', 'caregiver'].includes(account?.role ?? '') && account?.status === 'active' && account.profile_complete !== true;
  const personalRole=['driver','caregiver'].includes(account?.role??role);
  useEffect(() => { if (step === 'details') heading.current?.focus(); }, [step]);

  useEffect(() => {
    if (phase === 'ready') onAccountResolved(account);
  }, [phase, account, onAccountResolved]);

  const loading = phase !== 'ready';
  useEffect(() => { onLoadingChange(loading); }, [loading, onLoadingChange]);
  useEffect(() => () => onLoadingChange(false), [onLoadingChange]);

  useEffect(() => {
    const version = ++generation.current;
    setPhase('loading');
    setError('');
    apiGet<{ account: Account | null }>('/auth/me')
      .then(result => {
        if (generation.current === version) {
          setAccount(result.account);
          setPhase('ready');
        }
      })
      .catch(async error => {
        if (generation.current === version && error instanceof ApiError && error.status === 401) {
          await onSessionExpired();
          return;
        }
        if (generation.current === version) {
          setAccount(null);
          setPhase('error');
        }
      });
    return () => { generation.current++; };
  }, [attempt, onSessionExpired]);

  async function register(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || signingOut) return;
    if (!incompleteProfile && step === 'account') { setError(''); setStep('details'); return; }
    const version = generation.current;
    setSaving(true);
    setError('');
    try {
      const { status: unused, ...details } = profile;
      let result: Account;
      if (incompleteProfile) {
        await apiRequest(personalRole?`/profiles/${account!.role}`:'/profiles/patient', 'PATCH', personalRole?driverProfile:details);
        const current = await apiGet<{ account: Account | null }>('/auth/me');
        if (!current.account?.profile_complete) throw new Error('Profile completion could not be confirmed.');
        result = current.account;
      } else {
        result = await apiRequest<Account>('/auth/register', 'POST', { displayName: username.trim(), role, profile: role==='patient'?details:driverProfile });
      }
      if (generation.current === version) setAccount(result);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        if (generation.current === version) await onSessionExpired();
        return;
      }
      // Another tab may have finished registration, or the response may have been lost.
      try {
        const current = await apiGet<{ account: Account | null }>('/auth/me');
        if (generation.current !== version) return;
        if (current.account) {
          setAccount(current.account);
          if (!['patient', 'driver', 'caregiver'].includes(current.account.role) || current.account.profile_complete === true) return;
        }
      } catch (lookupError) {
        if (lookupError instanceof ApiError && lookupError.status === 401) {
          if (generation.current === version) await onSessionExpired();
          return;
        }
      }
      if (generation.current === version) setError('Unable to create your account. Please try again.');
    } finally {
      if (generation.current === version) setSaving(false);
    }
  }

  // Recover automatically while a sleeping or unavailable backend comes back online.
  useEffect(() => {
    if (phase !== 'error') return;
    const retry = window.setTimeout(() => setAttempt(value => value + 1), 5000);
    return () => window.clearTimeout(retry);
  }, [phase]);

  if (phase !== 'ready' || (account?.status === 'active' && (!['patient', 'driver', 'caregiver'].includes(account.role) || account.profile_complete === true))) return <div className="account-loading" role="status" aria-label={phase === 'error' ? 'Reconnecting to account service' : 'Loading account'}><span className="account-spinner" aria-hidden="true" /><span>Loading...</span></div>;

  if (!account || incompleteProfile) return <div className="space-y-5" aria-busy={saving}>
    <div>
      <h2 className="text-xl font-semibold" ref={heading} tabIndex={-1}>{incompleteProfile ? 'Finish creating your account' : step === 'details' ? 'Complete your details' : 'Create your account'}</h2>
      <p className="mt-2 text-slate-600">{step === 'account' && !incompleteProfile ? 'Choose a username and your role.' : personalRole ? 'Add your personal and contact details.' : 'Add your personal, contact and pickup details.'}</p>
    </div>
    <form onSubmit={register} className={`signup-form${step === 'details' || incompleteProfile ? ' signup-profile' : ''}`}>
      {step === 'account' && !incompleteProfile ? <>
      <div>
        <label htmlFor="signup-email" className="block font-medium">Email</label>
        <div className="signup-email-row mt-1">
          <input id="signup-email" type="email" autoComplete="email" value={email ?? ''} disabled className="rounded-lg border border-slate-400 p-3" />
          <button type="button" className="signup-change-account" aria-label="Change Google account" title="Change Google account"
            disabled={saving || signingOut} onClick={() => void onChangeGoogleAccount({ username, role })}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M20 7H4m0 0 4-4M4 7l4 4M4 17h16m0 0-4-4m4 4-4 4" />
            </svg>
          </button>
        </div>
      </div>
      <label className="block font-medium"><span className="patient-required">Username</span>
        <input disabled={saving || signingOut} required maxLength={100} autoComplete="username" placeholder="Enter your username" value={username} onChange={event => setUsername(event.target.value)} className="mt-1 block w-full rounded-lg border border-slate-400 p-3 font-normal" />
      </label>
      <label className="block font-medium"><span className="patient-required">Role</span>
        <select disabled={saving || signingOut} required value={role} onChange={event => setRole(event.target.value)} className="mt-1 block w-full rounded-lg border border-slate-400 bg-white p-3 font-normal">
          <option value="">Choose a role</option><option value="patient">Patient</option><option value="caregiver">Caregiver</option><option value="driver">Driver</option>
        </select>
      </label>
      </> : personalRole ? <fieldset className="patient-form-fields" disabled={saving || signingOut} aria-label={`${account?.role==='caregiver'||role==='caregiver'?'Caregiver':'Driver'} details`}><PersonalFields prefix={account?.role??role} draft={driverProfile} onChange={setDriverProfile} /></fieldset> : role === 'patient' || incompleteProfile ? <PatientFields draft={profile} onChange={setProfile} disabled={saving || signingOut} />
        : <dl className="signup-review"><div><dt>Email</dt><dd>{email}</dd></div><div><dt>Username</dt><dd>{username}</dd></div><div><dt>Role</dt><dd>{roleNames[role as keyof typeof roleNames]}</dd></div></dl>}
      {error && <p role="alert">{error}</p>}
      <div className="signup-actions">
        <button className="w-full rounded-lg bg-sky-800 p-3 font-semibold text-white disabled:opacity-50" disabled={saving || signingOut || (!incompleteProfile && (!username.trim() || !role))} type="submit">{saving ? 'Saving…' : incompleteProfile ? 'Finish creating account' : step === 'account' ? 'Next' : 'Sign Up'}</button>
        {step === 'details' && !incompleteProfile && <button type="button" className={`${button} w-full`} disabled={saving || signingOut} onClick={() => { setError(''); setStep('account'); }}>Back</button>}
        <button type="button" className={`${button} w-full`} onClick={onCancel} disabled={saving || signingOut}>{signingOut ? 'Cancelling…' : 'Cancel'}</button>
      </div>
    </form>
  </div>;

  return <div className="account-summary space-y-5">
    <header className="space-y-2">
      <p className="entry-eyebrow">Your account</p>
      <h2 className="entry-title">{account.display_name}</h2>
      <div className="account-identity">
        <p className="account-email">{account.email}</p>
        <span className="account-role">{roleNames[account.role]}</span>
      </div>
    </header>
    <h3 className="text-lg font-semibold">Account inactive</h3>
    <p>Contact your transport coordinator to discuss access.</p>
    <button type="button" className={`${button} w-full`} onClick={onSignOut} disabled={signingOut || saving}>
      {signingOut ? 'Signing out…' : 'Sign out'}
    </button>
  </div>;
}
