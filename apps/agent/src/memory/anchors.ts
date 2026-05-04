import type { MeetingMemory, VerbatimAnchor } from '@atlas/types';

export type AnchorContradiction = {
  anchor: VerbatimAnchor;
  axis: VerbatimAnchor['axis'];
  reason: string;
  matchedText: string;
};

const NUMERIC_WORD: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, thousand: 1000,
};

/**
 * Extract dollar amounts from text. Handles: $30k, 30000, "30 thousand", "twenty-five thousand",
 * "30-50k", "$30 to $50k". Returns numbers in dollars.
 */
function extractDollarAmounts(text: string): number[] {
  const out: number[] = [];
  const lower = text.toLowerCase();

  // $X, $Xk, $X thousand, Xk
  const reNum = /\$?\s*([0-9]+(?:\.[0-9]+)?)\s*(k|m|thousand|million)?/g;
  let m: RegExpExecArray | null;
  while ((m = reNum.exec(lower)) !== null) {
    const n = parseFloat(m[1]);
    const suf = m[2];
    let v = n;
    if (suf === 'k' || suf === 'thousand') v *= 1000;
    if (suf === 'm' || suf === 'million') v *= 1_000_000;
    if (v >= 100) out.push(v); // ignore tiny numbers like "1 thing" or "2 people"
  }

  // simple word-based amounts: "twenty thousand", "twenty-five thousand"
  const reWord = /(?:(\w+)[-\s])?(\w+)\s+(thousand|million)/g;
  while ((m = reWord.exec(lower)) !== null) {
    const a = NUMERIC_WORD[m[1] ?? ''] ?? 0;
    const b = NUMERIC_WORD[m[2]] ?? 0;
    const mul = m[3] === 'million' ? 1_000_000 : 1000;
    const v = (a + b) * mul;
    if (v >= 1000) out.push(v);
  }

  return out;
}

/**
 * Parse a budget anchor like "30 to 50k" or "$30-50k" into [min, max].
 */
function parseBudgetRange(text: string): { min: number; max: number } | null {
  const nums = extractDollarAmounts(text);
  if (nums.length >= 2) return { min: Math.min(...nums), max: Math.max(...nums) };
  if (nums.length === 1) return { min: nums[0], max: nums[0] };
  return null;
}

/**
 * Parse an authority anchor like "I sign up to twenty-five" → cap of 25k.
 */
function parseAuthorityCap(text: string): number | null {
  const nums = extractDollarAmounts(text);
  if (nums.length === 0) return null;
  // heuristic: smallest number is the cap when phrased "up to N"
  return Math.min(...nums);
}

/**
 * Detect anchor contradictions in a NEW utterance. Used by rep-watcher to flag
 * critical-priority correction suggestions.
 */
export function detectAnchorContradictions(
  memory: MeetingMemory,
  newUtteranceText: string,
): AnchorContradiction[] {
  const out: AnchorContradiction[] = [];
  const newAmounts = extractDollarAmounts(newUtteranceText);

  for (const anchor of memory.verbatimAnchors) {
    if (anchor.axis === 'budget') {
      const range = parseBudgetRange(anchor.verbatim);
      if (!range) continue;
      // Any amount in the new utterance more than 50% above max → contradiction
      const violator = newAmounts.find((n) => n > range.max * 1.5);
      if (violator !== undefined) {
        out.push({
          anchor,
          axis: 'budget',
          reason: `pitched $${violator} but budget anchor is $${range.min}–$${range.max}`,
          matchedText: newUtteranceText,
        });
      }
    } else if (anchor.axis === 'authority') {
      const cap = parseAuthorityCap(anchor.verbatim);
      if (cap === null) continue;
      const violator = newAmounts.find((n) => n > cap * 1.5);
      if (violator !== undefined) {
        out.push({
          anchor,
          axis: 'authority',
          reason: `mentioned $${violator} but authority cap is $${cap}`,
          matchedText: newUtteranceText,
        });
      }
    }
  }

  return out;
}
