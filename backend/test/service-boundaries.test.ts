import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AvailabilityService } from '../src/drivers/availability/availability.service';
import { TripsService } from '../src/trips/trips.service';
import type { AuthService } from '../src/auth/auth.service';
import type { SupabaseService } from '../src/infrastructure/database/supabase.module';
import type { TripRoutingService } from '../src/trips/routing/trip-routing.service';

/**
 * Boundary value analysis and control-flow (branch/path) tests for service-layer guards.
 * Each case drives the service with a fake identity and a recording fake database,
 * so a test can assert BOTH that bad input is refused AND that the database was never touched.
 */

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const status = (error: unknown) => (error as { getStatus(): number }).getStatus();
const rejectsWith = (promise: Promise<unknown>, code: number) => assert.rejects(promise, error => status(error) === code);

interface Harness { calls: Array<[string, Record<string, unknown>]>; role: string; accountStatus: string; account: unknown; dbError: { code: string } | null; }

function harness(role = 'driver') {
  const state: Harness = { calls: [], role, accountStatus: 'active', account: undefined, dbError: null };
  const auth = { verifyIdentity: async () => ({ account: state.account !== undefined ? state.account : { id: 'fixture', role: state.role, status: state.accountStatus } }) } as unknown as AuthService;
  const database = {
    forUser: () => ({
      rpc: async (name: string, args: Record<string, unknown>) => { state.calls.push([name, args]); return { data: { ok: true }, error: state.dbError }; },
    }),
  } as unknown as SupabaseService;
  const routes = { prepare: async () => undefined } as unknown as TripRoutingService;
  return { state, availability: new AvailabilityService(auth, database), trips: new TripsService(auth, database, routes) };
}

// ───────────────────────── AvailabilityService ─────────────────────────

const slots = (count: number) => Array.from({ length: count }, (_, index) => index);

test('availability access control: every branch of the guard (no token, malformed header, role, status, no account)', async () => {
  const { state, availability } = harness('driver');
  const body = { weekly_slots: [], version: 0 };
  // Branch: header missing / malformed → 401
  for (const header of [undefined, '', 'Bearer', 'Bearer ', 'Basic abc', 'bearer', 'Bearer a b', 'Token abc']) {
    await rejectsWith(availability.save(header, body), 401);
  }
  assert.equal(state.calls.length, 0);
  // Branch: valid header, wrong role → 403
  for (const role of ['patient', 'caregiver', 'coordinator']) { state.role = role; await rejectsWith(availability.save('Bearer t', body), 403); }
  // Branch: driver but inactive → 403
  state.role = 'driver'; state.accountStatus = 'inactive'; await rejectsWith(availability.save('Bearer t', body), 403);
  // Branch: no account row → 403
  state.account = null; await rejectsWith(availability.save('Bearer t', body), 403);
  assert.equal(state.calls.length, 0, 'no database access before authorisation succeeds');
  // Branch: happy path, header is case-insensitive about the scheme
  state.account = undefined; state.accountStatus = 'active';
  await availability.save('bearer t', body);
  assert.equal(state.calls.length, 1);
});

test('availability: body shape guard (null | array | primitive | unknown key)', async () => {
  const { state, availability } = harness();
  for (const body of [null, undefined, [], 'text', 7, true]) await rejectsWith(availability.save('Bearer t', body), 400);
  await rejectsWith(availability.save('Bearer t', { weekly_slots: [], version: 0, driver_id: ID }), 400);
  await rejectsWith(availability.save('Bearer t', { weekly_slots: [] }), 400);                  // version missing
  await rejectsWith(availability.save('Bearer t', { version: 0 }), 400);                        // slots missing
  assert.equal(state.calls.length, 0);
});

test('availability: version boundary 0 .. 2147483646 (below / on / above each end)', async () => {
  const { state, availability } = harness();
  await rejectsWith(availability.save('Bearer t', { weekly_slots: [], version: -1 }), 400);
  await availability.save('Bearer t', { weekly_slots: [], version: 0 });
  await availability.save('Bearer t', { weekly_slots: [], version: 1 });
  await availability.save('Bearer t', { weekly_slots: [], version: 2147483645 });
  await availability.save('Bearer t', { weekly_slots: [], version: 2147483646 });
  await rejectsWith(availability.save('Bearer t', { weekly_slots: [], version: 2147483647 }), 400);
  for (const version of [1.5, NaN, Infinity, '1', null, 2 ** 53]) await rejectsWith(availability.save('Bearer t', { weekly_slots: [], version }), 400);
  assert.equal(state.calls.length, 4);
});

