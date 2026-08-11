/**
 * Unit tests for section 7 (Verify — the invariant) — tasks 7.1–7.3.
 *
 * 7.1: Deterministic subsequence check.
 * 7.2: Rejected edits recorded, ingest continues.
 * 7.3: Adversarial cases — truncate, reorder, "fix" typo, rewrite heading.
 *      All four MUST be rejected.
 *
 * No ModelClient used here — this is pure code.
 */

import { describe, it, expect } from "vitest";
import {
  isSubsequence,
  verifyEdit,
  verifyEdits,
  simulateEditApplication,
} from "../src/verify.js";
import type { Edit } from "../src/plan.js";

// ---------------------------------------------------------------------------
// 7.1 — isSubsequence
// ---------------------------------------------------------------------------

describe("isSubsequence (task 7.1)", () => {
  it("empty string is a subsequence of anything", () => {
    expect(isSubsequence("", "hello")).toBe(true);
    expect(isSubsequence("", "")).toBe(true);
  });

  it("identical strings are subsequences", () => {
    expect(isSubsequence("abc", "abc")).toBe(true);
  });

  it("detects a valid subsequence (non-contiguous)", () => {
    expect(isSubsequence("ace", "abcde")).toBe(true);
  });

  it("detects a valid subsequence (contiguous substring)", () => {
    expect(isSubsequence("bcd", "abcde")).toBe(true);
  });

  it("rejects when characters are missing", () => {
    expect(isSubsequence("axe", "abcde")).toBe(false);
  });

  it("rejects when order is wrong", () => {
    expect(isSubsequence("ba", "abc")).toBe(false);
  });

  it("handles multiline content", () => {
    const pre = "line one\nline two\nline three";
    const post = "line one\nnew stuff\nline two\nmore\nline three\nend";
    expect(isSubsequence(pre, post)).toBe(true);
  });

  it("rejects when a line is removed from multiline content", () => {
    const pre = "line one\nline two\nline three";
    const post = "line one\nline three"; // line two removed
    expect(isSubsequence(pre, post)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7.1 — verifyEdit
// ---------------------------------------------------------------------------

describe("verifyEdit (task 7.1)", () => {
  it("accepts an edit that only adds content", () => {
    const pre = "# Page\n\nExisting content.\n";
    const edit: Edit = { page: "test", anchor: "# Page", insertion: "New addition." };
    const post = "# Page\n\nExisting content.\n\nNew addition.\n";

    const result = verifyEdit(edit, pre, post);
    expect(result.status).toBe("accepted");
  });

  it("rejects an edit that removes content", () => {
    const pre = "# Page\n\nExisting content.\n\nMore content.\n";
    const edit: Edit = { page: "test", anchor: "# Page", insertion: "Replacement." };
    const post = "# Page\n\nReplacement.\n"; // original content gone

    const result = verifyEdit(edit, pre, post);
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.reason).toContain("Invariant violation");
      expect(result.reason).toContain("subsequence");
    }
  });

  it("accepts edits to new pages (no pre-existing content)", () => {
    const edit: Edit = { page: "new-page", anchor: "(new page)", insertion: "# New\n\nContent." };
    const post = "# New\n\nContent.";

    const result = verifyEdit(edit, null, post);
    expect(result.status).toBe("accepted");
  });
});

// ---------------------------------------------------------------------------
// 7.2 — rejected edits recorded, ingest continues
// ---------------------------------------------------------------------------

describe("verifyEdits: rejected edits recorded, ingest continues (task 7.2)", () => {
  it("continues past rejected edits and still accepts valid ones", () => {
    const pageContent = "# Page\n\nParagraph one.\n\nParagraph two.\n";

    const goodEdit: Edit = {
      page: "test",
      anchor: "# Page",
      insertion: "Added safely.",
    };
    const badEdit: Edit = {
      page: "test",
      anchor: "# Page",
      insertion: "This replaces everything.",
    };

    const result = verifyEdits(
      [goodEdit, badEdit],
      (_slug) => pageContent,
      (pre, edit) => {
        if (edit === goodEdit) {
          // Good edit: appends
          return pre + "\n\nAdded safely.";
        }
        // Bad edit: replaces
        return "# Page\n\nThis replaces everything.";
      }
    );

    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].edit).toBe(goodEdit);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].edit).toBe(badEdit);
    expect(result.rejected[0].reason).toContain("Invariant violation");
  });

  it("records all rejected edits without aborting", () => {
    const pageContent = "Original content that must be preserved.";

    const edits: Edit[] = [
      { page: "a", anchor: "heading", insertion: "bad1" },
      { page: "b", anchor: "heading", insertion: "bad2" },
      { page: "c", anchor: "heading", insertion: "bad3" },
    ];

    const result = verifyEdits(
      edits,
      (_slug) => pageContent,
      (_pre, _edit) => "Completely rewritten." // all edits destroy content
    );

    // All three should be rejected, none aborted the process
    expect(result.rejected).toHaveLength(3);
    expect(result.accepted).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 7.3 — Adversarial unit tests
// ---------------------------------------------------------------------------

describe("adversarial edits — all four MUST be rejected (task 7.3)", () => {
  const originalPage =
    "# Cooking Basics\n\n" +
    "Cooking is the art of preparing food.\n\n" +
    "## Techniques\n\n" +
    "Boiling involves submerging food in hot water.\n" +
    "Roasting uses dry heat in an oven.\n\n" +
    "## Tips\n\n" +
    "Season early for deeper flavour.\n" +
    "Let meat rest before cutting.\n";

  it("REJECTS an edit that truncates content", () => {
    // The edit claims to add, but the resulting page is shorter — content was cut
    const postEdit =
      "# Cooking Basics\n\n" +
      "Cooking is the art of preparing food.\n\n" +
      "## Techniques\n\n" +
      "Boiling involves submerging food in hot water.\n" +
      "New insertion about steaming.\n";
    // Missing: "Roasting uses dry heat in an oven." and the entire Tips section

    const edit: Edit = {
      page: "cooking",
      anchor: "## Techniques",
      insertion: "New insertion about steaming.",
    };

    const result = verifyEdit(edit, originalPage, postEdit);
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.reason).toContain("Invariant violation");
    }
  });

  it("REJECTS an edit that reorders content", () => {
    // The edit moves the Tips section before Techniques
    const postEdit =
      "# Cooking Basics\n\n" +
      "Cooking is the art of preparing food.\n\n" +
      "## Tips\n\n" +
      "Season early for deeper flavour.\n" +
      "Let meat rest before cutting.\n\n" +
      "## Techniques\n\n" +
      "Boiling involves submerging food in hot water.\n" +
      "Roasting uses dry heat in an oven.\n";

    const edit: Edit = {
      page: "cooking",
      anchor: "## Tips",
      insertion: "Reorganised sections.",
    };

    const result = verifyEdit(edit, originalPage, postEdit);
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.reason).toContain("Invariant violation");
    }
  });

  it("REJECTS an edit that 'fixes' a typo", () => {
    // "flavour" → "flavor" — looks helpful but violates the invariant
    const postEdit = originalPage.replace("flavour", "flavor") +
      "\nAdded a note about seasoning.\n";

    const edit: Edit = {
      page: "cooking",
      anchor: "## Tips",
      insertion: "Added a note about seasoning.",
    };

    const result = verifyEdit(edit, originalPage, postEdit);
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.reason).toContain("Invariant violation");
    }
  });

  it("REJECTS an edit that rewrites a heading", () => {
    // "## Techniques" → "## Cooking Methods" — original heading text is gone
    const postEdit = originalPage.replace("## Techniques", "## Cooking Methods") +
      "\nSteaming is another method.\n";

    const edit: Edit = {
      page: "cooking",
      anchor: "## Cooking Methods",
      insertion: "Steaming is another method.",
    };

    const result = verifyEdit(edit, originalPage, postEdit);
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.reason).toContain("Invariant violation");
    }
  });
});

