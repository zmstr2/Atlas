#!/usr/bin/env bun
/**
 * A/B comparison of suggester PROMPT VERSIONS (v1 = original, v2 = modular lenses).
 *
 * Boots TWO agent processes in parallel — one with SUGGESTER_PROMPT_VERSION=v1, one
 * with v2 — replays the Jordan fixture against each concurrently, then dumps a
 * side-by-side. Both runs use SUGGESTER_MODE=merged so we isolate the prompt diff.
 *
 * Usage:
 *   bun run scripts/compare-prompt-versions.ts            # jordan
 *   FIXTURES=jordan,maya bun run scripts/compare-prompt-versions.ts
 */

import { spawn, type Subprocess } from 'bun';
import { resolve } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ROOT = resolve(import.meta.dir, '..');

if (!process.env.OPENAI_API_KEY && !process.env.VERCEL_AI_GATEWAY_TOKEN) {
  console.log('compare-prompt-versions — skipped (no OPENAI_API_KEY or VERCEL_AI_GATEWAY_TOKEN)');
  process.exit(0);
}

function pickPort(): number {
  return 3000 + Math.floor(Math.random() * 4000);
}

async function bootAgent(port: number, dbPath: string, version: 'v1' | 'v2' | 'v3'): Promise<Subprocess> {
  const proc = spawn(['bun', 'run', 'src/index.ts'], {
    cwd: resolve(ROOT, 'apps/agent'),
    env: {
      ...process.env,
      PORT: String(port),
      SQLITE_PATH: dbPath,
      SUGGESTER_MODE: 'merged',
      SUGGESTER_PROMPT_VERSION: version,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://localhost:${port}/health`);
      if (r.ok) return proc;
    } catch {}
    await Bun.sleep(150);
  }
  proc.kill();
  throw new Error(`agent (${version}) did not start within 8s`);
}

async function startCall(port: number, script: string): Promise<string> {
  const r = await fetch(`http://localhost:${port}/demo/start?speed=50`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ script }),
  });
  if (!r.ok) throw new Error(`/demo/start ${r.status} ${await r.text()}`);
  const body = await r.json() as { callId: string };
  return body.callId;
}

async function waitForCallEnd(port: number, callId: string, timeoutMs: number): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`http://localhost:${port}/demo/stream/${callId}`, { signal: ctrl.signal });
    if (!r.ok || !r.body) return false;
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) return false;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLine = frame.split('\n').find(l => l.startsWith('data: '));
        if (!dataLine) continue;
        try {
          const ev = JSON.parse(dataLine.slice(6));
          if (ev.type === 'call_end') { ctrl.abort(); return true; }
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

function loadSuggestionsAndUtterances(dbPath: string, callId: string) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Database } = require('bun:sqlite');
  const db = new Database(dbPath, { readonly: true });
  const utts = db.query(
    'SELECT * FROM utterances WHERE call_id = ? ORDER BY created_at ASC, id ASC'
  ).all(callId) as Array<{ id: string; speaker: string; text: string }>;
  const sugg = db.query(
    'SELECT * FROM suggestions WHERE call_id = ? ORDER BY created_at ASC, id ASC'
  ).all(callId) as Array<{
    utterance_id: string; turn_counter: number; agent: string; suppressed: number;
    priority: string; play: string; markdown: string;
  }>;
  db.close();
  return { utts, sugg };
}

async function drainSuggestions(dbPath: string, callId: string) {
  const HARD_CAP_MS = 90_000;
  const QUIET_MS = 5_000;
  const start = Date.now();
  let lastCount = -1;
  let lastChange = Date.now();
  while (Date.now() - start < HARD_CAP_MS) {
    const { sugg } = loadSuggestionsAndUtterances(dbPath, callId);
    if (sugg.length !== lastCount) { lastCount = sugg.length; lastChange = Date.now(); }
    if (Date.now() - lastChange >= QUIET_MS && lastCount > 0) break;
    await Bun.sleep(1000);
  }
  return lastCount;
}

async function runOnce(version: 'v1' | 'v2' | 'v3', script: string): Promise<{ callId: string; dbPath: string }> {
  const port = pickPort();
  const dbPath = resolve(tmpdir(), `atlas-promptcmp-${version}-${script}-${Date.now()}-${Math.floor(Math.random()*1e6)}.db`);
  console.log(`[${version}/${script}] booting on :${port}`);
  const agent = await bootAgent(port, dbPath, version);
  try {
    const callId = await startCall(port, script);
    console.log(`[${version}/${script}] callId=${callId}, awaiting call_end...`);
    const ended = await waitForCallEnd(port, callId, 60_000);
    console.log(`[${version}/${script}] call_end=${ended}, draining...`);
    const finalCount = await drainSuggestions(dbPath, callId);
    console.log(`[${version}/${script}] drained: ${finalCount} suggestions`);
    return { callId, dbPath };
  } finally {
    agent.kill();
    await Bun.sleep(200);
  }
}

type Row = {
  turn: number; speaker: string; text: string;
  fired: Array<{ agent: string; priority: string; play: string; markdown: string }>;
  suppressed: Array<{ agent: string; priority: string; play: string; markdown: string }>;
};