test('availability: slot index boundary 0..335 (48 half-hour slots × 7 days = 336)', async () => {
  const { state, availability } = harness();
  await availability.save('Bearer t', { weekly_slots: [0], version: 0 });
  await availability.save('Bearer t', { weekly_slots: [335], version: 0 });
  await availability.save('Bearer t', { weekly_slots: [0, 335], version: 0 });
  const accepted = state.calls.length;
  for (const bad of [-1, 336, 1.5, NaN, Infinity, '5', null, undefined]) {
    await rejectsWith(availability.save('Bearer t', { weekly_slots: [bad], version: 0 }), 400);
    await rejectsWith(availability.save('Bearer t', { weekly_slots: [10, bad], version: 0 }), 400); // bad in last position
  }
  assert.equal(state.calls.length, accepted);
});

test('availability: slot count boundary 0 | 335 | 336 | 337 and duplicate detection', async () => {
  const { state, availability } = harness();
  await availability.save('Bearer t', { weekly_slots: [], version: 0 });                // 0 slots (all unavailable)
  await availability.save('Bearer t', { weekly_slots: slots(335), version: 0 });        // one below max
  await availability.save('Bearer t', { weekly_slots: slots(336), version: 0 });        // exactly max (whole week)
  assert.equal(state.calls.length, 3);
  await rejectsWith(availability.save('Bearer t', { weekly_slots: [...slots(336), 0], version: 0 }), 400); // 337
  await rejectsWith(availability.save('Bearer t', { weekly_slots: [5, 5], version: 0 }), 400);             // smallest duplicate
  await rejectsWith(availability.save('Bearer t', { weekly_slots: [...slots(335), 0], version: 0 }), 400); // 336 long but duplicated
  await rejectsWith(availability.save('Bearer t', { weekly_slots: { length: 1, 0: 1 }, version: 0 }), 400); // array-like object
  await rejectsWith(availability.save('Bearer t', { weekly_slots: '1,2', version: 0 }), 400);
  assert.equal(state.calls.length, 3);
});

test('availability: control flow — template path vs per-week path chooses a different RPC', async () => {
  const { state, availability } = harness();
  // Path A: no week_start → template RPC.
  await availability.save('Bearer t', { weekly_slots: [1, 2], version: 3 });
  assert.deepEqual(state.calls.at(-1), ['save_my_availability', { slots: [1, 2], expected_version: 3 }]);
  // Path B: week_start present → per-week RPC with template_version.
  await availability.save('Bearer t', { weekly_slots: [1, 2], version: 3, week_start: '2026-10-26', template_version: 9 });
  assert.deepEqual(state.calls.at(-1), ['save_my_week_availability', { target_week: '2026-10-26', slots: [1, 2], expected_version: 3, expected_template_version: 9 }]);
  // Path C: template_version without week_start is refused (cross-branch consistency rule).
  await rejectsWith(availability.save('Bearer t', { weekly_slots: [], version: 0, template_version: 0 }), 400);
  assert.equal(state.calls.length, 2);
});

test('availability: week_start must be a real Monday (weekday boundary on both sides)', async () => {
  const { state, availability } = harness();
  const week = (week_start: unknown) => ({ weekly_slots: [], version: 0, template_version: 0, week_start });
  await availability.save('Bearer t', week('2026-10-26'));                              // Monday
  const accepted = state.calls.length;
  await rejectsWith(availability.save('Bearer t', week('2026-10-25')), 400);            // Sunday just before
  await rejectsWith(availability.save('Bearer t', week('2026-10-27')), 400);            // Tuesday just after
  for (const bad of ['2026-02-30', '2026-13-01', '0000-01-04', '2026-10-26T00:00:00Z', '26-10-26', '', 20261026, null]) {
    await rejectsWith(availability.save('Bearer t', week(bad)), 400);
  }
  // Leap-year Monday exists, non-leap 29 Feb does not.
  await availability.save('Bearer t', week('2028-02-28')); // Monday
  await rejectsWith(availability.save('Bearer t', week('2027-02-29')), 400);
  assert.equal(state.calls.length, accepted + 1);
});

