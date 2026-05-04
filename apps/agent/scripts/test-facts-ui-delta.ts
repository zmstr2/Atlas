#!/usr/bin/env bun
/**
 * In-process test of the fact-extraction → CallFactsUI pipeline.
 *
 * Drives the same code paths the live demo uses (`runMemoryAgent` →
 * `MemoryStore.applyMemoryPatch` → `buildCallFactsUI`) but without the HTTP /
 * SSE layer, so we avoid rate-limit, replay-timer, and call-end-stream-close
 * flakiness.
 *
 * After every customer utterance, we build the CallFactsUI exactly as
 * `routes/pipeline.ts` does and validate it against `CallFactsUISchema`. At
 * the end we render the panel as it would appear in `MemoryPanel.tsx` and
 * assert the basic facts that are present in the jordan fixture.
 *
 * Usage:  bun run apps/agent/scripts/test-facts-ui-delta.ts
 */

import { resolve } from 'node:path';
import {
  CallFactsUISchema,
  type CallFactsUI,
  type Utterance,
  type AxisCard,
} from '@atlas/types';
import { runMemoryAgent } from '../src/agents/memoryAgent';
import { MemoryStore } from '../src/memory/store';
import { HotTail } from '../src/memory/hotTail';
import { buildCallFactsUI } from '../src/memory/factsUI';

const ROOT = resolve(import.meta.dir, '..', '..', '..');
const FIXTURE = resolve(ROOT, 'fixtures/jordan-transcript.json');

if (!process.env.VERCEL_AI_GATEWAY_TOKEN && !process.env.AI_GATEWAY_API_KEY && !process.env.OPENAI_API_KEY) {
  console.log('skipped (no LLM gateway key)');
  process.exit(0);
}

function chip(state: AxisCard['state']): string {
  switch (state) {
    case 'firm':               return '\x1b[32m●\x1b[0m firm';
    case 'soft':               return '\x1b[33m◐\x1b[0m soft';
    case 'confirmed_negative': return '\x1b[31m✕\x1b[0m neg ';
    case 'unknown':            return '\x1b[90m○\x1b[0m unk ';
    default:                   return state;
  }
}

