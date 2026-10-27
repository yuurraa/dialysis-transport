import { supabase } from './supabase';
import { demoSessionEvent, getDemoSession } from './demoSession';

export class ApiError extends Error {
  constructor(readonly status: number, readonly code?: string) {
    super(`Request failed (${status}).`);
  }
}

/** Send the current identity to NestJS; protected workflows belong on the backend. */
export function apiGet<T>(path: string, accessToken?: string): Promise<T> {
  return apiRequest<T>(path, 'GET', undefined, accessToken);
}

export async function apiRequest<T>(path: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', body?: unknown, accessToken?: string): Promise<T> {
  const identity=getDemoSession();
  const token = accessToken ?? identity?.access_token ?? (supabase ? (await supabase.auth.getSession()).data.session?.access_token : undefined);
  if(!accessToken&&identity!==getDemoSession())throw new DOMException('Account changed.','AbortError');
  const origin = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');
  const controller = new AbortController();
  const changed=()=>controller.abort();
  window.addEventListener(demoSessionEvent,changed);
  const timeout = window.setTimeout(() => controller.abort(), path==='/demo/setup'?60000:15000);
  try {
    const response = await fetch(`${origin}/api${path}`, {
      method,
      cache: 'no-store',
      signal: controller.signal,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      // Only expose a bounded machine code. Screens supply their own user-facing messages.
      const details: unknown = await response.json().catch(() => null);
      const code = details && typeof details === 'object' && 'code' in details
        && typeof details.code === 'string' && /^[a-z_]{1,64}$/.test(details.code) ? details.code : undefined;
      throw new ApiError(response.status, code);
    }
    // Keep the deadline active until the body is read, not just until headers arrive.
    return await response.json() as T;
  } finally {
    window.clearTimeout(timeout);
    window.removeEventListener(demoSessionEvent,changed);
  }
}
