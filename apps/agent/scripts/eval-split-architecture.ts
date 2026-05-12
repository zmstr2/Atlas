#!/usr/bin/env bun
/**
 * eval-split-architecture.ts — Wave 3.1 benchmark
 *
 * Runs the same Sarah Park 20-turn fixture through the split architecture
 * (triggerDetector → code-mapped play → markdownWriter) and compares avg
 * score, precision, recall, and latency vs the single-call suggester
 * benchmark (eval-conversation.ts).
 *
 * Decision rule from the plan: ship the split architecture only if it
 * beats the Wave-2 baseline (avg ~3.1, recall ~7/10) AND p95 latency stays
 * under 4s (single-call is ~3s p95).
 */

import { resolve } from 'node:path';
process.chdir(resolve(import.meta.dir, '..'));

if (!process.env.OPENROUTER_API_KEY) {
  console.error('ERROR: OPENROUTER_API_KEY not set'); process.exit(1);
}

import { MemoryStore } from '../src/memory/store';
import { HotTail } from '../src/memory/hotTail';
import { runTriggerDetector, signalToPlay, signalToPriority, pickSignal, type TriggerOutput } from '../src/agents/triggerDetector';
import { runMarkdownWriter } from '../src/agents/markdownWriter';
import type { RecentSuggestionEntry } from '../src/agents/suggester';
import type { PreCallBrief, Utterance, MemoryPatch, Suggestion } from '@atlas/types';

// Reuse the brief, conversation, and gold standards from eval-conversation
// by re-importing the relevant constants. Since that file is a script
// (not a module), the cleanest path is to duplicate the minimal shape
// here — same brief, same 20 utterances, same memory patches.
// To keep this script focused, only the BRIEF, TRANSCRIPT, GOLD, and
// MEMORY_PATCHES are imported via dynamic eval pattern.

// Simpler: dynamic-import the eval-conversation file as a module would not
// work since it executes main() on import. Inline the minimal fixture instead.
import { BRIEF, TRANSCRIPT, GOLD, MEMORY_PATCHES, type GoldStandard } from './eval-fixture-sarah';

// ─── Run split pipeline ──────────────────────────────────────────────────────
type SplitResult = {
  id: string;
  gold: GoldStandard;
  trigger: TriggerOutput;
  finalSuggestion: { shouldFire: boolean; play: string; priority: string; markdown: string };
  triggerLatencyMs: number;
  markdownLatencyMs: number;
  totalLatencyMs: number;
};

