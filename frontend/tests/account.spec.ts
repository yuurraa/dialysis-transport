import { test, expect, session, seedSession, activeAccount, mockServices } from './support/fixtures';

test.beforeEach(mockServices);

test('patient profile failures preserve input and inactive profiles stay read-only', async ({ page }) => {
  await seedSession(page);
  await page.route('**/api/auth/me', route => route.fulfill({ json: { account: activeAccount } }));
  let mode = 'unavailable';
  let saves = 0;
  await page.route('**/api/profiles/patient', route => {
    if (route.request().method() === 'PATCH') { saves++; return route.fulfill({ status: 503, json: { message: 'Unavailable' } }); }
    if (mode === 'unavailable') return route.fulfill({ status: 503, json: { message: 'Unavailable' } });
    return route.fulfill({ json: { patient: { id: session.user.id, full_name: 'Test Patient', birth_date: '1990-04-12', gender: 'female', phone: '81234567', pickup_address: 'Test address', mobility: 'ambulant', assistance_required: false, status: mode === 'inactive' ? 'inactive' : 'active' } } });
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

test("patient profile conflicts preserve the draft until the latest details are reloaded", async ({ page }) => {
  await seedSession(page);
  await page.route('**/api/auth/me', route => route.fulfill({ json: { account: { ...activeAccount, role: "patient", profile_complete: true } } }));
  let patient = { id: '11111111-1111-4111-8111-111111111111', version: 3, full_name: 'Fixture Patient', birth_date: '1990-04-12', gender: 'female', phone: '+65 81234567', pickup_address: 'Fixture street', unit_no: '', postal_code: '560123', notes: 'Original notes', mobility: 'ambulant', assistance_required: false, status: 'active' };
  await page.route('**/api/profiles/patient**', route => {
    if (route.request().method() === 'GET')
      return route.fulfill({ json: { patient } });
    expect(route.request().postDataJSON().version).toBe(3);
    patient = { ...patient, version: 4, notes: 'Latest server notes' };
    return route.fulfill({ status: 409, json: { message: 'Changed' } });
  });
  await page.goto('/dashboard/account');
  await page.getByRole('button', { name: 'Edit profile', exact: true }).click();
  const editor = page.locator('.patient-profile-form');
  const notes = editor.getByLabel('Notes', { exact: true });
  await notes.fill('My unsaved notes');
  await page.getByRole('button', { name: 'Save profile', exact: true }).click();
  await expect(editor.getByRole('alert')).toContainText('changed');
  await expect(notes).toHaveValue('My unsaved notes');
  await expect(page.getByRole('button', { name: 'Save profile', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Reload latest details', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Your patient details' }).getByLabel('Notes', { exact: true })).toHaveValue('Latest server notes');
});

test("patient edits their profile in place, discards drafts and saves once", async ({ page }) => {
  await seedSession(page);
  await page.route('**/api/auth/me', route => route.fulfill({ json: { account: activeAccount } }));
  let saves = 0;
  let releaseSave: (() => void) | undefined;
  const patient = { id: session.user.id, version: 1, full_name: 'Fixture Patient', birth_date: '1990-04-12', gender: 'female', phone: '+65 81234567', pickup_address: 'Fixture Street', unit_no: '', postal_code: '560123', notes: '', mobility: 'ambulant', assistance_required: false, status: 'active' };
  await page.route('**/api/profiles/patient', async (route) => {
    if (route.request().method() === 'GET')
      return route.fulfill({ json: { patient } });
    saves++;
    const body = route.request().postDataJSON();
    await new Promise<void>(resolve => { releaseSave = resolve; });
    Object.assign(patient, body, { version: patient.version + 1 });
    return route.fulfill({ json: patient });
  });
  const width = 375;

  await page.setViewportSize({ width, height: 900 });
  await page.goto('/dashboard/account');
  const name = page.getByLabel('Full name', { exact: true });
  const street = page.getByLabel('Street', { exact: true });
  await expect(name).toBeDisabled();
  const savesBeforeEdit = saves;
  await page.getByRole('button', { name: 'Edit profile', exact: true }).click();
  expect(saves).toBe(savesBeforeEdit);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(name).toBeEnabled();
  await street.fill('Unsaved Street');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(street).toHaveValue(patient.pickup_address);
  await expect(name).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Edit profile', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Edit profile', exact: true }).click();
  await street.fill(`Saved Street ${width}`);
  const before = saves;
  await page.getByRole('button', { name: 'Save profile', exact: true }).click();
  await expect.poll(() => saves).toBe(before + 1);
  try {
    await expect(name).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Saving…', exact: true })).toBeDisabled();
    expect(saves).toBe(before + 1);
  }
  finally {
    releaseSave?.();
  }
  await expect(page.getByRole('button', { name: 'Edit profile', exact: true })).toBeFocused();
  await expect(street).toHaveValue(`Saved Street ${width}`);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

});
