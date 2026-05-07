'use client';

import { useEffect } from 'react';
import { initTauriBridge } from '@/lib/supabase';

/**
 * Mounts the Supabase ↔ Tauri auth bridge for the lifetime of the app.
 *
 * - Listens for SIGNED_IN / TOKEN_REFRESHED / INITIAL_SESSION and pushes the
 *   fresh access_token to the Tauri Rust core via `set_atlas_auth_token`.
 * - Listens for SIGNED_OUT and clears the Rust core's cached token.
 * - Runs a 60s defensive poll that force-refreshes if the JWT is < 5 min
 *   from expiry, in case Supabase's internal scheduler is paused (the
 *   webview has been backgrounded, etc.).
 *
 * Renders nothing. Mounted once from the root layout so every page benefits.
 */
export function TauriAuthBridge() {
  useEffect(() => {
    const cleanup = initTauriBridge();
    return cleanup;
  }, []);
  return null;
}
