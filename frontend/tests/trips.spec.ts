import { test, expect, session, seedSession, activeAccount, fixtureTrip, chooseOption, mockServices } from './support/fixtures';

test.beforeEach(mockServices);

for (const role of ['patient', 'coordinator']) test(`${role} trip list shows pickup requirements, review flags and journey details`, async ({ page }) => {
  await seedSession(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/auth/me', route => route.fulfill({ json: { account: { ...activeAccount, role } } }));
  await page.route('**/api/trips?*', route => route.fulfill({ json: { trips: Array.from({ length: 25 }, (_, index) => ({ ...fixtureTrip, id: `trip-${index}`, ...(index === 1 ? { direction: 'return', arrival_by: null, pickup_not_before: '2026-10-20T13:15:00+08:00', review_required: true } : {}) })), total: 26, page: 1, pageSize: 25, counts: { unfilled: 26, 'at-risk': 0, 'on-track': 0, resolved: 0 }, next_trip: fixtureTrip } }));
  await page.goto('/dashboard/trips');
  const list = page.getByRole('region', { name: 'Trip list', exact: true });
  await expect(list).toBeVisible();
  await expect(list.locator('article')).toHaveCount(25);
  await expect(list.locator('article').first()).not.toContainText('Pickup pending');
  await expect(list.locator('article').first().locator('.trip-status-badge')).toHaveText('Unfilled');
  await expect(list.locator('article').first()).not.toContainText('Arrival by');
  await expect(list.locator('article').nth(1)).not.toContainText('Earliest return pickup');
  await expect(list.locator('article').nth(1)).not.toContainText('13:15');
  await expect(list.locator('article').nth(1)).toContainText('Needs review');
  await expect(list.locator('article').nth(1)).not.toContainText('Arrival by');
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeEnabled();
  expect(await list.evaluate(element => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollHeight > innerHeight)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await list.locator('article').nth(1).getByRole('button', { name: 'View details', exact: true }).click();
  const returnDetails = page.getByRole('dialog', { name: 'Trip details', exact: true });
  await expect(returnDetails).toContainText('Earliest return pickup');
  await expect(returnDetails).toContainText('13:15');
  await returnDetails.getByRole('button', { name: /^Close / }).click();
  if (role === 'coordinator') {
    await page.getByRole('button', { name: 'Filters', exact: true }).click();
    await page.getByRole('dialog', { name: 'Trip filters', exact: true }).getByLabel('Status', { exact: true }).click();
    await expect(page.getByRole('listbox', { name: 'Status', exact: true }).getByRole('option')).toHaveText(['All trips', 'Unfilled (26)', 'At-Risk (0)', 'On-Track (0)', 'Resolved (0)']);
  }
  else { await expect(page.locator('.patient-next-pickup')).toContainText('Pickup time to be confirmed'); await expect(page.locator('.dashboard-metrics')).toHaveCount(0); }
});

test('coordinator generates unfilled trips and preserves dates after a stale schedule conflict', async ({ page }) => {
  await seedSession(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.clock.install({ time: new Date('2026-10-20T02:00:00Z') });
  await page.route('**/api/auth/me', route => route.fulfill({ json: { account: { ...activeAccount, role: 'coordinator' } } }));
  const centre = { id: '77777777-7777-4777-8777-777777777777', name: 'Fixture Centre', address: 'Fixture street', postal_code: '560123' };
  let version = 1;
  await page.route('**/api/schedules?*', route => route.fulfill({ json: { centres: [centre], schedules: [{ id: fixtureTrip.source_schedule_id, version, patient_id: session.user.id, patients: { full_name: 'Test Patient' }, kind: 'recurring', centre_id: centre.id, days: [2], start_time: '09:00', end_time: '13:00', effective_from: '2026-10-20', effective_to: '2026-12-31' }], context: [], total: 1, page: 1, pageSize: 25 } }));
  await page.route('**/api/trips/generate', route => {
    const body = route.request().postDataJSON();
    expect(body).toEqual({ schedule_id: fixtureTrip.source_schedule_id, version: body.version, from_date: '2026-10-21', until_date: '2026-11-19' });
    if (body.version === 1) { version = 2; return route.fulfill({ status: 409, json: {} }); }
    return route.fulfill({ json: { created: 8, updated: 0, unchanged: 2, total: 10 } });
  });
  await page.goto('/dashboard/schedules');
  await page.getByRole('button', { name: 'Generate Trips', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Generate Trips', exact: true });
  await expect(dialog).toContainText('Test Patient');
  await expect(dialog).toContainText('Unfilled');
  expect(await dialog.evaluate(element => element.getBoundingClientRect().bottom <= innerHeight)).toBe(true);
  await dialog.getByLabel('From date', { exact: true }).fill('2026-10-21');
  await dialog.getByRole('button', { name: 'Generate Trips', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Reload schedules');
  await expect(dialog.getByLabel('From date', { exact: true })).toHaveValue('2026-10-21');
  await dialog.getByRole('button', { name: 'Reload schedules', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Generate Trips', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Generate Trips', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: '8 created' })).toContainText('2 unchanged');
});

test('successful empty trip data differs from an unavailable trip service', async ({ page }) => {
  await seedSession(page);
  await page.route('**/api/auth/me', route => route.fulfill({ json: { account: activeAccount } }));
  await page.route('**/api/trips?*', route => route.fulfill({ json: { trips: [], total: 0, page: 1, pageSize: 25, counts: { unfilled: 0, 'at-risk': 0, 'on-track': 0, resolved: 0 }, next_trip: null } }));
  await page.goto('/dashboard/trips');
  await expect(page.getByText('No trips scheduled.', { exact: true })).toBeVisible();
  await expect(page.getByText('Trips could not be loaded', { exact: true })).toHaveCount(0);
  await page.route('**/api/trips?*', route => route.fulfill({ status: 503, json: {} }));
  await page.reload();
  await expect(page.getByText('Trips could not be loaded', { exact: true })).toBeVisible();
  await expect(page.getByText('No trips scheduled.', { exact: true })).toHaveCount(0);
  await page.route('**/api/trips?*', route => route.fulfill({ json: { trips: [], total: 0, page: 1, pageSize: 25, counts: { unfilled: 0, 'at-risk': 0, 'on-track': 0, resolved: 0 }, next_trip: null } }));
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByText('No trips scheduled.', { exact: true })).toBeVisible();
});

test('compact trip tools search on the server and apply filters only after confirmation', async ({ page }) => {
  await seedSession(page);
  await page.route('**/api/auth/me', route => route.fulfill({ json: { account: { ...activeAccount, role: 'coordinator' } } }));
  const queries: URLSearchParams[] = [];
  await page.route('**/api/trips?*', route => {
    const query = new URL(route.request().url()).searchParams; queries.push(query);
    return route.fulfill({ json: { trips: [{ ...fixtureTrip, version: 1 }], total: query.get('search') ? 1 : 26, page: Number(query.get('page')), pageSize: 25, counts: { unfilled: 26, 'at-risk': 0, 'on-track': 0, resolved: 0 }, next_trip: fixtureTrip } });
  });
  await page.goto('/dashboard/trips');
  await expect(page.locator('.dashboard-metrics')).toHaveCount(0);
  await expect(page.locator('.trip-filter-summary')).toHaveCount(0);
  await expect(page.locator('.list-toolbar').getByRole('button', { name: 'Filters', exact: true })).toBeVisible();
  await expect(page.locator('.trip-filter-badge')).toHaveCount(0);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect.poll(() => queries.at(-1)?.get('page')).toBe('2');
  await page.getByRole('searchbox', { name: 'Search trips' }).fill('Fixture');
  await expect.poll(() => queries.at(-1)?.get('search')).toBe('Fixture');
  expect(queries.at(-1)?.get('page')).toBe('1');
  await page.getByRole('button', { name: 'Filters', exact: true }).click();
  const filters = page.getByRole('dialog', { name: 'Trip filters', exact: true });
  await chooseOption(filters.getByLabel('Direction', { exact: true }), 'return');
  await chooseOption(filters.getByLabel('Status', { exact: true }), 'at-risk');
  await filters.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(queries.at(-1)?.get('direction')).toBe('all');
  expect(queries.at(-1)?.get('status')).toBe('all');
  await page.getByRole('button', { name: 'Filters', exact: true }).click();
  await chooseOption(filters.getByLabel('Direction', { exact: true }), 'return');
  await filters.getByRole('button', { name: 'Apply Filters', exact: true }).click();
  await expect.poll(() => queries.at(-1)?.get('direction')).toBe('return');
  await expect(page.locator('.trip-filter-badge')).toHaveText('1');
  await page.getByRole('button', { name: 'Filters', exact: true }).click();
  await chooseOption(filters.getByLabel('Status', { exact: true }), 'unfilled');
  expect(queries.at(-1)?.get('status')).toBe('all');
  await filters.getByRole('button', { name: 'Apply Filters', exact: true }).click();
  await expect.poll(() => queries.at(-1)?.get('status')).toBe('unfilled');
  await expect(page.locator('.trip-filter-badge')).toHaveText('2');
  await page.getByRole('button', { name: 'Filters', exact: true }).click();
  await filters.getByLabel('Until date', { exact: true }).fill(await filters.getByLabel('From date', { exact: true }).inputValue());
  await filters.getByRole('button', { name: 'Apply Filters', exact: true }).click();
  await expect(page.locator('.trip-filter-badge')).toHaveText('3');
  await page.getByRole('button', { name: 'View details', exact: true }).first().click();
  const details = page.getByRole('dialog', { name: 'Trip details', exact: true });
  await expect(details).toContainText('Fixture home');
  await expect(details).toContainText('Fixture Centre');
  await expect(details.locator('.overlay-header button')).toHaveCount(0);
  await expect(details.locator('.overlay-footer')).toContainText('Close');
  await expect(details.getByRole('button', { name: 'Close Trip details', exact: true })).toBeVisible();
  await expect(details.getByRole('button', { name: 'Delete Trip', exact: true })).toHaveClass(/button-danger/);
});

test('trip deletion preserves context on errors and reloads stale versions before retry', async ({ page }) => {
  await seedSession(page);
  await page.route('**/api/auth/me', route => route.fulfill({ json: { account: { ...activeAccount, role: 'coordinator' } } }));
  let version = 1; let deleted = false; let attempts = 0;
  await page.route('**/api/trips?*', route => route.fulfill({ json: { trips: deleted ? [] : [{ ...fixtureTrip, version }], total: deleted ? 0 : 1, page: 1, pageSize: 25, counts: { unfilled: deleted ? 0 : 1, 'at-risk': 0, 'on-track': 0, resolved: 0 }, next_trip: deleted ? null : { ...fixtureTrip, version } } }));
  await page.route('**/api/trips/trip-1', route => {
    expect(route.request().method()).toBe('DELETE');
    expect(route.request().postDataJSON()).toEqual({ version });
    attempts++;
    if (attempts === 1) return route.fulfill({ status: 503, json: {} });
    if (attempts === 2) { version = 2; return route.fulfill({ status: 409, json: {} }); }
    deleted = true; return route.fulfill({ json: { id: fixtureTrip.id } });
  });
  await page.goto('/dashboard/trips');
  await page.getByRole('button', { name: 'View details', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete Trip', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'Delete Trip', exact: true });
  await expect(confirmation).toContainText('one journey');
  await confirmation.getByRole('button', { name: 'Delete Trip', exact: true }).click();
  await expect(confirmation.getByRole('alert')).toContainText('could not be deleted');
  await expect(confirmation).toContainText('Fixture Centre');
  await confirmation.getByRole('button', { name: 'Delete Trip', exact: true }).click();
  await expect(confirmation.getByRole('alert')).toContainText('Reload trips');
  await confirmation.getByRole('button', { name: 'Reload trips', exact: true }).click();
  await confirmation.getByRole('button', { name: 'Delete Trip', exact: true }).click();
  await expect(confirmation).not.toBeVisible();
  await expect(page.getByText('No trips scheduled.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Filters', exact: true }).click();
  await chooseOption(page.getByLabel('Status', { exact: true }), 'unfilled');
  await expect(page.getByLabel('Status', { exact: true })).toContainText('Unfilled (0)');
});
