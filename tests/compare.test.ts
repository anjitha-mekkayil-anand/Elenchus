/**
 * Unit tests for section 4 (Compare) — tasks 4.6–4.8 + gate tests.
 *
 * Uses ReplayClient (test harness) for 4.6–4.8 — no real model calls.
 * Fixtures were generated via RecordingClient against the real API.
 *
 * Gate tests use a FakeModelClient with canned responses to verify
 * that enforcement logic (AC-8.7 falsifier, AC-8.5 change evidence,
 * AC-8.4 neither discard) works correctly regardless of model behaviour.
 *
 * Each test exercises one classification label:
 *   4.6 — refinement → "neither" (no conflicts, no rejected)
 *   4.7 — stated event → "supersession" with verifiable changeEvidence
 *   4.8 — genuine conflict → "contradiction" with falsifier
 */

import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { compareClaims } from "../src/compare.js";
import { ReplayClient } from "../src/model/replay.js";
import type { ModelClient, ModelRequest, ModelResponse } from "../src/model/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A FakeModelClient that returns a canned JSON string. No network. */
class FakeModelClient implements ModelClient {
  constructor(private readonly response: string) {}
  async complete(_req: ModelRequest): Promise<ModelResponse> {
    return { content: this.response, model: "fake-model" };
  }
}

// ---------------------------------------------------------------------------
// Fixtures directory — recorded from real API calls
// ---------------------------------------------------------------------------

const FIXTURES_DIR = resolve(__dirname, "fixtures", "compare");

// ---------------------------------------------------------------------------
// Task 4.6 — refinement returns neither (AC-8.4)
// ---------------------------------------------------------------------------

