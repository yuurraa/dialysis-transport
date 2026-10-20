import { createClient } from '@supabase/supabase-js';
import { apiGet } from './api';
import { signupSelectionKey, supabase } from './supabase';

export interface SignupDraft { username: string; role: string }
const selectionStorageKey = 'dialysis-signup-google-selection';
let picker: ReturnType<typeof createClient> | undefined;
let completion: Promise<{ draft?: SignupDraft; notice?: string }> | undefined;

function selectionClient() {
  return picker ??= createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY, {
    auth: { flowType: 'pkce', storage: sessionStorage, storageKey: selectionStorageKey,
      persistSession: true, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

function clearSelection() {
  sessionStorage.removeItem(signupSelectionKey);
  for (const key of Object.keys(sessionStorage)) {
    if (key.startsWith(selectionStorageKey)) sessionStorage.removeItem(key);
  }
}

export async function startGoogleAccountSelection(draft: SignupDraft) {
  clearSelection();
  completion = undefined;
  sessionStorage.setItem(signupSelectionKey, JSON.stringify(draft));
  try {
    const { error } = await selectionClient().auth.signInWithOAuth({ provider: 'google', options: {
      redirectTo: new URL('/auth/callback', window.location.origin).href,
      queryParams: { prompt: 'select_account' },
    } });
    if (error) throw error;
  } catch (error) {
    clearSelection();
    throw error;
  }
}

// Share one completion across React StrictMode effects; PKCE codes can only be exchanged once.
export function completeGoogleAccountSelection() {
  return completion ??= (async () => {
    let draft: SignupDraft | undefined;
    let cancelled = false;
    // A later logout owns the sign-in state, even if selection requests finish afterwards.
    const { data: { subscription } } = supabase!.auth.onAuthStateChange(event => {
      if (event === 'SIGNED_OUT') cancelled = true;
    });
    try {
      const saved = JSON.parse(sessionStorage.getItem(signupSelectionKey) ?? 'null');
      if (saved && typeof saved.username === 'string' && typeof saved.role === 'string') {
        draft = { username: saved.username.slice(0, 100), role: ['patient', 'caregiver', 'driver'].includes(saved.role) ? saved.role : '' };
      }
      const previous = await supabase!.auth.getSession();
      const params = new URLSearchParams(window.location.search);
      if (previous.error || !previous.data.session || params.has('error') || !params.get('code')) throw new Error('Selection interrupted.');
      const { data, error } = await selectionClient().auth.exchangeCodeForSession(params.get('code')!);
      if (cancelled) return { draft };
      if (error || !data.session) throw new Error('Selection failed.');
      // Check the candidate identity on the backend without replacing the current sign-in.
      const result = await apiGet<{ account: unknown | null }>('/auth/me', data.session.access_token);
      if (cancelled) return { draft };
      if (!Object.hasOwn(result, 'account')) throw new Error('Account lookup failed.');
      if (result.account !== null) return { draft, notice: 'Google account already in use' };
      const selected = await supabase!.auth.setSession({ access_token: data.session.access_token, refresh_token: data.session.refresh_token });
      if (cancelled) {
        // setSession validates over the network, so logout can also arrive during activation.
        await supabase!.auth.signOut({ scope: 'local' });
        return { draft };
      }
      if (selected.error || !selected.data.session) throw new Error('Unable to select account.');
      return { draft };
    } catch {
      return cancelled ? { draft } : { draft, notice: 'Unable to change Google account. Please try again.' };
    } finally {
      subscription.unsubscribe();
      clearSelection();
    }
  })();
}
