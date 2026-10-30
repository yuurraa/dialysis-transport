import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { AuthService } from '../auth/auth.service';
import { SupabaseService } from '../infrastructure/database/supabase.module';

@Injectable()
export class DriversService {
  constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(SupabaseService) private readonly database: SupabaseService) {}

  private async access(header: string | undefined, role: 'driver' | 'coordinator') {
    const token = header?.match(/^Bearer (\S+)$/i)?.[1];
    if (!token) throw new UnauthorizedException('Sign-in required.');
    const { account } = await this.auth.verifyIdentity(token);
    if (!account || account.status !== 'active' || account.role !== role) throw new ForbiddenException('Driver service access denied.');
    return { client: this.database.forUser(token), account };
  }

  private input(body: unknown, keys: string[]) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !keys.includes(key))) throw new BadRequestException('Invalid registration request.');
    return body as Record<string, unknown>;
  }

  private version(value: unknown, optional = false) {
    if (optional && value === null) return null;
    if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 2147483647) throw new BadRequestException('A valid registration version is required.');
    return value as number;
  }

  private check(error: { code?: string } | null) {
    if (!error) return;
    if (error.code === '42501') throw new ForbiddenException('Driver service access denied.');
    if (['PT409', '40001'].includes(error.code ?? '')) throw new ConflictException({ code: 'registration_conflict', message: 'Registration changed. Reload before trying again.' });
    if (error.code === '23505') throw new ConflictException({ code: 'vehicle_plate_conflict', message: 'This vehicle plate is already registered.' });
    if (error.code === 'P0002') throw new NotFoundException('Driver registration not found.');
    if (['22023', '23514', '23502', '22P02'].includes(error.code ?? '')) throw new BadRequestException('Check the registration details and current status.');
    throw new ServiceUnavailableException('Driver registration is unavailable. Please try again.');
  }

  async own(header?: string) {
    const { client, account } = await this.access(header, 'driver');
    const [result,statistics] = await Promise.all([
      client.from('driver_vehicles').select('id,driver_id,licence_number,plate_number,make,model,passenger_capacity,wheelchair_accessible,status,version,submitted_at,reviewed_at,registered_at,review_reason').eq('driver_id', account.id).maybeSingle(),
      client.rpc('my_driver_statistics'),
    ]);
    this.check(result.error);
    this.check(statistics.error);
    return { vehicle: result.data, statistics:statistics.data };
  }

  async availability(header: string | undefined, id: string) {
    const { client } = await this.access(header, 'coordinator');
    if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) throw new BadRequestException('Invalid driver.');
    const result = await client.rpc('get_driver_availability', { target: id });
    this.check(result.error); return result.data;
  }

  async week(header: string | undefined, id: string, start: unknown, own = false) {
    const { client, account } = await this.access(header, own ? 'driver' : 'coordinator');
    if (own) id = account.id;
    if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id) || typeof start !== 'string'
      || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(start) || !Number.isFinite(Date.parse(`${start}T00:00:00Z`))
      || new Date(`${start}T00:00:00Z`).toISOString().slice(0,10)!==start || new Date(`${start}T00:00:00Z`).getUTCDay()!==1) throw new BadRequestException('Choose a valid calendar week.');
    const localToday = new Date(Date.now()+8*3600000).toISOString().slice(0,10);
    const today = Date.parse(`${localToday}T00:00:00Z`);
    const monday = today-((new Date(today).getUTCDay()||7)-1)*86400000;
    const requested = Date.parse(`${start}T00:00:00Z`);
    if (requested<monday || requested>monday+21*86400000) throw new BadRequestException('Choose a week within the four-week planning window.');
    const result = await client.rpc('get_driver_week', { target:id, week_start:start });
    this.check(result.error); return result.data;
  }

  async submit(header: string | undefined, body: unknown) {
    const { client } = await this.access(header, 'driver');
    const input = this.input(body, ['licence_number', 'plate_number', 'make', 'model', 'passenger_capacity', 'wheelchair_accessible', 'version']);
    const version = this.version(input.version, true);
    const details: Record<string, unknown> = {};
    for (const [key, limit] of [['licence_number', 50], ['plate_number', 20], ['make', 60], ['model', 60]] as const) {
      if (typeof input[key] !== 'string' || !(input[key] as string).trim() || (input[key] as string).trim().length > limit) throw new BadRequestException('Complete the licence and vehicle details.');
      details[key] = (input[key] as string).trim();
    }
    if (!Number.isInteger(input.passenger_capacity) || (input.passenger_capacity as number) < 1 || (input.passenger_capacity as number) > 12 || typeof input.wheelchair_accessible !== 'boolean') throw new BadRequestException('Check passenger capacity and wheelchair accessibility.');
    details.passenger_capacity = input.passenger_capacity; details.wheelchair_accessible = input.wheelchair_accessible;
    const result = await client.rpc('submit_driver_vehicle', { details, expected_version: version });
    this.check(result.error); return result.data;
  }

  async list(header?: string, page = '1', search = '', status = 'all', sort = 'created_at', direction = 'desc') {
    const { client } = await this.access(header, 'coordinator');
    if (typeof page !== 'string' || !/^\d+$/.test(page) || !Number.isSafeInteger(Number(page)) || Number(page) < 1 || Number(page) > 1000000
      || typeof search !== 'string' || search.length > 100 || /[\u0000-\u001f\u007f]/.test(search)
      || typeof status !== 'string' || !['all', 'not-submitted', 'pending', 'approved', 'rejected'].includes(status)
      || !['created_at', 'id', 'full_name', 'phone', 'plate_number', 'status'].includes(sort) || !['asc', 'desc'].includes(direction)) throw new BadRequestException('Invalid driver filters.');
    const result = await client.rpc('list_drivers', { page_no: Number(page), search_text: search.trim(), status_filter: status, sort_by: sort, sort_order: direction });
    this.check(result.error); return result.data;
  }

  async updateStatus(header: string | undefined, id: string, body: unknown) {
    const { client } = await this.access(header, 'coordinator');
    const input = this.input(body, ['status', 'version']);
    const version = this.version(input.version);
    if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)
      || typeof input.status !== 'string' || !['active', 'inactive'].includes(input.status)) throw new BadRequestException('Choose Active or Inactive for the driver status.');
    const result = await client.rpc('save_driver_status', { target: id, expected_version: version, new_status: input.status });
    this.check(result.error); return result.data;
  }

  async review(header: string | undefined, id: string, body: unknown) {
    const { client } = await this.access(header, 'coordinator');
    const input = this.input(body, ['version', 'decision', 'reason']);
    const version = this.version(input.version);
    if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id) || !['approved', 'rejected'].includes(String(input.decision))
      || typeof input.decision !== 'string' || typeof input.reason !== 'string' || input.reason.length > 1000 || (input.decision === 'rejected' && !input.reason.trim())) throw new BadRequestException('Choose a decision and provide a reason for rejection.');
    const result = await client.rpc('review_driver_vehicle', { target: id, expected_version: version, decision: input.decision, reason: input.reason.trim() });
    this.check(result.error); return result.data;
  }
}
