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
  const administrator={...activeAccount,role:'coordinator',demo_admin:true};
  const cohort='22222222-2222-4222-8222-222222222222';
  const actor={...activeAccount,id:'33333333-3333-4333-8333-333333333333',auth_user_id:'33333333-3333-4333-8333-333333333333',display_name:'Fictional Coordinator',role:'coordinator',demo_admin:false,demo_access_owner_id:cohort};
  const demo={operator_id:administrator.id,cohort_owner_id:cohort,actors:[actor],scenario:{trip_id:'44444444-4444-4444-8444-444444444444',traffic:'normal',progress:0},trip:null};
  await page.route('**/api/auth/me', route => route.fulfill({ json: { account: administrator } }));
  await page.route('**/api/demo', route => route.fulfill({json:demo}));
  await page.route('**/api/demo/switch', route => route.fulfill({json:{access_token:'demo-actor-token',expires_at:4102444800,account:actor}}));
  await page.route('**/auth/v1/logout?scope=local', route => route.request().method() === 'OPTIONS' ? route.fallback() : route.fulfill({ status: 204, headers: cors }));
  await page.goto('/');
  // A second administrator returns to their own account, not the shared cohort owner.
  await openAccountDropdown(page);
  await page.getByRole('button',{name:'Demo Tools',exact:true}).click();
  await page.getByLabel('View as').selectOption(actor.id);
  await expect(page.getByRole('complementary',{name:'Demo session'})).toBeVisible();
  await page.getByRole('button',{name:'Controls',exact:true}).click();
  await expect(page.getByRole('option',{name:'Your coordinator account'})).toHaveAttribute('value',administrator.id);
  await page.getByLabel('View as').selectOption(administrator.id);
  await expect(page.getByRole('complementary',{name:'Demo session'})).toHaveCount(0);
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
