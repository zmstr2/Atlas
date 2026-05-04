#!/usr/bin/env bun
/**
 * End-to-end test for the suggester pipeline + recording.
 *
 * Boots the agent, replays the Jordan fixture at high speed via /demo/start,
 * waits for call_end, then queries SQLite via loadCallLog and runs
 * assertions A1–A8 from the plan.
 *
 * Skips with a friendly message when neither OPENAI_API_KEY nor
 * VERCEL_AI_GATEWAY_TOKEN is set (matching scripts/smoke.ts behavior).
 *
 * Uses an isolated SQLITE_PATH so production atlas.db is not polluted.
 *
 * Usage:
 *   bun run scripts/test-suggesters.ts
 */

import { spawn, type Subprocess } from 'bun';
import { resolve } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

type Check = { name: string; ok: boolean; detail?: string };
const results: Check[] = [];
function pass(name: string, detail?: string) { results.push({ name, ok: true, detail }); }
function fail(name: string, detail: string) { results.push({ name, ok: false, detail }); }

const ROOT = resolve(import.meta.dir, '..');
const TEST_DB = resolve(tmpdir(), `atlas-test-${Date.now()}.db`);

if (!process.env.OPENAI_API_KEY && !process.env.VERCEL_AI_GATEWAY_TOKEN) {
  console.log('Suggester e2e — skipped (no OPENAI_API_KEY or VERCEL_AI_GATEWAY_TOKEN)');
  process.exit(0);
}

function pickPort(): number {
  return 3000 + Math.floor(Math.random() * 4000);
}

async function bootAgent(port: number): Promise<Subprocess> {
  const proc = spawn(['bun', 'run', 'src/index.ts'], {
    cwd: resolve(ROOT, 'apps/agent'),
    env: { ...process.env, PORT: String(port), SQLITE_PATH: TEST_DB },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://localhost:${port}/health`);
      if (r.ok) return proc;
    } catch {}
    await Bun.sleep(120);
  }
  proc.kill();
  throw new Error('agent did not start within 5s');
}

async function startJordanCall(port: number): Promise<string> {
  const r = await fetch(`http://localhost:${port}/demo/start?speed=50`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ script: 'jordan' }),
  });
  if (!r.ok) throw new Error(`/demo/start ${r.status} ${await r.text()}`);
  const body = await r.json() as { callId: string };
  return body.callId;
}

