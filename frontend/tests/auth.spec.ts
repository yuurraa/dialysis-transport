import { test, expect, type Page } from '@playwright/test';

// Only the external Auth HTTP boundary is simulated; React and Supabase JS run unchanged.
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
const session = {
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

async function seedSession(page: Page, expired = false) {
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
async function submitSignup(page: Page) {
  if (await page.getByRole('button', { name: 'Next', exact: true }).isVisible()) await advanceSignup(page);
  await page.getByRole('button', { name: 'Sign Up', exact: true }).click();
}

async function openAccountDropdown(page: Page) {
  const button = page.getByRole('button', { name: 'Account', exact: true });
  await expect(button).toBeVisible();
  if (await button.getAttribute('aria-expanded') === 'false') await button.click();
}

test.beforeEach(async ({ page }) => {
  await page.route('**/api/profiles/patient', route => route.fulfill({ json: { patient: { id: session.user.id, full_name: 'Test Patient', phone: '+65 81234567', pickup_address: 'Test street', unit_no: '', postal_code: '560123', notes: '', mobility: 'ambulant', assistance_required: false, status: 'active' } } }));
  await page.route('**/api/auth/me', route => route.fulfill({ json: { id: session.user.id, email: session.user.email, account: null } }));
  await page.route('**/api/health', route => route.fulfill({ json: { status: 'ok' } }));
  // Unhandled fixture-host traffic is denied, never sent to the real shared project.
  await page.route('https://auth.example.test/**', route => route.fulfill(route.request().method() === 'OPTIONS' ? { status: 204, headers: cors } : {
    status: 400, headers: cors, json: { code: 'unexpected_request', message: 'Fixture endpoint not configured.' },
  }));
});

test('offers Google sign-in without collecting an application password', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeEnabled();
  await expect(page.locator('input[type=password]')).toHaveCount(0);
});

test('unavailable backend shows a labelled spinner and restores sign-in on focus', async ({ page }) => {
  await page.route('**/api/health', route => route.fulfill({ status: 503, json: { status: 'unavailable' } }));
  await page.goto('/');
  await expect(page.getByRole('status', { name: 'Connecting to service' })).toBeVisible();
  await expect(page.locator('.entry-card')).toHaveText('Loading...');
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toHaveCount(0);
  await page.route('**/api/health', route => route.fulfill({ json: { status: 'ok' } }));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeEnabled();
  await expect(page.locator('.account-spinner')).toHaveCount(0);
});

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

test('restores a saved session after reloading', async ({ page }) => {
  await seedSession(page);
  await page.route('**/api/auth/me', route => route.fulfill({ json: { account: activeAccount } }));
  await page.goto('/');
  await openAccountDropdown(page);
  await expect(page.getByText('patient@example.test', { exact: true })).toBeVisible();
  await page.reload();
  await openAccountDropdown(page);
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toHaveCount(0);
});

test('signs out locally and returns to login after a reload', async ({ page }) => {
  await seedSession(page);
  await page.route('**/api/auth/me', route => route.fulfill({ json: { account: activeAccount } }));
  await page.route('**/auth/v1/logout?scope=local', route => route.request().method() === 'OPTIONS' ? route.fallback() : route.fulfill({ status: 204, headers: cors }));
  await page.goto('/');
  await openAccountDropdown(page);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeEnabled();
  expect(await page.evaluate(() => localStorage.getItem('sb-auth-auth-token'))).toBeNull();
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

test('clears the local identity but reports when server sign-out cannot be confirmed', async ({ page }) => {
  await seedSession(page);
  await page.route('**/api/auth/me', route => route.fulfill({ json: { account: activeAccount } }));
  await page.route('**/auth/v1/logout?scope=local', route => route.request().method() === 'OPTIONS' ? route.fallback() : route.fulfill({
    status: 400, headers: cors, json: { code: 'unexpected_failure', message: 'PRIVATE_PROVIDER_DETAIL' },
  }));
  await page.goto('/');
  await openAccountDropdown(page);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.locator('.toast-region')).toContainText('Signed out on this device. Server sign-out could not be confirmed.');
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeEnabled();
  await expect(page.getByText('patient@example.test', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('sb-auth-auth-token'))).toBeNull();
});

const activeAccount = { id: '55555555-5555-4555-8555-555555555555', email: 'patient@example.test', display_name: 'testpatient', role: 'patient', status: 'active', profile_complete: true };

test('welcome uses the profile full name but coordinators keep their username', async ({ page }) => {
  await seedSession(page);
  for (const role of ['patient', 'driver', 'caregiver', 'coordinator']) {
    await page.route('**/api/auth/me', route => route.fulfill({ json: { account: { ...activeAccount, role, full_name: 'Alex Tan' } } }));
    await page.goto('/dashboard/trips');
    await expect(page.getByRole('heading', { name: `Welcome back, ${role === 'coordinator' ? activeAccount.display_name : 'Alex Tan'}.`, exact: true })).toBeVisible();
  }
});

test('patient signup collects profile before account creation and survives reload on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seedSession(page);
  let saved: typeof activeAccount | null = null;
  await page.route('**/api/auth/me', route => route.fulfill({ json: { id: session.user.id, account: saved } }));
  await page.route('**/api/auth/register', async route => {
    expect(route.request().headers().authorization).toBe('Bearer fixture-access-token');
    expect(route.request().postDataJSON()).toMatchObject({ displayName: 'testpatient', role: 'patient', profile: { postal_code: '560123', phone: '+65 81234567' } });
    saved = activeAccount;
    await route.fulfill({ status: 201, json: saved });
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Refresh account|Use another Google account/ })).toHaveCount(0);
  await expect(page.getByLabel('Role').locator('option')).toHaveText(['Choose a role', 'Patient', 'Caregiver', 'Driver']);
  await page.getByLabel('Username').fill('testpatient');
  await page.getByLabel('Role').selectOption('patient');
  await submitSignup(page);
  await expect(page.getByRole('heading', { name: /^Welcome back,/ })).toBeVisible();
  await openAccountDropdown(page);
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Awaiting approval' })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: /^Welcome back,/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign Up', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

for (const [role, heading] of [['driver', 'Your rides'], ['caregiver', 'Your rides'], ['coordinator', "Today's trips"]]) {
  test(`opens the active ${role} view without an account approval queue`, async ({ page }) => {
    await seedSession(page);
    await page.route('**/api/auth/me', route => route.fulfill({ json: { account: { ...activeAccount, role } } }));
    await page.goto('/');
    await expect(page.getByRole('heading', { name: heading })).toBeVisible();
    await expect(page.getByRole('button', { name: /Approve|Refresh account|Refresh registrations/ })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Pending registrations' })).toHaveCount(0);
    await openAccountDropdown(page);
    await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  });
}

test('inactive accounts stay restricted and cannot register again', async ({ page }) => {
  await seedSession(page);
  await page.route('**/api/auth/me', route => route.fulfill({ json: { account: { ...activeAccount, status: 'inactive' } } }));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Account inactive' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your rides' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sign Up', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
});

test('unavailable account service shows a labelled spinner and recovers automatically', async ({ page }) => {
  await seedSession(page);
  await page.clock.install();
  await page.route('**/api/auth/me', route => route.fulfill({ status: 503, json: { message: 'PRIVATE_DATABASE_DETAIL' } }));
  await page.goto('/');
  await expect(page.getByRole('status', { name: 'Reconnecting to account service' })).toBeVisible();
  await expect(page.locator('.account-loading')).toHaveText('Loading...');
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Create your account' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('PRIVATE_DATABASE_DETAIL');
  await page.route('**/api/auth/me', route => route.fulfill({ json: { account: activeAccount } }));
  await page.clock.fastForward(5100);
  await expect(page.getByRole('heading', { name: /^Welcome back,/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toHaveCount(0);
});

test('registration errors keep entered details and allow retry without refresh controls', async ({ page }) => {
  await seedSession(page);
  await page.route('**/api/auth/register', route => route.fulfill({ status: 503, json: { message: 'PRIVATE_DATABASE_DETAIL' } }));
  await page.goto('/');
  await page.getByLabel('Username').fill('testpatient');
  await page.getByLabel('Role').selectOption('patient');
  await submitSignup(page);
  await expect(page.getByRole('alert')).toContainText('Unable to create your account. Please try again.');
  await expect(page.getByLabel('Street', { exact: true })).toHaveValue('Test street');
  await expect(page.getByRole('button', { name: /Refresh account|Sign out/ })).toHaveCount(0);
  await page.route('**/api/auth/register', route => route.fulfill({ status: 201, json: activeAccount }));
  await submitSignup(page);
  await expect(page.getByRole('heading', { name: /^Welcome back,/ })).toBeVisible();
});

test('a sign-out event during account lookup cannot reveal a stale role view', async ({ page }) => {
  await seedSession(page);
  let release: () => void = () => {};
  let started: () => void = () => {};
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

test('a session rejected during signup returns to sign-in rather than trapping the form', async ({ page }) => {
  await seedSession(page);
  await page.route('**/api/auth/register', route => route.fulfill({ status: 401, json: { message: 'Invalid or expired sign-in.' } }));
  await page.route('**/auth/v1/logout?scope=local', route => route.request().method() === 'OPTIONS' ? route.fallback() : route.fulfill({ status: 204, headers: cors }));
  await page.goto('/');
  await page.getByLabel('Username').fill('testpatient');
  await page.getByLabel('Role').selectOption('patient');
  await submitSignup(page);
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeEnabled();
  await expect(page.locator('.toast-region')).toContainText('Your session is no longer valid. Please sign in with Google again.');
  expect(await page.evaluate(() => localStorage.getItem('sb-auth-auth-token'))).toBeNull();
});


test('an older failed health check cannot override a newer successful check', async ({ page }) => {
  await page.goto('/');
  const button = page.getByRole('button', { name: 'Continue with Google' });
  await expect(button).toBeEnabled();
  let release: () => void = () => {};
  let started: () => void = () => {};
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const requested = new Promise<void>(resolve => { started = resolve; });
  await page.route('**/api/health', async route => {
    started();
    await waiting;
    await route.fulfill({ status: 503, json: { status: 'unavailable' } });
  }, { times: 1 });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await requested;
  const newer = page.waitForResponse('**/api/health');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await newer;
  await expect(button).toBeEnabled();
  const older = page.waitForResponse(response => response.url().endsWith('/api/health') && response.status() === 503);
  release();
  await older;
  // Wait beyond React's response update; the stale failure must never disable sign-in.
  await page.waitForTimeout(100);
  await expect(button).toBeEnabled();
});

async function expectToastToFade(page: Page) {
  await page.waitForFunction(() => document.querySelector('.auth-toast')?.getAnimations().some(animation =>
    (animation as CSSAnimation).animationName === 'toast-exit'), undefined, { timeout: 4000 });
  const opacity = await page.locator('.auth-toast').evaluate(element => {
    const exit = element.getAnimations().find(animation => (animation as CSSAnimation).animationName === 'toast-exit')!;
    exit.pause();
    exit.currentTime = 90;
    return Number(getComputedStyle(element).opacity);
  });
  expect(opacity).toBeGreaterThan(0);
  expect(opacity).toBeLessThan(1);
  await page.locator('.auth-toast').evaluate(element => element.getAnimations().forEach(animation => animation.play()));
  await expect(page.locator('.auth-toast')).toHaveCount(0);
}

test('sign-out toast is separate from the card, pauses while focused and closes automatically', async ({ page }) => {
  await seedSession(page);
  await page.route('**/api/auth/me', route => route.fulfill({ json: { account: activeAccount } }));
  await page.route('**/auth/v1/logout?scope=local', route => route.request().method() === 'OPTIONS' ? route.fallback() : route.fulfill({ status: 204, headers: cors }));
  await page.goto('/');
  await openAccountDropdown(page);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  const toast = page.locator('.auth-toast');
  await expect(toast).toContainText('You have been signed out.');
  await expect(page.locator('.entry-card')).not.toContainText('You have been signed out.');
  await expect(page.locator('.toast-region')).toHaveAttribute('role', 'status');
  await toast.getByRole('button', { name: 'Dismiss notification' }).focus();
  await expect(page.locator('.toast-progress')).toHaveCSS('animation-play-state', 'paused');
  await page.waitForTimeout(3200);
  await expect(toast).toBeVisible();
  await page.getByRole('button', { name: 'Continue with Google' }).focus();
  await expect(page.locator('.toast-progress')).toHaveCSS('animation-play-state', 'running');
  await expect.poll(() => page.locator('.toast-progress').evaluate(element => element.getAnimations()[0]?.effect?.getComputedTiming().progress ?? 0)).toBeGreaterThan(0.05);
  await expectToastToFade(page);
});

test('a sign-out event outside the account panel shows a dismissible toast', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await seedSession(page);
  await page.route('**/auth/v1/logout?scope=local', route => route.request().method() === 'OPTIONS' ? route.fallback() : route.fulfill({ status: 204, headers: cors }));
  await page.goto('/');
  await expect(page.getByLabel('Username')).toBeVisible();
  await page.evaluate(async () => {
    const modulePath = '/src/lib/supabase.ts';
    const { supabase } = await import(modulePath);
    await supabase.auth.signOut({ scope: 'local' });
  });
  await expect(page.locator('.auth-toast')).toContainText('You have been signed out.');
  // The toast begins below the viewport and settles inside it after sliding in.
  await expect.poll(async () => {
    const box = await page.locator('.auth-toast').boundingBox();
    return box ? box.y + box.height : Infinity;
  }).toBeLessThanOrEqual(568);
  const bounds = await page.locator('.auth-toast').boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(568);
  await page.getByRole('button', { name: 'Dismiss notification' }).click();
  await expectToastToFade(page);
});

test.describe('touch phone layouts', () => {
  test.use({ isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

  for (const width of [320, 360, 390, 430]) {
    for (const screen of ['login', 'signup', 'account'] as const) {
      test(`${screen} fits a ${width}px phone and enlarged text`, async ({ page }) => {
        await page.setViewportSize({ width, height: 844 });
        if (screen !== 'login') await seedSession(page);
        if (screen === 'account') await page.route('**/api/auth/me', route => route.fulfill({ json: {
          account: { ...activeAccount, display_name: 'A very long coordinator name for testing', email: 'long-coordinator-email-address@example.test', role: 'coordinator' },
        } }));
        await page.goto('/');
        const control = screen === 'login' ? page.getByRole('button', { name: 'Continue with Google' })
          : screen === 'signup' ? page.getByLabel('Username') : page.getByRole('button', { name: 'Account', exact: true });
        await expect(control).toBeVisible();
        for (const scale of ['100%', '200%']) {
          await page.evaluate(size => { document.documentElement.style.fontSize = size; }, scale);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        if (screen === 'account') {
          const brandText = await page.locator('.dashboard-mobile-heading').boundingBox();
          const signOut = await page.getByRole('button', { name: 'Account', exact: true }).boundingBox();
          const overlap = brandText!.x < signOut!.x + signOut!.width && brandText!.x + brandText!.width > signOut!.x
            && brandText!.y < signOut!.y + signOut!.height && brandText!.y + brandText!.height > signOut!.y;
          expect(overlap).toBe(false);
          if (scale === '200%') expect((await page.locator('.dashboard-metric').first().boundingBox())!.width).toBeGreaterThan(width / 2);
        }

          for (const element of await page.locator('.entry-card button, .entry-card input, .entry-card select, .dashboard-page button:visible, .dashboard-page a:visible').all()) {
            if (await element.evaluate(node => Boolean(node.closest('.dashboard-filters')))) await element.scrollIntoViewIfNeeded();
            const box = await element.boundingBox();
            expect(box!.width).toBeGreaterThanOrEqual(44);
            expect(box!.height).toBeGreaterThanOrEqual(44);
            expect(box!.x).toBeGreaterThanOrEqual(0);
            expect(box!.x + box!.width).toBeLessThanOrEqual(width);
          }
        }
        if (screen === 'signup') {
          expect(await page.getByRole('button', { name: 'Cancel', exact: true }).evaluate(element => {
            const style = getComputedStyle(element);
            return element.getBoundingClientRect().height <= parseFloat(style.lineHeight) + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + 3;
          })).toBe(true);
          expect(await page.getByLabel('Username').evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
          await page.getByLabel('Username').focus();
          await page.getByLabel('Username').fill('mobilepatient');
          await page.getByLabel('Role').selectOption('patient');
          await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeEnabled();
        }
      });
    }
  }

});


test('reduced-motion toast still closes after three seconds without sliding', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await seedSession(page);
  await page.route('**/api/auth/me', route => route.fulfill({ json: { account: activeAccount } }));
  await page.route('**/auth/v1/logout?scope=local', route => route.request().method() === 'OPTIONS' ? route.fallback() : route.fulfill({ status: 204, headers: cors }));
  await page.goto('/');
  await openAccountDropdown(page);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.locator('.auth-toast')).toHaveCSS('animation-name', 'none');
  await expect(page.locator('.toast-progress')).toHaveCSS('animation-duration', '3s');
  await expect(page.locator('.toast-progress')).toHaveCSS('animation-timing-function', 'steps(1)');
  await expect(page.locator('.auth-toast')).toHaveCount(0, { timeout: 3500 });
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
  await page.getByLabel('Role').selectOption('patient');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeEnabled();
  expect(await page.locator('.auth-toast').count()).toBe(0);
  expect(registrations).toBe(0);
  expect(await page.evaluate(() => localStorage.getItem('sb-auth-auth-token'))).toBeNull();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeEnabled();
});

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
  await page.getByLabel('Role').selectOption('caregiver');
  await page.getByRole('button', { name: 'Change Google account' }).click();
  await page.waitForURL('https://auth.example.test/auth/v1/authorize**');
  const url = new URL(page.url());
  expect(url.searchParams.get('prompt')).toBe('select_account');
  expect(url.searchParams.get('code_challenge_method')).toBe('s256');
  expect(url.searchParams.get('redirect_to')).toBe('http://127.0.0.1:5199/auth/callback');
  expect(url.searchParams.get('scopes') ?? '').not.toContain('calendar');
}

for (const outcome of ['unused', 'registered', 'inactive', 'lookup-failed', 'denied', 'back'] as const) {
  test(`changing Google account handles ${outcome} without losing the previous signup`, async ({ page }) => {
    const candidate = selectionSession();
    await page.route('**/auth/v1/token?grant_type=pkce', route => route.request().method() === 'OPTIONS' ? route.fallback() : route.fulfill({ headers: cors, json: candidate }));
    await page.route('**/auth/v1/user', route => route.request().method() === 'OPTIONS' ? route.fallback() : route.fulfill({ headers: cors, json: candidate.user }));
    let checkedCandidate = false;
    await page.route('**/api/auth/me', route => {
      const isCandidate = route.request().headers().authorization === `Bearer ${candidate.access_token}`;
      checkedCandidate ||= isCandidate;
      if (isCandidate && outcome === 'lookup-failed') return route.fulfill({ status: 503, json: { message: 'Unavailable' } });
      return route.fulfill({ json: { account: isCandidate && ['registered', 'inactive'].includes(outcome)
        ? { ...activeAccount, email: candidate.user.email, status: outcome === 'inactive' ? 'inactive' : 'active' } : null } });
    });
    await beginGoogleSelection(page);
    await page.goto(outcome === 'back' ? '/' : outcome === 'denied' ? '/auth/callback?error=access_denied&error_description=PRIVATE_PROVIDER_DETAIL' : '/auth/callback?code=selection-code');
    await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
    await expect(page.getByLabel('Email', { exact: true })).toHaveValue(outcome === 'unused' ? 'other@example.test' : 'patient@example.test');
    await expect(page.getByLabel('Username')).toHaveValue('savedpatient');
    await expect(page.getByLabel('Role')).toHaveValue('caregiver');
    await expect(page).toHaveURL('http://127.0.0.1:5199/');
    expect(checkedCandidate).toBe(!['denied', 'back'].includes(outcome));
    const selected = await page.evaluate(() => JSON.parse(localStorage.getItem('sb-auth-auth-token')!));
    expect(selected.user.id).toBe(outcome === 'unused' ? candidate.user.id : session.user.id);
    expect(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('dialysis-signup-')))).toEqual([]);
    await expect(page.locator('body')).not.toContainText('PRIVATE_PROVIDER_DETAIL');
    if (['registered', 'inactive'].includes(outcome)) {
      await expect(page.locator('.auth-toast')).toHaveText(/Google account already in use/);
      await expect(page.getByRole('heading', { name: 'Your rides' })).toHaveCount(0);
    }
    if (['unused', 'registered', 'inactive'].includes(outcome)) {
      await page.route('**/api/auth/register', route => {
        expect(route.request().headers().authorization).toBe(`Bearer ${outcome === 'unused' ? candidate.access_token : session.access_token}`);
        expect(route.request().postDataJSON()).toEqual({ displayName: 'savedpatient', role: 'caregiver' });
        return route.fulfill({ status: 201, json: { ...activeAccount, email: outcome === 'unused' ? candidate.user.email : session.user.email, display_name: 'savedpatient', role: 'caregiver' } });
      });
      await submitSignup(page);
      await expect(page.getByRole('heading', { name: 'Your rides' })).toBeVisible();
    }
  });
}


test('signup actions use primary-first order, equal vertical spacing and hover feedback', async ({ page }) => {
  await seedSession(page);
  await page.goto('/');
  await page.getByLabel('Username').fill('testpatient');
  await page.getByLabel('Role').selectOption('patient');
  await expect(page.locator('.signup-actions button')).toHaveText(['Next', 'Cancel']);
  const gaps = await page.evaluate(() => {
    const username = document.querySelector('input[autocomplete=username]')!;
    const role = document.querySelector('select')!;
    return [document.querySelector('.signup-actions')!.getBoundingClientRect().top - role.getBoundingClientRect().bottom,
      role.closest('label')!.getBoundingClientRect().top - username.getBoundingClientRect().bottom];
  });
  expect(Math.abs(gaps[0] - gaps[1])).toBeLessThan(1);
  for (const name of ['Next', 'Cancel', 'Change Google account']) {
    const button = page.getByRole('button', { name, exact: true });
    await page.mouse.move(0, 0);
    await expect(button).toHaveCSS('box-shadow', 'none');
    await button.hover();
    await expect(button).not.toHaveCSS('box-shadow', 'none');
  }
});


test('pending session checks display a labelled spinner', async ({ page }) => {
  let release: () => void = () => {};
  const waiting = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/auth/v1/authorize**', route => route.fulfill({ contentType: 'text/html', body: 'Google OAuth boundary' }));
  await page.route('**/auth/v1/token?grant_type=pkce', async route => {
    if (route.request().method() === 'OPTIONS') return route.fallback();
    await waiting;
    await route.fulfill({ headers: cors, json: session });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await page.waitForURL('https://auth.example.test/auth/v1/authorize**');
  await page.goto('/auth/callback?code=fixture-code');
  await expect(page.getByRole('status', { name: 'Checking sign-in' })).toBeVisible();
  await expect(page.locator('.account-loading')).toHaveText('Loading...');
  await expect(page.locator('body')).not.toContainText(/Checking your session|Loading your account/);
  release();
  await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
});


test('slow backend reminders wait ten seconds, repeat after closing, and stop on recovery', async ({ page }) => {
  const now = new Date('2030-01-01T00:00:00Z');
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now);
  await page.route('**/api/health', route => route.fulfill({ status: 503, json: { status: 'unavailable' } }));
  await page.goto('/');
  await expect(page.getByRole('status', { name: 'Connecting to service' })).toBeVisible();
  await page.clock.fastForward(9900);
  expect(await page.locator('.auth-toast').count()).toBe(0);
  await page.clock.fastForward(100);
  const toast = page.locator('.auth-toast');
  await expect(toast).toContainText('This is taking us longer than expected.');
  // Toast animation timing is covered separately; exercise both close events with a controlled clock.
  await page.locator('.toast-progress').evaluate(element => element.dispatchEvent(new AnimationEvent('animationend', { animationName: 'toast-fill', bubbles: true })));
  await expect(toast).toHaveAttribute('data-closing', 'true');
  await toast.evaluate(element => element.dispatchEvent(new AnimationEvent('animationend', { animationName: 'toast-exit', bubbles: true })));
  await expect(toast).toHaveCount(0);
  await page.clock.fastForward(9900);
  expect(await toast.count()).toBe(0);
  await page.clock.fastForward(100);
  await expect(toast).toContainText('This is taking us longer than expected.');
  await page.getByRole('button', { name: 'Dismiss notification' }).dispatchEvent('click');
  await expect(toast).toHaveAttribute('data-closing', 'true');
  await toast.evaluate(element => element.dispatchEvent(new AnimationEvent('animationend', { animationName: 'toast-exit', bubbles: true })));
  await page.clock.fastForward(10000);
  await expect(toast).toContainText('This is taking us longer than expected.');
  await page.route('**/api/health', route => route.fulfill({ json: { status: 'ok' } }));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeEnabled();
  await expect(toast).toHaveAttribute('data-closing', 'true');
  await toast.evaluate(element => element.dispatchEvent(new AnimationEvent('animationend', { animationName: 'toast-exit', bubbles: true })));
  await page.clock.fastForward(60000);
  expect(await toast.count()).toBe(0);
});

test('account retry attempts do not reset the slow-loading reminder', async ({ page }) => {
  const now = new Date('2030-01-01T00:00:00Z');
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now);
  await seedSession(page);
  await page.route('**/api/auth/me', route => route.fulfill({ status: 503, json: { message: 'Unavailable' } }));
  await page.goto('/');
  await expect(page.getByRole('status', { name: 'Reconnecting to account service' })).toBeVisible();
  await page.clock.fastForward(5100);
  await expect(page.getByRole('status', { name: 'Reconnecting to account service' })).toBeVisible();
  await page.clock.fastForward(4900);
  await expect(page.locator('.auth-toast')).toContainText('This is taking us longer than expected.');
  await page.route('**/api/auth/me', route => route.fulfill({ json: { account: activeAccount } }));
  await page.clock.fastForward(5200);
  await expect(page.getByRole('heading', { name: /^Welcome back,/ })).toBeVisible();
  await expect(page.locator('.auth-toast')).toHaveAttribute('data-closing', 'true');
});

for (const stage of ['account verification', 'session activation']) {
  test(`sign-out in another tab cancels a Google switch during ${stage}`, async ({ page }) => {
    const candidate = selectionSession();
    await page.route('**/auth/v1/token?grant_type=pkce', route => route.request().method() === 'OPTIONS' ? route.fallback() : route.fulfill({ headers: cors, json: candidate }));
    let release: () => void = () => {};
    let started: () => void = () => {};
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const requested = new Promise<void>(resolve => { started = resolve; });
    await page.route('**/auth/v1/user', async route => {
      if (route.request().method() === 'OPTIONS') return route.fallback();
      if (stage === 'session activation') { started(); await waiting; }
      await route.fulfill({ headers: cors, json: candidate.user });
    });
    await page.route('**/api/auth/me', async route => {
      if (stage === 'account verification' && route.request().headers().authorization === `Bearer ${candidate.access_token}`) {
        started(); await waiting;
      }
      await route.fulfill({ json: { account: null } });
    });
    await beginGoogleSelection(page);
    await page.goto('/auth/callback?code=selection-code');
    await requested;
    await page.evaluate(async () => {
      const path = '/src/lib/supabase.ts';
      const { supabase } = await import(path);
      supabase.auth.onAuthStateChange((event: string) => {
        if (event === 'SIGNED_OUT') document.body.dataset.edgeSignedOut = 'yes';
      });
    });
    const otherTab = await page.context().newPage();
    await otherTab.route('**/api/health', route => route.fulfill({ json: { status: 'ok' } }));
    await otherTab.route('**/api/auth/me', route => route.fulfill({ json: { account: null } }));
    await otherTab.route('https://auth.example.test/**', route => route.request().method() === 'OPTIONS'
      ? route.fulfill({ status: 204, headers: cors }) : route.fulfill({ status: 204, headers: cors }));
    await otherTab.goto('/');
    await otherTab.getByLabel('Username').waitFor();
    await otherTab.evaluate(async () => {
      const path = '/src/lib/supabase.ts';
      const { supabase } = await import(path);
      await supabase.auth.signOut({ scope: 'local' });
    });
    await expect(page.locator('body')).toHaveAttribute('data-edge-signed-out', 'yes');
    expect(await page.evaluate(() => localStorage.getItem('sb-auth-auth-token'))).toBeNull();
    release();
    // Finish the callback, then check whether that later explicit sign-out was respected.
    await expect(page.getByRole('status', { name: 'Checking sign-in' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeEnabled();
    await expect.poll(() => page.evaluate(() => {
      const saved = localStorage.getItem('sb-auth-auth-token');
      return saved ? JSON.parse(saved).user.email : null;
    })).toBeNull();
  });

}


test('a hung account request times out and recovers on a fresh request', async ({ page }) => {
  const now = new Date('2030-01-01T00:00:00Z');
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now);
  await seedSession(page);
  const waiting = new Promise<void>(() => {});
  await page.route('**/api/auth/me', async () => { await waiting; });
  await page.goto('/');
  await expect(page.getByRole('status', { name: 'Loading account' })).toBeVisible();
  await page.clock.fastForward(15000);
  await expect(page.getByRole('status', { name: 'Reconnecting to account service' })).toBeVisible();
  // The timed-out request remains hung; only a new request can use this recovered response.
  await page.route('**/api/auth/me', route => route.fulfill({ json: { account: activeAccount } }));
  await page.clock.fastForward(5100);
  await expect(page.getByRole('heading', { name: /^Welcome back,/ })).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('sb-auth-auth-token')!).access_token)).toBe(session.access_token);
});


test('a timed-out registration response recovers an account already created by the server', async ({ page }) => {
  const now = new Date('2030-01-01T00:00:00Z');
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now);
  await seedSession(page);
  let registrations = 0;
  let started: () => void = () => {};
  const requested = new Promise<void>(resolve => { started = resolve; });
  const waiting = new Promise<void>(() => {});
  await page.route('**/api/auth/me', route => route.fulfill({ json: { account: registrations ? activeAccount : null } }));
  await page.route('**/api/auth/register', async () => { registrations++; started(); await waiting; });
  await page.goto('/');
  await page.getByLabel('Username').fill('testpatient');
  await page.getByLabel('Role').selectOption('patient');
  await advanceSignup(page);
  await page.locator('.signup-form').dispatchEvent('submit');
  await requested;
  await page.clock.fastForward(15000);
  await expect(page.getByRole('heading', { name: /^Welcome back,/ })).toBeVisible();
  expect(registrations).toBe(1);
});


test('active coordinators land on a separate dashboard with honest unavailable metrics', async ({ page }) => {
  await seedSession(page);
  await page.route('**/api/auth/me', route => route.fulfill({ json: { account: { ...activeAccount, display_name: 'Test Coordinator', role: 'coordinator' } } }));
  await page.goto('/');
  await expect(page).toHaveURL('http://127.0.0.1:5199/dashboard/trips');
  await expect(page.getByRole('heading', { name: "Today's trips" })).toBeVisible();
  await expect(page.locator('.landing-page')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Every patient.' })).toHaveCount(0);
  await expect(page.locator('.dashboard-metric-value')).toHaveText(['—', '—', '—', '—']);
  await expect(page.getByText('Trip information is not available.')).toBeVisible();
  for (const status of ['Unfilled', 'At-Risk', 'On-Track', 'Resolved']) {
    await page.getByRole('button', { name: status, exact: true }).click();
    await expect(page.getByRole('button', { name: status, exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('heading', { name: `${status} trips`, exact: true })).toBeVisible();
  }
  await page.getByRole('button', { name: 'All trips', exact: true }).click();
  await expect(page.getByRole('heading', { name: "Today's trips", exact: true })).toBeVisible();
});

test('coordinator account navigation, browser history and refresh preserve the dashboard', async ({ page }) => {
  await seedSession(page);
  await page.route('**/api/auth/me', route => route.fulfill({ json: { account: { ...activeAccount, role: 'coordinator' } } }));
  await page.goto('/dashboard');
  await openAccountDropdown(page);
  await page.getByRole('link', { name: 'My Account', exact: true }).click();
  await expect(page).toHaveURL('http://127.0.0.1:5199/dashboard/account');
  await expect(page).toHaveURL(/\/dashboard\/account$/);
  await expect(page.getByText('patient@example.test', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(/\/dashboard\/account$/);
  await page.getByRole('link', { name: 'Trips', exact: true }).click();
  await expect(page).toHaveURL('http://127.0.0.1:5199/dashboard/trips');
  await page.goBack();
  await expect(page).toHaveURL(/\/dashboard\/account$/);
});

for (const access of ['signed-out', 'unregistered', 'driver', 'caregiver', 'inactive'] as const) {
  test(`${access} users cannot open the coordinator dashboard`, async ({ page }) => {
    if (access !== 'signed-out') await seedSession(page);
    await page.route('**/api/auth/me', route => route.fulfill({ json: { account: access === 'unregistered' ? null
      : { ...activeAccount, role: access === 'inactive' ? 'coordinator' : access, status: access === 'inactive' ? 'inactive' : 'active' } } }));
    await page.goto(access === 'driver' || access === 'caregiver' ? '/dashboard/patients' : '/dashboard/account');
    if (access === 'driver' || access === 'caregiver') {
      await expect(page).toHaveURL(/\/dashboard\/trips$/);
      await expect(page.getByRole('link', { name: 'Patients', exact: true })).toHaveCount(0);
      return;
    }
    await expect(page).toHaveURL('http://127.0.0.1:5199/');
    await expect(page.locator('.dashboard-page')).toHaveCount(0);
    if (access === 'unregistered') await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
  });
}

test('dashboard sign-out returns to the landing page and stays protected after Back', async ({ page }) => {
  await seedSession(page);
  await page.route('**/api/auth/me', route => route.fulfill({ json: { account: { ...activeAccount, role: 'coordinator' } } }));
  await page.route('**/auth/v1/logout?scope=local', route => route.request().method() === 'OPTIONS' ? route.fallback() : route.fulfill({ status: 204, headers: cors }));
  await page.goto('/dashboard');
  await openAccountDropdown(page);
  await page.getByRole('link', { name: 'My Account', exact: true }).click();
  await openAccountDropdown(page);
  await openAccountDropdown(page);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page).toHaveURL('http://127.0.0.1:5199/');
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeEnabled();
  await expect(page.locator('.auth-toast')).toContainText('You have been signed out.');
  await page.goBack();
  await expect(page.locator('.dashboard-page')).toHaveCount(0);
});


test('coordinator overview fills desktop space with an aligned gap above the footer', async ({ page }) => {
  await seedSession(page);
  await page.route('**/api/auth/me', route => route.fulfill({ json: { account: { ...activeAccount, role: 'coordinator' } } }));
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: /Welcome back/ })).toBeVisible();
  for (const [width, height] of [[1280, 720], [1366, 768], [1440, 900], [1728, 972], [1920, 1080]]) {
    await page.setViewportSize({ width, height });
    expect(await page.evaluate(() => {
      const main = document.querySelector('.dashboard-main')!;
      return document.documentElement.scrollHeight <= innerHeight
        && document.documentElement.scrollWidth <= innerWidth
        && main.scrollHeight <= main.clientHeight;
    })).toBe(true);
    const trips = await page.locator('.dashboard-trips').boundingBox();
    const footer = await page.locator('.dashboard-footer').boundingBox();
    const metrics = await page.locator('.dashboard-metrics').boundingBox();
    const cards = await page.locator('.dashboard-metric').all();
    const first = await cards[0].boundingBox();
    const second = await cards[1].boundingBox();
    const third = await cards[2].boundingBox();
    expect(first!.y).toBeCloseTo(second!.y, 1);
    const fourth = await cards[3].boundingBox();
    expect(third!.y).toBeCloseTo(first!.y, 1);
    expect(fourth!.y).toBeCloseTo(first!.y, 1);
    expect(trips!.y).toBeGreaterThanOrEqual(metrics!.y + metrics!.height);
    expect(trips!.x).toBeCloseTo(metrics!.x, 1);
    expect(trips!.width).toBeCloseTo(metrics!.width, 1);
    const sidebar = await page.locator('.dashboard-sidebar').boundingBox();
    expect(footer!.y - (trips!.y + trips!.height)).toBeCloseTo(24, 0);
    expect(sidebar!.y + sidebar!.height).toBeCloseTo(trips!.y + trips!.height, 0);
    expect(trips!.y + trips!.height).toBeLessThanOrEqual(footer!.y);
    expect(footer!.y + footer!.height).toBeLessThanOrEqual(height);
  }
});


test('landing and dashboard bars share desktop dimensions with a seamless dashboard header', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
  const landingHeader = await page.locator('.landing-brand').boundingBox();
  const landingFooter = await page.locator('.landing-footer').boundingBox();
  await seedSession(page);
  await page.route('**/api/auth/me', route => route.fulfill({ json: { account: { ...activeAccount, role: 'coordinator' } } }));
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: /Welcome back/ })).toBeVisible();
  const dashboardHeader = await page.locator('.dashboard-header-inner').boundingBox();
  const dashboardFooter = await page.locator('.dashboard-footer').boundingBox();
  for (const dimension of ['x', 'width', 'height'] as const) {
    expect(dashboardHeader![dimension]).toBeCloseTo(landingHeader![dimension], 1);
    expect(dashboardFooter![dimension]).toBeCloseTo(landingFooter![dimension], 1);
  }
  expect(await page.locator('.dashboard-header').evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
  expect(await page.locator('.dashboard-header-inner').evaluate(element => getComputedStyle(element).borderBottomWidth)).toBe('0px');
});


test('coordinator navigation and status filters work with the keyboard', async ({ page }) => {
  await seedSession(page);
  await page.route('**/api/auth/me', route => route.fulfill({ json: { account: { ...activeAccount, role: 'coordinator' } } }));
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: /Welcome back/ })).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#dashboard-main')).toBeFocused();
  const filter = page.getByRole('button', { name: 'At-Risk', exact: true });
  await filter.focus();
  await page.keyboard.press('Space');
  await expect(filter).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('heading', { name: 'At-Risk trips', exact: true })).toBeVisible();
  await expect(page.getByText('Trip information is not available.')).toBeVisible();
  await expect(page.getByText(/No trips scheduled|No trips matching/)).toHaveCount(0);
  await openAccountDropdown(page);
  await page.getByRole('link', { name: 'My Account', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/dashboard\/account$/);
  await openAccountDropdown(page);
  await expect(page.getByRole('link', { name: 'My Account', exact: true })).toHaveAttribute('aria-current', 'page');
});


