'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { getCall, type CallDetail } from '@/lib/agent';
import { AuthGate } from '@/components/AuthGate';

export default function CoachingPageRoute({
  params,
}: {
  params: { id: string };
}) {
  return (
    <AuthGate>
      <CoachingPage params={params} />
    </AuthGate>
  );
}

function CoachingPage({ params }: { params: { id: string } }) {
  const [detail, setDetail] = useState<CallDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getCall(params.id)
      .then((d) => alive && setDetail(d))
      .catch((err) => alive && setError(err.message));
    return () => {
      alive = false;
    };
  }, [params.id]);

  if (!detail) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-bg-base">
        {error ? (
          <div className="text-signal-negative text-sm">{error}</div>
        ) : (
          <div className="text-fg-muted text-sm">Loading…</div>
        )}
      </main>
    );
  }

  const { call, suggestions, utterances } = detail;

  return (
    <main className="min-h-screen bg-bg-base text-fg-primary">
      <div className="max-w-3xl mx-auto px-6 py-10 space-y-8">
        <div>
          <Link
            href="/"
            className="text-fg-muted text-sm hover:text-fg-secondary inline-block mb-4"
          >
            ← All calls
          </Link>
          <h1 className="font-display text-3xl mb-1">
            {call.prospect_name ?? 'Untitled call'}
          </h1>
          <div className="text-fg-muted text-sm">
            {new Date(call.started_at).toLocaleString()}
            {call.ended_at && (
              <>
                {' '}
                — {Math.round((call.ended_at - call.started_at) / 1000 / 60)} min
              </>
            )}
          </div>
        </div>

        {call.verdict && (
          <Section title="Verdict">
            <pre className="whitespace-pre-wrap font-mono text-xs text-fg-secondary bg-bg-elevated border border-border rounded-md p-4">
              {JSON.stringify(call.verdict, null, 2)}
            </pre>
          </Section>
        )}

        {call.coaching_artifact !== null && (
          <Section title="Coaching">
            <pre className="whitespace-pre-wrap font-mono text-xs text-fg-secondary bg-bg-elevated border border-border rounded-md p-4">
              {JSON.stringify(call.coaching_artifact as unknown, null, 2)}
            </pre>
          </Section>
        )}

        {call.follow_up_email && (
          <Section title="Follow-up email">
            <pre className="whitespace-pre-wrap text-sm text-fg-primary bg-bg-elevated border border-border rounded-md p-4">
              {call.follow_up_email}
            </pre>
          </Section>
        )}

        <Section title={`Suggestions fired during the call (${suggestions.length})`}>
          {suggestions.length === 0 ? (
            <p className="text-fg-muted text-sm">No suggestions fired.</p>
          ) : (
            <ul className="space-y-2">
              {suggestions
                .filter((s) => s.should_fire && !s.suppressed)
                .map((s) => (
                  <li
                    key={s.id}
                    className="bg-bg-elevated border border-border rounded-md p-3 text-sm"
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span
                        className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ${
                          s.priority === 'critical'
                            ? 'bg-signal-negative/10 text-signal-negative'
                            : 'bg-bg-muted text-fg-secondary'
                        }`}
                      >
                        {s.priority}
                      </span>
                      <span className="text-xs text-fg-muted">{s.play}</span>
                    </div>
                    <div>{s.markdown}</div>
                    <div className="text-xs text-fg-muted mt-1">{s.reasoning}</div>
                  </li>
                ))}
            </ul>
          )}
        </Section>

        <Section title={`Transcript (${utterances.length} utterances)`}>
          <div className="bg-bg-elevated border border-border rounded-md p-4 space-y-2 max-h-96 overflow-y-auto">
            {utterances.map((u) => (
              <div key={u.id} className="text-sm">
                <span className="text-fg-muted text-xs uppercase tracking-wider mr-2">
                  {u.speaker}
                </span>
                {u.text}
              </div>
            ))}
          </div>
        </Section>
      </div>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-fg-muted mb-3">
        {title}
      </h2>
      {children}
    </section>
  );
}
