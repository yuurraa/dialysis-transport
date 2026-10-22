import { AuthService } from '../auth/auth.service';
import { SupabaseService } from '../supabase.module';
import { treatmentInput } from './treatment-input';
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, NotImplementedException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { PatientScope, AvailabilityInput, TreatmentSlotInput, AssignmentInput } from '../types';

/** UC-03, UC-03.1, UC-06 and UC-07: schedules, matching and availability. */
@Injectable()
export class SchedulingService {
  constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(SupabaseService) private readonly database: SupabaseService) {}

  private async access(header?: string, write = false) {
    const token = header?.match(/^Bearer (\S+)$/i)?.[1];
    if (!token) throw new UnauthorizedException('Sign-in required.');
    const { account } = await this.auth.verifyIdentity(token);
    if (!account || account.status !== 'active' || !(write ? ['patient'] : ['patient', 'coordinator']).includes(account.role)) throw new ForbiddenException('Treatment access denied.');
    return { client: this.database.forUser(token), account };
  }

  private check(error: { code?: string } | null) {
    if (!error) return;
    if (error.code === '40001') throw new ConflictException('Schedule changed. Reload before trying again.');
    if (error.code === '42501') throw new ForbiddenException('Treatment access denied.');
    if (error.code === '23P01') throw new BadRequestException('Treatment sessions overlap.');
    if (['23503', '23514', '22P02', '22023', '23505'].includes(error.code ?? '')) throw new BadRequestException('Invalid treatment schedule.');
    throw new ServiceUnavailableException('Treatment schedules are unavailable. Please try again.');
  }

  async treatments(header?: string, requestedPage = '1', search = '', kind = 'all', centre = 'all', sort = 'effective_from', order = 'asc') {
    const { client } = await this.access(header);
    if (typeof requestedPage !== 'string' || !/^\d+$/.test(requestedPage) || !Number.isSafeInteger(Number(requestedPage))
      || Number(requestedPage)<1 || Number(requestedPage)>1000000 || typeof search !== 'string' || search.length>100 || /[\u0000-\u001f\u007f]/.test(search)) throw new BadRequestException('Invalid schedule search.');
    if ((typeof kind !== 'string' || (kind !== 'all' && (kind.split(',').length > 3 || kind.split(',').some(value => !['recurring', 'single', 'rescheduled'].includes(value))))) || typeof centre !== 'string'
      || (centre !== 'all' && !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(centre))
      || !['effective_from', 'start_time', 'patient_name', 'centre_name', 'kind'].includes(sort)
      || !['asc', 'desc'].includes(order)) throw new BadRequestException('Invalid schedule filters or sort.');
    const result = await client.rpc('list_treatments', { search_text: search.trim(), page_no: Number(requestedPage),
      kind_filter: kind, centre_filter: centre.toLowerCase(), sort_by: sort, sort_order: order });
    this.check(result.error);
    return result.data;
  }

  private version(body: unknown): number {
    const value = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string,unknown>).version : undefined;
    if (!Number.isSafeInteger(value) || (value as number)<1 || (value as number)>2147483647) throw new BadRequestException('A valid schedule version is required.');
    return value as number;
  }

  async saveTreatment(header: string | undefined, body: unknown, id?: string) {
    const { client, account } = await this.access(header, true);
    const version = id ? this.version(body) : undefined;
    const details = treatmentInput(id ? Object.fromEntries(Object.entries(body as object).filter(([key]) => key!=='version')) : body);
    if (id && details.replaces_schedule_id) throw new BadRequestException('The original occurrence cannot be changed.');
    if (id && !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) throw new BadRequestException('Invalid schedule.');
    const patient = await client.from('patients').select('id').eq('account_id', account.id).eq('status', 'active').maybeSingle();
    this.check(patient.error);
    if (!patient.data) throw new ForbiddenException('An active Patient profile is required.');
    const result = id ? await client.rpc('update_my_treatment', { target: id, details, expected_version: version })
      : await client.from('treatment_schedules').insert({ ...details, patient_id: patient.data.id }).select('*').maybeSingle();
    this.check(result.error);
    if (!result.data) throw new NotFoundException('Treatment schedule not found.');
    return result.data;
  }

  async deleteTreatment(header: string | undefined, id: string, body?: unknown) {
    const { client } = await this.access(header, true);
    if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) throw new BadRequestException('Invalid schedule.');
    const version = this.version(body);
    if (Object.keys(body as object).some(key => key!=='version')) throw new BadRequestException('Invalid deletion request.');
    const result = await client.rpc('delete_my_treatment', { target: id, expected_version: version });
    this.check(result.error);
    if (!result.data) throw new NotFoundException('Treatment schedule not found.');
    return { id: result.data };
  }

  /** Generate outbound and return journeys with a 15-minute buffer in Asia/Singapore. */
  async createRecurringTrips(scope: PatientScope, slot: TreatmentSlotInput): Promise<unknown> {
    // TODO: Implement using Supabase and database constraints.
    throw new NotImplementedException('createRecurringTrips is awaiting implementation.');
  }

  /** Enforce verified driver availability, travel time, mobility, equipment, capacity and assistance; prefer patient choice before continuity; retain Unfilled trips. */
  async assignResources(scope: PatientScope, input: AssignmentInput): Promise<unknown> {
    // TODO: Implement using Supabase and database constraints.
    throw new NotImplementedException('assignResources is awaiting implementation.');
  }

  /** Allow drivers to update their own valid availability windows. */
  async saveAvailability(scope: PatientScope, input: AvailabilityInput): Promise<unknown> {
    // TODO: Implement using Supabase and database constraints.
    throw new NotImplementedException('saveAvailability is awaiting implementation.');
  }

  /** Require the assigned driver and confirmation; record the disruption and flag the eligible trip At-Risk. */
  async reportUnavailability(scope: PatientScope, tripId: string): Promise<unknown> {
    // TODO: Implement using Supabase and database constraints.
    throw new NotImplementedException('reportUnavailability is awaiting implementation.');
  }

}
