import { Toast, ToastRegion } from '../components/Toast';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import AccountPanel, { type Account } from './AccountPanel';
import PageLayout from '../components/PageLayout';
import Dashboard from './Dashboard';
import { hasSignupSelection, supabase } from '../lib/supabase';
import { completeGoogleAccountSelection, startGoogleAccountSelection, type SignupDraft } from '../lib/googleAccountSelection';

/** UC-01: Google session plus database-backed account registration and access. */
export default function LoginPage() {
  const [path, setPath] = useState(window.location.pathname);
  const [resolvedAccount, setResolvedAccount] = useState<{ userId: string; account: Account | null } | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(Boolean(supabase));
  const [busy, setBusy] = useState<'signin' | 'signout' | 'change' | null>(null);
  const [message, setMessage] = useState('');
  const [signupDraft, setSignupDraft] = useState<SignupDraft>();
  const selectingAccount = useRef(hasSignupSelection());
  const cancellingSignup = useRef(false);
  const [backendReady, setBackendReady] = useState(false);
  const [accountLoading, setAccountLoading] = useState(true);
  const [toast, setToast] = useState<{ message: string; id: number; kind: 'notice' | 'loading' } | null>(null);
  const [toastClosing, setToastClosing] = useState(false);

  const notify = useCallback((text: string, kind: 'notice' | 'loading' = 'notice') => {
    setMessage('');
    setToastClosing(false);
    setToast(previous => ({ message: text, id: (previous?.id ?? 0) + 1, kind }));
  }, []);

  const navigate = useCallback((target: string, replace = false) => {
    window.history[replace ? 'replaceState' : 'pushState'](null, '', target);
    setPath(target);
    window.scrollTo(0, 0);
  }, []);
  useEffect(() => {
    const changed = () => setPath(window.location.pathname);
    window.addEventListener('popstate', changed);
    return () => window.removeEventListener('popstate', changed);
  }, []);
  const onAccountResolved = useCallback((account: Account | null) => {
    if (user) setResolvedAccount({ userId: user.id, account });
  }, [user?.id]);
  const onPatientProfileMissing = useCallback(() => {
    setResolvedAccount(previous => previous?.account?.role === 'patient' ? { ...previous, account: { ...previous.account, profile_complete: false } } : previous);
    navigate('/', true);
  }, [navigate]);
  const account = resolvedAccount?.userId === user?.id ? resolvedAccount?.account : null;
  const restoringAccount = checking || Boolean(user && resolvedAccount?.userId !== user.id);
  const dashboardAccess = Boolean(user && account && (!['patient', 'driver'].includes(account.role) || account.profile_complete === true) && account.status === 'active');
  useEffect(() => {
    if (checking) return;
    if (dashboardAccess && account?.role === 'patient' && path === '/dashboard/profile') { navigate('/dashboard/account', true); return; }
    const home = '/dashboard/trips';
    const allowed = [home, '/dashboard/account', ...(account?.role === 'driver' ? ['/dashboard/trips', '/dashboard/availability', '/dashboard/vehicle'] : []), ...(['patient', 'coordinator'].includes(account?.role ?? '') ? ['/dashboard/schedules'] : []), ...(account?.role === 'coordinator' ? ['/dashboard/patients', '/dashboard/drivers'] : [])];
    if (dashboardAccess && !allowed.includes(path)) navigate(home, true);
    else if (path.startsWith('/dashboard') && (!user || (resolvedAccount?.userId === user.id && !dashboardAccess))) navigate('/', true);
  }, [checking, dashboardAccess, account?.role, path, user?.id, resolvedAccount, navigate]);

  const loading = checking || (!user && Boolean(supabase) && !backendReady) || Boolean(user && accountLoading);
  useEffect(() => {
    if (!loading) {
      if (toast?.kind === 'loading') setToastClosing(true);
      return;
    }
    // Start a fresh interval only after the previous toast has finished closing.
    if (toast) return;
    const reminder = window.setTimeout(() => notify('This is taking us longer than expected.', 'loading'), 10000);
    return () => window.clearTimeout(reminder);
  }, [loading, toast, notify]);

  useEffect(() => {
    if (user || !supabase) return;
    let active = true;
    const controller = new AbortController();
    let latestCheck = 0;
    async function checkBackend() {
      const version = ++latestCheck;
      try {
        const origin = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');
        const response = await fetch(`${origin}/api/health`, {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
          cache: 'no-store',
        });
        const result = response.ok ? await response.json() : null;
        if (active && version === latestCheck) setBackendReady(result?.status === 'ok');
      } catch {
        if (active && version === latestCheck) setBackendReady(false);
      }
    }
    void checkBackend();
    const refresh = () => { void checkBackend(); };
    const interval = window.setInterval(refresh, 30000);
    window.addEventListener('focus', refresh);
    return () => {
      active = false;
      controller.abort();
      window.clearInterval(interval);
      window.removeEventListener('focus', refresh);
    };
  }, [user]);

  useEffect(() => {
    const client = supabase;
    if (!client) return;
    let active = true;
    let eventVersion = 0;
    const isCallback = window.location.pathname === '/auth/callback';

    // Keep this callback synchronous; session initialization and network work happen below.
    const { data: { subscription } } = client.auth.onAuthStateChange((event, session) => {
      if (!active) return;
      eventVersion += 1;
      setUser(session?.user ?? null);
      if (event === 'SIGNED_OUT') setResolvedAccount(null);
      setChecking(selectingAccount.current);
      setBusy(null);
      if (event === 'SIGNED_OUT' && !selectingAccount.current && !cancellingSignup.current) notify('You have been signed out.');
    });

    async function restoreSession() {
      const version = eventVersion;
      try {
        // The browser SDK exchanges PKCE codes and restores/refreshes persisted sessions.
        const { error: initializationError } = await client!.auth.initialize();
        if (selectingAccount.current) {
          const selection = await completeGoogleAccountSelection();
          if (!active) return;
          setSignupDraft(selection.draft);
          if (selection.notice) notify(selection.notice);
          const current = await client!.auth.getSession();
          if (!active) return;
          selectingAccount.current = false;
          setUser(current.data.session?.user ?? null);
          return;
        }
        const { data, error } = await client!.auth.getSession();
        if (!active) return;
        // A newer event (for example sign-out in another tab) owns the current state.
        if (version === eventVersion) setUser(data.session?.user ?? null);
        if (initializationError || error || (isCallback && !data.session)) {
          setMessage('Google sign-in could not be completed. Please try again.');
        }
      } catch {
        if (active) setMessage('Unable to restore your session. Please try again.');
      } finally {
        if (active) {
          setChecking(false);
          // Remove callback codes and provider error details; never honour an arbitrary return URL.
          if (isCallback && window.location.pathname === '/auth/callback') {
            window.history.replaceState(window.history.state, '', '/');
          }
        }
      }
    }

    void restoreSession();
    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, [notify]);

  const expireSession = useCallback(async () => {
    await supabase?.auth.signOut({ scope: 'local' }).catch(() => undefined);
    setUser(null);
    notify('Your session is no longer valid. Please sign in with Google again.');
  }, [notify]);

  async function signIn() {
    if (!supabase || !backendReady || busy) return;
    setBusy('signin');
    setMessage('');
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: new URL('/auth/callback', window.location.origin).href },
      });
      // Calendar scopes and offline Google access are requested separately when reminders are enabled.
      if (error) throw error;
    } catch {
      setMessage('Unable to start Google sign-in. Please try again.');
      setBusy(null);
    }
  }

  async function changeGoogleAccount(draft: SignupDraft) {
    if (busy) return;
    setSignupDraft(draft);
    setBusy('change');
    setMessage('');
    selectingAccount.current = true;
    setChecking(true);
    try {
      await startGoogleAccountSelection(draft);
    } catch {
      selectingAccount.current = false;
      setChecking(false);
      setBusy(null);
      notify('Unable to change Google account. Please try again.');
    }
  }

  async function signOut(cancelSignup = false) {
    if (!supabase || busy) return;
    cancellingSignup.current = cancelSignup;
    if (cancelSignup) setToast(null);
    setBusy('signout');
    setSignupDraft(undefined);
    setMessage('');
    try {
      const { error } = await supabase.auth.signOut({ scope: 'local' });
      if (error) throw error;
      setUser(null);
      if (!cancelSignup) notify('You have been signed out.');
    } catch {
      // Supabase can clear local storage even when the revocation request fails.
      const current = await supabase.auth.getSession().catch(() => null);
      if (current && !current.error && !current.data.session) {
        setUser(null);
        if (!cancelSignup) notify('Signed out on this device. Server sign-out could not be confirmed.');
      } else {
        setMessage(cancelSignup ? 'Unable to cancel sign-up. Please try again.' : 'Unable to sign out. Please try again.');
      }
    } finally {
      cancellingSignup.current = false;
      setBusy(null);
    }
  }

  return (
    <>
      {dashboardAccess && account && !checking ? <Dashboard key={`${account.id}:${account.role}`} account={account} avatarUrl={typeof user?.user_metadata.avatar_url === 'string' ? user.user_metadata.avatar_url : typeof user?.user_metadata.picture === 'string' ? user.user_metadata.picture : undefined} path={path} onNavigate={navigate} onSignOut={() => void signOut()} signingOut={busy === 'signout'} notify={notify} onSessionExpired={expireSession} onPatientProfileMissing={onPatientProfileMissing} /> : <PageLayout restoring={restoringAccount} accountCreation={Boolean(user && !restoringAccount && (!account || (['patient', 'driver'].includes(account.role) && account.status === 'active' && account.profile_complete !== true)))}>
      <section className={`entry-card ${user ? 'entry-card-account' : ''}`} aria-busy={checking || Boolean(busy)} aria-label={user ? 'Your account' : 'Sign in'}>
        {checking || (!user && supabase && !backendReady) ? <div className="account-loading" role="status" aria-label={checking ? 'Checking sign-in' : 'Connecting to service'}><span className="account-spinner" aria-hidden="true" /><span>Loading...</span></div> : user ? (
          <AccountPanel key={user.id} email={user.email} onSignOut={() => void signOut()} onCancel={() => void signOut(true)} onSessionExpired={expireSession} signingOut={busy === 'signout'} onAccountResolved={onAccountResolved} onLoadingChange={setAccountLoading} onChangeGoogleAccount={changeGoogleAccount} initialDraft={signupDraft} />
        ) : (
          <>
            <p className="entry-eyebrow">Your journey starts here</p>
            <h2 className="entry-title">Welcome back.</h2>
            <div className="signin-control" tabIndex={!supabase || !backendReady ? 0 : undefined} aria-describedby={!supabase || !backendReady ? 'signin-unavailable' : undefined}>
            <button type="button" onClick={signIn} disabled={!supabase || !backendReady || Boolean(busy)} className="google-signin" aria-describedby={!supabase || !backendReady ? 'signin-unavailable' : undefined}>
              <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none">
                <path fill="#4285F4" d="M21.6 12.23c0-.71-.06-1.39-.18-2.05H12v3.88h5.38a4.6 4.6 0 0 1-2 3.02v2.51h3.24c1.89-1.74 2.98-4.3 2.98-7.36Z" />
                <path fill="#34A853" d="M12 22c2.7 0 4.96-.9 6.62-2.41l-3.24-2.51c-.9.6-2.04.97-3.38.97-2.6 0-4.81-1.76-5.6-4.13H3.05v2.59A10 10 0 0 0 12 22Z" />
                <path fill="#FBBC05" d="M6.4 13.92a6 6 0 0 1 0-3.84V7.49H3.05a10 10 0 0 0 0 9.02l3.35-2.59Z" />
                <path fill="#EA4335" d="M12 5.95c1.47 0 2.79.51 3.82 1.51l2.87-2.87A9.6 9.6 0 0 0 12 2a10 10 0 0 0-8.95 5.49l3.35 2.59c.79-2.37 3-4.13 5.6-4.13Z" />
              </svg>
              <span>{busy === 'signin' ? 'Opening Google…' : 'Continue with Google'}</span>
            </button>
            {(!supabase || !backendReady) && <span id="signin-unavailable" role="tooltip" className="signin-tooltip">Sign-in is temporarily unavailable. Please try again shortly.</span>}
            </div>
            <p className="entry-note">One secure sign-in. For patients, caregivers, drivers and transport coordinators.</p>
          </>
        )}
        <p role="status" aria-live="polite" className="entry-message">{message}</p>
      </section>
      </PageLayout>}
      <ToastRegion announce>
        {toast && <Toast key={toast.id} message={toast.message} closing={toastClosing} onDismiss={() => setToast(null)} />}
    </ToastRegion>
    </>
  );
}
