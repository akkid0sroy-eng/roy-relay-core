/**
 * Supabase client singletons for the API server.
 *
 * serviceClient — uses the service-role key, bypasses RLS.
 *   Use for all server-side reads/writes (message processing, integration loading, etc.)
 *
 * anonClient — uses the anon key, subject to RLS.
 *   Use only for auth operations (verifying JWTs, magic-link sign-in).
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

// Lazily initialised so tests can set env vars before first use
let _serviceClient: SupabaseClient | null = null;
let _anonClient: SupabaseClient | null = null;

export function getServiceClient(): SupabaseClient {
  if (!_serviceClient) {
    _serviceClient = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
      { auth: { autoRefreshToken: false, persistSession: false } }
    );
  }
  return _serviceClient;
}

export function getAnonClient(): SupabaseClient {
  if (!_anonClient) {
    _anonClient = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_ANON_KEY")
    );
  }
  return _anonClient;
}

/** Reset singletons — used in tests to swap env vars between test cases. */
export function resetClients(): void {
  _serviceClient = null;
  _anonClient = null;
}
