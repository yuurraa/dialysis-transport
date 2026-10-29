import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { personalInput, driverInput } from '../src/profiles/personal-input';
import { patientInput } from '../src/profiles/patient-input';
import { treatmentInput } from '../src/scheduling/treatment-input';

/**
 * Boundary value analysis (BVA) for the pure input validators.
 * Every limit is exercised at: just below, exactly on, and just above the boundary.
 * Equivalence classes (valid / invalid) are separated so one failure names one rule.
 */

const CENTRE = '77777777-7777-4777-8777-777777777777';
const person = { full_name: 'Tan Ah Kow', phone: '91234567', birth_date: '1950-06-15', gender: 'male' };
const patient = { ...person, pickup_address: '1 Example Road', mobility: 'ambulant', assistance_required: false };
const recurring = { centre_id: CENTRE, days: [1], start_time: '09:00', end_time: '13:00', effective_from: '2026-10-26', effective_to: '2026-12-28' };
const accepts = (fn: () => unknown) => assert.doesNotThrow(fn);
const rejects = (fn: () => unknown) => assert.throws(fn, /./);

// ───────────────────────────── personalInput ─────────────────────────────

test('personalInput: full_name length boundary 100/101 is measured after trimming', () => {
  accepts(() => personalInput({ ...person, full_name: 'a'.repeat(99) }));
  accepts(() => personalInput({ ...person, full_name: 'a'.repeat(100) }));
  rejects(() => personalInput({ ...person, full_name: 'a'.repeat(101) }));
  // Padding does not count: 100 characters plus spaces is still within the limit.
  assert.equal(personalInput({ ...person, full_name: `  ${'a'.repeat(100)}  ` }).full_name, 'a'.repeat(100));
  // Empty-equivalence class: empty, whitespace only, missing, wrong type.
  for (const bad of ['', '   ', undefined, null, 42, ['x']]) rejects(() => personalInput({ ...person, full_name: bad }));
});

test('personalInput: local phone must be exactly 8 digits (7 | 8 | 9 boundary)', () => {
  rejects(() => personalInput({ ...person, phone: '1234567' }));
  accepts(() => personalInput({ ...person, phone: '12345678' }));
  rejects(() => personalInput({ ...person, phone: '123456789' }));
  rejects(() => personalInput({ ...person, phone: '9123 4567' }));
  rejects(() => personalInput({ ...person, phone: '9123456a' }));
  rejects(() => personalInput({ ...person, phone: '' }));
});

test('personalInput: international phone boundaries (6..14 subscriber digits, 15-digit E.164 cap, +65 needs 8)', () => {
  // subscriber length lower/upper bound
  rejects(() => personalInput({ ...person, phone: '+1 12345' }));        // 5 digits
  accepts(() => personalInput({ ...person, phone: '+1 123456' }));       // 6 digits
  accepts(() => personalInput({ ...person, phone: '+1 12345678901234' })); // 14 digits, 1+14 = 15 total
  rejects(() => personalInput({ ...person, phone: '+1 123456789012345' })); // 15 digits (regex limit)
  // total E.164 length boundary 15/16 with a two-digit country code
  accepts(() => personalInput({ ...person, phone: '+44 1234567890123' }));   // 2 + 13 = 15
  rejects(() => personalInput({ ...person, phone: '+44 12345678901234' }));  // 2 + 14 = 16
  // Singapore special case 7 | 8 | 9
  rejects(() => personalInput({ ...person, phone: '+65 1234567' }));
  accepts(() => personalInput({ ...person, phone: '+65 12345678' }));
  rejects(() => personalInput({ ...person, phone: '+65 123456789' }));
  // country-code shape: 1-3 digits, no leading zero, mandatory single space
  accepts(() => personalInput({ ...person, phone: '+123 123456' }));
  rejects(() => personalInput({ ...person, phone: '+1234 123456' }));
  rejects(() => personalInput({ ...person, phone: '+0 123456' }));
  rejects(() => personalInput({ ...person, phone: '+6512345678' }));
  rejects(() => personalInput({ ...person, phone: '+65  12345678' }));
});