function truncate(s: string | null, n: number): string {
  if (!s) return '—';
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function wrap(s: string, w: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const word of s.split(/\s+/)) {
    if ((cur + ' ' + word).trim().length > w) {
      if (cur) out.push(cur);
      cur = word;
    } else {
      cur = (cur ? cur + ' ' : '') + word;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function visibleLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

function padRight(s: string, w: number): string {
  const pad = w - visibleLen(s);
  return pad > 0 ? s + ' '.repeat(pad) : s;
}

function renderPanel(ui: CallFactsUI): string {
  const W = 60;
  const hr = '─'.repeat(W);
  const lines: string[] = [];
  const row = (text: string) => lines.push(`│ ${padRight(text, W - 2)} │`);
  const blank = () => row('');

  lines.push(`┌─ Live Memory ${'─'.repeat(W - 14)}┐`);

  if (ui.pushNext) {
    row(`\x1b[35m◆ PUSH NEXT\x1b[0m  →  ${ui.pushNext.axis}`);
    for (const w of wrap(ui.pushNext.humanPrompt, W - 6)) row(`  ${w}`);
    lines.push(`├${hr}┤`);
  }

  row('\x1b[1mQUALIFICATION AXES\x1b[0m');
  blank();
  const axes: Array<[string, AxisCard]> = [
    ['Need',     ui.bant.need],
    ['Budget',   ui.bant.budget],
    ['Authority',ui.bant.authority],
    ['Timeline', ui.bant.timeline],
    ['Metrics',  ui.meddic.metrics],
    ['Econ.Buy', ui.meddic.economicBuyer],
    ['Pain',     ui.meddic.identifyPain],
    ['Champion', ui.meddic.champion],
  ];
  for (const [label, card] of axes) {
    row(`${label.padEnd(10)} ${chip(card.state)}  ${truncate(card.evidence, 32)}`);
  }

  if (ui.disqualifiers.hard) {
    lines.push(`├${hr}┤`);
    row('\x1b[31m■ HARD DISQUALIFIER\x1b[0m');
    for (const w of wrap(ui.disqualifiers.soft.join(' · '), W - 4)) row(`  ${w}`);
  } else if (ui.disqualifiers.softCount > 0) {
    lines.push(`├${hr}┤`);
    row(`\x1b[33m▲ ${ui.disqualifiers.softCount} soft disqualifier(s)\x1b[0m`);
    if (ui.disqualifiers.soft.length) {
      row(`  ${truncate(ui.disqualifiers.soft.join(' · '), W - 6)}`);
    }
  }

  if (ui.stakeholders.length) {
    lines.push(`├${hr}┤`);
    row('\x1b[1mSTAKEHOLDERS\x1b[0m');
    for (const s of ui.stakeholders) {
      row(`  ${s.name} · ${truncate(s.role, 18)} · ${s.sentiment}`);
    }
  }

  if (ui.openLoops.length) {
    lines.push(`├${hr}┤`);
    row('\x1b[1mOPEN LOOPS\x1b[0m');
    for (const l of ui.openLoops) row(`  [${l.owner}] ${truncate(l.description, W - 12)}`);
  }

  lines.push(`├${hr}┤`);
  const tr = `rep ${(ui.stage.talkRatio.rep * 100).toFixed(0)}% / prospect ${(ui.stage.talkRatio.prospect * 100).toFixed(0)}%`;
  row(`min ${ui.stage.callMinute}  ·  ${tr}`);
  lines.push(`└${hr}┘`);
  return lines.join('\n');
}

async function main() {
  const transcript: Utterance[] = JSON.parse(await Bun.file(FIXTURE).text());
  console.log(`Driving ${transcript.length} utterances through the live pipeline…\n`);

  const store = new MemoryStore();
  const hotTail = new HotTail(5);
  let turnCounter = 0;
  let factsUiCount = 0;
  let lastUi: CallFactsUI | null = null;
  const evolution: Array<{
    turn: number;
    speaker: 'rep' | 'customer';
    text: string;
    bant: Record<string, AxisCard['state']>;
    pushNext: string | null;
  }> = [];

  const tStart = Date.now();
  for (const utterance of transcript) {
    turnCounter += 1;
    const turnId = `t${String(turnCounter).padStart(2, '0')}`;
    hotTail.push(utterance);
    store.recordUtteranceStats(utterance.speaker, utterance.text);

    const prevMemory = store.snapshot;
    const tail = hotTail.snapshot();

    let patch;
    try {
      patch = await runMemoryAgent({ utterance, turnId, prevMemory, hotTail: tail });
    } catch (err) {
      console.error(`✗ memory agent failed on ${utterance.id}:`, err instanceof Error ? err.message : err);
      continue;
    }

    store.applyMemoryPatch(patch);

    // Pipeline emits facts_ui_delta only on customer turns.
    if (utterance.speaker === 'customer') {
      const ui = buildCallFactsUI(store.snapshot);
      const parse = CallFactsUISchema.safeParse(ui);
      if (!parse.success) {
        console.error('✗ buildCallFactsUI output failed schema validation:');
        console.error(parse.error.flatten());
        process.exit(1);
      }
      factsUiCount += 1;
      lastUi = parse.data;
      evolution.push({
        turn: turnCounter,
        speaker: utterance.speaker,
        text: utterance.text.slice(0, 70),
        bant: {
          need: ui.bant.need.state,
          budget: ui.bant.budget.state,
          authority: ui.bant.authority.state,
          timeline: ui.bant.timeline.state,
        },
        pushNext: ui.pushNext?.axis ?? null,
      });
    }
  }
  const wallMs = Date.now() - tStart;

  if (factsUiCount === 0 || !lastUi) {
    console.error('✗ no CallFactsUI snapshots produced');
    process.exit(1);
  }

  console.log(`── Per-utterance evolution (${factsUiCount} customer turns, ${wallMs}ms wall) ──`);
  for (const e of evolution) {
    const compact = `n=${e.bant.need[0]} b=${e.bant.budget[0]} a=${e.bant.authority[0]} t=${e.bant.timeline[0]}`;
    console.log(`  t${String(e.turn).padStart(2, '0')} bant[${compact}] push=${(e.pushNext ?? '—').padEnd(10)} "${e.text}…"`);
  }

  console.log('\n── Final MemoryPanel render (what the user would see) ──\n');
  console.log(renderPanel(lastUi));

  // Behavioural assertions on the jordan fixture. Jordan's call:
  //   - Names quantified pain ("six hours every Tuesday", $15k/wk reconcile cost)
  //   - Mentions Marcus from RevOps as authority/co-evaluator
  //   - Anchors a Q2-end / July board-meeting timeline
  //   - Hesitates on budget but doesn't confirm-negative it
  // We assert the LIVE extracted UI captures the high-confidence facts above.
  console.log('\n── Behavioural assertions on the jordan fixture ──');
  const checks: Array<[string, boolean, string]> = [
    ['need axis populated',     lastUi.bant.need.state !== 'unknown',     `state=${lastUi.bant.need.state}`],
    ['need has evidence text',  !!lastUi.bant.need.evidence,              `"${truncate(lastUi.bant.need.evidence, 50)}"`],
    ['timeline detected',       lastUi.bant.timeline.state !== 'unknown', `state=${lastUi.bant.timeline.state}`],
    ['stakeholders extracted',  lastUi.stakeholders.length > 0,           `count=${lastUi.stakeholders.length} (${lastUi.stakeholders.map(s => s.name).join(', ')})`],
    ['pushNext computed',       !!lastUi.pushNext,                        lastUi.pushNext?.axis ?? 'null'],
    ['talk ratio sums to ~1',   Math.abs(lastUi.stage.talkRatio.rep + lastUi.stage.talkRatio.prospect - 1) < 0.01, `rep=${lastUi.stage.talkRatio.rep.toFixed(2)} pro=${lastUi.stage.talkRatio.prospect.toFixed(2)}`],
  ];
  let failed = 0;
  for (const [name, ok, detail] of checks) {
    console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}  (${detail})`);
    if (!ok) failed += 1;
  }

  if (failed > 0) {
    console.error(`\n${failed}/${checks.length} assertion(s) failed`);
    process.exit(1);
  }
  console.log(`\n\x1b[32m✓ All ${checks.length} assertions passed.\x1b[0m`);
  console.log(`  - ${factsUiCount} CallFactsUI snapshots validated against CallFactsUISchema`);
  console.log(`  - ${evolution.filter(e => e.bant.need !== 'unknown').length} turns where need transitioned out of unknown`);
}

await main();