// ---------------------------------------------------------------------------
// simulateEditApplication
// ---------------------------------------------------------------------------

describe("simulateEditApplication", () => {
  it("appends insertion after the anchor section", () => {
    const pre = "# Page\n\n## Section\n\nExisting.\n\n## Other\n\nMore.\n";
    const edit: Edit = { page: "p", anchor: "## Section", insertion: "Added." };

    const post = simulateEditApplication(pre, edit);
    expect(post).toContain("Existing.");
    expect(post).toContain("Added.");
    expect(post).toContain("## Other");
    // The original content must still be a subsequence
    expect(isSubsequence(pre, post)).toBe(true);
  });

  it("appends at end if anchor not found", () => {
    const pre = "# Page\n\nContent.\n";
    const edit: Edit = { page: "p", anchor: "## Missing", insertion: "Appended." };

    const post = simulateEditApplication(pre, edit);
    expect(post).toContain("Content.");
    expect(post).toContain("Appended.");
    expect(isSubsequence(pre, post)).toBe(true);
  });

  it("returns insertion content for new pages", () => {
    const edit: Edit = { page: "new", anchor: "(new page)", insertion: "# New\n\nContent." };
    const post = simulateEditApplication(null, edit);
    expect(post).toBe("# New\n\nContent.");
  });
});
