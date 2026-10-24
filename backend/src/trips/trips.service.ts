import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, NotImplementedException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { AuthService } from '../auth/auth.service';
import { SupabaseService } from '../supabase.module';
import type { PatientScope, LocationInput } from '../types';

/** UC-04, UC-05, UC-05.1 and UC-09 to UC-12: operations, recovery and patient actions. */
@Injectable()
export class TripsService {
  constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(SupabaseService) private readonly database: SupabaseService) {}

  private async access(header?: string, write = false) {
    const token = header?.match(/^Bearer (\S+)$/i)?.[1];
    if (!token) throw new UnauthorizedException('Sign-in required.');
    const { account } = await this.auth.verifyIdentity(token);
    if (!account || account.status !== 'active' || !(write ? ['coordinator'] : ['patient', 'coordinator']).includes(account.role)) {
      throw new ForbiddenException('Trip access denied.');
    }
    return this.database.forUser(token);
  }

  private check(error: { code?: string } | null, resource = 'Treatment schedule') {
    if (!error) return;
    if (error.code === '42501') throw new ForbiddenException('Trip access denied.');
    if (error.code === '40001') throw new ConflictException(`${resource} changed. Reload before trying again.`);
    if (['22023', '23514', '22P02'].includes(error.code ?? '')) throw new BadRequestException('Invalid trip request.');
    if (error.code === 'P0002') throw new NotFoundException(`${resource} not found.`);
    throw new ServiceUnavailableException('Trips are unavailable. Please try again.');
  }

  private today() {
    return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }

  private date(value: unknown): number {
    if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) throw new BadRequestException('Invalid trip dates.');
    const timestamp = Date.parse(`${value}T00:00:00.000Z`);
    if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) throw new BadRequestException('Invalid trip dates.');
    return timestamp;
  }

  private window(from: unknown, until: unknown) {
    const start = this.date(from);
    const end = this.date(until);
    if (end < start || end - start > 89 * 24 * 60 * 60 * 1000) throw new BadRequestException('Choose a trip window of up to 90 days.');
  }

  /** Database pagination and patient ownership checks run before returning trip records. */
  async listTrips(header?: string, page = '1', from = this.today(), until?: string, status = 'all', search = '', direction = 'all', sort = 'treatment_start', order = 'asc') {
    const client = await this.access(header);
    const start = this.date(from);
    const end = until === undefined || until === '' ? null : this.date(until);
    if (end !== null && end < start) throw new BadRequestException('End date cannot be before start date.');
    const statuses = typeof status === 'string' ? status.split(',') : [];
    if (typeof page !== 'string' || !/^\d+$/.test(page) || !Number.isSafeInteger(Number(page)) || Number(page) < 1 || Number(page) > 1000000
      || typeof status !== 'string' || statuses.length > 4 || (status !== 'all' && statuses.some(value => !['unfilled', 'at-risk', 'on-track', 'resolved'].includes(value)))
      || typeof search !== 'string' || search.length > 100 || /[\u0000-\u001f\u007f]/.test(search)
      || typeof direction !== 'string' || (direction !== 'all' && (direction.split(',').length > 2 || direction.split(',').some(value => !['outbound', 'return'].includes(value))))
      || !['treatment_start', 'patient_name', 'direction', 'status'].includes(sort) || !['asc', 'desc'].includes(order)) throw new BadRequestException('Invalid trip filters.');
    const result = await client.rpc('list_trips', { page_no: Number(page), from_date: from, until_date: end === null ? null : until, status_filter: status, search_text: search.trim(), direction_filter: direction, sort_by: sort, sort_order: order });
    this.check(result.error);
    return result.data;
  }

  /** Delete one journey through the version-checked operation, retaining database history. */
  async deleteTrip(header: string | undefined, id: string, body: unknown) {
    const client = await this.access(header, true);
    if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id) || !body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some(key => key !== 'version')) throw new BadRequestException('Invalid trip deletion request.');
    const { version } = body as Record<string, unknown>;
    if (!Number.isSafeInteger(version) || (version as number) < 1 || (version as number) > 2147483647) throw new BadRequestException('A valid trip version is required.');
    const result = await client.rpc('delete_trip', { target: id, expected_version: version });
    this.check(result.error, 'Trip');
    if (!result.data) throw new NotFoundException('Trip not found.');
    return { id: result.data };
  }

  /** Generate unassigned outbound and return trips atomically from a versioned schedule. */
  async generateTrips(header: string | undefined, body: unknown) {
    const client = await this.access(header, true);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['schedule_id', 'from_date', 'until_date', 'version'].includes(key))) {
      throw new BadRequestException('Invalid trip generation request.');
    }
    const input = body as Record<string, unknown>;
    if (typeof input.schedule_id !== 'string' || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.schedule_id)
      || !Number.isSafeInteger(input.version) || (input.version as number) < 1 || (input.version as number) > 2147483647) throw new BadRequestException('Invalid schedule or version.');
    this.window(input.from_date, input.until_date);
    if ((input.from_date as string) < this.today()) throw new BadRequestException('Trip generation cannot start in the past.');
    const result = await client.rpc('generate_treatment_trips', { target: input.schedule_id, from_date: input.from_date, until_date: input.until_date, expected_version: input.version });
    this.check(result.error);
    return result.data;
  }

  /** Persist authorised patient or linked-caregiver confirmation. */
  async confirmTrip(scope: PatientScope, tripId: string): Promise<unknown> {
    // TODO: Implement using Supabase and database constraints.
    throw new NotImplementedException('confirmTrip is awaiting implementation.');
  }

  /** Check pickup time and lifecycle; atomically cancel, release capacity and log history; propose reuse for coordinator approval and schedule calendar removal. */
  async cancelTrip(scope: PatientScope, tripId: string): Promise<unknown> {
    // TODO: Implement using Supabase and database constraints.
    throw new NotImplementedException('cancelTrip is awaiting implementation.');
  }

  /** Generate/rank feasible pickup, route or resource options within ten seconds; escalate no-option cases as Unfilled-Critical. */
  async assessRecovery(scope: PatientScope, tripId: string): Promise<unknown> {
    // TODO: Implement using Supabase and database constraints.
    throw new NotImplementedException('assessRecovery is awaiting implementation.');
  }

  /** UC-08: combine baseline driving geometry with route-relevant traffic and treatment buffer. */
  async assessRoute(scope: PatientScope, tripId: string): Promise<unknown> {
    // TODO: Call OneMap/LTA under one five-second deadline, using a fresh cached traffic snapshot.
    // Recalculate ETA in application logic and flag buffer violations; label stale data clearly.
    throw new NotImplementedException('assessRoute is awaiting implementation.');
  }

  /** Require coordinator approval and fresh feasibility; atomically apply changes and history before notifications. */
  async approveRecovery(scope: PatientScope, tripId: string, optionId: string): Promise<unknown> {
    // TODO: Implement using Supabase and database constraints.
    throw new NotImplementedException('approveRecovery is awaiting implementation.');
  }

  /** Require assigned active driver; stop authorised sharing at completion/cancellation. */
  async reportLocation(scope: PatientScope, tripId: string, location: LocationInput): Promise<unknown> {
    // TODO: Implement using Supabase and database constraints.
    throw new NotImplementedException('reportLocation is awaiting implementation.');
  }

  /** Return authorised durable trip events and actor/time details. */
  async getHistory(scope: PatientScope, tripId: string): Promise<unknown> {
    // TODO: Implement using Supabase and database constraints.
    throw new NotImplementedException('getHistory is awaiting implementation.');
  }

  /** Require patient identity and their completed trip with the rated driver. */
  async rateDriver(scope: PatientScope, tripId: string, rating: number): Promise<unknown> {
    // TODO: Implement using Supabase and database constraints.
    throw new NotImplementedException('rateDriver is awaiting implementation.');
  }

  /** Allow patients to set, update or remove a preferred driver; caregivers cannot do this. */
  async setDriverPreference(scope: PatientScope, driverId: string | null): Promise<unknown> {
    // TODO: Implement using Supabase and database constraints.
    throw new NotImplementedException('setDriverPreference is awaiting implementation.');
  }

  /** After approved changes, notify only affected authorised recipients and record delivery state. */
  async notifyAffectedUsers(tripId: string): Promise<unknown> {
    // TODO: Implement using Supabase and database constraints.
    throw new NotImplementedException('notifyAffectedUsers is awaiting implementation.');
  }

}