describe("compareClaims: refinement → neither (task 4.6)", () => {
  it("'roughly 50 poems' vs '53 poems' is precision, not conflict (NF-8)", async () => {
    const replayer = new ReplayClient(FIXTURES_DIR);

    const sourceClaims = [
      { text: "The collection contains 53 poems." },
    ];
    const storedClaims = [
      { id: 1, text: "The collection contains roughly 50 poems.", page: "poetry", source_date: "2026-07-01" },
    ];
    const sourceText = "After a complete count, the collection contains 53 poems spanning three decades of work.";

    const result = await compareClaims(sourceClaims, storedClaims, sourceText, replayer);

    // Neither: no conflicts stored, no rejected pairs.
    expect(result.conflicts).toHaveLength(0);
    expect(result.rejected).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Task 4.7 — stated event returns supersession (AC-8.3)
// ---------------------------------------------------------------------------

describe("compareClaims: stated event → supersession (task 4.7)", () => {
  it("exam rescheduled with explicit change evidence (AC-8.3, AC-8.5)", async () => {
    const replayer = new ReplayClient(FIXTURES_DIR);

    const sourceClaims = [
      { text: "The AI-103 exam is scheduled for 3 September 2026." },
    ];
    const storedClaims = [
      { id: 2, text: "The AI-103 exam is scheduled for 12 August 2026.", page: "exams", source_date: "2026-07-15" },
    ];
    const sourceText = "Due to a scheduling conflict, the AI-103 exam has been rescheduled from 12 August to 3 September 2026. Students should update their calendars accordingly.";

    const result = await compareClaims(sourceClaims, storedClaims, sourceText, replayer);

    // One supersession.
    expect(result.conflicts).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);

    const pair = result.conflicts[0];
    expect(pair.label).toBe("supersession");
    expect(pair.sourceClaim.text).toBe("The AI-103 exam is scheduled for 3 September 2026.");
    expect(pair.storedClaim.text).toBe("The AI-103 exam is scheduled for 12 August 2026.");

    // Falsifier is non-empty and meaningful (AC-8.7 gate passed).
    expect(pair.falsifier.length).toBeGreaterThan(0);

    // Change evidence is a verbatim substring of the source (AC-8.5 gate passed).
    expect(pair.changeEvidence).toBeDefined();
    expect(pair.changeEvidence!.length).toBeGreaterThan(0);
    expect(sourceText.includes(pair.changeEvidence!)).toBe(true);

    // Reasoning recorded (AC-8.8).
    expect(pair.reasoning.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Task 4.8 — genuine conflict returns contradiction (AC-8.2)
// ---------------------------------------------------------------------------

describe("compareClaims: genuine conflict → contradiction (task 4.8)", () => {
  it("conflicting access requirements with no stated change (AC-8.2, AC-8.6)", async () => {
    const replayer = new ReplayClient(FIXTURES_DIR);

    const sourceClaims = [
      { text: "Kiro Web is available on the Free plan without any subscription." },
    ];
    const storedClaims = [
      { id: 3, text: "Kiro Web requires a Pro subscription to access.", page: "kiro-docs", source_date: "2026-06-01" },
    ];
    const sourceText = "After signing up, Kiro Web is available on the Free plan without any subscription. All core features work out of the box.";

    const result = await compareClaims(sourceClaims, storedClaims, sourceText, replayer);

    // One contradiction.
    expect(result.conflicts).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);

    const pair = result.conflicts[0];
    expect(pair.label).toBe("contradiction");
    expect(pair.sourceClaim.text).toBe("Kiro Web is available on the Free plan without any subscription.");
    expect(pair.storedClaim.text).toBe("Kiro Web requires a Pro subscription to access.");

    // Falsifier is non-empty and meaningful (AC-8.7 gate passed).
    expect(pair.falsifier.length).toBeGreaterThan(0);

    // No change evidence (not a supersession).
    expect(pair.changeEvidence).toBeUndefined();

    // Reasoning recorded (AC-8.8).
    expect(pair.reasoning.length).toBeGreaterThan(0);
  });
});


// ---------------------------------------------------------------------------
// Gate tests — stubbed model responses, no network
// ---------------------------------------------------------------------------

describe("Gate 1: AC-8.7 — missing falsifier demotes to neither", () => {
  it("contradiction with empty falsifier is demoted and appears in rejected", async () => {
    // Stub: model returns a contradiction with an empty falsifier.
    const stubbedResponse = JSON.stringify([
      {
        sourceIndex: 0,
        storedIndex: 0,
        label: "contradiction",
        falsifier: "",
        reasoning: "They seem different.",
      },
    ]);
    const fake = new FakeModelClient(stubbedResponse);

    const sourceClaims = [{ text: "Water boils at 90 °C at altitude." }];
    const storedClaims = [
      { id: 10, text: "Water boils at 100 °C at sea level.", page: "physics", source_date: "2026-01-01" },
    ];
    const sourceText = "Water boils at 90 °C at altitude due to reduced air pressure.";

    const result = await compareClaims(sourceClaims, storedClaims, sourceText, fake);

    // Must NOT appear in conflicts.
    expect(result.conflicts).toHaveLength(0);

    // Must appear in rejected with correct demotion.
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].originalLabel).toBe("contradiction");
    expect(result.rejected[0].demotedTo).toBe("neither");
    expect(result.rejected[0].reason).toContain("AC-8.7");
  });
});

describe("Gate 2: AC-8.5 — unverifiable changeEvidence demotes to contradiction", () => {
  it("supersession with non-matching changeEvidence is demoted to contradiction", async () => {
    // Stub: model returns a supersession whose changeEvidence is plausible
    // but does NOT appear verbatim in sourceText.
    const stubbedResponse = JSON.stringify([
      {
        sourceIndex: 0,
        storedIndex: 0,
        label: "supersession",
        falsifier: "The meeting cannot be on both Tuesday and Thursday.",
        reasoning: "The meeting was moved.",
        changeEvidence: "The weekly sync has been moved from Tuesday to Thursday.",
      },
    ]);
    const fake = new FakeModelClient(stubbedResponse);

    const sourceClaims = [{ text: "The weekly sync is held on Thursday." }];
    const storedClaims = [
      { id: 20, text: "The weekly sync is held on Tuesday.", page: "schedule", source_date: "2026-03-01" },
    ];
    // Note: sourceText does NOT contain the changeEvidence string.
    const sourceText = "Starting next week, the weekly sync is held on Thursday. Please update your calendars.";

    const result = await compareClaims(sourceClaims, storedClaims, sourceText, fake);

    // Still a real conflict — appears in conflicts as contradiction (not dropped).
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].label).toBe("contradiction");

    // Also appears in rejected documenting the demotion.
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].originalLabel).toBe("supersession");
    expect(result.rejected[0].demotedTo).toBe("contradiction");
    expect(result.rejected[0].reason).toContain("AC-8.5");
  });
});

describe("Gate 2: AC-8.5 — verbatim changeEvidence passes (pair stays supersession)", () => {
  it("supersession with matching changeEvidence survives as supersession", async () => {
    const sourceText = "The deadline has been extended from 15 August to 30 August 2026. All submissions after the new date will be rejected.";

    // Stub: model returns a supersession whose changeEvidence IS in sourceText.
    const stubbedResponse = JSON.stringify([
      {
        sourceIndex: 0,
        storedIndex: 0,
        label: "supersession",
        falsifier: "The deadline cannot be both 15 August and 30 August simultaneously.",
        reasoning: "The source explicitly states an extension of the deadline.",
        changeEvidence: "The deadline has been extended from 15 August to 30 August 2026.",
      },
    ]);
    const fake = new FakeModelClient(stubbedResponse);

    const sourceClaims = [{ text: "The submission deadline is 30 August 2026." }];
    const storedClaims = [
      { id: 30, text: "The submission deadline is 15 August 2026.", page: "deadlines", source_date: "2026-06-01" },
    ];

    const result = await compareClaims(sourceClaims, storedClaims, sourceText, fake);

    // Stays as supersession — not demoted.
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].label).toBe("supersession");
    expect(result.conflicts[0].changeEvidence).toBe(
      "The deadline has been extended from 15 August to 30 August 2026."
    );

    // Not in rejected.
    expect(result.rejected).toHaveLength(0);
  });
});

describe("AC-8.4: neither pairs are discarded, not stored", () => {
  it("an explicit neither pair is absent from both conflicts and rejected", async () => {
    // Stub: model returns a pair explicitly labelled "neither".
    const stubbedResponse = JSON.stringify([
      {
        sourceIndex: 0,
        storedIndex: 0,
        label: "neither",
        falsifier: "",
        reasoning: "These are the same fact at different precision levels.",
      },
    ]);
    const fake = new FakeModelClient(stubbedResponse);

    const sourceClaims = [{ text: "The tower is 324 metres tall." }];
    const storedClaims = [
      { id: 40, text: "The tower is approximately 320 metres tall.", page: "landmarks", source_date: "2026-02-01" },
    ];
    const sourceText = "The tower is 324 metres tall, including the antenna installed in 2022.";

    const result = await compareClaims(sourceClaims, storedClaims, sourceText, fake);

    // Neither: must not appear in conflicts.
    expect(result.conflicts).toHaveLength(0);

    // Neither: must not appear in rejected (it is not a gate failure, it is correct classification).
    expect(result.rejected).toHaveLength(0);
  });
});
