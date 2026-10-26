/** Initial contracts; refine attributes against the team's WIP design model. */
export type UserRole = 'coordinator' | 'driver' | 'patient' | 'caregiver';
export interface PatientScope { userId: string; role: UserRole; patientId: string }
export interface AvailabilityInput { driverId: string; startsAt: string; endsAt: string }
export interface TreatmentSlotInput { patientId: string; centreId: string; arrivalTime: string; returnWindow: string; recurrence: string }
export interface AssignmentInput { tripId: string; driverId: string; vehicleId: string }
/** WGS84 decimal degrees; OneMap expects latitude,longitude in this order. */
export interface Coordinates { latitude: number; longitude: number }
export interface LocationInput extends Coordinates { recordedAt: string; accuracyMetres?: number }
// Journey progress and patient acknowledgement are separate from operational risk.
export type TripLifecycle = 'scheduled' | 'in-progress' | 'completed' | 'cancelled';
export type TripOperationalStatus = 'unfilled' | 'on-track' | 'at-risk' | 'resolved';
