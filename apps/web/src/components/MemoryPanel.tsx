'use client';

import { useEffect, useRef, useState } from 'react';
import type { MeetingMemory, Concern, CallFactsUI, AxisCard, RelevantFact } from '@atlas/types';
import { cn } from '@/lib/cn';

// ─── Change tracking ────────────────────────────────────────────────────────
// "Change is the story": an item whose content changes gets a brief tint that
// fades on its own. Reduced motion collapses the animation (globals.css).

function useFlash(signature: string): boolean {
  const prev = useRef(signature);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (prev.current === signature) return;
    prev.current = signature;
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 1600);
    return () => clearTimeout(t);
  }, [signature]);
  return flash;
}

// ─── Qualification (BANT) ───────────────────────────────────────────────────

const AXIS_KEYS = ['need', 'budget', 'authority', 'timeline'] as const;
type AxisKey = (typeof AXIS_KEYS)[number];

const AXIS_LABEL: Record<AxisKey, string> = {
  need: 'Need',
  budget: 'Budget',
  authority: 'Authority',
  timeline: 'Timeline',
};

type Certainty = 'unknown' | 'soft' | 'firm' | 'blocked';

/** factsUI already collapses the scorecard's states to this ladder. */
function certaintyOf(card: AxisCard): Certainty {
  // A scored axis with nothing to show is not knowledge yet: be honest about it.
  if (!card.headline) return 'unknown';
  switch (card.state) {
    case 'firm':
    case 'confirmed':
      return 'firm';
    case 'confirmed_negative':
      return 'blocked';
    case 'soft':
    case 'partial':
    case 'vague':
      return 'soft';
    default:
      return 'unknown';
  }
}

const CERTAINTY: Record<Certainty, { label: string; tone: string }> = {
  unknown: { label: 'Not yet heard', tone: 'text-fg-muted' },
  soft: { label: 'Partial', tone: 'text-qual-need' },
  firm: { label: 'Confirmed', tone: 'text-signal-positive' },
  blocked: { label: 'Blocked', tone: 'text-signal-negative' },
};

