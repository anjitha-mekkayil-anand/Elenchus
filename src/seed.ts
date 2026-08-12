#!/usr/bin/env node
/**
 * Seeds the knowledge base with demo pages from demo-pages/.
 * Used for task 10.1 — provides a starting base for ingest testing.
 *
 * Creates a `seed-corpus` source row in SQLite so that claims extracted
 * from seeded pages are correctly attributed (Decision 2, section 6).
 *
 * Usage: npx tsx src/seed.ts
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { resolve, basename } from "node:path";
import { ensureLayout, getBaseDir } from "./layout.js";
import { ensureSchema, getDb } from "./schema.js";
import { syncPagesFromDisk, rebuildIndex } from "./pages.js";
import { createHash } from "node:crypto";

ensureLayout();
ensureSchema();

const base = getBaseDir();
const demoPagesDir = resolve(base, "demo-pages");
const pagesDir = resolve(base, "pages");

if (!existsSync(demoPagesDir)) {
  console.error("[seed] demo-pages/ directory not found.");
  process.exit(1);
}

const files = readdirSync(demoPagesDir).filter((f) => f.endsWith(".md"));

if (files.length === 0) {
  console.error("[seed] No .md files found in demo-pages/.");
  process.exit(1);
}

// Ensure the seed-corpus source exists in SQLite.
// This is what page claims extracted from seeded pages attribute to.
const db = getDb();
const seedHash = createHash("sha256").update("seed-corpus").digest("hex");
const existingSource = db.prepare("SELECT id FROM sources WHERE hash = ?").get(seedHash) as { id: number } | undefined;
if (!existingSource) {
  db.prepare(
    "INSERT INTO sources (hash, filename, origin, byte_length) VALUES (?, ?, ?, ?)"
  ).run(seedHash, "seed-corpus", "seed-corpus", 0);
  console.log("[seed] Created seed-corpus source row.");
}

let seeded = 0;
for (const file of files) {
  const src = resolve(demoPagesDir, file);
  const dest = resolve(pagesDir, file);

  if (existsSync(dest)) {
    console.log(`  [skip] ${file} (already exists)`);
    continue;
  }

  copyFileSync(src, dest);
  console.log(`  [seed] ${file}`);
  seeded++;
}

// Sync to SQLite and rebuild index
syncPagesFromDisk();
rebuildIndex();

console.log(`[seed] Done. ${seeded} page(s) seeded, index rebuilt.`);
