#!/usr/bin/env bun
/**
 * A/B comparison: replay the Jordan fixture once with SUGGESTER_MODE=split and
 * once with SUGGESTER_MODE=merged. Dump both side by side so we can eyeball
 * which mode is firing better.
 *
 * Skips with a friendly message when neither OPENAI_API_KEY nor
 * VERCEL_AI_GATEWAY_TOKEN is set.
 */

import { spawn, type Subprocess } from 'bun';
import { resolve } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ROOT = resolve(import.meta.dir, '..');
const FIXTURE_PATH = resolve(ROOT, 'fixtures/jordan-transcript.json');

if (!process.env.OPENAI_API_KEY && !process.env.VERCEL_AI_GATEWAY_TOKEN) {
  console.log('compare-suggesters — skipped (no OPENAI_API_KEY or VERCEL_AI_GATEWAY_TOKEN)');
  process.exit(0);
}

function pickPort(): number {
  return 3000 + Math.floor(Math.random() * 4000);
}

async function bootAgent(port: number, dbPath: string, mode: 'split' | 'merged'): Promise<Subprocess> {
  const proc = spawn(['bun', 'run', 'src/index.ts'], {
    cwd: resolve(ROOT, 'apps/agent'),
    env: { ...process.env, PORT: String(port), SQLITE_PATH: dbPath, SUGGESTER_MODE: mode },
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

async function startJordan(port: number): Promise<string> {
  const r = await fetch(`http://localhost:${port}/demo/start?speed=50`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ script: 'jordan' }),
  });
  if (!r.ok) throw new Error(`/demo/start ${r.status} ${await r.text()}`);
  const body = await r.json() as { callId: string };
  return body.callId;
}

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

async function runOnce(mode: 'split' | 'merged'): Promise<{
  callId: string;
  dbPath: string;
}> {
  const port = pickPort();
  const dbPath = resolve(tmpdir(), `atlas-cmp-${mode}-${Date.now()}.db`);
  console.log(`\n[${mode}] booting agent on :${port} db=${dbPath}`);

  const agent = await bootAgent(port, dbPath, mode);
  try {
    const callId = await startJordan(port);
    console.log(`[${mode}] callId=${callId}, awaiting call_end...`);
    const ended = await waitForCallEnd(port, callId, 60_000);
    console.log(`[${mode}] call_end=${ended}, draining suggesters...`);

    // Drain in-flight suggester promises by polling SQLite until count stabilizes.
    process.env.SQLITE_PATH = dbPath;
    const mod = await import(`../apps/agent/src/db/sqlite?cmp=${mode}-${Date.now()}`);
    const drainStart = Date.now();
    let lastCount = -1;
    let lastChange = Date.now();
    while (Date.now() - drainStart < 90_000) {
      const probe = mod.loadCallLog(callId);
      if (probe.suggestions.length !== lastCount) {
        lastCount = probe.suggestions.length;
        lastChange = Date.now();
      }
      if (Date.now() - lastChange >= 5_000 && lastCount > 0) break;
      await Bun.sleep(1000);
    }
    console.log(`[${mode}] drained: ${lastCount} suggestions recorded`);
    return { callId, dbPath };
  } finally {
    agent.kill();
    await Bun.sleep(300);
  }
}

type Row = {
  utteranceId: string;
  turn: number;
  speaker: string;
  text: string;
  fired: Array<{ agent: string; priority: string; play: string; markdown: string }>;
  suppressed: Array<{ agent: string; priority: string; play: string; markdown: string }>;
};

function buildRows(dbPath: string, callId: string): Row[] {
  process.env.SQLITE_PATH = dbPath;
  // Force fresh module each call so the Database opens against the right file.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Database } = require('bun:sqlite');
  const db = new Database(dbPath, { readonly: true });
  const utts = db.query(
    'SELECT * FROM utterances WHERE call_id = ? ORDER BY created_at ASC, id ASC'
  ).all(callId) as Array<{ id: string; speaker: string; text: string }>;
  const sugg = db.query(
    'SELECT * FROM suggestions WHERE call_id = ? ORDER BY created_at ASC, id ASC'
  ).all(callId) as Array<{
    utterance_id: string;
    turn_counter: number;
    agent: string;
    suppressed: number;
    priority: string;
    play: string;
    markdown: string;
  }>;
  db.close();

  const byUtt = new Map<string, typeof sugg>();
  for (const s of sugg) {
    const arr = byUtt.get(s.utterance_id) ?? [];
    arr.push(s);
    byUtt.set(s.utterance_id, arr);
  }

  return utts.map((u, i) => {
    const ss = byUtt.get(u.id) ?? [];
    return {
      utteranceId: u.id,
      turn: i + 1,
      speaker: u.speaker,
      text: u.text,
      fired: ss.filter(s => s.suppressed === 0).map(s => ({
        agent: s.agent, priority: s.priority, play: s.play, markdown: s.markdown,
      })),
      suppressed: ss.filter(s => s.suppressed === 1).map(s => ({
        agent: s.agent, priority: s.priority, play: s.play, markdown: s.markdown,
      })),
    };
  });
}

