import { PageHeading } from '../components/DashboardUI';
import TreatmentSchedules from './TreatmentSchedules';
import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import PatientProfile from './PatientProfile';
import PatientsPage from './PatientsPage';
import TripsPage from './TripsPage';
import { roleNames, type Account } from './AccountPanel';

const unavailableTripsIcon = <span className="dashboard-data-status-icon" aria-hidden="true"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="5" width="16" height="16" rx="3" /><path d="M8 3v4m8-4v4M4 11h16m-10 4 4 4m0-4-4 4" /></svg></span>;

interface Props {
  account: Account;
  avatarUrl?: string;
  path: string;
  onNavigate: (path: string, replace?: boolean) => void;
  onSignOut: () => void;
  signingOut: boolean;
  notify: (message: string) => void;
  onSessionExpired: () => void;
  onPatientProfileMissing: () => void;
}

/** Shared role workspace with server-authorized trip data for patients and coordinators. */
export default function Dashboard({ account, avatarUrl, path, onNavigate, onSignOut, signingOut, notify, onSessionExpired, onPatientProfileMissing }: Props) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const drawer = useRef<HTMLDialogElement>(null);
  const drawerClose = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 1051px)');
    const resized = () => { if (desktop.matches) setMenuOpen(false); };
    desktop.addEventListener('change', resized);
    return () => desktop.removeEventListener('change', resized);
  }, []);
  useEffect(() => {
    const panel = drawer.current;
    if (!menuOpen || !panel) return;
    const bodyOverflow = document.body.style.overflow;
    const rootOverflow = document.documentElement.style.overflow;
    panel.showModal();
    drawerClose.current?.focus();
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
    return () => {
      panel.close();
      document.body.style.overflow = bodyOverflow;
      document.documentElement.style.overflow = rootOverflow;
      if (menuButton.current?.getClientRects().length) menuButton.current.focus();
    };
  }, [menuOpen]);
  const [dropdown, setDropdown] = useState<'account' | 'notifications' | null>(null);
  const [avatarFailed, setAvatarFailed] = useState(false);
  const headerActions = useRef<HTMLDivElement>(null);
  const accountButton = useRef<HTMLButtonElement>(null);
  const notificationsButton = useRef<HTMLButtonElement>(null);
  useEffect(() => setAvatarFailed(false), [avatarUrl]);
  useEffect(() => { setDropdown(null); setMenuOpen(false); }, [path]);
  useEffect(() => {
    if (!dropdown) return;
    function dismissOutside(event: Event) {
      if (event.target instanceof Node && !headerActions.current?.contains(event.target)) setDropdown(null);
    }
    function dismissOnEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      setDropdown(null);
      (dropdown === 'account' ? accountButton : notificationsButton).current?.focus();
    }
    document.addEventListener('pointerdown', dismissOutside);
    document.addEventListener('focusin', dismissOutside);
    document.addEventListener('keydown', dismissOnEscape);
    return () => {
      document.removeEventListener('pointerdown', dismissOutside);
      document.removeEventListener('focusin', dismissOutside);
      document.removeEventListener('keydown', dismissOnEscape);
    };
  }, [dropdown]);
  function toggleDropdown(target: 'account' | 'notifications') {
    setDropdown(current => current === target ? null : target);
    setMenuOpen(false);
  }
  const patient = account.role === 'patient';
  const accountPage = path === '/dashboard/account';
  const profileResolved = useCallback((complete: boolean) => {
    if (!complete) onPatientProfileMissing();
  }, [onPatientProfileMissing]);
  const schedulesPage = ['patient', 'coordinator'].includes(account.role) && path === '/dashboard/schedules';
  const patientsPage = account.role === 'coordinator' && path === '/dashboard/patients';
  const date = new Intl.DateTimeFormat('en-SG', { dateStyle: 'full', timeZone: 'Asia/Singapore' }).format(now);
  const compactDate = new Intl.DateTimeFormat('en-SG', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Singapore' }).format(now);
  const time = new Intl.DateTimeFormat('en-SG', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Singapore' }).format(now);
  function follow(event: MouseEvent<HTMLAnchorElement>, target: string) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onNavigate(target);
    setDropdown(null);
    setMenuOpen(false);
    if (dropdown) {
      requestAnimationFrame(() => document.getElementById('dashboard-main')?.focus());
    }
  }

  const navigation = <nav className="dashboard-navigation" aria-label="Dashboard">
    <a href="/dashboard/trips" onClick={event => follow(event, '/dashboard/trips')} aria-current={path === '/dashboard/trips' ? 'page' : undefined}>Trips</a>
    {['patient', 'coordinator'].includes(account.role) && <a href="/dashboard/schedules" onClick={event => follow(event, '/dashboard/schedules')} aria-current={schedulesPage ? 'page' : undefined}>Schedules</a>}
    {account.role === 'coordinator' && <a href="/dashboard/patients" onClick={event => follow(event, '/dashboard/patients')} aria-current={patientsPage ? 'page' : undefined}>Patients</a>}
  </nav>;

  return <div className="dashboard-page">
    <a className="dashboard-skip" href="#dashboard-main">Skip to content</a>
    <header className="dashboard-header">
      <div className="dashboard-header-inner">
        <a className="dashboard-brand" href="/dashboard/trips" onClick={event => follow(event, '/dashboard/trips')} aria-label="Dialysis Transport dashboard">
          <span className="dashboard-brand-symbol" aria-hidden="true">DT</span><span>Dialysis Transport</span>
        </a>
        <div className="dashboard-mobile-heading">
          <button className="dashboard-menu-toggle" ref={menuButton} type="button" aria-label="Open navigation" aria-haspopup="dialog" aria-expanded={menuOpen} aria-controls="dashboard-drawer" onClick={() => { setMenuOpen(true); setDropdown(null); }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
          </button>
          <span className="dashboard-mobile-mark" aria-label="Dialysis Transport">DT</span><span className="dashboard-mobile-title">{accountPage ? 'My Account' : patientsPage ? 'Patients' : schedulesPage ? 'Schedules' : 'Trips'}</span>
        </div>
        <div className="dashboard-account-actions" ref={headerActions}>
          <time className="dashboard-header-clock" dateTime={now.toISOString()} aria-label={`${date}, ${time} Singapore time`}><span className="dashboard-date-full">{date}</span><span className="dashboard-date-compact" aria-hidden="true">{compactDate}</span><span className="dashboard-clock">{time}</span></time>
          <button className="dashboard-icon-button" ref={notificationsButton} type="button" aria-label="Notifications" aria-expanded={dropdown === 'notifications'} aria-controls="dashboard-notifications" onClick={() => toggleDropdown('notifications')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></svg>
          </button>
          <button className="dashboard-icon-button" ref={accountButton} type="button" aria-label="Account" aria-expanded={dropdown === 'account'} aria-controls="dashboard-account-menu" onClick={() => toggleDropdown('account')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><circle cx="12" cy="9" r="3" /><path d="M6 19a6 6 0 0 1 12 0" /></svg>
          </button>
          {dropdown === 'notifications' && <section className="dashboard-dropdown" id="dashboard-notifications" aria-label="Notifications">
            <h2>Notifications</h2>
            <p className="dashboard-notification-status">Notifications are currently unavailable.</p>
          </section>}
          {dropdown === 'account' && <section className="dashboard-dropdown" id="dashboard-account-menu" aria-label="Account">
            <div className="dashboard-profile">
              <span className="dashboard-profile-avatar" aria-hidden="true">{avatarUrl?.startsWith('https://') && !avatarFailed
                ? <img src={avatarUrl} alt="" referrerPolicy="no-referrer" onError={() => setAvatarFailed(true)} />
                : account.display_name.trim().slice(0, 2).toUpperCase()}</span>
              <div className="dashboard-profile-details"><div className="dashboard-profile-name"><strong>{account.display_name}</strong><span className="dashboard-access">{roleNames[account.role]}</span></div><span>{account.email}</span></div>
            </div>
            <div className="dashboard-dropdown-actions">
              <a aria-label="My Account" href="/dashboard/account" onClick={event => follow(event, '/dashboard/account')} aria-current={accountPage ? 'page' : undefined}>My Account</a>
              <button className="dashboard-signout" aria-label={signingOut ? 'Signing out…' : 'Sign out'} type="button" onClick={onSignOut} disabled={signingOut}>{signingOut ? 'Signing out…' : 'Sign Out'}</button>
            </div>
          </section>}
        </div>
      </div>
    </header>

    <div className="dashboard-workspace">
      <aside className="dashboard-sidebar">
        <p className="dashboard-eyebrow">Menu</p>
        {navigation}
      </aside>
    <main className="dashboard-main" id="dashboard-main" tabIndex={-1}>
      {schedulesPage ? <TreatmentSchedules coordinator={account.role === 'coordinator'} notify={notify} onSessionExpired={onSessionExpired} /> : patientsPage ? <PatientsPage notify={notify} onSessionExpired={onSessionExpired} /> : accountPage ? <>{!patient && <section className="dashboard-trips" aria-labelledby={account.role === 'coordinator' ? 'account-details-title' : 'role-profile-title'}><PageHeading id={account.role === 'coordinator' ? 'account-details-title' : 'role-profile-title'} title="Account Details" description={<span className="profile-id">{roleNames[account.role]} ID: {account.id}</span>} />{account.role === 'coordinator' && <dl className="dashboard-account-fields"><div><dt>Username</dt><dd>{account.display_name}</dd></div><div><dt>Email</dt><dd>{account.email}</dd></div><div><dt>Role</dt><dd>{roleNames[account.role]}</dd></div><div><dt>Status</dt><dd>Active</dd></div></dl>}</section>}{patient && <div className="patient-account-profile"><PatientProfile notify={notify} onSessionExpired={onSessionExpired} onProfileResolved={profileResolved} /></div>}</> : ['coordinator', 'patient'].includes(account.role) ? <TripsPage coordinator={account.role === 'coordinator'} onSessionExpired={onSessionExpired} /> : <div className="patient-home">
        <div className="patient-overview-top">
          <section className="dashboard-trips patient-next-pickup" aria-labelledby="patient-pickup-title">
            <PageHeading id="patient-pickup-title" title="Next pickup" eyebrow="Your next journey" level={2} actions={<span className="dashboard-access">Unavailable</span>} />
            <div className="patient-pickup-time"><span className="patient-journey-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg></span><div><strong aria-label="Pickup time unavailable">-</strong><p>Pickup time</p></div></div>
            <dl className="patient-trip-details">{['Dialysis centre', 'Driver', 'Vehicle', 'Return pickup'].map(label => <div key={label}><dt>{label}</dt><dd aria-label={`${label} unavailable`}>-</dd></div>)}</dl>
            <p className="patient-overview-note">Your pickup details are currently unavailable.</p>
          </section>

        </div>
        <section className="dashboard-trips patient-upcoming-rides" aria-labelledby="patient-rides-title">
          <PageHeading id="patient-rides-title" title="Your rides" eyebrow="Upcoming transport" level={2} />
          <div className="dashboard-data-status patients-status" role="status">{unavailableTripsIcon}<div><h3>Trip information is not available.</h3><p>Your upcoming rides will appear here.</p></div></div>
        </section>

      </div>}
    </main>
    </div>
    <dialog className="dashboard-drawer" ref={drawer} id="dashboard-drawer" aria-label="Menu navigation" onKeyDown={event => {
      if (event.key !== 'Tab') return;
      const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), a[href]'));
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first?.focus();
      }
    }} onCancel={event => { event.preventDefault(); setMenuOpen(false); }} onClose={() => setMenuOpen(false)} onClick={event => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) setMenuOpen(false);
    }}>
      <header className="dashboard-drawer-header">
        <span>Dialysis Transport</span>
        <button className="dashboard-icon-button" ref={drawerClose} type="button" aria-label="Close navigation" onClick={() => setMenuOpen(false)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
        </button>
      </header>
      <p className="dashboard-eyebrow">Menu</p>
      {navigation}
    </dialog>
    <footer className="dashboard-footer"><span>{`${roleNames[account.role]} Dashboard`}</span><span>2006-SCS1-X4</span></footer>
  </div>;
}
