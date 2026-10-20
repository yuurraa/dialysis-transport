import { AuthService } from '../auth/auth.service';
import { SupabaseService } from '../supabase.module';
import { treatmentInput } from './treatment-input';
import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException, NotImplementedException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
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
    if (error.code === '42501') throw new ForbiddenException('Treatment access denied.');
    if (error.code === '23P01') throw new BadRequestException('Treatment sessions overlap.');
    if (['23503', '23514', '22P02', '22023', '23505'].includes(error.code ?? '')) throw new BadRequestException('Invalid treatment schedule.');
    throw new ServiceUnavailableException('Treatment schedules are unavailable. Please try again.');
  }

  async treatments(header?: string) {
    const { client } = await this.access(header);
    const centres = await client.from('dialysis_centres').select('id,name,address,postal_code').order('name');
    this.check(centres.error);
    const schedules = await client.from('treatment_schedules').select('*,patients!inner(full_name)').order('effective_from').order('id');
    this.check(schedules.error);
    return { centres: centres.data, schedules: schedules.data };
  }

  async saveTreatment(header: string | undefined, body: unknown, id?: string) {
    const { client, account } = await this.access(header, true);
    const details = treatmentInput(body);
    if (id && details.replaces_schedule_id) throw new BadRequestException('The original occurrence cannot be changed.');
    if (id && !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) throw new BadRequestException('Invalid schedule.');
    const patient = await client.from('patients').select('id').eq('account_id', account.id).eq('status', 'active').maybeSingle();
    this.check(patient.error);
    if (!patient.data) throw new ForbiddenException('An active Patient profile is required.');
    const table = client.from('treatment_schedules');
    const result = await (id ? table.update(details).eq('id', id).eq('patient_id', patient.data.id)
      : table.insert({ ...details, patient_id: patient.data.id })).select('*').maybeSingle();
    this.check(result.error);
    if (!result.data) throw new NotFoundException('Treatment schedule not found.');
    return result.data;
  }

  async deleteTreatment(header: string | undefined, id: string) {
    const { client } = await this.access(header, true);
    if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) throw new BadRequestException('Invalid schedule.');
    const result = await client.rpc('delete_my_treatment', { target: id });
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