/** Certainty as a shape (not just a color): empty, half, full, struck. */
function CertaintyMark({ certainty }: { certainty: Certainty }) {
  const tone = CERTAINTY[certainty].tone;
  return (
    <svg viewBox="0 0 12 12" className={cn('w-3 h-3 shrink-0', tone)} aria-hidden="true">
      {certainty === 'unknown' && <circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.25" strokeDasharray="2 2" />}
      {certainty === 'soft' && (
        <>
          <circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.25" />
          <path d="M6 1.5a4.5 4.5 0 0 1 0 9z" fill="currentColor" />
        </>
      )}
      {certainty === 'firm' && <circle cx="6" cy="6" r="5" fill="currentColor" />}
      {certainty === 'blocked' && (
        <>
          <circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.25" />
          <path d="M3 9 9 3" stroke="currentColor" strokeWidth="1.25" />
        </>
      )}
    </svg>
  );
}

function AxisRow({ axisKey, card }: { axisKey: AxisKey; card: AxisCard }) {
  const certainty = certaintyOf(card);
  const { label, tone } = CERTAINTY[certainty];
  const flash = useFlash(`${certainty}|${card.headline ?? ''}|${card.detail ?? ''}`);
  const known = certainty !== 'unknown';

  return (
    <li className={cn('-mx-2 px-2 py-2.5 rounded-md', flash && 'animate-atlas-flash')}>
      <div className="flex items-center gap-2">
        <CertaintyMark certainty={certainty} />
        <span className={cn('text-[13px] font-medium', known ? 'text-fg-primary' : 'text-fg-muted')}>
          {AXIS_LABEL[axisKey]}
        </span>
        <span className={cn('ml-auto text-xs', tone)}>{label}</span>
      </div>
      {known && (
        <div className="mt-1 pl-5 space-y-1">
          <p className="text-[13px] leading-snug text-fg-primary text-pretty">{card.headline}</p>
          {card.detail && <p className="text-xs leading-snug text-fg-secondary text-pretty">{card.detail}</p>}
          {card.quote && card.quote !== card.headline && (
            <p className="text-xs leading-snug text-fg-secondary italic line-clamp-2" title={card.quote}>
              “{card.quote}”
            </p>
          )}
        </div>
      )}
    </li>
  );
}

// ─── Lists ──────────────────────────────────────────────────────────────────

const FACT_CATEGORY_LABEL: Record<RelevantFact['category'], string> = {
  stack: 'Stack',
  metric: 'Metric',
  trigger: 'Trigger',
  competitor: 'Competitor',
  commitment: 'Commitment',
  process: 'Process',
};

function FactRow({ fact }: { fact: RelevantFact }) {
  const flash = useFlash(fact.text);
  return (
    <li className={cn('-mx-2 px-2 py-1.5 rounded-md grid grid-cols-[5.5rem_1fr] gap-x-3 animate-slide-in', flash && 'animate-atlas-flash')}>
      <span className="text-xs text-fg-muted pt-px">{FACT_CATEGORY_LABEL[fact.category]}</span>
      <span className="text-[13px] leading-snug text-fg-primary text-pretty">{fact.text}</span>
    </li>
  );
}

const SEVERITY: Record<Concern['severity'], { label: string; tone: string }> = {
  mentioned: { label: 'Mentioned', tone: 'text-fg-secondary' },
  pressed: { label: 'Pressed', tone: 'text-qual-need' },
  blocking: { label: 'Blocking', tone: 'text-signal-negative font-medium' },
};

function ConcernRow({ concern }: { concern: Concern }) {
  const sev = SEVERITY[concern.severity];
  const flash = useFlash(`${concern.severity}|${concern.verbatim}`);
  return (
    <li className={cn('-mx-2 px-2 py-2 rounded-md animate-slide-in', flash && 'animate-atlas-flash')}>
      <div className="flex items-baseline gap-3">
        <span className="text-[13px] leading-snug text-fg-primary text-pretty">{concern.topic}</span>
        <span className={cn('ml-auto shrink-0 text-xs', sev.tone)}>{sev.label}</span>
      </div>
      {concern.verbatim && (
        <p className="mt-1 text-xs leading-snug text-fg-secondary italic line-clamp-2" title={concern.verbatim}>
          “{concern.verbatim}”
        </p>
      )}
    </li>
  );
}

function OpenLoopRow({ owner, description }: { owner: string; description: string }) {
  return (
    <li className="-mx-2 px-2 py-1.5 rounded-md grid grid-cols-[5.5rem_1fr] gap-x-3 animate-slide-in">
      <span className="text-xs font-medium text-fg-secondary pt-px truncate">{owner}</span>
      <span className="text-[13px] leading-snug text-fg-primary text-pretty">{description}</span>
    </li>
  );
}

const SENTIMENT_LABEL: Record<string, { label: string; tone: string } | undefined> = {
  positive: { label: 'Supportive', tone: 'text-signal-positive' },
  negative: { label: 'Skeptical', tone: 'text-signal-negative' },
};

function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <section aria-label={title}>
      <h3 className="flex items-baseline gap-1.5 text-xs font-semibold text-fg-secondary mb-1.5">
        {title}
        {count !== undefined && count > 0 && <span className="font-normal text-fg-muted tabular-nums">{count}</span>}
      </h3>
      {children}
    </section>
  );
}

// ─── Fact filter ────────────────────────────────────────────────────────────

