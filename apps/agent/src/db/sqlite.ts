import { Database } from 'bun:sqlite';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import type { MeetingMemory, Utterance, Suggestion, SpeakerRole, PreCallBrief } from '@atlas/types';
import { runMigrations } from './migrations';

// Resolve DB path. Precedence:
//   1. SQLITE_PATH (legacy override, used by tests + demo)
//   2. ATLAS_DATA_DIR/atlas.db (set by the Tauri shell at sidecar spawn time —
//      points at the OS-standard app data dir on each platform)
//   3. ./atlas.db (dev default when running `bun run dev:agent` from the
//      monorepo root)
function resolveDbPath(): string {
  if (process.env.SQLITE_PATH) return process.env.SQLITE_PATH;
  if (process.env.ATLAS_DATA_DIR) {
    mkdirSync(process.env.ATLAS_DATA_DIR, { recursive: true });
    return path.join(process.env.ATLAS_DATA_DIR, 'atlas.db');
  }
  return 'atlas.db';
}

const db = new Database(resolveDbPath(), { create: true });
runMigrations(db);

// ── calls ──────────────────────────────────────────────────────────────────

/**
 * Create a call row. `script` is set for legacy demo replay; for real
 * desktop calls pass null and supply prospect_name + brief_json instead.
 */
export function createCall(
  id: string,
  opts: { script?: string | null; prospectName?: string | null; meetingUrl?: string | null; brief?: PreCallBrief | null } = {},
) {
  db.run(
    `INSERT INTO calls (id, script, prospect_name, meeting_url, brief_json, status, started_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?)`,
    [
      id,
      opts.script ?? null,
      opts.prospectName ?? null,
      opts.meetingUrl ?? null,
      opts.brief ? JSON.stringify(opts.brief) : null,
      Date.now(),
    ],
  );
}

export function saveMemorySnapshot(callId: string, memory: MeetingMemory) {
  db.run(
    'UPDATE calls SET memory_snapshot = ? WHERE id = ?',
    [JSON.stringify(memory), callId],
  );
}

export function finalizeCall(callId: string) {
  db.run(
    `UPDATE calls SET ended_at = ?, status = 'ended' WHERE id = ?`,
    [Date.now(), callId],
  );
}

export function updateCallStatus(callId: string, status: 'active' | 'ended' | 'failed') {
  db.run('UPDATE calls SET status = ? WHERE id = ?', [status, callId]);
}

export function saveCoachingArtifact(callId: string, artifact: unknown) {
  db.run(
    'UPDATE calls SET coaching_artifact = ? WHERE id = ?',
    [JSON.stringify(artifact), callId],
  );
}

export function saveVerdict(callId: string, verdict: unknown) {
  db.run('UPDATE calls SET verdict = ? WHERE id = ?', [JSON.stringify(verdict), callId]);
}

export function saveFollowUpEmail(callId: string, email: string) {
  db.run('UPDATE calls SET follow_up_email = ? WHERE id = ?', [email, callId]);
}

// ── participants ───────────────────────────────────────────────────────────

export function upsertParticipant(opts: {
  callId: string;
  participantId: string;
  displayName?: string | null;
  role: SpeakerRole;
}) {
  db.run(
    `INSERT INTO participants (call_id, participant_id, display_name, role)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (call_id, participant_id) DO UPDATE
       SET display_name = COALESCE(excluded.display_name, display_name),
           role = excluded.role`,
    [opts.callId, opts.participantId, opts.displayName ?? null, opts.role],
  );
}

export function loadParticipants(callId: string): Array<{
  participantId: string;
  displayName: string | null;
  role: SpeakerRole;
}> {
  const rows = db.query(
    `SELECT participant_id as participantId, display_name as displayName, role
     FROM participants WHERE call_id = ? ORDER BY first_seen_at ASC`,
  ).all(callId) as Array<{ participantId: string; displayName: string | null; role: SpeakerRole }>;
  return rows;
}

// ── utterances ─────────────────────────────────────────────────────────────

export function recordUtterance(callId: string, u: Utterance) {
  try {
    db.run(
      `INSERT OR IGNORE INTO utterances (id, call_id, participant_id, speaker, text, start_ms, end_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [u.id, callId, u.participantId ?? null, u.speaker, u.text, u.startMs, u.endMs, Date.now()],
    );
  } catch (err) {
    console.error('[sqlite] recordUtterance failed', u.id, err);
  }
}

// ── suggestions ────────────────────────────────────────────────────────────

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
      ],
    );
  } catch (err) {
    console.error('[sqlite] recordSuggestion failed', utteranceId, err);
  }
}

// ── reads ──────────────────────────────────────────────────────────────────

export type LoadedUtteranceRow = {
  id: string;
  call_id: string;
  participant_id: string | null;
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
  script: string | null;
  prospect_name: string | null;
  meeting_url: string | null;
  brief_json: string | null;
  status: 'active' | 'ended' | 'failed';
  started_at: number;
  ended_at: number | null;
  verdict: string | null;
  coaching_artifact: string | null;
  follow_up_email: string | null;
};

export function loadCall(callId: string): LoadedCallRow | null {
  return db.query(
    `SELECT id, script, prospect_name, meeting_url, brief_json, status,
            started_at, ended_at, verdict, coaching_artifact, follow_up_email
     FROM calls WHERE id = ?`,
  ).get(callId) as LoadedCallRow | null;
}

export function listCalls(limit = 100): Array<Pick<LoadedCallRow,
  'id' | 'script' | 'prospect_name' | 'status' | 'started_at' | 'ended_at'
>> {
  return db.query(
    `SELECT id, script, prospect_name, status, started_at, ended_at
     FROM calls ORDER BY started_at DESC LIMIT ?`,
  ).all(limit) as Array<Pick<LoadedCallRow,
    'id' | 'script' | 'prospect_name' | 'status' | 'started_at' | 'ended_at'
  >>;
}

export function loadCallLog(callId: string): {
  utterances: LoadedUtteranceRow[];
  suggestions: LoadedSuggestionRow[];
} {
  const utterances = db.query(
    'SELECT * FROM utterances WHERE call_id = ? ORDER BY created_at ASC, id ASC',
  ).all(callId) as LoadedUtteranceRow[];
  const suggestions = db.query(
    'SELECT * FROM suggestions WHERE call_id = ? ORDER BY created_at ASC, id ASC',
  ).all(callId) as LoadedSuggestionRow[];
  return { utterances, suggestions };
}

// Daily spend uses the materialized total_cost_usd column written at finalize time.
export function getDailySpendUsd(): number {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const cutoff = startOfDay.getTime();

  const row = db.query(
    'SELECT COALESCE(SUM(total_cost_usd), 0) AS total FROM calls WHERE started_at >= ?',
  ).get(cutoff) as { total: number } | null;
  return row?.total ?? 0;
}

// ── legacy demo IP rate-limit shim ─────────────────────────────────────────
// The desktop app doesn't need IP rate limiting — the Bun sidecar binds to
// 127.0.0.1 only. The web demo (apps/web with practice mode) still wants a
// global ceiling, so this is a memory-only fallback when ip_sessions has
// been dropped.

const memoryIpSessions = new Map<string, number>();

export function checkAndIncrementIpSession(ip: string, dailyCap: number): boolean {
  const today = new Date().toISOString().slice(0, 10);
  const key = `${ip}:${today}`;
  const next = (memoryIpSessions.get(key) ?? 0) + 1;
  memoryIpSessions.set(key, next);
  return next <= dailyCap;
}
