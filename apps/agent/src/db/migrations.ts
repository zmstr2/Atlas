import { Database } from 'bun:sqlite';

/**
 * Idempotent schema migrations. Run on every boot via runMigrations().
 *
 * SQLite has no ALTER TABLE IF NOT EXISTS, so each step that adds a column
 * checks PRAGMA table_info first. Safe to run twice.
 */
export function runMigrations(db: Database): void {
  // Base schema (idempotent CREATE IF NOT EXISTS) — kept here for clean installs.
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

  // --- Per-table column additions (idempotent via PRAGMA check) ---
  ensureColumn(db, 'calls', 'follow_up_email', 'TEXT');
  ensureColumn(db, 'calls', 'total_cost_usd', 'REAL DEFAULT 0');

  // user_id scoping — Lane B. Default '__demo__' lets older rows stay accessible
  // through the demo path which uses user_id='__demo__' as its sentinel.
  ensureColumn(db, 'calls', 'user_id', "TEXT NOT NULL DEFAULT '__demo__'");
  ensureColumn(db, 'utterances', 'user_id', "TEXT NOT NULL DEFAULT '__demo__'");
  ensureColumn(db, 'suggestions', 'user_id', "TEXT NOT NULL DEFAULT '__demo__'");

  // Backfill any pre-existing NULLs (defensive — DEFAULT handles new rows, but
  // if a column was added without a default in some past version, this catches it).
  db.exec(`UPDATE calls       SET user_id = '__demo__' WHERE user_id IS NULL OR user_id = ''`);
  db.exec(`UPDATE utterances  SET user_id = '__demo__' WHERE user_id IS NULL OR user_id = ''`);
  db.exec(`UPDATE suggestions SET user_id = '__demo__' WHERE user_id IS NULL OR user_id = ''`);

  // Per-user spend tracking.
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_quotas (
      user_id TEXT NOT NULL,
      date TEXT NOT NULL,
      total_cost_usd REAL NOT NULL DEFAULT 0,
      call_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, date)
    );
  `);

  // Indexes on user_id for the per-user list/scope queries.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_calls_user ON calls(user_id, started_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_utterances_user ON utterances(user_id, created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_suggestions_user ON suggestions(user_id, created_at)`);
}

function ensureColumn(db: Database, table: string, column: string, decl: string): void {
  const cols = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}
