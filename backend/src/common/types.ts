export type UserRole = 'coordinator' | 'driver' | 'patient' | 'caregiver';
/** WGS84 decimal degrees; OneMap expects latitude,longitude in this order. */
export interface Coordinates { latitude: number; longitude: number }
export interface LocationInput extends Coordinates { recordedAt: string; accuracyMetres?: number }
// Journey progress and patient acknowledgement are separate from operational risk.
export type TripLifecycle = 'scheduled' | 'in-progress' | 'completed' | 'cancelled';
export type TripOperationalStatus = 'unfilled' | 'on-track' | 'at-risk' | 'resolved';
