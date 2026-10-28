export interface TripClock {
  demo_owner_id?: string | null;
  demo_clock_at?: string | null;
  demo_clock_started_at?: string | null;
}

/** Business time only: credentials, cache ages and location freshness use real time. */
export function tripNow(trip: TripClock = {}, realNow = Date.now()): number {
  if (!trip.demo_owner_id || !trip.demo_clock_at) return realNow;
  const instant = Date.parse(trip.demo_clock_at);
  if (!Number.isFinite(instant)) return realNow;
  if (!trip.demo_clock_started_at) return instant;
  const anchor = Date.parse(trip.demo_clock_started_at);
  return Number.isFinite(anchor) ? instant + Math.max(0, realNow - anchor) : realNow;
}
