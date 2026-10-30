import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeTraffic } from '../src/trips/traffic/route-traffic';
import type { DrivingRoute } from '../src/integrations/onemap/onemap.service';
import type { RoadSpeedBand, TrafficIncident, TrafficSnapshot } from '../src/integrations/lta/lta.service';

/**
 * Control-flow and boundary tests for routeTraffic().
 *
 * Geometry: the route runs due EAST along latitude 1.30 for ~1.11 km.
 * 1° of latitude is modelled as exactly 111 200 m, so a north/south offset of N metres
 * is N / 111200 degrees — this makes distance boundaries (40 m road match, 100 m incident,
 * 5 000 m link cap, 0.85 alignment) exact enough to test one metre either side.
 */

const LAT = 1.3;
const LON0 = 103.8;
const M_PER_LAT = 111200;
const M_PER_LON = 111200 * Math.cos((1.32 * Math.PI) / 180);
const lonAt = (metresEast: number) => LON0 + metresEast / M_PER_LON;
const latAt = (metresNorth: number) => LAT + metresNorth / M_PER_LAT;

const ROUTE_METRES = 1000;
const route = (over: Partial<DrivingRoute> = {}): DrivingRoute => ({
  encodedPolyline: '',
  geometry: [[LAT, LON0], [LAT, lonAt(ROUTE_METRES)]],
  distanceMetres: ROUTE_METRES,
  durationSeconds: 60,          // 60 km/h baseline: 1000 m in 60 s
  ...over,
});

const band = (over: Partial<RoadSpeedBand> & { from?: [number, number]; to?: [number, number] } = {}): RoadSpeedBand => {
  const { from = [LAT, LON0], to = [LAT, lonAt(ROUTE_METRES)], ...rest } = over;
  return {
    linkId: 'L1', roadName: 'Fixture Road', speedBand: 4, minimumSpeedKmh: 20, maximumSpeedKmh: 30,
    start: { latitude: from[0], longitude: from[1] }, end: { latitude: to[0], longitude: to[1] }, ...rest,
  };
};
const incident = (latitude: number, longitude: number): TrafficIncident => ({ latitude, longitude, type: 'Accident', message: 'Fixture' });
const snapshot = (speedBands: RoadSpeedBand[] = [], incidents: TrafficIncident[] = []): TrafficSnapshot => ({
  incidents, speedBands, retrievedAt: '2026-10-28T04:00:00.000Z',
  incidentsRetrievedAt: '2026-10-28T04:00:00.000Z', speedBandsRetrievedAt: '2026-10-28T03:58:00.000Z',
});

// ─────────────────────────── control flow: route geometry ───────────────────────────

test('path: empty geometry (loop body never executes) → nothing covered, estimate equals provider duration', () => {
  const result = routeTraffic(route({ geometry: [] }), snapshot([band()]));
  assert.equal(result.coverage_percent, 0);
  assert.equal(result.coverage_fraction, 0);
  assert.equal(result.minimum_seconds, 60);
  assert.equal(result.maximum_seconds, 60);
  assert.deepEqual(result.speed_bands, []);
  assert.deepEqual(result.incidents, []);
});

test('path: a single point (loop starts at index 1 and exits at once) behaves like an empty route', () => {
  const result = routeTraffic(route({ geometry: [[LAT, LON0]] }), snapshot([band()], [incident(LAT, LON0)]));
  assert.equal(result.coverage_percent, 0);
  assert.equal(result.minimum_seconds, 60);
  assert.deepEqual(result.incidents, [], 'with no route section there is nothing for an incident to be near');
});

test('path: zero-length sections (duplicate consecutive points) are skipped by the `continue` branch', () => {
  const result = routeTraffic(route({ geometry: [[LAT, LON0], [LAT, LON0], [LAT, LON0]] }), snapshot([band()]));
  assert.equal(result.coverage_percent, 0);
  // A duplicate point in the middle of a real route must not disturb coverage.
  const middle = lonAt(ROUTE_METRES / 2);
  const withDuplicate = routeTraffic(route({ geometry: [[LAT, LON0], [LAT, middle], [LAT, middle], [LAT, lonAt(ROUTE_METRES)]] }), snapshot([band()]));
  const plain = routeTraffic(route(), snapshot([band()]));
  assert.equal(withDuplicate.coverage_percent, plain.coverage_percent);
  assert.equal(withDuplicate.coverage_percent, 100);
});

