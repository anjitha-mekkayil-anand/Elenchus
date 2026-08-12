/**
 * Unit tests for section 2 (Extract) — tasks 2.1–2.3.
 *
 * Uses ReplayClient (test harness) — no real model calls.
 * Fixtures were generated via RecordingClient against the real API.
 */

import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { extractClaims } from "../src/extract.js";
import { ReplayClient } from "../src/model/replay.js";

// ---------------------------------------------------------------------------
// Fixtures directory — recorded from real API calls
// ---------------------------------------------------------------------------

const FIXTURES_DIR = resolve(__dirname, "fixtures", "extract");

// ---------------------------------------------------------------------------
// Task 2.3 — AC-7.3: non-checkable source produces zero claims
// ---------------------------------------------------------------------------

describe("extractClaims (task 2.3)", () => {
  it("a source asserting nothing checkable produces zero claims (AC-7.3)", async () => {
    const replayer = new ReplayClient(FIXTURES_DIR);

    // The same text used to record the fixture — all opinion, instruction, question
    const nonCheckableText = `# Tips for Learning

Learning new things is rewarding and worth the effort.

## Suggestions

- Try to stay curious about the world around you.
- Consider keeping a journal of what you find interesting.
- Ask questions whenever something is unclear.

Remember: the journey matters more than the destination.`;

    const claims = await extractClaims(
      nonCheckableText,
      "src/learning-tips",
      "2026-08-12",
      replayer
    );

    expect(claims).toEqual([]);
    expect(claims).toHaveLength(0);
  });

  it("a source with factual assertions produces claims (AC-7.1)", async () => {
    const replayer = new ReplayClient(FIXTURES_DIR);

    // The food-safety demo page used to record the fixture
    const sourceText = `# Food Safety

Preventing foodborne illness through proper handling, storage, and preparation.

## Temperature Danger Zone

Bacteria multiply rapidly between 4 °C and 60 °C. Perishable food should not remain in this range for more than two hours (one hour above 32 °C ambient).

## Cross-Contamination

Raw meat, poultry, and seafood must be stored below ready-to-eat foods. Separate cutting boards and utensils prevent transfer of pathogens like Salmonella and Campylobacter.
`;

    const claims = await extractClaims(
      sourceText,
      "src/food-safety-guide",
      "2026-08-10",
      replayer
    );

    // Should produce multiple claims — the exact count depends on the model
    // but it must be more than zero for factual content
    expect(claims.length).toBeGreaterThan(0);

    // Each claim must have a non-empty text field and an anchor
    for (const claim of claims) {
      expect(claim).toHaveProperty("text");
      expect(claim).toHaveProperty("anchor");
      expect(typeof claim.text).toBe("string");
      expect(claim.text.trim().length).toBeGreaterThan(0);
      expect(typeof claim.anchor).toBe("string");
      expect(claim.anchor.trim().length).toBeGreaterThan(0);
    }

    // Claims should be standalone — no pronouns like "it", "this range", "they"
    // as the opening word (a basic heuristic check)
    for (const claim of claims) {
      expect(claim.text).not.toMatch(/^(It |They |This |These |That )/);
    }

    // Anchors should be section headings from the source, not "full-page"
    const anchors = new Set(claims.map((c) => c.anchor));
    expect(anchors.has("Temperature Danger Zone") || anchors.has("Cross-Contamination")).toBe(true);
  });
});
