import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

// A signup account change uses its own PKCE verifier and temporary session.
export const signupSelectionKey = 'dialysis-signup-draft';
export function hasSignupSelection() {
  try { return sessionStorage.getItem(signupSelectionKey) !== null; }
  catch { return false; }
}

/** Public browser client for sign-in and later authorised realtime subscriptions. */
export const supabase = url && key ? createClient(url, key, {
  auth: { flowType: 'pkce', detectSessionInUrl: !hasSignupSelection(), persistSession: true, autoRefreshToken: true },
}) : null;
