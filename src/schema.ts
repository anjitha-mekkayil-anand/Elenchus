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

  db.exec(SCHEMA_SQL);
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
