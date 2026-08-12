/**
 * Unit tests for section 6 (Pipeline Wiring) — tasks 6.7 and 6.9.
 *
 * 6.7: Ingest record states explicitly when claims were compared and none conflicted.
 * 6.9: The real apply path for a supersession annotation preserves isSubsequence.
 *
 * These tests use the production verify/apply logic — not hand-built content.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ensureLayout } from "../src/layout.js";
import { ensureSchema, _resetDb } from "../src/schema.js";
import { writeIngestRecord } from "../src/record.js";
import { isSubsequence, simulateEditApplication, verifyEdit } from "../src/verify.js";
import { formatSupersessionAnnotation } from "../src/contradict.js";
import type { Edit } from "../src/plan.js";

// ---------------------------------------------------------------------------
// Task 6.7 — Record states "compared, none conflicted"
// ---------------------------------------------------------------------------

describe("ingest record: comparison reporting (task 6.7)", () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "elenchus-record67-"));
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

  it("states 'Claims were compared and none conflicted' when no conflicts found (AC-11.2)", () => {
    const recordPath = writeIngestRecord({
      sourceOrigin: "/test/source.txt",
      sourceFilename: "abc-source.txt",
      candidates: [{ slug: "food-safety", reason: "Relevant." }],
      droppedCandidates: [],
      newTopic: false,
      decisions: [{ action: "weave", slug: "food-safety", reason: "Material fits." }],
      pagesChanged: [{ slug: "food-safety" }],
      rejectedEdits: [],
      detectedPairs: [],
      comparisonPerformed: true,
      rejectedPairs: [],
    });

    const content = readFileSync(recordPath, "utf-8");
    expect(content).toContain("Claims were compared and none conflicted.");
  });

  it("reports detected conflicts with classification and reasoning (AC-11.1)", () => {
    const recordPath = writeIngestRecord({
      sourceOrigin: "/test/source.txt",
      sourceFilename: "abc-source.txt",
      candidates: [{ slug: "kiro-docs", reason: "Relevant." }],
      droppedCandidates: [],
      newTopic: false,
      decisions: [{ action: "weave", slug: "kiro-docs", reason: "Material fits." }],
      pagesChanged: [{ slug: "kiro-docs" }],
      rejectedEdits: [],
      detectedPairs: [
        {
          sourceClaimText: "Kiro Web is available on the Free plan.",
          storedClaimText: "Kiro Web requires a Pro subscription.",
          label: "contradiction",
          reasoning: "Incompatible access requirements.",
          falsifier: "Cannot be both free and paid.",
        },
      ],
      comparisonPerformed: true,
      rejectedPairs: [],
    });

    const content = readFileSync(recordPath, "utf-8");
    expect(content).toContain("Detected **1** conflict(s)");
    expect(content).toContain("Contradiction");
    expect(content).toContain("Kiro Web is available on the Free plan.");
    expect(content).toContain("Kiro Web requires a Pro subscription.");
    expect(content).toContain("Incompatible access requirements.");
    expect(content).toContain("Cannot be both free and paid.");
  });

  it("reports 'No comparison performed' when no target pages exist", () => {
    const recordPath = writeIngestRecord({
      sourceOrigin: "/test/source.txt",
      sourceFilename: "abc-source.txt",
      candidates: [],
      droppedCandidates: [],
      newTopic: true,
      decisions: [{ action: "create", suggestedSlug: "new-topic", suggestedTitle: "New", reason: "New topic.", rejectedCandidates: [] }],
      pagesChanged: [{ slug: "new-topic" }],
      rejectedEdits: [],
      detectedPairs: [],
      comparisonPerformed: false,
      rejectedPairs: [],
    });

    const content = readFileSync(recordPath, "utf-8");
    expect(content).toContain("No comparison performed");
  });
});

// ---------------------------------------------------------------------------
// Task 6.9 — Real apply path for supersession preserves isSubsequence
// ---------------------------------------------------------------------------

describe("supersession annotation through real apply path (task 6.9)", () => {
  it("supersession annotation is a pure line insertion that passes isSubsequence", () => {
    // Simulate a page with existing content including a claim
    const preContent = [
      "# Food Safety",
      "",
      "## Temperature Danger Zone",
      "",
      "Bacteria multiply rapidly between 4 °C and 60 °C.",
      "Perishable food should not remain in this range for more than two hours.",
      "",
      "## Cross-Contamination",
      "",
      "Raw meat must be stored below ready-to-eat foods.",
    ].join("\n");

    // The supersession annotation to insert
    const annotation = formatSupersessionAnnotation({
      existingClaimText: "Perishable food should not remain in this range for more than two hours.",
      supersessionDate: "2026-08-12",
      sourceSlug: "new-safety-guidelines",
    });

    // Create an edit that inserts the annotation after the Temperature Danger Zone section
    const edit: Edit = {
      page: "food-safety",
      anchor: "## Temperature Danger Zone",
      insertion: annotation,
    };

    // Simulate the edit through the production simulateEditApplication
    const postContent = simulateEditApplication(preContent, edit);

    // The invariant: isSubsequence(pre, post) must hold
    expect(isSubsequence(preContent, postContent)).toBe(true);

    // The annotation must be present in the post-edit content
    expect(postContent).toContain(annotation);

    // Verify through the production verifyEdit function
    const outcome = verifyEdit(edit, preContent, postContent);
    expect(outcome.status).toBe("accepted");
  });

  it("supersession annotation does not alter any existing line", () => {
    const preContent = [
      "# Exams",
      "",
      "## Schedule",
      "",
      "The AI-103 exam is scheduled for 12 August 2026.",
      "",
      "## Preparation",
      "",
      "Study the materials before the exam.",
    ].join("\n");

    const annotation = formatSupersessionAnnotation({
      existingClaimText: "The AI-103 exam is scheduled for 12 August 2026.",
      supersessionDate: "2026-08-12",
      sourceSlug: "reschedule-notice",
    });

    const edit: Edit = {
      page: "exams",
      anchor: "## Schedule",
      insertion: annotation,
    };

    const postContent = simulateEditApplication(preContent, edit);

    // Every line from pre must appear in post, in order
    expect(isSubsequence(preContent, postContent)).toBe(true);

    // The annotation is a new line — not modifying any existing line
    const preLines = preContent.split("\n");
    const postLines = postContent.split("\n");
    expect(postLines.length).toBeGreaterThan(preLines.length);

    // All original non-empty lines are present
    for (const line of preLines) {
      if (line.trim().length > 0) {
        expect(postLines).toContain(line);
      }
    }
  });
});
