import { test, expect, seedSession, activeAccount, mockServices } from './support/fixtures';

test.beforeEach(mockServices);

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
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await toggle.click();
  await expect(drawer).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(toggle).toBeFocused();

});