test('path: empty traffic feed (no road observation) → both bounds collapse onto the provider duration', () => {
  const result = routeTraffic(route(), snapshot());
  assert.equal(result.coverage_percent, 0);
  assert.ok(result.minimum_seconds >= 60 && result.minimum_seconds <= 61, `minimum ${result.minimum_seconds}`);
  assert.ok(result.maximum_seconds !== null && result.maximum_seconds >= 60 && result.maximum_seconds <= 61, `maximum ${result.maximum_seconds}`);
  assert.deepEqual(result.speed_bands, []);
});

test('path: multi-section route accumulates coverage across every section', () => {
  const corner = lonAt(500);
  const bent = route({ geometry: [[LAT, LON0], [LAT, corner], [latAt(500), corner]] });
  const east = band({ linkId: 'east', from: [LAT, LON0], to: [LAT, corner] });
  const north = band({ linkId: 'north', from: [LAT, corner], to: [latAt(500), corner] });
  const both = routeTraffic(bent, snapshot([east, north]));
  const onlyEast = routeTraffic(bent, snapshot([east]));
  assert.equal(both.coverage_percent, 100);
  assert.ok(onlyEast.coverage_percent >= 45 && onlyEast.coverage_percent <= 55, `half covered, got ${onlyEast.coverage_percent}`);
  assert.deepEqual(both.speed_bands.map(road => road.linkId).sort(), ['east', 'north']);
});

test('path: degenerate provider distance (0 m) does not divide by zero', () => {
  const result = routeTraffic(route({ distanceMetres: 0 }), snapshot([band()]));
  assert.ok(Number.isFinite(result.minimum_seconds));
  assert.ok(result.minimum_seconds >= 60, 'estimate never drops below the provider duration');
  assert.ok(Number.isFinite(result.coverage_fraction));
});

// ─────────────────────────── control flow: matching and estimates ───────────────────────────

test('path: aligned observation covers the route and bounds the estimate by that band\'s speeds', () => {
  const result = routeTraffic(route(), snapshot([band({ minimumSpeedKmh: 20, maximumSpeedKmh: 30 })]));
  assert.equal(result.coverage_percent, 100);
  assert.equal(result.speed_bands.length, 1);
  assert.ok(result.speed_bands[0].route_geometry.length > 0, 'matched part of the route is returned for drawing');
  // 1000 m at 30 km/h = 120 s fastest; at 20 km/h = 180 s slowest (scaled by distance ratio ≈ 1).
  assert.ok(result.minimum_seconds >= 120 && result.minimum_seconds <= 122, `minimum ${result.minimum_seconds}`);
  assert.ok(result.maximum_seconds !== null && result.maximum_seconds >= 180 && result.maximum_seconds <= 182, `maximum ${result.maximum_seconds}`);
  assert.ok(result.minimum_seconds <= result.maximum_seconds!);
});

test('path: the estimate never falls below the provider baseline even when the band is faster than baseline', () => {
  // Band allows 90–100 km/h → 36 s; baseline says 60 s, so the floor of 60 s applies on both bounds.
  const result = routeTraffic(route(), snapshot([band({ minimumSpeedKmh: 90, maximumSpeedKmh: 100, speedBand: 7 })]));
  assert.equal(result.minimum_seconds, 60);
  assert.equal(result.maximum_seconds, 60);
});

test('path: minimumSpeedKmh = 0 (stopped traffic) makes the slow bound unbounded (null) but keeps the fast bound', () => {
  const result = routeTraffic(route(), snapshot([band({ minimumSpeedKmh: 0, maximumSpeedKmh: 9, speedBand: 1 })]));
  assert.equal(result.maximum_seconds, null);
  assert.ok(Number.isFinite(result.minimum_seconds));
  // Boundary: the smallest positive minimum is bounded again.
  const bounded = routeTraffic(route(), snapshot([band({ minimumSpeedKmh: 1, maximumSpeedKmh: 9, speedBand: 1 })]));
  assert.notEqual(bounded.maximum_seconds, null);
});

