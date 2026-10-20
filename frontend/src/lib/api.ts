import { supabase } from './supabase';

export class ApiError extends Error {
  constructor(readonly status: number) {
    super(`Request failed (${status}).`);
  }
}

/** Send the current identity to NestJS; protected workflows belong on the backend. */
export function apiGet<T>(path: string, accessToken?: string): Promise<T> {
  return apiRequest<T>(path, 'GET', undefined, accessToken);
}

export async function apiRequest<T>(path: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', body?: unknown, accessToken?: string): Promise<T> {
  const token = accessToken ?? (supabase ? (await supabase.auth.getSession()).data.session?.access_token : undefined);
  const origin = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`${origin}/api${path}`, {
      method,
      signal: controller.signal,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new ApiError(response.status);
    // Keep the deadline active until the body is read, not just until headers arrive.
    return await response.json() as T;
  } finally {
    window.clearTimeout(timeout);
  }
}
