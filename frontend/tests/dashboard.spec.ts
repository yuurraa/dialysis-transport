import { test, expect, session, seedSession, openAccountDropdown, activeAccount, mockServices } from './support/fixtures';

test.beforeEach(mockServices);

for (const access of ['signed-out', 'unregistered', 'driver', 'caregiver', 'inactive'] as const) {
  test(`${access} users cannot open the coordinator dashboard`, async ({ page }) => {
    if (access !== 'signed-out') await seedSession(page);
    await page.route('**/api/auth/me', route => route.fulfill({
      json: {
        account: access === 'unregistered' ? null
          : { ...activeAccount, role: access === 'inactive' ? 'coordinator' : access, status: access === 'inactive' ? 'inactive' : 'active' }
      }
    }));
    await page.goto(access === 'driver' || access === 'caregiver' ? '/dashboard/patients' : '/dashboard/account');
    if (access === 'driver' || access === 'caregiver') {
      await expect(page).toHaveURL(access === 'driver' ? /\/dashboard\/vehicle$/ : /\/dashboard\/trips$/);
      await expect(page.getByRole('link', { name: 'Patients', exact: true })).toHaveCount(0);
      return;
    }
    if (access === 'unregistered') {
      // Wait for session restoration and the account lookup before checking the redirect.
      await expect(page.getByRole('heading', { name: 'Create your account', exact: true })).toBeVisible({ timeout: 10000 });
    }
    await expect(page).toHaveURL('http://127.0.0.1:5199/');
    await expect(page.locator('.dashboard-page')).toHaveCount(0);
  });
}

test('mobile navigation traps focus, supports dismissal and opens protected pages', async ({ page }) => {
  await seedSession(page);
  await page.route('**/api/auth/me', route => route.fulfill({ json: { account: { ...activeAccount, role: 'coordinator' } } }));
  await page.goto('/dashboard');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const width = 375;

  await page.setViewportSize({ width, height: 900 });
  const toggle = page.locator('.dashboard-menu-toggle');
  const drawer = page.getByRole('dialog', { name: 'Menu navigation' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.dashboard-header .dashboard-brand')).toBeHidden();
  await toggle.click();
  await expect(drawer).toBeVisible();
  await expect(drawer.locator('.dashboard-brand-symbol')).toHaveText('DT');
  await expect(drawer.getByRole('button', { name: 'Close navigation' })).toHaveText('');
  await drawer.evaluate(element => {
    element.addEventListener('animationstart', event => {
      if ((event as AnimationEvent).animationName === 'drawer-exit') element.setAttribute('data-exit-was-open', String((element as HTMLDialogElement).open));
    });
  });

  await expect(drawer.getByRole('button', { name: 'Close navigation' })).toBeFocused();
  expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden');
  await page.keyboard.press('Tab');
  await expect(drawer.getByRole('link', { name: 'Trips', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(drawer.getByRole('link', { name: 'Schedules', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(drawer.getByRole('link', { name: 'Patients', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(drawer.getByRole('link', { name: 'Drivers', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(drawer.getByRole('button', { name: 'Close navigation' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(drawer).toHaveAttribute('data-exit-was-open', 'true');
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
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await toggle.click();
  await expect(drawer).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(toggle).toBeFocused();


});

for (const [role, label] of [['coordinator', 'Transport Coordinator'], ['patient', 'Patient']]) {
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
    await expect(page.getByText('Account Management', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'My Account', exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Account Details', exact: true })).toBeVisible();
    await expect(page.locator('.profile-id')).toHaveText(`${label} ID: ${role === 'patient' ? session.user.id : activeAccount.id}`);
    if (role === 'coordinator') {
      await expect(page.getByRole('heading', { name: 'Account Details', exact: true })).toBeVisible();
      const details = page.getByRole('group', { name: 'Coordinator account details', exact: true });
      await expect(details.getByLabel('Username', { exact: true })).toHaveValue(activeAccount.display_name);
      await expect(details.getByLabel('Email', { exact: true })).toHaveValue(activeAccount.email);
      await expect(details.getByLabel('Role', { exact: true })).toHaveValue(label);
      await expect(details.getByLabel('Status', { exact: true })).toHaveValue('Active');
      for (const field of ['Username', 'Email', 'Role', 'Status']) await expect(details.getByLabel(field, { exact: true })).toBeDisabled();
      await expect(page.getByRole('button', { name: /Edit (profile|account)/i })).toHaveCount(0);
    } else {
      await expect(page.locator('#account-details-title')).toHaveCount(0);
    }

    await page.reload();
    await expect(page).toHaveURL(/\/dashboard\/account$/);
    await expect(page.getByRole('heading', { name: 'Account Details', exact: true })).toHaveCount(1);
  });
}
