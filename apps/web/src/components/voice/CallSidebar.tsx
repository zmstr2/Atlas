'use client';
import { Waveform } from './Waveform';


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

export function CallSidebar({
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
  errors = [],
}: CallSidebarProps) {
  return (
    <div className="flex flex-col h-full">
      {/* Section: Presence */}
      <div className="px-4 py-4 space-y-3 shrink-0">
        <div className="flex items-start gap-3">
          <div className="shrink-0 pt-0.5">
            <Waveform stream={remoteStream} color={color} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-fg-primary leading-snug">{displayName}</div>
            <div className="flex items-center gap-1.5 mt-0.5">
              {subtitle && <span className="text-xs text-fg-muted">{subtitle}</span>}
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

        <div className="flex gap-2">
          <button
            type="button"
            onClick={onToggleMute}
            aria-label={muted ? 'Unmute microphone' : 'Mute microphone'}
            className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition ${
              muted
                ? 'bg-accent/10 text-accent border border-accent/30'
                : 'bg-[#F5F5F4] text-fg-secondary border border-[#E7E5E4] hover:bg-[#EFEDEB]'
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

      {errors.length > 0 && (
        <div className="px-4 pb-4">
          <CoachErrorNotice errors={errors} />
        </div>
      )}
    </div>
  );
}

const ERROR_HINTS: Record<string, string> = {
  unknown_call: 'Coach state not found — the call may have expired or restarted.',
  must_send_hello_first: 'Connection out of sequence. Refresh to reconnect.',
  invalid_persona: 'Unrecognised persona. Check agent configuration.',
  suggester_failed: 'Atlas couldn\'t generate a suggestion for this turn.',
};

function CoachErrorNotice({ errors }: { errors: string[] }) {
  const latest = errors[errors.length - 1];
  const hint = ERROR_HINTS[latest];
  return (
    <div className="flex gap-2.5 items-start text-xs">
      <span className="mt-0.5 shrink-0 w-3.5 h-3.5 rounded-full border border-fg-muted/40 flex items-center justify-center text-fg-muted font-bold leading-none">!</span>
      <div className="space-y-0.5">
        <div className="text-fg-secondary font-medium">{latest}</div>
        {hint && <div className="text-fg-muted">{hint}</div>}
        {errors.length > 1 && (
          <div className="text-fg-muted">{errors.length - 1} earlier error{errors.length > 2 ? 's' : ''} this session.</div>
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
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M23 7l-7 5 7 5V7z" />
      <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
      <line x1="1" y1="19" x2="23" y2="5" />
    </svg>
  );
}
