import TripNotifications from '../components/TripNotifications';
import { DashboardViewStateProvider } from '../components/DashboardViewState';
import { ApiError, apiGet } from '../lib/api';
import { ListError, PageHeading } from '../components/DashboardUI';
import ThemeControl from '../components/ThemeControl';
import TreatmentSchedules from './TreatmentSchedules';
import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import DriverProfile from './DriverProfile';
import PatientProfile from './PatientProfile';
import PatientsPage from './PatientsPage';
import DriversPage from './DriversPage';
import DriverRegistration, { type DriverVehicle } from './DriverRegistration';
import DriverAvailability from './DriverAvailability';
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
  const [drawerVisible, setDrawerVisible] = useState(false);
  const drawerClosing = drawerVisible && !menuOpen;
  useEffect(() => {
    if (menuOpen) { setDrawerVisible(true); return; }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { setDrawerVisible(false); return; }
    const timeout = window.setTimeout(() => setDrawerVisible(false), 220);
    return () => window.clearTimeout(timeout);
  }, [menuOpen]);
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
    if (!drawerVisible || !panel) return;
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
  }, [drawerVisible]);
  const [unreadNotifications, setUnreadNotifications] = useState(0);
  useEffect(() => setUnreadNotifications(0), [account.id, account.role]);
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
  const driver = account.role === 'driver';
  const [driverRegistered, setDriverRegistered] = useState<boolean | null>(null);
  const [driverLoadError, setDriverLoadError] = useState(false);
  const [driverReload, setDriverReload] = useState(0);
  const vehicleChanged = useCallback((vehicle: DriverVehicle | null) => {
    setDriverRegistered(Boolean(vehicle?.registered_at || vehicle?.status === 'approved'));
  }, []);
  useEffect(() => {
    if (!driver) return;
    let active = true;
    setDriverLoadError(false); setDriverRegistered(null);
    apiGet<{ vehicle: DriverVehicle | null }>('/drivers/me').then(result => {
      if (active) vehicleChanged(result.vehicle);
    }).catch(reason => {
      if (!active) return;
      if (reason instanceof ApiError && reason.status === 401) onSessionExpired();
      setDriverLoadError(true);
    });
    return () => { active = false; };
  }, [driver, account.id, driverReload, vehicleChanged, onSessionExpired]);

  const tripDetailsId=path.match(/^\/dashboard\/trips\/([0-9a-f-]{36})$/i)?.[1]?.toLowerCase();
  const driverTripsPage = driver && (path === '/dashboard/trips'||!!tripDetailsId);
  const availabilityPage = driver && path === '/dashboard/availability';
  const driversPage = account.role === 'coordinator' && path === '/dashboard/drivers';
  const home = '/dashboard/trips';
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
    {driver ? <>
      <a href="/dashboard/trips" onClick={event => follow(event, '/dashboard/trips')} aria-current={driverTripsPage ? 'page' : undefined}>Trips</a>
      {driverRegistered !== null && <>
      {driverRegistered && <a href="/dashboard/availability" onClick={event => follow(event, '/dashboard/availability')} aria-current={availabilityPage ? 'page' : undefined}>Availability</a>}
      <a href="/dashboard/vehicle" onClick={event => follow(event, '/dashboard/vehicle')} aria-current={path === '/dashboard/vehicle' ? 'page' : undefined}>{driverRegistered ? 'My Vehicle' : 'Register Vehicle'}</a></>}
    </> : <a href="/dashboard/trips" onClick={event => follow(event, '/dashboard/trips')} aria-current={path === '/dashboard/trips'||tripDetailsId ? 'page' : undefined}>Trips</a>}
    {['patient', 'coordinator'].includes(account.role) && <a href="/dashboard/schedules" onClick={event => follow(event, '/dashboard/schedules')} aria-current={schedulesPage ? 'page' : undefined}>Schedules</a>}
    {account.role === 'coordinator' && <a href="/dashboard/patients" onClick={event => follow(event, '/dashboard/patients')} aria-current={patientsPage ? 'page' : undefined}>Patients</a>}
    {account.role === 'coordinator' && <a href="/dashboard/drivers" onClick={event => follow(event, '/dashboard/drivers')} aria-current={driversPage ? 'page' : undefined}>Drivers</a>}
  </nav>;

  return <DashboardViewStateProvider><div className="dashboard-page">
    <a className="dashboard-skip" href="#dashboard-main">Skip to content</a>
    <header className="dashboard-header">
      <div className="dashboard-header-inner">
        <a className="dashboard-brand" href={home} onClick={event => follow(event, home)} aria-label="Dialysis Transport dashboard">
          <span className="dashboard-brand-symbol" aria-hidden="true">DT</span><span>Dialysis Transport</span>
        </a>
        <div className="dashboard-top-navigation">{navigation}</div>
        <div className="dashboard-mobile-heading">
          <button className="dashboard-menu-toggle" ref={menuButton} type="button" aria-label="Open navigation" aria-haspopup="dialog" aria-expanded={menuOpen} aria-controls="dashboard-drawer" onClick={() => { setMenuOpen(true); setDropdown(null); }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
          </button>
          <span className="dashboard-mobile-mark" aria-label="Dialysis Transport">DT</span><span className="dashboard-mobile-title">{tripDetailsId?'Trip details':accountPage ? 'My Account' : driverTripsPage ? 'Trips' : driversPage ? 'Drivers' : availabilityPage ? 'Availability' : driver ? driverRegistered ? 'My Vehicle' : 'Register Vehicle' : patientsPage ? 'Patients' : schedulesPage ? 'Schedules' : 'Trips'}</span>
        </div>
        <div className="dashboard-account-actions" ref={headerActions}>
          <time className="dashboard-header-clock" dateTime={now.toISOString()} aria-label={`${date}, ${time} Singapore time`}><span className="dashboard-date-full">{date}</span><span className="dashboard-date-compact" aria-hidden="true">{compactDate}</span><span className="dashboard-clock">{time}</span></time>
          <ThemeControl />
          <button className="dashboard-icon-button" ref={notificationsButton} type="button" aria-label="Notifications" aria-expanded={dropdown === 'notifications'} aria-controls="dashboard-notifications" onClick={() => toggleDropdown('notifications')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></svg>{unreadNotifications > 0 && <span className="notification-unread-dot" aria-label={`${unreadNotifications} unread notifications`} />}
          </button>
          <button className="dashboard-icon-button" ref={accountButton} type="button" aria-label="Account" aria-expanded={dropdown === 'account'} aria-controls="dashboard-account-menu" onClick={() => toggleDropdown('account')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><circle cx="12" cy="9" r="3" /><path d="M6 19a6 6 0 0 1 12 0" /></svg>
          </button>
          {account.role !== 'caregiver' && <section className="dashboard-dropdown dashboard-notifications" id="dashboard-notifications" aria-label="Notifications" style={{display: dropdown === 'notifications' ? undefined : 'none'}}>
            <TripNotifications key={account.id} open={dropdown === 'notifications'} onUnread={setUnreadNotifications} onError={notify} onSessionExpired={onSessionExpired} onOpenTrip={trip=>{setDropdown(null);notificationsButton.current?.focus();onNavigate(`/dashboard/trips/${trip.id}`);}} />
          </section>}
          {account.role === 'caregiver' && dropdown === 'notifications' && <section className="dashboard-dropdown dashboard-notifications" id="dashboard-notifications" aria-label="Notifications"><h2>Notifications</h2><p className="dashboard-notification-status">Patient notifications will be available after caregiver linking is enabled.</p></section>}
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
    <main className="dashboard-main" id="dashboard-main" tabIndex={-1}>
      {driver && !accountPage && !driverTripsPage && driverLoadError ? <section className="dashboard-trips patients-panel page-panel"><ListError title="Driver dashboard could not be loaded" message="Your vehicle registration could not be loaded. Please try again." onRetry={() => setDriverReload(value => value + 1)} /></section> : driver && !accountPage && !driverTripsPage && driverRegistered === null ? <div className="account-loading patients-loading" role="status"><span className="account-spinner" aria-hidden="true" /><span>Loading...</span></div> : driversPage ? <DriversPage notify={notify} onSessionExpired={onSessionExpired} /> : availabilityPage ? <DriverAvailability notify={notify} onSessionExpired={onSessionExpired} vehicleRegistered={Boolean(driverRegistered)} onViewVehicle={() => onNavigate('/dashboard/vehicle')} /> : driverTripsPage ? <TripsPage coordinator={false} driver tripId={tripDetailsId} onNavigate={onNavigate} onSessionExpired={onSessionExpired} /> : driver && !accountPage ? <div className="patient-account-profile"><DriverRegistration notify={notify} onSessionExpired={onSessionExpired} registered={Boolean(driverRegistered)} onVehicleChange={vehicleChanged} /></div> : schedulesPage ? <TreatmentSchedules coordinator={account.role === 'coordinator'} notify={notify} onSessionExpired={onSessionExpired} /> : patientsPage ? <PatientsPage notify={notify} onSessionExpired={onSessionExpired} /> : accountPage && account.role === 'driver' ? <div className="patient-account-profile"><DriverProfile notify={notify} onSessionExpired={onSessionExpired} /></div> : accountPage ? <>{!patient && <section className="dashboard-trips" aria-labelledby={account.role === 'coordinator' ? 'account-details-title' : 'role-profile-title'}><PageHeading id={account.role === 'coordinator' ? 'account-details-title' : 'role-profile-title'} title="Account Details" eyebrow="Account Management" description={<span className="profile-id">{roleNames[account.role]} ID: {account.id}</span>} />{account.role === 'coordinator' && <fieldset className="patient-form-fields coordinator-account-fields" disabled aria-label="Coordinator account details">
        <div className="patient-field"><label htmlFor="coordinator-username">Username</label><input id="coordinator-username" value={account.display_name} readOnly autoComplete="username" /></div>
        <div className="patient-field"><label htmlFor="coordinator-email">Email</label><input id="coordinator-email" type="email" value={account.email} readOnly autoComplete="email" /></div>
        <div className="patient-field"><label htmlFor="coordinator-role">Role</label><input id="coordinator-role" value={roleNames[account.role]} readOnly /></div>
        <div className="patient-field"><label htmlFor="coordinator-status">Status</label><input id="coordinator-status" value={account.status === 'active' ? 'Active' : 'Inactive'} readOnly /></div>
      </fieldset>}</section>}{patient && <div className="patient-account-profile"><PatientProfile notify={notify} onSessionExpired={onSessionExpired} onProfileResolved={profileResolved} /></div>}</> : ['coordinator', 'patient'].includes(account.role) ? <TripsPage coordinator={account.role === 'coordinator'} tripId={tripDetailsId} onNavigate={onNavigate} onSessionExpired={onSessionExpired} /> : <div className="patient-home">
        <div className="patient-overview-top">
          <section className="dashboard-trips patient-next-pickup trip-next-summary" aria-labelledby="patient-pickup-title">
            <h2 id="patient-pickup-title">Next pickup</h2>
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
    <dialog className="dashboard-drawer" data-closing={drawerClosing} onAnimationEnd={event => { if (drawerClosing && event.target === event.currentTarget && event.animationName === 'drawer-exit') setDrawerVisible(false); }} ref={drawer} id="dashboard-drawer" aria-label="Menu navigation" onKeyDown={event => {
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
        <span className="dashboard-drawer-brand"><span className="dashboard-brand-symbol" aria-hidden="true">DT</span><span>Dialysis Transport</span></span>
        <button className="dashboard-drawer-close" ref={drawerClose} type="button" aria-label="Close navigation" onClick={() => setMenuOpen(false)}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6" /></svg>
        </button>
      </header>
      <p className="dashboard-eyebrow">Menu</p>
      {navigation}
    </dialog>
  </div></DashboardViewStateProvider>;
}
