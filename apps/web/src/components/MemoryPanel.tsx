'use client';

import { useEffect, useRef, useState } from 'react';
import type { MeetingMemory, Concern, CallFactsUI, AxisCard, RelevantFact } from '@atlas/types';
import { cn } from '@/lib/cn';
import { type CoachSuggestion, type SuggestionStatus, type SuggestionView } from '@/lib/coach/suggestions';

// ─── Type scale ─────────────────────────────────────────────────────────────
// Four styles carry the whole panel. Color beyond these is reserved for status
// words (certainty, severity, sentiment).
const LEAD = 'text-[15px] font-medium leading-[1.35] text-fg-primary'; // the next move only
const BODY = 'text-[13px] leading-snug text-fg-primary';
const LABEL = 'text-[13px] font-medium text-fg-primary';
const META = 'text-xs text-fg-secondary';
const HEADING = 'text-xs font-medium text-fg-secondary';

const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent';

// ─── Change tracking ────────────────────────────────────────────────────────
// "Change is the story": a changed item tints and (for axes) opens to show the
// prospect's words for a few seconds, then settles. Reduced motion removes the
// animation (globals.css) but the content still shows.

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
const words = (s: string | null | undefined) => new Set(norm(s).split(' ').filter((w) => w.length >= 4));

/** True when one string already says (or contains) the other. */
function covers(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = norm(a), y = norm(b);
  return !!x && !!y && (x.includes(y) || y.includes(x));
}

