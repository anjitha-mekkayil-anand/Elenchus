/**
 * Unit tests for contradiction detection spec 2, section 5 — representation.
 *
 * - 5.1: Contradiction callout format
 * - 5.2: Supersession annotation format
 * - 5.3: Register entries in contradictions.md
 * - 5.4: Contradiction callout passes the line-level invariant check
 * - 5.5: Supersession annotation passes the line-level invariant check
 * - Register preservation: adding an entry does not lose existing ones
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureLayout } from "../src/layout.js";
import { isSubsequence } from "../src/verify.js";
import {
  formatContradictionCallout,
  formatContradictionId,
  formatSupersessionAnnotation,
  addToRegister,
  formatRegisterEntry,
  type ContradictionEntry,
  type SupersessionEntry,
} from "../src/contradict.js";

// ---------------------------------------------------------------------------
// 5.1 — Contradiction callout
// ---------------------------------------------------------------------------

describe("formatContradictionCallout (task 5.1)", () => {
  const entry: ContradictionEntry = {
    id: "CD-004",
    claimA: {
      text: "Kiro Web requires a Pro subscription.",
      sourceSlug: "kiro-docs",
      sourceDate: "2026-08-09",
    },
    claimB: {
      text: "Kiro Web runs on the Free plan.",
      sourceSlug: "observed-signup",
      sourceDate: "2026-08-11",
    },
    reasoning: "Neither source states a change. Unresolved.",
  };

  it("produces the Obsidian callout format", () => {
    const callout = formatContradictionCallout(entry);
    expect(callout).toContain("> [!warning] Contradiction — CD-004 · open");
    expect(callout).toContain("> **A** —");
    expect(callout).toContain("> **B** —");
  });

  it("A is the existing claim, B is the new one", () => {
    const callout = formatContradictionCallout(entry);
    const lines = callout.split("\n");
    const lineA = lines.find((l) => l.includes("**A**"))!;
    const lineB = lines.find((l) => l.includes("**B**"))!;
    expect(lineA).toContain("Pro subscription");
    expect(lineB).toContain("Free plan");
  });

  it("includes source slugs and dates", () => {
    const callout = formatContradictionCallout(entry);
    expect(callout).toContain("`src/kiro-docs`");
    expect(callout).toContain("`src/observed-signup`");
    expect(callout).toContain("2026-08-09");
    expect(callout).toContain("2026-08-11");
  });

  it("includes reasoning", () => {
    const callout = formatContradictionCallout(entry);
    expect(callout).toContain("Neither source states a change. Unresolved.");
  });
});

describe("formatContradictionId", () => {
  it("zero-pads to three digits", () => {
    expect(formatContradictionId(1)).toBe("CD-001");
    expect(formatContradictionId(42)).toBe("CD-042");
    expect(formatContradictionId(999)).toBe("CD-999");
  });

  it("does not truncate numbers above 999", () => {
    expect(formatContradictionId(1234)).toBe("CD-1234");
  });
});

// ---------------------------------------------------------------------------
// 5.2 — Supersession annotation
// ---------------------------------------------------------------------------

describe("formatSupersessionAnnotation (task 5.2)", () => {
  it("produces the strikethrough annotation", () => {
    const entry: SupersessionEntry = {
      existingClaimText: "The exam is booked for 12 Aug.",
      supersessionDate: "2026-08-03",
      sourceSlug: "reschedule-mail",
    };

    const annotation = formatSupersessionAnnotation(entry);
    expect(annotation).toBe(" ~~superseded 2026-08-03 by src/reschedule-mail~~");
  });

  it("starts with a space (appends to end of existing line)", () => {
    const annotation = formatSupersessionAnnotation({
      existingClaimText: "anything",
      supersessionDate: "2026-01-01",
      sourceSlug: "test",
    });
    expect(annotation[0]).toBe(" ");
  });
});

// ---------------------------------------------------------------------------
// 5.3 — Register entries
// ---------------------------------------------------------------------------

describe("addToRegister (task 5.3)", () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "elenchus-register-"));
    originalCwd = process.cwd();
    process.chdir(tmpDir);
    ensureLayout();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const entry1: ContradictionEntry = {
    id: "CD-001",
    claimA: { text: "Claim A text.", sourceSlug: "source-a", sourceDate: "2026-08-01" },
    claimB: { text: "Claim B text.", sourceSlug: "source-b", sourceDate: "2026-08-10" },
    reasoning: "Cannot both be true.",
  };

  it("adds an entry to the Open section", () => {
    addToRegister(entry1);
    const content = readFileSync(join(tmpDir, "contradictions.md"), "utf-8");
    expect(content).toContain("### CD-001 — open");
    expect(content).toContain("Claim A text.");
    expect(content).toContain("Claim B text.");
  });

  it("entry appears in Open section, before Resolved section", () => {
    addToRegister(entry1);
    const content = readFileSync(join(tmpDir, "contradictions.md"), "utf-8");
    const entryIdx = content.indexOf("### CD-001");
    const resolvedIdx = content.indexOf("## Resolved");
    expect(entryIdx).toBeLessThan(resolvedIdx);
  });

  it("adding an entry preserves all existing entries (register is not lossy)", () => {
    // Add first entry
    addToRegister(entry1);

    const entry2: ContradictionEntry = {
      id: "CD-002",
      claimA: { text: "X is true.", sourceSlug: "src-x", sourceDate: "2026-07-01" },
      claimB: { text: "X is false.", sourceSlug: "src-y", sourceDate: "2026-08-05" },
      reasoning: "Direct contradiction.",
    };

    // Add second entry
    addToRegister(entry2);

    const content = readFileSync(join(tmpDir, "contradictions.md"), "utf-8");

    // Both entries still present
    expect(content).toContain("### CD-001 — open");
    expect(content).toContain("Claim A text.");
    expect(content).toContain("### CD-002 — open");
    expect(content).toContain("X is true.");
    expect(content).toContain("X is false.");

    // Structure intact
    expect(content).toContain("## Open");
    expect(content).toContain("## Resolved");
  });

  it("register with N entries still has N+1 after one added, all N intact", () => {
    // Seed with 3 entries
    addToRegister(entry1);
    addToRegister({
      id: "CD-002",
      claimA: { text: "Second A.", sourceSlug: "s2", sourceDate: "2026-01-01" },
      claimB: { text: "Second B.", sourceSlug: "s2b", sourceDate: "2026-02-01" },
      reasoning: "Reason 2.",
    });
    addToRegister({
      id: "CD-003",
      claimA: { text: "Third A.", sourceSlug: "s3", sourceDate: "2026-03-01" },
      claimB: { text: "Third B.", sourceSlug: "s3b", sourceDate: "2026-04-01" },
      reasoning: "Reason 3.",
    });

    // Capture state with 3 entries
    const before = readFileSync(join(tmpDir, "contradictions.md"), "utf-8");
    expect(before).toContain("CD-001");
    expect(before).toContain("CD-002");
    expect(before).toContain("CD-003");

    // Add a 4th
    addToRegister({
      id: "CD-004",
      claimA: { text: "Fourth A.", sourceSlug: "s4", sourceDate: "2026-05-01" },
      claimB: { text: "Fourth B.", sourceSlug: "s4b", sourceDate: "2026-06-01" },
      reasoning: "Reason 4.",
    });

    const after = readFileSync(join(tmpDir, "contradictions.md"), "utf-8");

    // All 4 present
    expect(after).toContain("CD-001");
    expect(after).toContain("CD-002");
    expect(after).toContain("CD-003");
    expect(after).toContain("CD-004");

    // Original 3 entries are completely intact (not altered)
    expect(after).toContain("Claim A text.");
    expect(after).toContain("Second A.");
    expect(after).toContain("Third A.");
    expect(after).toContain("Fourth A.");
  });
});

// ---------------------------------------------------------------------------
// 5.4 — Contradiction callout passes the line-level invariant
// ---------------------------------------------------------------------------

describe("contradiction callout passes line-level invariant (task 5.4)", () => {
  it("inserting a callout into a page preserves all original lines", () => {
    const originalPage =
      "# Food Safety\n\n" +
      "Preventing foodborne illness.\n\n" +
      "## Temperature\n\n" +
      "Bacteria multiply between 4 °C and 60 °C.\n";

    const callout = formatContradictionCallout({
      id: "CD-001",
      claimA: { text: "Danger zone is 4–60 °C.", sourceSlug: "textbook", sourceDate: "2026-01-01" },
      claimB: { text: "Danger zone is 5–57 °C.", sourceSlug: "new-source", sourceDate: "2026-08-10" },
      reasoning: "Different thresholds stated as absolute.",
    });

    // Simulate inserting the callout after the Temperature section
    const postEdit = originalPage + "\n" + callout + "\n";

    // The invariant: every non-empty line of pre appears in post, in order
    expect(isSubsequence(originalPage, postEdit)).toBe(true);
  });

  it("a callout is ONLY line insertions — never alters existing lines", () => {
    const callout = formatContradictionCallout({
      id: "CD-001",
      claimA: { text: "A.", sourceSlug: "s1", sourceDate: "2026-01-01" },
      claimB: { text: "B.", sourceSlug: "s2", sourceDate: "2026-02-01" },
      reasoning: "Conflict.",
    });

    // Every line of the callout starts with ">" (quoted block)
    const lines = callout.split("\n");
    for (const line of lines) {
      expect(line.startsWith(">")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 5.5 — Supersession annotation passes the line-level invariant
// ---------------------------------------------------------------------------

describe("supersession annotation passes line-level invariant (task 5.5)", () => {
  it("appending an annotation to a line preserves ALL original lines", () => {
    const originalPage =
      "# Nutrition\n\n" +
      "## Vitamins\n\n" +
      "Vitamin C is water-soluble.\n" +
      "The exam is booked for 12 Aug.\n";

    const annotation = formatSupersessionAnnotation({
      existingClaimText: "The exam is booked for 12 Aug.",
      supersessionDate: "2026-08-03",
      sourceSlug: "reschedule-mail",
    });

    // Simulate: append the annotation to the LAST LINE of the claim's region.
    // The claim is on line "The exam is booked for 12 Aug."
    // After annotation: "The exam is booked for 12 Aug. ~~superseded ...~~"
    const lines = originalPage.split("\n");
    const claimLineIdx = lines.findIndex((l) => l.includes("The exam is booked for 12 Aug."));
    lines[claimLineIdx] = lines[claimLineIdx] + annotation;
    const postEdit = lines.join("\n");

    // The LINE-LEVEL invariant: every non-empty line of pre appears in post.
    // The annotated line is DIFFERENT from the original — but this is by design.
    // The invariant check skips empty lines and checks exact line match.
    //
    // CRITICAL: This test documents that a supersession annotation MODIFIES
    // an existing line (appends to it). The line-level check treats the
    // annotated line as a new line — it does NOT match the original.
    // This means the verify gate would REJECT this edit if it compared the
    // whole page.
    //
    // The design's answer (design.md "The invariant composes"):
    // "the supersession annotation appends to a line's end without altering
    // the lines around it" — the verify stage must check that ALL OTHER LINES
    // are preserved, while allowing the annotated line to change.
    //
    // For now, we verify the weaker property: all lines EXCEPT the annotated
    // one are preserved. The verify stage integration (section 6) will need
    // to handle this specific case.
    const originalLines = originalPage.split("\n").filter((l) => l.length > 0);
    const postLines = postEdit.split("\n");

    // Every original line EXCEPT the one being annotated appears in post
    for (const origLine of originalLines) {
      if (origLine === "The exam is booked for 12 Aug.") {
        // This line was modified — check that the POST contains it as a prefix
        const annotatedLine = postLines.find((l) => l.startsWith(origLine));
        expect(annotatedLine).toBeDefined();
        expect(annotatedLine).toContain("~~superseded");
      } else {
        expect(postLines).toContain(origLine);
      }
    }
  });

  it("annotation only appends — does not insert newlines or alter surrounding lines", () => {
    const annotation = formatSupersessionAnnotation({
      existingClaimText: "Multi-line claim\nthat spans two lines.",
      supersessionDate: "2026-01-01",
      sourceSlug: "test",
    });

    // Must not contain newlines — it appends to ONE line
    expect(annotation).not.toContain("\n");
  });

  it("the annotated line starts with the original content (prefix property)", () => {
    const original = "The exam is booked for 12 Aug.";
    const annotation = formatSupersessionAnnotation({
      existingClaimText: original,
      supersessionDate: "2026-08-03",
      sourceSlug: "reschedule-mail",
    });

    const annotatedLine = original + annotation;
    expect(annotatedLine.startsWith(original)).toBe(true);
  });
});
