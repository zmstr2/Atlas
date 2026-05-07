import { Database } from 'bun:sqlite';

/**
 * Tiny migration runner for the local SQLite store. Not Postgres-grade — there
 * is no migration ledger; each migration is idempotent and self-checks via
 * PRAGMA before running. Sufficient for a single-instance Railway deployment
 * AND for the legacy desktop in-process DB.
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
      // Demo IP rate-limit table is now in-memory only.
      db.exec(`DROP TABLE IF EXISTS ip_sessions;`);
    },
  },
  {
    name: '003_add_call_columns_for_local',
    run(db) {
      // Backward-compatibility for installs that came from the demo schema.
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
      // Backfill: copy legacy training_delta into coaching_artifact once.
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
  {
    name: '005_add_user_id_scoping',
    run(db) {
      // user_id scoping for multi-tenant Railway deployment. Default '__demo__'
      // keeps existing rows accessible via the demo flow (which uses
      // DEMO_USER_ID = '__demo__' as its sentinel).
      if (!tableHasColumn(db, 'calls', 'user_id')) {
        db.exec(`ALTER TABLE calls ADD COLUMN user_id TEXT NOT NULL DEFAULT '__demo__'`);
      }
      if (!tableHasColumn(db, 'utterances', 'user_id')) {
        db.exec(`ALTER TABLE utterances ADD COLUMN user_id TEXT NOT NULL DEFAULT '__demo__'`);
      }
      if (!tableHasColumn(db, 'suggestions', 'user_id')) {
        db.exec(`ALTER TABLE suggestions ADD COLUMN user_id TEXT NOT NULL DEFAULT '__demo__'`);
      }
      // Defensive backfill in case older rows landed with NULL.
      db.exec(`UPDATE calls       SET user_id = '__demo__' WHERE user_id IS NULL OR user_id = ''`);
      db.exec(`UPDATE utterances  SET user_id = '__demo__' WHERE user_id IS NULL OR user_id = ''`);
      db.exec(`UPDATE suggestions SET user_id = '__demo__' WHERE user_id IS NULL OR user_id = ''`);

      db.exec(`CREATE INDEX IF NOT EXISTS idx_calls_user ON calls(user_id, started_at DESC)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_utterances_user ON utterances(user_id, created_at)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_suggestions_user ON suggestions(user_id, created_at)`);
    },
  },
  {
    name: '006_create_user_quotas',
    run(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS user_quotas (
          user_id TEXT NOT NULL,
          date TEXT NOT NULL,
          total_cost_usd REAL NOT NULL DEFAULT 0,
          call_count INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (user_id, date)
        );
      `);
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

// Re-exported for tests
export { tableExists, tableHasColumn };