test('boundary: speedBand ≤ 3 counts as slow traffic, 4 does not (3 | 4)', () => {
  assert.equal(routeTraffic(route(), snapshot([band({ speedBand: 3 })])).slow_route_percent, 100);
  assert.equal(routeTraffic(route(), snapshot([band({ speedBand: 4 })])).slow_route_percent, 0);
  assert.equal(routeTraffic(route(), snapshot([band({ speedBand: 1 })])).slow_route_percent, 100);
  assert.equal(routeTraffic(route(), snapshot([band({ speedBand: 8 })])).slow_route_percent, 0);
});

test('boundary: a road more than 40 m from the route is not matched (39 m | 41 m)', () => {
  const offset = (metres: number) => band({ from: [latAt(metres), LON0], to: [latAt(metres), lonAt(ROUTE_METRES)] });
  assert.equal(routeTraffic(route(), snapshot([offset(0)])).coverage_percent, 100);
  assert.equal(routeTraffic(route(), snapshot([offset(39)])).coverage_percent, 100);
  assert.equal(routeTraffic(route(), snapshot([offset(41)])).coverage_percent, 0);
  assert.equal(routeTraffic(route(), snapshot([offset(-39)])).coverage_percent, 100, 'offset to the south behaves the same');
  assert.equal(routeTraffic(route(), snapshot([offset(-41)])).coverage_percent, 0);
});

test('boundary: link direction must align with travel (cosine ≥ 0.85); opposing and perpendicular links are ignored', () => {
  const reversed = band({ from: [LAT, lonAt(ROUTE_METRES)], to: [LAT, LON0] });             // cosine −1
  const perpendicular = band({ from: [latAt(-300), lonAt(500)], to: [latAt(300), lonAt(500)] }); // cosine 0
  assert.equal(routeTraffic(route(), snapshot([reversed])).coverage_percent, 0);
  assert.equal(routeTraffic(route(), snapshot([perpendicular])).coverage_percent, 0);
  // Angle boundary: cos(31.79°) = 0.85. A link rotated 30° still counts, 33° does not.
  const rotated = (degrees: number) => {
    const span = 400, rad = (degrees * Math.PI) / 180;
    return band({ from: [LAT, lonAt(300)], to: [latAt(span * Math.sin(rad)), lonAt(300 + span * Math.cos(rad))] });
  };
  assert.ok(routeTraffic(route(), snapshot([rotated(0)])).coverage_percent > 0);
  assert.ok(routeTraffic(route(), snapshot([rotated(20)])).coverage_percent > 0, '20° off is aligned');
  // The link leaves the 40 m corridor quickly, so use a short link to isolate the angle rule.
  const shortRotated = (degrees: number) => {
    const span = 30, rad = (degrees * Math.PI) / 180;
    return band({ from: [LAT, lonAt(500)], to: [latAt(span * Math.sin(rad)), lonAt(500 + span * Math.cos(rad))] });
  };
  assert.ok(routeTraffic(route(), snapshot([shortRotated(30)])).coverage_percent > 0, '30° off is still aligned (cos 0.866)');
  assert.equal(routeTraffic(route(), snapshot([shortRotated(33)])).coverage_percent, 0, '33° off is refused (cos 0.839)');
});

test('boundary: feed links longer than 5 000 m cannot establish correspondence (4 900 m | 5 100 m)', () => {
  const link = (metres: number) => band({ from: [LAT, lonAt(-100)], to: [LAT, lonAt(-100 + metres)] });
  assert.equal(routeTraffic(route(), snapshot([link(4900)])).coverage_percent, 100);
  assert.equal(routeTraffic(route(), snapshot([link(5100)])).coverage_percent, 0);
});

test('path: the nearest of several candidate roads wins', () => {
  const near = band({ linkId: 'near', from: [latAt(5), LON0], to: [latAt(5), lonAt(ROUTE_METRES)] });
  const far = band({ linkId: 'far', from: [latAt(30), LON0], to: [latAt(30), lonAt(ROUTE_METRES)] });
  const result = routeTraffic(route(), snapshot([far, near]));
  assert.deepEqual(result.speed_bands.map(road => road.linkId), ['near']);
});

