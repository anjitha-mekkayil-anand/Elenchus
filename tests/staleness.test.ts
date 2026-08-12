/**
 * Unit tests for section 3 (Staleness) — tasks 3.1–3.4.
 *
 * Tests insert claim rows directly with a known hash, then mutate the file.
 * This is the correct approach because page claims are normally persisted at
 * task 6.5 (after Apply), which is not built yet. These tests exercise the
 * staleness detection and re-extraction path in isolation.
 *
 * Uses a FakeModelClient with canned responses — no real model calls.
 * The fake simulates what the model would return for a given page content.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ensureLayout } from "../src/layout.js";
import { ensureSchema, getDb, _resetDb } from "../src/schema.js";
import { contentHash } from "../src/hash.js";
import { ensurePageClaims } from "../src/staleness.js";
import type { ModelClient, ModelRequest, ModelResponse } from "../src/model/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A FakeModelClient that returns a canned JSON array of claims.
 * Tracks how many times complete() is called to verify re-extraction behaviour.
 */
class FakeModelClient implements ModelClient {
  public callCount = 0;
  constructor(private readonly claims: Array<{ text: string }>) {}

  async complete(_req: ModelRequest): Promise<ModelResponse> {
    this.callCount++;
    return {
      content: JSON.stringify(this.claims),
      model: "fake-model",
    };
  }
}

/**
 * Inserts a source row into the DB. Returns the source id.
 * Needed because claims.source_id references sources(id).
 */
function insertSource(db: ReturnType<typeof getDb>): number {
  const result = db
    .prepare(
      "INSERT INTO sources (hash, filename, origin, byte_length) VALUES (?, ?, ?, ?)"
    )
    .run("abc123hash", "test-source.txt", "/test/source.txt", 100);
  return Number(result.lastInsertRowid);
}

/**
 * Inserts a claim row directly into the DB with a known content hash.
 */