test('mobile navigation overlays without reflow, traps focus and closes through every supported action', async ({ page }) => {
  await seedSession(page);
  await page.route('**/api/auth/me', route => route.fulfill({ json: { account: { ...activeAccount, role: 'coordinator' } } }));
  await page.goto('/dashboard');
  for (const width of [360, 390, 430, 768]) {
    await page.setViewportSize({ width, height: 900 });
    const toggle = page.locator('.dashboard-menu-toggle');
    const drawer = page.getByRole('dialog', { name: 'Menu navigation' });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.dashboard-header .dashboard-brand')).toBeHidden();
    const header = await page.locator('.dashboard-header-inner').boundingBox();
    expect(header!.height).toBeLessThanOrEqual(64);
    const before = await page.locator('.dashboard-welcome h1').boundingBox();
    await toggle.click();
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'Close navigation' })).toBeFocused();
    expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden');
    expect(await page.locator('.dashboard-welcome h1').boundingBox()).toEqual(before);
    await page.keyboard.press('Tab');
    await expect(drawer.getByRole('link', { name: 'Trips', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(drawer.getByRole('link', { name: 'Schedules', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(drawer.getByRole('link', { name: 'Patients', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(drawer.getByRole('button', { name: 'Close navigation' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await expect(toggle).toBeFocused();
    expect(await page.evaluate(() => document.body.style.overflow)).toBe('');
    await toggle.click();
    await page.mouse.click(width - 4, 300);
    await expect(drawer).toBeHidden();
    await toggle.click();
    await drawer.getByRole('button', { name: 'Close navigation' }).click();
    await expect(drawer).toBeHidden();
    await toggle.click();
    await drawer.getByRole('link', { name: 'Trips', exact: true }).click();
    await expect(drawer).toBeHidden();
    await expect(toggle).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});


test('a mobile drawer closes and unlocks scrolling when resized to desktop', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seedSession(page);
  await page.route('**/api/auth/me', route => route.fulfill({ json: { account: { ...activeAccount, role: 'coordinator' } } }));
  await page.goto('/dashboard');
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(page.getByRole('dialog', { name: 'Menu navigation' })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole('dialog', { name: 'Menu navigation' })).toBeHidden();
  await expect(page.locator('.dashboard-sidebar')).toBeVisible();
  expect(await page.evaluate(() => document.body.style.overflow)).toBe('');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'Open navigation' })).toHaveAttribute('aria-expanded', 'false');
});


test('mobile landing uses a compact wordmark and retains the desktop monogram', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
  for (const width of [360, 390, 430, 768]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.locator('.landing-brand .brand-symbol')).toBeHidden();
    await expect(page.locator('.landing-brand')).toBeVisible();
    expect((await page.locator('.landing-brand').boundingBox())!.height).toBeLessThanOrEqual(64);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator('.landing-brand .brand-symbol')).toBeVisible();
  expect((await page.locator('.landing-brand').boundingBox())!.height).toBe(84);
});


test('coordinator clock ticks in Singapore time and updates the date at midnight', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-10-16T15:59:58Z') });
  await seedSession(page);
  await page.route('**/api/auth/me', route => route.fulfill({ json: { account: { ...activeAccount, role: 'coordinator' } } }));
  await page.goto('/dashboard');
  await expect(page.locator('.dashboard-clock')).toHaveText('23:59:58');
  await expect(page.locator('.dashboard-welcome time')).toContainText('Friday, 16 October 2026');
  await page.clock.fastForward(2000);
  await expect(page.locator('.dashboard-clock')).toHaveText('00:00:00');
  await expect(page.locator('.dashboard-welcome time')).toContainText('Saturday, 17 October 2026');
  await expect(page.getByText("Here's your transport overview.")).toHaveCount(0);
  await expect(page.locator('.dashboard-time-separator')).toBeHidden();
  for (const width of [390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(page.locator('.dashboard-time-separator')).toBeVisible();
    await expect(page.locator('.dashboard-welcome h1')).toHaveCSS('font-size', '24px');
    const date = await page.locator('.dashboard-welcome time > span').first().boundingBox();
    const clock = await page.locator('.dashboard-clock').boundingBox();
    expect(Math.abs(date!.y - clock!.y)).toBeLessThan(2);
    const trips = await page.locator('.dashboard-trips').boundingBox();
    const footer = await page.locator('.dashboard-footer').boundingBox();
    expect(Math.abs(footer!.y - trips!.y - trips!.height - 24)).toBeLessThan(2);
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);
  }
});


test('account controls stay in the header on desktop and mobile, outside Menu', async ({ page }) => {
  await seedSession(page);
  await page.route('**/api/auth/me', route => route.fulfill({ json: { account: { ...activeAccount, role: 'coordinator' } } }));
  await page.goto('/dashboard');
  for (const [width, height] of [[1440, 900], [390, 844], [320, 844]]) {
    await page.setViewportSize({ width, height });
    const account = page.locator('.dashboard-header').getByRole('button', { name: 'Account', exact: true });
    await expect(account).toBeVisible();
    await expect(page.locator('.dashboard-sidebar').getByRole('link', { name: 'My Account', exact: true })).toHaveCount(0);
    const header = await page.locator('.dashboard-header').boundingBox();
    const button = await account.boundingBox();
    expect(button!.y + button!.height).toBeLessThanOrEqual(header!.y + header!.height);
    expect(button!.x + button!.width).toBeLessThanOrEqual(width);
    await account.click();
    await page.getByRole('link', { name: 'My Account', exact: true }).click();
    await expect(page).toHaveURL(/\/dashboard\/account$/);
    await openAccountDropdown(page);
    await expect(page.getByRole('link', { name: 'My Account', exact: true })).toHaveAttribute('aria-current', 'page');
    await page.keyboard.press('Escape');
    if (width <= 1050) {
      await page.getByRole('button', { name: 'Open navigation' }).click();
      await page.getByRole('dialog', { name: 'Menu navigation' }).getByRole('link', { name: 'Trips', exact: true }).click();
    } else await page.getByRole('link', { name: 'Dialysis Transport dashboard', exact: true }).click();
    await expect(page.getByRole('heading', { name: /Welcome back/ })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});


test('header dropdowns are exclusive, keyboard dismissible, and show real account identity', async ({ page }) => {
  await seedSession(page);
  await page.route('**/api/auth/me', route => route.fulfill({ json: { account: { ...activeAccount, display_name: 'Pebble', role: 'coordinator' } } }));
  await page.goto('/dashboard');
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const account = page.getByRole('button', { name: 'Account', exact: true });
    const notifications = page.getByRole('button', { name: 'Notifications', exact: true });
    await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toHaveCount(0);
    await notifications.click();
    await expect(notifications).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('region', { name: 'Notifications', exact: true })).toContainText('Notifications are currently unavailable.');
    await account.click();
    await expect(notifications).toHaveAttribute('aria-expanded', 'false');
    const panel = page.getByRole('region', { name: 'Account', exact: true });
    await expect(panel.getByText('Pebble', { exact: true })).toBeVisible();
    await expect(panel.getByText('patient@example.test', { exact: true })).toBeVisible();
    await expect(panel.getByRole('link', { name: 'My Account', exact: true })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
    const box = await panel.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    await page.keyboard.press('Escape');
    await expect(account).toHaveAttribute('aria-expanded', 'false');
    await expect(account).toBeFocused();
    await account.click();
    await page.mouse.click(2, 2);
    await expect(account).toHaveAttribute('aria-expanded', 'false');
  }
});


for (const photoLoads of [true, false]) {
  test(`account profile ${photoLoads ? 'shows its Google photo' : 'falls back to initials when the photo fails'}`, async ({ page }) => {
    await seedSession(page);
    await page.addInitScript(() => {
      const key = 'sb-auth-auth-token';
      const saved = JSON.parse(localStorage.getItem(key)!);
      saved.user.user_metadata = { avatar_url: 'https://images.example.test/avatar.svg' };
      localStorage.setItem(key, JSON.stringify(saved));
    });
    await page.route('https://images.example.test/avatar.svg', route => photoLoads
      ? route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="56" height="56"><rect width="56" height="56" fill="#29434d"/></svg>' })
      : route.fulfill({ status: 503, body: '' }));
    await page.route('**/api/auth/me', route => route.fulfill({ json: { account: { ...activeAccount, display_name: 'Pebble', role: 'coordinator' } } }));
    await page.goto('/dashboard');
    await openAccountDropdown(page);
    const avatar = page.locator('.dashboard-profile-avatar');
    if (photoLoads) {
      await expect(avatar.locator('img')).toBeVisible();
      await expect.poll(() => avatar.locator('img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    } else {
      await expect(avatar).toHaveText('PE');
      await expect(avatar.locator('img')).toHaveCount(0);
    }
    await page.getByRole('link', { name: 'My Account', exact: true }).click();
    await expect(page.locator('.dashboard-account-card')).toHaveCount(0);
    await expect(page).toHaveURL(/\/dashboard\/account$/);
    await expect(page.locator('.dashboard-account-identity')).toHaveCount(0);
    await openAccountDropdown(page);
    await expect(page.locator('.dashboard-profile-name').getByText('Transport Coordinator', { exact: true })).toBeVisible();
  });
}


test('account dropdown fits enlarged text on a small phone and remains keyboard accessible', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await seedSession(page);
  await page.route('**/api/auth/me', route => route.fulfill({ json: { account: { ...activeAccount, display_name: 'A very long coordinator username', email: 'long.coordinator.email.address@example.test', role: 'coordinator' } } }));
  await page.goto('/dashboard');
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  const trigger = page.getByRole('button', { name: 'Account', exact: true });
  await trigger.focus();
  await page.keyboard.press('Enter');
  const panel = page.getByRole('region', { name: 'Account', exact: true });
  const box = await panel.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(320);
  expect(box!.y + box!.height).toBeLessThanOrEqual(568);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'My Account', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
});


test('dashboard reload shows a neutral loader until the coordinator account is verified', async ({ page }) => {
  await seedSession(page);
  let hold = false;
  let release: () => void = () => {};
  const waiting = new Promise<void>(resolve => { release = resolve; });
  let started: () => void = () => {};
  const requested = new Promise<void>(resolve => { started = resolve; });
  await page.route('**/api/auth/me', async route => {
    if (hold) { started(); await waiting; }
    await route.fulfill({ json: { account: { ...activeAccount, role: 'coordinator' } } });
  });
  await page.goto('/dashboard/account');
  await expect(page).toHaveURL(/\/dashboard\/account$/);
  hold = true;
  await page.reload();
  await requested;
  await expect(page.locator('.session-restoring')).toBeVisible();
  await expect(page.locator('.landing-intro')).toBeHidden();
  await expect(page.locator('.landing-brand')).toBeHidden();
  await expect(page.locator('.dashboard-page')).toHaveCount(0);
  await expect(page.getByRole('status', { name: 'Loading account', exact: true })).toBeVisible();
  release();
  await expect(page).toHaveURL(/\/dashboard\/account$/);
  await expect(page).toHaveURL('http://127.0.0.1:5199/dashboard/account');
  await expect(page.locator('.session-restoring')).toHaveCount(0);
});


test('a rejected restored session leaves the neutral loader for the public sign-in page', async ({ page }) => {
  await seedSession(page);
  let release: () => void = () => {};
  const waiting = new Promise<void>(resolve => { release = resolve; });
  let started: () => void = () => {};
  const requested = new Promise<void>(resolve => { started = resolve; });
  await page.route('**/api/auth/me', async route => {
    started(); await waiting;
    await route.fulfill({ status: 401, json: { message: 'Invalid or expired sign-in.' } });
  });
  await page.route('**/auth/v1/logout?scope=local', route => route.request().method() === 'OPTIONS' ? route.fallback() : route.fulfill({ status: 204, headers: cors }));
  await page.goto('/dashboard');
  await requested;
  await expect(page.locator('.session-restoring')).toBeVisible();
  await expect(page.locator('.landing-intro')).toBeHidden();
  await expect(page.locator('.dashboard-page')).toHaveCount(0);
  release();
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
  await expect(page.locator('.landing-intro')).toBeVisible();
  await expect(page).toHaveURL('http://127.0.0.1:5199/');
});


test('the initial HTML provides the blurred backdrop before JavaScript and app styles load', async ({ page }) => {
  let release: () => void = () => {};
  const waiting = new Promise<void>(resolve => { release = resolve; });
  let started: () => void = () => {};
  const requested = new Promise<void>(resolve => { started = resolve; });
  await page.route('**/src/main.tsx*', async route => { started(); await waiting; await route.continue(); });
  await page.goto('/', { waitUntil: 'commit' });
  await requested;
  await expect(page.locator('#root')).toBeEmpty();
  expect(await page.evaluate(() => getComputedStyle(document.body, '::before').backgroundImage)).toContain('/images/transport-night.jpg');
  expect(await page.evaluate(() => getComputedStyle(document.body, '::before').filter)).toBe('blur(32px)');
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)).toBe('rgb(16, 37, 43)');
  release();
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)).toBe('rgb(16, 37, 43)');
});

test('coordinator reads patient details but persists only Status and Notes', async ({ page }) => {
  await seedSession(page);
  await page.route('**/api/auth/me', route => route.fulfill({ json: { account: { ...activeAccount, role: 'coordinator' } } }));
  let patient = { id: session.user.id, full_name: 'Test Patient', phone: '+65 81234567', pickup_address: 'Test pickup address', postal_code: '560123', unit_no: '#05-12', notes: '', mobility: 'wheelchair', assistance_required: true, status: 'active' };
  let writes = 0;
  await page.route('**/api/profiles/patients**', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { patients: [patient], total: 1, page: 1, pageSize: 25 } });
    expect(route.request().method()).toBe('PATCH');
    expect(route.request().postDataJSON()).toEqual({ status: 'inactive', notes: 'Coordinator note.' });
    writes++; patient = { ...patient, ...route.request().postDataJSON() };
    return route.fulfill({ json: patient });
  });
  await page.goto('/dashboard/patients');
  await expect(page.getByRole('heading', { name: 'Patients List', exact: true })).toBeVisible();
  await expect(page.getByText('Patient Management', { exact: true })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Patient ID', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: patient.id, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add patient', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'View Test Patient', exact: true }).click();
  const details=page.getByRole('dialog',{name:'Patient Details',exact:true});
  await expect(details.getByRole('heading', { name: 'Patient Details', exact: true })).toBeVisible();
  await expect(page.locator('.profile-id')).toHaveText(`Patient ID: ${patient.id}`);
  await expect(page.getByRole('dialog',{name:'Patient Details',exact:true}).getByText('Patient Management', { exact: true })).toHaveCount(0);
  await expect(details.getByRole('heading', { name: 'Patients List', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save Patient', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
  await expect(details.getByLabel('Notes', { exact: true })).toBeDisabled();
  await expect(details.getByLabel('Status', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Edit Patient', exact: true }).click();
  for (const label of ['Full name', 'Contact number', 'Street', 'Unit no.', 'Postal code', 'Mobility', 'Assistance required']) await expect(details.getByLabel(label, { exact: true })).toBeDisabled();
  await details.getByLabel('Notes', { exact: true }).fill('Discard this.');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(writes).toBe(0);
  await expect(page.getByRole('button', { name: 'Edit Patient', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save Patient', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Edit Patient', exact: true }).click();
  await expect(details.getByLabel('Notes', { exact: true })).toHaveValue('');
  await details.getByLabel('Status', { exact: true }).selectOption('inactive');
  await details.getByLabel('Notes', { exact: true }).fill('Coordinator note.');
  await page.getByRole('button', { name: 'Save Patient', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit Patient', exact: true })).toBeVisible();
  await expect(details.getByLabel('Notes', { exact: true })).toHaveValue('Coordinator note.');
  await expect(details.getByLabel('Notes', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save Patient', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('button', { name: 'View Test Patient', exact: true })).toBeFocused();
  await page.reload();
  await expect(page.getByRole('cell', { name: 'Inactive', exact: true })).toBeVisible();
  expect(writes).toBe(1);
});

test('patients errors preserve form input and mobile controls fit enlarged text', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seedSession(page);
  await page.route('**/api/auth/me', route => route.fulfill({ json: { account: { ...activeAccount, role: 'coordinator' } } }));
  let available = false;
  await page.route('**/api/profiles/patients**', route => route.fulfill(available && route.request().method() === 'GET'
    ? { json: { patients: [{id: session.user.id, full_name: 'Test Patient', phone: '+65 81234567', pickup_address: 'Test address', postal_code: '560123', unit_no: '', notes: '', mobility: 'ambulant', assistance_required: false, status: 'active'}], total: 1, page: 1, pageSize: 25 } }
    : { status: 503, json: { message: 'Unavailable' } }));
  await page.goto('/dashboard/patients');
  await expect(page.getByRole('alert')).toContainText('Patients could not be loaded.');
  await expect(page.getByText('No patients yet.')).toHaveCount(0);
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const panel = await page.locator('.patients-panel').boundingBox();
    const footer = await page.locator('.dashboard-footer').boundingBox();
    expect(Math.abs(footer!.y - panel!.y - panel!.height - 24)).toBeLessThan(2);
    await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeInViewport();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  available = true;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await page.getByRole('button', { name: 'View Test Patient', exact: true }).click();
  await page.getByRole('button', { name: 'Edit Patient', exact: true }).click();
  await page.getByRole('dialog',{name:'Patient Details',exact:true}).getByLabel('Notes', { exact: true }).fill('Call on arrival.');
  await page.getByRole('button', { name: 'Save Patient', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Patient could not be saved.');
  await expect(page.getByRole('dialog',{name:'Patient Details',exact:true}).getByLabel('Notes', { exact: true })).toHaveValue('Call on arrival.');
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const fontSize of ['16px', '32px']) {
      await page.evaluate(size => document.documentElement.style.fontSize = size, fontSize);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      for (const label of ['Full name', 'Contact number', 'Street', 'Mobility', 'Status']) {
        const box = await page.getByRole('dialog',{name:'Patient Details',exact:true}).getByLabel(label, { exact: true }).boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      }
    }
  }
});

test('patient list pagination and mobile drawer navigation preserve bounded table scrolling', async ({ page }) => {
  await seedSession(page);
  await page.route('**/api/auth/me', route => route.fulfill({ json: { account: { ...activeAccount, role: 'coordinator' } } }));
  await page.route('**/api/profiles/patients**', route => {
    const number = Number(new URL(route.request().url()).searchParams.get('page'));
    return route.fulfill({ json: { patients: [{ id: '11111111-1111-4111-8111-111111111111', full_name: number === 2 ? 'Second Page Patient' : 'Test Patient With A Longer Name', phone: '+65 8123 4567', pickup_address: 'Test address', mobility: 'walking-aid', assistance_required: false, status: 'active' }], total: 26, page: number, pageSize: 25 } });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/dashboard');
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('dialog').getByRole('link', { name: 'Patients', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Patients List', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Previous', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'Second Page Patient', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Previous', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'Test Patient With A Longer Name', exact: true })).toBeVisible();
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const fontSize of ['16px', '32px']) {
      await page.evaluate(size => document.documentElement.style.fontSize = size, fontSize);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const region = page.getByRole('region', { name: 'Patient records', exact: true });
      const bounds = await region.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      await expect(region).toHaveCSS('overflow-x', 'auto');
    }
  }
});

test('expired patient requests return to sign-in and discard private records', async ({ page }) => {
  await seedSession(page);
  await page.route('**/api/auth/me', route => route.fulfill({ json: { account: { ...activeAccount, role: 'coordinator' } } }));
  await page.route('**/api/profiles/patients**', route => route.fulfill({ status: 401, json: { message: 'Expired' } }));
  await page.route('**/auth/v1/logout?scope=local', route => route.request().method() === 'OPTIONS' ? route.fallback() : route.fulfill({ status: 204, headers: cors }));
  await page.goto('/dashboard/patients');
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
  await expect(page.locator('.patients-panel')).toHaveCount(0);
  await expect(page).toHaveURL(/\/$/);
});

test('patient dashboard completes and edits its own profile with shared styling on phones and desktop', async ({ page }) => {
  await seedSession(page);
  await page.route('**/api/auth/me', route => route.fulfill({ json: { account: { ...activeAccount, profile_complete: Boolean(profile) } } }));
  let profile: Record<string, unknown> | null = null;
  await page.route('**/api/profiles/patient', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { patient: profile } });
    const details = route.request().postDataJSON();
    expect(details.phone).toBe('+65 81234567');
    expect(details.status).toBeUndefined();
    expect(details.account_id).toBeUndefined();
    profile = { ...details, id: session.user.id, account_id: activeAccount.id, status: 'active' };
    return route.fulfill({ json: profile });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page).toHaveURL('http://127.0.0.1:5199/');
  await expect(page.getByRole('heading', { name: 'Finish creating your account', exact: true })).toBeVisible();
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.locator('.dashboard-sidebar')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Open navigation' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Trips', exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'My profile', exact: true })).toHaveCount(0);
  }
  await page.getByLabel('Full name', { exact: true }).fill('Test Patient');
  await expect(page.getByLabel('Country code', { exact: true })).toHaveCount(0);
  await page.getByLabel('Contact number', { exact: true }).fill('+65 81234567');
  await page.getByLabel('Street', { exact: true }).fill('Test address');
  await page.getByLabel('Postal code', { exact: true }).fill('560123');
  await page.getByLabel('Unit no.', { exact: true }).fill('#05-12');
  await page.getByLabel('Notes', { exact: true }).fill('Please call upon arrival.');
  await page.getByLabel('Assistance required', { exact: true }).selectOption('yes');
  await expect(page.getByLabel('Status', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Finish creating account', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your rides', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Account Details', exact: true })).toHaveCount(0);
  await expect(page.getByText('Test address', { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Your rides', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Account Details', exact: true })).toHaveCount(0);
  await expect(page.getByText('Test address', { exact: true })).toHaveCount(0);
  await openAccountDropdown(page);
  await page.getByRole('link', { name: 'My Account', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\/account$/);
  await expect(page.getByLabel('Street', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('Street', { exact: true })).toHaveValue('Test address');
  await page.getByRole('button', { name: 'Edit profile', exact: true }).click();
  await expect(page.getByLabel('Street', { exact: true })).toHaveValue('Test address');
  await expect(page.getByLabel('Country code', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Contact number', { exact: true })).toHaveValue('+65 81234567');
  await expect(page.getByLabel('Unit no.', { exact: true })).toHaveValue('#05-12');
  await expect(page.getByLabel('Postal code', { exact: true })).toHaveValue('560123');
  await expect(page.getByLabel('Notes', { exact: true })).toHaveValue('Please call upon arrival.');
  await expect(page.getByLabel('Assistance required', { exact: true })).toHaveValue('yes');
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const size of ['16px', '32px']) {
      await page.evaluate(size => document.documentElement.style.fontSize = size, size);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  }
  await page.evaluate(() => document.documentElement.style.fontSize = '16px');
  await page.getByLabel('Street', { exact: true }).fill('New address');
  await page.getByLabel('Postal code', { exact: true }).fill('560123');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await openAccountDropdown(page);
  await page.getByRole('link', { name: 'My Account', exact: true }).click();
  await expect(page.getByLabel('Street', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('Street', { exact: true })).toHaveValue('Test address');
  await page.getByRole('button', { name: 'Edit profile', exact: true }).click();
  await page.getByLabel('Street', { exact: true }).fill('Saved address');
  await page.getByLabel('Full name', { exact: true }).fill('Updated Patient');
  await page.getByRole('button', { name: 'Save profile', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\/account$/);
  await expect(page.getByLabel('Street', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('Street', { exact: true })).toHaveValue('Saved address');
  await page.getByRole('link', { name: 'Trips', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back, Updated Patient.', exact: true })).toBeVisible();
  await page.goto('/dashboard/patients');
  await expect(page).toHaveURL(/\/dashboard\/trips$/);
  await expect(page.getByRole('link', { name: 'Patients', exact: true })).toHaveCount(0);
  await openAccountDropdown(page);
  await page.getByRole('link', { name: 'My Account', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\/account$/);
  await expect(page.locator('.dashboard-account-identity')).toHaveCount(0);
  await openAccountDropdown(page);
  await expect(page.locator('.dashboard-profile-name').getByText('Patient', { exact: true })).toBeVisible();
});

test('patient profile failures preserve input and inactive profiles stay read-only', async ({ page }) => {
  await seedSession(page);
  await page.route('**/api/auth/me', route => route.fulfill({ json: { account: activeAccount } }));
  let mode = 'unavailable';
  let saves = 0;
  await page.route('**/api/profiles/patient', route => {
    if (route.request().method() === 'PATCH') { saves++; return route.fulfill({ status: 503, json: { message: 'Unavailable' } }); }
    if (mode === 'unavailable') return route.fulfill({ status: 503, json: { message: 'Unavailable' } });
    return route.fulfill({ json: { patient: { id: session.user.id, full_name: 'Test Patient', phone: '81234567', pickup_address: 'Test address', mobility: 'ambulant', assistance_required: false, status: mode === 'inactive' ? 'inactive' : 'active' } } });
  });
  await page.goto('/dashboard/account');
  await expect(page.getByRole('alert')).toContainText('Your profile could not be loaded.');
  await expect(page.getByLabel('Full name', { exact: true })).toHaveCount(0);
  mode = 'ready';
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await page.getByRole('button', { name: 'Edit profile', exact: true }).click();
  await page.getByLabel('Full name', { exact: true }).fill('Test Patient');
  await page.getByLabel('Contact number', { exact: true }).fill('+65 81234567');
  await page.getByLabel('Street', { exact: true }).fill('Test address');
  await page.getByLabel('Postal code', { exact: true }).fill('560123');
  await page.getByRole('button', { name: 'Save profile', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Your profile could not be saved.');
  await expect(page.getByLabel('Street', { exact: true })).toHaveValue('Test address');
  expect(saves).toBe(1);
  mode = 'inactive';
  await page.reload();
  await expect(page.getByText('Your patient profile is inactive. Contact your transport coordinator.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save profile', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Edit profile', exact: true })).toHaveCount(0);
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
    expect(body.profile.status).toBeUndefined();
    registered = true;
    return route.fulfill({ status: 201, json: { ...activeAccount, profile_complete: true } });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByLabel('Username').fill('testpatient');
  await page.getByLabel('Role').selectOption('patient');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  expect(submissions).toBe(0);
  await expect(page).toHaveURL('http://127.0.0.1:5199/');
  await expect(page.locator('.entry-card .signup-profile')).toBeVisible();
  await expect(page.locator('.dashboard-page')).toHaveCount(0);
  await page.getByLabel('Full name', { exact: true }).fill('Test Patient');
  await expect(page.getByLabel('Country code', { exact: true })).toHaveCount(0);
  const contactField = page.getByLabel('Contact number', { exact: true });
  for (const number of ['81234567', '+65 81234567', '+44 7911123456']) {
    await contactField.fill(number);
    expect(await contactField.evaluate((input: HTMLInputElement) => input.checkValidity())).toBe(true);
  }
  for (const number of ['abc', '8123456', '+65 8123456']) {
    await contactField.fill(number);
    expect(await contactField.evaluate((input: HTMLInputElement) => input.checkValidity())).toBe(false);
  }
  await page.getByLabel('Contact number', { exact: true }).fill('+65 81234567');
  await page.getByLabel('Street', { exact: true }).fill('Test street');
  await page.getByLabel('Postal code', { exact: true }).fill('560123');
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const fontSize of ['16px', '32px']) {
      await page.evaluate(size => document.documentElement.style.fontSize = size, fontSize);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (width === 1440 && fontSize === '16px') {
        const fullName = await page.getByLabel('Full name', { exact: true }).boundingBox();
        const contact = await page.getByLabel('Contact number', { exact: true }).boundingBox();
        expect(fullName!.y).toBe(contact!.y);
        expect(fullName!.x + fullName!.width).toBeLessThan(contact!.x);
      }
    }
  }
  await page.evaluate(() => document.documentElement.style.fontSize = '16px');
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByLabel('Username')).toHaveValue('testpatient');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByLabel('Street', { exact: true })).toHaveValue('Test street');
  await submitSignup(page);
  await expect(page).toHaveURL(/\/dashboard\/trips$/);
  expect(submissions).toBe(1);
});

test('landing columns stay centred between signup steps', async ({ page }) => {
  await seedSession(page);
  await page.route('**/api/auth/me', route => route.fulfill({ json: { account: null } }));
  await page.goto('/');
  await page.getByLabel('Username').fill('testpatient');
  await page.getByLabel('Role').selectOption('patient');
  for (const width of [1440, 1728]) {
    await page.setViewportSize({ width, height: 1000 });
    const intro = page.locator('.landing-intro');
    const before = await intro.boundingBox();
    const heading = await page.locator('#landing-title').boundingBox();
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    expect(await intro.boundingBox()).toEqual(before);
    expect(await page.locator('#landing-title').boundingBox()).toEqual(heading);
    const card = await page.locator('.entry-card').boundingBox();
    expect(Math.abs((before!.y + before!.height / 2) - (card!.y + card!.height / 2))).toBeLessThan(1);
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    expect(await intro.boundingBox()).toEqual(before);
  }
});

test('dashboard keeps content separated from its scrollbar at desktop scaling sizes', async ({ page }) => {
  await seedSession(page);
  await page.route('**/api/auth/me', route => route.fulfill({ json: { account: activeAccount } }));
  await page.goto('/dashboard/trips');
  await expect(page.getByRole('heading', { name: 'Next pickup', exact: true })).toBeVisible();
  for (const viewport of [{ width: 1707, height: 800 }, { width: 1920, height: 1080 }, { width: 2560, height: 1440 }]) {
    await page.setViewportSize(viewport);
    const gap = await page.locator('.dashboard-workspace').evaluate(element => {
      const content = element.querySelector('.dashboard-main')!.getBoundingClientRect();
      return element.getBoundingClientRect().left + element.clientLeft + element.clientWidth - content.right;
    });
    expect(gap).toBeGreaterThanOrEqual(16);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

test('patient Trips prioritises pickup without Overview, detached actions or personal details', async ({ page }) => {
  await seedSession(page);
  await page.route('**/api/auth/me', route => route.fulfill({ json: { account: activeAccount } }));
  let profileReads = 0;
  await page.route('**/api/profiles/patient', route => { profileReads++; return route.fulfill({ json: { patient: null } }); });
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: 'Next pickup', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Ride actions', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Overview', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Your rides', exact: true })).toBeVisible();
  for (const action of ['Confirm ride', 'Cancel ride', 'Track driver', 'Add to calendar']) {
    await expect(page.getByRole('button', { name: action, exact: true })).toHaveCount(0);
  }
  await expect(page.getByRole('heading', { name: 'Account Details', exact: true })).toHaveCount(0);
  await expect(page.getByText('No upcoming trips', { exact: true })).toHaveCount(0);
  expect(profileReads).toBe(0);
  for (const width of [320, 390, 768, 1440, 1728]) {
    await page.setViewportSize({ width, height: 900 });
    for (const size of ['16px', '32px']) {
      await page.evaluate(size => document.documentElement.style.fontSize = size, size);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  }
});

for (const [role, label] of [['coordinator', 'Transport Coordinator'], ['patient', 'Patient'], ['caregiver', 'Caregiver'], ['driver', 'Driver']]) {
  test(`${role} has function navigation and role-appropriate My Account content`, async ({ page }) => {
    await seedSession(page);
    await page.route('**/api/auth/me', route => route.fulfill({ json: { account: { ...activeAccount, role } } }));
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/dashboard\/trips$/);
    await expect(page.getByRole('link', { name: 'Overview', exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Trips', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Ride actions', exact: true })).toHaveCount(0);
    await openAccountDropdown(page);
    await expect(page.locator('.dashboard-profile-name').getByText(label, { exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'My Account', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'My Account', exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Account Details', exact: true })).toBeVisible();
    await expect(page.locator('.profile-id')).toHaveText(`${label} ID: ${role === 'patient' ? session.user.id : activeAccount.id}`);
    await expect(page.getByRole('heading', { name: 'Account Details', exact: true })).toHaveCSS('font-size', '24px');
    if (role === 'coordinator') {
      await expect(page.getByRole('heading', { name: 'Account Details', exact: true })).toBeVisible();
      await expect(page.getByRole('definition').filter({ hasText: activeAccount.email })).toBeVisible();
      await expect(page.getByRole('definition').filter({ hasText: new RegExp(`^${label}$`) })).toBeVisible();
    } else {
      await expect(page.locator('#account-details-title')).toHaveCount(0);
    }
    for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => document.documentElement.style.fontSize = '32px');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await page.reload();
    await expect(page).toHaveURL(/\/dashboard\/account$/);
    await expect(page.getByRole('heading', { name: 'Account Details', exact: true })).toHaveCount(1);
  });
}


test('My Account displays the persistent patient record ID independently of the login account ID', async ({ page }) => {
  await seedSession(page);
  await page.route('**/api/auth/me', route => route.fulfill({ json: { account: activeAccount } }));
  const patientId = '99999999-9999-4999-8999-999999999999';
  await page.route('**/api/profiles/patient', route => route.fulfill({ json: { patient: { id: patientId, full_name: 'Test Patient', phone: '+65 81234567', pickup_address: 'Test street', unit_no: '', postal_code: '560123', notes: '', mobility: 'ambulant', assistance_required: false, status: 'active' } } }));
  await page.goto('/dashboard/account');
  await expect(page.locator('.profile-id')).toHaveText(`Patient ID: ${patientId}`);
  await page.getByRole('button', { name: 'Edit profile', exact: true }).click();
  await expect(page.locator('.profile-id')).toHaveText(`Patient ID: ${patientId}`);
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => document.documentElement.style.fontSize = '32px');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.reload();
  await expect(page.locator('.profile-id')).toHaveText(`Patient ID: ${patientId}`);
});


test('profile Edit and Save hover keep dark text on the themed accent', async ({ page }) => {
  await seedSession(page);
  await page.route('**/api/auth/me', route => route.fulfill({ json: { account: activeAccount } }));
  await page.goto('/dashboard/account');
  for (const label of ['Edit profile', 'Save profile']) {
    const button = page.getByRole('button', { name: label, exact: true });
    await button.hover();
    await expect(button).toHaveCSS('color', 'rgb(16, 37, 43)');
    await expect(button).toHaveCSS('filter', 'none');
    if (label === 'Edit profile') await button.click();
  }
});


test('patient list pagination stays at the panel bottom with few, many and zero records', async ({ page }) => {
  await seedSession(page);
  await page.route('**/api/auth/me', route => route.fulfill({ json: { account: { ...activeAccount, role: 'coordinator' } } }));
  let count = 1;
  await page.route('**/api/profiles/patients**', route => route.fulfill({ json: { patients: Array.from({ length: count }, (_, index) => ({ id: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`, full_name: `Test Patient ${index}`, phone: '+65 81234567', mobility: 'walking-aid', status: 'active' })), total: count, page: 1, pageSize: 25 } }));
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const size of [1, 25, 0]) {
    count = size;
    await page.goto('/dashboard/patients');
    await expect(page.locator('.patients-pagination')).toContainText(`${count} ${count === 1 ? 'patient' : 'patients'} · Page 1`);
    const panel = await page.locator('.patients-panel').boundingBox();
    const pagination = await page.locator('.patients-pagination').boundingBox();
    const padding = await page.locator('.patients-panel').evaluate(node => parseFloat(getComputedStyle(node).paddingBottom));
    expect(Math.abs(panel!.y + panel!.height - padding - 1 - pagination!.y - pagination!.height)).toBeLessThan(2);
    if (count === 25) {
      expect(await page.locator('.patients-table-scroll').evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
      await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeInViewport();
    }
  }
});


test('patient search and column sort apply across pages and preserve bottom pagination', async ({ page }) => {
  await seedSession(page);
  await page.route('**/api/auth/me', route => route.fulfill({ json: { account: { ...activeAccount, role: 'coordinator' } } }));
  const requests: URLSearchParams[] = [];
  const patients = Array.from({ length: 30 }, (_, index) => ({ id: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`, full_name: index === 29 ? 'Zebra Needle' : `Alpha Patient ${String(index).padStart(2, '0')}`, phone: '+65 81234567', mobility: 'ambulant', status: 'active' }));
  await page.route('**/api/profiles/patients**', route => {
    const params = new URL(route.request().url()).searchParams;
    requests.push(params);
    const search = params.get('search') ?? '';
    const column = params.get('sort') as keyof typeof patients[number] | 'created_at';
    const direction = params.get('direction') === 'desc' ? -1 : 1;
    const filtered = patients.filter(patient => patient.full_name.toLowerCase().includes(search.toLowerCase()) || patient.id === search || patient.phone.includes(search));
    if (column && column !== 'created_at') filtered.sort((a, b) => String(a[column]).localeCompare(String(b[column])) * direction);
    const number = Number(params.get('page') ?? 1);
    return route.fulfill({ json: { patients: filtered.slice((number - 1) * 25, number * 25), total: filtered.length, page: number, pageSize: 25 } });
  });
  await page.goto('/dashboard/patients');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.locator('.patients-pagination')).toContainText('Page 2');
  const search = page.getByRole('searchbox', { name: 'Search patients' });
  await search.fill('Needle');
  await expect(page.getByRole('cell', { name: 'Zebra Needle', exact: true })).toBeVisible();
  await expect(page.locator('.patients-pagination')).toContainText('1 patient · Page 1');
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
  await search.fill('no match');
  await expect(page.getByText('No matching patients.', { exact: true })).toBeVisible();
  await expect(page.locator('.patients-pagination')).toContainText('0 patients · Page 1');
  await search.fill('');
  await expect(page.locator('.patients-pagination')).toContainText('30 patients');
  await expect(page.locator('.patient-sort-button span')).toHaveCount(0);
  await page.getByRole('button', { name: 'Sort by Name ascending', exact: true }).click();
  await expect(page.getByRole('columnheader', { name: 'Name', exact: true })).toHaveAttribute('aria-sort', 'ascending');
  await expect(page.locator('.patients-table tbody tr').first()).toContainText('Alpha Patient 00');
  await expect(page.locator('.patient-sort-button span')).toHaveText('▲');
  await page.getByRole('button', { name: 'Sort by Name descending', exact: true }).click();
  await expect(page.getByRole('columnheader', { name: 'Name', exact: true })).toHaveAttribute('aria-sort', 'descending');
  await expect(page.locator('.patients-table tbody tr').first()).toContainText('Zebra Needle');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.locator('.patients-pagination')).toContainText('Page 2');
  expect(requests.at(-1)!.get('sort')).toBe('full_name');
  expect(requests.at(-1)!.get('direction')).toBe('desc');
  await expect(page.locator('.patient-sort-button span')).toHaveText('▼');
  await page.getByRole('button', { name: 'Reset Name ordering', exact: true }).click();
  await expect(page.locator('.patients-pagination')).toContainText('Page 1');
  await expect(page.getByRole('columnheader', { name: 'Name', exact: true })).toHaveAttribute('aria-sort', 'none');
  await expect(page.locator('.patient-sort-button span')).toHaveCount(0);
  expect(requests.at(-1)!.get('sort')).toBe('created_at');
  await page.getByRole('button', { name: 'Sort by Name ascending', exact: true }).click();
  await page.getByRole('button', { name: 'Sort by Contact ascending', exact: true }).click();
  await expect(page.getByRole('columnheader', { name: 'Name', exact: true })).toHaveAttribute('aria-sort', 'none');
  await expect(page.getByRole('columnheader', { name: 'Contact', exact: true })).toHaveAttribute('aria-sort', 'ascending');
  await expect(page.locator('.patient-sort-button span')).toHaveCount(1);
  await expect(page.locator('.patient-sort-button span')).toHaveText('▲');
  await page.getByRole('button', { name: 'Sort by Contact descending', exact: true }).click();
  await expect(page.locator('.patient-sort-button span')).toHaveText('▼');
  await page.getByRole('button', { name: 'Reset Contact ordering', exact: true }).click();
  await expect(page.locator('.patient-sort-button span')).toHaveCount(0);
  await search.fill(patients[29].id);
  await expect(page.locator('.patients-pagination')).toContainText('1 patient · Page 1');
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => document.documentElement.style.fontSize = '32px');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

test('patients save treatment requirements and coordinators have a read-only schedule view', async ({ page }) => {
  await seedSession(page);
  let role = 'patient';
  await page.route('**/api/auth/me', route => route.fulfill({ json: { account: { ...activeAccount, role, profile_complete: true } } }));
  const centre = { id: '77777777-7777-4777-8777-777777777777', name: 'Test Centre', address: 'Test street', postal_code: '560123' };
  let schedules: Record<string, unknown>[] = [];
  let failSave = true;
  await page.route('**/api/schedules**', async route => {
    if (route.request().method() !== 'GET') {
      if (failSave) return route.fulfill({ status: 503, json: { message: 'Unavailable' } });
      const input = route.request().postDataJSON();
      expect(input.days).toEqual([1]);
      expect(input).not.toHaveProperty('patient_id');
      schedules = [{ ...input, id: centre.id, patients: { full_name: 'Test Patient' } }];
      return route.fulfill({ json: schedules[0] });
    }
    return route.fulfill({ json: { centres: [centre], schedules } });
  });
  await page.goto('/dashboard/schedules');
  await expect(page.getByRole('heading', { name: 'Treatment Schedules', exact: true })).toBeVisible();
  const panelBefore=await page.locator('.treatment-panel').boundingBox();
  await page.getByRole('button', { name: 'Add Schedule', exact: true }).click();
  await expect(page.getByRole('heading',{name:'Add Schedule',exact:true})).toBeVisible();
  await page.getByRole('combobox',{name:'Dialysis centre',exact:true}).click();
  await page.getByRole('option',{name:/Test Centre/}).click();
  await page.getByLabel('Treatment day',{exact:true}).selectOption('1');
  await page.getByLabel('Treatment day',{exact:true}).selectOption('3');
  await page.getByLabel('Treatment day',{exact:true}).selectOption('1');
  const panelAfter=await page.locator('.treatment-panel').boundingBox();
  expect(panelAfter!.width).toBe(panelBefore!.width);
  expect(panelAfter!.height).toBe(panelBefore!.height);
  await expect(page.locator('.centre-picker + .treatment-hint')).toContainText('Centre not listed?');
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await page.getByLabel('Session start').fill('09:00');
  await page.getByLabel('Session end').fill('13:00');
  await page.getByLabel('Effective from').fill('2026-10-20');
  await page.getByLabel('Effective to').fill('2026-12-31');
  await page.getByRole('button', { name: 'Save Schedule', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('could not be saved');
  await expect(page.getByLabel('Session start')).toHaveValue('09:00');
  failSave = false;
  await page.getByRole('button', { name: 'Save Schedule', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit Schedule', exact: true })).toBeVisible();
  await expect(page.getByText('Test Centre', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Edit Schedule', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit Schedule', exact: true }).click();
  await expect(page.getByRole('heading',{name:'Edit Schedule',exact:true})).toBeVisible();
  for (const width of [320,390,768,1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const size of [16,32]) {
      await page.evaluate(size => { document.documentElement.style.fontSize = `${size}px`; }, size);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    }
    await page.evaluate(() => { document.documentElement.style.fontSize = '16px'; });
  }
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  role = 'coordinator';
  await page.reload();
  await expect(page.getByText('Test Patient', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add Schedule', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Edit Schedule', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Reschedule Session', exact: true })).toHaveCount(0);
});

test('centre search matches name, address and postcode and displays only a selected read-only address', async ({ page }) => {
  await seedSession(page);
  await page.route('**/api/auth/me', route => route.fulfill({ json: { account: { ...activeAccount, role: 'patient', profile_complete: true } } }));
  const centres = [
    { id:'77777777-7777-4777-8777-777777777777',name:'Test Centre',address:'Blk 10 Example Road #01-01',postal_code:'560123' },
    { id:'88888888-8888-4888-8888-888888888888',name:'Another Centre',address:'Blk 20 Other Street #02-02',postal_code:'730123' },
  ];
  await page.route('**/api/schedules',route => route.fulfill({ json: { centres,schedules:[] } }));
  await page.goto('/dashboard/schedules');
  await page.getByRole('button',{name:'Add Schedule',exact:true}).click();
  const search=page.getByRole('combobox',{name:'Dialysis centre',exact:true});
  for (const term of ['test','EXAMPLE ROAD','560123']) {
    await search.fill(term);
    await expect(page.getByRole('listbox',{name:'Dialysis centres'}).getByRole('option')).toHaveCount(1);
    await page.getByRole('option',{name:/Test Centre/}).click();
    await expect(page.getByLabel('Centre address',{exact:true})).toHaveValue('Blk 10 Example Road #01-01, Singapore 560123');
    await expect(page.getByLabel('Centre address',{exact:true})).toBeDisabled();
  }
  await search.fill('not a real centre');
  await expect(page.getByText('No matching centres. Try another search.',{exact:true})).toBeVisible();
  await expect(page.getByLabel('Centre address',{exact:true})).toHaveValue('');
  await search.fill('730123');
  await search.press('ArrowDown');
  await search.press('Enter');
  await expect(page.getByLabel('Centre address',{exact:true})).toHaveValue('Blk 20 Other Street #02-02, Singapore 730123');
  for (const width of [320,390,1440]) {
    await page.setViewportSize({width,height:900});
    await page.evaluate(() => { document.documentElement.style.fontSize='32px'; });
    expect(await page.evaluate(() => document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  }
});

for (const scenario of [
  { role: 'coordinator', centres: false, failure: false, title: 'No dialysis centres are available.' },
  { role: 'coordinator', centres: true, failure: false, title: 'No treatment schedules yet.' },
  { role: 'patient', centres: false, failure: false, title: 'No dialysis centres are available.' },
  { role: 'patient', centres: true, failure: true, title: 'Treatment schedules could not be loaded. Please try again.' },
]) test(`schedule empty state uses shared styling for ${scenario.role} centres=${scenario.centres} failure=${scenario.failure}`, async ({ page }) => {
  await seedSession(page);
  await page.route('**/api/auth/me',route => route.fulfill({json:{account:{...activeAccount,role:scenario.role,profile_complete:true}}}));
  await page.route('**/api/schedules',route => route.fulfill(scenario.failure
    ? {status:503,json:{message:'Unavailable'}}
    : {json:{centres:scenario.centres ? [{id:'77777777-7777-4777-8777-777777777777',name:'Test Centre',address:'Test street',postal_code:'560123'}] : [],schedules:[]}}));
  await page.goto('/dashboard/schedules');
  const state=page.locator('.treatment-panel .dashboard-data-status');
  await expect(state.getByRole('heading',{name:scenario.title,exact:true})).toBeVisible();
  await expect(state.locator('.dashboard-data-status-icon svg')).toBeVisible();
  if(scenario.role==='coordinator') await expect(page.getByText(/contact your transport coordinator/i)).toHaveCount(0);
  if(scenario.role==='patient' && !scenario.centres) await expect(state).toContainText('Contact your Transport Coordinator.');
  if(scenario.failure) await expect(state.getByRole('button',{name:'Try again'})).toBeVisible();
  if(scenario.role==='coordinator') await expect(state).not.toContainText('Your upcoming');
  for(const width of [390,1440]) {
    await page.setViewportSize({width,height:900});
    if(width===390) await page.locator('.dashboard-menu-toggle').click();
    const nav=width===390 ? page.getByRole('dialog',{name:'Menu navigation'}) : page.getByRole('navigation',{name:'Dashboard'});
    await expect(nav.getByRole('link',{name:'Schedules',exact:true})).toBeVisible();
    await expect(nav.getByRole('link',{name:'Treatment Schedules',exact:true})).toHaveCount(0);
    if(width===390) await page.keyboard.press('Escape');
    expect(await page.evaluate(() => document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  }
});

test('schedule loading indicator is centred inside the panel on desktop and mobile', async ({ page }) => {
  await seedSession(page);
  await page.route('**/api/auth/me',route => route.fulfill({json:{account:{...activeAccount,role:'coordinator'}}}));
  await page.route('**/api/schedules', () => {});
  await page.goto('/dashboard/schedules');
  const panel=page.locator('.treatment-panel');
  const loader=panel.locator('.account-loading');
  await expect(loader).toBeVisible();
  for(const width of [1440,390]) {
    await page.setViewportSize({width,height:900});
    const bounds=await panel.boundingBox();
    const heading=await panel.locator('header').boundingBox();
    const spinner=await loader.locator('.account-spinner').boundingBox();
    const text=await loader.getByText('Loading...', {exact:true}).boundingBox();
    const groupCentre=(spinner!.x+text!.x+text!.width)/2;
    expect(Math.abs(groupCentre-(bounds!.x+bounds!.width/2))).toBeLessThan(3);
    const contentCentre=(heading!.y+heading!.height+bounds!.y+bounds!.height)/2;
    expect(Math.abs(spinner!.y+spinner!.height/2-contentCentre)).toBeLessThan(20);
  }
});

test('patient schedule heading stays in place when the Add Schedule action loads', async ({ page }) => {
  await seedSession(page);
  await page.route('**/api/auth/me',route => route.fulfill({json:{account:{...activeAccount,role:'patient',profile_complete:true}}}));
  let release: () => void = () => {};
  await page.route('**/api/schedules',async route => {
    await new Promise<void>(resolve => { release=resolve; });
    await route.fulfill({json:{centres:[{id:'77777777-7777-4777-8777-777777777777',name:'Test Centre',address:'Test street',postal_code:'560123'}],schedules:[]}});
  });
  for(const width of [1440,390]) {
    await page.setViewportSize({width,height:900});
    await page.goto('/dashboard/schedules');
    await expect(page.locator('.treatment-panel .account-loading')).toBeVisible();
    const heading=page.getByRole('heading',{name:'Treatment Schedules',exact:true});
    const before=await heading.boundingBox();
    await expect(page.getByRole('button',{name:'Add Schedule',exact:true})).toBeHidden();
    release();
    await expect(page.getByRole('button',{name:'Add Schedule',exact:true})).toBeVisible();
    expect(await heading.boundingBox()).toEqual(before);
  }
});

test('centre picker stays bounded with many results and supports keyboard selection', async ({ page }) => {
  await seedSession(page);
  await page.route('**/api/auth/me',route => route.fulfill({json:{account:{...activeAccount,role:'patient',profile_complete:true}}}));
  const centres=Array.from({length:45},(_,i)=>({id:`77777777-7777-4777-8777-${String(i).padStart(12,'0')}`,name:`Test Dialysis Centre ${String(i).padStart(2,'0')}`,address:`Blk ${i+1} Example Street #01-01`,postal_code:'560123'}));
  await page.route('**/api/schedules',route => route.fulfill({json:{centres,schedules:[]}}));
  await page.goto('/dashboard/schedules');
  await page.getByRole('button',{name:'Add Schedule',exact:true}).click();
  const picker=page.getByRole('combobox',{name:'Dialysis centre',exact:true});
  for(const width of [1440,390]) {
    await page.setViewportSize({width,height:900});
    await picker.click();
    const list=page.getByRole('listbox',{name:'Dialysis centres'});
    await expect(list.getByRole('option')).toHaveCount(45);
    const bounds=await list.boundingBox();
    expect(bounds!.height).toBeLessThanOrEqual(224);
    expect(await list.evaluate(el=>el.scrollHeight>el.clientHeight)).toBe(true);
    await picker.press('End');
    await picker.press('ArrowDown');
    await picker.press('Enter');
    await expect(picker).toHaveValue('Test Dialysis Centre 01');
    await picker.click();
    await picker.press('Escape');
    await expect(list).toBeHidden();
  }
});

test('schedule form overlays the list, keeps address space stable and restores focus on dismissal', async ({ page }) => {
  await seedSession(page);
  await page.route('**/api/auth/me',route => route.fulfill({json:{account:{...activeAccount,role:'patient',profile_complete:true}}}));
  const centre={id:'77777777-7777-4777-8777-777777777777',name:'Test Centre',address:'Test street',postal_code:'560123'};
  await page.route('**/api/schedules',route => route.fulfill({json:{centres:[centre],schedules:[]}}));
  for(const width of [1440,390]) {
    await page.setViewportSize({width,height:900});
    await page.goto('/dashboard/schedules');
    const add=page.getByRole('button',{name:'Add Schedule',exact:true});
    await add.click();
    const dialog=page.getByRole('dialog',{name:'Add Schedule',exact:true});
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading',{name:'Add Schedule',exact:true})).toBeFocused();
    expect(await page.evaluate(()=>document.body.style.overflow)).toBe('hidden');
    await dialog.getByRole('button',{name:'Save Schedule',exact:true}).focus();
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate(element=>element.contains(document.activeElement))).toBe(true);
    const address=dialog.getByLabel('Centre address',{exact:true});
    await expect(address).toBeVisible();
    const dayBefore=await dialog.getByLabel('Treatment day',{exact:true}).boundingBox();
    await dialog.getByRole('combobox',{name:'Dialysis centre',exact:true}).click();
    await page.getByRole('option',{name:/Test Centre/}).click();
    await expect(address).toHaveValue('Test street, Singapore 560123');
    expect(await dialog.getByLabel('Treatment day',{exact:true}).boundingBox()).toEqual(dayBefore);
    await dialog.getByLabel('Treatment day',{exact:true}).focus();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(add).toBeFocused();
    expect(await page.evaluate(()=>document.body.style.overflow)).toBe('');
    await add.click();
    await page.getByRole('dialog',{name:'Add Schedule',exact:true}).getByRole('button',{name:'Cancel',exact:true}).click();
    await expect(dialog).toBeHidden();
    await expect(add).toBeFocused();
    await add.click();
    await page.mouse.click(2,2);
    await expect(dialog).toBeHidden();
    await expect(add).toBeFocused();
  }
});

test('coordinator patient details overlay preserves the list and returns focus after dismissal', async ({ page }) => {
  await seedSession(page);
  await page.route('**/api/auth/me',route=>route.fulfill({json:{account:{...activeAccount,role:'coordinator'}}}));
  const patient={id:session.user.id,full_name:'Test Patient',phone:'+65 81234567',pickup_address:'Test street',unit_no:'#01-01',postal_code:'560123',mobility:'ambulant',assistance_required:false,status:'active',notes:''};
  await page.route('**/api/profiles/patients**',route=>route.fulfill({json:{patients:[patient],total:1,page:1,pageSize:25}}));
  for(const width of [1440,390]) {
    await page.setViewportSize({width,height:900});
    await page.goto('/dashboard/patients');
    await page.getByRole('searchbox',{name:'Search patients'}).fill('Test');
    const view=page.getByRole('button',{name:'View Test Patient',exact:true});
    await expect(view).toBeEnabled();
    await view.scrollIntoViewIfNeeded();
    const before=await page.locator('.patients-table').boundingBox();
    await view.click();
    const dialog=page.getByRole('dialog',{name:'Patient Details',exact:true});
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading',{name:'Patient Details',exact:true})).toBeFocused();
    expect(await page.locator('.patients-table').boundingBox()).toEqual(before);
    expect(await page.evaluate(()=>document.body.style.overflow)).toBe('hidden');
    await dialog.getByRole('button',{name:'Edit Patient',exact:true}).focus();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button',{name:'Close',exact:true})).toBeFocused();
    await dialog.getByRole('button',{name:'Edit Patient',exact:true}).click();
    await expect(dialog.getByLabel('Full name',{exact:true})).toBeDisabled();
    await dialog.getByLabel('Notes',{exact:true}).fill('Discard on dismissal.');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(view).toBeFocused();
    await expect(page.getByRole('searchbox',{name:'Search patients'})).toHaveValue('Test');
    expect(await page.evaluate(()=>document.body.style.overflow)).toBe('');
    await view.click();
    await expect(dialog.getByLabel('Notes',{exact:true})).toHaveValue('');
    await page.mouse.click(2,2);
    await expect(dialog).toBeHidden();
    await expect(view).toBeFocused();
    await view.click();
    await dialog.getByRole('button',{name:'Close',exact:true}).click();
    await expect(dialog).toBeHidden();
    await expect(view).toBeFocused();
  }
});

test('patient records an independent single session without recurring fields', async ({ page }) => {
  await seedSession(page);
  await page.route('**/api/auth/me',route=>route.fulfill({json:{account:{...activeAccount,role:'patient',profile_complete:true}}}));
  const centre={id:'77777777-7777-4777-8777-777777777777',name:'Test Centre',address:'Test street',postal_code:'560123'};
  let saved: Record<string,unknown>|null=null;
  await page.route('**/api/schedules**',route=>{
    if(route.request().method()!=='GET') {
      const input=route.request().postDataJSON();
      expect(input).toEqual({kind:'single',centre_id:centre.id,session_date:'2026-10-27',start_time:'09:00',end_time:'13:00'});
      saved={...input,id:centre.id,days:[2],effective_from:input.session_date,effective_to:input.session_date,patients:{full_name:'Test Patient'}};
      return route.fulfill({json:saved});
    }
    return route.fulfill({json:{centres:[centre],schedules:saved?[saved]:[]}});
  });
  await page.goto('/dashboard/schedules');
  await page.getByRole('button',{name:'Add Schedule',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Add Schedule',exact:true});
  await dialog.getByLabel('Schedule type',{exact:true}).selectOption('single');
  await expect(dialog.getByLabel('Treatment day',{exact:true})).toHaveCount(0);
  await expect(dialog.getByLabel('Effective from',{exact:true})).toHaveCount(0);
  await dialog.getByRole('combobox',{name:'Dialysis centre',exact:true}).click();
  await page.getByRole('option',{name:/Test Centre/}).click();
  await dialog.getByLabel('Session date',{exact:true}).fill('2026-10-27');
  await dialog.getByLabel('Session start',{exact:true}).fill('09:00');
  await dialog.getByLabel('Session end',{exact:true}).fill('13:00');
  await dialog.getByRole('button',{name:'Save Schedule',exact:true}).click();
  await expect(page.getByText('Single Session',{exact:true})).toBeVisible();
  await expect(page.getByRole('heading',{name:/27 Oct 2026/})).toBeVisible();
  await page.reload();
  await page.getByRole('button',{name:'Edit Schedule',exact:true}).click();
  await expect(page.getByLabel('Schedule type',{exact:true})).toBeDisabled();
  await expect(page.getByLabel('Session date',{exact:true})).toHaveValue('2026-10-27');
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
});

test('rescheduling replaces one recurring occurrence and failed saves leave the series unchanged', async ({ page }) => {
  await page.setViewportSize({width:390,height:900});
  await seedSession(page);
  await page.route('**/api/auth/me',route=>route.fulfill({json:{account:{...activeAccount,role:'patient',profile_complete:true}}}));
  const centre={id:'77777777-7777-4777-8777-777777777777',name:'Test Centre',address:'Test street',postal_code:'560123'};
  const series={id:'88888888-8888-4888-8888-888888888888',kind:'recurring',centre_id:centre.id,days:[1],start_time:'09:00',end_time:'13:00',effective_from:'2026-10-19',effective_to:'2026-12-31',patients:{full_name:'Test Patient'}};
  let replacement: Record<string,unknown>|null=null;
  let fail=true; let writes=0;
  await page.route('**/api/schedules**',route=>{
    if(route.request().method()!=='GET') {
      writes++;
      if(fail) return route.fulfill({status:503,json:{message:'Unavailable'}});
      const input=route.request().postDataJSON();
      expect(input.replaces_schedule_id).toBe(series.id);
      expect(input.replaces_date).toBe('2026-10-26');
      expect(input.session_date).toBe('2026-10-27');
      replacement={...input,id:centre.id,days:[2],effective_from:input.session_date,effective_to:input.session_date,patients:{full_name:'Test Patient'}};
      return route.fulfill({json:replacement});
    }
    return route.fulfill({json:{centres:[centre],schedules:[series,...(replacement?[replacement]:[])]}});
  });
  await page.goto('/dashboard/schedules');
  await page.getByRole('button',{name:'Reschedule Session',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Reschedule Session',exact:true});
  await dialog.getByLabel('Original session date',{exact:true}).fill('2026-10-27');
  await dialog.getByLabel('Session date',{exact:true}).fill('2026-10-28');
  await dialog.getByRole('button',{name:'Save Schedule',exact:true}).click();
  await expect(dialog.getByRole('alert')).toContainText('valid occurrence');
  expect(writes).toBe(0);
  await dialog.getByLabel('Original session date',{exact:true}).fill('2026-10-26');
  await dialog.getByLabel('Session date',{exact:true}).fill('2026-10-27');
  await dialog.getByRole('button',{name:'Save Schedule',exact:true}).click();
  await expect(dialog.getByRole('alert')).toContainText('could not be saved');
  await expect(dialog.getByLabel('Original session date',{exact:true})).toHaveValue('2026-10-26');
  expect(replacement).toBeNull();
  fail=false;
  await dialog.getByRole('button',{name:'Save Schedule',exact:true}).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Rescheduled Session',{exact:true})).toBeVisible();
  await expect(page.getByText('Rescheduled dates: 26 Oct 2026',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Reschedule Session',exact:true}).click();
  await dialog.getByLabel('Original session date',{exact:true}).fill('2026-10-26');
  await dialog.getByRole('button',{name:'Save Schedule',exact:true}).click();
  await expect(dialog.getByRole('alert')).toContainText('already been rescheduled');
  expect(writes).toBe(2);
  for(const width of [320,390,1440]) {
    await page.setViewportSize({width,height:900});
    await page.evaluate(()=>{document.documentElement.style.fontSize='32px';});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  }
  await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
});
