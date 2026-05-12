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

// Per-state: label color, card background tint, bottom strip color
const AXIS_STYLE: Record<string, { label: string; bg: string; strip: string }> = {
  soft:              { label: 'text-qual-need',        bg: 'bg-[#FEF3C7]/60',          strip: 'bg-qual-need/50' },
  partial:           { label: 'text-qual-need',        bg: 'bg-[#FEF3C7]/60',          strip: 'bg-qual-need/50' },
  firm:              { label: 'text-signal-positive',  bg: 'bg-[#D1FAE5]/50',          strip: 'bg-signal-positive/60' },
  confirmed:         { label: 'text-signal-positive',  bg: 'bg-[#D1FAE5]/50',          strip: 'bg-signal-positive/60' },
  confirmed_negative:{ label: 'text-signal-negative',  bg: 'bg-signal-negative/5',     strip: 'bg-signal-negative/50' },
};
const AXIS_STYLE_DEFAULT = { label: 'text-fg-muted/60', bg: 'bg-bg-base/40', strip: '' };

const AXIS_KEYS = ['need', 'budget', 'authority', 'timeline'] as const;
type AxisKey = (typeof AXIS_KEYS)[number];

function isPopulated(card: AxisCard): boolean {
  const state = card.state ?? 'unknown';
  return state !== 'unknown' && state !== 'vague';
}

function BantCard({ axisKey, card }: { axisKey: string; card: AxisCard }) {
  const state = card.state ?? 'unknown';
  const style = AXIS_STYLE[state] ?? AXIS_STYLE_DEFAULT;

  return (
    <div
      className={cn(
        'rounded-md border border-border/50 overflow-hidden transition-all duration-150 animate-slide-in flex flex-col',
        style.bg,
      )}
    >
      <div className="px-2.5 pt-2 pb-2.5 flex flex-col gap-1 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-fg-secondary">
            {AXIS_LABEL[axisKey] ?? axisKey}
          </span>
          <span className={cn('text-[10px] font-medium shrink-0', style.label)}>
            {AXIS_STATE_LABEL[state] ?? AXIS_STATE_LABEL.unknown}
          </span>
        </div>
        {card.headline && (
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
        )}
      </div>
      {/* Bottom strip — only rendered when there's a state to show */}
      {style.strip && (
        <div className={cn('h-[3px] w-full', style.strip)} />
      )}
    </div>
  );
}

// ─── Relevant Facts ───────────────────────────────────────────────────────────

const FACT_CATEGORY_LABEL: Record<RelevantFact['category'], string> = {
  stack: 'Stack',
  metric: 'Metric',
  trigger: 'Trigger',
  competitor: 'Competitor',
  commitment: 'Commitment',
  process: 'Process',
};

const FACT_CATEGORY_COLOR: Record<RelevantFact['category'], string> = {
  stack: 'bg-blue-500',
  metric: 'bg-signal-positive',
  trigger: 'bg-orange-500',
  competitor: 'bg-qual-need',
  commitment: 'bg-accent',
  process: 'bg-fg-muted',
};

function RelevantFactItem({ fact }: { fact: RelevantFact }) {
  return (
    <div className="flex items-start gap-2.5 py-1 animate-slide-in">
      <span
        className={cn(
          'shrink-0 mt-[7px] w-1.5 h-1.5 rounded-full',
          FACT_CATEGORY_COLOR[fact.category],
        )}
        title={FACT_CATEGORY_LABEL[fact.category]}
        aria-label={FACT_CATEGORY_LABEL[fact.category]}
      />
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

// ─── Section ──────────────────────────────────────────────────────────────────

function Section({
  title,
  emphasis = false,
  children,
}: {
  title: string;
  emphasis?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <h3
        className={cn(
          'uppercase tracking-[0.14em] text-fg-muted',
          emphasis ? 'text-[11px] font-bold' : 'text-[10px] font-semibold',
        )}
      >
        {title}
      </h3>
      {children}
    </section>
  );
}

// ─── Fact filter ──────────────────────────────────────────────────────────────

// Suppress facts that restate context already shown in the persona header.
function filterRedundantFacts(
  facts: RelevantFact[],
  redundantPhrases: string[],
): RelevantFact[] {
  if (redundantPhrases.length === 0) return facts;
  const norms = redundantPhrases
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length > 3);
  return facts.filter((f) => {
    const text = f.text.toLowerCase();
    return !norms.some((p) => text.includes(p));
  });
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
  redundantPhrases = [],
}: {
  memory: MeetingMemory | null;
  factsUI?: CallFactsUI | null;
  className?: string;
  redundantPhrases?: string[];
}) {
  const baseClass = className ?? 'w-[360px] shrink-0 bg-bg-elevated border-l border-border';
  const isLive = !!factsUI;

  const bant = factsUI?.bant ?? EMPTY_BANT;
  const stakeholders = factsUI?.stakeholders ?? [];
  const openLoops = factsUI?.openLoops ?? [];
  const relevantFacts = filterRedundantFacts(
    factsUI?.relevantFacts ?? [],
    redundantPhrases,
  );
  const activeConcerns = (memory?.concerns ?? []).filter((c) => !c.addressed);
  const activeLoops = openLoops.filter((l) => (l as { status?: string }).status !== 'addressed');

  const populatedAxes = AXIS_KEYS.filter((k) => isPopulated(bant[k]));
  const awaitingAxes = AXIS_KEYS.filter((k) => !isPopulated(bant[k]));

  return (
    <aside className={cn(baseClass, 'h-full flex flex-col overflow-hidden')}>
      {/* Sticky header */}
      <div className="sticky top-0 bg-bg-elevated border-b border-border px-4 py-3 z-10 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <span className={cn('w-1.5 h-1.5 rounded-full transition-colors duration-500', isLive ? 'bg-signal-positive animate-atlas-pulse' : 'bg-fg-muted/30')} />
          <span className="text-sm font-bold tracking-wide text-fg-primary">Live Memory</span>
        </div>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-6">
        {/* Qualification — always first, slightly emphasized */}
        <Section title="Qualification" emphasis>
          {populatedAxes.length === 0 ? (
            <div className="text-[12px] text-fg-muted/80 leading-snug">
              Awaiting signal on Need, Budget, Authority, Timeline.
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2">
                {populatedAxes.map((k) => (
                  <BantCard key={k} axisKey={k} card={bant[k]} />
                ))}
              </div>
              {awaitingAxes.length > 0 && (
                <div className="text-[11px] text-fg-muted leading-snug pt-1">
                  Awaiting:{' '}
                  {awaitingAxes.map((k, i) => (
                    <span key={k}>
                      {i > 0 && <span className="text-fg-muted/40"> · </span>}
                      {AXIS_LABEL[k]}
                    </span>
                  ))}
                </div>
              )}
            </>
          )}
        </Section>

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
                  <span className="w-1.5 h-1.5 rounded-full bg-fg-muted/15 shrink-0" />
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
                  className={cn(HOVER_BASE, 'border-l-qual-need/60 hover:border-l-qual-need text-sm text-fg-secondary')}
                >
                  <span className="text-[10px] text-qual-need font-semibold mr-2 uppercase tracking-wider">
                    {l.owner}
                  </span>
                  {l.description}
                </div>
              ))}
            </div>
          ) : (
            <div className="space-y-1.5">
              {[68, 50].map((w) => (
                <div key={w} className="border-l-2 border-l-qual-need/15 pl-3 py-1.5">
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