test('personalInput: birth_date boundaries — lower limit 1900-01-01 and upper limit "today" in Singapore time', context => {
  context.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-29T15:59:59.999Z') }); // 23:59:59.999 SGT
  rejects(() => personalInput({ ...person, birth_date: '1899-12-31' }));
  accepts(() => personalInput({ ...person, birth_date: '1900-01-01' }));
  accepts(() => personalInput({ ...person, birth_date: '1900-01-02' }));
  accepts(() => personalInput({ ...person, birth_date: '2026-10-28' }));
  accepts(() => personalInput({ ...person, birth_date: '2026-10-29' }));  // today (SGT)
  rejects(() => personalInput({ ...person, birth_date: '2026-10-30' }));  // tomorrow (SGT)
  // One millisecond later it is already the next day in Singapore (UTC+8).
  context.mock.timers.setTime(new Date('2026-10-29T16:00:00.000Z').getTime());
  accepts(() => personalInput({ ...person, birth_date: '2026-10-30' }));
  rejects(() => personalInput({ ...person, birth_date: '2026-10-31' }));
});

test('personalInput: calendar validity of birth_date (leap days, month/day limits, format)', () => {
  accepts(() => personalInput({ ...person, birth_date: '2000-02-29' }));  // divisible by 400
  accepts(() => personalInput({ ...person, birth_date: '1996-02-29' }));
  rejects(() => personalInput({ ...person, birth_date: '1900-02-29' }));  // divisible by 100, not 400
  rejects(() => personalInput({ ...person, birth_date: '2023-02-29' }));
  rejects(() => personalInput({ ...person, birth_date: '2023-04-31' }));
  rejects(() => personalInput({ ...person, birth_date: '2023-13-01' }));
  rejects(() => personalInput({ ...person, birth_date: '2023-00-10' }));
  rejects(() => personalInput({ ...person, birth_date: '2023-1-1' }));
  rejects(() => personalInput({ ...person, birth_date: '15/06/1950' }));
  rejects(() => personalInput({ ...person, birth_date: '1950-06-15T00:00:00Z' }));
  rejects(() => personalInput({ ...person, birth_date: undefined }));
});

test('personalInput: gender is a closed enumeration (every member passes, near-misses fail)', () => {
  for (const gender of ['female', 'male', 'other', 'prefer-not-to-say']) assert.equal(personalInput({ ...person, gender }).gender, gender);
  for (const gender of ['Female', 'MALE', ' male', 'male ', 'prefer not to say', '', undefined, null, 1]) rejects(() => personalInput({ ...person, gender }));
});

test('driverInput: control flow — non-object, array and unknown-key branches precede field validation', () => {
  for (const body of [null, undefined, 'text', 5, [], [person]]) rejects(() => driverInput(body));
  rejects(() => driverInput({ ...person, role: 'coordinator' })); // privilege fields never accepted
  rejects(() => driverInput({ ...person, status: 'active' }));
  assert.deepEqual(driverInput(person), person);
  // Only whitelisted fields come back, trimmed.
  assert.deepEqual(driverInput({ ...person, full_name: '  Lim  ', phone: ' 91234567 ' }), { ...person, full_name: 'Lim', phone: '91234567' });
});

// ───────────────────────────── patientInput ─────────────────────────────

test('patientInput: pickup_address boundary 300/301 and empty class', () => {
  accepts(() => patientInput({ ...patient, pickup_address: 'a' }, false));
  accepts(() => patientInput({ ...patient, pickup_address: 'a'.repeat(300) }, false));
  rejects(() => patientInput({ ...patient, pickup_address: 'a'.repeat(301) }, false));
  for (const bad of ['', '   ', undefined, 7]) rejects(() => patientInput({ ...patient, pickup_address: bad }, false));
});

