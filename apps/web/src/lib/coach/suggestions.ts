/**
 * Suggestion lifecycle for the rep's "Next move" card.
 *
 * Time is a poor test of relevance on a call: a budget question is still worth
 * asking five turns later if nobody asked it, while a reaction to one remark is
 * stale the moment the topic moves. So the CALL decides:
 *
 *  - The newest suggestion is "current".
 *  - When it is replaced, an unasked QUESTION parks in a small "Still open"
 *    tray (one slot per topic); a one-shot NOTE goes straight to history.
 *  - A parked question clears when the model says the latest turn covered it,
 *    when its qualification axis becomes confirmed, or when the rep marks it.
 *  - Age is only a backstop (about 8 turns or 5 minutes).
 *
 * Everything here is pure so it can be tested without React.
 */

export type SuggestionKind = 'question' | 'note';

export type SuggestionStatus =
  | 'current'
  | 'open' // parked in the tray
  | 'covered' // asked or answered during the call
  | 'asked' // rep marked it asked
  | 'dropped' // rep dismissed it
  | 'superseded' // replaced by a newer take on the same moment
  | 'expired'; // aged out

export type CoachSuggestion = {
  id: string;
  /** What the rep can say next. */
  content: string;
  /** One line on why it matters. */
  why?: string;
  kind: SuggestionKind;
  /** Qualification axis (need, budget, authority, timeline, …) or '' when general. */
  topic: string;
  reason?: string;
  ts: number;
  /** Utterance count when it arrived; used for the age backstop. */
  turn: number;
  status: SuggestionStatus;
  /** When it left current/open, so "Covered" can show briefly. */
  settledAt?: number;
};

export const MAX_OPEN = 5;
export const EXPIRE_AFTER_TURNS = 8;
export const EXPIRE_AFTER_MS = 5 * 60 * 1000;
/** How long a just-covered item lingers as "Covered" before it fades. */
export const COVERED_FLASH_MS = 1400;

const isLive = (s: CoachSuggestion) => s.status === 'current' || s.status === 'open';
const parkable = (s: CoachSuggestion) => s.kind === 'question';
const sameTopic = (a: string, b: string) => a !== '' && a === b;

/** A new suggestion arrives: it becomes current; the old current parks or retires. */
export function addSuggestion(
  list: CoachSuggestion[],
  incoming: Omit<CoachSuggestion, 'status' | 'settledAt'>,
  now: number,
): CoachSuggestion[] {
  if (list.some((s) => s.id === incoming.id)) return list;

  const next = list.map((s): CoachSuggestion => {
    if (s.status === 'current') {
      // A newer take on the same topic replaces it; a different-topic question parks.
      return parkable(s) && !sameTopic(s.topic, incoming.topic)
        ? { ...s, status: 'open' }
        : { ...s, status: 'superseded', settledAt: now };
    }
    // One slot per topic in the tray.
    if (s.status === 'open' && sameTopic(s.topic, incoming.topic)) {
      return { ...s, status: 'superseded', settledAt: now };
    }
    return s;
  });

  next.push({ ...incoming, status: 'current' });

  // Cap the tray: the oldest parked items age out first.
  const open = next.filter((s) => s.status === 'open').sort((a, b) => b.ts - a.ts);
  const overflow = new Set(open.slice(MAX_OPEN).map((s) => s.id));
  return overflow.size
    ? next.map((s) => (overflow.has(s.id) ? { ...s, status: 'expired' as const, settledAt: now } : s))
    : next;
}

/** The model reports these ids were asked by the rep or answered by the prospect. */
export function markCovered(list: CoachSuggestion[], ids: string[], now: number): CoachSuggestion[] {
  const set = new Set(ids);
  return list.map((s) => (set.has(s.id) && isLive(s) ? { ...s, status: 'covered', settledAt: now } : s));
}

/** Manual controls on a single item. */
export function settle(
  list: CoachSuggestion[],
  id: string,
  status: 'asked' | 'dropped',
  now: number,
): CoachSuggestion[] {
  return list.map((s) => (s.id === id && isLive(s) ? { ...s, status, settledAt: now } : s));
}

/** Make a parked item the current one; the current one parks (if it's a question) or retires. */
export function promote(list: CoachSuggestion[], id: string, now: number): CoachSuggestion[] {
  const target = list.find((s) => s.id === id);
  if (!target || target.status !== 'open') return list;
  return list.map((s) => {
    if (s.id === id) return { ...s, status: 'current' as const };
    if (s.status === 'current') {
      return parkable(s) ? { ...s, status: 'open' as const } : { ...s, status: 'superseded' as const, settledAt: now };
    }
    return s;
  });
}

export type SuggestionView = {
  /** The one thing to read right now. */
  current: CoachSuggestion | null;
  /** Unasked questions still worth asking, newest first. */
  tray: CoachSuggestion[];
  /** Items that were just covered; shown briefly as "Covered", then gone. */
  covering: CoachSuggestion[];
  /** Everything else, newest first. */
  history: CoachSuggestion[];
};

export type ViewContext = {
  now: number;
  /** Utterances so far. */
  turn: number;
  /** True when this qualification axis is confirmed, so questions about it are answered. */
  axisConfirmed: (topic: string) => boolean;
};

/**
 * What to render. Staleness rules are applied here (not stored), so they are
 * always evaluated against the live scorecard and clock.
 */
export function deriveView(list: CoachSuggestion[], ctx: ViewContext): SuggestionView {
  const stale = (s: CoachSuggestion) =>
    ctx.turn - s.turn >= EXPIRE_AFTER_TURNS || ctx.now - s.ts >= EXPIRE_AFTER_MS;
  const answered = (s: CoachSuggestion) => s.topic !== '' && ctx.axisConfirmed(s.topic);

  const byNewest = (a: CoachSuggestion, b: CoachSuggestion) => b.ts - a.ts;

  const open: CoachSuggestion[] = [];
  const history: CoachSuggestion[] = [];
  const covering: CoachSuggestion[] = [];
  let current: CoachSuggestion | null = null;

  for (const s of list) {
    if (s.status === 'current') {
      // The current item stays until replaced, unless the call already answered it.
      if (parkable(s) && answered(s)) history.push(s);
      else current = s;
    } else if (s.status === 'open') {
      if (answered(s) || stale(s)) history.push(s);
      else open.push(s);
    } else {
      if (s.status === 'covered' && s.settledAt !== undefined && ctx.now - s.settledAt < COVERED_FLASH_MS) {
        covering.push(s);
      }
      history.push(s);
    }
  }

  open.sort(byNewest);
  // If nothing is current (e.g. it was just covered), surface the newest parked question.
  if (!current && open.length) current = open.shift()!;

  return { current, tray: open, covering, history: history.sort(byNewest) };
}

/** What the model is told is still open: the current question plus the tray. */
export function openForModel(view: SuggestionView): { id: string; say: string; topic: string }[] {
  return [view.current, ...view.tray]
    .filter((s): s is CoachSuggestion => !!s && parkable(s))
    .slice(0, 8)
    .map((s) => ({ id: s.id, say: s.content.slice(0, 300), topic: s.topic }));
}

/** Coarse age for the tray: "now", "40s", "2m". */
export function ageLabel(ts: number, now: number): string {
  const sec = Math.max(0, Math.round((now - ts) / 1000));
  if (sec < 10) return 'now';
  if (sec < 60) return `${Math.round(sec / 10) * 10}s`;
  return `${Math.round(sec / 60)}m`;
}