test('availability: template_version boundary 0 .. 2147483647 when a week is given', async () => {
  const { state, availability } = harness();
  const withTemplate = (template_version: unknown) => ({ weekly_slots: [], version: 0, week_start: '2026-10-26', template_version });
  await rejectsWith(availability.save('Bearer t', withTemplate(-1)), 400);
  await availability.save('Bearer t', withTemplate(0));
  await availability.save('Bearer t', withTemplate(2147483647));
  await rejectsWith(availability.save('Bearer t', withTemplate(2147483648)), 400);
  for (const bad of [1.5, '1', null, undefined, NaN]) await rejectsWith(availability.save('Bearer t', withTemplate(bad)), 400);
  assert.equal(state.calls.length, 2);
});

test('availability: database error-code mapping covers every branch of check() for save and get', async () => {
  const { state, availability } = harness();
  const cases: Array<[string, number]> = [
    ['P0001', 400], ['42501', 403], ['PT409', 409], ['40001', 409],
    ['22023', 400], ['22007', 400], ['22008', 400], ['22P02', 400], ['23514', 400],
    ['XX000', 503], ['', 503], ['08006', 503],
  ];
  for (const [code, expected] of cases) {
    state.dbError = { code };
    await rejectsWith(availability.save('Bearer t', { weekly_slots: [], version: 0 }), expected);
    await rejectsWith(availability.get('Bearer t'), expected);
  }
  // P0001 carries a machine-readable code the UI keys off.
  state.dbError = { code: 'P0001' };
  await assert.rejects(availability.save('Bearer t', { weekly_slots: [], version: 0 }), error => (error as { getResponse(): { code: string } }).getResponse().code === 'availability_booked');
  state.dbError = { code: 'PT409' };
  await assert.rejects(availability.get('Bearer t'), error => (error as { getResponse(): { code: string } }).getResponse().code === 'availability_conflict');
  // No error: data passes straight through.
  state.dbError = null;
  assert.deepEqual(await availability.get('Bearer t'), { ok: true });
});

// ───────────────────────────── TripsService ─────────────────────────────

/** Fixed clock: 2026-10-28 12:00 Singapore time (a Wednesday). */
const WEDNESDAY_NOON_SGT = new Date('2026-10-28T04:00:00Z');

test('listTrips: page boundary 1 .. 1000000', async context => {
  context.mock.timers.enable({ apis: ['Date'], now: WEDNESDAY_NOON_SGT });
  const { state, trips } = harness('coordinator');
  const list = (page: unknown) => trips.listTrips('Bearer t', page as string);
  await rejectsWith(list('0'), 400);
  await list('1');
  await list('2');
  await list('999999');
  await list('1000000');
  await rejectsWith(list('1000001'), 400);
  for (const bad of ['-1', '1.5', '1e3', ' 1', '1 ', '', 'abc', 1, null, 9007199254740993n.toString()]) await rejectsWith(list(bad), 400);
  assert.equal(state.calls.length, 4);
  assert.equal(state.calls[3][1].page_no, 1000000);
});

test('listTrips: search length boundary 100/101, control characters and trimming', async context => {
  context.mock.timers.enable({ apis: ['Date'], now: WEDNESDAY_NOON_SGT });
  const { state, trips } = harness('coordinator');
  const search = (value: unknown) => trips.listTrips('Bearer t', '1', undefined, undefined, undefined, value as string);
  await search('');
  await search('a'.repeat(99));
  await search('a'.repeat(100));
  await rejectsWith(search('a'.repeat(101)), 400);
  // Length is checked BEFORE trimming: 100 characters plus a space is rejected, yet the value sent is trimmed.
  await rejectsWith(search(` ${'a'.repeat(100)}`), 400);
  await search(`  ${'a'.repeat(96)}  `); // 100 characters including padding
  assert.equal(state.calls.at(-1)![1].search_text, 'a'.repeat(96));
  // Control-character boundary: 0x1f and 0x7f refused, 0x20 (space) and 0x7e (~) allowed.
  await rejectsWith(search('a\u001fb'), 400);
  await rejectsWith(search('a\u007fb'), 400);
  await rejectsWith(search('a\u0000b'), 400);
  await rejectsWith(search('a\nb'), 400);
  await search('a b');
  await search('a~b');
  await rejectsWith(search(42), 400);
  await rejectsWith(search(['a']), 400);
});

