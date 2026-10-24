import { test, expect, session, seedSession, activeAccount, chooseOption, expectPopup, mockServices } from './support/fixtures';

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

test('patient records an independent single session without recurring fields', async ({ page }) => {
  await seedSession(page);
  await page.route('**/api/auth/me', route => route.fulfill({ json: { account: { ...activeAccount, role: 'patient', profile_complete: true } } }));
  const centre = { id: '77777777-7777-4777-8777-777777777777', name: 'Test Centre', address: 'Test street', postal_code: '560123' };
  let saved: Record<string, unknown> | null = null;
  await page.route('**/api/schedules**', route => {
    if (route.request().method() !== 'GET') {
      const input = route.request().postDataJSON();
      expect(input).toEqual({ kind: 'single', centre_id: centre.id, session_date: '2026-10-27', start_time: '09:00', end_time: '13:00' });
      saved = { ...input, id: centre.id, days: [2], effective_from: input.session_date, effective_to: input.session_date, version: 1, patients: { full_name: 'Test Patient' } };
      return route.fulfill({ json: saved });
    }
    return route.fulfill({ json: { centres: [centre], schedules: saved ? [saved] : [] } });
  });
  await page.goto('/dashboard/schedules');
  await page.getByRole('button', { name: 'Add Schedule', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add Schedule', exact: true });
  await expectPopup(dialog);
  await chooseOption(dialog.getByLabel('Schedule type', { exact: true }), 'single');
  await expect(dialog.getByLabel('Treatment day', { exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel('Effective from', { exact: true })).toHaveCount(0);
  await dialog.getByRole('combobox', { name: 'Dialysis centre', exact: true }).click();
  await page.getByRole('option', { name: /Test Centre/ }).click();
  await dialog.getByLabel('Session date', { exact: true }).fill('2026-10-27');
  await dialog.getByLabel('Session start', { exact: true }).fill('09:00');
  await dialog.getByLabel('Session end', { exact: true }).fill('13:00');
  await dialog.getByRole('button', { name: 'Save Schedule', exact: true }).click();
  await expect(page.getByText('Single Session', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: /27 Oct 2026/ })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Edit Schedule', exact: true }).click();
  await expect(page.getByLabel('Schedule type', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Session date', { exact: true })).toHaveValue('2026-10-27');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
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
  await expectPopup(dialog);
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

test('schedule deletion requires confirmation, preserves failed edits and removes only after success', async ({ page }) => {
  await seedSession(page);
  await page.route('**/api/auth/me', r => r.fulfill({ json: { account: activeAccount } }));
  const centre = { id: '77777777-7777-4777-8777-777777777777', name: 'Test Centre', address: 'Test street', postal_code: '560123' };
  const schedule = { id: '88888888-8888-4888-8888-888888888888', kind: 'single', centre_id: centre.id, days: [5], start_time: '11:00', end_time: '12:30', effective_from: '2026-10-30', effective_to: '2026-10-30', version: 1, patients: { full_name: 'Test Patient' } };
  let deleted = false; let fail = true; let writes = 0;
  await page.route('**/api/schedules**', r => {
    if (r.request().method() === 'DELETE') { writes++; if (fail) return r.fulfill({ status: 503, json: {} }); deleted = true; return r.fulfill({ json: { id: schedule.id } }); }
    return r.fulfill({ json: { centres: [centre], schedules: deleted ? [] : [schedule] } });
  });
  await page.goto('/dashboard/schedules');
  await expect(page.getByRole('heading', { name: /Friday, 30 Oct 2026/ })).toBeVisible();
  await page.getByRole('button', { name: 'Edit Schedule', exact: true }).click();
  await page.getByLabel('Session start').fill('10:00');
  await page.getByRole('button', { name: 'Delete Schedule', exact: true }).click();
  expect(writes).toBe(0);
  await page.getByRole('button', { name: 'Keep Schedule', exact: true }).click();
  await expect(page.getByLabel('Session start')).toHaveValue('10:00');
  await page.getByRole('button', { name: 'Delete Schedule', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm Delete', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('could not be deleted');
  expect(deleted).toBe(false);
  fail = false;
  await page.getByRole('button', { name: 'Confirm Delete', exact: true }).click();
  await expect(page.getByText('No treatment schedules yet.', { exact: true })).toBeVisible();
  expect(writes).toBe(2);
});

test('one-session selection stays bounded for long series and can jump to another month', async ({ page }) => {
  await seedSession(page);
  await page.route('**/api/auth/me', r => r.fulfill({ json: { account: activeAccount } }));
  const centre = { id: '77777777-7777-4777-8777-777777777777', name: 'Test Centre', address: 'Test street', postal_code: '560123' };
  const series = { id: '88888888-8888-4888-8888-888888888888', kind: 'recurring', centre_id: centre.id, days: [1], start_time: '09:00', end_time: '13:00', effective_from: '2026-10-19', effective_to: '9999-12-31', version: 1, patients: { full_name: 'Test Patient' } };
  await page.route('**/api/schedules?*', r => r.fulfill({ json: { centres: [centre], schedules: [series] } }));
  await page.goto('/dashboard/schedules');
  await page.getByRole('button', { name: 'Edit Schedule', exact: true }).click();
  await chooseOption(page.getByLabel('Apply changes to'), 'occurrence');
  const source = page.getByRole('combobox', { name: 'Session to change', exact: true });
  await expect(source).toBeVisible();
  await source.click();
  expect(await page.getByRole('listbox', { name: 'Session to change', exact: true }).getByRole('option').count()).toBeLessThanOrEqual(5);
  await page.keyboard.press('Escape');
  await page.getByLabel('Show sessions in', { exact: true }).fill('2099-12');
  await source.click();
  await expect(page.getByRole('listbox', { name: 'Session to change', exact: true }).locator('[data-value="2099-12-07"]')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await source.click();
  expect(await page.getByRole('listbox', { name: 'Session to change', exact: true }).getByRole('option').count()).toBeLessThanOrEqual(5);
  await page.keyboard.press('Escape');
  await chooseOption(source, '2099-12-07');
  await expect(page.getByLabel('New session date', { exact: true })).toHaveValue('2099-12-07');
});

test('schedule pagination sends search to the server and resets to the first page', async ({ page }) => {
  await seedSession(page);
  await page.route('**/api/auth/me', route => route.fulfill({ json: { account: { ...activeAccount, role: 'coordinator' } } }));
  const centre = { id: '77777777-7777-4777-8777-777777777777', name: 'Fixture Centre', address: 'Fixture street', postal_code: '560123' };
  const schedules = Array.from({ length: 26 }, (_, i) => ({ id: `schedule-${i}`, version: 1, patient_id: `patient-${i}`, patients: { full_name: `Fixture Patient ${i + 1}` }, kind: 'single', centre_id: centre.id, days: [2], effective_from: '2026-10-20', effective_to: '2026-10-20', start_time: '09:00', end_time: '10:00' }));
  const requests: URLSearchParams[] = [];
  await page.route('**/api/schedules?*', route => {
    const query = new URL(route.request().url()).searchParams; requests.push(query);
    const number = Number(query.get('page')); const term = query.get('search');
    const filtered = term ? schedules.filter(item => item.patients.full_name.includes(term)) : schedules;
    return route.fulfill({ json: { centres: [centre], schedules: filtered.slice((number - 1) * 10, number * 10), context: [], total: filtered.length, page: number, pageSize: 10 } });
  });
  await page.goto('/dashboard/schedules');
  await expect(page.locator('.treatment-record')).toHaveCount(10);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.locator('.treatment-record')).toHaveCount(10);
  await expect(page.locator('.treatment-record').first()).toContainText('Fixture Patient 11');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.locator('.treatment-record')).toHaveCount(6);
  await expect(page.locator('.treatment-record').last()).toContainText('Fixture Patient 26');
  await page.getByRole('searchbox', { name: 'Search treatment schedules' }).fill('Fixture Patient 1');
  await expect(page.locator('.treatment-record')).toHaveCount(10);
  expect(requests.at(-1)!.get('page')).toBe('1');
  expect(requests.at(-1)!.get('search')).toBe('Fixture Patient 1');

});

for (const operation of ['edit', 'delete']) test(`stale schedule ${operation} preserves input and requires reload`, async ({ page }) => {
  await seedSession(page);
  await page.route('**/api/auth/me', route => route.fulfill({ json: { account: { ...activeAccount, role: 'patient', profile_complete: true } } }));
  const centre = { id: '77777777-7777-4777-8777-777777777777', name: 'Fixture Centre', address: 'Fixture street', postal_code: '560123' };
  let version = 3;
  const schedule = () => ({ id: centre.id, version, patient_id: 'fixture', patients: { full_name: 'Fixture Patient' }, kind: 'recurring', centre_id: centre.id, days: [1], effective_from: '2026-10-19', effective_to: '2026-12-31', start_time: version === 3 ? '09:00' : '08:00', end_time: '13:00' });
  await page.route('**/api/schedules**', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { centres: [centre], schedules: [schedule()], context: [], total: 1, page: 1, pageSize: 10 } });
    expect(route.request().postDataJSON().version).toBe(3); version = 4;
    return route.fulfill({ status: 409, json: { message: 'Changed' } });
  });
  await page.goto('/dashboard/schedules');
  await page.getByRole('button', { name: 'Edit Schedule', exact: true }).click();
  await page.getByLabel('Session start', { exact: true }).fill('10:00');
  if (operation === 'delete') {
    await page.getByRole('button', { name: 'Delete Schedule', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm Delete', exact: true }).click();
  } else await page.getByRole('button', { name: 'Save Schedule', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('changed');
  if (operation === 'edit') await expect(page.getByLabel('Session start', { exact: true })).toHaveValue('10:00');
  await page.getByRole('button', { name: 'Reload schedules', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.treatment-record')).toContainText('08:00');
});

test("schedule list retries failed loads without showing unavailable pagination", async ({ page }) => {
  await seedSession(page);
  await page.route('**/api/auth/me', route => route.fulfill({ json: { account: { ...activeAccount, role: 'coordinator' } } }));
  let failing = true;
  await page.route("**/api/schedules?*", route => failing ? route.fulfill({ status: 503, json: { message: 'Unavailable' } }) : route.fulfill({ json: { schedules: [], centres: [], context: [], total: 0, page: 1, pageSize: 10, counts: {}, next_trip: null } }));
  const width = 375;
  await page.setViewportSize({ width, height: 800 });
  await page.goto("/dashboard/schedules");
  const error = page.locator('.list-error-state');
  await expect(error).toBeVisible();
  await expect(error.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
  await expect(page.locator('.patients-pagination')).toHaveCount(0);
  failing = false;
  await error.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(error).toHaveCount(0);
  await expect(page.locator('.patients-pagination')).toBeVisible();

});

test('coordinator schedule rows show trip coverage and refresh it after generation while patients see no indicator', async ({ page }) => {
  await seedSession(page);await page.setViewportSize({width:390,height:844});
  let role='coordinator';let generated=false;
  await page.route('**/api/auth/me',route=>route.fulfill({json:{account:{...activeAccount,role}}}));
  const centre={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',name:'Fixture Centre',address:'Fixture road',postal_code:'560123'};
  const base={id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',patient_id:session.user.id,version:1,kind:'recurring',centre_id:centre.id,days:[1],start_time:'09:00',end_time:'13:00',effective_from:'2027-01-04',effective_to:'2027-03-29',patients:{full_name:'Fixture Patient'}};
  await page.route('**/api/schedules?*',route=>route.fulfill({json:{centres:[centre],schedules:[
    {...base,trip_generation:{status:generated ? 'generated' : 'not_generated',through:generated ? '2027-01-25' : null,window_start:'2027-01-04',window_end:'2027-04-03'}},
    {...base,kind:'single',id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',trip_generation:{status:'partial',through:'2027-01-04',generated_ranges:[{from_date:'2027-01-04',until_date:'2027-01-25'},{from_date:'2027-02-08',until_date:'2027-02-08'}]}},
    {...base,id:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',trip_generation:{status:'none',through:null}}
  ],total:3,page:1,pageSize:10,context:[]}}));
  await page.route('**/api/trips/generate',route=>{generated=true;return route.fulfill({json:{created:8,updated:0,unchanged:0,skipped:0,total:8}});});
  await page.goto('/dashboard/schedules');
  await expect(page.getByText('Not generated',{exact:true})).toBeVisible();
  await expect(page.getByText('Partially generated',{exact:true})).toBeVisible();
  const partialRow = page.locator('.treatment-record').nth(1);
  await expect(partialRow.locator('.treatment-generation-label')).toBeHidden();
  const kindBadge = partialRow.locator('.treatment-kind');
  const coverageBadge = partialRow.locator('.treatment-generation-badge');
  await expect(kindBadge).toHaveText('Single Session');
  const kindBounds = (await kindBadge.boundingBox())!;
  const coverageBounds = (await coverageBadge.boundingBox())!;
  expect(Math.abs(kindBounds.y - coverageBounds.y)).toBeLessThan(1);
  expect(coverageBounds.x).toBeGreaterThanOrEqual(kindBounds.x + kindBounds.width);
  expect(await kindBadge.evaluate(element => getComputedStyle(element).whiteSpace)).toBe('nowrap');
  expect(await coverageBadge.evaluate(element => getComputedStyle(element).whiteSpace)).toBe('nowrap');

  await expect(page.getByText('Through 4 Jan 2027',{exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Generate Trips',exact:true}).nth(1).click();
  const partial=page.getByRole('dialog',{name:'Generate Trips',exact:true});
  await expect(partial.getByRole('heading',{name:'Trips already generated',exact:true})).toBeVisible();
  await expect(partial.getByText('4 Jan 2027 – 25 Jan 2027',{exact:true})).toBeVisible();
  await expect(partial.getByText('8 Feb 2027',{exact:true})).toBeVisible();
  await expect(partial.getByText('Up to 90 days. Includes rescheduled sessions.',{exact:true})).toHaveCount(0);
  await partial.getByRole('button',{name:'Close',exact:true}).click();
  await expect(page.getByText('No upcoming sessions',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Generate Trips',exact:true}).first().click();
  const dialog=page.getByRole('dialog',{name:'Generate Trips',exact:true});
  await dialog.getByRole('button',{name:'Generate Trips',exact:true}).click();
  await expect(page.getByText('Generated',{exact:true})).toBeVisible();
  role='patient';await page.reload();
  await expect(page.getByRole('heading',{name:'Treatment Schedules',exact:true})).toBeVisible();
  await expect(page.locator('.treatment-generation')).toHaveCount(0);
});

test('coordinator opts into automatic generation per schedule and reloads stale settings', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-10-24T04:00:00Z') });
  await page.clock.pauseAt(new Date('2026-10-24T04:00:01Z'));
  await seedSession(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/auth/me', route => route.fulfill({ json: { account: { ...activeAccount, role: 'coordinator' } } }));
  const centre = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Fixture Centre', address: 'Fixture road', postal_code: '560123' };
  let setting = { enabled: false, version: 0 }; let stale = true;
  let holdRefresh = false; let releaseRefresh: (() => void) | undefined;
  const schedule = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', version: 1, patient_id: session.user.id, patients: { full_name: 'Fixture Patient' }, kind: 'recurring', days: [1], start_time: '09:00', end_time: '13:00', centre_id: centre.id, effective_from: '2027-01-04', effective_to: '2027-03-29' };
  await page.route('**/api/schedules?*', async route => {
    if (holdRefresh) await new Promise<void>(resolve => { releaseRefresh = resolve; });
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
  await expectPopup(dialog);
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
  const originalRecord = (await page.locator('.treatment-record').first().elementHandle())!;
  const originalDateInput = (await dialog.getByLabel('From date', { exact: true }).elementHandle())!;
  const originalDate = await dialog.getByLabel('From date', { exact: true }).inputValue();
  holdRefresh = true;
  await toggle.click();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(toggle).toBeChecked();
  await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
  await expect(dialog.getByText('Off · Generate trips manually.', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Automatic trip generation enabled.', { exact: true })).toBeVisible();
  expect(await originalRecord.evaluate(element => element.isConnected)).toBe(true);
  expect(await originalDateInput.evaluate(element => element.isConnected)).toBe(true);
  await expect(dialog.getByLabel('From date', { exact: true })).toBeEnabled();
  await expect(dialog.getByLabel('From date', { exact: true })).toHaveValue(originalDate);
  await expect(dialog.getByRole('button', { name: 'Generate Trips', exact: true })).toBeEnabled();
  await expect(page.locator('.treatment-panel > .account-loading')).toHaveCount(0);
  await expect.poll(() => Boolean(releaseRefresh)).toBe(true);
  holdRefresh = false;
  releaseRefresh!();

  await toggle.click();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(toggle).not.toBeChecked();
  await expect(page.getByText('Automatic trip generation disabled. Existing trips kept.', { exact: true })).toBeVisible();
  const toast = dialog.locator('.auth-toast').filter({ hasText: 'Automatic trip generation disabled.' });
  await expect(toast).toBeVisible();
  await page.clock.fastForward(1000);
  expect(await toast.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
  })).toBe(true);
  const node = (await toast.elementHandle())!;
  const beforeClose = (await toast.boundingBox())!;

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  expect(await node.evaluate(element => element.isConnected && element.closest('dialog') === null)).toBe(true);
  const afterClose = (await page.locator('.auth-toast').filter({ hasText: 'Automatic trip generation disabled.' }).boundingBox())!;
  expect(Math.abs(beforeClose.y - afterClose.y)).toBeLessThan(1);
  expect(afterClose.height).toBe(beforeClose.height);
  const progressTime = () => node.evaluate(element => new DOMMatrix(getComputedStyle(element.querySelector('.toast-progress')!).transform).a);
  const elapsedProgress = await progressTime();
  expect(elapsedProgress).toBeGreaterThan(0.25);
  await page.getByRole('button', { name: 'Generate Trips', exact: true }).click();
  expect(await progressTime()).toBeGreaterThanOrEqual(elapsedProgress);
  // Exercise the animation-preserving fallback used by older browsers as well.
  await page.evaluate(() => Reflect.set(Element.prototype, 'moveBefore', undefined));
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  expect(await progressTime()).toBeGreaterThanOrEqual(elapsedProgress);
  await page.getByRole('button', { name: 'Generate Trips', exact: true }).click();
  expect(await progressTime()).toBeGreaterThanOrEqual(elapsedProgress);
  expect(await node.evaluate(element => element.getAnimations().every(animation => animation.currentTime === null || Number(animation.currentTime) >= 240))).toBe(true);
  await page.clock.fastForward(2100);
  await page.clock.fastForward(200);
  await expect(page.getByText('Automatic trip generation disabled. Existing trips kept.', { exact: true })).toHaveCount(0);


});
