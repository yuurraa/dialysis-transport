import { useSyncExternalStore } from 'react';
import type { Account } from './pages/AccountPanel';

/** The single statement of which dashboard pages exist and which accounts may open them. */
export interface DashboardRoute {
  path: string;
  /** A function when the label depends on the account's role. */
  label: string | ((account: Account) => string);
  allow: (account: Account) => boolean;
  /** Main navigation link; My Account lives in the account dropdown instead. */
  nav: boolean;
}

export const homePath = '/dashboard/trips' as const;

// Order is main navigation order.
export const dashboardRoutes = [
  { path: homePath, label: 'Trips', allow: () => true, nav: true },
  { path: '/dashboard/availability', label: 'Availability', allow: account => account.role === 'driver', nav: true },
  { path: '/dashboard/vehicle', label: 'My Vehicle', allow: account => account.role === 'driver', nav: true },
  { path: '/dashboard/schedules', label: 'Schedules', allow: account => account.role === 'patient' || account.role === 'caregiver' || account.role === 'coordinator', nav: true },
  { path: '/dashboard/patients', label: 'Patients', allow: account => account.role === 'coordinator', nav: true },
  { path: '/dashboard/caregivers', label: 'Caregivers', allow: account => account.role === 'coordinator', nav: true },
  { path: '/dashboard/drivers', label: 'Drivers', allow: account => account.role === 'coordinator', nav: true },
  { path: '/dashboard/connections', label: account => account.role === 'patient' ? 'Caregivers' : 'Patient', allow: account => account.role === 'patient' || account.role === 'caregiver', nav: true },
  { path: '/dashboard/account', label: 'My Account', allow: () => true, nav: false },
  { path: '/dashboard/trips/:tripId', label: 'Trip details', allow: () => true, nav: false },
] as const satisfies readonly DashboardRoute[];

export type DashboardPath = typeof dashboardRoutes[number]['path'];

export function routesFor(account: Account): readonly (DashboardRoute & { path: DashboardPath })[] {
  return dashboardRoutes.filter(route => route.allow(account));
}

const uuid = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** The route an account may open at this path, with its `:param` segment (a UUID) when the route has one. */
export function matchRoute(account: Account, path: string): { route: ReturnType<typeof routesFor>[number]; id?: string } | undefined {
  for (const route of routesFor(account)) {
    const [base, param] = route.path.split('/:');
    if (!param) {
      if (path === route.path) return { route };
    } else if (path.startsWith(`${base}/`) && uuid.test(path.slice(base.length + 1))) {
      return { route, id: path.slice(base.length + 1).toLowerCase() };
    }
  }
}

export function navigate(target: string, replace = false) {
  window.history[replace ? 'replaceState' : 'pushState'](null, '', target);
  window.scrollTo(0, 0);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function subscribe(changed: () => void) {
  window.addEventListener('popstate', changed);
  return () => window.removeEventListener('popstate', changed);
}

/** Current pathname, re-read on every render so direct history writes are never stale. */
export function usePath() {
  return useSyncExternalStore(subscribe, () => window.location.pathname);
}