test('listTrips: status filter boundaries — 8 distinct members allowed, 9 refused, unknown members refused', async context => {
  context.mock.timers.enable({ apis: ['Date'], now: WEDNESDAY_NOON_SGT });
  const { state, trips } = harness('coordinator');
  const filter = (status: unknown) => trips.listTrips('Bearer t', '1', undefined, undefined, status as string);
  const members = ['unfilled', 'at-risk', 'on-track', 'resolved', 'cancelled', 'upcoming', 'in-progress', 'completed'];
  await filter('all');
  for (const member of members) await filter(member);
  await filter(members.slice(0, 7).join(','));
  await filter(members.join(','));                                            // exactly 8
  await rejectsWith(filter([...members, 'unfilled'].join(',')), 400);        // 9
  await rejectsWith(filter('unfilled,bogus'), 400);
  await rejectsWith(filter('unfilled,'), 400);                               // trailing empty member
  await rejectsWith(filter(''), 400);
  await rejectsWith(filter('All'), 400);
  await rejectsWith(filter('all,unfilled'), 400);                            // "all" is not a list member
  await rejectsWith(filter(['unfilled']), 400);
  assert.equal(state.calls.length, 1 + members.length + 2);
});

test('listTrips: direction filter boundaries — 1 or 2 members allowed, 3 refused', async context => {
  context.mock.timers.enable({ apis: ['Date'], now: WEDNESDAY_NOON_SGT });
  const { state, trips } = harness('coordinator');
  const direction = (value: unknown) => trips.listTrips('Bearer t', '1', undefined, undefined, undefined, undefined, value as string);
  for (const ok of ['all', 'outbound', 'return', 'outbound,return', 'return,outbound']) await direction(ok);
  for (const bad of ['outbound,return,outbound', 'sideways', 'outbound,', ',return', '', 'Outbound', ['outbound']]) await rejectsWith(direction(bad), 400);
  assert.equal(state.calls.length, 5);
});

test('listTrips: sort and order are closed enumerations (each member accepted, near-misses refused)', async context => {
  context.mock.timers.enable({ apis: ['Date'], now: WEDNESDAY_NOON_SGT });
  const { state, trips } = harness('coordinator');
  const call = (sort: unknown, order: unknown) => trips.listTrips('Bearer t', '1', undefined, undefined, undefined, undefined, undefined, sort as string, order as string);
  for (const sort of ['treatment_start', 'pickup_time', 'patient_name', 'direction', 'status']) for (const order of ['asc', 'desc']) await call(sort, order);
  for (const sort of ['id', 'created_at', 'Status', 'status;drop table trips', '', null]) await rejectsWith(call(sort, 'asc'), 400);
  for (const order of ['ASC', 'Desc', 'ascending', '', null]) await rejectsWith(call('status', order), 400);
  assert.equal(state.calls.length, 10);
});

test('listTrips: date-window boundaries — until == from allowed, until < from refused, empty until means open-ended', async context => {
  context.mock.timers.enable({ apis: ['Date'], now: WEDNESDAY_NOON_SGT });
  const { state, trips } = harness('coordinator');
  await trips.listTrips('Bearer t', '1', '2026-10-28', '2026-10-28');
  assert.equal(state.calls.at(-1)![1].until_date, '2026-10-28');
  await rejectsWith(trips.listTrips('Bearer t', '1', '2026-10-28', '2026-10-27'), 400);
  await trips.listTrips('Bearer t', '1', '2026-10-28', '');
  assert.equal(state.calls.at(-1)![1].until_date, null);
  await trips.listTrips('Bearer t', '1', '2026-10-28', undefined);
  assert.equal(state.calls.at(-1)![1].until_date, null);
  for (const bad of ['2026-02-30', '2026-13-01', '0000-01-01', '28-10-2026', 'today']) await rejectsWith(trips.listTrips('Bearer t', '1', bad), 400);
  await rejectsWith(trips.listTrips('Bearer t', '1', '2026-10-28', '2026-02-30'), 400);
  // Default `from` is today's Singapore date.
  await trips.listTrips('Bearer t');
  assert.equal(state.calls.at(-1)![1].from_date, '2026-10-28');
});

