import { Database } from 'bun:sqlite';
import type { MeetingMemory, Utterance, Suggestion, SpeakerRole } from '@atlas/types';

const db = new Database(process.env.SQLITE_PATH ?? 'atlas.db', { create: true });

db.exec(`
  CREATE TABLE IF NOT EXISTS calls (
    id TEXT PRIMARY KEY,
    script TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    memory_snapshot TEXT,
    verdict TEXT,
    training_delta TEXT,
    follow_up_email TEXT,
    call_log TEXT,
    total_cost_usd REAL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS utterances (
    id TEXT PRIMARY KEY,
    call_id TEXT NOT NULL,
    speaker TEXT NOT NULL,
    text TEXT NOT NULL,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
  );

  CREATE TABLE IF NOT EXISTS ip_sessions (
    ip TEXT NOT NULL,
    date TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (ip, date)
  );

  CREATE TABLE IF NOT EXISTS suggestions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    call_id TEXT NOT NULL,
    utterance_id TEXT NOT NULL,
    turn_counter INTEGER NOT NULL,
    agent TEXT NOT NULL,
    should_fire INTEGER NOT NULL,
    suppressed INTEGER NOT NULL,
    priority TEXT NOT NULL,
    play TEXT NOT NULL,
    markdown TEXT NOT NULL,
    reasoning TEXT NOT NULL,
    grounded_utterance_ids TEXT NOT NULL,
    grounded_anchor_turn_ids TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
  );

  CREATE INDEX IF NOT EXISTS idx_suggestions_call ON suggestions(call_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_utterances_call ON utterances(call_id, created_at);
`);

// Tiny migration: add columns introduced after initial schema.
// SQLite doesn't have ALTER TABLE IF NOT EXISTS, so we check pragma first.
const callsCols = db.query('PRAGMA table_info(calls)').all() as Array<{ name: string }>;
const callsColNames = new Set(callsCols.map(c => c.name));
if (!callsColNames.has('follow_up_email')) {
  db.exec('ALTER TABLE calls ADD COLUMN follow_up_email TEXT');
}
if (!callsColNames.has('total_cost_usd')) {
  db.exec('ALTER TABLE calls ADD COLUMN total_cost_usd REAL DEFAULT 0');
}

export function createCall(id: string, script: string) {
  db.run(
    'INSERT INTO calls (id, script, started_at) VALUES (?, ?, ?)',
    [id, script, Date.now()]
  );
}

export function saveMemorySnapshot(callId: string, memory: MeetingMemory) {
  db.run(
    'UPDATE calls SET memory_snapshot = ? WHERE id = ?',
    [JSON.stringify(memory), callId]
  );
}

export function finalizeCall(callId: string) {
  db.run('UPDATE calls SET ended_at = ? WHERE id = ?', [Date.now(), callId]);
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

export function recordUtterance(callId: string, u: Utterance) {
  try {
    db.run(
      `INSERT OR IGNORE INTO utterances (id, call_id, speaker, text, start_ms, end_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [u.id, callId, u.speaker, u.text, u.startMs, u.endMs, Date.now()]
    );
  } catch (err) {
    console.error('[sqlite] recordUtterance failed', u.id, err);
  }
}

export function recordSuggestion(
  callId: string,
  utteranceId: string,
  turnCounter: number,
  s: Suggestion,
  suppressed = false,
) {
  try {
    db.run(
      `INSERT INTO suggestions (
         call_id, utterance_id, turn_counter, agent,
         should_fire, suppressed, priority, play, markdown, reasoning,
         grounded_utterance_ids, grounded_anchor_turn_ids, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        callId, utteranceId, turnCounter, s.agent,
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
  speaker: SpeakerRole;
  text: string;
  start_ms: number;
  end_ms: number;
  created_at: number;
};

export type LoadedSuggestionRow = {
  id: number;
  call_id: string;
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
  script: string;
  started_at: number;
  ended_at: number | null;
};

export function loadCall(callId: string): LoadedCallRow | null {
  return db.query(
    'SELECT id, script, started_at, ended_at FROM calls WHERE id = ?'
  ).get(callId) as LoadedCallRow | null;
}

export function loadCallLog(callId: string): {
  utterances: LoadedUtteranceRow[];
  suggestions: LoadedSuggestionRow[];
} {
  const utterances = db.query(
    'SELECT * FROM utterances WHERE call_id = ? ORDER BY created_at ASC, id ASC'
  ).all(callId) as LoadedUtteranceRow[];
  const suggestions = db.query(
    'SELECT * FROM suggestions WHERE call_id = ? ORDER BY created_at ASC, id ASC'
  ).all(callId) as LoadedSuggestionRow[];
  return { utterances, suggestions };
}

// Daily spend uses the materialized total_cost_usd column written at finalize time.
export function getDailySpendUsd(): number {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const cutoff = startOfDay.getTime();

  const row = db.query(
    'SELECT COALESCE(SUM(total_cost_usd), 0) AS total FROM calls WHERE started_at >= ?'
  ).get(cutoff) as { total: number } | null;
  return row?.total ?? 0;
}
