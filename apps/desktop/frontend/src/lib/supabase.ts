// Supabase Auth client for the Atlas desktop app.
//
// The session is persisted to a Tauri `plugin-store` file (`auth.dat`) which
// the OS encrypts at rest via the OS keychain plumbing Tauri provides. We
// disable Supabase's default localStorage path because the app runs inside a
// webview where localStorage isn't durable across reinstalls/updates and we
// want the JWT under OS-level protection.
//
// In `next dev` (browser, no Tauri runtime) we transparently fall back to
// localStorage so the login flow works during web dev.

import {
  createClient,
  type Session,
  type SupabaseClient,
  type SupportedStorage,
} from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';

const STORE_FILE = 'auth.dat';

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

// Lazy Tauri store handle, cached per-process.
let tauriStorePromise: Promise<{
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: unknown) => Promise<void>;
  delete: (key: string) => Promise<boolean>;
  save: () => Promise<void>;
}> | null = null;

async function getTauriStore() {
  if (!tauriStorePromise) {
    tauriStorePromise = (async () => {
      // Dynamic import — `@tauri-apps/plugin-store` only resolves at runtime
      // inside the Tauri shell. In `next dev` we never reach this branch.
      const mod = await import('@tauri-apps/plugin-store');
      const store = await mod.load(STORE_FILE, { defaults: {}, autoSave: true });
      return {
        get: (key: string) => store.get(key),
        set: (key: string, value: unknown) => store.set(key, value),
        delete: (key: string) => store.delete(key),
        save: () => store.save(),
      };
    })();
  }
  return tauriStorePromise;
}

// Supabase 2.x's `SupportedStorage` interface allows async returns. We adapt
// either Tauri's plugin-store or window.localStorage to the same shape.
const tauriStorage: SupportedStorage = {
  async getItem(key: string): Promise<string | null> {
    try {
      const store = await getTauriStore();
      const value = await store.get(key);
      return typeof value === 'string' ? value : null;
    } catch (err) {
      console.warn('[supabase] tauri store getItem failed', err);
      return null;
    }
  },
  async setItem(key: string, value: string): Promise<void> {
    try {
      const store = await getTauriStore();
      await store.set(key, value);
      await store.save();
    } catch (err) {
      console.warn('[supabase] tauri store setItem failed', err);
    }
  },
  async removeItem(key: string): Promise<void> {
    try {
      const store = await getTauriStore();
      await store.delete(key);
      await store.save();
    } catch (err) {
      console.warn('[supabase] tauri store removeItem failed', err);
    }
  },
};

const browserStorage: SupportedStorage = {
  getItem: (key) =>
    typeof window === 'undefined' ? null : window.localStorage.getItem(key),
  setItem: (key, value) => {
    if (typeof window !== 'undefined') window.localStorage.setItem(key, value);
  },
  removeItem: (key) => {
    if (typeof window !== 'undefined') window.localStorage.removeItem(key);
  },
};

// Pick storage at module load. In SSR we always get browserStorage which
// safely no-ops; the real choice happens once we're hydrated client-side.
const storage: SupportedStorage =
  typeof window !== 'undefined' && isTauri() ? tauriStorage : browserStorage;

// We tolerate empty creds at build time — the login form will just fail at
// submit. This keeps `tsc` and `next build` green even without env vars set.
export const supabase: SupabaseClient = createClient(
  SUPABASE_URL || 'https://invalid.supabase.co',
  SUPABASE_ANON_KEY || 'invalid-anon-key',
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      storage,
      storageKey: 'atlas-auth',
    },
  },
);

// ── Helpers ─────────────────────────────────────────────────────────────────

export async function getSession(): Promise<Session | null> {
  const { data, error } = await supabase.auth.getSession();
  if (error) {
    console.warn('[supabase] getSession failed', error);
    return null;
  }
  return data.session;
}

export async function getAccessToken(): Promise<string | null> {
  const session = await getSession();
  return session?.access_token ?? null;
}

export async function signInWithPassword(email: string, password: string) {
  return supabase.auth.signInWithPassword({ email, password });
}

export async function signInWithOtp(email: string) {
  return supabase.auth.signInWithOtp({ email });
}

export async function signUp(email: string, password: string) {
  return supabase.auth.signUp({ email, password });
}

export async function signOut() {
  return supabase.auth.signOut();
}

export function onAuthStateChange(
  callback: (session: Session | null) => void,
) {
  const { data } = supabase.auth.onAuthStateChange((_event, session) => {
    callback(session);
  });
  return () => data.subscription.unsubscribe();
}

// ── Tauri bridge: keep Rust core's auth token in sync with Supabase JWT ─────
//
// Supabase JS auto-refreshes JWTs ~5 min before expiry on its internal
// scheduler and emits a `TOKEN_REFRESHED` event via `onAuthStateChange`. We
// listen for that and forward the new access_token to the Tauri Rust core
// (via the `set_atlas_auth_token` command) so atlas_bridge POSTs always carry
// a fresh JWT.
//
// We also run a defensive 60s poll: if the next expiry is < 5 min away and
// Supabase hasn't refreshed yet (e.g. webview backgrounded), we force a
// refresh ourselves.
//
// Returns a cleanup function that unsubscribes the auth listener and clears
// the polling interval. Call from a top-level client component on mount.

const REFRESH_GUARD_SECONDS = 300; // 5 min before expiry
const REFRESH_POLL_MS = 60_000;

async function pushTokenToTauri(token: string): Promise<void> {
  if (!isTauri()) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('set_atlas_auth_token', { token });
  } catch (err) {
    console.warn('[supabase] failed to push token to Tauri bridge', err);
  }
}

async function clearTokenInTauri(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('clear_atlas_auth_token');
  } catch (err) {
    console.warn('[supabase] failed to clear Tauri auth token', err);
  }
}

export function initTauriBridge(): () => void {
  // Subscribe to auth state changes. SIGNED_IN / TOKEN_REFRESHED /
  // INITIAL_SESSION all carry a fresh access_token; SIGNED_OUT clears it.
  const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
    switch (event) {
      case 'SIGNED_IN':
      case 'TOKEN_REFRESHED':
      case 'INITIAL_SESSION':
        if (session?.access_token) {
          void pushTokenToTauri(session.access_token);
        }
        break;
      case 'SIGNED_OUT':
        void clearTokenInTauri();
        break;
      default:
        break;
    }
  });

  // Defensive proactive refresh poll. Supabase normally handles this on its
  // own schedule, but Next.js inside a Tauri webview can be backgrounded; we
  // don't want a stale JWT lurking on a long call.
  const interval =
    typeof window === 'undefined'
      ? null
      : window.setInterval(async () => {
          try {
            const { data } = await supabase.auth.getSession();
            const session = data.session;
            if (!session) return;
            const expiresAt = session.expires_at; // unix seconds
            if (!expiresAt) return;
            const now = Math.floor(Date.now() / 1000);
            if (expiresAt - now < REFRESH_GUARD_SECONDS) {
              await supabase.auth.refreshSession();
            }
          } catch (err) {
            console.warn('[supabase] proactive refresh poll failed', err);
          }
        }, REFRESH_POLL_MS);

  return () => {
    sub.subscription.unsubscribe();
    if (interval !== null && typeof window !== 'undefined') {
      window.clearInterval(interval);
    }
  };
}
