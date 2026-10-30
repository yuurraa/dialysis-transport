import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { AuthService } from '../../auth/auth.service';
import { SupabaseService } from '../../infrastructure/database/supabase.module';

/** Availability belongs to the signed-in approved driver; RPCs repeat authorization under row locks. */
@Injectable()
export class AvailabilityService {
  constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(SupabaseService) private readonly database: SupabaseService) {}

  private async client(header?: string) {
    const token = header?.match(/^Bearer (\S+)$/i)?.[1];
    if (!token) throw new UnauthorizedException('Sign-in required.');
    const { account } = await this.auth.verifyIdentity(token);
    if (account?.role !== 'driver' || account.status !== 'active') throw new ForbiddenException('Driver access required.');
    return this.database.forUser(token);
  }

  private check(error: { code?: string } | null) {
    if (!error) return;
    if (error.code === 'P0001') throw new BadRequestException({code:'availability_booked',message:'Assigned times must stay available until a coordinator unassigns the trip.'});
    if (error.code === '42501') throw new ForbiddenException('An approved vehicle is required.');
    if (['PT409', '40001'].includes(error.code ?? '')) throw new ConflictException({ code: 'availability_conflict', message: 'Availability changed. Reload before saving.' });
    if (['22023', '22007', '22008', '22P02', '23514'].includes(error.code ?? '')) throw new BadRequestException('Check the availability slots.');
    throw new ServiceUnavailableException('Availability is unavailable. Please try again.');
  }

  async get(header?: string) {
    const client = await this.client(header);
    const result = await client.rpc('get_my_availability');
    this.check(result.error); return result.data;
  }

  async save(header: string | undefined, body: unknown) {
    const client = await this.client(header);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('Invalid availability.');
    const input = body as Record<string, unknown>;
    if (Object.keys(input).some(key => !['weekly_slots', 'version', 'week_start', 'template_version'].includes(key))
      || !Number.isSafeInteger(input.version) || (input.version as number) < 0 || (input.version as number) > 2147483646
      || !Array.isArray(input.weekly_slots) || input.weekly_slots.length > 336
      || input.weekly_slots.some(slot => !Number.isInteger(slot) || slot < 0 || slot > 335)
      || new Set(input.weekly_slots).size !== input.weekly_slots.length) throw new BadRequestException('Invalid availability.');
    const perWeek = input.week_start !== undefined;
    if (perWeek && (typeof input.week_start !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(input.week_start)
      || !Number.isFinite(Date.parse(`${input.week_start}T00:00:00Z`)) || new Date(`${input.week_start}T00:00:00Z`).toISOString().slice(0,10)!==input.week_start
      || new Date(`${input.week_start}T00:00:00Z`).getUTCDay()!==1 || !Number.isSafeInteger(input.template_version) || (input.template_version as number)<0 || (input.template_version as number)>2147483647)) throw new BadRequestException('Check the availability week.');
    if (!perWeek && input.template_version !== undefined) throw new BadRequestException('A week is required.');
    const result = perWeek ? await client.rpc('save_my_week_availability', {target_week:input.week_start,slots:input.weekly_slots,expected_version:input.version,expected_template_version:input.template_version})
      : await client.rpc('save_my_availability', { slots: input.weekly_slots, expected_version: input.version });
    this.check(result.error); return result.data;
  }
}