test('patientInput: optional field limits unit_no 20, postal_code exactly 6 digits, notes 1000', () => {
  accepts(() => patientInput({ ...patient, unit_no: 'u'.repeat(20) }, false));
  rejects(() => patientInput({ ...patient, unit_no: 'u'.repeat(21) }, false));
  accepts(() => patientInput({ ...patient, unit_no: '' }, false));

  rejects(() => patientInput({ ...patient, postal_code: '12345' }, false));
  accepts(() => patientInput({ ...patient, postal_code: '123456' }, false));
  rejects(() => patientInput({ ...patient, postal_code: '1234567' }, false));
  rejects(() => patientInput({ ...patient, postal_code: '12345a' }, false));

  accepts(() => patientInput({ ...patient, notes: 'n'.repeat(1000) }, false));
  rejects(() => patientInput({ ...patient, notes: 'n'.repeat(1001) }, false));
  // Length is measured after trimming, so padding around 1000 characters is tolerated.
  assert.equal(patientInput({ ...patient, notes: ` ${'n'.repeat(1000)} ` }, false).notes, 'n'.repeat(1000));
  for (const field of ['unit_no', 'postal_code', 'notes']) rejects(() => patientInput({ ...patient, [field]: 12 }, false));
});

test('patientInput: control flow of optional fields — absent keys stay absent, present keys are trimmed', () => {
  const minimal = patientInput(patient, false);
  assert.equal('unit_no' in minimal, false);
  assert.equal('postal_code' in minimal, false);
  assert.equal('notes' in minimal, false);
  const full = patientInput({ ...patient, unit_no: ' #01-01 ', notes: ' needs help ', postal_code: '123456' }, false);
  assert.equal(full.unit_no, '#01-01');
  assert.equal(full.notes, 'needs help');
  assert.equal(full.postal_code, '123456');
});

test('patientInput: postal_code is validated after trimming; an empty code is not a valid code', () => {
  assert.equal(patientInput({ ...patient, postal_code: ' 123456 ' }, false).postal_code, '123456');
  rejects(() => patientInput({ ...patient, postal_code: '' }, false));
  rejects(() => patientInput({ ...patient, postal_code: '   ' }, false));
});

test('patientInput: mobility enumeration and assistance flag type', () => {
  for (const mobility of ['ambulant', 'walking-aid', 'wheelchair']) assert.equal(patientInput({ ...patient, mobility }, false).mobility, mobility);
  for (const mobility of ['Wheelchair', 'walking aid', '', undefined, null, 1]) rejects(() => patientInput({ ...patient, mobility }, false));
  for (const flag of ['true', 'false', 0, 1, null, undefined]) rejects(() => patientInput({ ...patient, assistance_required: flag }, false));
  assert.equal(patientInput({ ...patient, assistance_required: true }, false).assistance_required, true);
});

test('patientInput: includeStatus switches between two control-flow paths', () => {
  // includeStatus = false: "status" is an unknown key.
  rejects(() => patientInput({ ...patient, status: 'active' }, false));
  // includeStatus = true: status is mandatory and enumerated.
  assert.equal(patientInput({ ...patient, status: 'active' }, true).status, 'active');
  assert.equal(patientInput({ ...patient, status: 'inactive' }, true).status, 'inactive');
  for (const status of ['pending', 'Active', '', undefined, null, 1]) rejects(() => patientInput({ ...patient, status }, true));
  rejects(() => patientInput(patient, true));
  // Structural guards run first.
  for (const body of [null, undefined, [], 'x', { ...patient, extra: 1 }]) rejects(() => patientInput(body, false));
});

// ───────────────────────────── treatmentInput ─────────────────────────────

test('treatmentInput: time-of-day boundaries (00:00, 23:59) and ordering end > start', () => {
  accepts(() => treatmentInput({ ...recurring, start_time: '00:00', end_time: '00:01' }));
  accepts(() => treatmentInput({ ...recurring, start_time: '23:58', end_time: '23:59' }));
  rejects(() => treatmentInput({ ...recurring, start_time: '09:00', end_time: '09:00' })); // equal
  rejects(() => treatmentInput({ ...recurring, start_time: '09:01', end_time: '09:00' })); // one minute reversed
  accepts(() => treatmentInput({ ...recurring, start_time: '09:00', end_time: '09:01' }));  // one minute apart
  for (const bad of ['24:00', '23:60', '-1:00', '9:00', '09:0', '09:00:00', '0900', '', null, 900]) {
    rejects(() => treatmentInput({ ...recurring, start_time: bad }));
    rejects(() => treatmentInput({ ...recurring, end_time: bad }));
  }
});

