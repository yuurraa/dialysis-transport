import { test, expect, type Page, type Locator } from '@playwright/test';

export { test, expect };

export const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS' };

export const session = {
  access_token: 'fixture-access-token',
  token_type: 'bearer',
  refresh_token: 'fixture-refresh-token',
  expires_in: 3600,
  expires_at: 4102444800,
  user: {
    id: '11111111-1111-4111-8111-111111111111',
    aud: 'authenticated',
    role: 'authenticated',
    email: 'patient@example.test',
    email_confirmed_at: '2026-01-01T00:00:00Z',
    app_metadata: { provider: 'google', providers: ['google'] },
    user_metadata: {},
    identities: [],
    created_at: '2026-01-01T00:00:00Z',
  },
};

export const activeAccount = { id: '55555555-5555-4555-8555-555555555555', email: 'patient@example.test', display_name: 'testpatient', role: 'patient', status: 'active', profile_complete: true };

export const fixtureTrip = { id: 'trip-1', version: 1, patient_id: session.user.id, patient_name: 'Test Patient', source_schedule_id: '88888888-8888-4888-8888-888888888888', session_date: '2026-10-21', direction: 'outbound', origin: 'Fixture home', destination: 'Fixture Centre', treatment_start: '2026-10-21T09:00:00+08:00', treatment_end: '2026-10-21T13:00:00+08:00', arrival_by: '2026-10-21T08:45:00+08:00', pickup_not_before: null, pickup_at: null, review_required: false, status: 'unfilled', created_at: '2026-10-21T00:00:00Z' };

export async function chooseOption(control: Locator, value: string) {
  if (await control.evaluate(element => element.tagName) === 'SELECT') { await control.selectOption(value); return; }
  const label = (await control.getAttribute('aria-label'))!;
  await control.click();
  const list = control.page().getByRole('listbox', { name: label, exact: true });
  await list.locator(`[data-value="${value}"]`).click();
}

export async function seedSession(page: Page, expired = false) {
  await page.addInitScript(value => {
    if (!sessionStorage.getItem('fixture-seeded')) {
      localStorage.setItem('sb-auth-auth-token', JSON.stringify(value));
      sessionStorage.setItem('fixture-seeded', 'yes');
    }
  }, { ...session, expires_at: expired ? 1 : session.expires_at });
}

async function advanceSignup(page: Page) {
  const role = await page.getByLabel('Role').inputValue();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  if (role === 'patient') {
    await page.getByLabel('Full name', { exact: true }).fill('Test Patient');
    await page.getByLabel('Contact number', { exact: true }).fill('+65 81234567');
    await page.getByLabel('Street', { exact: true }).fill('Test street');
    await page.getByLabel('Postal code', { exact: true }).fill('560123');
  }
}

export async function submitSignup(page: Page) {
  if (await page.getByRole('button', { name: 'Next', exact: true }).isVisible()) await advanceSignup(page);
  await page.getByRole('button', { name: 'Sign Up', exact: true }).click();
}

export async function openAccountDropdown(page: Page) {
  const button = page.getByRole('button', { name: 'Account', exact: true });
  await expect(button).toBeVisible();
  if (await button.getAttribute('aria-expanded') === 'false') await button.click();
}

export async function expectHeaderContext(page: Page) {
  if ((page.viewportSize()?.width ?? 1280) <= 760) {
    await expect(page.locator('.dashboard-header-clock')).toBeHidden();
    await expect(page.locator('.dashboard-mobile-title')).toBeVisible();
  } else await expect(page.locator('.dashboard-header-clock')).toBeVisible();
}

// API/Auth boundaries use fixtures; React runs unchanged and unexpected Auth traffic is denied.
export async function mockServices({ page }: { page: Page }) {
  await page.route('**/api/trips?*', route => route.fulfill({ status: 503, json: {} }));
  await page.route('**/api/profiles/patient', route => route.fulfill({ json: { patient: { id: session.user.id, full_name: 'Test Patient', phone: '+65 81234567', pickup_address: 'Test street', unit_no: '', postal_code: '560123', notes: '', mobility: 'ambulant', assistance_required: false, status: 'active' } } }));
  await page.route('**/api/auth/me', route => route.fulfill({ json: { id: session.user.id, email: session.user.email, account: null } }));
  await page.route('**/api/health', route => route.fulfill({ json: { status: 'ok' } }));
  // Unhandled fixture-host traffic is denied, never sent to the real shared project.
  await page.route('https://auth.example.test/**', route => route.fulfill(route.request().method() === 'OPTIONS' ? { status: 204, headers: cors } : {
    status: 400, headers: cors, json: { code: 'unexpected_request', message: 'Fixture endpoint not configured.' },
  }));
}
