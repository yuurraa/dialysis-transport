import { Global, Injectable, Module, ServiceUnavailableException } from '@nestjs/common';
import { createClient } from '@supabase/supabase-js';

/** One connection factory; user JWTs preserve the identity needed by future RLS policies. */
@Injectable()
export class SupabaseService {
  forUser(accessToken: string) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_PUBLISHABLE_KEY;
    if (!url || !key) throw new ServiceUnavailableException('Supabase is not configured.');
    return createClient(url, key, {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  }
}

@Global()
@Module({ providers: [SupabaseService], exports: [SupabaseService] })
export class SupabaseModule {}
