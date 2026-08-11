/**
 * Unit tests for section 6 (Plan) — tasks 6.1–6.3.
 *
 * Uses ReplayClient (test harness) — no real model calls.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureLayout } from "../src/layout.js";
import { ensureSchema, _resetDb } from "../src/schema.js";
import { upsertPage } from "../src/pages.js";
import { plan } from "../src/plan.js";
import type { Decision, WeaveDecision, CreateDecision } from "../src/decide.js";
import { RecordingClient } from "../src/model/recording.js";
import { ReplayClient } from "../src/model/replay.js";
import type { ModelClient, ModelRequest, ModelResponse } from "../src/model/types.js";

/** A FakeClient that returns a canned response for fixture recording. */
class FakeModelClient implements ModelClient {
  constructor(private response: string) {}
  async complete(_req: ModelRequest): Promise<ModelResponse> {
    return { content: this.response, model: "fake-model" };
  }
}

// ---------------------------------------------------------------------------
// Task 6.1 — emit edits as { page, anchor, insertion }
// ---------------------------------------------------------------------------

describe("plan: emit edits (task 6.1)", () => {
  let tmpDir: string;
  let fixturesDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "elenchus-plan-"));
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

  it("produces edits with page, anchor, and insertion for weave decisions", async () => {
    // Create a page on disk
    const pagesDir = join(tmpDir, "pages");
    writeFileSync(
      join(pagesDir, "cooking.md"),
      "# Cooking Basics\n\nFundamental techniques for home cooking.\n\n## Techniques\n\nBoiling and roasting are common.\n",
      "utf-8"
    );
    upsertPage("cooking", "Cooking Basics", "Fundamental techniques for home cooking.");

    const modelResponse = JSON.stringify([
      { anchor: "## Techniques", insertion: "Stir-frying at high heat preserves nutrients while creating flavour." },
    ]);

    const fake = new FakeModelClient(modelResponse);
    const recorder = new RecordingClient(fake, fixturesDir);

    const decisions: Decision[] = [
      { action: "weave", slug: "cooking", reason: "Adds a new technique." },
    ];

    await plan(decisions, "Stir-frying preserves nutrients.", "/tmp/source.md", recorder);

    const replayer = new ReplayClient(fixturesDir);
    const result = await plan(decisions, "Stir-frying preserves nutrients.", "/tmp/source.md", replayer);

    expect(result.edits).toHaveLength(1);
    expect(result.edits[0].page).toBe("cooking");
    expect(result.edits[0].anchor).toBe("## Techniques");
    expect(result.edits[0].insertion).toContain("Stir-frying at high heat");
  });

  it("produces no edits for skip decisions", async () => {
    const decisions: Decision[] = [
      { action: "skip", slug: "cooking", reason: "Not relevant." },
    ];

    // No model call needed for skip — use a throwing client
    const result = await plan(
      decisions,
      "Irrelevant text.",
      "/tmp/source.md",
      { complete: () => { throw new Error("Should not be called"); } } as unknown as ModelClient
    );

    expect(result.edits).toHaveLength(0);
  });

  it("produces a create edit for create decisions", async () => {
    const decisions: Decision[] = [
      {
        action: "create",
        suggestedSlug: "quantum-computing",
        suggestedTitle: "Quantum Computing",
        reason: "New topic.",
        rejectedCandidates: [],
      } as CreateDecision,
    ];

    const result = await plan(
      decisions,
      "Quantum entanglement enables correlation.",
      "/tmp/source.md",
      { complete: () => { throw new Error("Should not be called"); } } as unknown as ModelClient
    );

    expect(result.edits).toHaveLength(1);
    expect(result.edits[0].page).toBe("quantum-computing");
    expect(result.edits[0].anchor).toBe("(new page)");
    expect(result.edits[0].insertion).toContain("# Quantum Computing");
    expect(result.edits[0].insertion).toContain("Quantum entanglement enables correlation.");
  });

  it("handles multiple weave decisions (multi-page, AC-3.4)", async () => {
    const pagesDir = join(tmpDir, "pages");
    writeFileSync(
      join(pagesDir, "cooking.md"),
      "# Cooking Basics\n\nTechniques.\n\n## Methods\n\nBoiling.\n",
      "utf-8"
    );
    writeFileSync(
      join(pagesDir, "nutrition.md"),
      "# Nutrition\n\nMacro info.\n\n## Vitamins\n\nVitamin A is important.\n",
      "utf-8"
    );
    upsertPage("cooking", "Cooking Basics", "Techniques.");
    upsertPage("nutrition", "Nutrition", "Macro info.");

    // The model is called once per weave decision — need two separate responses.
    // Use separate fixture dirs per call to avoid hash collision.
    // Actually, since the requests differ (different page content), they'll have different hashes.
    const response1 = JSON.stringify([
      { anchor: "## Methods", insertion: "Steaming retains vitamins." },
    ]);
    const response2 = JSON.stringify([
      { anchor: "## Vitamins", insertion: "Vitamin C is preserved by steaming." },
    ]);

    // We need a client that returns different responses per call
    let callCount = 0;
    const responses = [response1, response2];
    const multiClient: ModelClient = {
      async complete(_req: ModelRequest): Promise<ModelResponse> {
        return { content: responses[callCount++], model: "fake-model" };
      },
    };
    const recorder = new RecordingClient(multiClient, fixturesDir);

    const decisions: Decision[] = [
      { action: "weave", slug: "cooking", reason: "New method." },
      { action: "weave", slug: "nutrition", reason: "Vitamin data." },
    ];

    const sourceText = "Steaming vegetables retains 90% of vitamin C.";
    await plan(decisions, sourceText, "/tmp/steam.md", recorder);

    const replayer = new ReplayClient(fixturesDir);
    const result = await plan(decisions, sourceText, "/tmp/steam.md", replayer);

    expect(result.edits).toHaveLength(2);
    expect(result.edits[0].page).toBe("cooking");
    expect(result.edits[1].page).toBe("nutrition");
  });
});

