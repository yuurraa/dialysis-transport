import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { SupabaseService } from '../supabase.module';
import { patientInput } from '../profiles/patient-input';
import type { UserRole } from '../types';

interface Account {
  id: string;
  auth_user_id: string | null;
  email: string;
  display_name: string;
  full_name?: string | null;
  role: UserRole;
  status: 'active' | 'inactive';
  profile_complete?: boolean;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  constructor(@Inject(SupabaseService) private readonly database: SupabaseService) {}

  /** Identity and current database permissions are separate; Google metadata never assigns roles. */
  async verifyIdentity(token: string) {
    const client = this.database.forUser(token);
    const { data, error } = await client.auth.getUser(token);
    if (error && (!error.status || error.status === 408 || error.status === 429 || error.status >= 500)) {
      this.logger.warn(`Identity verification unavailable: status=${error.status ?? 'unknown'}`);
      throw new ServiceUnavailableException('Sign-in service is temporarily unavailable. Please try again.');
    }
    if (error || !data.user) {
      // Provider codes help diagnose rejected sessions without logging tokens or personal data.
      this.logger.warn(`Sign-in rejected: code=${error?.code ?? 'user_unavailable'}, status=${error?.status ?? 'unknown'}`);
      throw new UnauthorizedException('Invalid or expired sign-in.');
    }
    if (!data.user.email_confirmed_at || !data.user.identities?.some(identity => identity.provider === 'google')) {
      throw new ForbiddenException('A verified Google account is required.');
    }
    const result = await client.rpc('current_account');
    this.checkDatabaseError(result.error);
    return { id: data.user.id, email: data.user.email, account: result.data as Account | null };
  }

  async register(token: string, body: unknown) {
    const input = this.input(body, ['role', 'displayName', 'profile']);
    if (typeof input.role !== 'string' || !['patient', 'caregiver', 'driver'].includes(input.role) || typeof input.displayName !== 'string'
      || !input.displayName.trim() || input.displayName.trim().length > 100) {
      throw new BadRequestException('Choose a valid role and enter a name of up to 100 characters.');
    }
    await this.verifyIdentity(token);
    let profile;
    if (input.role === 'patient') {
      profile = patientInput(input.profile, false);
      if (!('postal_code' in profile)) throw new BadRequestException('Complete the patient address.');
    } else if ('profile' in input) throw new BadRequestException('Patient details require the patient role.');
    const result = input.role === 'patient'
      ? await this.database.forUser(token).rpc('register_patient_account', { requested_name: input.displayName.trim(), details: profile })
      : await this.database.forUser(token).rpc('register_account', { requested_role: input.role, requested_name: input.displayName.trim() });
    this.checkDatabaseError(result.error);
    return result.data as Account;
  }

  private input(body: unknown, allowed: string[]): Record<string, unknown> {
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some(key => !allowed.includes(key))) {
      throw new BadRequestException('Invalid account request.');
    }
    return body as Record<string, unknown>;
  }

  private checkDatabaseError(error: { code?: string } | null) {
    if (!error) return;
    if (error.code === '23505') throw new ConflictException('This Google account is already registered.');
    if (['22023', '23514', '23502', '22P02'].includes(error.code ?? '')) throw new BadRequestException('Invalid account request.');
    if (error.code === '42501') throw new ForbiddenException('Account access denied.');
    throw new ServiceUnavailableException('Account service is unavailable. Please try again.');
  }
}