test('Singapore day rollover: "today" changes exactly at 16:00:00.000 UTC', async context => {
  context.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-28T15:59:59.999Z') });
  const { state, trips } = harness('coordinator');
  await trips.listTrips('Bearer t');
  assert.equal(state.calls.at(-1)![1].from_date, '2026-10-28');
  context.mock.timers.setTime(new Date('2026-10-28T16:00:00.000Z').getTime());
  await trips.listTrips('Bearer t');
  assert.equal(state.calls.at(-1)![1].from_date, '2026-10-29');
});

test('generateTrips: planning horizon is the fourth Sunday, for each weekday the horizon moves by a day', async context => {
  context.mock.timers.enable({ apis: ['Date'], now: WEDNESDAY_NOON_SGT });
  const { state, trips } = harness('coordinator');
  const generate = (from: string, until: string) => trips.generateTrips('Bearer t', { schedule_id: ID, from_date: from, until_date: until, version: 1 });
  // [instant (SGT noon), today, last permitted until, first refused until]
  const table: Array<[string, string, string, string]> = [
    ['2026-10-26T04:00:00Z', '2026-10-26', '2026-11-22', '2026-11-23'], // Monday    → horizon +27
    ['2026-10-28T04:00:00Z', '2026-10-28', '2026-11-22', '2026-11-23'], // Wednesday → +25
    ['2026-10-31T04:00:00Z', '2026-10-31', '2026-11-22', '2026-11-23'], // Saturday  → +22
    ['2026-11-01T04:00:00Z', '2026-11-01', '2026-11-22', '2026-11-23'], // Sunday    → +21 (weekday 7)
    ['2026-11-02T04:00:00Z', '2026-11-02', '2026-11-29', '2026-11-30'], // next Monday: horizon advances a week
  ];
  for (const [instant, today, last, refused] of table) {
    context.mock.timers.setTime(new Date(instant).getTime());
    state.calls.length = 0;
    await generate(today, last);
    assert.equal(state.calls.length, 1, `${today}: ${last} must be allowed`);
    await rejectsWith(generate(today, refused), 400);
    assert.equal(state.calls.length, 1, `${today}: ${refused} must be refused before the database`);
  }
});

test('generateTrips: start-date boundary — today allowed, yesterday refused, until before from refused', async context => {
  context.mock.timers.enable({ apis: ['Date'], now: WEDNESDAY_NOON_SGT });
  const { state, trips } = harness('coordinator');
  const generate = (from: unknown, until: unknown) => trips.generateTrips('Bearer t', { schedule_id: ID, from_date: from, until_date: until, version: 1 });
  await generate('2026-10-28', '2026-10-28');
  assert.equal(state.calls.length, 1);
  await rejectsWith(generate('2026-10-27', '2026-10-28'), 400);       // yesterday
  await rejectsWith(generate('2026-10-29', '2026-10-28'), 400);       // until before from
  await rejectsWith(generate(undefined, '2026-10-28'), 400);          // missing from
  await rejectsWith(generate('2026-10-28', undefined), 400);          // missing until
  await rejectsWith(generate('2026-10-28', '2026-02-30'), 400);       // impossible date
  assert.equal(state.calls.length, 1);
});

test('trip version boundary 1 .. 2147483647 on delete, unassign and generate', async context => {
  context.mock.timers.enable({ apis: ['Date'], now: WEDNESDAY_NOON_SGT });
  const { state, trips } = harness('coordinator');
  const commands: Array<[string, (version: unknown) => Promise<unknown>]> = [
    ['deleteTrip', version => trips.deleteTrip('Bearer t', ID, { version })],
    ['unassignTrip', version => trips.unassignTrip('Bearer t', ID, { version })],
    ['generateTrips', version => trips.generateTrips('Bearer t', { schedule_id: ID, from_date: '2026-10-28', until_date: '2026-10-28', version })],
  ];
  for (const [name, run] of commands) {
    state.calls.length = 0;
    await rejectsWith(run(0), 400);
    await run(1);
    await run(2147483647);
    await rejectsWith(run(2147483648), 400);
    for (const bad of [-1, 1.5, NaN, Infinity, '1', null, undefined, 2 ** 53]) await rejectsWith(run(bad), 400);
    assert.equal(state.calls.length, 2, `${name}: only versions 1 and 2147483647 reach the database`);
  }
});

