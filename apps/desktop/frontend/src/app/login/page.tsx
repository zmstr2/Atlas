'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  getSession,
  signInWithOtp,
  signInWithPassword,
  signUp,
} from '@/lib/supabase';

type Mode = 'password' | 'magic' | 'signup';

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [magicSent, setMagicSent] = useState(false);

  // If the user is already signed in, bounce them to /.
  useEffect(() => {
    let alive = true;
    getSession().then((session) => {
      if (alive && session) router.replace('/');
    });
    return () => {
      alive = false;
    };
  }, [router]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMagicSent(false);

    if (!email.trim()) {
      setError('Email is required.');
      return;
    }
    if (mode !== 'magic' && !password) {
      setError('Password is required.');
      return;
    }

    setSubmitting(true);
    try {
      if (mode === 'password') {
        const { error: err } = await signInWithPassword(email.trim(), password);
        if (err) throw err;
        router.replace('/');
      } else if (mode === 'signup') {
        const { error: err } = await signUp(email.trim(), password);
        if (err) throw err;
        // Supabase may require email confirmation depending on project config.
        setMagicSent(true);
      } else {
        const { error: err } = await signInWithOtp(email.trim());
        if (err) throw err;
        setMagicSent(true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  const title =
    mode === 'signup'
      ? 'Create your Atlas account'
      : mode === 'magic'
        ? 'Sign in with magic link'
        : 'Sign in to Atlas';

  return (
    <main className="min-h-screen bg-bg-base text-fg-primary flex items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="font-display text-4xl mb-2">Atlas</h1>
          <p className="text-fg-secondary text-sm">{title}</p>
        </div>

        {magicSent ? (
          <div className="bg-bg-elevated border border-border rounded-md p-6 text-center">
            <p className="text-sm text-fg-primary mb-2">Check your email.</p>
            <p className="text-xs text-fg-muted">
              We sent a sign-in link to {email}. Open it on this computer to
              continue.
            </p>
            <button
              type="button"
              onClick={() => {
                setMagicSent(false);
                setMode('password');
              }}
              className="mt-4 text-xs text-accent hover:underline"
            >
              Use password instead
            </button>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            <Field label="Email">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                className="input"
                autoFocus
                autoComplete="email"
                disabled={submitting}
              />
            </Field>

            {mode !== 'magic' && (
              <Field label="Password">
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="input"
                  autoComplete={
                    mode === 'signup' ? 'new-password' : 'current-password'
                  }
                  disabled={submitting}
                />
              </Field>
            )}

            {error && (
              <div className="bg-signal-negative/10 border border-signal-negative/30 rounded-md p-3 text-sm text-signal-negative">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full px-4 py-3 bg-accent text-white rounded-md hover:bg-accent-hover transition-colors text-sm font-medium disabled:opacity-50"
            >
              {submitting
                ? 'Working…'
                : mode === 'signup'
                  ? 'Create account'
                  : mode === 'magic'
                    ? 'Send magic link'
                    : 'Sign in'}
            </button>

            <div className="flex items-center justify-between text-xs text-fg-muted pt-2">
              {mode === 'password' && (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      setMode('magic');
                      setError(null);
                    }}
                    className="hover:text-fg-secondary"
                  >
                    Sign in with magic link
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setMode('signup');
                      setError(null);
                    }}
                    className="hover:text-fg-secondary"
                  >
                    Don&apos;t have an account? Sign up
                  </button>
                </>
              )}
              {mode === 'magic' && (
                <button
                  type="button"
                  onClick={() => {
                    setMode('password');
                    setError(null);
                  }}
                  className="hover:text-fg-secondary"
                >
                  Use password instead
                </button>
              )}
              {mode === 'signup' && (
                <button
                  type="button"
                  onClick={() => {
                    setMode('password');
                    setError(null);
                  }}
                  className="hover:text-fg-secondary"
                >
                  Already have an account? Sign in
                </button>
              )}
            </div>
          </form>
        )}
      </div>

      <style jsx global>{`
        .input {
          @apply w-full bg-bg-elevated border border-border rounded-md px-3 py-2 text-sm text-fg-primary placeholder:text-fg-muted focus:outline-none focus:border-accent disabled:opacity-50;
        }
      `}</style>
    </main>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-xs font-semibold uppercase tracking-[0.14em] text-fg-muted mb-1.5">
        {label}
      </span>
      {children}
    </label>
  );
}
