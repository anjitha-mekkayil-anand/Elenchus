import Database from "better-sqlite3";
import { resolve } from "node:path";
import { getBaseDir } from "./layout.js";

const SCHEMA_SQL = `
-- Sources: the raw material handed to elenchus (AC-1.4: persisted unmodified)
CREATE TABLE IF NOT EXISTS sources (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  hash          TEXT NOT NULL UNIQUE,        -- SHA-256 of extracted text, for idempotency (AC-6.1)
  filename      TEXT NOT NULL,               -- on-disk filename under sources/
  origin        TEXT NOT NULL,               -- original path or URL as given by user
  accepted_at   TEXT NOT NULL DEFAULT (datetime('now')),
  byte_length   INTEGER NOT NULL
);

-- Pages: the knowledge base pages on disk (NF-1: markdown files)
CREATE TABLE IF NOT EXISTS pages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  slug          TEXT NOT NULL UNIQUE,        -- filename stem, used as key
  title         TEXT NOT NULL,
  summary       TEXT NOT NULL DEFAULT '',    -- one-line summary for retrieval (design.md)
  content_hash  TEXT NOT NULL DEFAULT '',    -- SHA-256 of page content; staleness check (AC-7.4)
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Ingests: one row per ingest run
CREATE TABLE IF NOT EXISTS ingests (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id     INTEGER NOT NULL REFERENCES sources(id),
  started_at    TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at  TEXT,
  status        TEXT NOT NULL DEFAULT 'running', -- running | completed | failed
  forced        INTEGER NOT NULL DEFAULT 0,      -- 1 if --force was used (AC-6.2)
  record_file   TEXT                              -- path to the markdown ingest record
);

-- Edits: individual edits planned and applied (or rejected) within an ingest
CREATE TABLE IF NOT EXISTS edits (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ingest_id     INTEGER NOT NULL REFERENCES ingests(id),
  page_slug     TEXT NOT NULL,
  anchor        TEXT,                            -- section/location for insertion
  status        TEXT NOT NULL DEFAULT 'planned', -- planned | applied | rejected
  rejection_reason TEXT,                         -- why it was rejected (AC-4.2)
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Claims: factual assertions stored against pages (spec 2, AC-7.2)
-- These are PAGE claims (bound), persisted after Apply with the content hash as written.
-- Source claims (unbound) are held in memory during an ingest and never stored here.
-- Nothing deletes a claim: AC-10.3 requires rejected claims retained after resolution.
-- superseded_at: NULL = active; set when re-extraction replaces this claim (AC-7.4).
-- Re-extraction marks old rows superseded and inserts new ones — never deletes.
-- Contradictions keep referencing superseded rows, so history survives and the FK never breaks.
CREATE TABLE IF NOT EXISTS claims (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  page          TEXT NOT NULL,               -- page slug
  anchor        TEXT NOT NULL,               -- location within the page
  text          TEXT NOT NULL,               -- the claim in its own words
  source_id     INTEGER NOT NULL REFERENCES sources(id),
  source_date   TEXT NOT NULL,               -- date from the source
  content_hash  TEXT NOT NULL,               -- hash of page content when claim was persisted
  superseded_at TEXT                          -- NULL = active; ISO timestamp when superseded
);

-- Contradictions: detected conflicts between claims (spec 2, AC-8.x, AC-10.x)
-- kind: 'contradiction' | 'supersession'
-- status: 'open' | 'resolved'
-- Supersessions are stored for auditability (AC-8.5) but only contradictions reach the register.
-- RESTRICT on claim references: nothing deletes a claim (AC-10.3).
-- UNIQUE(claim_a, claim_b): AC-10.4 reopens rather than duplicates (mechanically enforced).
CREATE TABLE IF NOT EXISTS contradictions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  claim_a         INTEGER NOT NULL REFERENCES claims(id) ON DELETE RESTRICT,
  claim_b         INTEGER NOT NULL REFERENCES claims(id) ON DELETE RESTRICT,
  kind            TEXT NOT NULL DEFAULT 'contradiction',  -- 'contradiction' | 'supersession'
  reasoning       TEXT NOT NULL DEFAULT '',               -- AC-8.8: reasoning for classification
  status          TEXT NOT NULL DEFAULT 'open',           -- 'open' | 'resolved'
  resolved_keep   TEXT,                                    -- 'A' | 'B' | null
  resolved_at     TEXT,                                    -- datetime of resolution
  resolved_reason TEXT,                                    -- user's stated reason (AC-10.2)
  UNIQUE(claim_a, claim_b)
);
`;

let db: Database.Database | null = null;

/**
 * Opens (or returns cached) the SQLite database and ensures the schema exists.
 */
export function ensureSchema(): Database.Database {
  if (db) return db;

  const dbPath = resolve(getBaseDir(), "elenchus.db");
  db = new Database(dbPath);

  // WAL mode for better concurrent read performance
  db.pragma("journal_mode = WAL");
  // Enable foreign key enforcement (SQLite does not enforce by default)
  db.pragma("foreign_keys = ON");

  db.exec(SCHEMA_SQL);

  // Migration: add content_hash to pages if it doesn't exist (for databases
  // created before spec 2). SQLite has no ALTER TABLE ... IF NOT EXISTS, so
  // we check the column list first.
  const cols = db.pragma("table_info(pages)") as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "content_hash")) {
    db.exec("ALTER TABLE pages ADD COLUMN content_hash TEXT NOT NULL DEFAULT ''");
  }

  // Migration: add superseded_at to claims if it doesn't exist (for databases
  // created before the staleness/re-extraction feature, task 3.2).
  const claimCols = db.pragma("table_info(claims)") as Array<{ name: string }>;
  if (!claimCols.some((c) => c.name === "superseded_at")) {
    db.exec("ALTER TABLE claims ADD COLUMN superseded_at TEXT");
  }

  // Migration: add UNIQUE(claim_a, claim_b) index to contradictions if missing
  // (for databases created before the unique constraint was added).
  const indexes = db!.pragma("index_list(contradictions)") as Array<{ name: string }>;
  const hasUniqueIndex = indexes.some((idx) => {
    const info = db!.pragma(`index_info("${idx.name}")`) as Array<{ name: string }>;
    const colNames = info.map((c) => c.name);
    return colNames.includes("claim_a") && colNames.includes("claim_b");
  });
  if (!hasUniqueIndex) {
    db!.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_contradictions_pair ON contradictions(claim_a, claim_b)");
  }

  return db;
}

/**
 * Returns the current database instance. Throws if ensureSchema() has not been called.
 */
export function getDb(): Database.Database {
  if (!db) {
    throw new Error("Database not initialised. Call ensureSchema() first.");
  }
  return db;
}

/**
 * Closes and resets the database connection.
 * Used in tests to allow a fresh database per test case.
 */
export function _resetDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