function fmtSuggestion(s: { agent: string; priority: string; play: string; markdown: string }, prefix: string): string {
  return `${prefix} [${s.agent}/${s.priority}/${s.play}] ${s.markdown}`;
}

function summarize(label: string, rows: Row[]): { fired: number; suppressed: number; firstFireTurn: number | null } {
  let fired = 0, suppressed = 0;
  let firstFireTurn: number | null = null;
  for (const r of rows) {
    if (r.fired.length > 0 && firstFireTurn === null) firstFireTurn = r.turn;
    fired += r.fired.length;
    suppressed += r.suppressed.length;
  }
  console.log(`${label}: fired=${fired}, suppressed=${suppressed}, first fire @ t${firstFireTurn ?? '-'}`);
  return { fired, suppressed, firstFireTurn };
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
}

async function main() {
  console.log('Comparing split vs merged suggester modes on Jordan fixture\n');

  const split = await runOnce('split');
  const merged = await runOnce('merged');

  const splitRows = buildRows(split.dbPath, split.callId);
  const mergedRows = buildRows(merged.dbPath, merged.callId);

  console.log('\n────────────────────────────────────────────────────');
  console.log('SUMMARY');
  console.log('────────────────────────────────────────────────────');
  const splitSum = summarize('SPLIT ', splitRows);
  const mergedSum = summarize('MERGED', mergedRows);

  console.log('\n────────────────────────────────────────────────────');
  console.log('SIDE-BY-SIDE TRANSCRIPT (split | merged)');
  console.log('────────────────────────────────────────────────────');

  for (let i = 0; i < splitRows.length; i++) {
    const s = splitRows[i];
    const m = mergedRows[i];
    const speaker = s.speaker.toUpperCase();
    console.log(`\nt${s.turn} ${speaker}: ${truncate(s.text, 150)}`);
    if (s.fired.length === 0 && m.fired.length === 0 && s.suppressed.length === 0 && m.suppressed.length === 0) {
      console.log('  (both silent)');
      continue;
    }
    if (s.fired.length > 0 || s.suppressed.length > 0) {
      for (const f of s.fired) console.log('  SPLIT  ' + fmtSuggestion(f, 'FIRED  '));
      for (const f of s.suppressed) console.log('  SPLIT  ' + fmtSuggestion(f, 'silent '));
    } else {
      console.log('  SPLIT   (silent)');
    }
    if (m.fired.length > 0 || m.suppressed.length > 0) {
      for (const f of m.fired) console.log('  MERGED ' + fmtSuggestion(f, 'FIRED  '));
      for (const f of m.suppressed) console.log('  MERGED ' + fmtSuggestion(f, 'silent '));
    } else {
      console.log('  MERGED  (silent)');
    }
  }

  console.log('\n────────────────────────────────────────────────────');
  console.log('VERDICT');
  console.log('────────────────────────────────────────────────────');
  console.log(`Cadence:    split fired ${splitSum.fired}, merged fired ${mergedSum.fired}`);
  console.log(`First fire: split @t${splitSum.firstFireTurn}, merged @t${mergedSum.firstFireTurn}`);
  console.log(`(callIds: split=${split.callId}  merged=${merged.callId})`);
  console.log(`(dbs:     split=${split.dbPath}  merged=${merged.dbPath})`);

  // Cleanup
  if (!process.env.KEEP_TEST_DB) {
    for (const p of [split.dbPath, merged.dbPath]) {
      if (existsSync(p)) try { unlinkSync(p); } catch {}
    }
  }
}

await main();
