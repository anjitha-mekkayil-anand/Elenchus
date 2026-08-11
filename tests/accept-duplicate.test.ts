/**
 * Unit tests for task 2.5 — duplicate detection and --force flag.
 * AC-6.1: already-processed source recognised, no modification.
 * AC-6.2: forced re-ingest proceeds and records the force.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  acceptSource,
  isRejection,
  hashContent,
  findExistingSource,
} from "../src/accept.js";
import { ensureLayout } from "../src/layout.js";
import { ensureSchema, _resetDb } from "../src/schema.js";

describe("hashContent (task 2.5)", () => {
  it("produces a 64-char hex SHA-256", () => {
    const hash = hashContent("hello world");
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("same content → same hash", () => {
    const h1 = hashContent("identical text");
    const h2 = hashContent("identical text");
    expect(h1).toBe(h2);
  });

  it("different content → different hash", () => {
    const h1 = hashContent("version one");
    const h2 = hashContent("version two");
    expect(h1).not.toBe(h2);
  });
});

describe("duplicate detection (AC-6.1)", () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "elenchus-dup-test-"));
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

  it("first ingest of a source succeeds and creates a file", async () => {
    const srcFile = join(tmpDir, "doc.md");
    writeFileSync(srcFile, "This is real content for a knowledge base page.", "utf-8");

    const outcome = await acceptSource(srcFile);
    expect(isRejection(outcome)).toBe(false);
    if (!isRejection(outcome)) {
      expect(outcome.alreadyIngested).toBe(false);
      expect(outcome.forced).toBe(false);
      expect(outcome.sourceId).toBeGreaterThan(0);
      expect(outcome.filename).toBeTruthy();
    }
  });

  it("second ingest of same content is detected as duplicate", async () => {
    const srcFile = join(tmpDir, "doc.md");
    writeFileSync(srcFile, "This is real content for a knowledge base page.", "utf-8");

    // First ingest
    const first = await acceptSource(srcFile);
    expect(isRejection(first)).toBe(false);

    // Second ingest — same content
    const second = await acceptSource(srcFile);
    expect(isRejection(second)).toBe(false);
    if (!isRejection(second)) {
      expect(second.alreadyIngested).toBe(true);
      expect(second.forced).toBe(false);
    }
  });

  it("duplicate detection works regardless of file path", async () => {
    const content = "Duplicate detection should be content-based not path-based.";

    const fileA = join(tmpDir, "a.md");
    const fileB = join(tmpDir, "b.md");
    writeFileSync(fileA, content, "utf-8");
    writeFileSync(fileB, content, "utf-8");

    const first = await acceptSource(fileA);
    expect(isRejection(first)).toBe(false);

    const second = await acceptSource(fileB);
    expect(isRejection(second)).toBe(false);
    if (!isRejection(second)) {
      expect(second.alreadyIngested).toBe(true);
    }
  });

  it("different content is not flagged as duplicate", async () => {
    const fileA = join(tmpDir, "a.md");
    const fileB = join(tmpDir, "b.md");
    writeFileSync(fileA, "Content about topic A with enough detail.", "utf-8");
    writeFileSync(fileB, "Entirely different content about topic B.", "utf-8");

    const first = await acceptSource(fileA);
    expect(isRejection(first)).toBe(false);

    const second = await acceptSource(fileB);
    expect(isRejection(second)).toBe(false);
    if (!isRejection(second)) {
      expect(second.alreadyIngested).toBe(false);
    }
  });

  it("sources/ file is only written once (write-once, AC-1.4)", async () => {
    const content = "Write-once test content for the knowledge base.";
    const fileA = join(tmpDir, "original.md");
    writeFileSync(fileA, content, "utf-8");

    await acceptSource(fileA);
    const sourcesAfterFirst = readdirSync(join(tmpDir, "sources"));
    expect(sourcesAfterFirst).toHaveLength(1);

    // Read the persisted source content
    const persistedContent = readFileSync(
      join(tmpDir, "sources", sourcesAfterFirst[0]),
      "utf-8"
    );
    expect(persistedContent).toBe(content);

    // Second attempt (duplicate) — no new file written
    await acceptSource(fileA);
    const sourcesAfterSecond = readdirSync(join(tmpDir, "sources"));
    expect(sourcesAfterSecond).toHaveLength(1);
  });
});

describe("--force flag (AC-6.2)", () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "elenchus-force-test-"));
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

  it("--force on a duplicate proceeds and marks forced=true", async () => {
    const content = "Content that will be force-reingested for testing.";
    const srcFile = join(tmpDir, "doc.md");
    writeFileSync(srcFile, content, "utf-8");

    // First ingest (normal)
    const first = await acceptSource(srcFile);
    expect(isRejection(first)).toBe(false);

    // Forced re-ingest
    const forced = await acceptSource(srcFile, { force: true });
    expect(isRejection(forced)).toBe(false);
    if (!isRejection(forced)) {
      expect(forced.alreadyIngested).toBe(true);
      expect(forced.forced).toBe(true);
      expect(forced.sourceId).toBeGreaterThan(0);
    }
  });

  it("--force on a new source just ingests normally", async () => {
    const srcFile = join(tmpDir, "brand-new.md");
    writeFileSync(srcFile, "Brand new content, never seen before in the system.", "utf-8");

    const outcome = await acceptSource(srcFile, { force: true });
    expect(isRejection(outcome)).toBe(false);
    if (!isRejection(outcome)) {
      expect(outcome.alreadyIngested).toBe(false);
      expect(outcome.forced).toBe(false); // not forced because it was new
    }
  });

  it("findExistingSource returns the correct ID after insert", async () => {
    const content = "Finding existing source by hash lookup test content.";
    const srcFile = join(tmpDir, "findme.md");
    writeFileSync(srcFile, content, "utf-8");

    const hash = hashContent(content);

    // Before insert
    expect(findExistingSource(hash)).toBeNull();

    // After insert
    await acceptSource(srcFile);
    const id = findExistingSource(hash);
    expect(id).not.toBeNull();
    expect(id).toBeGreaterThan(0);
  });
});