function buildRows(dbPath: string, callId: string): Row[] {
  const { utts, sugg } = loadSuggestionsAndUtterances(dbPath, callId);
  const byUtt = new Map<string, typeof sugg>();
  for (const s of sugg) {
    const arr = byUtt.get(s.utterance_id) ?? [];
    arr.push(s);
    byUtt.set(s.utterance_id, arr);
  }
  return utts.map((u, i) => {
    const ss = byUtt.get(u.id) ?? [];
    return {
      turn: i + 1, speaker: u.speaker, text: u.text,
      fired: ss.filter(s => s.suppressed === 0).map(s => ({
        agent: s.agent, priority: s.priority, play: s.play, markdown: s.markdown,
      })),
      suppressed: ss.filter(s => s.suppressed === 1).map(s => ({
        agent: s.agent, priority: s.priority, play: s.play, markdown: s.markdown,
      })),
    };
  });
}

function fmt(s: { agent: string; priority: string; play: string; markdown: string }, prefix: string): string {
  return `${prefix} [${s.agent}/${s.priority}/${s.play}] ${s.markdown}`;
}

function summarize(label: string, rows: Row[]) {
  let fired = 0, suppressed = 0;
  let firstFireTurn: number | null = null;
  const playCounts: Record<string, number> = {};
  for (const r of rows) {
    if (r.fired.length > 0 && firstFireTurn === null) firstFireTurn = r.turn;
    fired += r.fired.length;
    suppressed += r.suppressed.length;
    for (const f of r.fired) playCounts[f.play] = (playCounts[f.play] ?? 0) + 1;
  }
  const playSummary = Object.entries(playCounts).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`${k}=${v}`).join(', ');
  console.log(`${label}: fired=${fired}, suppressed=${suppressed}, first-fire @ t${firstFireTurn ?? '-'}`);
  if (playSummary) console.log(`${label} plays: ${playSummary}`);
  return { fired, suppressed, firstFireTurn, playCounts };
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
}

const A_VERSION = (process.env.A_VERSION ?? 'v1') as 'v1' | 'v2' | 'v3';
const B_VERSION = (process.env.B_VERSION ?? 'v3') as 'v1' | 'v2' | 'v3';

async function compareFixture(script: string) {
  console.log(`\n========== Fixture: ${script} (A=${A_VERSION} vs B=${B_VERSION}) ==========`);
  // PARALLEL: kick off A and B simultaneously
  const [a, b] = await Promise.all([
    runOnce(A_VERSION, script),
    runOnce(B_VERSION, script),
  ]);

  const v1Rows = buildRows(a.dbPath, a.callId);
  const v2Rows = buildRows(b.dbPath, b.callId);

  console.log('\n──── SUMMARY ────');
  const v1Sum = summarize(A_VERSION.toUpperCase(), v1Rows);
  const v2Sum = summarize(B_VERSION.toUpperCase(), v2Rows);

  console.log(`\n──── SIDE-BY-SIDE (${A_VERSION.toUpperCase()} | ${B_VERSION.toUpperCase()}) ────`);
  for (let i = 0; i < v1Rows.length; i++) {
    const a = v1Rows[i];
    const b = v2Rows[i];
    const speaker = a.speaker.toUpperCase();
    console.log(`\nt${a.turn} ${speaker}: ${truncate(a.text, 150)}`);
    if (a.fired.length === 0 && b.fired.length === 0 && a.suppressed.length === 0 && b.suppressed.length === 0) {
      console.log('  (both silent)');
      continue;
    }
    const aLabel = A_VERSION.toUpperCase().padEnd(2);
    const bLabel = B_VERSION.toUpperCase().padEnd(2);
    if (a.fired.length || a.suppressed.length) {
      for (const f of a.fired) console.log(`  ${aLabel} ` + fmt(f, 'FIRED  '));
      for (const f of a.suppressed) console.log(`  ${aLabel} ` + fmt(f, 'silent '));
    } else { console.log(`  ${aLabel}  (silent)`); }
    if (b.fired.length || b.suppressed.length) {
      for (const f of b.fired) console.log(`  ${bLabel} ` + fmt(f, 'FIRED  '));
      for (const f of b.suppressed) console.log(`  ${bLabel} ` + fmt(f, 'silent '));
    } else { console.log(`  ${bLabel}  (silent)`); }
  }

  console.log('\n──── VERDICT ────');
  console.log(`Cadence:    ${A_VERSION.toUpperCase()} fired ${v1Sum.fired}, ${B_VERSION.toUpperCase()} fired ${v2Sum.fired}`);
  console.log(`First fire: ${A_VERSION.toUpperCase()} @t${v1Sum.firstFireTurn}, ${B_VERSION.toUpperCase()} @t${v2Sum.firstFireTurn}`);

  if (!process.env.KEEP_TEST_DB) {
    for (const p of [a.dbPath, b.dbPath]) {
      if (existsSync(p)) try { unlinkSync(p); } catch {}
    }
  } else {
    console.log(`(KEEP_TEST_DB set — ${A_VERSION.toUpperCase()}=${a.dbPath}  ${B_VERSION.toUpperCase()}=${b.dbPath})`);
  }
}

async function main() {
  const fixtures = (process.env.FIXTURES ?? 'jordan').split(',').map(s => s.trim()).filter(Boolean);
  console.log(`Comparing ${A_VERSION.toUpperCase()} vs ${B_VERSION.toUpperCase()} prompt across fixtures: ${fixtures.join(', ')}`);
  // Run fixtures sequentially (within each fixture, V1+V2 run in parallel) to avoid
  // saturating the gateway with 4+ concurrent agent processes.
  for (const f of fixtures) {
    await compareFixture(f);
  }
}

await main();
