#!/usr/bin/env node
/**
 * Seeds the knowledge base with demo pages from demo-pages/.
 * Used for task 10.1 — provides a starting base for ingest testing.
 *
 * Usage: npx tsx src/seed.ts
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { resolve, basename } from "node:path";
import { ensureLayout, getBaseDir } from "./layout.js";
import { ensureSchema } from "./schema.js";
import { syncPagesFromDisk, rebuildIndex } from "./pages.js";

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