/** Tail the SSE stream until call_end or timeout. */
async function waitForCallEnd(port: number, callId: string, timeoutMs: number): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`http://localhost:${port}/demo/stream/${callId}`, {
      signal: ctrl.signal,
    });
    if (!r.ok || !r.body) return false;
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) return false;
      buf += dec.decode(value, { stream: true });
      // crude SSE parse: split on \n\n, look for data: lines containing call_end
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLine = frame.split('\n').find(l => l.startsWith('data: '));
        if (!dataLine) continue;
        try {
          const ev = JSON.parse(dataLine.slice(6));
          if (ev.type === 'call_end') {
            ctrl.abort();
            return true;
          }
        } catch {}
      }
    }
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') return false;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  console.log(`Suggester e2e starting (TEST_DB=${TEST_DB})...\n`);

  const port = pickPort();
  let agent: Subprocess | null = null;

  try {
    agent = await bootAgent(port);
    pass(`agent boots on :${port}`);
  } catch (err) {
    fail('agent boot', err instanceof Error ? err.message : String(err));
    finish();
    return;
  }

  let callId = '';
  try {
    callId = await startJordanCall(port);
    pass(`POST /demo/start → ${callId}`);
  } catch (err) {
    fail('start jordan call', String(err));
    agent.kill();
    finish();
    return;
  }

  const ended = await waitForCallEnd(port, callId, 60_000);
  if (ended) pass('received call_end event');
  else fail('call_end', 'timeout — call did not end within 60s');

  // ReplayTimer fires utterances rapidly without awaiting; suggester
  // promises continue running in the background after call_end. Drain
  // them before killing the agent. We poll the DB until suggestions
  // stop arriving (or hit a hard cap).
  const DRAIN_HARD_CAP_MS = 90_000;
  const DRAIN_QUIET_MS = 5_000;
  process.env.SQLITE_PATH = TEST_DB;
  const { loadCallLog: loadLogProbe } = await import('../apps/agent/src/db/sqlite');
  const drainStart = Date.now();
  let lastCount = -1;
  let lastChange = Date.now();
  while (Date.now() - drainStart < DRAIN_HARD_CAP_MS) {
    const probe = loadLogProbe(callId);
    if (probe.suggestions.length !== lastCount) {
      lastCount = probe.suggestions.length;
      lastChange = Date.now();
    }
    if (Date.now() - lastChange >= DRAIN_QUIET_MS && lastCount > 0) break;
    await Bun.sleep(1000);
  }
  agent.kill();
  await Bun.sleep(300);

  // ─── Assertions ────────────────────────────────────────────────────
  // Re-import sqlite against the test DB. The module reads SQLITE_PATH at
  // import time, and we set it on this process before running the script.
  process.env.SQLITE_PATH = TEST_DB;
  const { loadCallLog } = await import('../apps/agent/src/db/sqlite');
  const log = loadCallLog(callId);

  const fixturePath = resolve(ROOT, 'fixtures/jordan-transcript.json');
  const fixture = JSON.parse(await Bun.file(fixturePath).text()) as Array<{ speaker: 'rep' | 'customer' }>;
  const fixtureLen = fixture.length;
  const prospectTurns = fixture.filter(u => u.speaker === 'customer').length;

  // A1: utterances recorded
  if (log.utterances.length === fixtureLen) {
    pass(`A1 utterances recorded (${log.utterances.length}/${fixtureLen})`);
  } else {
    fail('A1 utterances recorded', `got ${log.utterances.length}, expected ${fixtureLen}`);
  }

  // A2: suggester ran
  if (log.suggestions.length > 0) {
    pass(`A2 suggester ran (${log.suggestions.length} suggester decisions recorded)`);
  } else {
    fail('A2 suggester ran', 'no suggestions in DB — gateway probably unreachable');
  }

  const fired = log.suggestions.filter(s => s.suppressed === 0);
  const suppressed = log.suggestions.filter(s => s.suppressed === 1);

  // A3: cadence ceiling — heuristic, calibrated against the jordan fixture.
  // The hard ceiling is "fewer fires than total utterances" (a fire on every
  // turn would be obvious noise). Tune downward as the principles tighten.
  const ceiling = fixtureLen;
  if (fired.length > 0 && fired.length < ceiling) {
    pass(`A3 cadence (fired=${fired.length}/${fixtureLen} utterances, prospectTurns=${prospectTurns})`);
  } else {
    fail('A3 cadence', `fired=${fired.length}, ceiling<${ceiling} (must be >0 and < ceiling)`);
  }

  // A4: one-suggestion-per-exchange — no consecutive turns where
  // prospect_suggester fire is followed by non-critical rep_watcher fire.
  const firedSorted = [...fired].sort((a, b) => a.turn_counter - b.turn_counter);
  let stackViolation: string | null = null;
  for (let i = 0; i < firedSorted.length - 1; i++) {
    const a = firedSorted[i];
    const b = firedSorted[i + 1];
    if (
      a.agent === 'prospect_suggester' &&
      b.agent === 'rep_watcher' &&
      b.turn_counter === a.turn_counter + 1 &&
      b.priority !== 'critical'
    ) {
      stackViolation = `turn ${a.turn_counter}→${b.turn_counter}: ${a.markdown.slice(0, 40)} → ${b.markdown.slice(0, 40)}`;
      break;
    }
  }
  if (!stackViolation) pass('A4 no stacking (gate works)');
  else fail('A4 no stacking', stackViolation);

  // A5: one-sentence format
  const tooLong = fired.filter(s => s.markdown.length > 100 || s.markdown.includes('\n'));
  if (tooLong.length === 0) {
    pass(`A5 one-sentence format (max ${Math.max(...fired.map(s => s.markdown.length), 0)} chars)`);
  } else {
    fail('A5 one-sentence format', `${tooLong.length} suggestions exceed format: ` +
      tooLong.slice(0, 3).map(s => `[${s.markdown.length}ch] ${s.markdown.slice(0, 60)}`).join(' | '));
  }

  // A6: no live fyi
  const fyiFired = fired.filter(s => s.priority === 'fyi');
  if (fyiFired.length === 0) pass('A6 no live fyi');
  else fail('A6 no live fyi', `${fyiFired.length} fyi-priority suggestions live-fired`);

  // A7: self-test enforced
  const ungrounded = fired.filter(s => {
    if (!s.reasoning?.trim()) return true;
    const utts = JSON.parse(s.grounded_utterance_ids || '[]') as string[];
    const anchors = JSON.parse(s.grounded_anchor_turn_ids || '[]') as string[];
    return utts.length === 0 && anchors.length === 0;
  });
  if (ungrounded.length === 0) {
    pass('A7 self-test grounded');
  } else {
    fail('A7 self-test grounded', `${ungrounded.length} fired suggestions lack reasoning or grounding`);
  }

  // A8: opening pleasantry guard — first 3 turns only critical fires
  const earlyNonCritical = fired.filter(s => s.turn_counter <= 3 && s.priority !== 'critical');
  if (earlyNonCritical.length === 0) {
    pass('A8 opening pleasantries silent');
  } else {
    fail('A8 opening pleasantries silent',
      `${earlyNonCritical.length} non-critical fires in turns 1-3: ` +
      earlyNonCritical.map(s => `t${s.turn_counter} ${s.markdown.slice(0, 50)}`).join(' | '));
  }

  // Summary block on the data we collected (always print for visibility).
  console.log('');
  console.log(`Recorded:    utterances=${log.utterances.length}  suggestions=${log.suggestions.length}  fired=${fired.length}  suppressed=${suppressed.length}`);
  console.log(`Prospect turns in fixture: ${prospectTurns}, cadence ceiling=${ceiling}`);
  console.log('');
  console.log('Fired suggestions:');
  for (const s of fired) {
    console.log(`  t${s.turn_counter} [${s.agent}/${s.priority}/${s.play}] ${s.markdown}`);
  }
  if (suppressed.length > 0) {
    console.log('');
    console.log('Suppressed suggestions:');
    for (const s of suppressed) {
      console.log(`  t${s.turn_counter} [${s.agent}/${s.priority}/${s.play}] ${s.markdown}`);
    }
  }

  finish();
}

function finish() {
  console.log('');
  for (const r of results) {
    const icon = r.ok ? '✓' : '✗';
    console.log(`  ${icon} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  }
  const failed = results.filter(r => !r.ok);
  console.log('');
  console.log(`${results.length - failed.length}/${results.length} passed`);

  // Cleanup test DB unless asked to keep
  if (!process.env.KEEP_TEST_DB && existsSync(TEST_DB)) {
    try { unlinkSync(TEST_DB); } catch {}
  } else if (process.env.KEEP_TEST_DB) {
    console.log(`(KEEP_TEST_DB set — leaving ${TEST_DB} on disk)`);
  }

  process.exit(failed.length > 0 ? 1 : 0);
}

await main();