async function main() {
  console.log('\n' + '═'.repeat(70));
  console.log('SPLIT ARCHITECTURE EVAL — Sarah Park / EarlyCo');
  console.log('Two-call pipeline: triggerDetector → signalToPlay → markdownWriter');
  console.log('═'.repeat(70) + '\n');

  const store = new MemoryStore();
  const hotTail = new HotTail(5);
  const recentProspectSuggestions: RecentSuggestionEntry[] = [];
  const recentRepSuggestions: RecentSuggestionEntry[] = [];
  const results: SplitResult[] = [];

  let turnCounter = 0;
  for (const utt of TRANSCRIPT) {
    turnCounter++;
    store.recordUtteranceStats(utt.speaker, utt.text);

    const prevMemory = store.snapshot;
    const tail = hotTail.snapshot();
    const matchingRecent = utt.speaker === 'customer'
      ? recentProspectSuggestions : recentRepSuggestions;

    console.log(`Processing [${utt.id}] ${utt.speaker.toUpperCase()}...`);

    // ── Call 1: trigger detector ────────────────────────────────────────────
    const t0 = Date.now();
    const trigger = await runTriggerDetector({
      utterance: utt,
      hotTail: tail,
      prevMemory,
      brief: BRIEF,
      recentSuggestions: [...matchingRecent],
    });
    const triggerLatencyMs = Date.now() - t0;

    // ── Code: pick top-K candidate above threshold (Test 1) ──────────────────
    const picked = pickSignal(trigger.signalCandidates);
    let finalFire = picked.type !== 'none';
    let play = signalToPlay(picked.type);
    let priority = signalToPriority(picked.type);

    // Opener gate (mirrors the single-call's applyOpenerPhaseGate)
    const repQuestionCount = prevMemory.flow.filter((f) => f.tag === 'R-Q').length;
    if (finalFire && repQuestionCount === 0) {
      const PAIN_GATED = new Set(['drill_vague', 'quantify_pain']);
      const ALWAYS_OK = new Set(['rep_off_ladder', 'rep_feature_dump', 'rep_premature_discount', 'correct_contradiction', 'none']);
      if (!ALWAYS_OK.has(play)) {
        if (PAIN_GATED.has(play)) {
          if (prevMemory.scorecard.bant.need === 'unknown') finalFire = false;
        } else {
          finalFire = false;
        }
      }
    }

    // Confidence-aware cadence bypass: a fire at confidence ≥ 0.85 skips
    // cadence. The original cadence rule existed because the single-call
    // model rationalized past cadence by hallucinating signals — with a
    // calibrated multi-label detector, the model expressing 0.85+ confidence
    // is a structural commitment, not rationalization. The cadence rule's
    // purpose ("don't flood the rep") shouldn't override the detector's
    // genuine high-confidence catches.
    const isHighConfidenceBypass = picked.confidence >= 0.85;

    // Cadence floor (3 of last 5 in this channel), skipped on bypass
    if (finalFire && priority !== 'critical' && play !== 'correct_contradiction' && !isHighConfidenceBypass) {
      const last5 = matchingRecent.slice(-5);
      if (last5.filter((r) => r.fired).length >= 3) finalFire = false;
      // Repeat-play suppressor
      const last3 = matchingRecent.slice(-3);
      if (last3.some((r) => r.fired && r.play === play)) finalFire = false;
    }

    // ── Call 2: markdown writer (only if firing) ────────────────────────────
    let markdown = '';
    let markdownLatencyMs = 0;
    if (finalFire) {
      const t1 = Date.now();
      try {
        markdown = await runMarkdownWriter({
          utterance: utt,
          signalType: picked.type,
          play,
          evidenceQuote: trigger.evidenceQuote,
          brief: BRIEF,
        });
      } catch (err) {
        console.error('  markdown writer failed:', err);
      }
      markdownLatencyMs = Date.now() - t1;
      // Markdown floor — must be ≥5 words
      if (markdown.trim().split(/\s+/).filter(Boolean).length < 5) {
        finalFire = false;
        markdown = '';
      }
    }

    results.push({
      id: utt.id,
      gold: GOLD[utt.id],
      trigger,
      finalSuggestion: { shouldFire: finalFire, play, priority, markdown },
      triggerLatencyMs,
      markdownLatencyMs,
      totalLatencyMs: triggerLatencyMs + markdownLatencyMs,
    });

    // Update channel
    const agent = utt.speaker === 'customer' ? 'prospect_suggester' : 'rep_watcher';
    const target = agent === 'prospect_suggester' ? recentProspectSuggestions : recentRepSuggestions;
    target.push({
      turn: turnCounter,
      speaker: utt.speaker,
      agent,
      fired: finalFire,
      priority: priority as any,
      play: play as any,
      markdown,
    });
    if (target.length > 6) target.splice(0, target.length - 6);

    hotTail.push(utt);
    const patch = MEMORY_PATCHES[utt.id];
    if (patch) store.applyMemoryPatch(patch);
  }

  // ─── Scoring ────────────────────────────────────────────────────────────────
  function scoreTurn(gold: GoldStandard, fired: boolean, play: string): { score: number; verdict: string } {
    if (gold.fire === false) {
      return fired
        ? { score: 1, verdict: '✗ OVER-FIRED' }
        : { score: 5, verdict: '✓ CORRECT (silent)' };
    }
    if (!fired) {
      return gold.cadenceMask
        ? { score: 3, verdict: '~ CADENCE-SUPPRESSED' }
        : { score: 1, verdict: '✗ MISSED' };
    }
    if (play === gold.play) return { score: 5, verdict: '✓ CORRECT (fire, correct play)' };
    return { score: 3, verdict: '~ FIRED (wrong play)' };
  }

  console.log('\n' + '═'.repeat(70));
  console.log('PER-TURN RESULTS');
  console.log('═'.repeat(70));

  let totalScore = 0;
  for (const r of results) {
    const { score, verdict } = scoreTurn(r.gold, r.finalSuggestion.shouldFire, r.finalSuggestion.play);
    totalScore += score;
    const goldStr = r.gold.fire ? `FIRE [${r.gold.play}]` : 'SILENT';
    const actualStr = r.finalSuggestion.shouldFire
      ? `🔥 [${r.finalSuggestion.play}] "${r.finalSuggestion.markdown}"`
      : '🤐 silent';
    console.log(`[${r.id}] gold=${goldStr.padEnd(28)} actual=${actualStr.slice(0, 100)}`);
    const top = r.trigger.signalCandidates[0];
    const sigStr = `${top?.type ?? 'none'}@${(top?.confidence ?? 0).toFixed(2)}`;
    console.log(`       top=${sigStr.padEnd(28)} latency=${(r.totalLatencyMs / 1000).toFixed(1)}s  ${verdict} (${score}/5)`);
  }

  // ─── Aggregate ──────────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(70));
  console.log('AGGREGATE');
  console.log('═'.repeat(70));

  const goldFire = results.filter((r) => r.gold.fire === true);
  const goldSilent = results.filter((r) => r.gold.fire === false);
  const fireCorrect = goldFire.filter((r) => r.finalSuggestion.shouldFire).length;
  const overFires = goldSilent.filter((r) => r.finalSuggestion.shouldFire).length;
  const silentCorrect = goldSilent.length - overFires;

  console.log(`Total turns:        ${results.length}`);
  console.log(`Avg score:          ${(totalScore / results.length).toFixed(2)}/5`);
  console.log(`Precision (silent): ${silentCorrect}/${goldSilent.length}`);
  console.log(`Recall (fire):      ${fireCorrect}/${goldFire.length}`);

  // Latency
  const latencies = results.map((r) => r.totalLatencyMs).sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)];
  const p95 = latencies[Math.floor(latencies.length * 0.95)];
  const triggerLatencies = results.map((r) => r.triggerLatencyMs);
  const writerLatencies = results.filter((r) => r.markdownLatencyMs > 0).map((r) => r.markdownLatencyMs);
  const triggerAvg = triggerLatencies.reduce((a, b) => a + b, 0) / triggerLatencies.length;
  const writerAvg = writerLatencies.length > 0
    ? writerLatencies.reduce((a, b) => a + b, 0) / writerLatencies.length : 0;

  console.log(`\nLatency p50:        ${(p50 / 1000).toFixed(2)}s`);
  console.log(`Latency p95:        ${(p95 / 1000).toFixed(2)}s`);
  console.log(`Trigger avg:        ${(triggerAvg / 1000).toFixed(2)}s`);
  console.log(`Writer avg (fires): ${(writerAvg / 1000).toFixed(2)}s`);

  // ─── Compared to single-call baseline (Wave 2) ──────────────────────────────
  console.log('\n' + '─'.repeat(70));
  console.log('COMPARISON vs Wave 2 single-call baseline');
  console.log('─'.repeat(70));
  console.log(`Single-call:  avg=3.10  precision=7/10  recall=7/10  p95~5s`);
  console.log(`Split:        avg=${(totalScore / results.length).toFixed(2)}  precision=${silentCorrect}/${goldSilent.length}  recall=${fireCorrect}/${goldFire.length}  p95=${(p95 / 1000).toFixed(1)}s`);

  const splitAvg = totalScore / results.length;
  const wins = splitAvg > 3.10;
  const latencyOk = p95 < 4000;
  console.log(`\nDecision: ${wins ? '✓' : '✗'} score (need > 3.10), ${latencyOk ? '✓' : '✗'} p95 (need < 4s)`);
  console.log(splitAvg > 3.10 && latencyOk
    ? '→ SHIP the split architecture'
    : '→ DO NOT SHIP — defer or iterate');
}

await main();
