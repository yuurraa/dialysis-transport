import { AuthService } from '../auth/auth.service';
import { SupabaseService } from '../supabase.module';
import { treatmentInput } from './treatment-input';
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, NotImplementedException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { PatientScope, AvailabilityInput, TreatmentSlotInput, AssignmentInput } from '../types';

/** UC-03, UC-03.1, UC-06 and UC-07: schedules, matching and availability. */
@Injectable()
export class SchedulingService {
  constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(SupabaseService) private readonly database: SupabaseService) {}

  private async access(header?: string, write = false, changingExisting = false) {
    const token = header?.match(/^Bearer (\S+)$/i)?.[1];
    if (!token) throw new UnauthorizedException('Sign-in required.');
    const { account } = await this.auth.verifyIdentity(token);
    if (!account || account.status !== 'active' || !(write ? ['patient','caregiver'] : ['patient','caregiver','coordinator']).includes(account.role)) throw new ForbiddenException('Treatment access denied.');
    if (changingExisting) throw new ForbiddenException('Changes to existing treatment schedules require coordinator approval.');
    return { client: this.database.forUser(token), account };
  }

  private check(error: { code?: string } | null) {
    if (!error) return;
    if (error.code === 'P0002') throw new NotFoundException('Treatment schedule or request not found.');
    if (error.code === '40001') throw new ConflictException('Schedule changed. Reload before trying again.');
    if (error.code === '42501') throw new ForbiddenException('Treatment access denied.');
    if (error.code === '23P01') throw new BadRequestException('Treatment sessions overlap.');
    if (['23503', '23514', '22P02', '22023', '23505', '22007', '22008'].includes(error.code ?? '')) throw new BadRequestException('Invalid treatment schedule.');
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

  /** Coordinator-only preference; generation and version checks are atomic in PostgreSQL. */
  async setAutoGeneration(header: string | undefined, id: string, body: unknown) {
    const { client, account } = await this.access(header);
    if (account.role !== 'coordinator') throw new ForbiddenException('Treatment access denied.');
    if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id) || !body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some(key => !['enabled', 'version', 'setting_version'].includes(key))) throw new BadRequestException('Invalid generation setting.');
    const { enabled, setting_version } = body as Record<string, unknown>;
    const version = this.version(body);
    if (typeof enabled !== 'boolean' || !Number.isSafeInteger(setting_version) || (setting_version as number) < 0 || (setting_version as number) > 2147483647) throw new BadRequestException('Invalid generation setting.');
    const result = await client.rpc('set_treatment_auto_generation', { target: id, enabled, expected_version: version, expected_setting_version: setting_version });
    if (result.error?.code === 'P0002') throw new NotFoundException('Treatment schedule not found.');
    this.check(result.error);
    return result.data;
  }

  private target(id: string) {
    if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) throw new BadRequestException('Invalid schedule or request.');
  }

  async requestChange(header: string | undefined, id: string, body: unknown) {
    const { client } = await this.access(header, true);
    this.target(id);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['action','details','original_date','reason','version'].includes(key))) throw new BadRequestException('Invalid change request.');
    const input = body as Record<string, unknown>;
    const version = this.version(body);
    if (!['update','reschedule','delete'].includes(input.action as string) || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 1000) throw new BadRequestException('Choose a change and give a reason.');
    let proposal = {};
    if (input.action === 'delete') {
      if (input.details !== undefined || input.original_date !== undefined) throw new BadRequestException('Deletion does not accept replacement details.');
    } else {
      const parsed = treatmentInput(input.details);
      if (parsed.replaces_schedule_id || parsed.replaces_date || (input.action === 'reschedule' && parsed.kind !== 'single')) throw new BadRequestException('Invalid treatment proposal.');
      proposal = parsed;
      if (input.action === 'reschedule') {
        const date = input.original_date;
        if (typeof date !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0,10) !== date) throw new BadRequestException('Choose a valid original session date.');
      } else if (input.original_date !== undefined) throw new BadRequestException('Only rescheduling accepts an original date.');
    }
    const result = await client.rpc('request_treatment_change', { target: id, operation: input.action, proposal, original_day: input.original_date ?? null, reason: input.reason.trim(), expected_version: version });
    this.check(result.error);
    return result.data;
  }

  async changeRequest(header: string | undefined, id: string) {
    const { client } = await this.access(header);
    this.target(id);
    const result = await client.rpc('get_treatment_change_request', { target: id });
    this.check(result.error);
    return result.data;
  }

  async reviewChange(header: string | undefined, id: string, body: unknown) {
    const { client, account } = await this.access(header);
    if (account.role !== 'coordinator') throw new ForbiddenException('Coordinator access required.');
    this.target(id);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['decision','note','version','assignment_token'].includes(key))) throw new BadRequestException('Invalid review.');
    const input = body as Record<string, unknown>;
    const version = this.version(body);
    const note = input.note ?? '';
    if (!['approved','rejected'].includes(input.decision as string) || typeof note !== 'string' || note.length>1000 || (input.decision==='rejected' && !note.trim())) throw new BadRequestException('Choose a decision and provide a rejection reason.');
    if (input.assignment_token !== undefined && (typeof input.assignment_token !== 'string' || !/^[a-f0-9]{32}$/.test(input.assignment_token))) throw new BadRequestException('Invalid assignment confirmation.');
    const result = await client.rpc('review_treatment_change', { target: id, decision: input.decision, note: note.trim(), expected_version: version, assignment_token: input.assignment_token ?? null });
    this.check(result.error);
    return result.data;
  }

  async assignmentImpact(header: string | undefined, id: string) {
    const { client, account } = await this.access(header);
    if (account.role !== 'coordinator') throw new ForbiddenException('Coordinator access required.');
    this.target(id);
    const result = await client.rpc('treatment_assignment_impact', { target: id });
    this.check(result.error);
    return result.data;
  }

  async withdrawChange(header: string | undefined, id: string, body: unknown) {
    const { client } = await this.access(header, true);
    this.target(id);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'version')) throw new BadRequestException('Invalid withdrawal.');
    const version = this.version(body);
    const result = await client.rpc('withdraw_treatment_change', { target: id, expected_version: version });
    this.check(result.error);
    return result.data;
  }

  async saveTreatment(header: string | undefined, body: unknown, id?: string) {
    const { client, account } = await this.access(header, true, Boolean(id));
    if (id) throw new ForbiddenException('Changes to existing treatment schedules require coordinator approval.');
    const caregiver=account.role==='caregiver';
    if(caregiver&&(!body||typeof body!=='object'||Array.isArray(body)))throw new BadRequestException('Choose a linked patient.');
    const {patient_id:requestedPatient,...fields}=caregiver?body as Record<string,unknown>:{};
    if(caregiver&&(typeof requestedPatient!=='string'||!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(requestedPatient)))throw new BadRequestException('Choose a linked patient.');
    const details = treatmentInput(caregiver?fields:body);
    if (details.replaces_schedule_id) throw new ForbiddenException('Rescheduling requires coordinator approval.');
    let patientId=requestedPatient;
    if(!caregiver){
      const patient = await client.from('patients').select('id').eq('account_id', account.id).eq('status', 'active').maybeSingle();
      this.check(patient.error);
      if (!patient.data) throw new ForbiddenException('An active Patient profile is required.');
      patientId=patient.data.id;
    }
    // RLS and the locked overlap trigger recheck the live link; no patient profile read is granted.
    const result = await client.from('treatment_schedules').insert({ ...details, patient_id: patientId }).select('*').maybeSingle();
    this.check(result.error);
    if (!result.data) throw new NotFoundException('Treatment schedule not found.');
    return result.data;
  }

  async deleteTreatment(header: string | undefined, _id: string, _body?: unknown) {
    await this.access(header, true, true);
    throw new ForbiddenException('Deleting a treatment schedule requires coordinator approval.');
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
