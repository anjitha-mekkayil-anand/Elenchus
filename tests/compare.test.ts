/**
 * Unit tests for section 4 (Compare) — tasks 4.6–4.8.
 *
 * Uses ReplayClient (test harness) — no real model calls.
 * Fixtures were generated via RecordingClient against the real API.
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
