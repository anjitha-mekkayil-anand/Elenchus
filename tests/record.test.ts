/**
 * Unit tests for section 9 (Record) — tasks 9.1, 9.2.
 *
 * 9.1: Write the ingest record with all required information.
 * 9.2: Readable as a file without running the app.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureLayout } from "../src/layout.js";
import { ensureSchema, _resetDb } from "../src/schema.js";
import { writeIngestRecord, type IngestRecordData } from "../src/record.js";
import type { RejectedEdit } from "../src/verify.js";

describe("writeIngestRecord (tasks 9.1, 9.2)", () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "elenchus-record-"));
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

  it("writes a file to ingests/ with timestamp and slug in the name", () => {
    const data: IngestRecordData = {
      sourceOrigin: "/home/user/notes/cooking-tips.md",
      sourceFilename: "a1b2c3d4-cooking-tips.txt",
      candidates: [{ slug: "cooking", reason: "New technique mentioned." }],
      droppedCandidates: [],
      newTopic: false,
      decisions: [{ action: "weave", slug: "cooking", reason: "Adds a stir-fry method." }],
      pagesChanged: [{ slug: "cooking" }],
      rejectedEdits: [],
    };

    const filePath = writeIngestRecord(data);

    // File exists in ingests/
    expect(filePath).toContain("ingests/");
    expect(filePath).toContain("cooking-tips");
    expect(filePath).toMatch(/\.md$/);

    const content = readFileSync(filePath, "utf-8");
    expect(content.length).toBeGreaterThan(0);
  });

  it("includes the source origin and persisted filename (AC-5.1)", () => {
    const data: IngestRecordData = {
      sourceOrigin: "https://example.com/article",
      sourceFilename: "f0f0f0f0-article.txt",
      candidates: [],
      droppedCandidates: [],
      newTopic: true,
      decisions: [{ action: "create", suggestedSlug: "new-topic", suggestedTitle: "New Topic", reason: "Genuinely new.", rejectedCandidates: [] }],
      pagesChanged: [{ slug: "new-topic" }],
      rejectedEdits: [],
    };

    const filePath = writeIngestRecord(data);
    const content = readFileSync(filePath, "utf-8");

    expect(content).toContain("https://example.com/article");
    expect(content).toContain("sources/f0f0f0f0-article.txt");
  });

  it("includes candidates with reasons (AC-5.1, AC-2.3)", () => {
    const data: IngestRecordData = {
      sourceOrigin: "/src.md",
      sourceFilename: "abcd1234-src.txt",
      candidates: [
        { slug: "cooking", reason: "Discusses new technique." },
        { slug: "nutrition", reason: "Mentions vitamins." },
      ],
      droppedCandidates: [],
      newTopic: false,
      decisions: [
        { action: "weave", slug: "cooking", reason: "Adds stir-fry." },
        { action: "skip", slug: "nutrition", reason: "Too tangential." },
      ],
      pagesChanged: [{ slug: "cooking" }],
      rejectedEdits: [],
    };

    const filePath = writeIngestRecord(data);
    const content = readFileSync(filePath, "utf-8");

    // Candidates visible
    expect(content).toContain("**cooking**");
    expect(content).toContain("Discusses new technique.");
    expect(content).toContain("**nutrition**");
    expect(content).toContain("Mentions vitamins.");
  });

  it("includes dropped (hallucinated) candidates with reasons", () => {
    const data: IngestRecordData = {
      sourceOrigin: "/src.md",
      sourceFilename: "abcd-src.txt",
      candidates: [{ slug: "real-page", reason: "Relevant." }],
      droppedCandidates: [
        { slug: "fake-page", reason: "Model thought it existed.", dropReason: 'Slug "fake-page" does not exist in the page index.' },
      ],
      newTopic: false,
      decisions: [{ action: "weave", slug: "real-page", reason: "Fits." }],
      pagesChanged: [{ slug: "real-page" }],
      rejectedEdits: [],
    };

    const filePath = writeIngestRecord(data);
    const content = readFileSync(filePath, "utf-8");

    expect(content).toContain("Dropped Candidates");
    expect(content).toContain("**fake-page**");
    expect(content).toContain("does not exist in the page index");
  });

  it("includes decisions with reasoning (AC-5.1)", () => {
    const data: IngestRecordData = {
      sourceOrigin: "/src.md",
      sourceFilename: "abcd-src.txt",
      candidates: [{ slug: "cooking", reason: "Relevant." }],
      droppedCandidates: [],
      newTopic: false,
      decisions: [
        { action: "weave", slug: "cooking", reason: "Adds a new method." },
      ],
      pagesChanged: [{ slug: "cooking" }],
      rejectedEdits: [],
    };

    const filePath = writeIngestRecord(data);
    const content = readFileSync(filePath, "utf-8");

    expect(content).toContain("**Weave**");
    expect(content).toContain("`cooking`");
    expect(content).toContain("Adds a new method.");
  });

  it("includes create decisions with rejected candidates (AC-3.3, AC-5.1)", () => {
    const data: IngestRecordData = {
      sourceOrigin: "/src.md",
      sourceFilename: "abcd-src.txt",
      candidates: [{ slug: "cooking", reason: "Maybe." }],
      droppedCandidates: [],
      newTopic: false,
      decisions: [
        { action: "skip", slug: "cooking", reason: "Not about cooking." },
        {
          action: "create",
          suggestedSlug: "astronomy",
          suggestedTitle: "Astronomy",
          reason: "New topic about stars.",
          rejectedCandidates: [{ slug: "cooking", reason: "Not about cooking." }],
        },
      ],
      pagesChanged: [{ slug: "astronomy" }],
      rejectedEdits: [],
    };

    const filePath = writeIngestRecord(data);
    const content = readFileSync(filePath, "utf-8");

    expect(content).toContain("**Create**");
    expect(content).toContain("`astronomy`");
    expect(content).toContain("Astronomy");
    expect(content).toContain("Rejected candidates considered before creating");
    expect(content).toContain("`cooking`: Not about cooking.");
  });

  it("includes pages changed (AC-5.1)", () => {
    const data: IngestRecordData = {
      sourceOrigin: "/src.md",
      sourceFilename: "abcd-src.txt",
      candidates: [{ slug: "a", reason: "R." }, { slug: "b", reason: "R." }],
      droppedCandidates: [],
      newTopic: false,
      decisions: [
        { action: "weave", slug: "a", reason: "Fits." },
        { action: "weave", slug: "b", reason: "Also fits." },
      ],
      pagesChanged: [{ slug: "a" }, { slug: "b" }],
      rejectedEdits: [],
    };

    const filePath = writeIngestRecord(data);
    const content = readFileSync(filePath, "utf-8");

    expect(content).toContain("`pages/a.md`");
    expect(content).toContain("`pages/b.md`");
  });

  it("includes rejected edits with reasons (AC-5.1)", () => {
    const rejected: RejectedEdit[] = [
      {
        edit: { page: "cooking", anchor: "## Tips", insertion: "Bad edit text." },
        status: "rejected",
        reason: "Invariant violation: post-edit content does not contain pre-edit content as a subsequence.",
      },
    ];

    const data: IngestRecordData = {
      sourceOrigin: "/src.md",
      sourceFilename: "abcd-src.txt",
      candidates: [{ slug: "cooking", reason: "Relevant." }],
      droppedCandidates: [],
      newTopic: false,
      decisions: [{ action: "weave", slug: "cooking", reason: "Fits." }],
      pagesChanged: [],
      rejectedEdits: rejected,
    };

    const filePath = writeIngestRecord(data);
    const content = readFileSync(filePath, "utf-8");

    expect(content).toContain("Rejected Edits");
    expect(content).toContain("`cooking`");
    expect(content).toContain("## Tips");
    expect(content).toContain("Invariant violation");
    expect(content).toContain("Bad edit text.");
  });

  it("is readable as prose with markdown headings (AC-5.2)", () => {
    const data: IngestRecordData = {
      sourceOrigin: "/home/user/notes.md",
      sourceFilename: "1234abcd-notes.txt",
      candidates: [{ slug: "topic", reason: "Related." }],
      droppedCandidates: [],
      newTopic: false,
      decisions: [{ action: "weave", slug: "topic", reason: "Adds detail." }],
      pagesChanged: [{ slug: "topic" }],
      rejectedEdits: [],
    };

    const filePath = writeIngestRecord(data);
    const content = readFileSync(filePath, "utf-8");

    // Has proper markdown structure
    expect(content).toContain("# Ingest Record");
    expect(content).toContain("## Source");
    expect(content).toContain("## Candidates Retrieved");
    expect(content).toContain("## Decisions");
    expect(content).toContain("## Pages Changed");
    expect(content).toContain("## Rejected Edits");

    // Not raw JSON — should contain prose connectors
    expect(content).not.toMatch(/^\[/m);
    expect(content).not.toMatch(/^\{/m);
  });

  it("handles new-topic ingest with no candidates", () => {
    const data: IngestRecordData = {
      sourceOrigin: "/new-thing.md",
      sourceFilename: "ffff0000-new-thing.txt",
      candidates: [],
      droppedCandidates: [],
      newTopic: true,
      decisions: [{ action: "create", suggestedSlug: "new-thing", suggestedTitle: "New Thing", reason: "No pages cover this.", rejectedCandidates: [] }],
      pagesChanged: [{ slug: "new-thing" }],
      rejectedEdits: [],
    };

    const filePath = writeIngestRecord(data);
    const content = readFileSync(filePath, "utf-8");

    expect(content).toContain("new topic");
    expect(content).toContain("**Create**");
    expect(content).toContain("`new-thing`");
  });
});
