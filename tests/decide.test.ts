/**
 * Unit tests for section 5 (Decide) — tasks 5.1–5.4.
 *
 * Uses ReplayClient (test harness) — no real model calls.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureLayout } from "../src/layout.js";
import { ensureSchema, _resetDb } from "../src/schema.js";
import { upsertPage } from "../src/pages.js";
import { decide } from "../src/decide.js";
import type { Candidate } from "../src/retrieve.js";
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
// Task 5.1 — weave or skip per candidate
// ---------------------------------------------------------------------------

describe("decide: weave/skip per candidate (task 5.1)", () => {
  let tmpDir: string;
  let fixturesDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "elenchus-decide-"));
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

  it("returns weave decision with reasoning (AC-3.1)", async () => {
    upsertPage("cooking", "Cooking Basics", "Fundamental techniques.");

    const candidates: Candidate[] = [
      { slug: "cooking", reason: "Discusses a new technique." },
    ];

    const modelResponse = JSON.stringify({
      decisions: [
        { slug: "cooking", action: "weave", reason: "The source adds a stir-fry method to existing techniques." },
      ],
      create: null,
    });

    const fake = new FakeModelClient(modelResponse);
    const recorder = new RecordingClient(fake, fixturesDir);
    const sourceText = "Stir-frying preserves nutrients.";

    await decide(sourceText, candidates, recorder);

    const replayer = new ReplayClient(fixturesDir);
    const result = await decide(sourceText, candidates, replayer);

    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0].action).toBe("weave");
    if (result.decisions[0].action === "weave") {
      expect(result.decisions[0].slug).toBe("cooking");
      expect(result.decisions[0].reason).toContain("stir-fry");
    }
  });

  it("returns skip decision with reasoning (AC-3.1)", async () => {
    upsertPage("cooking", "Cooking Basics", "Fundamental techniques.");
    upsertPage("nutrition", "Nutrition", "Macro and micronutrient info.");

    const candidates: Candidate[] = [
      { slug: "cooking", reason: "Possibly relevant." },
      { slug: "nutrition", reason: "Mentions nutrients." },
    ];

    const modelResponse = JSON.stringify({
      decisions: [
        { slug: "cooking", action: "skip", reason: "The source is about chemistry, not cooking." },
        { slug: "nutrition", action: "weave", reason: "The source adds new vitamin data." },
      ],
      create: null,
    });

    const fake = new FakeModelClient(modelResponse);
    const recorder = new RecordingClient(fake, fixturesDir);
    const sourceText = "Vitamin C degrades at temperatures above 70°C.";

    await decide(sourceText, candidates, recorder);

    const replayer = new ReplayClient(fixturesDir);
    const result = await decide(sourceText, candidates, replayer);

    expect(result.decisions).toHaveLength(2);

    const skipDecision = result.decisions.find((d) => d.action === "skip");
    const weaveDecision = result.decisions.find((d) => d.action === "weave");

    expect(skipDecision).toBeDefined();
    expect(skipDecision!.action).toBe("skip");
    if (skipDecision!.action === "skip") {
      expect(skipDecision!.slug).toBe("cooking");
    }

    expect(weaveDecision).toBeDefined();
    expect(weaveDecision!.action).toBe("weave");
    if (weaveDecision!.action === "weave") {
      expect(weaveDecision!.slug).toBe("nutrition");
    }
  });
});

// ---------------------------------------------------------------------------
// Task 5.2, 5.3 — create new page + record rejected candidates
// ---------------------------------------------------------------------------

describe("decide: create new page (tasks 5.2, 5.3)", () => {
  let tmpDir: string;
  let fixturesDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "elenchus-decide-create-"));
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

  it("creates a new page when all candidates are skipped (AC-3.2)", async () => {
    upsertPage("cooking", "Cooking Basics", "Fundamental techniques.");

    const candidates: Candidate[] = [
      { slug: "cooking", reason: "Possibly relevant." },
    ];

    const modelResponse = JSON.stringify({
      decisions: [
        { slug: "cooking", action: "skip", reason: "Source is about quantum physics, not cooking." },
      ],
      create: { slug: "quantum-computing", title: "Quantum Computing", reason: "Entirely new topic not covered by any existing page." },
    });

    const fake = new FakeModelClient(modelResponse);
    const recorder = new RecordingClient(fake, fixturesDir);
    const sourceText = "Quantum entanglement enables instantaneous state correlation.";

    await decide(sourceText, candidates, recorder);

    const replayer = new ReplayClient(fixturesDir);
    const result = await decide(sourceText, candidates, replayer);

    const createDecision = result.decisions.find((d) => d.action === "create");
    expect(createDecision).toBeDefined();
    if (createDecision?.action === "create") {
      expect(createDecision.suggestedSlug).toBe("quantum-computing");
      expect(createDecision.suggestedSlug.length).toBeGreaterThan(0);
      expect(createDecision.suggestedTitle).toBe("Quantum Computing");
      expect(createDecision.suggestedTitle.length).toBeGreaterThan(0);
      expect(createDecision.reason).toContain("new topic");
    }
  });

  it("records rejected candidates on create (AC-3.3)", async () => {
    upsertPage("cooking", "Cooking Basics", "Fundamental techniques.");
    upsertPage("nutrition", "Nutrition", "Macro info.");

    const candidates: Candidate[] = [
      { slug: "cooking", reason: "Possibly relevant." },
      { slug: "nutrition", reason: "Mentions food." },
    ];

    const modelResponse = JSON.stringify({
      decisions: [
        { slug: "cooking", action: "skip", reason: "Not about cooking at all." },
        { slug: "nutrition", action: "skip", reason: "Not about nutrition either." },
      ],
      create: { slug: "astronomy", title: "Astronomy", reason: "New topic about stars." },
    });

    const fake = new FakeModelClient(modelResponse);
    const recorder = new RecordingClient(fake, fixturesDir);
    const sourceText = "The Andromeda galaxy is 2.5 million light-years away.";

    await decide(sourceText, candidates, recorder);

    const replayer = new ReplayClient(fixturesDir);
    const result = await decide(sourceText, candidates, replayer);

    const createDecision = result.decisions.find((d) => d.action === "create");
    expect(createDecision?.action).toBe("create");
    if (createDecision?.action === "create") {
      expect(createDecision.suggestedSlug).toBe("astronomy");
      expect(createDecision.suggestedSlug.length).toBeGreaterThan(0);
      expect(createDecision.suggestedTitle).toBe("Astronomy");
      expect(createDecision.suggestedTitle.length).toBeGreaterThan(0);
      expect(createDecision.rejectedCandidates).toHaveLength(2);
      expect(createDecision.rejectedCandidates[0].slug).toBe("cooking");
      expect(createDecision.rejectedCandidates[0].reason).toContain("Not about cooking");
      expect(createDecision.rejectedCandidates[1].slug).toBe("nutrition");
    }
  });

  it("takes new-topic path with model call when no candidates — returns non-empty slug and title (AC-3.2)", async () => {
    const modelResponse = JSON.stringify({
      slug: "quantum-computing",
      title: "Quantum Computing",
      reason: "Entirely new topic about quantum mechanics and computation.",
    });

    const fake = new FakeModelClient(modelResponse);
    const recorder = new RecordingClient(fake, fixturesDir);
    const sourceText = "Quantum entanglement is a phenomenon where particles become correlated.";

    // Record
    await decide(sourceText, [], recorder);

    // Replay
    const replayer = new ReplayClient(fixturesDir);
    const result = await decide(sourceText, [], replayer);

    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0].action).toBe("create");
    if (result.decisions[0].action === "create") {
      expect(result.decisions[0].suggestedSlug).toBe("quantum-computing");
      expect(result.decisions[0].suggestedSlug.length).toBeGreaterThan(0);
      expect(result.decisions[0].suggestedTitle).toBe("Quantum Computing");
      expect(result.decisions[0].suggestedTitle.length).toBeGreaterThan(0);
      expect(result.decisions[0].reason).toContain("quantum");
      expect(result.decisions[0].rejectedCandidates).toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Task 5.4 — multi-page weave
// ---------------------------------------------------------------------------

describe("decide: multi-page weave (task 5.4)", () => {
  let tmpDir: string;
  let fixturesDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "elenchus-decide-multi-"));
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

  it("allows weaving into multiple pages in one run (AC-3.4)", async () => {
    upsertPage("cooking", "Cooking Basics", "Fundamental techniques.");
    upsertPage("nutrition", "Nutrition", "Macro and micronutrient info.");
    upsertPage("health", "Health", "General wellness information.");

    const candidates: Candidate[] = [
      { slug: "cooking", reason: "New technique." },
      { slug: "nutrition", reason: "Nutrient data." },
      { slug: "health", reason: "Health benefit." },
    ];

    const modelResponse = JSON.stringify({
      decisions: [
        { slug: "cooking", action: "weave", reason: "Adds a steaming technique." },
        { slug: "nutrition", action: "weave", reason: "Adds vitamin retention data." },
        { slug: "health", action: "skip", reason: "Too tangential to general wellness." },
      ],
      create: null,
    });

    const fake = new FakeModelClient(modelResponse);
    const recorder = new RecordingClient(fake, fixturesDir);
    const sourceText = "Steaming vegetables retains 90% of vitamin C compared to 60% when boiling.";

    await decide(sourceText, candidates, recorder);

    const replayer = new ReplayClient(fixturesDir);
    const result = await decide(sourceText, candidates, replayer);

    const weaves = result.decisions.filter((d) => d.action === "weave");
    const skips = result.decisions.filter((d) => d.action === "skip");

    // AC-3.4: multiple weaves in one run
    expect(weaves).toHaveLength(2);
    expect(weaves[0].action === "weave" && weaves[0].slug).toBe("cooking");
    expect(weaves[1].action === "weave" && weaves[1].slug).toBe("nutrition");
    expect(skips).toHaveLength(1);
  });
});
