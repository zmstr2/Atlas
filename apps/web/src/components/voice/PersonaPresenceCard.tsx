'use client';
import { Waveform } from './Waveform';

export type PersonaPresenceCardProps = {
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
};

export function PersonaPresenceCard({
  remoteStream,
  displayName,
  subtitle,
  color = '#5B3FBE',
  muted,
  onToggleMute,
  onHangup,
  phase,
  error,
  onErrorBack,
}: PersonaPresenceCardProps) {
  return (
    <div className="rounded-xl border border-border bg-bg-elevated p-3 space-y-3">
      {/* Top row: waveform + name */}
      <div className="flex items-start gap-3">
        <div className="shrink-0 pt-0.5">
          <Waveform stream={remoteStream} color={color} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-fg-primary leading-snug">{displayName}</div>
          <div className="flex items-center gap-1.5 mt-0.5">
            {subtitle && (
              <span className="text-xs text-fg-muted">{subtitle}</span>
            )}
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
            />
            <span className="text-[10px] uppercase tracking-wider text-fg-muted">
              {phase === 'live' && 'Live'}
              {phase === 'connecting' && 'Connecting'}
              {phase === 'ended' && 'Ended'}
              {phase === 'error' && 'Error'}
            </span>
          </div>
        </div>
      </div>

      {/* Bottom row: call controls */}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onToggleMute}
          aria-label={muted ? 'Unmute microphone' : 'Mute microphone'}
          className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition ${
            muted
              ? 'bg-accent/10 text-accent border border-accent/30'
              : 'bg-bg-subtle text-fg-secondary border border-border hover:bg-bg-muted'
          }`}
        >
          {muted ? <MicMutedIcon /> : <MicIcon />}
          {muted ? 'Unmute' : 'Mute'}
        </button>

        <button
          type="button"
          onClick={onHangup}
          aria-label="End call"
          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-signal-negative/10 border border-signal-negative/40 text-signal-negative hover:bg-signal-negative/20 transition"
        >
          <HangupIcon />
          End call
        </button>
      </div>

      {phase === 'error' && error && (
        <div className="rounded-lg border border-signal-negative/30 bg-signal-negative/5 p-2 text-xs text-signal-negative">
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
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M23 7l-7 5 7 5V7z" />
      <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
      <line x1="1" y1="19" x2="23" y2="5" />
    </svg>
  );
}
