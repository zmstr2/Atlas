import { Database } from 'bun:sqlite';

/**
 * Tiny migration runner for the local SQLite store. Not Postgres-grade — there
 * is no migration ledger; each migration is idempotent and self-checks via
 * PRAGMA before running. Sufficient for a single-user local DB that the
 * desktop app upgrades in place across versions.
 */
export type Migration = {
  name: string;
  run: (db: Database) => void;
};

function tableHasColumn(db: Database, table: string, column: string): boolean {
  const cols = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}

function tableExists(db: Database, table: string): boolean {
  const row = db.query(
    `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
  ).get(table) as { name: string } | null;
  return !!row;
}

const migrations: Migration[] = [
  {
    name: '001_create_initial_schema',
    run(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS calls (
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

        CREATE TABLE IF NOT EXISTS utterances (
          id TEXT PRIMARY KEY,
          call_id TEXT NOT NULL,
          participant_id TEXT,
          speaker TEXT NOT NULL,
          text TEXT NOT NULL,
          start_ms INTEGER NOT NULL,
          end_ms INTEGER NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
        );

        CREATE TABLE IF NOT EXISTS participants (
          call_id TEXT NOT NULL,
          participant_id TEXT NOT NULL,
          display_name TEXT,
          role TEXT NOT NULL DEFAULT 'unknown',
          first_seen_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
          PRIMARY KEY (call_id, participant_id)
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
        CREATE INDEX IF NOT EXISTS idx_participants_call ON participants(call_id);
        CREATE INDEX IF NOT EXISTS idx_calls_started ON calls(started_at DESC);
      `);
    },
  },
  {
    name: '002_drop_ip_sessions',
    run(db) {
      // Demo IP rate-limit table is irrelevant for the local desktop app.
      // Kept idempotent so this migration is safe to re-run.
      db.exec(`DROP TABLE IF EXISTS ip_sessions;`);
    },
  },
  {
    name: '003_add_call_columns_for_local',
    run(db) {
      // Backward-compatibility for installs that came from the demo schema:
      // the legacy demo schema had script NOT NULL and was missing several
      // desktop-mode columns. Add them in place.
      if (!tableHasColumn(db, 'calls', 'follow_up_email')) {
        db.exec(`ALTER TABLE calls ADD COLUMN follow_up_email TEXT`);
      }
      if (!tableHasColumn(db, 'calls', 'total_cost_usd')) {
        db.exec(`ALTER TABLE calls ADD COLUMN total_cost_usd REAL DEFAULT 0`);
      }
      if (!tableHasColumn(db, 'calls', 'coaching_artifact')) {
        db.exec(`ALTER TABLE calls ADD COLUMN coaching_artifact TEXT`);
      }
      if (!tableHasColumn(db, 'calls', 'prospect_name')) {
        db.exec(`ALTER TABLE calls ADD COLUMN prospect_name TEXT`);
      }
      if (!tableHasColumn(db, 'calls', 'meeting_url')) {
        db.exec(`ALTER TABLE calls ADD COLUMN meeting_url TEXT`);
      }
      if (!tableHasColumn(db, 'calls', 'brief_json')) {
        db.exec(`ALTER TABLE calls ADD COLUMN brief_json TEXT`);
      }
      if (!tableHasColumn(db, 'calls', 'status')) {
        db.exec(`ALTER TABLE calls ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`);
      }
      // Backfill: copy legacy training_delta into coaching_artifact once,
      // then null the old column. Don't drop it — SQLite ALTER TABLE DROP
      // COLUMN is finicky on older versions.
      if (tableHasColumn(db, 'calls', 'training_delta')) {
        db.exec(
          `UPDATE calls SET coaching_artifact = training_delta
           WHERE coaching_artifact IS NULL AND training_delta IS NOT NULL`,
        );
      }
    },
  },
  {
    name: '004_add_utterance_participant_id',
    run(db) {
      if (!tableHasColumn(db, 'utterances', 'participant_id')) {
        db.exec(`ALTER TABLE utterances ADD COLUMN participant_id TEXT`);
      }
    },
  },
];

export function runMigrations(db: Database): void {
  for (const m of migrations) {
    try {
      m.run(db);
    } catch (err) {
      console.error(`[migrations] ${m.name} failed:`, err);
      throw err;
    }
  }
}