function insertClaim(
  db: ReturnType<typeof getDb>,
  opts: {
    page: string;
    text: string;
    sourceId: number;
    contentHash: string;
  }
): number {
  const result = db
    .prepare(
      "INSERT INTO claims (page, anchor, text, source_id, source_date, content_hash) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(opts.page, "full-page", opts.text, opts.sourceId, "2026-08-10", opts.contentHash);
  return Number(result.lastInsertRowid);
}

/**
 * Counts active (non-superseded) claims for a page.
 */
function countActiveClaims(db: ReturnType<typeof getDb>, page: string): number {
  const row = db
    .prepare("SELECT COUNT(*) as cnt FROM claims WHERE page = ? AND superseded_at IS NULL")
    .get(page) as { cnt: number };
  return row.cnt;
}

/**
 * Counts superseded claims for a page.
 */
function countSupersededClaims(db: ReturnType<typeof getDb>, page: string): number {
  const row = db
    .prepare("SELECT COUNT(*) as cnt FROM claims WHERE page = ? AND superseded_at IS NOT NULL")
    .get(page) as { cnt: number };
  return row.cnt;
}

// ---------------------------------------------------------------------------
// Task 3.3 — hand-edit triggers re-extraction
// ---------------------------------------------------------------------------

describe("staleness: hand-edit triggers re-extraction (task 3.3)", () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "elenchus-stale-"));
    originalCwd = process.cwd();
    process.chdir(tmpDir);
    ensureLayout();
    ensureSchema();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    _resetDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("re-extracts when page content hash differs from stored claims (AC-7.4)", async () => {
    const db = getDb();
    const sourceId = insertSource(db);

    // Write initial page content and compute its hash.
    const pageDir = resolve(tmpDir, "pages");
    const pageFile = resolve(pageDir, "food-safety.md");
    const originalContent = "# Food Safety\n\nBacteria grow between 4 and 60 C.\n";
    writeFileSync(pageFile, originalContent, "utf-8");
    const originalHash = contentHash(originalContent);

    // Register the page in the pages table.
    db.prepare("INSERT INTO pages (slug, title, summary, content_hash) VALUES (?, ?, ?, ?)").run(
      "food-safety",
      "Food Safety",
      "Bacteria grow between 4 and 60 C.",
      originalHash
    );

    // Insert a claim with the original hash — simulates what 6.5 would do.
    insertClaim(db, {
      page: "food-safety",
      text: "Bacteria grow between 4 and 60 C.",
      sourceId,
      contentHash: originalHash,
    });

    expect(countActiveClaims(db, "food-safety")).toBe(1);

    // Simulate a hand-edit: modify the page file.
    const editedContent = "# Food Safety\n\nBacteria grow between 5 and 63 C.\n";
    writeFileSync(pageFile, editedContent, "utf-8");

    // The fake model returns claims for the new content.
    const fake = new FakeModelClient([
      { text: "Bacteria grow between 5 and 63 C." },
    ]);

    const result = await ensurePageClaims("food-safety", sourceId, "2026-08-12", fake);

    // Re-extraction was triggered.
    expect(result.reExtracted).toBe(true);
    expect(fake.callCount).toBe(1);

    // The old claim is superseded, not deleted.
    expect(countSupersededClaims(db, "food-safety")).toBe(1);

    // The new claim is active.
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0].text).toBe("Bacteria grow between 5 and 63 C.");
    expect(countActiveClaims(db, "food-safety")).toBe(1);

    // The new claim carries the current hash.
    const editedHash = contentHash(editedContent);
    expect(result.claims[0].content_hash).toBe(editedHash);
    expect(result.currentHash).toBe(editedHash);
  });

  it("re-extracts when page has no active claims at all (AC-7.7 — cache miss)", async () => {
    const db = getDb();
    const sourceId = insertSource(db);

    // Write a page file (simulates a seeded page with no claims).
    const pageDir = resolve(tmpDir, "pages");
    const pageFile = resolve(pageDir, "nutrition.md");
    const content = "# Nutrition\n\nProtein yields 4 kcal per gram.\n";
    writeFileSync(pageFile, content, "utf-8");

    // Register the page — no content_hash set (empty default, like seed).
    db.prepare("INSERT INTO pages (slug, title, summary) VALUES (?, ?, ?)").run(
      "nutrition",
      "Nutrition",
      "Protein yields 4 kcal per gram."
    );

    // No claims inserted — this is the AC-7.7 scenario.
    expect(countActiveClaims(db, "nutrition")).toBe(0);

    const fake = new FakeModelClient([
      { text: "Protein yields 4 kcal per gram." },
    ]);

    const result = await ensurePageClaims("nutrition", sourceId, "2026-08-12", fake);

    // Re-extraction triggered because no active claims.
    expect(result.reExtracted).toBe(true);
    expect(fake.callCount).toBe(1);

    // Claims now stored.
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0].text).toBe("Protein yields 4 kcal per gram.");
    expect(countActiveClaims(db, "nutrition")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Task 3.4 — second call does NOT re-extract
// ---------------------------------------------------------------------------

describe("staleness: no re-extraction after fresh extraction (task 3.4)", () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "elenchus-stale2-"));
    originalCwd = process.cwd();
    process.chdir(tmpDir);
    ensureLayout();
    ensureSchema();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    _resetDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not re-extract when hash matches and active claims exist (task 3.4)", async () => {
    const db = getDb();
    const sourceId = insertSource(db);

    // Write a page and compute its hash.
    const pageFile = resolve(tmpDir, "pages", "food-safety.md");
    const content = "# Food Safety\n\nBacteria grow between 4 and 60 C.\n";
    writeFileSync(pageFile, content, "utf-8");
    const hash = contentHash(content);

    // Register the page with the correct hash.
    db.prepare("INSERT INTO pages (slug, title, summary, content_hash) VALUES (?, ?, ?, ?)").run(
      "food-safety",
      "Food Safety",
      "Bacteria info.",
      hash
    );

    // Insert a claim with the matching hash.
    insertClaim(db, {
      page: "food-safety",
      text: "Bacteria grow between 4 and 60 C.",
      sourceId,
      contentHash: hash,
    });

    const fake = new FakeModelClient([
      { text: "This should never be called." },
    ]);

    const result = await ensurePageClaims("food-safety", sourceId, "2026-08-12", fake);

    // No re-extraction — hash matches and claims exist.
    expect(result.reExtracted).toBe(false);
    expect(fake.callCount).toBe(0);

    // Returns existing claims.
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0].text).toBe("Bacteria grow between 4 and 60 C.");
  });

  it("after a re-extraction, a second call does not re-extract again (task 3.4)", async () => {
    const db = getDb();
    const sourceId = insertSource(db);

    // Write a page.
    const pageFile = resolve(tmpDir, "pages", "food-safety.md");
    const content = "# Food Safety\n\nBacteria grow between 5 and 63 C.\n";
    writeFileSync(pageFile, content, "utf-8");
    const hash = contentHash(content);

    // Register the page with NO content_hash (simulates seed).
    db.prepare("INSERT INTO pages (slug, title, summary) VALUES (?, ?, ?)").run(
      "food-safety",
      "Food Safety",
      "Bacteria info."
    );

    // No claims — triggers AC-7.7 on first call.
    const fake = new FakeModelClient([
      { text: "Bacteria grow between 5 and 63 C." },
    ]);

    // First call: re-extracts.
    const result1 = await ensurePageClaims("food-safety", sourceId, "2026-08-12", fake);
    expect(result1.reExtracted).toBe(true);
    expect(fake.callCount).toBe(1);

    // Second call: same file, claims now stored with correct hash.
    const result2 = await ensurePageClaims("food-safety", sourceId, "2026-08-12", fake);
    expect(result2.reExtracted).toBe(false);
    expect(fake.callCount).toBe(1); // Still 1 — no new call.

    // Returns the same claims.
    expect(result2.claims).toHaveLength(1);
    expect(result2.claims[0].text).toBe("Bacteria grow between 5 and 63 C.");
  });

  it("superseded claims are never returned by ensurePageClaims", async () => {
    const db = getDb();
    const sourceId = insertSource(db);

    // Write a page.
    const pageFile = resolve(tmpDir, "pages", "food-safety.md");
    const originalContent = "# Food Safety\n\nOld fact here.\n";
    writeFileSync(pageFile, originalContent, "utf-8");
    const originalHash = contentHash(originalContent);

    // Register the page.
    db.prepare("INSERT INTO pages (slug, title, summary, content_hash) VALUES (?, ?, ?, ?)").run(
      "food-safety",
      "Food Safety",
      "Old fact.",
      originalHash
    );

    // Insert original claim.
    insertClaim(db, {
      page: "food-safety",
      text: "Old fact here.",
      sourceId,
      contentHash: originalHash,
    });

    // Hand-edit the file.
    const newContent = "# Food Safety\n\nNew fact here.\n";
    writeFileSync(pageFile, newContent, "utf-8");

    const fake = new FakeModelClient([{ text: "New fact here." }]);

    // First call: re-extracts.
    const result = await ensurePageClaims("food-safety", sourceId, "2026-08-12", fake);
    expect(result.reExtracted).toBe(true);
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0].text).toBe("New fact here.");

    // Verify: old claim is superseded, new is active.
    expect(countSupersededClaims(db, "food-safety")).toBe(1);
    expect(countActiveClaims(db, "food-safety")).toBe(1);

    // Second call: no re-extraction, returns only new claim.
    const result2 = await ensurePageClaims("food-safety", sourceId, "2026-08-12", fake);
    expect(result2.reExtracted).toBe(false);
    expect(result2.claims).toHaveLength(1);
    expect(result2.claims[0].text).toBe("New fact here.");
  });
});
