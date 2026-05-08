'use client';

import { useState } from 'react';
import type { MeetingMemory, Concern, CallFactsUI, AxisCard, RelevantFact } from '@atlas/types';
import { cn } from '@/lib/cn';

// ─── BANT ────────────────────────────────────────────────────────────────────

const AXIS_LABEL: Record<string, string> = {
  need: 'Need',
  budget: 'Budget',
  authority: 'Authority',
  timeline: 'Timeline',
};

const AXIS_STATE_LABEL: Record<string, string> = {
  unknown: 'Not yet qualified',
  vague: 'Vague signal',
  soft: 'Soft signal',
  partial: 'Partial',
  firm: 'Confirmed',
  confirmed: 'Confirmed',
  confirmed_negative: 'Blocked',
};

const AXIS_STATE_COLOR: Record<string, string> = {
  unknown: 'text-fg-muted/60',
  vague: 'text-fg-muted/60',
  soft: 'text-qual-need',
  partial: 'text-qual-need',
  firm: 'text-signal-positive',
  confirmed: 'text-signal-positive',
  confirmed_negative: 'text-signal-negative',
};

const AXIS_BORDER: Record<string, string> = {
  unknown: 'border-fg-muted/20 border-dashed',
  vague: 'border-fg-muted/20 border-dashed',
  soft: 'border-qual-need/40',
  partial: 'border-qual-need/40',
  firm: 'border-signal-positive/50',
  confirmed: 'border-signal-positive/50',
  confirmed_negative: 'border-signal-negative/50',
};

function BantCard({ axisKey, card }: { axisKey: string; card: AxisCard }) {
  const state = card.state ?? 'unknown';
  return (
    <div
      className={cn(
        'rounded-md border bg-bg-base/40 px-2.5 py-2 transition-all duration-150 animate-slide-in flex flex-col gap-1',
        AXIS_BORDER[state] ?? AXIS_BORDER.unknown,
      )}
    >
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
          {AXIS_LABEL[axisKey] ?? axisKey}
        </span>
        <span className={cn('text-[10px] font-medium', AXIS_STATE_COLOR[state] ?? AXIS_STATE_COLOR.unknown)}>
          {AXIS_STATE_LABEL[state] ?? AXIS_STATE_LABEL.unknown}
        </span>
      </div>
      {card.headline ? (
        <>
          <div className="text-[12px] text-fg-primary font-medium leading-snug">
            {card.headline}
          </div>
          {card.detail && (
            <div className="text-[11px] text-fg-muted leading-snug">
              {card.detail}
            </div>
          )}
        </>
      ) : (
        <div className="text-[11px] text-fg-muted/70 leading-snug">—</div>
      )}
    </div>
  );
}

// ─── Relevant Facts ───────────────────────────────────────────────────────────

const FACT_CATEGORY_ICON: Record<RelevantFact['category'], string> = {
  stack: '⬡',
  metric: '#',
  trigger: '↯',
  competitor: '⊕',
  commitment: '✓',
  process: '→',
};

const FACT_CATEGORY_COLOR: Record<RelevantFact['category'], string> = {
  stack: 'text-blue-500',
  metric: 'text-signal-positive',
  trigger: 'text-orange-500',
  competitor: 'text-qual-need',
  commitment: 'text-accent',
  process: 'text-fg-muted',
};

function RelevantFactItem({ fact }: { fact: RelevantFact }) {
  return (
    <div className="flex items-start gap-2 py-1 animate-slide-in">
      <span className={cn('text-[11px] shrink-0 mt-0.5 font-mono', FACT_CATEGORY_COLOR[fact.category])}>
        {FACT_CATEGORY_ICON[fact.category]}
      </span>
      <span className="text-[12px] text-fg-secondary leading-snug">{fact.text}</span>
    </div>
  );
}

// ─── Concerns ────────────────────────────────────────────────────────────────

const CONCERN_BORDER: Record<Concern['severity'], string> = {
  mentioned: 'border-l-qual-need/60',
  pressed: 'border-l-orange-500/70',
  blocking: 'border-l-signal-negative/70',
};
const CONCERN_CHIP: Record<Concern['severity'], string> = {
  mentioned: 'bg-qual-need/15 text-qual-need',
  pressed: 'bg-orange-500/15 text-orange-600',
  blocking: 'bg-signal-negative/15 text-signal-negative',
};

const HOVER_BASE =
  'group relative animate-slide-in border-l-2 pl-3 pr-2 py-1.5 -mx-1 rounded-r-md cursor-pointer ' +
  'transition-all duration-150 ease-out hover:bg-bg-subtle hover:translate-x-0.5';

function ConcernItem({ concern }: { concern: Concern }) {
  const [showVerbatim, setShowVerbatim] = useState(false);
  return (
    <div
      className={cn(HOVER_BASE, CONCERN_BORDER[concern.severity])}
      onMouseEnter={() => setShowVerbatim(true)}
      onMouseLeave={() => setShowVerbatim(false)}
    >
      <div className="flex items-center gap-2 text-sm">
        <span className={cn('px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wider', CONCERN_CHIP[concern.severity])}>
          {concern.severity}
        </span>
        <span className="text-fg-secondary">{concern.topic}</span>
      </div>
      {showVerbatim && (
        <div className="mt-1.5 text-[11px] text-fg-secondary italic border-l-2 border-l-fg-muted/30 pl-2 animate-slide-in">
          "{concern.verbatim}"
        </div>
      )}
    </div>
  );
}

// ─── Stakeholders ─────────────────────────────────────────────────────────────

