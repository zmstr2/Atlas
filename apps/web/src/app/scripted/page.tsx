import Link from 'next/link';

const SCRIPTS = [
  {
    id: 'jordan',
    name: 'Jordan Hayes',
    title: 'VP Marketing, MidCo',
    outcome: 'Qualified → Demo booked',
    theme: 'Lead-attribute true-positives, objection language, decision geography',
    color: 'bg-signal-positive/10 border-signal-positive/30',
    badge: 'qualified',
  },
  {
    id: 'sarah',
    name: 'Sarah Park',
    title: 'Head of Growth, EarlyCo (Series A)',
    outcome: 'Qualified-out cleanly',
    theme: 'Negative qual signals, silence patterns, lead-attribute noise',
    color: 'bg-signal-negative/10 border-signal-negative/30',
    badge: 'not qualified',
  },
  {
    id: 'tom',
    name: 'Tom Reyes',
    title: 'Director of Sales Ops, MidCo',
    outcome: 'Needs more info',
    theme: 'Authority gap, conviction-tone hesitation, open loop',
    color: 'bg-qual-timeline/10 border-qual-timeline/30',
    badge: 'needs more info',
  },
];

export default function ScriptedLandingPage() {
  return (
    <main className="min-h-screen bg-bg-base flex flex-col items-center justify-center px-6 py-16">
      <div className="max-w-3xl w-full space-y-10">
        <header className="space-y-3">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-accent flex items-center justify-center">
              <span className="text-white text-xs font-bold">A</span>
            </div>
            <span className="text-fg-muted text-sm font-medium tracking-wide uppercase">Atlas · Scripted demo</span>
          </div>
          <h1 className="text-3xl font-semibold text-fg-primary leading-tight">
            No mic required.<br />
            <span className="text-accent">Watch a pre-recorded call.</span>
          </h1>
          <p className="text-fg-secondary max-w-xl">
            Atlas processes a deterministic audio fixture as if it were live — same coach, same memory bank,
            same Training Delta. Use this if you can't grant mic access, or want a reproducible demo.
          </p>
          <Link
            href="/"
            className="inline-block text-xs text-accent hover:underline"
          >
            ← Back to live voice mode
          </Link>
        </header>

        <section className="space-y-3">
          <p className="text-fg-muted text-sm font-medium">Choose a scripted scenario to replay:</p>
          <div className="grid gap-3">
            {SCRIPTS.map((s) => (
              <Link
                key={s.id}
                href={`/demo/${s.id}`}
                className={`group block rounded-xl border p-5 transition-shadow hover:shadow-md bg-bg-elevated ${s.color}`}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-fg-primary">{s.name}</span>
                      <span className="text-fg-muted text-sm">·</span>
                      <span className="text-fg-secondary text-sm">{s.title}</span>
                    </div>
                    <p className="text-fg-muted text-sm">{s.theme}</p>
                  </div>
                  <span className="shrink-0 text-xs font-medium px-2.5 py-1 rounded-full bg-bg-muted text-fg-secondary">
                    {s.badge}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
