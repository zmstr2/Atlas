import { Database } from 'bun:sqlite';
import type { MeetingMemory, Utterance, Suggestion } from '@atlas/types';
import { runMigrations } from './migrations';

const db = new Database(process.env.SQLITE_PATH ?? 'atlas.db', { create: true });
runMigrations(db);

/** Sentinel userId for the public demo flow (no auth required). */
export const DEMO_USER_ID = '__demo__';

export function createCall(id: string, userId: string, script: string) {
  db.run(
    'INSERT INTO calls (id, user_id, script, started_at) VALUES (?, ?, ?, ?)',
    [id, userId, script, Date.now()]
  );
}

export function saveMemorySnapshot(callId: string, memory: MeetingMemory) {
  db.run(
    'UPDATE calls SET memory_snapshot = ? WHERE id = ?',
    [JSON.stringify(memory), callId]
  );
}

export function finalizeCall(callId: string, userId: string) {
  db.run(
    'UPDATE calls SET ended_at = ? WHERE id = ? AND user_id = ?',
    [Date.now(), callId, userId]
  );
}

export function checkAndIncrementIpSession(ip: string, dailyCap: number): boolean {
  const today = new Date().toISOString().slice(0, 10);
  db.run(
    `INSERT INTO ip_sessions (ip, date, count) VALUES (?, ?, 1)
     ON CONFLICT (ip, date) DO UPDATE SET count = count + 1`,
    [ip, today]
  );
  const row = db.query('SELECT count FROM ip_sessions WHERE ip = ? AND date = ?')
    .get(ip, today) as { count: number } | null;
  return (row?.count ?? 0) <= dailyCap;
}

export function recordUtterance(callId: string, userId: string, u: Utterance) {
  try {
    db.run(
      `INSERT OR IGNORE INTO utterances (id, call_id, user_id, speaker, text, start_ms, end_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [u.id, callId, userId, u.speaker, u.text, u.startMs, u.endMs, Date.now()]
    );
  } catch (err) {
    console.error('[sqlite] recordUtterance failed', u.id, err);
  }
}

export function recordSuggestion(
  callId: string,
  userId: string,
  utteranceId: string,
  turnCounter: number,
  s: Suggestion,
  suppressed = false,
) {
  try {
    db.run(
      `INSERT INTO suggestions (
         call_id, user_id, utterance_id, turn_counter, agent,
         should_fire, suppressed, priority, play, markdown, reasoning,
         grounded_utterance_ids, grounded_anchor_turn_ids, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        callId, userId, utteranceId, turnCounter, s.agent,
        s.shouldFire ? 1 : 0, suppressed ? 1 : 0,
        s.priority, s.play, s.markdown, s.reasoning,
        JSON.stringify(s.groundedInUtteranceIds),
        JSON.stringify(s.groundedInAnchorTurnIds),
        Date.now(),
      ]
    );
  } catch (err) {
    console.error('[sqlite] recordSuggestion failed', utteranceId, err);
  }
}

export type LoadedUtteranceRow = {
  id: string;
  call_id: string;
  user_id: string;
  speaker: 'rep' | 'customer';
  text: string;
  start_ms: number;
  end_ms: number;
  created_at: number;
};

export type LoadedSuggestionRow = {
  id: number;
  call_id: string;
  user_id: string;
  utterance_id: string;
  turn_counter: number;
  agent: 'prospect_suggester' | 'rep_watcher';
  should_fire: number;
  suppressed: number;
  priority: 'critical' | 'nudge' | 'fyi';
  play: string;
  markdown: string;
  reasoning: string;
  grounded_utterance_ids: string;
  grounded_anchor_turn_ids: string;
  created_at: number;
};

export type LoadedCallRow = {
  id: string;
  user_id: string;
  script: string;
  started_at: number;
  ended_at: number | null;
};

export function loadCall(callId: string, userId: string): LoadedCallRow | null {
  return db.query(
    'SELECT id, user_id, script, started_at, ended_at FROM calls WHERE id = ? AND user_id = ?'
  ).get(callId, userId) as LoadedCallRow | null;
}

export function loadCallLog(callId: string, userId: string): {
  utterances: LoadedUtteranceRow[];
  suggestions: LoadedSuggestionRow[];
} {
  const utterances = db.query(
    'SELECT * FROM utterances WHERE call_id = ? AND user_id = ? ORDER BY created_at ASC, id ASC'
  ).all(callId, userId) as LoadedUtteranceRow[];
  const suggestions = db.query(
    'SELECT * FROM suggestions WHERE call_id = ? AND user_id = ? ORDER BY created_at ASC, id ASC'
  ).all(callId, userId) as LoadedSuggestionRow[];
  return { utterances, suggestions };
}

/** List a single user's calls, most recent first. */
export function listCalls(userId: string, limit = 50): LoadedCallRow[] {
  return db.query(
    `SELECT id, user_id, script, started_at, ended_at
     FROM calls WHERE user_id = ?
     ORDER BY started_at DESC
     LIMIT ?`
  ).all(userId, limit) as LoadedCallRow[];
}

// ============================================================
// Per-user spend (Lane B)
// ============================================================

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Returns today's accumulated spend for a single user. */
export function getDailySpendUsd(userId: string): number {
  const row = db.query(
    'SELECT COALESCE(total_cost_usd, 0) AS total FROM user_quotas WHERE user_id = ? AND date = ?'
  ).get(userId, todayUtc()) as { total: number } | null;
  return row?.total ?? 0;
}

/** UPSERT: bump per-user spend + call count for today. */
export function incrementUserSpend(userId: string, costUsd: number, callIncrement = 0): void {
  db.run(
    `INSERT INTO user_quotas (user_id, date, total_cost_usd, call_count)
       VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id, date) DO UPDATE SET
       total_cost_usd = total_cost_usd + excluded.total_cost_usd,
       call_count = call_count + excluded.call_count`,
    [userId, todayUtc(), costUsd, callIncrement]
  );
}

/**
 * Global daily-spend ceiling — sums today's spend across ALL users.
 * Demo route still uses this for the $20/day global cap.
 *
 * Backed by `calls.total_cost_usd` (materialized at finalize time) for parity
 * with the prior single-tenant behavior. user_quotas tracks the same totals
 * keyed per-user; this view just collapses it.
 */
export function getGlobalDailySpendUsd(): number {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const cutoff = startOfDay.getTime();

  const row = db.query(
    'SELECT COALESCE(SUM(total_cost_usd), 0) AS total FROM calls WHERE started_at >= ?'
  ).get(cutoff) as { total: number } | null;
  return row?.total ?? 0;
}

// Test-only: drop and re-init the database. Lets the test suite reset state
// between cases without re-spawning the process.
export function _resetDbForTests(): void {
  db.exec(`
    DROP TABLE IF EXISTS calls;
    DROP TABLE IF EXISTS utterances;
    DROP TABLE IF EXISTS suggestions;
    DROP TABLE IF EXISTS ip_sessions;
    DROP TABLE IF EXISTS user_quotas;
  `);
  runMigrations(db);
}
