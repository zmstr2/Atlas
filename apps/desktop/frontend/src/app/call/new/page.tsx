'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useState } from 'react';
import { startCall } from '@/lib/agent';
import type { PreCallBrief } from '@atlas/types';

export default function NewCallPage() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Minimal v1 brief form. The user can paste a meeting URL for context (not
  // load-bearing — Atlas captures system audio regardless of which app the
  // call is running in) and fills out a few prospect details.
  const [prospectName, setProspectName] = useState('');
  const [prospectTitle, setProspectTitle] = useState('');
  const [prospectCompany, setProspectCompany] = useState('');
  const [callGoal, setCallGoal] = useState('');
  const [founderContext, setFounderContext] = useState('');
  const [meetingUrl, setMeetingUrl] = useState('');

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!prospectName.trim()) {
      setError('Prospect name is required.');
      return;
    }
    setSubmitting(true);
    setError(null);

    const brief: PreCallBrief = {
      prospect: {
        name: prospectName.trim(),
        title: prospectTitle.trim() || undefined,
        company: prospectCompany.trim() || undefined,
      },
      callGoal: callGoal.trim() || undefined,
      founderContext: founderContext.trim() || undefined,
    };

    try {
      const { callId } = await startCall(brief, meetingUrl.trim() || undefined);
      router.push(`/call/${callId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  return (
    <main className="min-h-screen bg-bg-base text-fg-primary">
      <div className="max-w-xl mx-auto px-6 py-10">
        <Link
          href="/"
          className="text-fg-muted text-sm hover:text-fg-secondary mb-6 inline-block"
        >
          ← Back
        </Link>

        <h1 className="font-display text-3xl mb-2">New call</h1>
        <p className="text-fg-secondary mb-8 text-sm">
          Atlas will capture audio from your microphone and your computer's speakers.
          Make sure both are on. The bot does not join the meeting — you do.
        </p>

        <form onSubmit={onSubmit} className="space-y-5">
          <Field label="Prospect name" required>
            <input
              type="text"
              value={prospectName}
              onChange={(e) => setProspectName(e.target.value)}
              placeholder="Maya Chen"
              className="input"
              autoFocus
            />
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Title">
              <input
                type="text"
                value={prospectTitle}
                onChange={(e) => setProspectTitle(e.target.value)}
                placeholder="VP Marketing"
                className="input"
              />
            </Field>
            <Field label="Company">
              <input
                type="text"
                value={prospectCompany}
                onChange={(e) => setProspectCompany(e.target.value)}
                placeholder="MidCo"
                className="input"
              />
            </Field>
          </div>

          <Field label="What do you want out of this call?">
            <input
              type="text"
              value={callGoal}
              onChange={(e) => setCallGoal(e.target.value)}
              placeholder="qualify, surface budget, lock next step"
              className="input"
            />
          </Field>

          <Field label="Anything else Atlas should know?">
            <textarea
              value={founderContext}
              onChange={(e) => setFounderContext(e.target.value)}
              placeholder="They've evaluated competitors. Skeptical of AI. CFO is the actual buyer."
              className="input min-h-[80px]"
              rows={3}
            />
          </Field>

          <Field label="Meeting URL (optional)">
            <input
              type="text"
              value={meetingUrl}
              onChange={(e) => setMeetingUrl(e.target.value)}
              placeholder="https://meet.google.com/abc-defg-hij"
              className="input"
            />
            <p className="text-xs text-fg-muted mt-1">
              For your records only — Atlas listens to system audio, not the URL.
            </p>
          </Field>

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
            {submitting ? 'Starting…' : 'Start listening'}
          </button>
        </form>
      </div>

      <style jsx global>{`
        .input {
          @apply w-full bg-bg-elevated border border-border rounded-md px-3 py-2 text-sm text-fg-primary placeholder:text-fg-muted focus:outline-none focus:border-accent;
        }
      `}</style>
    </main>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-xs font-semibold uppercase tracking-[0.14em] text-fg-muted mb-1.5">
        {label}
        {required && <span className="text-signal-negative ml-1">*</span>}
      </span>
      {children}
    </label>
  );
}
