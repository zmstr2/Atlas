'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { listCalls, type CallSummary } from '@/lib/agent';

export default function HomePage() {
  const [calls, setCalls] = useState<CallSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listCalls()
      .then((res) => setCalls(res.calls))
      .catch((err) => setError(err.message));
  }, []);

  return (
    <main className="min-h-screen bg-bg-base text-fg-primary">
      <div className="max-w-3xl mx-auto px-6 py-12">
        <header className="flex items-end justify-between mb-10">
          <div>
            <h1 className="font-display text-4xl mb-2">Atlas</h1>
            <p className="text-fg-secondary">Live coaching for sales calls.</p>
          </div>
          <Link
            href="/call/new"
            className="px-4 py-2 bg-accent text-white rounded-md hover:bg-accent-hover transition-colors text-sm font-medium"
          >
            New call
          </Link>
        </header>

        <section>
          <h2 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-fg-muted mb-3">
            Past calls
          </h2>

          {error && (
            <div className="bg-signal-negative/10 border border-signal-negative/30 rounded-md p-3 text-sm text-signal-negative mb-4">
              Couldn't reach the Atlas agent. Make sure the desktop app is running. ({error})
            </div>
          )}

          {calls === null && !error && (
            <p className="text-fg-muted text-sm">Loading…</p>
          )}

          {calls && calls.length === 0 && (
            <div className="border border-dashed border-border rounded-md p-8 text-center">
              <p className="text-fg-muted text-sm mb-3">No calls yet.</p>
              <Link
                href="/call/new"
                className="text-accent hover:underline text-sm font-medium"
              >
                Start your first call →
              </Link>
            </div>
          )}

          {calls && calls.length > 0 && (
            <ul className="space-y-2">
              {calls.map((c) => (
                <li key={c.id}>
                  <Link
                    href={c.status === 'active' ? `/call/${c.id}` : `/call/${c.id}/coaching`}
                    className="block bg-bg-elevated border border-border rounded-md p-4 hover:border-accent/50 transition-colors"
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="font-medium">
                          {c.prospect_name ?? '(no prospect name)'}
                        </div>
                        <div className="text-xs text-fg-muted mt-1">
                          {new Date(c.started_at).toLocaleString()}
                        </div>
                      </div>
                      <span
                        className={`text-[10px] uppercase tracking-wider px-2 py-1 rounded-md ${
                          c.status === 'active'
                            ? 'bg-signal-positive/10 text-signal-positive'
                            : c.status === 'ended'
                              ? 'bg-bg-muted text-fg-muted'
                              : 'bg-signal-negative/10 text-signal-negative'
                        }`}
                      >
                        {c.status}
                      </span>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
