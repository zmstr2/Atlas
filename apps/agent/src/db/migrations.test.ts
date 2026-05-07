/**
 * Migration semantics tests.
 *
 * The most consequential migration is 005_add_user_id_scoping which adds a
 * `user_id` column with DEFAULT '__demo__' to existing rows. We document
 * (and lock in) the backfill behavior — any change here is a deliberate
 * cross-tenant data-classification decision.
 *
 * Migration 007 adds three nullable post-call status columns; we verify
 * idempotency and that re-running over a fresh DB doesn't error.
 */
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { runMigrations, tableHasColumn } from './migrations';

function freshDb(): Database {
  return new Database(':memory:', { create: true });
}

describe('migration 005 — user_id scoping backfill', () => {
  test('runs from fresh DB without error', () => {
    const db = freshDb();
    runMigrations(db);
    expect(tableHasColumn(db, 'calls', 'user_id')).toBe(true);
    expect(tableHasColumn(db, 'utterances', 'user_id')).toBe(true);
    expect(tableHasColumn(db, 'suggestions', 'user_id')).toBe(true);
  });

  test('pre-existing legacy rows get backfilled to __demo__', () => {
    // Simulate an upgrade scenario: schema before 005 had no user_id.
    const db = freshDb();
    db.exec(`
      CREATE TABLE calls (
        id TEXT PRIMARY KEY,
        script TEXT,
        prospect_name TEXT,
        meeting_url TEXT,
        brief_json TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        memory_snapshot TEXT,
        verdict TEXT,
        coaching_artifact TEXT,
        follow_up_email TEXT,
        call_log TEXT,
        total_cost_usd REAL DEFAULT 0
      );
      CREATE TABLE utterances (
        id TEXT PRIMARY KEY,
        call_id TEXT NOT NULL,
        participant_id TEXT,
        speaker TEXT NOT NULL,
        text TEXT NOT NULL,
        start_ms INTEGER NOT NULL,
        end_ms INTEGER NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
      );
      CREATE TABLE participants (
        call_id TEXT NOT NULL,
        participant_id TEXT NOT NULL,
        display_name TEXT,
        role TEXT NOT NULL DEFAULT 'unknown',
        first_seen_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
        PRIMARY KEY (call_id, participant_id)
      );
      CREATE TABLE suggestions (
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
    `);
    db.run(
      `INSERT INTO calls (id, script, status, started_at) VALUES (?, ?, 'active', ?)`,
      ['legacy-call-1', 'legacy script', Date.now()],
    );

    runMigrations(db);

    const row = db.query(
      `SELECT user_id FROM calls WHERE id = ?`,
    ).get('legacy-call-1') as { user_id: string };
    expect(row.user_id).toBe('__demo__');
    // INTENTIONAL: legacy rows land in the demo bucket, accessible only via
    // the unauthenticated demo route (DEMO_USER_ID). They are NOT exposed to
    // any authenticated user. Changing this default would change the
    // cross-tenant data-classification semantics — break this test on purpose
    // if you change the design.
  });
});

describe('migration 007 — post-call status columns', () => {
  test('adds verdict_status, coaching_status, followup_status columns', () => {
    const db = freshDb();
    runMigrations(db);
    expect(tableHasColumn(db, 'calls', 'verdict_status')).toBe(true);
    expect(tableHasColumn(db, 'calls', 'coaching_status')).toBe(true);
    expect(tableHasColumn(db, 'calls', 'followup_status')).toBe(true);
  });

  test('idempotent — runs cleanly twice', () => {
    const db = freshDb();
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
  });
});
