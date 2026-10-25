import { test, expect, session, seedSession, activeAccount, fixtureTrip, mockServices } from './support/fixtures';

test.beforeEach(mockServices);

test('patient opens their journey details', async ({ page }) => {
  await seedSession(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/auth/me', route => route.fulfill({ json: { account: { ...activeAccount, role: 'patient' } } }));
  await page.route('**/api/trips?*', route => route.fulfill({ json: { trips: Array.from({ length: 10 }, (_, index) => ({ ...fixtureTrip, id: `trip-${index}`, ...(index === 1 ? { direction: 'return', arrival_by: null, pickup_not_before: '2026-10-20T13:15:00+08:00', review_required: true } : {}) })), total: 26, page: 1, pageSize: 10, counts: { unfilled: 26, 'at-risk': 0, 'on-track': 0, resolved: 0 }, next_trip: { ...fixtureTrip, review_required: true } } }));
  await page.goto('/dashboard/trips');
  const list = page.getByRole('region', { name: 'Trip list', exact: true });
  await expect(list).toBeVisible();
  await expect(list.locator('article')).toHaveCount(10);
  await expect(list.locator('article').first()).not.toContainText('Pickup pending');
  await expect(list.locator('article').first().locator('.trip-status-badge')).toHaveText('Unfilled');
  await expect(list.locator('article').first()).not.toContainText('Arrival by');
  await expect(list.locator('article').nth(1)).not.toContainText('Earliest return pickup');
  await expect(list.locator('.trip-mobile-timing')).toHaveCount(0);
  await expect(list).not.toContainText('Arrive by');
  await expect(list).not.toContainText('Earliest pickup');
  await expect(list.locator('article').nth(1)).not.toContainText('Pickup at 13:15');
  await expect(page.getByText('Needs review', { exact: true })).toHaveCount(0);
  await expect(list.locator('article').nth(1)).not.toContainText('Arrival by');
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeEnabled();
  await list.locator('article').nth(1).getByRole('button', { name: 'View trip details', exact: true }).click();
  const returnDetails = page.getByRole('dialog', { name: 'Trip details', exact: true });
  await expect(returnDetails).toBeVisible();
  await expect(returnDetails).not.toContainText('timings need review');
  await expect(returnDetails).toContainText('Earliest return pickup');
  await expect(returnDetails).toContainText('13:15');
  await returnDetails.getByRole('button', { name: /^Close / }).click();
  await expect(page.getByRole('button', { name: 'Select trips', exact: true })).toHaveCount(0);
  await expect(page.locator('.patient-next-pickup')).toContainText('Pickup time to be confirmed');
});

test('coordinator generates unfilled trips and preserves dates after a stale schedule conflict', async ({ page }) => {
  await seedSession(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.clock.install({ time: new Date('2026-10-20T02:00:00Z') });
  await page.route('**/api/auth/me', route => route.fulfill({ json: { account: { ...activeAccount, role: 'coordinator' } } }));
  const centre = { id: '77777777-7777-4777-8777-777777777777', name: 'Fixture Centre', address: 'Fixture street', postal_code: '560123' };
  let version = 1;
  await page.route('**/api/schedules?*', route => route.fulfill({ json: { centres: [centre], schedules: [{ id: fixtureTrip.source_schedule_id, version, patient_id: session.user.id, patients: { full_name: 'Test Patient' }, kind: 'recurring', centre_id: centre.id, days: [2], start_time: '09:00', end_time: '13:00', effective_from: '2026-10-20', effective_to: '2026-12-31' }], context: [], total: 1, page: 1, pageSize: 10 } }));
  await page.route('**/api/trips/generate', route => {
    const body = route.request().postDataJSON();
    expect(body).toEqual({ schedule_id: fixtureTrip.source_schedule_id, version: body.version, from_date: '2026-10-21', until_date: '2026-11-18' });
    if (body.version === 1) { version = 2; return route.fulfill({ status: 409, json: {} }); }
    return route.fulfill({ json: { created: 8, updated: 0, unchanged: 2, total: 10 } });
  });
  await page.goto('/dashboard/schedules');
  await page.getByRole('button', { name: 'Generate Trips', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Generate Trips', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Test Patient');
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

test('coordinator deletes selected trips with confirmation and reports partial failures', async ({ page }) => {
  await seedSession(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/auth/me', route => route.fulfill({ json: { account: { ...activeAccount, role: 'coordinator' } } }));
  const trips = [0, 1].map(index => ({ ...fixtureTrip, id: `bulk-trip-${index}`, version: index + 1 }));
  let remaining = trips;
  const deleted: string[] = [];
  await page.route('**/api/trips?*', route => route.fulfill({ json: { trips: remaining, total: remaining.length, page: 1, pageSize: 10, counts: { unfilled: remaining.length }, next_trip: null } }));
  await page.route('**/api/trips/bulk-trip-*', async route => {
    const id = route.request().url().split('/').at(-1)!;
    deleted.push(id);
    expect(route.request().method()).toBe('DELETE');
    expect(route.request().postDataJSON().version).toBe(id === trips[0].id ? 1 : 2);
    if (id === trips[1].id) return route.fulfill({ status: 409, json: { message: 'Trip changed.' } });
    remaining = remaining.filter(trip => trip.id !== id);
    return route.fulfill({ json: { id } });
  });
  await page.goto('/dashboard/trips');
  await page.getByRole('button', { name: 'Select trips', exact: true }).click();
  const footer = page.getByLabel('Trip selection', { exact: true });
  const trash = footer.getByRole('button', { name: 'Delete selected trips', exact: true });
  await expect(trash).toBeDisabled();
  await footer.getByRole('button', { name: 'Select all', exact: true }).click();
  await trash.click();
  let dialog = page.getByRole('dialog', { name: 'Delete selected trips', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Delete 2 selected trips?');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(deleted).toHaveLength(0);
  await expect(footer).toContainText('2 selected');
  await trash.click();
  dialog = page.getByRole('dialog', { name: 'Delete selected trips', exact: true });
  await dialog.getByRole('button', { name: 'Delete 2 trips', exact: true }).click();
  await expect(dialog).toContainText('1 trip deleted. 1 trip could not be deleted.');
  await expect(dialog.getByRole('button', { name: 'Delete 2 trips', exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Reload trips', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Trip list', exact: true }).locator('article')).toHaveCount(1);
  expect(deleted).toEqual(trips.map(trip => trip.id));
  // The remaining trip can be selected afresh; never retry with an old version automatically.
  await page.getByRole('button', { name: 'Select trips', exact: true }).click();
  await page.getByRole('checkbox').check();
  await page.route('**/api/trips/bulk-trip-1', route => { remaining = []; return route.fulfill({ json: { id: trips[1].id } }); });
  await page.getByRole('button', { name: 'Delete selected trips', exact: true }).click();
  await page.getByRole('dialog', { name: 'Delete selected trips', exact: true }).getByRole('button', { name: 'Delete 1 trip', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Delete selected trips', exact: true })).toHaveCount(0);
  await expect(page.getByText('1 trip deleted.', { exact: true })).toBeVisible();
  await expect(page.getByText('No trips scheduled.', { exact: true })).toBeVisible();
});
