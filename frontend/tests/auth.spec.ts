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
