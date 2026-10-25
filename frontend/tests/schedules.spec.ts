import { test, expect, session, seedSession, activeAccount, chooseOption, mockServices } from './support/fixtures';

test.beforeEach(mockServices);

test('patient confirms schedule creation, can go back, and retains details on failure', async ({ page }) => {
  await seedSession(page);
  await page.route('**/api/auth/me', route => route.fulfill({ json: { account: { ...activeAccount, role: 'patient', profile_complete: true } } }));
  const centre = { id: '77777777-7777-4777-8777-777777777777', name: 'Test Centre', address: 'Test street', postal_code: '560123' };
  let saved: Record<string, unknown>[] = []; let fail = true; let submissions = 0;
  await page.route('**/api/schedules**', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { centres: [centre], schedules: saved, total: saved.length, page: 1, pageSize: 10, context: [] } });
    submissions++;
    if (fail) return route.fulfill({ status: 503, json: {} });
    saved = [{ ...route.request().postDataJSON(), id: centre.id, patients: { full_name: 'Test Patient' }, version: 1 }];
    return route.fulfill({ json: saved[0] });
  });
  await page.goto('/dashboard/schedules');
  await page.getByRole('button', { name: 'Add Schedule', exact: true }).click();
  await page.getByRole('combobox', { name: 'Dialysis centre', exact: true }).click();
  await page.getByRole('option', { name: /Test Centre/ }).click();
  await chooseOption(page.getByLabel('Treatment day', { exact: true }), '1');
  await page.getByLabel('Session start').fill('09:00');
  await page.getByLabel('Session end').fill('13:00');
  await page.getByLabel('Effective from').fill('2026-10-20');
  await page.getByLabel('Effective to').fill('2026-12-31');
  await page.getByRole('button', { name: 'Create Schedule', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'Confirm treatment schedule', exact: true });
  await expect(confirmation).toContainText('require coordinator approval');
  await expect(confirmation).toContainText('09:00 – 13:00');
  expect(submissions).toBe(0);
  await confirmation.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByLabel('Session start')).toHaveValue('09:00');
  await page.getByRole('button', { name: 'Create Schedule', exact: true }).click();
  await confirmation.getByRole('button', { name: 'Create Schedule', exact: true }).click();
  await expect(confirmation.getByRole('alert')).toContainText('could not be created');
  await expect(confirmation).toContainText('Test Centre');
  fail = false;
  await confirmation.getByRole('button', { name: 'Create Schedule', exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'View schedule details', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit Schedule', exact: true })).toHaveCount(0);
});

