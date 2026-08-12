/**
 * Integration test for the full ingest pipeline — task 10.
 *
 * Calls runIngest with ReplayClient against recorded fixtures and asserts:
 * - The contradiction callout appears in the PAGE FILE (not only the register)
 * - The register has the entry
 * - The page still satisfies isSubsequence against its pre-ingest content
 *
 * This is the test that would have caught PR #18, where formatContradictionCallout
 * was imported but never called.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, copyFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { ensureLayout } from "../src/layout.js";
import { ensureSchema, getDb, _resetDb } from "../src/schema.js";
import { syncPagesFromDisk, rebuildIndex } from "../src/pages.js";
import { isSubsequence } from "../src/verify.js";
import { runIngest } from "../src/ingest.js";
import { ReplayClient } from "../src/model/replay.js";

// ---------------------------------------------------------------------------
// Integration test — contradiction detection end-to-end
// ---------------------------------------------------------------------------

describe("ingest integration: contradiction reaches the page (task 10)", () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "elenchus-integration-"));
    originalCwd = process.cwd();
    process.chdir(tmpDir);
    ensureLayout();
    ensureSchema();

    // Seed all 4 demo pages (matching the state when fixtures were recorded)
    const pagesDir = resolve(tmpDir, "pages");
    const demoPagesDir = resolve(originalCwd, "demo-pages");
    for (const file of ["cooking-basics.md", "fermentation.md", "food-safety.md", "nutrition.md"]) {
      copyFileSync(resolve(demoPagesDir, file), resolve(pagesDir, file));
    }

    syncPagesFromDisk();
    rebuildIndex();

    // Create the seed-corpus source row (as npm run seed does)
    const db = getDb();
    const seedHash = createHash("sha256").update("seed-corpus").digest("hex");
    db.prepare(
      "INSERT OR IGNORE INTO sources (hash, filename, origin, byte_length) VALUES (?, ?, ?, ?)"
    ).run(seedHash, "seed-corpus", "seed-corpus", 0);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    _resetDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("callout appears in the page file after ingest, not only in the register", async () => {
    // Use the recorded fixtures — point at the project's fixtures/ directory
    const fixturesDir = resolve(originalCwd, "fixtures");
    const replayer = new ReplayClient(fixturesDir);

    // Copy the example file to the working directory (same relative path as real run)
    mkdirSync(resolve(tmpDir, "examples"), { recursive: true });
    copyFileSync(
      resolve(originalCwd, "examples", "food-safety-update.md"),
      resolve(tmpDir, "examples", "food-safety-update.md")
    );

    // Use the actual example file (same relative path that produced the fixtures)
    const sourceFile = "examples/food-safety-update.md";

    // Record the pre-ingest page content
    const preIngestContent = readFileSync(resolve(tmpDir, "pages", "food-safety.md"), "utf-8");

    const result = await runIngest(sourceFile, {}, replayer);

    // The page file must contain the callout
    const pageContent = readFileSync(resolve(tmpDir, "pages", "food-safety.md"), "utf-8");
    expect(pageContent).toContain("[!warning] Contradiction");
    expect(pageContent).toContain("open");

    // Both claims present in the callout
    expect(pageContent).toMatch(/4 °C/);
    expect(pageContent).toMatch(/5 °C/);

    // The register also has the entry
    const register = readFileSync(resolve(tmpDir, "contradictions.md"), "utf-8");
    expect(register).toContain("CD-");
    expect(register).toContain("open");

    // The original page content is preserved (isSubsequence)
    expect(isSubsequence(preIngestContent, pageContent)).toBe(true);

    // Contradictions detected
    expect(result.contradictions.length).toBeGreaterThan(0);
  });
});
