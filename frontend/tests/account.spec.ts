import { test, expect, session, seedSession, activeAccount, mockServices } from './support/fixtures';

test.beforeEach(mockServices);

test("patient edits their profile in place, discards drafts and saves once", async ({ page }) => {
  await seedSession(page);
  await page.route('**/api/auth/me', route => route.fulfill({ json: { account: activeAccount } }));
  let calendarDeletes=0;
  await page.route('**/api/calendar',route=>{
    if(route.request().method()==='DELETE'){calendarDeletes++;return route.fulfill({json:{connected:false,status:'disconnecting'}});}
    return route.fulfill({json:{configured:true,connected:true,status:'connected'}});
  });
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
  const calendar=page.getByRole('region',{name:'Google Calendar',exact:true});
  await expect(calendar).toContainText('Connected');
  await calendar.getByRole('button',{name:'Disconnect',exact:true}).click();
  const consent=page.getByRole('dialog',{name:'Disconnect Google Calendar',exact:true});
  await expect(consent).toBeVisible();
  await consent.getByRole('button',{name:'Cancel',exact:true}).click();
  expect(calendarDeletes).toBe(0);
  await calendar.getByRole('button',{name:'Disconnect',exact:true}).click();
  await page.getByRole('dialog',{name:'Disconnect Google Calendar',exact:true}).getByRole('button',{name:'Disconnect',exact:true}).click();
  await expect.poll(()=>calendarDeletes).toBe(1);
  await expect(calendar).toContainText('Removing reminders and disconnecting');


});
