import { test, expect, session, seedSession, activeAccount, chooseOption, mockServices } from './support/fixtures';

test.beforeEach(mockServices);

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
  await expect(page.getByRole('heading', { name: 'Patient List', exact: true })).toBeVisible();
  await expect(page.getByText('Patient Management', { exact: true })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Patient ID', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: patient.id, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add patient', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'View Test Patient', exact: true }).click();
  const details = page.getByRole('dialog', { name: 'Patient Details', exact: true });
  await expect(details.getByRole('heading', { name: 'Patient Details', exact: true })).toBeVisible();
  await expect(page.locator('.profile-id')).toHaveText(`Patient ID: ${patient.id}`);
  await expect(page.getByRole('dialog', { name: 'Patient Details', exact: true }).getByText('Patient Management', { exact: true })).toHaveCount(0);
  await expect(details.getByRole('heading', { name: 'Patient List', exact: true })).toHaveCount(0);
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
  await chooseOption(details.getByLabel('Status', { exact: true }), 'inactive');
  await details.getByLabel('Notes', { exact: true }).fill('Coordinator note.');
  await page.getByRole('button', { name: 'Save Patient', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit Patient', exact: true })).toBeVisible();
  await expect(details.getByLabel('Notes', { exact: true })).toHaveValue('Coordinator note.');
  await expect(details.getByLabel('Notes', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save Patient', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: /^Close / }).click();
  await expect(page.getByRole('button', { name: 'View Test Patient', exact: true })).toBeFocused();
  await page.reload();
  await expect(page.getByRole('cell', { name: 'Inactive', exact: true })).toBeVisible();
  expect(writes).toBe(1);
});

test('patient list retries failed loads and preserves edits after a failed save', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seedSession(page);
  await page.route('**/api/auth/me', route => route.fulfill({ json: { account: { ...activeAccount, role: 'coordinator' } } }));
  let available = false;
  await page.route('**/api/profiles/patients**', route => route.fulfill(available && route.request().method() === 'GET'
    ? { json: { patients: [{ id: session.user.id, full_name: 'Test Patient', phone: '+65 81234567', pickup_address: 'Test address', postal_code: '560123', unit_no: '', notes: '', mobility: 'ambulant', assistance_required: false, status: 'active' }], total: 1, page: 1, pageSize: 25 } }
    : { status: 503, json: { message: 'Unavailable' } }));
  await page.goto('/dashboard/patients');
  await expect(page.getByRole('alert')).toContainText('Patients could not be loaded');
  await expect(page.getByText('No patients yet.')).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  available = true;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await page.getByRole('button', { name: 'View Test Patient', exact: true }).click();
  await page.getByRole('button', { name: 'Edit Patient', exact: true }).click();
  await page.getByRole('dialog', { name: 'Patient Details', exact: true }).getByLabel('Notes', { exact: true }).fill('Call on arrival.');
  await page.getByRole('button', { name: 'Save Patient', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Patient could not be saved.');
  await expect(page.getByRole('dialog', { name: 'Patient Details', exact: true }).getByLabel('Notes', { exact: true })).toHaveValue('Call on arrival.');

});

test('patient search and sorting reset pagination and handle empty results', async ({ page }) => {
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
  await page.getByRole('button', { name: 'Sort by Name ascending', exact: true }).click();
  await expect(page.getByRole('columnheader', { name: 'Name', exact: true })).toHaveAttribute('aria-sort', 'ascending');
  await expect(page.locator('.patients-table tbody tr').first()).toContainText('Alpha Patient 00');
  await page.getByRole('button', { name: 'Sort by Name descending', exact: true }).click();
  await expect(page.getByRole('columnheader', { name: 'Name', exact: true })).toHaveAttribute('aria-sort', 'descending');
  await expect(page.locator('.patients-table tbody tr').first()).toContainText('Zebra Needle');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.locator('.patients-pagination')).toContainText('Page 2');
  expect(requests.at(-1)!.get('sort')).toBe('full_name');
  expect(requests.at(-1)!.get('direction')).toBe('desc');
  await page.getByRole('button', { name: 'Reset Name ordering', exact: true }).click();
  await expect(page.locator('.patients-pagination')).toContainText('Page 1');
  await expect(page.getByRole('columnheader', { name: 'Name', exact: true })).toHaveAttribute('aria-sort', 'none');
  expect(requests.at(-1)!.get('sort')).toBe('created_at');
  await page.getByRole('button', { name: 'Sort by Name ascending', exact: true }).click();
  await page.getByRole('button', { name: 'Sort by Contact ascending', exact: true }).click();
  await expect(page.getByRole('columnheader', { name: 'Name', exact: true })).toHaveAttribute('aria-sort', 'none');
  await expect(page.getByRole('columnheader', { name: 'Contact', exact: true })).toHaveAttribute('aria-sort', 'ascending');
  await page.getByRole('button', { name: 'Sort by Contact descending', exact: true }).click();
  await page.getByRole('button', { name: 'Reset Contact ordering', exact: true }).click();
  await search.fill(patients[29].id);
  await expect(page.locator('.patients-pagination')).toContainText('1 patient · Page 1');

});

test("coordinator patient edits preserve the draft after a version conflict", async ({ page }) => {
  await seedSession(page);
  await page.route('**/api/auth/me', route => route.fulfill({ json: { account: { ...activeAccount, role: "coordinator", profile_complete: true } } }));
  let patient = { id: '11111111-1111-4111-8111-111111111111', version: 3, full_name: 'Fixture Patient', phone: '+65 81234567', pickup_address: 'Fixture street', unit_no: '', postal_code: '560123', notes: 'Original notes', mobility: 'ambulant', assistance_required: false, status: 'active' };
  await page.route('**/api/profiles/patient**', route => {
    if (route.request().method() === 'GET')
      return route.fulfill({ json: { patients: [patient], total: 1, page: 1, pageSize: 25 } });
    expect(route.request().postDataJSON().version).toBe(3);
    patient = { ...patient, version: 4, notes: 'Latest server notes' };
    return route.fulfill({ status: 409, json: { message: 'Changed' } });
  });
  await page.goto('/dashboard/patients');
  {
    await page.getByRole('button', { name: 'View Fixture Patient', exact: true }).click();
    await page.getByRole('button', { name: 'Edit Patient', exact: true }).click();
  }
  const editor = page.getByRole('dialog');
  const notes = editor.getByLabel('Notes', { exact: true });
  await notes.fill('My unsaved notes');
  await page.getByRole('button', { name: 'Save Patient', exact: true }).click();
  await expect(editor.getByRole('alert')).toContainText('changed');
  await expect(notes).toHaveValue('My unsaved notes');
  await expect(page.getByRole('button', { name: 'Save Patient', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Reload latest details', exact: true }).click();
  await expect(page.getByRole('dialog').getByLabel('Notes', { exact: true })).toHaveValue('Latest server notes');
});
