import { test, expect, seedSession, activeAccount, fixtureTrip, expectPopup, mockServices } from './support/fixtures';

test.beforeEach(mockServices);

for (const kind of ['patients', 'schedules', 'trips']) test(`list toolbar ${kind} overlays apply sorting and stay pinned on mobile`, async ({ page }) => {
  await seedSession(page);
  await page.route('**/api/auth/me', route => route.fulfill({ json: { account: { ...activeAccount, role: 'coordinator' } } }));
  const endpoint = kind === 'patients' ? 'profiles/patients' : kind;
  const requests: URLSearchParams[] = [];
  await page.route(`**/api/${endpoint}?*`, route => {
    requests.push(new URL(route.request().url()).searchParams);
    const rows = Array.from({ length: 10 }, (_, i) => ({
      ...fixtureTrip, id: `fixture-${i}`, full_name: 'Fixture Patient', phone: '81234567', mobility: 'ambulant',
      patients: { full_name: 'Fixture Patient' }, kind: 'recurring', centre_id: 'centre', days: [1], start_time: '09:00', end_time: '13:00', effective_from: '2026-10-21', effective_to: '2026-12-31'
    }));
    return route.fulfill({ json: { [kind]: rows, total: 12, page: 1, pageSize: 10, context: [], next_trip: null, counts: {}, centres: [{ id: 'centre', name: 'Fixture Centre' }, ...Array.from({ length: 12 }, (_, i) => ({ id: `centre-${i}`, name: `Centre ${i + 2}` }))] } });
  });
  await page.setViewportSize({ width: 375, height: 700 });
  await page.goto(`/dashboard/${kind}`);
  await page.getByRole('button', { name: 'Sort', exact: true }).click();
  const sort = page.getByRole('dialog', { name: 'Sort records' });
  await expectPopup(sort);
  await sort.getByRole('radio', { name: kind === 'patients' ? 'Name' : kind === 'schedules' ? 'Start date' : 'Treatment date', exact: true }).check();
  await sort.getByRole('radio', { name: 'Descending', exact: true }).check();
  if (kind === 'patients') {
    const before = requests.length;
    await sort.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(requests.length).toBe(before);
    await page.getByRole('button', { name: 'Sort', exact: true }).click();
    await sort.getByRole('radio', { name: 'Name', exact: true }).check();
    await sort.getByRole('radio', { name: 'Descending', exact: true }).check();
  }
  await sort.getByRole('button', { name: 'Apply Sort', exact: true }).click();
  await expect.poll(() => requests.at(-1)?.get(kind === 'patients' ? 'direction' : 'order')).toBe('desc');
  await expect.poll(() => requests.at(-1)?.get('page')).toBe('1');
  await page.getByRole('button', { name: 'Filters', exact: true }).click();
  const filters = page.getByRole('dialog');
  await expectPopup(filters);
  if (kind === 'patients') await filters.getByRole('checkbox', { name: 'Active', exact: true }).uncheck();
  if (kind === 'schedules') {
    await filters.getByRole('checkbox', { name: 'Single Session', exact: true }).uncheck();
    await filters.getByRole('checkbox', { name: 'Rescheduled Session', exact: true }).uncheck();
    await filters.getByRole('combobox', { name: 'Dialysis centre', exact: true }).click();
    const centreSearch = filters.getByRole('searchbox', { name: 'Search dialysis centre', exact: true });
    const centreOptions = filters.getByRole('listbox', { name: 'Dialysis centre', exact: true });
    await centreOptions.evaluate(element => { element.scrollTop = 80; });
    const bounds = (await centreOptions.boundingBox())!;
    await page.mouse.move(bounds.x + 30, bounds.y + 8);
    await expect(centreOptions.locator('.is-active')).toHaveText('Fixture Centre');
    await expect.poll(() => centreOptions.evaluate(element => element.scrollTop)).toBe(80);
    await centreSearch.press('ArrowDown');
    await filters.getByRole('combobox', { name: 'Dialysis centre', exact: true }).press('End');
    await expect(centreOptions.getByRole('option').last()).toBeInViewport();
    await centreSearch.fill('Fixture');
    await expect(filters.getByRole('listbox', { name: 'Dialysis centre', exact: true }).getByRole('option')).toHaveText(['Fixture Centre']);
    await centreSearch.fill('Missing centre');
    await expect(filters.getByText('No matching options.', { exact: true })).toBeVisible();
    await centreSearch.press('Escape');
  }
  if (kind === 'trips') await filters.getByRole('checkbox', { name: 'Outbound', exact: true }).uncheck();
  await filters.getByRole('button', { name: 'Apply Filters', exact: true }).click();
  await expect.poll(() => requests.at(-1)?.get(kind === 'patients' ? 'status' : kind === 'schedules' ? 'kind' : 'direction')).toBe(kind === 'patients' ? 'inactive' : kind === 'schedules' ? 'recurring' : 'return');
  await page.evaluate(() => window.scrollTo(0, 600));
  await expect(page.getByRole('searchbox')).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Filters', exact: true })).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Sort', exact: true })).toBeInViewport();
  await expect(page.locator('.patients-pagination')).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Previous', exact: true })).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const row = page.locator(kind === 'patients' ? '.patients-table tbody tr' : kind === 'schedules' ? '.treatment-record' : '.trip-record').last();
  await row.scrollIntoViewIfNeeded();
  const info = row.getByRole('button', { name: kind === 'patients' ? 'View Fixture Patient' : kind === 'schedules' ? 'View schedule details' : 'View trip details', exact: true });
  await info.click();
  await expect(page.getByRole('dialog').locator('.overlay-header button')).toHaveCount(0);
  await page.getByRole('dialog').getByRole('button', { name: /^Close / }).click();
  if (kind === 'patients') {
    await page.getByRole('button', { name: 'Sort', exact: true }).click();
    await sort.getByRole('button', { name: 'Reset', exact: true }).click();
    await expect(sort.getByRole('radio', { name: 'Created date', exact: true })).toBeChecked();
    await sort.getByRole('button', { name: 'Apply Sort', exact: true }).click();
    await expect.poll(() => requests.at(-1)?.get('sort')).toBe('created_at');
    expect(requests.at(-1)?.get('status')).toBe('inactive');
  }

});