test('treatmentInput: recurring weekday boundary 1..7 and single-element requirement', () => {
  for (const day of [1, 2, 3, 4, 5, 6, 7]) {
    // Pick a range of one week starting on a Monday so every weekday occurs.
    accepts(() => treatmentInput({ ...recurring, days: [day], effective_from: '2026-10-26', effective_to: '2026-11-01' }));
  }
  for (const bad of [0, 8, -1, 1.5, '1', null, NaN]) rejects(() => treatmentInput({ ...recurring, days: [bad] }));
  rejects(() => treatmentInput({ ...recurring, days: [] }));
  rejects(() => treatmentInput({ ...recurring, days: [1, 2] }));
  rejects(() => treatmentInput({ ...recurring, days: 1 }));
  rejects(() => treatmentInput({ ...recurring, days: undefined }));
});

test('treatmentInput: effective range must contain the selected weekday (first occurrence boundary)', () => {
  // 2026-10-26 is a Monday; 2026-11-01 is the following Sunday.
  accepts(() => treatmentInput({ ...recurring, days: [1], effective_from: '2026-10-26', effective_to: '2026-10-26' })); // single matching day
  rejects(() => treatmentInput({ ...recurring, days: [2], effective_from: '2026-10-26', effective_to: '2026-10-26' })); // Tuesday absent
  accepts(() => treatmentInput({ ...recurring, days: [2], effective_from: '2026-10-26', effective_to: '2026-10-27' })); // Tuesday on the last day
  rejects(() => treatmentInput({ ...recurring, days: [7], effective_from: '2026-10-26', effective_to: '2026-10-31' })); // Sunday one day late
  accepts(() => treatmentInput({ ...recurring, days: [7], effective_from: '2026-10-26', effective_to: '2026-11-01' })); // Sunday on last day
  // Starting on the weekday itself needs no wrap-around.
  accepts(() => treatmentInput({ ...recurring, days: [7], effective_from: '2026-11-01', effective_to: '2026-11-01' }));
});

test('treatmentInput: effective_to is compared with effective_from at the 0 / -1 day boundary', () => {
  accepts(() => treatmentInput({ ...recurring, effective_from: '2026-10-26', effective_to: '2026-10-26' }));
  rejects(() => treatmentInput({ ...recurring, effective_from: '2026-10-27', effective_to: '2026-10-26' }));
  rejects(() => treatmentInput({ ...recurring, effective_from: undefined }));
  rejects(() => treatmentInput({ ...recurring, effective_to: undefined }));
});

test('treatmentInput: date validity boundaries (year 0000, leap day, month end)', () => {
  accepts(() => treatmentInput({ ...recurring, days: [2], effective_from: '2028-02-29', effective_to: '2028-02-29' })); // leap Tuesday
  rejects(() => treatmentInput({ ...recurring, days: [1], effective_from: '2026-02-29', effective_to: '2026-03-02' })); // not a leap year
  rejects(() => treatmentInput({ ...recurring, effective_from: '0000-01-01', effective_to: '2026-12-31' }));
  rejects(() => treatmentInput({ ...recurring, effective_from: '2026-04-31', effective_to: '2026-12-31' }));
  rejects(() => treatmentInput({ ...recurring, effective_from: '2026-10-26 ', effective_to: '2026-12-31' }));
  rejects(() => treatmentInput({ ...recurring, effective_from: '26-10-26', effective_to: '2026-12-31' }));
});

test('treatmentInput: centre_id must be a UUID (length / grouping boundary)', () => {
  accepts(() => treatmentInput({ ...recurring, centre_id: CENTRE.toUpperCase() }));
  for (const bad of ['', CENTRE.slice(1), `${CENTRE}0`, CENTRE.replaceAll('-', ''), 'not-a-uuid', null, undefined, 5]) {
    rejects(() => treatmentInput({ ...recurring, centre_id: bad }));
  }
});

