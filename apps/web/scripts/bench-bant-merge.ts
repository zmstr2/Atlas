#!/usr/bin/env bun
/**
 * Test the BANT-merge prompt revision against the prior prompt.
 * Runs the Jordan transcript through both prompts, captures bantRender per
 * turn, and reports:
 *   - emission count per axis (lower = less noise; we want less churn)
 *   - replacement rate (turns where the headline fully replaced — no token overlap)
 *   - concrete-token survival (numbers, names, dates that appeared once and
 *     never returned)
 *
 * Usage: bun run apps/agent/scripts/bench-bant-merge.ts
 */

import { resolve } from 'node:path';
import { MemoryPatchSchema } from '@atlas/types';
import type { MemoryPatch, MeetingMemory } from '@atlas/types';
import { llmGenerateObject } from '../src/server/llm/wrapper';
import { MemoryStore } from '../src/lib/memory/store';
import { HotTail } from '../src/lib/memory/hotTail';
import { MEMORY_AGENT_SYSTEM as NEW_SYSTEM } from '../src/server/agents/memoryAgent';

if (!process.env.AI_GATEWAY_API_KEY && !process.env.VERCEL_AI_GATEWAY_TOKEN && !process.env.OPENAI_API_KEY) {
  console.log('bench — skipped (no gateway key)');
  process.exit(0);
}

// ─── The PRIOR prompt (verbatim from before the merge revision) ──────────────
// This is the BANT RENDER section that was in main before the change. Keep the
// rest of the system prompt identical so we isolate the merge rule effect.
const OLD_BANT_BLOCK = `BANT RENDER — emit bantRender for every BANT axis that received new evidence this turn:
- headline: ≤8 words. Declarative fact. No leading "they said" / "prospect mentioned" / quotes. Third person or noun phrase. ("Reports 6 hrs/week on HubSpot reconciliation", "$30–50k allocated RevOps budget", "Jordan signs to $25k; CFO above", "Decision needed before July board")
- detail: ≤12 words. The qualifier — WHY it matters, the driver, scope, or constraint. Null if nothing adds texture.
- Rewrite: combine the prior headline/detail (shown as CURRENT BANT SUMMARIES in the prompt) with the new evidence. Do NOT just replace. Do NOT invent facts not in verbatims.
- If no new evidence on an axis this turn, do NOT emit bantRender for that axis.
- TIMELINE: only emit if the evidence is a deal/decision timeline (quarter, month, board date, fiscal deadline). Do NOT emit for meeting logistics ("I have 30 minutes", "hard stop at the hour", "let's wrap up").`;

// Reconstruct the OLD system by swapping the new block back to old.
function buildOldSystem(): string {
  // The new prompt's BANT RENDER block starts with "BANT RENDER —" and ends
  // before "RELEVANT FACTS —". Replace that span.
  const start = NEW_SYSTEM.indexOf('BANT RENDER —');
  const end = NEW_SYSTEM.indexOf('RELEVANT FACTS —');
  if (start < 0 || end < 0) throw new Error('Cannot locate BANT RENDER block in new system prompt');
  return NEW_SYSTEM.slice(0, start) + OLD_BANT_BLOCK + '\n\n' + NEW_SYSTEM.slice(end);
}

const OLD_SYSTEM = buildOldSystem();

// ─── Fixture ─────────────────────────────────────────────────────────────────
const ROOT = resolve(import.meta.dir, '..', '..', '..');
const FIXTURE_PATH = resolve(ROOT, 'fixtures/jordan-transcript.json');
type Utt = { id: string; speaker: 'rep' | 'customer'; text: string; startMs: number; endMs: number };
const fixture: Utt[] = JSON.parse(await Bun.file(FIXTURE_PATH).text());

