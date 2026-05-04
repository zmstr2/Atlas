'use client';

import { useState, type ReactNode } from 'react';
import type { PreCallBrief } from '@atlas/types';

export function PreCallBriefHeader({
  brief,
  callActive,
  rightSlot,
}: {
  brief: PreCallBrief;
  callActive?: boolean;
  rightSlot?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border-b border-border bg-bg-elevated">
      <div className="px-6 py-3 flex items-center gap-4">
        <div className="flex flex-col min-w-0">
          <div className="flex items-center gap-2">
            {callActive && (
              <span
                className="w-1.5 h-1.5 rounded-full bg-signal-positive animate-pulse"
                aria-label="Call active"
              />
            )}
            <span className="font-display text-base font-medium text-fg-primary truncate">
              {brief.lead.name}
            </span>
            <span className="text-fg-muted text-sm">·</span>
            <span className="text-sm text-fg-secondary truncate">{brief.lead.title}</span>
          </div>
          <span className="text-xs text-fg-muted">
            {brief.lead.company} · {brief.lead.companySize}
          </span>
        </div>

        <div className="ml-auto flex items-center gap-2">
          {rightSlot}
          <button
            className="px-2.5 py-1.5 rounded-md bg-bg-muted text-fg-secondary text-xs font-medium flex items-center gap-1.5 hover:bg-bg-muted/70 transition-colors"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
          >
            <span className="text-[10px]">{expanded ? '▲' : '▼'}</span>
            pre-call brief
          </button>
        </div>
      </div>

      {expanded && (
        <div className="px-6 py-4 space-y-4 border-t border-border bg-bg-muted/30 text-sm">
          <div>
            <h4 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-fg-muted mb-2">
              Ava's Scoring Signals
            </h4>
            <div className="space-y-1">
              {brief.avaContext.scoringSignals.map((s) => (
                <div key={s.signal} className="flex items-center gap-2 text-fg-secondary">
                  <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />
                  {s.signal}
                  <span className="text-fg-muted ml-auto font-mono text-xs tabular-nums">
                    {(s.weight * 100).toFixed(0)}%
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div>
            <h4 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-fg-muted mb-2">
              Suggested Questions
            </h4>
            <ul className="space-y-1">
              {brief.suggestedQuestions.map((q, i) => (
                <li key={i} className="text-fg-secondary flex gap-2">
                  <span className="text-accent shrink-0 tabular-nums">{i + 1}.</span>
                  {q}
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h4 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-fg-muted mb-2">
              Product Snippets
            </h4>
            <ul className="space-y-1">
              {brief.productSnippets.map((s, i) => (
                <li key={i} className="text-fg-secondary italic text-xs">
                  "{s}"
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