test('treatmentInput: control flow — kind selection chooses the permitted key set', () => {
  // Branch 1: structural guard.
  for (const body of [null, undefined, [], 'x', 3]) rejects(() => treatmentInput(body));
  // Branch 2: kind omitted defaults to recurring.
  assert.equal(treatmentInput(recurring).kind, 'recurring');
  assert.equal(treatmentInput({ ...recurring, kind: 'recurring' }).kind, 'recurring');
  // Branch 3: unknown kind.
  for (const kind of ['weekly', 'Single', '', null, 1]) rejects(() => treatmentInput({ ...recurring, kind }));
  // Branch 4: keys valid for the other kind are refused.
  rejects(() => treatmentInput({ ...recurring, session_date: '2026-10-26' }));
  rejects(() => treatmentInput({ ...recurring, replaces_schedule_id: CENTRE }));
  rejects(() => treatmentInput({ kind: 'single', centre_id: CENTRE, start_time: '09:00', end_time: '13:00', session_date: '2026-10-26', days: [1] }));
  rejects(() => treatmentInput({ kind: 'single', centre_id: CENTRE, start_time: '09:00', end_time: '13:00', session_date: '2026-10-26', effective_from: '2026-10-26' }));
  // Ownership/privilege fields are never accepted on either path.
  rejects(() => treatmentInput({ ...recurring, patient_id: CENTRE }));
  rejects(() => treatmentInput({ kind: 'single', centre_id: CENTRE, start_time: '09:00', end_time: '13:00', session_date: '2026-10-26', patient_id: CENTRE }));
});

test('treatmentInput: single-session path derives weekday with Sunday mapped to 7 (getUTCDay 0 boundary)', () => {
  const single = { kind: 'single', centre_id: CENTRE, start_time: '09:00', end_time: '13:00' };
  const expected: Array<[string, number]> = [
    ['2026-10-26', 1], ['2026-10-27', 2], ['2026-10-28', 3], ['2026-10-29', 4],
    ['2026-10-30', 5], ['2026-10-31', 6], ['2026-11-01', 7], ['2026-11-02', 1],
  ];
  for (const [session_date, day] of expected) {
    const result = treatmentInput({ ...single, session_date });
    assert.deepEqual(result.days, [day], session_date);
    assert.equal(result.effective_from, session_date);
    assert.equal(result.effective_to, session_date);
    assert.equal(result.kind, 'single');
  }
  for (const bad of [undefined, '', '2026-02-30', '2026-13-01', '0000-01-01', 'tomorrow', 20261026]) {
    rejects(() => treatmentInput({ ...single, session_date: bad }));
  }
});

test('treatmentInput: single-session replacement requires both references together (all-or-nothing branch)', () => {
  const single = { kind: 'single', centre_id: CENTRE, start_time: '09:00', end_time: '13:00', session_date: '2026-10-27' };
  const replaced = treatmentInput({ ...single, replaces_schedule_id: CENTRE, replaces_date: '2026-10-26' });
  assert.equal(replaced.replaces_schedule_id, CENTRE);
  assert.equal(replaced.replaces_date, '2026-10-26');
  // Neither reference: plain single session without replacement fields.
  const plain = treatmentInput(single);
  assert.equal('replaces_schedule_id' in plain, false);
  assert.equal('replaces_date' in plain, false);
  // Exactly one reference present.
  rejects(() => treatmentInput({ ...single, replaces_schedule_id: CENTRE }));
  rejects(() => treatmentInput({ ...single, replaces_date: '2026-10-26' }));
  // Both present but malformed.
  rejects(() => treatmentInput({ ...single, replaces_schedule_id: 'bad', replaces_date: '2026-10-26' }));
  rejects(() => treatmentInput({ ...single, replaces_schedule_id: CENTRE, replaces_date: '2026-02-30' }));
  rejects(() => treatmentInput({ ...single, replaces_schedule_id: null, replaces_date: null }));
});