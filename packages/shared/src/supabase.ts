import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../types/db';

/**
 * The only place either app constructs a Supabase client.
 *
 * It reads `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` and nothing
 * else. The publishable key is safe in the bundle — RLS is what gates it. The
 * secret key bypasses RLS and lives in Edge Functions and local scripts only;
 * it carries no `VITE_` prefix precisely so a bundler cannot reach it, and
 * nothing under `/apps` or `/packages` may reference it.
 */
export type ChopChopClient = SupabaseClient<Database>;

let client: ChopChopClient | undefined;

/**
 * The project URL on its own.
 *
 * Image paths are stored, not URLs, so both apps derive a public URL at render
 * time — a project ref change must not invalidate every row. `publicImageUrl`
 * is pure and takes the base as an argument so it stays testable; this is where
 * components get that argument.
 */
export function getSupabaseUrl(): string {
  const url = import.meta.env.VITE_SUPABASE_URL;
  if (!url) throw new Error('Missing VITE_SUPABASE_URL.');
  return url;
}

export function getSupabaseClient(): ChopChopClient {
  if (client) return client;

  const url = import.meta.env.VITE_SUPABASE_URL;
  const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

  if (!url || !publishableKey) {
    throw new Error(
      'Missing VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY. Both live in ' +
        'the repo-root .env; the Vite configs point envDir at it.',
    );
  }

  client = createClient<Database>(url, publishableKey, {
    auth: {
      // Sellers stay signed in across reloads; buyers' anonymous sessions
      // persist on the device for the same reason.
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  });

  return client;
}