// ---------------------------------------------------------------------------
// Task 6.2 — full page content in weave prompt
// ---------------------------------------------------------------------------

describe("plan: full page content in prompt (task 6.2)", () => {
  let tmpDir: string;
  let fixturesDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "elenchus-plan-content-"));
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

  it("includes the full page content in the model request", async () => {
    const pageContent = "# Deep Page\n\nThis page has detailed content.\n\n## Section A\n\nParagraph one.\n\n## Section B\n\nParagraph two with specifics.\n";
    const pagesDir = join(tmpDir, "pages");
    writeFileSync(join(pagesDir, "deep-page.md"), pageContent, "utf-8");
    upsertPage("deep-page", "Deep Page", "This page has detailed content.");

    // Capture what the model receives
    let capturedRequest: ModelRequest | null = null;
    const capturingClient: ModelClient = {
      async complete(req: ModelRequest): Promise<ModelResponse> {
        capturedRequest = req;
        return { content: "[]", model: "fake-model" };
      },
    };

    const decisions: Decision[] = [
      { action: "weave", slug: "deep-page", reason: "Relevant." },
    ];

    await plan(decisions, "New info.", "/tmp/src.md", capturingClient);

    // Verify the FULL page content was sent
    expect(capturedRequest).not.toBeNull();
    const userMessage = capturedRequest!.messages[0].content;
    expect(userMessage).toContain("# Deep Page");
    expect(userMessage).toContain("This page has detailed content.");
    expect(userMessage).toContain("## Section A");
    expect(userMessage).toContain("Paragraph one.");
    expect(userMessage).toContain("## Section B");
    expect(userMessage).toContain("Paragraph two with specifics.");
  });
});

// ---------------------------------------------------------------------------
// Task 6.3 — citation attached to insertions (AC-4.3)
// ---------------------------------------------------------------------------

describe("plan: citation (task 6.3)", () => {
  let tmpDir: string;
  let fixturesDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "elenchus-plan-cite-"));
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

  it("attaches source citation to weave insertions (AC-4.3)", async () => {
    const pagesDir = join(tmpDir, "pages");
    writeFileSync(
      join(pagesDir, "cooking.md"),
      "# Cooking\n\nBasics.\n\n## Tips\n\nSeason early.\n",
      "utf-8"
    );
    upsertPage("cooking", "Cooking", "Basics.");

    const modelResponse = JSON.stringify([
      { anchor: "## Tips", insertion: "Rest meat before cutting." },
    ]);

    const fake = new FakeModelClient(modelResponse);
    const recorder = new RecordingClient(fake, fixturesDir);

    const decisions: Decision[] = [
      { action: "weave", slug: "cooking", reason: "New tip." },
    ];
    const sourceOrigin = "https://example.com/cooking-tips";

    await plan(decisions, "Rest meat before cutting.", sourceOrigin, recorder);

    const replayer = new ReplayClient(fixturesDir);
    const result = await plan(decisions, "Rest meat before cutting.", sourceOrigin, replayer);

    expect(result.edits).toHaveLength(1);
    expect(result.edits[0].insertion).toContain("Rest meat before cutting.");
    expect(result.edits[0].insertion).toContain("*(Source: https://example.com/cooking-tips");
    expect(result.edits[0].insertion).toContain("ingested");
  });

  it("attaches source citation to create insertions (AC-4.3)", async () => {
    const decisions: Decision[] = [
      {
        action: "create",
        suggestedSlug: "new-topic",
        suggestedTitle: "New Topic",
        reason: "New.",
        rejectedCandidates: [],
      } as CreateDecision,
    ];

    const result = await plan(
      decisions,
      "Brand new content.",
      "/home/user/notes.md",
      { complete: () => { throw new Error("Should not be called"); } } as unknown as ModelClient
    );

    expect(result.edits[0].insertion).toContain("*(Source: /home/user/notes.md");
    expect(result.edits[0].insertion).toContain("ingested");
  });

  it("citation includes the date", async () => {
    const decisions: Decision[] = [
      {
        action: "create",
        suggestedSlug: "dated",
        suggestedTitle: "Dated",
        reason: "Test.",
        rejectedCandidates: [],
      } as CreateDecision,
    ];

    const result = await plan(
      decisions,
      "Content.",
      "/src.md",
      { complete: () => { throw new Error("Should not be called"); } } as unknown as ModelClient
    );

    // Should contain today's date in ISO format (YYYY-MM-DD)
    const today = new Date().toISOString().slice(0, 10);
    expect(result.edits[0].insertion).toContain(today);
  });
});
