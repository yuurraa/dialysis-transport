import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, NotImplementedException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { TripRoutingService } from './trip-routing.service';
import { AuthService } from '../auth/auth.service';
import { SupabaseService } from '../supabase.module';
import type { PatientScope } from '../types';

/** UC-04, UC-05, UC-05.1 and UC-09 to UC-12: operations, recovery and patient actions. */
@Injectable()
export class TripsService {
  constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(SupabaseService) private readonly database: SupabaseService, @Inject(TripRoutingService) private readonly routes: TripRoutingService) {}

  private async access(header?: string, write = false, roles?: string[]) {
    const token = header?.match(/^Bearer (\S+)$/i)?.[1];
    if (!token) throw new UnauthorizedException('Sign-in required.');
    const { account } = await this.auth.verifyIdentity(token);
    if (!account || account.status !== 'active' || !(roles ?? (write ? ['coordinator'] : ['patient', 'coordinator', 'driver'])).includes(account.role)) {
      throw new ForbiddenException('Trip access denied.');
    }
    return this.database.forUser(token);
  }

  private check(error: { code?: string } | null, resource = 'Treatment schedule') {
    if (!error) return;
    if (error.code === '42501') throw new ForbiddenException('Trip access denied.');
    if (error.code === '40001') throw new ConflictException(`${resource} changed. Reload before trying again.`);
    if (['22023', '23514', '22P02', '22007', '22008'].includes(error.code ?? '')) throw new BadRequestException('Invalid trip request.');
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
    const today = this.today();
    const weekday = new Date(`${today}T00:00:00Z`).getUTCDay() || 7;
    const horizon = Date.parse(`${today}T00:00:00Z`) + (28-weekday)*86400000;
    if (end < start || end > horizon) throw new BadRequestException('Choose dates from today through the fourth Sunday.');
  }

  /** Database pagination and patient ownership checks run before returning trip records. */
  async listTrips(header?: string, page = '1', from = this.today(), until?: string, status = 'unfilled,at-risk,on-track', search = '', direction = 'all', sort = 'treatment_start', order = 'asc') {
    const client = await this.access(header);
    const start = this.date(from);
    const end = until === undefined || until === '' ? null : this.date(until);
    if (end !== null && end < start) throw new BadRequestException('End date cannot be before start date.');
    const statuses = typeof status === 'string' ? status.split(',') : [];
    if (typeof page !== 'string' || !/^\d+$/.test(page) || !Number.isSafeInteger(Number(page)) || Number(page) < 1 || Number(page) > 1000000
      || typeof status !== 'string' || statuses.length > 8 || (status !== 'all' && statuses.some(value => !['unfilled', 'at-risk', 'on-track', 'resolved', 'cancelled', 'upcoming', 'in-progress', 'completed'].includes(value)))
      || typeof search !== 'string' || search.length > 100 || /[\u0000-\u001f\u007f]/.test(search)
      || typeof direction !== 'string' || (direction !== 'all' && (direction.split(',').length > 2 || direction.split(',').some(value => !['outbound', 'return'].includes(value))))
      || !['treatment_start', 'pickup_time', 'patient_name', 'direction', 'status'].includes(sort) || !['asc', 'desc'].includes(order)) throw new BadRequestException('Invalid trip filters.');
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

  private assignmentId(id: unknown): asserts id is string {
    if (typeof id !== 'string' || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) throw new BadRequestException('Invalid trip or driver.');
  }

  private pickup(value: unknown, future = true): asserts value is string {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/.test(value) || !Number.isFinite(Date.parse(value))
      || new Date(value).toISOString() !== value || (future && Date.parse(value) <= Date.now())) throw new BadRequestException('Choose an upcoming pickup time.');
  }

  async assignmentOptions(header: string | undefined, id: string, pickupAt: unknown) {
    const client = await this.access(header, true);
    this.assignmentId(id); this.pickup(pickupAt, false);
    await this.routes.prepare(client, id, pickupAt);
    const result = await client.rpc('trip_assignment_options', { target: id, starts: pickupAt });
    this.check(result.error, 'Trip');
    return result.data;
  }

  async assignTrip(header: string | undefined, id: string, body: unknown) {
    const client = await this.access(header, true);
    this.assignmentId(id);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['driver_id','pickup_at','version'].includes(key))) throw new BadRequestException('Invalid assignment.');
    const input = body as Record<string, unknown>;
    this.assignmentId(input.driver_id); this.pickup(input.pickup_at);
    if (!Number.isSafeInteger(input.version) || (input.version as number)<1 || (input.version as number)>2147483647) throw new BadRequestException('A valid trip version is required.');
    await this.routes.prepare(client, id, input.pickup_at, input.version as number);
    const result = await client.rpc('assign_trip', { target: id, driver: input.driver_id, starts: input.pickup_at, expected_version: input.version });
    this.check(result.error, 'Trip');
    return result.data;
  }

  async unassignTrip(header: string | undefined, id: string, body: unknown) {
    const client = await this.access(header, true);
    this.assignmentId(id);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'version')) throw new BadRequestException('Invalid assignment.');
    const version = (body as Record<string, unknown>).version;
    if (!Number.isSafeInteger(version) || (version as number)<1 || (version as number)>2147483647) throw new BadRequestException('A valid trip version is required.');
    const result = await client.rpc('unassign_trip', { target: id, expected_version: version });
    this.check(result.error, 'Trip');
    return result.data;
  }

  async tripRoute(header: string | undefined, id: string) {
    const client = await this.access(header);
    this.assignmentId(id);
    return this.routes.view(client, id);
  }

  /** Current record for stale-overlay recovery; the caller's JWT retains row-level scope. */
  async getTrip(header: string | undefined, id: string) {
    const client = await this.access(header);
    this.assignmentId(id);
    const result = await client.from('trips').select('*').eq('id', id).is('deleted_at', null).maybeSingle();
    this.check(result.error, 'Trip');
    if (!result.data) throw new NotFoundException('Trip not found.');
    return result.data;
  }

  private async tripAction(header: string | undefined, id: string, body: unknown, action: 'confirm' | 'cancel' | 'unavailable' | 'start' | 'complete') {
    const execution = action === 'start' || action === 'complete';
    const client = await this.access(header, false, [action === 'unavailable' || execution ? 'driver' : 'patient']);
    this.assignmentId(id);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'version')) throw new BadRequestException('Invalid trip action.');
    const version = (body as Record<string, unknown>).version;
    if (!Number.isSafeInteger(version) || (version as number) < 1 || (version as number) > 2147483647) throw new BadRequestException('A valid trip version is required.');
    const result = await client.rpc(execution ? 'execute_trip' : action === 'unavailable' ? 'report_driver_unavailability' : `${action}_trip`, { target: id, expected_version: version, ...(execution ? { action } : {}) });
    this.check(result.error, 'Trip');
    return result.data;
  }

  /** Confirmation acknowledges current transport details without changing journey progress. */
  confirmTrip(header: string | undefined, id: string, body: unknown) {
    return this.tripAction(header, id, body, 'confirm');
  }

  /** Cancel one upcoming owned journey; the database releases capacity and records history atomically. */
  cancelTrip(header: string | undefined, id: string, body: unknown) {
    return this.tripAction(header, id, body, 'cancel');
  }

  /** A report retains capacity until the coordinator explicitly resolves the disruption. */
  reportUnavailability(header: string | undefined, id: string, body: unknown) {
    return this.tripAction(header, id, body, 'unavailable');
  }

  executeTrip(header: string | undefined, id: string, body: unknown, action: 'start' | 'complete') {
    return this.tripAction(header, id, body, action);
  }

  async progress(header: string | undefined, id: string) {
    const client = await this.access(header);
    this.assignmentId(id);
    const result = await client.rpc('trip_progress', { target: id });
    this.check(result.error, 'Trip');
    return result.data;
  }

  async beginSharing(header: string | undefined, id: string, body: unknown) {
    const client = await this.access(header, false, ['driver']);
    this.assignmentId(id);
    if (body !== undefined && (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length)) throw new BadRequestException('Invalid sharing action.');
    const result = await client.rpc('begin_trip_sharing', { target: id });
    this.check(result.error, 'Trip');
    return result.data;
  }

  private locationInput(body: unknown, clearing = false) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !(clearing ? ['sharing_id'] : ['sharing_id','latitude','longitude','accuracy_metres','recorded_at']).includes(key))) throw new BadRequestException('Invalid location.');
    const input = body as Record<string,unknown>;
    this.assignmentId(input.sharing_id);
    if (!clearing && (typeof input.latitude !== 'number' || !Number.isFinite(input.latitude) || input.latitude < -90 || input.latitude > 90
      || typeof input.longitude !== 'number' || !Number.isFinite(input.longitude) || input.longitude < -180 || input.longitude > 180
      || typeof input.accuracy_metres !== 'number' || !Number.isFinite(input.accuracy_metres) || input.accuracy_metres < 0 || input.accuracy_metres > 10000
      || typeof input.recorded_at !== 'string' || !Number.isFinite(Date.parse(input.recorded_at)))) throw new BadRequestException('Invalid location.');
    return input;
  }

  async updateLocation(header: string | undefined, id: string, body: unknown) {
    const client = await this.access(header, false, ['driver']);
    this.assignmentId(id);
    const input = this.locationInput(body);
    const result = await client.rpc('report_trip_location', { target: id, session_id: input.sharing_id, latitude: input.latitude, longitude: input.longitude, accuracy_metres: input.accuracy_metres, recorded_at: input.recorded_at });
    this.check(result.error, 'Trip');
    return { ok: true };
  }

  async clearLocation(header: string | undefined, id: string, body: unknown) {
    const client = await this.access(header, false, ['driver']);
    this.assignmentId(id);
    const input = this.locationInput(body, true);
    const result = await client.rpc('clear_trip_location', { target: id, session_id: input.sharing_id });
    this.check(result.error, 'Trip');
    return { ok: true };
  }

  /** Generate/rank feasible pickup, route or resource options within ten seconds; escalate no-option cases as Unfilled-Critical. */
  async assessRecovery(scope: PatientScope, tripId: string): Promise<unknown> {
    // TODO: Implement using Supabase and database constraints.
    throw new NotImplementedException('assessRecovery is awaiting implementation.');
  }

  /** Access is verified before route/traffic provider calls; database reads retain caller RLS. */
  async assessRoute(header:string|undefined,id:string) {
    const client=await this.access(header);
    this.assignmentId(id);
    return this.routes.traffic(client,id);
  }

  /** Require coordinator approval and fresh feasibility; atomically apply changes and history before notifications. */
  async approveRecovery(scope: PatientScope, tripId: string, optionId: string): Promise<unknown> {
    // TODO: Implement using Supabase and database constraints.
    throw new NotImplementedException('approveRecovery is awaiting implementation.');
  }

  private page(value: string) {
    if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value)>1000000) throw new BadRequestException('Invalid page.');
    return Number(value);
  }

  /** Current access is rechecked on every history read, including after unassignment. */
  async getHistory(header: string | undefined, id: string, page = '1') {
    const client = await this.access(header);
    this.assignmentId(id);
    const result = await client.rpc('trip_history_page', { target: id, page_no: this.page(page) });
    this.check(result.error, 'Trip');
    return result.data;
  }

  async listNotifications(header: string | undefined, page = '1') {
    const client = await this.access(header);
    const result = await client.rpc('list_trip_notifications', { page_no: this.page(page) });
    this.check(result.error, 'Notification');
    return result.data;
  }

  async readAllNotifications(header:string|undefined,body:unknown) {
    const client=await this.access(header);
    if(body!==undefined&&(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length))throw new BadRequestException('Invalid notification action.');
    const result=await client.rpc('read_all_trip_notifications');
    this.check(result.error,'Notification');
    return result.data;
  }

  async readNotification(header: string | undefined, id: string, body: unknown) {
    const client = await this.access(header);
    this.assignmentId(id);
    if (body !== undefined && (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length)) throw new BadRequestException('Invalid notification action.');
    const result = await client.rpc('read_trip_notification', { target: id });
    this.check(result.error, 'Notification');
    return result.data;
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
}