// Suppress facts that restate context already shown in the persona header.
function filterRedundantFacts(facts: RelevantFact[], redundantPhrases: string[]): RelevantFact[] {
  if (redundantPhrases.length === 0) return facts;
  const patterns = redundantPhrases
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length > 3)
    .map((p) => new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`));
  if (patterns.length === 0) return facts;
  return facts.filter((f) => !patterns.some((re) => re.test(f.text.toLowerCase())));
}

// ─── Screen-reader announcements ────────────────────────────────────────────

function useAnnouncement(parts: { bant: Record<AxisKey, AxisCard>; facts: number; concerns: number; loops: number }): string {
  const prev = useRef<typeof parts | null>(null);
  const [message, setMessage] = useState('');
  const key = JSON.stringify(parts);
  useEffect(() => {
    const before = prev.current;
    prev.current = parts;
    if (!before) return;
    const changes: string[] = [];
    for (const k of AXIS_KEYS) {
      const a = certaintyOf(before.bant[k]);
      const b = certaintyOf(parts.bant[k]);
      if (a !== b || before.bant[k].headline !== parts.bant[k].headline) {
        if (b !== 'unknown') changes.push(`${AXIS_LABEL[k]}: ${CERTAINTY[b].label.toLowerCase()}, ${parts.bant[k].headline}`);
      }
    }
    if (parts.facts > before.facts) changes.push('New fact');
    if (parts.concerns > before.concerns) changes.push('New concern');
    if (parts.loops > before.loops) changes.push('New open loop');
    if (changes.length) setMessage(changes.join('. '));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return message;
}

// ─── Main panel ─────────────────────────────────────────────────────────────

const EMPTY_AXIS: AxisCard = { state: 'unknown', headline: null, detail: null, anchorTurnId: null, quote: null };
const EMPTY_BANT: Record<AxisKey, AxisCard> = {
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
  prospectName = 'Prospect',
}: {
  memory: MeetingMemory | null;
  factsUI?: CallFactsUI | null;
  className?: string;
  redundantPhrases?: string[];
  /** First name used for open-loop owners and the empty-state hint. */
  prospectName?: string;
}) {
  const baseClass = className ?? 'w-[360px] shrink-0 bg-bg-elevated border-l border-border';

  const bant = (factsUI?.bant ?? EMPTY_BANT) as Record<AxisKey, AxisCard>;
  const stakeholders = factsUI?.stakeholders ?? [];
  const openLoops = factsUI?.openLoops ?? [];
  const relevantFacts = filterRedundantFacts(factsUI?.relevantFacts ?? [], redundantPhrases);
  const activeConcerns = (memory?.concerns ?? []).filter((c) => !c.addressed);
  const pushNext = factsUI?.pushNext ?? null;

  const knownAxes = AXIS_KEYS.filter((k) => certaintyOf(bant[k]) !== 'unknown').length;
  const nothingYet =
    knownAxes === 0 && relevantFacts.length === 0 && activeConcerns.length === 0 &&
    openLoops.length === 0 && stakeholders.length === 0;

  const announcement = useAnnouncement({
    bant,
    facts: relevantFacts.length,
    concerns: activeConcerns.length,
    loops: openLoops.length,
  });

  const notRaised = [
    relevantFacts.length === 0 && 'facts',
    activeConcerns.length === 0 && 'concerns',
    openLoops.length === 0 && 'open loops',
    stakeholders.length === 0 && 'stakeholders',
  ].filter(Boolean) as string[];

  return (
    <aside className={cn(baseClass, 'h-full flex flex-col overflow-hidden')} aria-label="Live memory">
      <div className="px-4 py-3 border-b border-border flex items-baseline justify-between shrink-0">
        <h2 className="text-[13px] font-semibold text-fg-primary">Live memory</h2>
        <span className="text-xs text-fg-muted tabular-nums">{knownAxes}/4 qualified</span>
      </div>

      <p className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</p>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-6">
        {nothingYet && (
          <p className="text-[13px] leading-relaxed text-fg-secondary text-pretty">
            Atlas fills this in as {prospectName} talks: the need, the budget, who decides and by when.
            Every line comes from something said on the call.
          </p>
        )}

        {pushNext && !nothingYet && (
          <div className="rounded-lg bg-accent-soft px-3 py-2.5">
            <div className="text-xs font-semibold text-accent">Ask next</div>
            <p className="mt-0.5 text-[13px] leading-snug text-fg-primary text-pretty">{pushNext.humanPrompt}</p>
          </div>
        )}

        <Section title="Qualification">
          <ul className="divide-y divide-border">
            {AXIS_KEYS.map((k) => (
              <AxisRow key={k} axisKey={k} card={bant[k]} />
            ))}
          </ul>
        </Section>

        {relevantFacts.length > 0 && (
          <Section title="Facts" count={relevantFacts.length}>
            <ul>{relevantFacts.map((f) => <FactRow key={f.id} fact={f} />)}</ul>
          </Section>
        )}

        {activeConcerns.length > 0 && (
          <Section title="Concerns" count={activeConcerns.length}>
            <ul>{activeConcerns.map((c) => <ConcernRow key={c.id} concern={c} />)}</ul>
          </Section>
        )}

        {openLoops.length > 0 && (
          <Section title="Open loops" count={openLoops.length}>
            <ul>
              {openLoops.map((l) => (
                <OpenLoopRow
                  key={l.id}
                  owner={l.owner === 'rep' ? 'You' : prospectName}
                  description={l.description}
                />
              ))}
            </ul>
          </Section>
        )}

        {stakeholders.length > 0 && (
          <Section title="Stakeholders" count={stakeholders.length}>
            <ul className="space-y-1.5">
              {stakeholders.map((s) => {
                const sentiment = SENTIMENT_LABEL[s.sentiment];
                return (
                  <li key={s.name} className="text-[13px] leading-snug">
                    <span className="font-medium text-fg-primary">{s.name}</span>
                    <span className="text-fg-secondary"> · {s.role}</span>
                    {sentiment && <span className={cn('text-xs', sentiment.tone)}> · {sentiment.label}</span>}
                  </li>
                );
              })}
            </ul>
          </Section>
        )}

        {!nothingYet && notRaised.length > 0 && (
          <p className="text-xs text-fg-muted">
            Not raised yet: {notRaised.join(', ')}.
          </p>
        )}
      </div>
    </aside>
  );
}