// ─── Memory agent caller ─────────────────────────────────────────────────────
async function runAgent(opts: {
  utt: Utt; turnId: string; prevMemory: MeetingMemory; hotTail: any[]; system: string;
}): Promise<MemoryPatch | null> {
  const { utt, turnId, prevMemory, hotTail, system } = opts;
  const existingFacts = prevMemory.facts.slice(-15).map((f) => `${f.key}: ${f.content}`).join('\n');
  const existingAnchors = prevMemory.verbatimAnchors
    .filter((a) => !a.supersededBy).slice(-10)
    .map((a) => `[${a.turnId} / ${a.axis}] "${a.verbatim}"`).join('\n');
  const recentFlow = prevMemory.flow.slice(-10).map((f) => `[${f.turnId}] ${f.tag} ${f.content}`).join('\n');
  const activeConcerns = prevMemory.concerns
    .filter((c) => !c.addressed).slice(-10)
    .map((c) => `[${c.severity}] ${c.topic}: "${c.verbatim}"`).join('\n');
  const tail = hotTail.map((h) => `[${h.id}] ${h.speaker.toUpperCase()}: ${h.text}`).join('\n');
  const bantRender = prevMemory.bantRender ?? {};
  const currentBantSummaries = (['need', 'budget', 'authority', 'timeline'] as const)
    .map((axis) => {
      const r = bantRender[axis];
      if (!r?.headline) return `${axis}: (no summary yet)`;
      return `${axis}: "${r.headline}"${r.detail ? ` | detail: "${r.detail}"` : ''}`;
    }).join('\n');
  const currentRelevantFacts = (prevMemory.relevantFacts ?? [])
    .map((f) => `[${f.category}] ${f.text}`).join('\n');

  const prompt = `TURN ID: ${turnId}
SPEAKER: ${utt.speaker}
NEW UTTERANCE [${utt.id}]:
${utt.speaker.toUpperCase()}: ${utt.text}

HOT TAIL (last raw utterances, for context — do not re-extract):
${tail || '(empty)'}

RECENT FLOW (last 10):
${recentFlow || '(empty)'}

EXISTING FACTS (last 15, do not re-extract unless changed):
${existingFacts || '(none)'}

EXISTING ANCHORS (active only, last 10 — reference turnId in anchor.supersedes if updating):
${existingAnchors || '(none)'}

EXISTING ACTIVE CONCERNS (unresolved — use exact topic string in concerns op='resolve'):
${activeConcerns || '(none)'}

CURRENT BANT SUMMARIES (rewrite these for axes with new evidence — do NOT replace unrelated axes):
${currentBantSummaries}

CURRENT RELEVANT FACTS (append new ones; do not duplicate):
${currentRelevantFacts || '(none)'}

Emit the memory patch.`;

  try {
    const raw = await llmGenerateObject({
      step: 'bench_bant_merge',
      modelKey: 'extractor',
      schema: MemoryPatchSchema.omit({ utteranceId: true, turnId: true, speaker: true }),
      prompt, system, maxRetries: 1,
    });
    return { ...raw, utteranceId: utt.id, turnId, speaker: utt.speaker };
  } catch (err) {
    console.error(`  agent error t${turnId}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

// ─── Token analysis ─────────────────────────────────────────────────────────
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'on', 'in', 'of', 'to', 'for', 'with',
  'is', 'are', 'was', 'were', 'be', 'has', 'have', 'had', 'will', 'this', 'that',
  'their', 'they', 'them', 'we', 'our', 'us', 'no', 'not', 'at', 'as', 'by',
  'from', 'off', 'up', 'down', 'into', 'about', 'over', 'under', 'than', 'then',
]);

/** Tokens that matter for "is the same fact still in the summary?" — numbers,
 * $/%/h amounts, capitalised names, multi-syllable nouns. */
function loadBearingTokens(s: string | null | undefined): Set<string> {
  if (!s) return new Set();
  const out = new Set<string>();
  // Numbers and money/percent/hours
  const nums = s.match(/\$?\d[\d,.]*[%kKmMxX]?|\d+\s*(hrs?|hours?|weeks?|months?|years?|days?|min)/gi) ?? [];
  for (const n of nums) out.add(n.toLowerCase().replace(/\s+/g, ''));
  // Capitalised words (likely names/proper nouns) — split on non-word.
  const caps = s.match(/\b[A-Z][a-zA-Z]+\b/g) ?? [];
  for (const c of caps) {
    const lc = c.toLowerCase();
    if (!STOPWORDS.has(lc) && lc.length >= 3) out.add(lc);
  }
  return out;
}

function tokenSurvival(prior: string | null | undefined, next: string | null | undefined): {
  priorCount: number; survived: number; lost: string[];
} {
  const priorT = loadBearingTokens(prior);
  if (priorT.size === 0) return { priorCount: 0, survived: 0, lost: [] };
  const nextT = loadBearingTokens(next);
  const lost: string[] = [];
  let survived = 0;
  for (const t of priorT) {
    if (nextT.has(t)) survived++; else lost.push(t);
  }
  return { priorCount: priorT.size, survived, lost };
}

// ─── Per-condition runner ───────────────────────────────────────────────────
interface AxisHistory {
  axis: string;
  emissions: number;
  totalPriorTokens: number;
  totalSurvivedTokens: number;
  lostTokenInstances: { turn: number; lost: string[]; from: string; to: string }[];
  finalHeadline: string | null;
  finalDetail: string | null;
  trail: { turn: number; headline: string | null; detail: string | null }[];
}

async function runCondition(label: string, system: string): Promise<Map<string, AxisHistory>> {
  console.log(`\n>>> ${label}`);
  const store = new MemoryStore();
  const hot = new HotTail(6);
  const histories = new Map<string, AxisHistory>();
  for (const ax of ['need', 'budget', 'authority', 'timeline']) {
    histories.set(ax, {
      axis: ax, emissions: 0, totalPriorTokens: 0, totalSurvivedTokens: 0,
      lostTokenInstances: [], finalHeadline: null, finalDetail: null, trail: [],
    });
  }

  for (let i = 0; i < fixture.length; i++) {
    const utt = fixture[i];
    const turnId = `t${i + 1}`;
    process.stdout.write(`  t${i + 1}/${fixture.length}…`);
    hot.push({ id: utt.id, speaker: utt.speaker, text: utt.text, startMs: utt.startMs, endMs: utt.endMs });
    store.recordUtteranceStats(utt.speaker, utt.text);

    const prevMemory = store.snapshot;
    const prevBant = prevMemory.bantRender ?? {};

    const patch = await runAgent({ utt, turnId, prevMemory, hotTail: hot.snapshot(), system });
    if (!patch) { process.stdout.write(' err\n'); continue; }

    try { store.applyMemoryPatch(patch); } catch {}

    // Record per-axis emissions
    const newBant = (patch as any).bantRender ?? {};
    for (const ax of ['need', 'budget', 'authority', 'timeline']) {
      if (!newBant[ax]) continue;
      const h = histories.get(ax)!;
      const prior = prevBant[ax];
      const next = newBant[ax];
      h.emissions++;
      h.trail.push({ turn: i + 1, headline: next.headline ?? null, detail: next.detail ?? null });
      h.finalHeadline = next.headline ?? h.finalHeadline;
      h.finalDetail = next.detail ?? h.finalDetail;
      if (prior?.headline) {
        const survival = tokenSurvival(
          [prior.headline, prior.detail].filter(Boolean).join(' '),
          [next.headline, next.detail].filter(Boolean).join(' '),
        );
        h.totalPriorTokens += survival.priorCount;
        h.totalSurvivedTokens += survival.survived;
        if (survival.lost.length > 0) {
          h.lostTokenInstances.push({
            turn: i + 1, lost: survival.lost,
            from: `${prior.headline} | ${prior.detail ?? ''}`.trim(),
            to: `${next.headline} | ${next.detail ?? ''}`.trim(),
          });
        }
      }
    }
    process.stdout.write(' ok\n');
  }
  return histories;
}

// ─── Reporting ──────────────────────────────────────────────────────────────
function report(label: string, histories: Map<string, AxisHistory>) {
  const DIV = '─'.repeat(80);
  console.log(`\n${DIV}\n${label}\n${DIV}`);
  console.log('axis        emissions  prior-toks  survived  survival%  lost-events');
  for (const ax of ['need', 'budget', 'authority', 'timeline']) {
    const h = histories.get(ax)!;
    const pct = h.totalPriorTokens === 0 ? '—' :
      `${Math.round((h.totalSurvivedTokens / h.totalPriorTokens) * 100)}%`;
    console.log(
      `${ax.padEnd(12)}${String(h.emissions).padEnd(11)}${String(h.totalPriorTokens).padEnd(12)}${String(h.totalSurvivedTokens).padEnd(10)}${pct.padEnd(11)}${h.lostTokenInstances.length}`,
    );
  }
  console.log('\nFinal summaries:');
  for (const ax of ['need', 'budget', 'authority', 'timeline']) {
    const h = histories.get(ax)!;
    console.log(`  ${ax}: "${h.finalHeadline ?? '(none)'}" | ${h.finalDetail ?? '(no detail)'}`);
  }
  console.log('\nLost-token events (concrete facts that disappeared between emissions):');
  for (const ax of ['need', 'budget', 'authority', 'timeline']) {
    const h = histories.get(ax)!;
    for (const ev of h.lostTokenInstances) {
      console.log(`  [${ax} t${ev.turn}] lost: ${ev.lost.join(', ')}`);
      console.log(`     FROM: ${ev.from}`);
      console.log(`     TO:   ${ev.to}`);
    }
  }
}

function diffTrails(oldHist: Map<string, AxisHistory>, newHist: Map<string, AxisHistory>) {
  const DIV = '═'.repeat(80);
  console.log(`\n${DIV}\nPER-AXIS HEADLINE TRAIL (OLD vs NEW)\n${DIV}`);
  for (const ax of ['need', 'budget', 'authority', 'timeline']) {
    console.log(`\n── ${ax.toUpperCase()} ──`);
    const o = oldHist.get(ax)!.trail;
    const n = newHist.get(ax)!.trail;
    const turns = new Set([...o.map((t) => t.turn), ...n.map((t) => t.turn)]);
    for (const t of [...turns].sort((a, b) => a - b)) {
      const oe = o.find((x) => x.turn === t);
      const ne = n.find((x) => x.turn === t);
      console.log(`  t${t}`);
      console.log(`    OLD: ${oe ? oe.headline : '(no emit)'}`);
      console.log(`    NEW: ${ne ? ne.headline : '(no emit)'}`);
    }
  }
}

async function main() {
  // Run sequentially to keep prompts comparable across turns (same fixture; LLM
  // calls hit the gateway hard if both run concurrently).
  const oldHist = await runCondition('OLD prompt (pre-merge-rule)', OLD_SYSTEM);
  const newHist = await runCondition('NEW prompt (with merge rule)', NEW_SYSTEM);

  report('OLD prompt', oldHist);
  report('NEW prompt', newHist);
  diffTrails(oldHist, newHist);

  // Bottom-line summary
  console.log('\n═══ BOTTOM LINE ═══');
  for (const ax of ['need', 'budget', 'authority', 'timeline']) {
    const o = oldHist.get(ax)!;
    const n = newHist.get(ax)!;
    const oPct = o.totalPriorTokens === 0 ? null : (o.totalSurvivedTokens / o.totalPriorTokens) * 100;
    const nPct = n.totalPriorTokens === 0 ? null : (n.totalSurvivedTokens / n.totalPriorTokens) * 100;
    console.log(
      `${ax.padEnd(10)}  emissions ${o.emissions}→${n.emissions}   ` +
      `survival ${oPct?.toFixed(0) ?? '—'}%→${nPct?.toFixed(0) ?? '—'}%   ` +
      `lost-events ${o.lostTokenInstances.length}→${n.lostTokenInstances.length}`,
    );
  }
}

await main();
