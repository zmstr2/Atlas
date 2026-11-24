'use client';

import { useEffect, useRef, useState } from 'react';
import type { MeetingMemory, Concern, CallFactsUI, AxisCard, RelevantFact } from '@atlas/types';
import { cn } from '@/lib/cn';
import { ageLabel, type CoachSuggestion, type SuggestionStatus, type SuggestionView } from '@/lib/coach/suggestions';

// ─── Change tracking ────────────────────────────────────────────────────────
// "Change is the story": an item whose content changes gets a tint that fades
// slowly, long enough for a glancing rep to catch it. Reduced motion collapses
// the animation (globals.css).

const FLASH_MS = 4000;

function useFlash(signature: string): boolean {
  const prev = useRef(signature);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (prev.current === signature) return;
    prev.current = signature;
    setFlash(true);
    const t = setTimeout(() => setFlash(false), FLASH_MS);
    return () => clearTimeout(t);
  }, [signature]);
  return flash;
}

// ─── Text helpers ───────────────────────────────────────────────────────────

/** Sentence case, no wrapping quotes, no trailing period. */
function tidy(text: string | null | undefined): string {
  const t = (text ?? '').trim().replace(/^["“”']+|["“”']+$/g, '').replace(/[.]+$/, '').trim();
  return t ? t[0].toUpperCase() + t.slice(1) : '';
}

const norm = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** True when one string already says (or contains) the other. */
function covers(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = norm(a), y = norm(b);
  return !!x && !!y && (x.includes(y) || y.includes(x));
}

/** Plain text for display: suggestions can arrive with light markdown. */
const plain = (s: string) => s.replace(/[*_`]/g, '').trim();

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

// "Unconfirmed" says how sure we are, not whether it's good news ("Partial"
// read like progress even when the prospect said no).
const CERTAINTY: Record<Certainty, { label: string; tone: string }> = {
  unknown: { label: 'Not yet heard', tone: 'text-fg-muted' },
  soft: { label: 'Unconfirmed', tone: 'text-qual-need' },
  firm: { label: 'Confirmed', tone: 'text-signal-positive' },
  blocked: { label: 'At risk', tone: 'text-signal-negative' },
};

/** Certainty as a shape (not just a color): dashed, half, full, struck. */
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

  // When the headline IS the prospect's raw words (the panel agent hasn't
  // summarised yet), show it once, as a quote.
  const headlineIsQuote = !!card.quote && norm(card.headline) === norm(card.quote);
  const headline = tidy(card.headline);
  const detail = covers(card.headline, card.detail) ? '' : tidy(card.detail);
  const quote =
    !card.quote || headlineIsQuote || covers(card.headline, card.quote) || covers(card.detail, card.quote)
      ? ''
      : tidy(card.quote);

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
          <p className={cn('text-[13px] leading-snug text-fg-primary text-pretty', headlineIsQuote && 'italic')}>
            {headlineIsQuote ? `“${headline}”` : headline}
          </p>
          {detail && <p className="text-xs leading-snug text-fg-secondary text-pretty">{detail}</p>}
          {quote && (
            <p className="text-xs leading-snug text-fg-secondary italic line-clamp-2" title={quote}>
              “{quote}”
            </p>
          )}
        </div>
      )}
    </li>
  );
}

// ─── Next move (pinned) ─────────────────────────────────────────────────────

const STATUS_LABEL: Partial<Record<SuggestionStatus, string>> = {
  covered: 'Covered',
  asked: 'Asked',
  dropped: 'Dropped',
  expired: 'Expired',
  superseded: 'Replaced',
};

function CheckIcon() {
  return (
    <svg viewBox="0 0 12 12" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 6.5 5 9l4.5-5.5" />
    </svg>
  );
}
function CloseIcon() {
  return (
    <svg viewBox="0 0 12 12" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
      <path d="M3 3l6 6M9 3 3 9" />
    </svg>
  );
}

const ICON_BTN =
  'w-6 h-6 inline-flex items-center justify-center rounded text-fg-secondary transition-colors duration-150 ' +
  'hover:bg-white hover:text-fg-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent';

type NextMoveProps = {
  view: SuggestionView;
  now: number;
  /** Template prompt for the next unfilled axis; used only before any suggestion exists. */
  fallbackPrompt: string | null;
  onAsked: (id: string) => void;
  onDrop: (id: string) => void;
  onPromote: (id: string) => void;
};

/**
 * The one place live coaching shows up.
 *  - Current: what to say next, big, with a one-line reason.
 *  - Still open: unasked questions that are still worth asking (cleared by the
 *    call itself, never piling up past a few).
 *  - History: everything else, one click away.
 */
function NextMoveCard({ view, now, fallbackPrompt, onAsked, onDrop, onPromote }: NextMoveProps) {
  const [expanded, setExpanded] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const { current, tray, covering, history } = view;

  if (!current && !fallbackPrompt && tray.length === 0 && covering.length === 0) return null;

  const visible = expanded ? tray : tray.slice(0, 2);
  const hidden = tray.length - visible.length;

  return (
    <div className="rounded-lg bg-accent-soft px-3 py-2.5" aria-label="Next move" aria-keyshortcuts="Alt+Period Alt+Enter Alt+Backspace">
      {/* One announcement per new suggestion; nothing else in the card is live. */}
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {current ? `Next move: ${plain(current.content)}` : ''}
      </p>

      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold text-accent">{current ? 'Next move' : 'Ask next'}</span>
        {current && <span className="text-xs text-fg-secondary tabular-nums">{ageLabel(current.ts, now)}</span>}
        {current && (
          <span className="ml-auto flex items-center gap-1">
            <button type="button" className={ICON_BTN} onClick={() => onAsked(current.id)} aria-label="Mark as asked" title="Asked (Alt+Enter)">
              <CheckIcon />
            </button>
            <button type="button" className={ICON_BTN} onClick={() => onDrop(current.id)} aria-label="Drop this suggestion" title="Drop (Alt+Backspace)">
              <CloseIcon />
            </button>
          </span>
        )}
      </div>

      {/* Keyed by id so a new suggestion eases in instead of swapping silently. */}
      <div key={current?.id ?? 'fallback'} className="mt-1 animate-slide-in">
        <p className="text-[15px] font-medium leading-snug text-fg-primary text-pretty">
          {current ? plain(current.content) : fallbackPrompt}
        </p>
        {current?.why && <p className="mt-1 text-xs leading-snug text-fg-secondary text-pretty">{plain(current.why)}</p>}
      </div>

      {(tray.length > 0 || covering.length > 0) && (
        <div className="mt-3 border-t border-accent/15 pt-2">
          <h3 className="text-xs font-semibold text-fg-secondary">
            Still open{tray.length > 0 && <span className="ml-1.5 font-normal tabular-nums">{tray.length}</span>}
          </h3>
          <ul aria-label="Still open questions" className="mt-1">
            {covering.map((s) => (
              <li key={`c-${s.id}`} className="flex items-center gap-2 py-1.5 text-xs text-signal-positive animate-slide-in">
                <CheckIcon />
                <span className="font-medium">Covered</span>
                <span className="truncate text-fg-secondary line-through decoration-fg-muted/50">{plain(s.content)}</span>
              </li>
            ))}
            {visible.map((s) => (
              <TrayRow key={s.id} s={s} now={now} onPromote={onPromote} onAsked={onAsked} onDrop={onDrop} />
            ))}
          </ul>
          {hidden > 0 && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="mt-0.5 inline-flex min-h-6 items-center text-xs text-accent underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded"
            >
              +{hidden} more
            </button>
          )}
        </div>
      )}

      {history.length > 0 && (
        <div className="mt-1.5">
          <button
            type="button"
            onClick={() => setShowHistory((v) => !v)}
            aria-expanded={showHistory}
            aria-controls="suggestion-history"
            className="inline-flex min-h-6 items-center text-xs text-fg-secondary underline-offset-2 hover:underline hover:text-fg-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded"
          >
            {showHistory ? 'Hide history' : `History (${history.length})`}
          </button>
          {showHistory && (
            <ul id="suggestion-history" className="mt-1 max-h-40 space-y-1.5 overflow-y-auto border-t border-accent/15 pt-2">
              {history.map((s) => (
                <li key={s.id} className="flex items-baseline gap-2 text-xs leading-snug text-fg-secondary">
                  <span className="shrink-0 w-[4.5rem] text-fg-muted">{STATUS_LABEL[s.status] ?? ''}</span>
                  <span className="text-pretty">{plain(s.content)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function TrayRow({
  s, now, onPromote, onAsked, onDrop,
}: {
  s: CoachSuggestion;
  now: number;
  onPromote: (id: string) => void;
  onAsked: (id: string) => void;
  onDrop: (id: string) => void;
}) {
  const topic = (AXIS_LABEL as Record<string, string>)[s.topic] ?? (s.topic ? tidy(s.topic) : '');
  return (
    <li className="group -mx-1.5 flex items-start gap-1 rounded-md px-1.5 py-1 hover:bg-white/70 focus-within:bg-white/70">
      <button
        type="button"
        onClick={() => onPromote(s.id)}
        className="min-w-0 flex-1 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        aria-label={`Open question${topic ? ` about ${topic}` : ''}, ${ageLabel(s.ts, now)} ago: ${plain(s.content)}. Press to make it the next move.`}
      >
        <span className="block text-xs leading-snug text-fg-primary line-clamp-2">{plain(s.content)}</span>
        <span className="mt-0.5 block text-xs text-fg-secondary tabular-nums">
          {topic && <span>{topic} · </span>}
          {ageLabel(s.ts, now)}
        </span>
      </button>
      {/* Hover/focus on desktop; always visible where there is no hover. */}
      <span className="flex shrink-0 items-center opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100">
        <button type="button" className={ICON_BTN} onClick={() => onAsked(s.id)} aria-label="Mark as asked" title="Asked">
          <CheckIcon />
        </button>
        <button type="button" className={ICON_BTN} onClick={() => onDrop(s.id)} aria-label="Drop this question" title="Drop">
          <CloseIcon />
        </button>
      </span>
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
      <span className="text-[13px] leading-snug text-fg-primary text-pretty">{tidy(fact.text)}</span>
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
        <span className="text-[13px] leading-snug text-fg-primary text-pretty">{tidy(concern.topic)}</span>
        <span className={cn('ml-auto shrink-0 text-xs', sev.tone)}>{sev.label}</span>
      </div>
      {concern.verbatim && (
        <p className="mt-1 text-xs leading-snug text-fg-secondary italic line-clamp-2" title={concern.verbatim}>
          “{tidy(concern.verbatim)}”
        </p>
      )}
    </li>
  );
}

function OpenLoopRow({ owner, description }: { owner: string; description: string }) {
  return (
    <li className="-mx-2 px-2 py-1.5 rounded-md grid grid-cols-[5.5rem_1fr] gap-x-3 animate-slide-in">
      <span className="text-xs font-medium text-fg-secondary pt-px truncate">{owner}</span>
      <span className="text-[13px] leading-snug text-fg-primary text-pretty">{tidy(description)}</span>
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
        {count !== undefined && count > 0 && <span className="font-normal text-fg-secondary tabular-nums">{count}</span>}
      </h3>
      {children}
    </section>
  );
}

// ─── De-duplication ─────────────────────────────────────────────────────────

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

const words = (s: string) => new Set(norm(s).split(' ').filter((w) => w.length >= 4));

/** Facts already said in an axis line shouldn't be repeated below it. */
function dropRepeatedFacts(facts: RelevantFact[], axisText: string): RelevantFact[] {
  const corpus = words(axisText);
  return facts.filter((f) => {
    const w = [...words(f.text)];
    if (w.length < 3) return true;
    return w.filter((x) => corpus.has(x)).length / w.length < 0.7;
  });
}

/** A stakeholder whose name and role are already spelled out in an axis line is noise. */
function isStakeholderRedundant(name: string, role: string, axisText: string): boolean {
  if (!norm(axisText).includes(norm(name))) return false;
  const rw = [...words(role)];
  if (rw.length === 0) return true;
  const corpus = words(axisText);
  return rw.filter((x) => corpus.has(x)).length / rw.length >= 0.5;
}

// An open loop the PROSPECT owes us ("Provide budget information") is answered
// once that axis has content. Rep-owned loops are commitments and always stay.
const LOOP_AXIS_HINTS: Record<AxisKey, RegExp> = {
  budget: /budget|cost|pric|spend|funding|approv/i,
  timeline: /timeline|deadline|timing|\bwhen\b|date/i,
  authority: /decision|decide|sign.?off|authority|approver|stakeholder|\bwho\b/i,
  need: /\bpain\b|\bneed\b|problem|priorit|goal|challenge/i,
};

// ─── Screen-reader announcements for the memory record ──────────────────────

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
        if (b !== 'unknown') changes.push(`${AXIS_LABEL[k]}: ${CERTAINTY[b].label.toLowerCase()}, ${tidy(parts.bant[k].headline)}`);
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
const EMPTY_VIEW: SuggestionView = { current: null, tray: [], covering: [], history: [] };

export function MemoryPanel({
  memory,
  factsUI,
  view = EMPTY_VIEW,
  now = 0,
  onAsked = () => {},
  onDrop = () => {},
  onPromote = () => {},
  className,
  redundantPhrases = [],
  prospectName = 'Prospect',
}: {
  memory: MeetingMemory | null;
  factsUI?: CallFactsUI | null;
  /** Live coaching: current suggestion, still-open tray, history. */
  view?: SuggestionView;
  now?: number;
  onAsked?: (id: string) => void;
  onDrop?: (id: string) => void;
  onPromote?: (id: string) => void;
  className?: string;
  redundantPhrases?: string[];
  /** First name used for open-loop owners and the empty-state hint. */
  prospectName?: string;
}) {
  const baseClass = className ?? 'w-[360px] shrink-0 bg-bg-elevated border-l border-border';

  const bant = (factsUI?.bant ?? EMPTY_BANT) as Record<AxisKey, AxisCard>;
  const certainty = Object.fromEntries(AXIS_KEYS.map((k) => [k, certaintyOf(bant[k])])) as Record<AxisKey, Certainty>;
  const confirmed = AXIS_KEYS.filter((k) => certainty[k] === 'firm').length;
  const atRisk = AXIS_KEYS.filter((k) => certainty[k] === 'blocked').length;
  const known = AXIS_KEYS.filter((k) => certainty[k] !== 'unknown').length;

  const axisText = AXIS_KEYS.map((k) => `${bant[k].headline ?? ''} ${bant[k].detail ?? ''} ${bant[k].quote ?? ''}`).join(' ');

  const relevantFacts = dropRepeatedFacts(
    filterRedundantFacts(factsUI?.relevantFacts ?? [], redundantPhrases),
    axisText,
  );
  const activeConcerns = (memory?.concerns ?? []).filter((c) => !c.addressed);
  const openLoops = (factsUI?.openLoops ?? []).filter((l) => {
    if (l.owner !== 'customer') return true;
    return !AXIS_KEYS.some((k) => certainty[k] !== 'unknown' && LOOP_AXIS_HINTS[k].test(l.description));
  });
  const stakeholders = (factsUI?.stakeholders ?? []).filter((s) => !isStakeholderRedundant(s.name, s.role, axisText));
  const pushNext = factsUI?.pushNext ?? null;

  const nothingYet =
    known === 0 && relevantFacts.length === 0 && activeConcerns.length === 0 &&
    openLoops.length === 0 && stakeholders.length === 0 && !view.current;

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

  // Alt+. brings the next open question forward, Alt+Enter marks the current
  // one asked, Alt+Backspace drops it. Modifier chords so typing is never hijacked.
  const viewRef = useRef(view);
  viewRef.current = view;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.metaKey || e.ctrlKey) return;
      const v = viewRef.current;
      if (e.code === 'Period' && v.tray[0]) { e.preventDefault(); onPromote(v.tray[0].id); }
      else if (e.key === 'Enter' && v.current) { e.preventDefault(); onAsked(v.current.id); }
      else if (e.key === 'Backspace' && v.current) { e.preventDefault(); onDrop(v.current.id); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onAsked, onDrop, onPromote]);

  const summary =
    confirmed === 0 && atRisk === 0
      ? ''
      : `${confirmed}/4 confirmed${atRisk > 0 ? ` · ${atRisk} at risk` : ''}`;

  return (
    <aside className={cn(baseClass, 'h-full flex flex-col overflow-hidden')} aria-label="Live memory">
      <div className="px-4 py-3 border-b border-border flex items-baseline justify-between shrink-0">
        <h2 className="text-[13px] font-semibold text-fg-primary">Live memory</h2>
        {summary && <span className="text-xs text-fg-secondary tabular-nums">{summary}</span>}
      </div>

      {/* Pinned: a new suggestion is never off-screen, whatever the record below holds. */}
      {!nothingYet && (
        <div className="shrink-0 px-4 pt-3 pb-3 border-b border-border">
          <NextMoveCard
            view={view}
            now={now}
            fallbackPrompt={pushNext ? pushNext.humanPrompt : null}
            onAsked={onAsked}
            onDrop={onDrop}
            onPromote={onPromote}
          />
        </div>
      )}

      <p className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</p>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-6">
        {nothingYet && (
          <p className="text-[13px] leading-relaxed text-fg-secondary text-pretty">
            Atlas fills this in as {prospectName} talks: the need, the budget, who decides and by when.
            Every line comes from something said on the call.
          </p>
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
                    <span className="text-fg-secondary"> · {tidy(s.role)}</span>
                    {sentiment && <span className={cn('text-xs', sentiment.tone)}> · {sentiment.label}</span>}
                  </li>
                );
              })}
            </ul>
          </Section>
        )}

        {!nothingYet && notRaised.length > 0 && (
          <p className="text-xs text-fg-secondary">
            Not raised yet: {notRaised.join(', ')}.
          </p>
        )}
      </div>
    </aside>
  );
}