/** True when most of `text`'s words already appear in `other`. */
function restates(text: string | null | undefined, other: string | null | undefined): boolean {
  const w = [...words(text)];
  if (w.length < 2) return covers(text, other);
  const o = words(other);
  return covers(text, other) || w.filter((x) => o.has(x)).length / w.length >= 0.8;
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

// Says how sure we are, not whether it's good news.
const CERTAINTY: Record<Certainty, { label: string; tone: string }> = {
  unknown: { label: 'Not yet heard', tone: 'text-fg-muted' },
  soft: { label: 'Unconfirmed', tone: 'text-signal-caution' },
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

/**
 * Two lines at a glance (name + status, then a one-line headline). Detail and
 * the prospect's own words open on click, and open by themselves for a few
 * seconds when the axis changes.
 */
function AxisRow({ axisKey, card, otherHeadlines }: { axisKey: AxisKey; card: AxisCard; otherHeadlines: string[] }) {
  const certainty = certaintyOf(card);
  const { label, tone } = CERTAINTY[certainty];
  const flash = useFlash(`${certainty}|${card.headline ?? ''}|${card.detail ?? ''}`);
  const [open, setOpen] = useState(false);

  if (certainty === 'unknown') {
    return (
      <li className="flex items-center gap-2 py-2">
        <CertaintyMark certainty={certainty} />
        <span className="text-[13px] font-medium text-fg-muted">{AXIS_LABEL[axisKey]}</span>
        <span className="ml-auto text-xs text-fg-muted">{label}</span>
      </li>
    );
  }

  const headlineIsQuote = !!card.quote && norm(card.headline) === norm(card.quote);
  const headline = tidy(card.headline);
  // Hide detail that repeats this headline or another axis's headline.
  const detail =
    !card.detail || restates(card.detail, card.headline) || otherHeadlines.some((h) => restates(card.detail, h))
      ? ''
      : tidy(card.detail);
  const quote =
    !card.quote || headlineIsQuote || covers(card.headline, card.quote) || covers(card.detail, card.quote)
      ? ''
      : tidy(card.quote);
  const hasMore = !!detail || !!quote || headline.length > 52;
  const expanded = hasMore && (open || flash);

  const body = (
    <>
      <span className="flex items-center gap-2">
        <CertaintyMark certainty={certainty} />
        <span className={LABEL}>{AXIS_LABEL[axisKey]}</span>
        <span className={cn('ml-auto text-xs', tone)}>{label}</span>
      </span>
      <span className={cn('mt-0.5 block pl-5', BODY, !expanded && 'line-clamp-1', headlineIsQuote && 'italic')}>
        {headlineIsQuote ? `“${headline}”` : headline}
      </span>
      {expanded && (detail || quote) && (
        <span className="mt-1 block space-y-1 pl-5">
          {detail && <span className={cn('block text-pretty', META)}>{detail}</span>}
          {quote && <span className={cn('block italic text-pretty', META)}>“{quote}”</span>}
        </span>
      )}
    </>
  );

  return (
    <li className={cn('-mx-2 rounded-md', flash && 'animate-atlas-flash')}>
      {hasMore ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={expanded}
          className={cn('block w-full rounded-md px-2 py-2 text-left transition-colors duration-150 hover:bg-bg-subtle/60', FOCUS)}
        >
          {body}
        </button>
      ) : (
        <div className="px-2 py-2">{body}</div>
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
    <svg viewBox="0 0 12 12" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 6.5 5 9l4.5-5.5" />
    </svg>
  );
}
function CloseIcon() {
  return (
    <svg viewBox="0 0 12 12" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
      <path d="M3 3l6 6M9 3 3 9" />
    </svg>
  );
}

const ICON_BTN = cn(
  'w-7 h-7 inline-flex items-center justify-center rounded-md text-fg-secondary transition-colors duration-150 hover:bg-white hover:text-fg-primary',
  FOCUS,
);
// Revealed on hover or keyboard focus; always visible where there is no hover.
const REVEAL = 'opacity-0 transition-opacity duration-150 group-hover/card:opacity-100 group-focus-within/card:opacity-100 [@media(hover:none)]:opacity-100';

type NextMoveProps = {
  view: SuggestionView;
  /** Template prompt for the next unfilled axis; used only before any suggestion exists. */
  fallbackPrompt: string | null;
  onAsked: (id: string) => void;
  onDrop: (id: string) => void;
  onPromote: (id: string) => void;
  onRestore: (id: string) => void;
};

/**
 * One job at a glance: what to say next. The reason shows for a moment when a
 * suggestion arrives (and again on hover/focus); controls appear on hover; the
 * other open questions live behind one quiet line.
 */
function NextMoveCard({ view, fallbackPrompt, onAsked, onDrop, onPromote, onRestore }: NextMoveProps) {
  const { current, tray, covering, undoable } = view;
  const [trayOpen, setTrayOpen] = useState(false);
  const [whyFresh, setWhyFresh] = useState(false);

  useEffect(() => {
    if (!current) return;
    setWhyFresh(true);
    const t = setTimeout(() => setWhyFresh(false), 5000);
    return () => clearTimeout(t);
  }, [current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (tray.length === 0) setTrayOpen(false);
  }, [tray.length]);

  if (!current && !fallbackPrompt) return null;

  let footer: React.ReactNode = null;
  if (undoable) {
    footer = (
      <span className={META}>
        {undoable.status === 'asked' ? 'Marked asked' : 'Dropped'} ·{' '}
        <button type="button" onClick={() => onRestore(undoable.id)} className={cn('rounded text-accent underline-offset-2 hover:underline', FOCUS)}>
          Undo
        </button>
      </span>
    );
  } else if (covering.length > 0) {
    footer = (
      <span className="flex min-w-0 items-center gap-1.5 text-xs text-signal-positive">
        <CheckIcon />
        <span className="shrink-0 font-medium">Covered</span>
        <span className="truncate text-fg-secondary">· {plain(covering[0].content)}</span>
      </span>
    );
  } else if (tray.length > 0) {
    footer = (
      <button
        type="button"
        onClick={() => setTrayOpen((v) => !v)}
        aria-expanded={trayOpen}
        aria-controls="still-open-list"
        className={cn('inline-flex min-h-6 items-center gap-2 rounded text-xs text-fg-secondary hover:text-fg-primary', FOCUS)}
      >
        {trayOpen ? 'Hide' : `${tray.length} more open`}
        <span className={cn('text-fg-muted', REVEAL)} aria-hidden="true">⌥. next</span>
      </button>
    );
  }

  return (
    <div className="group/card rounded-lg bg-accent-soft px-3.5 pb-2.5 pt-3" aria-label="Next move">
      {/* One announcement per new suggestion; nothing else in the card is live. */}
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {current ? `Next move: ${plain(current.content)}` : ''}
      </p>

      <div className="flex h-7 items-center gap-2">
        <span className="text-xs font-medium text-accent">Next move</span>
        {!current && <span className="text-xs text-fg-secondary">· suggested opener</span>}
        {current && (
          <span className={cn('ml-auto flex items-center gap-1', REVEAL)}>
            <span className="mr-1 hidden text-xs text-fg-muted [@media(hover:hover)]:inline" aria-hidden="true">⌥↵ · ⌥⌫</span>
            <button type="button" className={ICON_BTN} onClick={() => onAsked(current.id)} aria-label="Mark as asked" aria-keyshortcuts="Alt+Enter">
              <CheckIcon />
            </button>
            <button type="button" className={ICON_BTN} onClick={() => onDrop(current.id)} aria-label="Drop this suggestion" aria-keyshortcuts="Alt+Backspace">
              <CloseIcon />
            </button>
          </span>
        )}
      </div>

      {/* Keyed by id so a new suggestion eases in instead of swapping silently. */}
      <div key={current?.id ?? 'fallback'} className="animate-slide-in">
        <p className={cn(LEAD, 'line-clamp-3 text-pretty')} title={current ? plain(current.content) : undefined}>
          {current ? plain(current.content) : fallbackPrompt}
        </p>
        {current?.why && (
          <p
            className={cn(
              'mt-1 line-clamp-1',
              META,
              whyFresh ? 'block' : 'hidden group-hover/card:block group-focus-within/card:block',
            )}
          >
            {plain(current.why)}
          </p>
        )}
      </div>

      {footer && <div className="mt-2 flex min-h-6 items-center">{footer}</div>}

      {trayOpen && tray.length > 0 && (
        <ul id="still-open-list" aria-label="Other open questions" className="mt-1 space-y-0.5">
          {tray.map((s) => (
            <TrayRow key={s.id} s={s} onPromote={onPromote} onAsked={onAsked} onDrop={onDrop} />
          ))}
        </ul>
      )}
    </div>
  );
}

function TrayRow({
  s, onPromote, onAsked, onDrop,
}: {
  s: CoachSuggestion;
  onPromote: (id: string) => void;
  onAsked: (id: string) => void;
  onDrop: (id: string) => void;
}) {
  const topic = (AXIS_LABEL as Record<string, string>)[s.topic] ?? (s.topic ? tidy(s.topic) : '');
  return (
    <li className="group/row -mx-1.5 flex h-[30px] items-center gap-1 rounded-md px-1.5 hover:bg-white/70 focus-within:bg-white/70">
      <button
        type="button"
        onClick={() => onPromote(s.id)}
        className={cn('flex min-w-0 flex-1 items-center gap-2 rounded text-left', FOCUS)}
        aria-label={`Make next: ${plain(s.content)}`}
        title={plain(s.content)}
      >
        <span className={cn('min-w-0 flex-1 truncate', BODY)}>{plain(s.content)}</span>
        {topic && <span className="shrink-0 text-xs text-fg-muted">{topic}</span>}
      </button>
      <span className="flex shrink-0 items-center opacity-0 transition-opacity duration-150 group-hover/row:opacity-100 group-focus-within/row:opacity-100 [@media(hover:none)]:opacity-100">
        <button type="button" className={ICON_BTN} onClick={() => onAsked(s.id)} aria-label="Mark as asked">
          <CheckIcon />
        </button>
        <button type="button" className={ICON_BTN} onClick={() => onDrop(s.id)} aria-label="Drop this question">
          <CloseIcon />
        </button>
      </span>
    </li>
  );
}

// ─── Earlier suggestions (directly under the card) ──────────────────────────

function RestoreIcon() {
  return (
    <svg viewBox="0 0 12 12" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 5.5a3.5 3.5 0 1 1 1 2.6" />
      <path d="M2.5 2.5v3h3" />
    </svg>
  );
}

/** How each earlier suggestion left: an icon you can read at a glance, with the word for screen readers. */
function StatusGlyph({ status }: { status: SuggestionStatus }) {
  const label = STATUS_LABEL[status] ?? 'Earlier';
  const icon =
    status === 'covered' ? <span className="text-signal-positive"><CheckIcon /></span>
    : status === 'asked' ? <span className="text-fg-secondary"><CheckIcon /></span>
    : status === 'dropped' ? <span className="text-fg-muted"><CloseIcon /></span>
    : <span className="block h-1.5 w-1.5 rounded-full bg-fg-muted/60" />;
  return (
    <span className="mt-[3px] flex h-3.5 w-3.5 shrink-0 items-center justify-center" title={label}>
      {icon}
      <span className="sr-only">{label}:</span>
    </span>
  );
}

/**
 * Quiet by default: one line under the card. Opens to a short, scrollable list
 * in the same rhythm as the card, newest first. Any item can be brought back.
 */
function EarlierSuggestions({ items, onRestore }: { items: CoachSuggestion[]; onRestore: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  return (
    <div className="mt-1.5 px-3.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="earlier-suggestions"
        className={cn('inline-flex min-h-6 items-center gap-1 rounded text-xs text-fg-secondary transition-colors duration-150 hover:text-fg-primary', FOCUS)}
      >
        <svg viewBox="0 0 12 12" className={cn('h-3 w-3 transition-transform duration-150', open && 'rotate-90')} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4.5 2.5 8 6l-3.5 3.5" />
        </svg>
        Earlier
        <span className="tabular-nums text-fg-muted">{items.length}</span>
      </button>
      {open && (
        <ul id="earlier-suggestions" aria-label="Earlier suggestions" className="mt-1 max-h-44 overflow-y-auto pr-1">
          {items.map((s) => (
            <li key={s.id} className="group/earlier flex items-start gap-2 py-1.5">
              <StatusGlyph status={s.status} />
              <span className="min-w-0 flex-1 text-[13px] leading-snug text-fg-secondary line-clamp-2" title={plain(s.content)}>
                {plain(s.content)}
              </span>
              <button
                type="button"
                onClick={() => onRestore(s.id)}
                aria-label={`Bring back: ${plain(s.content)}`}
                title="Bring back"
                className={cn(
                  '-my-1 w-7 h-7 shrink-0 inline-flex items-center justify-center rounded-md text-fg-secondary transition-[opacity,color,background-color] duration-150 hover:bg-bg-subtle hover:text-fg-primary',
                  'opacity-0 group-hover/earlier:opacity-100 group-focus-within/earlier:opacity-100 [@media(hover:none)]:opacity-100',
                  FOCUS,
                )}
              >
                <RestoreIcon />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ─── Record sections ────────────────────────────────────────────────────────

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
    <li className={cn('-mx-2 grid grid-cols-[4.75rem_1fr] gap-x-3 rounded-md px-2 py-1.5 animate-slide-in', flash && 'animate-atlas-flash')}>
      <span className="pt-px text-xs text-fg-muted">{FACT_CATEGORY_LABEL[fact.category]}</span>
      <span className={cn(BODY, 'text-pretty')}>{tidy(fact.text)}</span>
    </li>
  );
}

// Color only where it changes what the rep does: red for a blocker.
const SEVERITY: Record<Concern['severity'], { label: string; tone: string }> = {
  mentioned: { label: 'Mentioned', tone: 'text-fg-secondary' },
  pressed: { label: 'Pressed', tone: 'text-fg-secondary font-medium' },
  blocking: { label: 'Blocking', tone: 'text-signal-negative font-medium' },
};

function ConcernRow({ concern }: { concern: Concern }) {
  const sev = SEVERITY[concern.severity];
  const flash = useFlash(`${concern.severity}|${concern.verbatim}`);
  const [open, setOpen] = useState(false);
  const quote = concern.verbatim && !covers(concern.topic, concern.verbatim) ? tidy(concern.verbatim) : '';
  const expanded = !!quote && (open || flash);
  return (
    <li className={cn('-mx-2 rounded-md animate-slide-in', flash && 'animate-atlas-flash')}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={quote ? expanded : undefined}
        disabled={!quote}
        className={cn('block w-full rounded-md px-2 py-2 text-left transition-colors duration-150 enabled:hover:bg-bg-subtle/60 disabled:cursor-default', FOCUS)}
      >
        <span className="flex items-baseline gap-3">
          <span className={cn(BODY, 'min-w-0 flex-1', !expanded && 'line-clamp-1')}>{tidy(concern.topic)}</span>
          <span className={cn('shrink-0 text-xs', sev.tone)}>{sev.label}</span>
        </span>
        {expanded && <span className={cn('mt-1 block italic', META)}>“{quote}”</span>}
      </button>
    </li>
  );
}

const SENTIMENT_LABEL: Record<string, { label: string; tone: string } | undefined> = {
  positive: { label: 'Supportive', tone: 'text-signal-positive' },
  negative: { label: 'Skeptical', tone: 'text-signal-negative' },
};

function Section({
  title, aside, children,
}: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section aria-label={title}>
      <h3 className={cn('mb-1 flex items-baseline justify-between gap-2', HEADING)}>
        {title}
        {aside}
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

/** Facts already said in an axis line (headline, detail or quote) aren't repeated below it. */
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

// A follow-up the PROSPECT owes ("Provide budget information") is answered once
// that axis has content. The rep's own commitments always stay.
const LOOP_AXIS_HINTS: Record<AxisKey, RegExp> = {
  budget: /budget|cost|pric|spend|funding|approv/i,
  timeline: /timeline|deadline|timing|\bwhen\b|date/i,
  authority: /decision|decide|sign.?off|authority|approver|stakeholder|\bwho\b/i,
  need: /\bpain\b|\bneed\b|problem|priorit|goal|challenge/i,
};

/** The extractor sometimes tags "Prospect shares X" as the rep's. Trust the wording. */
function loopOwner(owner: 'rep' | 'customer', description: string): { owner: 'rep' | 'customer'; text: string } {
  const m = description.match(/^\s*(the\s+)?(prospect|customer|client)\s+(.*)$/i);
  if (m) return { owner: 'customer', text: m[3] };
  return { owner, text: description };
}

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
    if (parts.loops > before.loops) changes.push('New follow-up');
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
const EMPTY_VIEW: SuggestionView = { current: null, tray: [], covering: [], history: [], undoable: null };
const FACTS_SHOWN = 3;

export function MemoryPanel({
  memory,
  factsUI,
  view = EMPTY_VIEW,
  onAsked = () => {},
  onDrop = () => {},
  onPromote = () => {},
  onRestore = () => {},
  className,
  redundantPhrases = [],
  prospectName = 'Prospect',
}: {
  memory: MeetingMemory | null;
  factsUI?: CallFactsUI | null;
  /** Live coaching: current suggestion, still-open questions, history. */
  view?: SuggestionView;
  /** Kept for API compatibility; ages are no longer shown. */
  now?: number;
  onAsked?: (id: string) => void;
  onDrop?: (id: string) => void;
  onPromote?: (id: string) => void;
  onRestore?: (id: string) => void;
  className?: string;
  redundantPhrases?: string[];
  /** First name used for follow-up owners and the empty-state hint. */
  prospectName?: string;
}) {
  const baseClass = className ?? 'w-[360px] shrink-0 bg-bg-elevated border-l border-border';
  const [scrolled, setScrolled] = useState(false);
  const [allFacts, setAllFacts] = useState(false);

  const bant = (factsUI?.bant ?? EMPTY_BANT) as Record<AxisKey, AxisCard>;
  const certainty = Object.fromEntries(AXIS_KEYS.map((k) => [k, certaintyOf(bant[k])])) as Record<AxisKey, Certainty>;
  const confirmed = AXIS_KEYS.filter((k) => certainty[k] === 'firm').length;
  const atRisk = AXIS_KEYS.filter((k) => certainty[k] === 'blocked').length;
  const known = AXIS_KEYS.filter((k) => certainty[k] !== 'unknown').length;

  const axisText = AXIS_KEYS.map((k) => `${bant[k].headline ?? ''} ${bant[k].detail ?? ''} ${bant[k].quote ?? ''}`).join(' ');
  const headlines = Object.fromEntries(AXIS_KEYS.map((k) => [k, certainty[k] === 'unknown' ? '' : bant[k].headline ?? ''])) as Record<AxisKey, string>;

  const relevantFacts = dropRepeatedFacts(filterRedundantFacts(factsUI?.relevantFacts ?? [], redundantPhrases), axisText);
  const activeConcerns = (memory?.concerns ?? []).filter((c) => !c.addressed);
  const followUps = (factsUI?.openLoops ?? [])
    .map((l) => ({ id: l.id, ...loopOwner(l.owner, l.description) }))
    .filter((l) => l.owner !== 'customer' || !AXIS_KEYS.some((k) => certainty[k] !== 'unknown' && LOOP_AXIS_HINTS[k].test(l.text)));
  const stakeholders = (factsUI?.stakeholders ?? []).filter((s) => !isStakeholderRedundant(s.name, s.role, axisText));
  const pushNext = factsUI?.pushNext ?? null;
  const earlier = view.history;

  const nothingYet =
    known === 0 && relevantFacts.length === 0 && activeConcerns.length === 0 &&
    stakeholders.length === 0 && !view.current;

  const announcement = useAnnouncement({
    bant,
    facts: relevantFacts.length,
    concerns: activeConcerns.length,
    loops: followUps.length,
  });

  // Alt+. cycles through open questions, Alt+Enter marks the current one asked,
  // Alt+Backspace drops it. Modifier chords so typing is never hijacked.
  const viewRef = useRef(view);
  viewRef.current = view;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.metaKey || e.ctrlKey) return;
      const v = viewRef.current;
      const oldest = v.tray[v.tray.length - 1];
      if (e.code === 'Period' && oldest) { e.preventDefault(); onPromote(oldest.id); }
      else if (e.key === 'Enter' && v.current) { e.preventDefault(); onAsked(v.current.id); }
      else if (e.key === 'Backspace' && v.current) { e.preventDefault(); onDrop(v.current.id); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onAsked, onDrop, onPromote]);

  const hasCard = !!view.current || !!pushNext;
  const visibleFacts = allFacts ? relevantFacts : relevantFacts.slice(0, FACTS_SHOWN);

  return (
    <aside className={cn(baseClass, 'flex h-full flex-col overflow-hidden')} aria-label="Live memory">
      {/* Pinned: a new suggestion is never off-screen. A soft edge appears only while the record scrolls under it. */}
      {hasCard && (
        <div
          className={cn(
            'relative z-10 shrink-0 px-4 pb-3 pt-3 transition-shadow duration-200',
            scrolled && 'shadow-[0_10px_12px_-12px_rgba(28,25,23,0.28)]',
          )}
        >
          <NextMoveCard
            view={view}
            fallbackPrompt={pushNext ? pushNext.humanPrompt : null}
            onAsked={onAsked}
            onDrop={onDrop}
            onPromote={onPromote}
            onRestore={onRestore}
          />
          <EarlierSuggestions items={earlier} onRestore={onRestore} />
        </div>
      )}

      <p className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</p>

      <div
        className={cn('flex-1 space-y-5 overflow-y-auto px-4 pb-6', hasCard ? 'pt-2' : 'pt-4')}
        onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 2)}
      >
        {nothingYet && (
          <p className={cn(BODY, 'text-fg-secondary text-pretty')}>
            Atlas fills this in as {prospectName} talks. Every line comes from something said on the call.
          </p>
        )}

        <Section
          title="Qualification"
          aside={
            known > 0 ? (
              <span className="font-normal tabular-nums">
                <span className="text-fg-muted">{confirmed} of 4 confirmed</span>
                {atRisk > 0 && <span className="text-signal-negative"> · {atRisk} at risk</span>}
              </span>
            ) : undefined
          }
        >
          <ul>
            {AXIS_KEYS.map((k) => (
              <AxisRow
                key={k}
                axisKey={k}
                card={bant[k]}
                otherHeadlines={AXIS_KEYS.filter((o) => o !== k).map((o) => headlines[o]).filter(Boolean)}
              />
            ))}
          </ul>
        </Section>

        {activeConcerns.length > 0 && (
          <Section title="Concerns">
            <ul>{activeConcerns.map((c) => <ConcernRow key={c.id} concern={c} />)}</ul>
          </Section>
        )}

        {known > 0 && followUps.length > 0 && (
          <Section title="Follow-ups">
            <ul>
              {followUps.map((l) => (
                <li key={l.id} className="-mx-2 grid grid-cols-[4.75rem_1fr] gap-x-3 rounded-md px-2 py-1.5 animate-slide-in">
                  <span className="truncate pt-px text-xs text-fg-secondary">{l.owner === 'rep' ? 'You' : prospectName}</span>
                  <span className={cn(BODY, 'text-pretty')}>{tidy(l.text)}</span>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {relevantFacts.length > 0 && (
          <Section title="Facts">
            <ul>{visibleFacts.map((f) => <FactRow key={f.id} fact={f} />)}</ul>
            {relevantFacts.length > FACTS_SHOWN && (
              <button
                type="button"
                onClick={() => setAllFacts((v) => !v)}
                aria-expanded={allFacts}
                className={cn('mt-0.5 inline-flex min-h-6 items-center rounded text-xs text-fg-secondary hover:text-fg-primary', FOCUS)}
              >
                {allFacts ? 'Show fewer' : `+${relevantFacts.length - FACTS_SHOWN} more`}
              </button>
            )}
          </Section>
        )}

        {stakeholders.length > 0 && (
          <Section title="Stakeholders">
            <ul className="space-y-1.5">
              {stakeholders.map((s) => {
                const sentiment = SENTIMENT_LABEL[s.sentiment];
                return (
                  <li key={s.name} className={BODY}>
                    <span className="font-medium">{s.name}</span>
                    <span className="text-fg-secondary"> · {tidy(s.role)}</span>
                    {sentiment && <span className={cn('text-xs', sentiment.tone)}> · {sentiment.label}</span>}
                  </li>
                );
              })}
            </ul>
          </Section>
        )}

      </div>
    </aside>
  );
}