const SENTIMENT_DOT: Record<string, string> = {
  positive: 'bg-signal-positive',
  neutral: 'bg-fg-muted',
  negative: 'bg-signal-negative',
  unknown: 'bg-fg-muted/40',
};

// ─── Open Loops ───────────────────────────────────────────────────────────────

// ─── Section ──────────────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="pt-4 border-t border-border/60 first:pt-0 first:border-t-0">
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-fg-muted mb-2">
        {title}
      </h3>
      {children}
    </section>
  );
}

// ─── Main Panel ───────────────────────────────────────────────────────────────

const EMPTY_AXIS: AxisCard = { state: 'unknown', headline: null, detail: null, anchorTurnId: null };
const EMPTY_BANT: Record<string, AxisCard> = {
  need: EMPTY_AXIS,
  budget: EMPTY_AXIS,
  authority: EMPTY_AXIS,
  timeline: EMPTY_AXIS,
};

export function MemoryPanel({
  memory,
  factsUI,
  className,
}: {
  memory: MeetingMemory | null;
  factsUI?: CallFactsUI | null;
  className?: string;
}) {
  const baseClass = className ?? 'w-[360px] shrink-0 bg-bg-elevated border-l border-border';
  const isLive = !!factsUI;

  const bant = factsUI?.bant ?? EMPTY_BANT;
  const stakeholders = factsUI?.stakeholders ?? [];
  const openLoops = factsUI?.openLoops ?? [];
  const relevantFacts = factsUI?.relevantFacts ?? [];
  const activeConcerns = (memory?.concerns ?? []).filter((c) => !c.addressed);
  const activeLoops = openLoops.filter((l) => (l as { status?: string }).status !== 'addressed');

  return (
    <aside className={cn(baseClass, 'h-full flex flex-col overflow-hidden')}>
      {/* Sticky header */}
      <div className="sticky top-0 bg-bg-elevated border-b border-border px-4 py-3 z-10 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <span className={cn('w-1.5 h-1.5 rounded-full transition-colors duration-500', isLive ? 'bg-accent animate-atlas-pulse' : 'bg-fg-muted/30')} />
          <span className="text-sm font-bold tracking-wide text-fg-primary">Live Memory</span>
        </div>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {/* Qualification — always first */}
        <section>
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-fg-muted mb-2">
            Qualification
          </h3>
          <div className="grid grid-cols-2 gap-2">
            {(['need', 'budget', 'authority', 'timeline'] as const).map((k) => (
              <BantCard key={k} axisKey={k} card={bant[k]} />
            ))}
          </div>
        </section>

        {/* Relevant Facts */}
        <Section title="Relevant Facts">
          {relevantFacts.length > 0 ? (
            <div className="divide-y divide-border/40">
              {relevantFacts.map((f) => (
                <RelevantFactItem key={f.id} fact={f} />
              ))}
            </div>
          ) : (
            <div className="space-y-2">
              {[72, 56, 80].map((w) => (
                <div key={w} className="flex items-center gap-2 py-0.5">
                  <span className="w-2.5 h-2.5 rounded-sm bg-fg-muted/10 shrink-0" />
                  <div className="h-2 rounded-full bg-fg-muted/10" style={{ width: `${w}%` }} />
                </div>
              ))}
            </div>
          )}
        </Section>

        {/* Concerns */}
        <Section title="Concerns">
          {activeConcerns.length > 0 ? (
            <div className="space-y-1">
              {activeConcerns.map((c) => (
                <ConcernItem key={c.id} concern={c} />
              ))}
            </div>
          ) : (
            <div className="space-y-1.5">
              {[60, 45].map((w) => (
                <div key={w} className="border-l-2 border-l-fg-muted/15 pl-3 py-1.5">
                  <div className="h-2 rounded-full bg-fg-muted/10" style={{ width: `${w}%` }} />
                </div>
              ))}
            </div>
          )}
        </Section>

        {/* Open Loops */}
        <Section title="Open Loops">
          {activeLoops.length > 0 ? (
            <div className="space-y-1">
              {activeLoops.map((l) => (
                <div
                  key={l.id}
                  className={cn(HOVER_BASE, 'border-l-accent/60 hover:border-l-accent text-sm text-fg-secondary')}
                >
                  <span className="text-[10px] text-accent font-semibold mr-2 uppercase tracking-wider">
                    {l.owner}
                  </span>
                  {l.description}
                </div>
              ))}
            </div>
          ) : (
            <div className="space-y-1.5">
              {[68, 50].map((w) => (
                <div key={w} className="border-l-2 border-l-accent/15 pl-3 py-1.5">
                  <div className="h-2 rounded-full bg-fg-muted/10" style={{ width: `${w}%` }} />
                </div>
              ))}
            </div>
          )}
        </Section>

        {/* Stakeholders */}
        <Section title="Stakeholders">
          {stakeholders.length > 0 ? (
            <ul className="space-y-1.5">
              {stakeholders.map((s) => (
                <li key={s.name} className="flex items-center gap-2 text-xs">
                  <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', SENTIMENT_DOT[s.sentiment] ?? SENTIMENT_DOT.unknown)} />
                  <span className="text-fg-primary font-medium">{s.name}</span>
                  <span className="text-fg-muted truncate">{s.role}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="space-y-2">
              {[55, 40].map((w) => (
                <div key={w} className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-fg-muted/20 shrink-0" />
                  <div className="h-2 rounded-full bg-fg-muted/10" style={{ width: `${w}%` }} />
                </div>
              ))}
            </div>
          )}
        </Section>
      </div>
    </aside>
  );
}