test('saved patient schedules are read-only with or without generated trips', async ({ page }) => {
  await seedSession(page);
  await page.route('**/api/auth/me', route => route.fulfill({ json: { account: { ...activeAccount, role: 'patient', profile_complete: true } } }));
  const base = { centre_id: 'centre', kind: 'recurring', days: [1], start_time: '09:00', end_time: '13:00', effective_from: '2026-10-20', effective_to: '2026-12-31', patients: { full_name: 'Test Patient' } };
  await page.route('**/api/schedules?*', route => route.fulfill({ json: { centres: [{ id: 'centre', name: 'Test Centre' }], schedules: [{ ...base, id: 'without-trips' }, { ...base, id: 'with-trips', trip_generation: { status: 'generated' } }], context: [], total: 2, page: 1, pageSize: 10 } }));
  await page.goto('/dashboard/schedules');
  await expect(page.getByRole('button', { name: 'Edit Schedule', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'View schedule details', exact: true }).first().click();
  const details = page.getByRole('dialog', { name: 'Schedule details', exact: true });
  await expect(details).toContainText('Changes to this schedule require coordinator approval.');
  await expect(details.getByRole('button', { name: /Edit|Delete|Reschedule/ })).toHaveCount(0);
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

test('patients request changes and coordinators reject or approve them from the schedule row', async ({ page }) => {
  await seedSession(page);
  let role = 'patient';
  const centre = { id:'77777777-7777-4777-8777-777777777777',name:'Test Centre',address:'Fixture street',postal_code:'560123' };
  const source = { id:'88888888-8888-4888-8888-888888888888',patient_id:session.user.id,version:1,kind:'recurring',centre_id:centre.id,days:[1],start_time:'09:00',end_time:'10:00',effective_from:'2027-01-04',effective_to:'2027-03-29',patients:{full_name:'Test Patient'} };
  let request: Record<string, any> | null = null;
  await page.route('**/api/auth/me',route=>route.fulfill({json:{account:{...activeAccount,role,profile_complete:true}}}));
  await page.route('**/api/schedules?*',route=>route.fulfill({json:{centres:[centre],schedules:[{...source,change_request:request}],context:[],total:1,page:1,pageSize:10}}));
  await page.route('**/api/schedules/*/change-requests',route=>{
    expect(route.request().method()).toBe('POST');
    const input=route.request().postDataJSON();
    expect(input.version).toBe(source.version);
    request={id:'99999999-9999-4999-8999-999999999999',schedule_id:source.id,root_schedule_id:source.id,version:1,action:input.action,proposal:input.details,before_snapshot:{...source},reason:input.reason,original_date:null,status:'pending',review_note:'',requested_at:'2026-10-25T00:00:00Z',reviewed_at:null};
    return route.fulfill({json:request});
  });
  await page.route('**/api/schedules/change-requests/*/review',route=>{
    const input=route.request().postDataJSON();
    expect(input.version).toBe(request!.version);
    if(input.decision==='approved') { source.start_time=request!.proposal.start_time;source.end_time=request!.proposal.end_time;source.version++; }
    request={...request,status:input.decision,review_note:input.note,version:request!.version+1};
    return route.fulfill({json:request});
  });
  await page.goto('/dashboard/schedules');
  await page.getByRole('button',{name:'Request schedule change',exact:true}).click();
  let dialog=page.getByRole('dialog',{name:'Request schedule change',exact:true});
  await dialog.getByLabel('Session start',{exact:true}).fill('12:00');
  await dialog.getByLabel('Session end',{exact:true}).fill('13:00');
  await dialog.getByLabel('Reason for change',{exact:true}).fill('Appointment moved');
  await dialog.getByRole('button',{name:'Submit request',exact:true}).click();
  await expect(page.getByRole('button',{name:'Changes pending',exact:true})).toBeVisible();
  expect(source.start_time).toBe('09:00');
  role='coordinator';await page.reload();
  await page.getByRole('button',{name:'Review schedule change',exact:true}).click();
  dialog=page.getByRole('dialog',{name:'Review schedule change',exact:true});
  await expect(dialog).toContainText('09:00 – 10:00');
  await expect(dialog).toContainText('12:00 – 13:00');
  await dialog.getByRole('button',{name:'Reject',exact:true}).click();
  await expect(dialog.getByRole('alert')).toContainText('reason');
  await dialog.getByLabel('Review note (required to reject)',{exact:true}).fill('Please verify with the centre');
  await dialog.getByRole('button',{name:'Reject',exact:true}).click();
  expect(source.start_time).toBe('09:00');
  role='patient';await page.reload();
  await page.getByRole('button',{name:'Request schedule change',exact:true}).click();
  dialog=page.getByRole('dialog',{name:'Request schedule change',exact:true});
  await expect(dialog).toContainText('Please verify with the centre');
  await dialog.getByLabel('Session start',{exact:true}).fill('12:00');
  await dialog.getByLabel('Session end',{exact:true}).fill('13:00');
  await dialog.getByLabel('Reason for change',{exact:true}).fill('Confirmed with the centre');
  await dialog.getByRole('button',{name:'Submit request',exact:true}).click();
  await expect(page.getByRole('button',{name:'Changes pending',exact:true})).toBeVisible();
  role='coordinator';await page.reload();
  await page.getByRole('button',{name:'Review schedule change',exact:true}).click();
  await page.getByRole('dialog',{name:'Review schedule change',exact:true}).getByRole('button',{name:'Approve',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'Review schedule change',exact:true})).toHaveCount(0);
  await expect(page.locator('.treatment-record')).toContainText('12:00–13:00');
  await expect(page.getByRole('button',{name:'Changes pending',exact:true})).toHaveCount(0);
});
