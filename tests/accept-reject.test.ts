/**
 * Unit tests for task 2.3 — rejection of empty/no-extractable-text sources.
 * AC-1.3: reject with a stated reason and write nothing.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateContent, acceptSource, isRejection } from "../src/accept.js";
import { ensureLayout } from "../src/layout.js";
import { ensureSchema, _resetDb } from "../src/schema.js";

describe("validateContent (task 2.3)", () => {
  it("rejects empty string", () => {
    const reason = validateContent("");
    expect(reason).not.toBeNull();
    expect(reason).toContain("empty");
  });

  it("rejects whitespace-only content", () => {
    const reason = validateContent("   \n\n\t  \n  ");
    expect(reason).not.toBeNull();
    expect(reason).toContain("whitespace");
  });

  it("accepts content with any non-whitespace characters", () => {
    const reason = validateContent("X is true");
    expect(reason).toBeNull();
  });

  it("accepts a very short but real source", () => {
    const reason = validateContent("hi");
    expect(reason).toBeNull();
  });

  it("accepts content with 10+ meaningful characters", () => {
    const reason = validateContent("This is a valid source with real content.");
    expect(reason).toBeNull();
  });

  it("accepts markdown with formatting but enough text", () => {
    const reason = validateContent("# Title\n\nSome paragraph text here.");
    expect(reason).toBeNull();
  });
});

describe("acceptSource rejection paths (task 2.3)", () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "elenchus-test-"));
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

  it("rejects a non-existent file path", async () => {
    const outcome = await acceptSource("/does/not/exist.md");
    expect(isRejection(outcome)).toBe(true);
    if (isRejection(outcome)) {
      expect(outcome.reason).toContain("File read failed");
    }
  });

  it("rejects an empty file — writes nothing to sources/", async () => {
    const emptyFile = join(tmpDir, "empty.md");
    writeFileSync(emptyFile, "", "utf-8");

    const outcome = await acceptSource(emptyFile);
    expect(isRejection(outcome)).toBe(true);
    if (isRejection(outcome)) {
      expect(outcome.reason).toContain("empty");
    }

    // AC-1.3: SHALL NOT create or modify any page — also shouldn't write to sources/
    const sources = readdirSync(join(tmpDir, "sources"));
    expect(sources).toHaveLength(0);
  });

  it("rejects a whitespace-only file — writes nothing to sources/", async () => {
    const wsFile = join(tmpDir, "whitespace.txt");
    writeFileSync(wsFile, "   \n\n\t\n  ", "utf-8");

    const outcome = await acceptSource(wsFile);
    expect(isRejection(outcome)).toBe(true);
    if (isRejection(outcome)) {
      expect(outcome.reason).toContain("whitespace");
    }

    const sources = readdirSync(join(tmpDir, "sources"));
    expect(sources).toHaveLength(0);
  });

  it("accepts a very short but real source ('X is true')", async () => {
    const shortFile = join(tmpDir, "short.md");
    writeFileSync(shortFile, "X is true", "utf-8");

    const outcome = await acceptSource(shortFile);
    expect(isRejection(outcome)).toBe(false);

    // It should have been persisted to sources/
    const sources = readdirSync(join(tmpDir, "sources"));
    expect(sources.length).toBeGreaterThan(0);
  });

  it("accepts a valid file — does write to sources/", async () => {
    const validFile = join(tmpDir, "valid.md");
    writeFileSync(validFile, "# Hello\n\nThis is meaningful content for testing.", "utf-8");

    const outcome = await acceptSource(validFile);
    expect(isRejection(outcome)).toBe(false);

    const sources = readdirSync(join(tmpDir, "sources"));
    expect(sources.length).toBeGreaterThan(0);
  });
});