test('path: roads far away from the route (outside the sampled grid) are discarded early', () => {
  const faraway = band({ from: [latAt(5000), LON0], to: [latAt(5000), lonAt(ROUTE_METRES)] });
  const result = routeTraffic(route(), snapshot([faraway]));
  assert.equal(result.coverage_percent, 0);
  assert.deepEqual(result.speed_bands, []);
});

test('path: partial coverage is reported proportionally (roughly one third | two thirds)', () => {
  const third = band({ from: [LAT, LON0], to: [LAT, lonAt(ROUTE_METRES / 3)] });
  const twoThirds = band({ from: [LAT, LON0], to: [LAT, lonAt((ROUTE_METRES * 2) / 3)] });
  const a = routeTraffic(route(), snapshot([third]));
  const b = routeTraffic(route(), snapshot([twoThirds]));
  assert.ok(a.coverage_percent >= 25 && a.coverage_percent <= 42, `got ${a.coverage_percent}`);
  assert.ok(b.coverage_percent >= 58 && b.coverage_percent <= 75, `got ${b.coverage_percent}`);
  assert.ok(a.coverage_fraction < b.coverage_fraction);
});

// ─────────────────────────── incidents ───────────────────────────

test('boundary: incidents within 100 m of the route are returned (99 m | 101 m)', () => {
  const at = (metresNorth: number) => incident(latAt(metresNorth), lonAt(ROUTE_METRES / 2));
  assert.equal(routeTraffic(route(), snapshot([], [at(0)])).incidents.length, 1);
  assert.equal(routeTraffic(route(), snapshot([], [at(99)])).incidents.length, 1);
  assert.equal(routeTraffic(route(), snapshot([], [at(101)])).incidents.length, 0);
  assert.equal(routeTraffic(route(), snapshot([], [at(-99)])).incidents.length, 1);
  assert.equal(routeTraffic(route(), snapshot([], [at(-101)])).incidents.length, 0);
});

test('boundary: incident beyond a segment end is measured to the end point, not the infinite line', () => {
  const beyond = (metres: number) => incident(LAT, lonAt(ROUTE_METRES + metres));
  assert.equal(routeTraffic(route(), snapshot([], [beyond(90)])).incidents.length, 1);
  assert.equal(routeTraffic(route(), snapshot([], [beyond(150)])).incidents.length, 0);
  const before = (metres: number) => incident(LAT, lonAt(-metres));
  assert.equal(routeTraffic(route(), snapshot([], [before(90)])).incidents.length, 1);
  assert.equal(routeTraffic(route(), snapshot([], [before(150)])).incidents.length, 0);
});

test('path: incident filtering keeps order and independence (some near, some far)', () => {
  const near = incident(latAt(10), lonAt(100));
  const far = incident(latAt(2000), lonAt(100));
  const alsoNear = incident(latAt(-50), lonAt(900));
  const result = routeTraffic(route(), snapshot([], [far, near, far, alsoNear]));
  assert.deepEqual(result.incidents, [near, alsoNear]);
});

test('path: incident at a grid-cell boundary is still found via the 3×3 neighbourhood search', () => {
  // Cells are 200 m wide; sample incidents either side of the 200 m and 400 m cell edges.
  for (const east of [199.9, 200, 200.1, 399.9, 400, 400.1]) {
    assert.equal(routeTraffic(route(), snapshot([], [incident(latAt(60), lonAt(east))])).incidents.length, 1, `east ${east}`);
  }
});

test('metadata: retrieval timestamps are passed through untouched', () => {
  const result = routeTraffic(route(), snapshot());
  assert.equal(result.incidents_retrieved_at, '2026-10-28T04:00:00.000Z');
  assert.equal(result.speeds_retrieved_at, '2026-10-28T03:58:00.000Z');
  const missing = routeTraffic(route(), { ...snapshot(), incidentsRetrievedAt: null, speedBandsRetrievedAt: null });
  assert.equal(missing.incidents_retrieved_at, null);
  assert.equal(missing.speeds_retrieved_at, null);
});