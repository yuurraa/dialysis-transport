import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { AuthService } from '../auth/auth.service';
import { SupabaseService } from '../supabase.module';

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
    if (error.code === '42501') throw new ForbiddenException('An approved vehicle is required.');
    if (error.code === '40001') throw new ConflictException({ code: 'availability_conflict', message: 'Availability changed. Reload before saving.' });
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
    if (Object.keys(input).some(key => !['weekly_slots', 'version'].includes(key))
      || !Number.isSafeInteger(input.version) || (input.version as number) < 0 || (input.version as number) > 2147483646
      || !Array.isArray(input.weekly_slots) || input.weekly_slots.length > 336
      || input.weekly_slots.some(slot => !Number.isInteger(slot) || slot < 0 || slot > 335)
      || new Set(input.weekly_slots).size !== input.weekly_slots.length) throw new BadRequestException('Invalid availability.');
    const result = await client.rpc('save_my_availability', { slots: input.weekly_slots, expected_version: input.version });
    this.check(result.error); return result.data;
  }
}
