/**
 * Unit tests for section 4 (Retrieve) — tasks 4.1–4.3.
 *
 * Uses ReplayClient (test harness) — no real model calls.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureLayout } from "../src/layout.js";
import { ensureSchema, _resetDb } from "../src/schema.js";
import {
  extractPageMeta,
  upsertPage,
  listPages,
  syncPagesFromDisk,
  rebuildIndex,
  formatIndexForModel,
} from "../src/pages.js";
import { retrieve } from "../src/retrieve.js";
import { RecordingClient, hashRequest } from "../src/model/recording.js";
import { ReplayClient } from "../src/model/replay.js";
import type { ModelClient, ModelRequest, ModelResponse } from "../src/model/types.js";

// ---------------------------------------------------------------------------
// Task 4.1 — Page registry
// ---------------------------------------------------------------------------

describe("extractPageMeta (task 4.1)", () => {
  it("extracts title from first heading", () => {
    const { title } = extractPageMeta("# My Page\n\nSome content here.");
    expect(title).toBe("My Page");
  });

  it("extracts summary from first paragraph after title", () => {
    const { summary } = extractPageMeta("# My Page\n\nThis is the summary.\n\nMore content.");
    expect(summary).toBe("This is the summary.");
  });

  it("returns Untitled if no heading found", () => {
    const { title } = extractPageMeta("Just some text without a heading.");
    expect(title).toBe("Untitled");
  });

  it("returns empty summary if only a heading exists", () => {
    const { summary } = extractPageMeta("# Title Only");
    expect(summary).toBe("");
  });
});

describe("page registry CRUD (task 4.1)", () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "elenchus-pages-"));
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

  it("upsertPage inserts a new page", () => {
    upsertPage("test-page", "Test Page", "A test summary.");
    const pages = listPages();
    expect(pages).toHaveLength(1);
    expect(pages[0]).toEqual({
      slug: "test-page",
      title: "Test Page",
      summary: "A test summary.",
    });
  });

  it("upsertPage updates an existing page", () => {
    upsertPage("test-page", "Original Title", "Original summary.");
    upsertPage("test-page", "Updated Title", "Updated summary.");
    const pages = listPages();
    expect(pages).toHaveLength(1);
    expect(pages[0].title).toBe("Updated Title");
    expect(pages[0].summary).toBe("Updated summary.");
  });

  it("syncPagesFromDisk reads all .md files in pages/", () => {
    const pagesDir = join(tmpDir, "pages");
    writeFileSync(
      join(pagesDir, "alpha.md"),
      "# Alpha\n\nAlpha is the first letter.",
      "utf-8"
    );
    writeFileSync(
      join(pagesDir, "beta.md"),
      "# Beta\n\nBeta is the second letter.",
      "utf-8"
    );

    syncPagesFromDisk();
    const pages = listPages();
    expect(pages).toHaveLength(2);
    expect(pages[0].slug).toBe("alpha");
    expect(pages[1].slug).toBe("beta");
  });

  it("rebuildIndex writes index.md from registry", () => {
    upsertPage("alpha", "Alpha", "The first letter.");
    upsertPage("beta", "Beta", "The second letter.");
    rebuildIndex();

    const content = readFileSync(join(tmpDir, "index.md"), "utf-8");
    expect(content).toContain("**Alpha** — The first letter.");
    expect(content).toContain("**Beta** — The second letter.");
  });

  it("formatIndexForModel returns structured text", () => {
    upsertPage("alpha", "Alpha", "The first letter.");
    const index = formatIndexForModel();
    expect(index).toContain("[alpha] Alpha: The first letter.");
  });

  it("formatIndexForModel returns placeholder when no pages", () => {
    const index = formatIndexForModel();
    expect(index).toBe("(no pages exist yet)");
  });
});

// ---------------------------------------------------------------------------
// Tasks 4.2, 4.3 — Retrieve stage
// ---------------------------------------------------------------------------

/** A FakeClient that returns a canned response for fixture recording. */
class FakeModelClient implements ModelClient {
  constructor(private response: string) {}
  async complete(_req: ModelRequest): Promise<ModelResponse> {
    return { content: this.response, model: "fake-model" };
  }
}

describe("retrieve with candidates (task 4.2)", () => {
  let tmpDir: string;
  let fixturesDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "elenchus-retrieve-"));
    fixturesDir = join(tmpDir, "fixtures");
    mkdirSync(fixturesDir, { recursive: true });
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

  it("returns candidates with reasons from model response (AC-2.1, AC-2.3)", async () => {
    // Set up pages in registry
    upsertPage("cooking", "Cooking Basics", "Fundamental techniques for home cooking.");
    upsertPage("nutrition", "Nutrition", "Macro and micronutrient information.");

    // Record a fixture with a canned response
    const modelResponse = JSON.stringify([
      { slug: "cooking", reason: "The source discusses a new cooking technique." },
      { slug: "nutrition", reason: "The source mentions nutritional values of the ingredients." },
    ]);
    const fake = new FakeModelClient(modelResponse);
    const recorder = new RecordingClient(fake, fixturesDir);

    const sourceText = "Stir-frying at high heat preserves vitamins in vegetables while creating good flavour.";

    // Run retrieve through recorder to create the fixture
    const result1 = await retrieve(sourceText, recorder);

    // Now replay from fixture — no network
    const replayer = new ReplayClient(fixturesDir);
    const result2 = await retrieve(sourceText, replayer);

    expect(result2.candidates).toHaveLength(2);
    expect(result2.candidates[0].slug).toBe("cooking");
    expect(result2.candidates[0].reason).toContain("cooking technique");
    expect(result2.candidates[1].slug).toBe("nutrition");
    expect(result2.newTopic).toBe(false);
    expect(result2.rawResponse).toBe(modelResponse);
  });
});

describe("retrieve with no candidates — new topic (task 4.3)", () => {
  let tmpDir: string;
  let fixturesDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "elenchus-newtopic-"));
    fixturesDir = join(tmpDir, "fixtures");
    mkdirSync(fixturesDir, { recursive: true });
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

  it("returns newTopic=true when model returns empty array (AC-2.2)", async () => {
    // Pages exist but source is unrelated
    upsertPage("cooking", "Cooking Basics", "Fundamental techniques.");

    const modelResponse = "[]";
    const fake = new FakeModelClient(modelResponse);
    const recorder = new RecordingClient(fake, fixturesDir);

    const sourceText = "Quantum computing uses qubits that can exist in superposition.";

    // Record fixture
    await retrieve(sourceText, recorder);

    // Replay
    const replayer = new ReplayClient(fixturesDir);
    const result = await retrieve(sourceText, replayer);

    expect(result.candidates).toHaveLength(0);
    expect(result.newTopic).toBe(true);
  });

  it("handles new topic when no pages exist at all", async () => {
    // No pages in registry at all
    const modelResponse = "[]";
    const fake = new FakeModelClient(modelResponse);
    const recorder = new RecordingClient(fake, fixturesDir);

    const sourceText = "This is about something entirely new.";

    await retrieve(sourceText, recorder);

    const replayer = new ReplayClient(fixturesDir);
    const result = await retrieve(sourceText, replayer);

    expect(result.candidates).toHaveLength(0);
    expect(result.newTopic).toBe(true);
  });
});
