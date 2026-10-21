import { test, expect, seedSession, activeAccount, fixtureTrip, chooseOption, mockServices } from './support/fixtures';

test.beforeEach(mockServices);

for (const kind of ['patients', 'schedules', 'trips']) test(`list toolbar ${kind} overlays apply sorting and stay pinned on mobile`, async ({ page }) => {
  await seedSession(page);
  await page.route('**/api/auth/me', route => route.fulfill({ json: { account: { ...activeAccount, role: 'coordinator' } } }));
  const endpoint = kind === 'patients' ? 'profiles/patients' : kind;
  const requests: URLSearchParams[] = [];
  await page.route(`**/api/${endpoint}?*`, route => {
    requests.push(new URL(route.request().url()).searchParams);
    const rows = Array.from({ length: 12 }, (_, i) => ({
      ...fixtureTrip, id: `fixture-${i}`, full_name: 'Fixture Patient', phone: '81234567', mobility: 'ambulant',
      patients: { full_name: 'Fixture Patient' }, kind: 'recurring', centre_id: 'centre', days: [1], start_time: '09:00', end_time: '13:00', effective_from: '2026-10-21', effective_to: '2026-12-31'
    }));
    return route.fulfill({ json: { [kind]: rows, total: 12, page: 1, pageSize: 25, context: [], next_trip: null, counts: {}, centres: [{ id: 'centre', name: 'Fixture Centre' }] } });
  });
  await page.setViewportSize({ width: 375, height: 700 });
  await page.goto(`/dashboard/${kind}`);
  await page.getByRole('button', { name: 'Sort', exact: true }).click();
  const sort = page.getByRole('dialog', { name: 'Sort records' });
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
  if (kind === 'patients') await filters.getByRole('radio', { name: 'Inactive', exact: true }).check();
  if (kind === 'schedules') await filters.getByRole('radio', { name: 'Recurring', exact: true }).check();
  if (kind === 'trips') await chooseOption(filters.getByLabel('Direction', { exact: true }), 'return');
  await filters.getByRole('button', { name: 'Apply Filters', exact: true }).click();
  await expect.poll(() => requests.at(-1)?.get(kind === 'patients' ? 'status' : kind === 'schedules' ? 'kind' : 'direction')).toBe(kind === 'patients' ? 'inactive' : kind === 'schedules' ? 'recurring' : 'return');
  await page.evaluate(() => window.scrollTo(0, 600));
  await expect(page.getByRole('searchbox')).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Filters', exact: true })).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Sort', exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const row = page.locator(kind === 'patients' ? '.patients-table tbody tr' : kind === 'schedules' ? '.treatment-record' : '.trip-record').last();
  await row.scrollIntoViewIfNeeded();
  const info = row.locator('.list-info-control');
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
