// File: packages/ledger/src/db.ts
import Database from 'better-sqlite3';

export type Db = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('ALLOW','ESCALATE','DENY')),
  rule_id TEXT NOT NULL,
  layer TEXT NOT NULL,
  verb TEXT NOT NULL,
  class TEXT NOT NULL,
  model TEXT,
  call_hash TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  target_id TEXT,
  request_hash TEXT,
  plan TEXT,
  region TEXT,
  request_json TEXT
);
CREATE TRIGGER IF NOT EXISTS decisions_no_update BEFORE UPDATE ON decisions
  BEGIN SELECT RAISE(ABORT, 'decisions are append-only'); END;
CREATE TRIGGER IF NOT EXISTS decisions_no_delete BEFORE DELETE ON decisions
  BEGIN SELECT RAISE(ABORT, 'decisions are append-only'); END;
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  session_id TEXT NOT NULL,
  detail_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS resources (
  id TEXT PRIMARY KEY,
  class TEXT NOT NULL,
  label TEXT NOT NULL,
  plan TEXT,
  hourly REAL NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL,
  destroyed_at_ms INTEGER,
  ttl_h REAL NOT NULL DEFAULT 1,
  protected INTEGER NOT NULL DEFAULT 0,
  session_id TEXT NOT NULL,
  allow_decision_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS spend (
  session_id TEXT PRIMARY KEY,
  usd_resources REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS inference_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL,
  completion_tokens INTEGER NOT NULL,
  usd REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS bond (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  free REAL NOT NULL,
  held REAL NOT NULL,
  burned REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS bond_actions (
  action_id TEXT PRIMARY KEY,
  amount REAL NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('held','released','burned'))
);
CREATE TABLE IF NOT EXISTS bond_sessions (
  session_id TEXT PRIMARY KEY,
  free REAL NOT NULL,
  held REAL NOT NULL,
  burned REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS approvals (
  decision_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  request_json TEXT NOT NULL,
  nonce TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','denied','expired')),
  created_at_ms INTEGER NOT NULL,
  decided_at_ms INTEGER
);
`;

/** CO-2 E-1: columns added after the first schema. A database file from before them gains the columns (nullable); no rows are written. */
const DECISION_COLUMNS_V2 = ['target_id', 'request_hash', 'plan', 'region', 'request_json'] as const;

function migrate(db: Db): void {
  const have = new Set((db.prepare('PRAGMA table_info(decisions)').all() as { name: string }[]).map((c) => c.name));
  for (const col of DECISION_COLUMNS_V2) {
    if (!have.has(col)) db.exec(`ALTER TABLE decisions ADD COLUMN ${col} TEXT`);
  }
  migrateBondActions(db);
}

/** Per-session bond: an older bond_actions table gains session_id (old rows get 'legacy'; the old global `bond` table stays, unused). */
function migrateBondActions(db: Db): void {
  const cols = (db.prepare('PRAGMA table_info(bond_actions)').all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('session_id')) db.exec("ALTER TABLE bond_actions ADD COLUMN session_id TEXT NOT NULL DEFAULT 'legacy'");
}

export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}