test('trip id boundary: a UUID must have 8-4-4-4-12 hexadecimal groups', async context => {
  context.mock.timers.enable({ apis: ['Date'], now: WEDNESDAY_NOON_SGT });
  const { state, trips } = harness('coordinator');
  await trips.unassignTrip('Bearer t', ID, { version: 1 });
  await trips.unassignTrip('Bearer t', ID.toUpperCase(), { version: 1 });
  for (const bad of ['', ID.slice(1), `${ID}0`, ID.replaceAll('-', ''), ID.replace('a', 'g'), ` ${ID}`, `${ID}\n`, 'null']) {
    await rejectsWith(trips.unassignTrip('Bearer t', bad, { version: 1 }), 400);
  }
  assert.equal(state.calls.length, 2);
});

test('assignTrip: pickup must be an exact future minute (seconds, millis, offset and "now" boundaries)', async context => {
  context.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-28T04:00:00.000Z') });
  const { state, trips } = harness('coordinator');
  const assign = (pickup_at: unknown) => trips.assignTrip('Bearer t', ID, { driver_id: ID, pickup_at, version: 1 });
  await rejectsWith(assign('2026-10-28T03:59:00.000Z'), 400);         // past
  await rejectsWith(assign('2026-10-28T04:00:00.000Z'), 400);         // exactly now (strictly future required)
  await assign('2026-10-28T04:01:00.000Z');                           // one minute ahead
  context.mock.timers.setTime(new Date('2026-10-28T04:00:59.999Z').getTime());
  await rejectsWith(assign('2026-10-28T04:00:00.000Z'), 400);         // still in the past by 59.999 s
  await assign('2026-10-28T04:01:00.000Z');                           // 1 ms ahead is allowed
  const accepted = state.calls.length;
  for (const bad of ['2026-10-28T04:01:30.000Z', '2026-10-28T04:01:00.001Z', '2026-10-28T04:01:00Z', '2026-10-28T12:01:00.000+08:00', '2026-10-28 04:01:00.000Z',
    '2026-10-28T04:01', '2026-02-30T04:01:00.000Z', '2026-10-28T24:00:00.000Z', '', null, undefined, 1793000000000]) {
    await rejectsWith(assign(bad), 400);
  }
  assert.equal(state.calls.length, accepted);
});

test('updateLocation: latitude, longitude and accuracy boundaries', async () => {
  const { state, trips } = harness('driver');
  const at = (over: Record<string, unknown>) => trips.updateLocation('Bearer t', ID,
    { sharing_id: ID, latitude: 1.3, longitude: 103.8, accuracy_metres: 10, recorded_at: '2026-10-28T04:00:00.000Z', ...over });
  await at({});
  // latitude −90..90
  await at({ latitude: -90 }); await at({ latitude: 90 });
  await rejectsWith(at({ latitude: -90.000001 }), 400); await rejectsWith(at({ latitude: 90.000001 }), 400);
  // longitude −180..180
  await at({ longitude: -180 }); await at({ longitude: 180 });
  await rejectsWith(at({ longitude: -180.000001 }), 400); await rejectsWith(at({ longitude: 180.000001 }), 400);
  // accuracy 0..10000 metres
  await at({ accuracy_metres: 0 }); await at({ accuracy_metres: 10000 });
  await rejectsWith(at({ accuracy_metres: -0.001 }), 400); await rejectsWith(at({ accuracy_metres: 10000.001 }), 400);
  // type / finiteness class
  for (const bad of [NaN, Infinity, -Infinity, '1.3', null, undefined]) {
    await rejectsWith(at({ latitude: bad }), 400);
    await rejectsWith(at({ longitude: bad }), 400);
    await rejectsWith(at({ accuracy_metres: bad }), 400);
  }
  await rejectsWith(at({ recorded_at: 'yesterday' }), 400);
  await rejectsWith(at({ recorded_at: undefined }), 400);
  await rejectsWith(at({ sharing_id: 'bad' }), 400);
  await rejectsWith(at({ extra: 1 }), 400);
  assert.equal(state.calls.length, 7);
  assert.equal(state.calls[0][0], 'report_trip_location');
});

test('clearLocation: control flow — only sharing_id is accepted when clearing', async () => {
  const { state, trips } = harness('driver');
  await trips.clearLocation('Bearer t', ID, { sharing_id: ID });
  assert.deepEqual(state.calls.at(-1), ['clear_trip_location', { target: ID, session_id: ID }]);
  await rejectsWith(trips.clearLocation('Bearer t', ID, { sharing_id: ID, latitude: 1.3 }), 400);
  await rejectsWith(trips.clearLocation('Bearer t', ID, {}), 400);
  await rejectsWith(trips.clearLocation('Bearer t', ID, null), 400);
  assert.equal(state.calls.length, 1);
});

