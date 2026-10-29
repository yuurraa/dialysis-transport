import type { Page } from '@playwright/test';
import { test, expect, seedSession, activeAccount, mockServices } from './support/fixtures';

test.beforeEach(mockServices);

// Characterisation of the role guards: every role deep-links to every dashboard page.
const tripDetails = 'trips/11111111-2222-4333-8444-555555555555';
const titles = (role: string): Record<string, string> => ({ trips: 'Trips', account: 'My Account', schedules: 'Schedules', patients: 'Patients', caregivers: 'Caregivers', drivers: 'Drivers', connections: role === 'patient' ? 'Caregivers' : 'Patient', availability: 'Availability', vehicle: 'Register Vehicle', [tripDetails]: 'Trip details' });
const allowed: Record<string, string[]> = {
  coordinator: ['trips', 'account', 'schedules', 'patients', 'caregivers', 'drivers', tripDetails],
  patient: ['trips', 'account', 'schedules', 'connections', tripDetails],
  caregiver: ['trips', 'account', 'schedules', 'connections', tripDetails],
  driver: ['trips', 'account', 'availability', 'vehicle', tripDetails],
};

async function signInAs(page: Page, role: string) {
  await seedSession(page);
  await page.route('**/api/auth/me', route => route.fulfill({ json: { account: { ...activeAccount, role } } }));
}

async function expectPage(page: Page, name: string, role = 'patient') {
  await expect(page.locator('.dashboard-page')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/dashboard/${name}$`));
  await expect(page.locator('.dashboard-mobile-title')).toHaveText(titles(role)[name]);
}

for (const [role, pages] of Object.entries(allowed)) {
  test(`${role} deep links land on permitted pages and redirect elsewhere to Trips`, async ({ page }) => {
    await signInAs(page, role);
    for (const name of Object.keys(titles(role))) {
      await page.goto(`/dashboard/${name}`);
      await expectPage(page, pages.includes(name) ? name : 'trips', role);
    }
  });
}

test('dashboard root, unknown, legacy profile and callback paths redirect', async ({ page }) => {
  await signInAs(page, 'patient');
  for (const [from, to] of [['/dashboard', 'trips'], ['/dashboard/x', 'trips'], ['/dashboard/trips/not-a-uuid', 'trips'], ['/dashboard/profile', 'account'], ['/auth/callback', 'trips']]) {
    await page.goto(from);
    await expectPage(page, to);
  }
});

test('trip details keep Trips as the current navigation link', async ({ page }) => {
  await signInAs(page, 'coordinator');
  await page.goto(`/dashboard/${tripDetails}`);
  await expectPage(page, tripDetails, 'coordinator');
  await expect(page.locator('.dashboard-top-navigation [aria-current="page"]')).toHaveText('Trips');
});

test('signed-out dashboard links return to sign-in', async ({ page }) => {
  await page.goto('/dashboard/trips');
  await expect(page).toHaveURL(/127\.0\.0\.1:5199\/$/);
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
  await expect(page.locator('.dashboard-page')).toHaveCount(0);
});

test('Back and Forward render the page in the address bar', async ({ page }) => {
  await signInAs(page, 'coordinator');
  await page.goto('/dashboard/trips');
  const current = page.locator('.dashboard-top-navigation [aria-current="page"]');
  await expect(current).toHaveText('Trips');
  await page.locator('.dashboard-top-navigation').getByRole('link', { name: 'Schedules', exact: true }).click();
  await expectPage(page, 'schedules');
  await expect(current).toHaveText('Schedules');
  await page.goBack();
  await expectPage(page, 'trips');
  await expect(current).toHaveText('Trips');
  await page.goForward();
  await expectPage(page, 'schedules');
  await expect(current).toHaveText('Schedules');
});
