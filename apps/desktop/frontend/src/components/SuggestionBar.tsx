'use client';

import { cn } from '@/lib/cn';

export type SuggestionState =
  | { mode: 'idle' }
  | { mode: 'pulse'; utteranceId: string }
  | { mode: 'complete'; text: string; utteranceId: string };

export function SuggestionBar({ state }: { state: SuggestionState }) {
  return (
    <div
      className={cn(
        'fixed bottom-0 left-0 right-0 min-h-[96px] flex items-center px-6 py-4',
        'border-t border-border border-l-4 border-l-accent',
        'bg-bg-elevated/95 backdrop-blur-sm',
        'shadow-[0_-4px_12px_rgba(0,0,0,0.04)]',
      )}
    >
      {state.mode === 'idle' && (
        <div className="flex items-center gap-3">
          <div className="w-2 h-2 rounded-full bg-accent/40" />
          <span className="text-fg-muted text-sm">Listening for cues</span>
        </div>
      )}

      {state.mode === 'pulse' && (
        <div className="flex items-center gap-3">
          <div className="w-2.5 h-2.5 rounded-full bg-accent animate-atlas-pulse shadow-[0_0_10px_rgba(91,63,190,0.6)]" />
          <span className="text-fg-secondary text-sm italic">Atlas is composing a suggestion…</span>
        </div>
      )}

      {state.mode === 'complete' && (
        <div className="flex items-start gap-3 w-full">
          <div className="w-2.5 h-2.5 mt-2 rounded-full bg-accent shrink-0 shadow-[0_0_10px_rgba(91,63,190,0.6)]" />
          <div className="flex-1">
            <span className="block text-[10px] font-semibold uppercase tracking-widest text-accent mb-1">
              Atlas Suggestion
            </span>
            <p className="text-fg-primary text-base leading-relaxed whitespace-pre-wrap">
              {state.text}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
