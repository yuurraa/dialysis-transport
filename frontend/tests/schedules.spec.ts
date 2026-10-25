import { test, expect, session, seedSession, activeAccount, chooseOption, mockServices } from './support/fixtures';

test.beforeEach(mockServices);

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
      schedules = [{ ...input, id: centre.id, version: 1, patients: { full_name: 'Test Patient' } }];
      return route.fulfill({ json: schedules[0] });
    }
    return route.fulfill({ json: { centres: [centre], schedules } });
  });
  await page.goto('/dashboard/schedules');
  await expect(page.getByRole('heading', { name: 'Treatment Schedules', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add Schedule', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Add Schedule', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Dialysis centre', exact: true }).click();
  await page.getByRole('option', { name: /Test Centre/ }).click();
  await chooseOption(page.getByLabel('Treatment day', { exact: true }), '1');
  await chooseOption(page.getByLabel('Treatment day', { exact: true }), '3');
  await chooseOption(page.getByLabel('Treatment day', { exact: true }), '1');
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
  await expect(page.getByRole('heading', { name: 'Edit Schedule', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  role = 'coordinator';
  await page.reload();
  await expect(page.getByText('Test Patient', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add Schedule', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Edit Schedule', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Reschedule Session', exact: true })).toHaveCount(0);
});

test('rescheduling replaces one recurring occurrence and failed saves leave the series unchanged', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await seedSession(page);
  await page.route('**/api/auth/me', route => route.fulfill({ json: { account: { ...activeAccount, role: 'patient', profile_complete: true } } }));
  const centre = { id: '77777777-7777-4777-8777-777777777777', name: 'Test Centre', address: 'Test street', postal_code: '560123' };
  const series = { id: '88888888-8888-4888-8888-888888888888', kind: 'recurring', centre_id: centre.id, days: [1], start_time: '09:00', end_time: '13:00', effective_from: '2026-10-19', effective_to: '2026-12-31', version: 1, patients: { full_name: 'Test Patient' } };
  let replacement: Record<string, unknown> | null = null;
  let fail = true; let writes = 0;
  await page.route('**/api/schedules**', route => {
    if (route.request().method() !== 'GET') {
      writes++;
      if (fail) return route.fulfill({ status: 503, json: { message: 'Unavailable' } });
      const input = route.request().postDataJSON();
      expect(input.replaces_schedule_id).toBe(series.id);
      expect(input.replaces_date).toBe('2026-10-26');
      expect(input.session_date).toBe('2026-10-27');
      replacement = { ...input, id: centre.id, days: [2], effective_from: input.session_date, effective_to: input.session_date, version: 1, patients: { full_name: 'Test Patient' } };
      return route.fulfill({ json: replacement });
    }
    return route.fulfill({ json: { centres: [centre], schedules: [series, ...(replacement ? [replacement] : [])] } });
  });
  await page.goto('/dashboard/schedules');
  await page.getByRole('button', { name: 'Edit Schedule', exact: true }).first().click();
  await chooseOption(page.getByLabel('Apply changes to'), 'occurrence');
  const dialog = page.getByRole('dialog', { name: 'Edit Schedule', exact: true });
  await expect(dialog).toBeVisible();
  const source = dialog.getByRole('combobox', { name: 'Session to change', exact: true });
  await expect(source).toBeVisible();
  await source.click();
  await expect(page.getByRole('listbox', { name: 'Session to change', exact: true }).locator('[data-value="2026-10-27"]')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(dialog.getByLabel('Schedule type', { exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Save Schedule', exact: true }).click();
  await expect(dialog.locator('.auth-toast[role="alert"]')).toContainText('session');
  expect(writes).toBe(0);
  await dialog.getByRole('button', { name: 'Dismiss notification' }).click();
  await chooseOption(source, '2026-10-26');
  await expect(dialog.getByLabel('New session date', { exact: true })).toHaveValue('2026-10-26');
  await chooseOption(source, '2026-11-02');
  await expect(dialog.getByLabel('New session date', { exact: true })).toHaveValue('2026-11-02');
  await dialog.getByLabel('New session date', { exact: true }).fill('2026-10-27');
  await chooseOption(source, '2026-10-26');
  await expect(dialog.getByLabel('New session date', { exact: true })).toHaveValue('2026-10-27');
  await dialog.getByRole('button', { name: 'Save Schedule', exact: true }).click();
  await expect(dialog.locator('.auth-toast[role="alert"]')).toContainText('could not be saved');
  await expect(source).toHaveText('Monday, 26 Oct 2026');
  expect(replacement).toBeNull();
  fail = false;
  await dialog.getByRole('button', { name: 'Save Schedule', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Rescheduled Session', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '1 rescheduled session', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit Schedule', exact: true }).first().click();
  await chooseOption(page.getByLabel('Apply changes to'), 'occurrence');
  await source.click();
  await expect(page.getByRole('listbox', { name: 'Session to change', exact: true }).locator('[data-value="2026-10-26"]')).toHaveCount(0);
  await page.keyboard.press('Escape');
  expect(writes).toBe(2);

  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
});

test('coordinator opts into automatic generation per schedule and reloads stale settings', async ({ page }) => {
  await seedSession(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/auth/me', route => route.fulfill({ json: { account: { ...activeAccount, role: 'coordinator' } } }));
  const centre = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Fixture Centre', address: 'Fixture road', postal_code: '560123' };
  let setting = { enabled: false, version: 0 }; let stale = true;
  const schedule = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', version: 1, patient_id: session.user.id, patients: { full_name: 'Fixture Patient' }, kind: 'recurring', days: [1], start_time: '09:00', end_time: '13:00', centre_id: centre.id, effective_from: '2027-01-04', effective_to: '2027-03-29' };
  await page.route('**/api/schedules?*', async route => {
    return route.fulfill({ json: { centres: [centre], schedules: [{ ...schedule, auto_generation: setting }], context: [], total: 1, page: 1, pageSize: 10 } });
  });
  await page.route('**/api/schedules/*/auto-generation', route => {
    expect(route.request().method()).toBe('PATCH');
    const input = route.request().postDataJSON();
    expect(input.version).toBe(1);
    expect(input.setting_version).toBe(setting.version);
    if (stale) { stale = false; return route.fulfill({ status: 409, json: { message: 'Setting changed.' } }); }
    setting = { enabled: input.enabled, version: setting.version + 1 };
    return route.fulfill({ json: setting });
  });
  await page.goto('/dashboard/schedules');
  await page.getByRole('button', { name: 'Generate Trips', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Generate Trips', exact: true });
  await expect(dialog).toBeVisible();
  const toggle = dialog.getByRole('switch', { name: 'Auto-generate trips', exact: true });
  await expect(toggle).not.toBeChecked();
  await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
  await toggle.click();
  await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
  expect(setting.enabled).toBe(false);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: 'Generate Trips', exact: true }).click();
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Reload schedules');
  await expect(toggle).toBeChecked();
  await dialog.getByRole('button', { name: 'Reload schedules', exact: true }).click();
  await toggle.click();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(toggle).toBeChecked();
  await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
  await expect(page.getByText('Automatic trip generation enabled.', { exact: true })).toBeVisible();
  await toggle.click();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(toggle).not.toBeChecked();
  await expect(page.getByText('Automatic trip generation disabled. Existing trips kept.', { exact: true })).toBeVisible();
});
