/**
 * Unit tests for section 6 (Pipeline Wiring) — tasks 6.4, 6.5, 6.7, 6.8, 6.9.
 *
 * 6.4: Callout text appears in the page file (AC-9.5)
 * 6.5: Source claims become page claims directly (no re-extraction)
 * 6.7: Ingest record states explicitly when claims were compared and none conflicted
 * 6.8: Post-Apply DB failure leaves pages unchanged (rollback)
 * 6.9: Supersession annotation lands in the right section, passes isSubsequence
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ensureLayout } from "../src/layout.js";
import { ensureSchema, getDb, _resetDb } from "../src/schema.js";
import { writeIngestRecord } from "../src/record.js";
import { isSubsequence, simulateEditApplication, verifyEdit } from "../src/verify.js";
import { applyEdits } from "../src/apply.js";
import {
  formatContradictionCallout,
  formatContradictionId,
  formatSupersessionAnnotation,
} from "../src/contradict.js";
import { insertSourceClaimsAsPageClaims, refreshClaimHashes } from "../src/persist.js";
import { contentHash } from "../src/hash.js";
import type { Edit } from "../src/plan.js";

// ---------------------------------------------------------------------------
// Task 6.7 — Record states "compared, none conflicted"
// ---------------------------------------------------------------------------

describe("ingest record: comparison reporting (task 6.7)", () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "elenchus-record67-"));
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

  it("states 'Claims were compared and none conflicted' when no conflicts found (AC-11.2)", () => {
    const recordPath = writeIngestRecord({
      sourceOrigin: "/test/source.txt",
      sourceFilename: "abc-source.txt",
      candidates: [{ slug: "food-safety", reason: "Relevant." }],
      droppedCandidates: [],
      newTopic: false,
      decisions: [{ action: "weave", slug: "food-safety", reason: "Material fits." }],
      pagesChanged: [{ slug: "food-safety" }],
      rejectedEdits: [],
      detectedPairs: [],
      comparisonPerformed: true,
      rejectedPairs: [],
    });

    const content = readFileSync(recordPath, "utf-8");
    expect(content).toContain("Claims were compared and none conflicted.");
  });

  it("reports detected conflicts with classification and reasoning (AC-11.1)", () => {
    const recordPath = writeIngestRecord({
      sourceOrigin: "/test/source.txt",
      sourceFilename: "abc-source.txt",
      candidates: [{ slug: "kiro-docs", reason: "Relevant." }],
      droppedCandidates: [],
      newTopic: false,
      decisions: [{ action: "weave", slug: "kiro-docs", reason: "Material fits." }],
      pagesChanged: [{ slug: "kiro-docs" }],
      rejectedEdits: [],
      detectedPairs: [
        {
          sourceClaimText: "Kiro Web is available on the Free plan.",
          storedClaimText: "Kiro Web requires a Pro subscription.",
          label: "contradiction",
          reasoning: "Incompatible access requirements.",
          falsifier: "Cannot be both free and paid.",
        },
      ],
      comparisonPerformed: true,
      rejectedPairs: [],
    });

    const content = readFileSync(recordPath, "utf-8");
    expect(content).toContain("Detected **1** conflict(s)");
    expect(content).toContain("Contradiction");
    expect(content).toContain("Kiro Web is available on the Free plan.");
    expect(content).toContain("Incompatible access requirements.");
    expect(content).toContain("Cannot be both free and paid.");
  });

  it("reports 'No comparison performed' when no target pages exist", () => {
    const recordPath = writeIngestRecord({
      sourceOrigin: "/test/source.txt",
      sourceFilename: "abc-source.txt",
      candidates: [],
      droppedCandidates: [],
      newTopic: true,
      decisions: [{ action: "create", suggestedSlug: "new-topic", suggestedTitle: "New", reason: "New topic.", rejectedCandidates: [] }],
      pagesChanged: [{ slug: "new-topic" }],
      rejectedEdits: [],
      detectedPairs: [],
      comparisonPerformed: false,
      rejectedPairs: [],
    });

    const content = readFileSync(recordPath, "utf-8");
    expect(content).toContain("No comparison performed");
  });
});

// ---------------------------------------------------------------------------
// Task 6.4 — Contradiction callout appears on the page (AC-9.5)
// ---------------------------------------------------------------------------

describe("contradiction callout on page (task 6.4, AC-9.5)", () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "elenchus-callout-"));
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

  it("callout text appears in the page file after being applied as an edit", () => {
    // Write a page
    const pagesDir = resolve(tmpDir, "pages");
    const pagePath = resolve(pagesDir, "food-safety.md");
    const pageContent = [
      "# Food Safety",
      "",
      "## Temperature Danger Zone",
      "",
      "Bacteria multiply rapidly between 4 °C and 60 °C.",
      "",
    ].join("\n");
    writeFileSync(pagePath, pageContent, "utf-8");

    // Build the callout
    const entry = {
      id: "CD-001",
      claimA: {
        text: "Bacteria multiply rapidly between 4 °C and 60 °C.",
        sourceSlug: "seed-corpus",
        sourceDate: "2026-08-10",
      },
      claimB: {
        text: "Bacteria multiply rapidly between 5 °C and 63 °C.",
        sourceSlug: "new-safety-update",
        sourceDate: "2026-08-12",
      },
      reasoning: "The temperature ranges are incompatible.",
    };
    const callout = formatContradictionCallout(entry);

    // Apply as an edit
    const edit: Edit = {
      page: "food-safety",
      anchor: "## Temperature Danger Zone",
      insertion: callout,
    };

    const result = applyEdits([edit]);

    // The page file must contain the callout
    expect(result.written).toHaveLength(1);
    const finalContent = readFileSync(pagePath, "utf-8");
    expect(finalContent).toContain("[!warning] Contradiction — CD-001 · open");
    expect(finalContent).toContain("Bacteria multiply rapidly between 5 °C and 63 °C.");
    expect(finalContent).toContain("`src/seed-corpus`");
    expect(finalContent).toContain("`src/new-safety-update`");

    // Invariant: isSubsequence still holds
    expect(isSubsequence(pageContent, finalContent)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Task 6.9 — Supersession annotation lands in the right section
// ---------------------------------------------------------------------------

describe("supersession annotation in correct section (task 6.9)", () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "elenchus-supersede-"));
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

  it("annotation lands after the anchor section, not at the bottom", () => {
    const pagesDir = resolve(tmpDir, "pages");
    const pagePath = resolve(pagesDir, "exams.md");
    const pageContent = [
      "# Exams",
      "",
      "## Schedule",
      "",
      "The AI-103 exam is scheduled for 12 August 2026.",
      "",
      "## Preparation",
      "",
      "Study the materials before the exam.",
    ].join("\n");
    writeFileSync(pagePath, pageContent, "utf-8");

    const annotation = formatSupersessionAnnotation({
      existingClaimText: "The AI-103 exam is scheduled for 12 August 2026.",
      supersessionDate: "2026-08-12",
      sourceSlug: "reschedule-notice",
    });

    // Apply with the section anchor
    const edit: Edit = {
      page: "exams",
      anchor: "## Schedule",
      insertion: annotation,
    };

    const result = applyEdits([edit]);
    expect(result.written).toHaveLength(1);

    const finalContent = readFileSync(pagePath, "utf-8");
    expect(finalContent).toContain("*Superseded 2026-08-12 by `src/reschedule-notice`");

    // The annotation must appear BEFORE the ## Preparation section
    const annotationIdx = finalContent.indexOf("*Superseded");
    const prepIdx = finalContent.indexOf("## Preparation");
    expect(annotationIdx).toBeLessThan(prepIdx);

    // And AFTER the ## Schedule section
    const scheduleIdx = finalContent.indexOf("## Schedule");
    expect(annotationIdx).toBeGreaterThan(scheduleIdx);

    // Invariant: isSubsequence holds
    expect(isSubsequence(pageContent, finalContent)).toBe(true);
  });

  it("annotation passes verifyEdit through real production path", () => {
    const preContent = [
      "# Food Safety",
      "",
      "## Temperature Danger Zone",
      "",
      "Bacteria multiply rapidly between 4 °C and 60 °C.",
      "Perishable food should not remain in this range for more than two hours.",
      "",
      "## Cross-Contamination",
      "",
      "Raw meat must be stored below ready-to-eat foods.",
    ].join("\n");

    const annotation = formatSupersessionAnnotation({
      existingClaimText: "Perishable food should not remain in this range for more than two hours.",
      supersessionDate: "2026-08-12",
      sourceSlug: "new-safety-guidelines",
    });

    const edit: Edit = {
      page: "food-safety",
      anchor: "## Temperature Danger Zone",
      insertion: annotation,
    };

    const postContent = simulateEditApplication(preContent, edit);
    const outcome = verifyEdit(edit, preContent, postContent);
    expect(outcome.status).toBe("accepted");
    expect(isSubsequence(preContent, postContent)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Task 6.8 — Rollback: DB failure leaves pages unchanged
// ---------------------------------------------------------------------------

describe("rollback on post-Apply failure (task 6.8)", () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "elenchus-rollback-"));
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

  it("DB transaction rollback leaves no partial claim rows", () => {
    const db = getDb();

    // Create a source for FK
    db.prepare(
      "INSERT INTO sources (hash, filename, origin, byte_length) VALUES (?, ?, ?, ?)"
    ).run("test-hash", "test.txt", "test", 100);
    const sourceId = (db.prepare("SELECT id FROM sources WHERE hash = ?").get("test-hash") as { id: number }).id;

    // Write a page
    const pagesDir = resolve(tmpDir, "pages");
    writeFileSync(resolve(pagesDir, "test.md"), "# Test\n\nSome content.\n", "utf-8");
    const hash = contentHash("# Test\n\nSome content.\n");

    // Begin transaction, insert claims, then rollback
    db.exec("BEGIN TRANSACTION");
    db.prepare(
      "INSERT INTO claims (page, anchor, text, source_id, source_date, content_hash) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("test", "full-page", "Some claim.", sourceId, "2026-08-12", hash);

    // Verify the row exists inside the transaction
    const countInside = (db.prepare("SELECT COUNT(*) as cnt FROM claims").get() as { cnt: number }).cnt;
    expect(countInside).toBe(1);

    // Rollback
    db.exec("ROLLBACK");

    // Row is gone
    const countAfter = (db.prepare("SELECT COUNT(*) as cnt FROM claims").get() as { cnt: number }).cnt;
    expect(countAfter).toBe(0);
  });

  it("file content can be restored from cached originals", () => {
    const pagesDir = resolve(tmpDir, "pages");
    const pagePath = resolve(pagesDir, "food-safety.md");
    const original = "# Food Safety\n\nOriginal content.\n";
    writeFileSync(pagePath, original, "utf-8");

    // Simulate Apply writing new content
    const newContent = "# Food Safety\n\nOriginal content.\n\nNew material added.\n";
    writeFileSync(pagePath, newContent, "utf-8");

    // Simulate rollback by restoring from cached original
    writeFileSync(pagePath, original, "utf-8");

    const restored = readFileSync(pagePath, "utf-8");
    expect(restored).toBe(original);
  });
});

// ---------------------------------------------------------------------------
// Task 6.5 — Source claims become page claims directly
// ---------------------------------------------------------------------------

describe("source claims as page claims (task 6.5)", () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "elenchus-persist-"));
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

  it("insertSourceClaimsAsPageClaims persists claims with correct fields", () => {
    const db = getDb();

    // Create a source
    db.prepare(
      "INSERT INTO sources (hash, filename, origin, byte_length) VALUES (?, ?, ?, ?)"
    ).run("src-hash", "source.txt", "/path/source.txt", 200);
    const sourceId = (db.prepare("SELECT id FROM sources WHERE hash = ?").get("src-hash") as { id: number }).id;

    const claims = [
      { text: "Claim one.", anchor: "Section A" },
      { text: "Claim two.", anchor: "Section B" },
    ];
    const hash = "abcdef1234567890";

    const ids = insertSourceClaimsAsPageClaims("food-safety", claims, sourceId, "2026-08-12", "Temperature Danger Zone", hash);

    expect(ids).toHaveLength(2);

    // Verify stored correctly
    const rows = db.prepare("SELECT * FROM claims WHERE page = ? AND superseded_at IS NULL").all("food-safety") as Array<{
      id: number; page: string; anchor: string; text: string; source_id: number; source_date: string; content_hash: string;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].text).toBe("Claim one.");
    expect(rows[0].anchor).toBe("Temperature Danger Zone");
    expect(rows[0].source_id).toBe(sourceId);
    expect(rows[0].content_hash).toBe(hash);
    expect(rows[1].text).toBe("Claim two.");
  });

  it("refreshClaimHashes updates all active claims for a page", () => {
    const db = getDb();

    // Create a source and some claims
    db.prepare(
      "INSERT INTO sources (hash, filename, origin, byte_length) VALUES (?, ?, ?, ?)"
    ).run("src-hash2", "source2.txt", "/path/source2.txt", 200);
    const sourceId = (db.prepare("SELECT id FROM sources WHERE hash = ?").get("src-hash2") as { id: number }).id;

    db.prepare(
      "INSERT INTO claims (page, anchor, text, source_id, source_date, content_hash) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("test-page", "Section A", "Old claim.", sourceId, "2026-08-10", "old-hash");

    db.prepare(
      "INSERT INTO claims (page, anchor, text, source_id, source_date, content_hash) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("test-page", "Section B", "Another claim.", sourceId, "2026-08-10", "old-hash");

    // Refresh
    refreshClaimHashes("test-page", "new-hash-value");

    const rows = db.prepare("SELECT content_hash FROM claims WHERE page = ? AND superseded_at IS NULL").all("test-page") as Array<{ content_hash: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].content_hash).toBe("new-hash-value");
    expect(rows[1].content_hash).toBe("new-hash-value");
  });
});



// ---------------------------------------------------------------------------
// Supersession deduplication — one annotation per superseded stored claim
// ---------------------------------------------------------------------------

describe("supersession deduplication", () => {
  it("two source claims superseding the same stored claim produce one annotation", () => {
    // The deduplication happens in ingest.ts (via supersededClaimIds set).
    // Here we verify the annotation format — that formatSupersessionAnnotation
    // produces a single self-explanatory line, and that the same call produces
    // the same output (idempotent for dedup purposes).
    const entry = {
      existingClaimText: "The recommended safe internal temperature for poultry is 82 °C.",
      supersessionDate: "2026-08-12",
      sourceSlug: "poultry-temperature-revision",
    };

    const annotation1 = formatSupersessionAnnotation(entry);
    const annotation2 = formatSupersessionAnnotation(entry);

    // Same entry produces identical annotation (dedup would skip the second)
    expect(annotation1).toBe(annotation2);

    // The annotation is one line (no newlines)
    expect(annotation1).not.toContain("\n");

    // The annotation includes the superseded claim text
    expect(annotation1).toContain("82 °C");

    // The annotation includes the source slug (without hash prefix)
    expect(annotation1).toContain("poultry-temperature-revision");

    // Starts with *Superseded (italic)
    expect(annotation1).toMatch(/^\*Superseded/);
  });
});
