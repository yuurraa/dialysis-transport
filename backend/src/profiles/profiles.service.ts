import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, NotImplementedException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { AuthService } from '../auth/auth.service';
import { SupabaseService } from '../supabase.module';
import { driverInput } from './personal-input';
import { patientInput } from './patient-input';
import type { PatientScope } from '../types';

/** UC-02 and UC-02.1: coordinator-managed records and caregiver links. */
@Injectable()
export class ProfilesService {
  constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(SupabaseService) private readonly database: SupabaseService) {}

  private async requireRole(header: string | undefined, role: 'coordinator' | 'patient' | 'driver') {
    const token = header?.match(/^Bearer (\S+)$/i)?.[1];
    if (!token) throw new UnauthorizedException('Sign-in required.');
    const { account } = await this.auth.verifyIdentity(token);
    if (account?.role !== role || account.status !== 'active') throw new ForbiddenException('Account access denied.');
    return { client: this.database.forUser(token), account };
  }

  async ownDriver(header?: string) {
    const { client, account } = await this.requireRole(header, 'driver');
    const result = await client.from('drivers').select('account_id,full_name,phone,birth_date,gender,version').eq('account_id', account.id).maybeSingle();
    this.checkError(result.error);
    return { driver: result.data };
  }

  async completeOwnDriver(header: string | undefined, body: unknown) {
    const { client } = await this.requireRole(header, 'driver');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('Invalid driver details.');
    const { version, ...input } = body as Record<string, unknown>;
    if ('version' in body && (!Number.isSafeInteger(version) || (version as number)<1 || (version as number)>2147483646)) throw new BadRequestException('A valid driver profile version is required.');
    const details = driverInput(input);
    const result = 'version' in body
      ? await client.rpc('update_my_driver', { details, expected_version: version })
      : await client.rpc('save_my_driver', { details });
    this.checkError(result.error);
    return result.data;
  }

  async ownPatient(header?: string) {
    const { client, account } = await this.requireRole(header, 'patient');
    const result = await client.from('patients').select('id,birth_date,gender,full_name,phone,pickup_address,mobility,assistance_required,status,created_at,unit_no,postal_code,notes,version,account_id').eq('account_id', account.id).maybeSingle();
    this.checkError(result.error);
    return { patient: result.data };
  }

  async saveOwnPatient(header: string | undefined, body: unknown) {
    const { client } = await this.requireRole(header, 'patient');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('Invalid profile details.');
    const { version, ...input } = body as Record<string, unknown>;
    if (!Number.isSafeInteger(version) || (version as number) < 1) throw new BadRequestException('Patient version is required.');
    const details = { ...patientInput(input, false), version };
    const result = await client.rpc('save_my_patient', { details });
    this.checkError(result.error);
    return result.data;
  }

  async listPatients(header?: string, requestedPage = '1', search = '', sort = 'created_at', direction = 'desc', status = 'all', mobility = 'all') {
    const { client } = await this.requireRole(header, 'coordinator');
    const page = Number(requestedPage);
    if (typeof requestedPage !== 'string' || !/^\d+$/.test(requestedPage) || !Number.isSafeInteger(page) || page < 1 || page > 1000000) throw new BadRequestException('Invalid page.');
    if (typeof search !== 'string' || search.length > 100 || /[\u0000-\u001f\u007f]/.test(search)
      || !['created_at', 'id', 'full_name', 'phone', 'mobility', 'status'].includes(sort)
      || !['asc', 'desc'].includes(direction) || (typeof status !== 'string' || (status !== 'all' && (status.split(',').length > 2 || status.split(',').some(value => !['active', 'inactive'].includes(value)))))
      || (typeof mobility !== 'string' || (mobility !== 'all' && (mobility.split(',').length > 3 || mobility.split(',').some(value => !['ambulant', 'walking-aid', 'wheelchair'].includes(value)))))) throw new BadRequestException('Invalid search or sort.');
    const pageSize = 10;
    let query = client.from('patients').select('id,birth_date,gender,full_name,phone,pickup_address,mobility,assistance_required,status,created_at,unit_no,postal_code,notes,version', { count: 'exact' });
    const term = search.trim();
    if (term) {
      // Quote the entire PostgREST value and escape literal SQL LIKE characters.
      const pattern = JSON.stringify(`%${term.replace(/[\\%_]/g, '\\$&')}%`);
      const filters = [`full_name.ilike.${pattern}`, `phone.ilike.${pattern}`];
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(term)) filters.push(`id.eq.${term}`);
      query = query.or(filters.join(','));
    }
    if (status !== 'all') query = status.includes(',') ? query.in('status', status.split(',')) : query.eq('status', status);
    if (mobility !== 'all') query = mobility.includes(',') ? query.in('mobility', mobility.split(',')) : query.eq('mobility', mobility);
    query = query.order(sort, { ascending: direction === 'asc' });
    if (sort !== 'id') query = query.order('id', { ascending: true });
    const result = await query.range((page - 1) * pageSize, page * pageSize - 1);
    this.checkError(result.error);
    return { patients: result.data, total: result.count ?? 0, page, pageSize };
  }

  async savePatient(header: string | undefined, body: unknown, id: string) {
    const { client } = await this.requireRole(header, 'coordinator');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new BadRequestException('Invalid patient.');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('Invalid patient update.');
    const input = body as Record<string, unknown>;
    if (!Number.isSafeInteger(input.version) || (input.version as number) < 1 || !('status' in input || 'notes' in input) || Object.keys(input).some(key => !['status', 'notes', 'version'].includes(key))
      || ('status' in input && (typeof input.status !== 'string' || !['active', 'inactive'].includes(input.status)))
      || ('notes' in input && (typeof input.notes !== 'string' || input.notes.length > 1000))) throw new BadRequestException('Only Status and Notes may be updated.');
    const data = { version: input.version, ...('status' in input ? { status: input.status } : {}), ...('notes' in input ? { notes: (input.notes as string).trim() } : {}) };
    const result = await client.rpc('save_patient', { target: id, details: data });
    this.checkError(result.error);
    if (!result.data) throw new NotFoundException('Profile not found.');
    return result.data;
  }

  private checkError(error: { code?: string } | null) {
    if (!error) return;
    if (error.code === '40001') throw new ConflictException('This profile was changed by someone else. Reload before saving.');
    if (error.code === 'P0002') throw new NotFoundException('Profile not found.');
    if (error.code === '42501') throw new ForbiddenException('Profile access denied.');
    if (error.code === '23514' || error.code === '22P02' || error.code === '22023' || error.code === '23502') throw new BadRequestException('Invalid profile details.');
    throw new ServiceUnavailableException('Profile service is unavailable. Please try again.');
  }

  /** Require coordinator access and return only permitted fields. */
  async listRecords(scope: PatientScope, recordType: string): Promise<unknown> {
    // TODO: Implement using Supabase and database constraints.
    throw new NotImplementedException('listRecords is awaiting implementation.');
  }

  /** Validate and create, edit or deactivate a record. */
  async saveRecord(scope: PatientScope, recordType: string, data: unknown): Promise<unknown> {
    // TODO: Implement using Supabase and database constraints.
    throw new NotImplementedException('saveRecord is awaiting implementation.');
  }

  /** Validate active records and prevent duplicate active links. */
  async linkCaregiver(scope: PatientScope, caregiverId: string, patientId: string): Promise<unknown> {
    // TODO: Implement using Supabase and database constraints.
    throw new NotImplementedException('linkCaregiver is awaiting implementation.');
  }

}
