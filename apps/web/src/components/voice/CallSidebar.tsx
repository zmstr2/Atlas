'use client';
import { useState } from 'react';

export type CallSidebarProps = {
  remoteStream: MediaStream | null;
  displayName: string;
  subtitle?: string;
  color?: string;
  muted: boolean;
  onToggleMute: () => void;
  onHangup: () => void;
  phase: 'connecting' | 'live' | 'ended' | 'error';
  error?: string | null;
  onErrorBack?: () => void;
  errors?: string[];
};

const PHASE_LABEL: Record<CallSidebarProps['phase'], string> = {
  live: 'Live',
  connecting: 'Connecting',
  ended: 'Ended',
  error: 'Error',
};

export function CallSidebar({
  displayName,
  subtitle,
  muted,
  onToggleMute,
  onHangup,
  phase,
  error,
  onErrorBack,
  errors = [],
}: CallSidebarProps) {
  return (
    <div className="flex flex-col">
      {/* Single-row persona header with inline icon controls */}
      <div className="px-4 py-3 flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-fg-primary leading-snug truncate">
            {displayName}
          </div>
          <div className="flex items-center gap-1.5 mt-0.5 min-w-0">
            {subtitle && (
              <span className="text-xs text-fg-muted truncate">{subtitle}</span>
            )}
            <span className="text-fg-muted/40">·</span>
            <span
              className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${
                phase === 'live'
                  ? 'bg-signal-positive animate-atlas-pulse'
                  : phase === 'connecting'
                    ? 'bg-fg-muted animate-atlas-pulse'
                    : phase === 'error'
                      ? 'bg-signal-negative'
                      : 'bg-fg-muted'
              }`}
              aria-hidden="true"
            />
            <span className="text-[10px] uppercase tracking-wider text-fg-muted">
              {PHASE_LABEL[phase]}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <IconButton
            label={muted ? 'Unmute microphone' : 'Mute microphone'}
            onClick={onToggleMute}
            tone={muted ? 'accent' : 'neutral'}
          >
            {muted ? <MicMutedIcon /> : <MicIcon />}
          </IconButton>
          <IconButton
            label="End call"
            onClick={onHangup}
            tone="destructive"
          >
            <HangupIcon />
          </IconButton>
        </div>
      </div>

      {phase === 'error' && error && (
        <div className="mx-4 mb-3 rounded-md border border-signal-negative/30 bg-signal-negative/5 p-2 text-xs text-signal-negative">
          <div>{error}</div>
          {onErrorBack && (
            <button
              type="button"
              onClick={onErrorBack}
              className="mt-2 px-2 py-1 rounded bg-signal-negative text-white text-xs"
            >
              Back
            </button>
          )}
        </div>
      )}

      {errors.length > 0 && (
        <div className="px-4 pb-3">
          <CoachErrorNotice errors={errors} />
        </div>
      )}
    </div>
  );
}

function IconButton({
  label,
  onClick,
  tone,
  children,
}: {
  label: string;
  onClick: () => void;
  tone: 'neutral' | 'accent' | 'destructive';
  children: React.ReactNode;
}) {
  const toneClass =
    tone === 'destructive'
      ? 'text-fg-muted hover:text-signal-negative hover:bg-signal-negative/10'
      : tone === 'accent'
        ? 'text-accent bg-accent/10 hover:bg-accent/15'
        : 'text-fg-secondary hover:text-fg-primary hover:bg-bg-subtle';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`w-8 h-8 flex items-center justify-center rounded-md transition ${toneClass}`}
    >
      {children}
    </button>
  );
}

const ERROR_HINTS: Record<string, string> = {
  unknown_call: 'Coach state expired. Refresh to reconnect.',
  must_send_hello_first: 'Connection out of sequence. Refresh to reconnect.',
  invalid_persona: 'Persona not recognized.',
  suggester_failed: "Atlas couldn't generate a suggestion for this turn.",
};

function humanizeError(raw: string): string {
  if (ERROR_HINTS[raw]) return ERROR_HINTS[raw];
  // Schema mismatches and other long technical strings get a single calm line.
  if (raw.startsWith('LLM schema mismatch') || raw.includes('Invalid enum')) {
    return "Atlas hit an unexpected response and is recovering.";
  }
  return 'Atlas hit a transient issue and is recovering.';
}

function CoachErrorNotice({ errors }: { errors: string[] }) {
  const [open, setOpen] = useState(false);
  const latest = errors[errors.length - 1];
  const human = humanizeError(latest);
  const olderCount = errors.length - 1;
  return (
    <div className="flex gap-2 items-start text-xs text-fg-muted">
      <span
        className="mt-[3px] shrink-0 w-3 h-3 rounded-full border border-fg-muted/40 flex items-center justify-center text-[9px] font-bold leading-none"
        aria-hidden="true"
      >
        !
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="text-fg-secondary leading-snug">
          {human}
          {olderCount > 0 && (
            <span className="text-fg-muted">
              {' '}· {olderCount} earlier {olderCount === 1 ? 'issue' : 'issues'}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="text-[11px] text-fg-muted hover:text-fg-secondary underline-offset-2 hover:underline"
        >
          {open ? 'Hide details' : 'Details'}
        </button>
        {open && (
          <pre className="mt-1 p-2 rounded bg-bg-subtle text-[10px] text-fg-muted whitespace-pre-wrap break-words max-h-32 overflow-y-auto">
            {latest}
          </pre>
        )}
      </div>
    </div>
  );
}

function MicIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="3" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <line x1="12" y1="18" x2="12" y2="22" />
    </svg>
  );
}

function MicMutedIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="3" y1="3" x2="21" y2="21" />
      <path d="M9 9v3a3 3 0 0 0 5.12 2.12" />
      <path d="M15 9.34V5a3 3 0 0 0-5.94-.6" />
      <path d="M5 11a7 7 0 0 0 11.4 5.5" />
      <line x1="12" y1="18" x2="12" y2="22" />
    </svg>
  );
}

function HangupIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.37 1.9.72 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.35 1.85.59 2.81.72A2 2 0 0 1 22 16.92z" transform="rotate(135 12 12)" />
    </svg>
  );
}
