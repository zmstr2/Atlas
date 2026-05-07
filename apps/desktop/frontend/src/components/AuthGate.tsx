'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getSession, onAuthStateChange } from '@/lib/supabase';

type GateState = 'checking' | 'authed' | 'unauthed';

/**
 * Wraps protected pages. While the auth state is unknown we show a spinner.
 * If the user signs out (in this window or another) we redirect to /login.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [state, setState] = useState<GateState>('checking');

  useEffect(() => {
    let alive = true;

    getSession().then((session) => {
      if (!alive) return;
      if (session) {
        setState('authed');
      } else {
        setState('unauthed');
        router.replace('/login');
      }
    });

    const unsubscribe = onAuthStateChange((session) => {
      if (!alive) return;
      if (session) {
        setState('authed');
      } else {
        setState('unauthed');
        router.replace('/login');
      }
    });

    return () => {
      alive = false;
      unsubscribe();
    };
  }, [router]);

  if (state !== 'authed') {
    return (
      <main className="min-h-screen flex items-center justify-center bg-bg-base text-fg-muted text-sm">
        Loading…
      </main>
    );
  }

  return <>{children}</>;
}
