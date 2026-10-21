import { test, expect, cors, session, seedSession, openAccountDropdown, activeAccount, mockServices } from './support/fixtures';

test.beforeEach(mockServices);

test('starts PKCE Google login and returns to this browser origin without Calendar access', async ({ page }) => {
  await page.route('**/auth/v1/authorize**', route => route.fulfill({ contentType: 'text/html', body: 'Google OAuth boundary' }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await page.waitForURL('https://auth.example.test/auth/v1/authorize**');
  const url = new URL(page.url());
  expect(url.searchParams.get('provider')).toBe('google');
  expect(url.searchParams.get('redirect_to')).toBe('http://127.0.0.1:5199/auth/callback');
  expect(url.searchParams.get('code_challenge_method')).toBe('s256');
  expect(url.searchParams.get('code_challenge')).toBeTruthy();
  expect(url.searchParams.get('scopes') ?? '').not.toContain('calendar');
});

test('exchanges a returned code and shows identity without granting a role dashboard', async ({ page }) => {
  await page.route('**/auth/v1/authorize**', route => route.fulfill({ contentType: 'text/html', body: 'Google OAuth boundary' }));
  await page.route('**/auth/v1/token?grant_type=pkce', async route => {
    if (route.request().method() === 'OPTIONS') return route.fallback();
    const body = route.request().postDataJSON();
    expect(body.auth_code).toBe('fixture-code');
    expect(body.code_verifier).toBeTruthy();
    await route.fulfill({ headers: cors, json: session });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await page.waitForURL('https://auth.example.test/auth/v1/authorize**');
  await page.goto('/auth/callback?code=fixture-code');
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue('patient@example.test');
  await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your rides' })).toHaveCount(0);
  await expect(page).toHaveURL('http://127.0.0.1:5199/');
});

test('logout clears the session and protects reload and browser Back', async ({ page }) => {
  await seedSession(page);
  await page.route('**/api/auth/me', route => route.fulfill({ json: { account: activeAccount } }));
  await page.route('**/auth/v1/logout?scope=local', route => route.request().method() === 'OPTIONS' ? route.fallback() : route.fulfill({ status: 204, headers: cors }));
  await page.goto('/');
  await openAccountDropdown(page);
  await page.getByRole('link', { name: 'My Account', exact: true }).click();
  await openAccountDropdown(page);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeEnabled();
  expect(await page.evaluate(() => localStorage.getItem('sb-auth-auth-token'))).toBeNull();
  await page.goBack();
  await expect(page.locator('.dashboard-page')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeEnabled();
});

test('shows a safe retry message for a denied OAuth callback and removes provider details', async ({ page }) => {
  await page.goto('/auth/callback?error=access_denied&error_description=PRIVATE_PROVIDER_DETAIL');
  await expect(page.getByRole('status').first()).toContainText('Google sign-in could not be completed. Please try again.');
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeEnabled();
  await expect(page.locator('body')).not.toContainText('PRIVATE_PROVIDER_DETAIL');
  await expect(page).toHaveURL('http://127.0.0.1:5199/');
});

test('returns to login when an expired session can no longer be refreshed', async ({ page }) => {
  await seedSession(page, true);
  await page.route('**/auth/v1/token?grant_type=refresh_token', route => route.request().method() === 'OPTIONS' ? route.fallback() : route.fulfill({
    status: 400, headers: cors, json: { code: 'refresh_token_not_found', message: 'Refresh token is unavailable.' },
  }));
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeEnabled();
  await expect(page.getByText('patient@example.test', { exact: true })).toHaveCount(0);
});

test('inactive accounts stay restricted and cannot register again', async ({ page }) => {
  await seedSession(page);
  await page.route('**/api/auth/me', route => route.fulfill({ json: { account: { ...activeAccount, status: 'inactive' } } }));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Account inactive' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your rides' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sign Up', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
});

test('a sign-out event during account lookup cannot reveal a stale role view', async ({ page }) => {
  await seedSession(page);
  let release: () => void = () => { };
  let started: () => void = () => { };
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const requested = new Promise<void>(resolve => { started = resolve; });
  await page.route('**/api/auth/me', async route => { started(); await waiting; await route.fulfill({ json: { account: { ...activeAccount, role: 'coordinator' } } }); });
  await page.route('**/auth/v1/logout?scope=local', route => route.request().method() === 'OPTIONS' ? route.fallback() : route.fulfill({ status: 204, headers: cors }));
  await page.goto('/');
  await requested;
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toHaveCount(0);
  // Session revocation can arrive outside the form, e.g. through another tab.
  await page.evaluate(async () => {
    const modulePath = '/src/lib/supabase.ts';
    const { supabase } = await import(modulePath);
    await supabase.auth.signOut({ scope: 'local' });
  });
  release();
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Transport operations' })).toHaveCount(0);
});

test('a cached session rejected by the backend is cleared and returns to Google sign-in', async ({ page }) => {
  await seedSession(page);
  await page.route('**/api/auth/me', route => route.fulfill({ status: 401, json: { message: 'Invalid or expired sign-in.' } }));
  await page.route('**/auth/v1/logout?scope=local', route => route.request().method() === 'OPTIONS' ? route.fallback() : route.fulfill({ status: 204, headers: cors }));
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeEnabled();
  await expect(page.locator('.toast-region')).toContainText('Your session is no longer valid. Please sign in with Google again.');
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('sb-auth-auth-token'))).toBeNull();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeEnabled();
});