test('access(): decision table of role × operation for trip reads, coordinator writes and driver-only actions', async context => {
  context.mock.timers.enable({ apis: ['Date'], now: WEDNESDAY_NOON_SGT });
  const roles = ['coordinator', 'patient', 'caregiver', 'driver'];
  type Op = (trips: TripsService) => Promise<unknown>;
  const operations: Array<[string, string[], Op]> = [
    ['listTrips (read)', roles, trips => trips.listTrips('Bearer t')],
    ['deleteTrip (write)', ['coordinator'], trips => trips.deleteTrip('Bearer t', ID, { version: 1 })],
    ['unassignTrip (write)', ['coordinator'], trips => trips.unassignTrip('Bearer t', ID, { version: 1 })],
    ['confirmTrip', ['patient', 'caregiver'], trips => trips.confirmTrip('Bearer t', ID, { version: 1 })],
    ['cancelTrip', ['patient', 'caregiver'], trips => trips.cancelTrip('Bearer t', ID, { version: 1 })],
    ['reportUnavailability', ['driver'], trips => trips.reportUnavailability('Bearer t', ID, { version: 1 })],
    ['executeTrip start', ['driver'], trips => trips.executeTrip('Bearer t', ID, { version: 1 }, 'start')],
    ['executeTrip complete', ['driver'], trips => trips.executeTrip('Bearer t', ID, { version: 1 }, 'complete')],
  ];
  for (const [name, allowed, run] of operations) {
    for (const role of roles) {
      const { state, trips } = harness(role);
      if (allowed.includes(role)) { await run(trips); assert.equal(state.calls.length, 1, `${name} as ${role} should reach the database`); }
      else { await rejectsWith(run(trips), 403); assert.equal(state.calls.length, 0, `${name} as ${role} must not reach the database`); }
    }
    // Inactive accounts are refused for every role.
    for (const role of allowed) {
      const { state, trips } = harness(role); state.accountStatus = 'inactive';
      await rejectsWith(run(trips), 403);
      assert.equal(state.calls.length, 0);
    }
  }
});

test('tripAction: each action maps to its own RPC name and passes the action flag only for start/complete', async () => {
  const table: Array<[string, string, (trips: TripsService) => Promise<unknown>, string, Record<string, unknown>]> = [
    ['patient', 'confirm', trips => trips.confirmTrip('Bearer t', ID, { version: 4 }), 'confirm_trip', { target: ID, expected_version: 4 }],
    ['patient', 'cancel', trips => trips.cancelTrip('Bearer t', ID, { version: 4 }), 'cancel_trip', { target: ID, expected_version: 4 }],
    ['driver', 'unavailable', trips => trips.reportUnavailability('Bearer t', ID, { version: 4 }), 'report_driver_unavailability', { target: ID, expected_version: 4 }],
    ['driver', 'start', trips => trips.executeTrip('Bearer t', ID, { version: 4 }, 'start'), 'execute_trip', { target: ID, expected_version: 4, action: 'start' }],
    ['driver', 'complete', trips => trips.executeTrip('Bearer t', ID, { version: 4 }, 'complete'), 'execute_trip', { target: ID, expected_version: 4, action: 'complete' }],
  ];
  for (const [role, , run, rpc, args] of table) {
    const { state, trips } = harness(role);
    await run(trips);
    assert.deepEqual(state.calls, [[rpc, args]]);
  }
});

test('trip database error-code mapping: every branch of check() with the resource name in the message', async () => {
  const cases: Array<[string, number]> = [
    ['42501', 403], ['PT409', 409], ['40001', 409], ['22023', 400], ['23514', 400], ['22P02', 400],
    ['22007', 400], ['22008', 400], ['P0002', 404], ['XX000', 503], ['', 503],
  ];
  for (const [code, expected] of cases) {
    const { state, trips } = harness('coordinator');
    state.dbError = { code };
    await rejectsWith(trips.unassignTrip('Bearer t', ID, { version: 1 }), expected);
  }
  const { state, trips } = harness('coordinator');
  state.dbError = { code: 'P0002' };
  await assert.rejects(trips.unassignTrip('Bearer t', ID, { version: 1 }), /Trip not found/);
});