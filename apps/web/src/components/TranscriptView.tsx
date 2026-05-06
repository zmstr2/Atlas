'use client';

import { useEffect, useRef } from 'react';
import type { Utterance } from '@atlas/types';
import { cn } from '@/lib/cn';

function formatTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function getInitials(name?: string): string {
  if (!name) return 'C';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

export function TranscriptView({
  utterances,
  customerName,
}: {
  utterances: Utterance[];
  customerName?: string;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [utterances.length]);

  const customerInitials = getInitials(customerName);

  return (
    <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3 pb-32">
      {utterances.length === 0 && (
        <p className="text-fg-muted text-sm text-center mt-8">Transcript will appear here…</p>
      )}
      {utterances.map((u) => {
        const isRep = u.speaker === 'founder';
        return (
          <div
            key={u.id}
            className={cn(
              'animate-slide-in flex gap-3',
              isRep ? 'flex-row' : 'flex-row-reverse',
            )}
          >
            <div className="shrink-0 flex flex-col items-center gap-1.5">
              <div
                className={cn(
                  'w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-semibold',
                  isRep ? 'bg-accent text-white' : 'bg-bg-muted text-fg-secondary',
                )}
              >
                {isRep ? 'REP' : customerInitials}
              </div>
              <span className="text-[10px] text-fg-muted font-mono tabular-nums">
                {formatTime(u.startMs)}
              </span>
            </div>
            <div className={cn('max-w-[70%]', !isRep && 'flex flex-col items-end')}>
              <div
                className={cn(
                  'px-4 py-2.5 text-sm leading-relaxed',
                  isRep
                    ? 'bg-accent/10 text-fg-primary rounded-2xl rounded-tl-sm'
                    : 'bg-bg-elevated text-fg-primary rounded-2xl rounded-tr-sm shadow-[0_1px_2px_rgba(0,0,0,0.04)]',
                  u.derivedFromLowConfidence && 'opacity-60',
                )}
              >
                {u.text}
              </div>
            </div>
          </div>
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}
