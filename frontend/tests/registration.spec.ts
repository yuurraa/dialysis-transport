import { test, expect, cors, session, seedSession, submitSignup, expectHeaderContext, activeAccount, chooseOption, mockServices } from './support/fixtures';
import type { Page } from '@playwright/test';
test.beforeEach(mockServices);
function selectionSession() {
  const user = { ...session.user, id: '22222222-2222-4222-8222-222222222222', email: 'other@example.test' };
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const token = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: user.id, exp: 4102444800 })}.fixture`;
  return { ...session, access_token: token, refresh_token: 'selection-refresh-token', user };
}
async function beginGoogleSelection(page: Page) {
  await seedSession(page);
  await page.route('**/auth/v1/authorize**', route => route.fulfill({ contentType: 'text/html', body: 'Google account picker boundary' }));
  await page.goto('/');
  await page.getByLabel('Username').fill('savedpatient');
  await chooseOption(page.getByLabel('Role'), 'caregiver');
  await page.getByRole('button', { name: 'Change Google account' }).click();
  await page.waitForURL('https://auth.example.test/auth/v1/authorize**');
  const url = new URL(page.url());
  expect(url.searchParams.get('prompt')).toBe('select_account');
  expect(url.searchParams.get('code_challenge_method')).toBe('s256');
  expect(url.searchParams.get('redirect_to')).toBe('http://127.0.0.1:5199/auth/callback');
  expect(url.searchParams.get('scopes') ?? '').not.toContain('calendar');
}
test('registration errors keep entered details and allow retry without refresh controls', async ({ page }) => {
  await seedSession(page);
  await page.route('**/api/auth/register', route => route.fulfill({ status: 503, json: { message: 'PRIVATE_DATABASE_DETAIL' } }));
  await page.goto('/');
  await page.getByLabel('Username').fill('testpatient');
  await chooseOption(page.getByLabel('Role'), 'patient');
  await submitSignup(page);
  await expect(page.getByRole('alert')).toContainText('Unable to create your account. Please try again.');
  await expect(page.getByLabel('Street', { exact: true })).toHaveValue('Test street');
  await expect(page.getByRole('button', { name: /Refresh account|Sign out/ })).toHaveCount(0);
  await page.route('**/api/auth/register', route => route.fulfill({ status: 201, json: activeAccount }));
  await submitSignup(page);
  await expectHeaderContext(page);
});
test('signup shows the selected Google email as a disabled field and Cancel does not register', async ({ page }) => {
  await seedSession(page);
  let registrations = 0;
  await page.route('**/api/auth/register', route => { registrations++; return route.fulfill({ status: 500 }); });
  await page.route('**/auth/v1/logout?scope=local', route => route.request().method() === 'OPTIONS' ? route.fallback() : route.fulfill({ status: 204, headers: cors }));
  await page.goto('/');
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue('patient@example.test');
  await expect(page.getByLabel('Email', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Change Google account' })).toBeVisible();
  await page.getByLabel('Username').fill('cancelledpatient');
  await chooseOption(page.getByLabel('Role'), 'patient');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeEnabled();
  expect(await page.locator('.auth-toast').count()).toBe(0);
  expect(registrations).toBe(0);
  expect(await page.evaluate(() => localStorage.getItem('sb-auth-auth-token'))).toBeNull();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeEnabled();
});
test("switching to an already registered Google identity preserves the current signup", async ({ page }) => {
  const candidate = selectionSession();
  await page.route('**/auth/v1/token?grant_type=pkce', route => route.request().method() === 'OPTIONS' ? route.fallback() : route.fulfill({ headers: cors, json: candidate }));
  await page.route('**/auth/v1/user', route => route.request().method() === 'OPTIONS' ? route.fallback() : route.fulfill({ headers: cors, json: candidate.user }));
  let checkedCandidate = false;
  await page.route('**/api/auth/me', route => {
    const isCandidate = route.request().headers().authorization === `Bearer ${candidate.access_token}`;
    checkedCandidate ||= isCandidate;
    return route.fulfill({
      json: {
        account: isCandidate
          ? { ...activeAccount, email: candidate.user.email, status: 'active' } : null
      }
    });
  });
  await beginGoogleSelection(page);
  await page.goto('/auth/callback?code=selection-code');
  await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue('patient@example.test');
  await expect(page.getByLabel('Username')).toHaveValue('savedpatient');
  await expect(page.getByLabel('Role')).toHaveValue('caregiver');
  await expect(page).toHaveURL('http://127.0.0.1:5199/');
  expect(checkedCandidate).toBe(true);
  const selected = await page.evaluate(() => JSON.parse(localStorage.getItem('sb-auth-auth-token')!));
  expect(selected.user.id).toBe(session.user.id);
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('dialysis-signup-')))).toEqual([]);
  await expect(page.locator('body')).not.toContainText('PRIVATE_PROVIDER_DETAIL');
  await expect(page.locator('.auth-toast')).toHaveText(/Google account already in use/);
  await expect(page.getByRole('heading', { name: 'Your rides' })).toHaveCount(0);
  await page.route('**/api/auth/register', route => {
    expect(route.request().headers().authorization).toBe(`Bearer ${session.access_token}`);
    expect(route.request().postDataJSON()).toEqual({ displayName: 'savedpatient', role: 'caregiver' });
    return route.fulfill({ status: 201, json: { ...activeAccount, email: session.user.email, display_name: 'savedpatient', role: 'caregiver' } });
  });
  await submitSignup(page);
  await expect(page.getByRole('heading', { name: 'Your rides' })).toBeVisible();
});
test('patient signup stays in the landing box until final submission and Back preserves details', async ({ page }) => {
  await seedSession(page);
  let registered = false;
  let submissions = 0;
  await page.route('**/api/auth/me', route => route.fulfill({ json: { account: registered ? { ...activeAccount, profile_complete: true } : null } }));
  await page.route('**/api/auth/register', route => {
    submissions++;
    const body = route.request().postDataJSON();
    expect(body.profile.postal_code).toBe('560123');
    expect(body.profile.phone).toBe('+65 81234567');
    expect(body.profile.birth_date).toBe('1990-04-12');
    expect(body.profile.gender).toBe('female');
    expect(body.profile.status).toBeUndefined();
    registered = true;
    return route.fulfill({ status: 201, json: { ...activeAccount, profile_complete: true } });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByLabel('Username').fill('testpatient');
  await chooseOption(page.getByLabel('Role'), 'patient');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  expect(submissions).toBe(0);
  await expect(page).toHaveURL('http://127.0.0.1:5199/');
  await expect(page.locator('.entry-card .signup-profile')).toBeVisible();
  await expect(page.locator('.dashboard-page')).toHaveCount(0);
  await page.getByLabel('Full name', { exact: true }).fill('Test Patient');
  await expect(page.getByLabel('Country code', { exact: true })).toHaveCount(0);
  const contactField = page.getByLabel('Contact number', { exact: true });
  await contactField.fill('+65 81234567');
  expect(await contactField.evaluate((input: HTMLInputElement) => input.checkValidity())).toBe(true);
  await contactField.fill('abc');
  expect(await contactField.evaluate((input: HTMLInputElement) => input.checkValidity())).toBe(false);
  await page.getByLabel('Contact number', { exact: true }).fill('+65 81234567');
  await page.getByLabel('Street', { exact: true }).fill('Test street');
  await page.getByLabel('Postal code', { exact: true }).fill('560123');
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByLabel('Username')).toHaveValue('testpatient');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByLabel('Street', { exact: true })).toHaveValue('Test street');
  await submitSignup(page);
  await expect(page).toHaveURL(/\/dashboard\/trips$/);
  expect(submissions).toBe(1);
});

test('driver signup collects personal details, preserves Back state and retains existing dashboard navigation', async ({ page }) => {
  await seedSession(page);
  const profile = { full_name: 'Fixture Driver', phone: '+65 81234567', birth_date: '1990-04-12', gender: 'prefer-not-to-say' };
  let registrations = 0;
  await page.route('**/api/auth/register', route => {
    registrations++;
    expect(route.request().postDataJSON()).toEqual({ displayName: 'testdriver', role: 'driver', profile });
    return route.fulfill({ status: 201, json: { ...activeAccount, role: 'driver', full_name: profile.full_name } });
  });
  await page.route('**/api/profiles/driver', route => route.fulfill({ json: { driver: profile } }));
  await page.goto('/');
  await page.getByLabel('Username').fill('testdriver');
  await chooseOption(page.getByLabel('Role'), 'driver');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByLabel('Full name', { exact: true }).fill(profile.full_name);
  await page.getByLabel('Contact number', { exact: true }).fill(profile.phone);
  await page.getByLabel('Date of birth', { exact: true }).fill(profile.birth_date);
  await chooseOption(page.getByLabel('Gender', { exact: true }), profile.gender);
  expect(registrations).toBe(0);
  await expect(page.getByLabel('Street', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByLabel('Full name', { exact: true })).toHaveValue(profile.full_name);
  await expect(page.getByLabel('Date of birth', { exact: true })).toHaveValue(profile.birth_date);
  await submitSignup(page);
  await expect(page).toHaveURL(/\/dashboard\/trips$/);
  await expect(page.getByRole('link', { name: 'Register Vehicle', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await page.getByRole('link', { name: 'My Account', exact: true }).click();
  await expect(page.getByLabel('Full name', { exact: true })).toHaveValue(profile.full_name);
  await expect(page.getByLabel('Full name', { exact: true })).toBeDisabled();
  expect(registrations).toBe(1);
});
