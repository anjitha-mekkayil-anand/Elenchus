/**
 * Record stage — tasks 9.1, 9.2
 *
 * Writes ingests/<timestamp>-<slug>.md — a readable markdown record of
 * what the ingest did and why. This is not logging. It is the artefact
 * that makes the app's judgement inspectable.
 *
 * AC-5.1: source, candidates + reasons, decisions + reasoning, pages
 *         changed, rejected edits.
 * AC-5.2: readable as a file without running the app.
 * AC-2.3: considered-but-not-edited must be visible here.
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getBaseDir } from "./layout.js";
import type { Candidate, DroppedCandidate } from "./retrieve.js";
import type { Decision } from "./decide.js";
import type { RejectedEdit } from "./verify.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IngestRecordData {
  /** The source origin (path or URL as given by user). */
  sourceOrigin: string;
  /** Where the extracted text was persisted (filename under sources/). */
  sourceFilename: string;
  /** Candidates retrieved from the model. */
  candidates: Candidate[];
  /** Candidates dropped because their slug was hallucinated. */
  droppedCandidates: DroppedCandidate[];
  /** Whether this was a new-topic ingest (no valid candidates). */
  newTopic: boolean;
  /** Decisions taken per candidate. */
  decisions: Decision[];
  /** Pages that were written (created or updated). */
  pagesChanged: Array<{ slug: string }>;
  /** Edits rejected by the verify gate. */
  rejectedEdits: RejectedEdit[];
  /** Classified pairs detected during comparison (AC-11.1). Optional for backward compat. */
  detectedPairs?: DetectedPairRecord[];
  /** Whether comparison was performed (AC-11.2). */
  comparisonPerformed?: boolean;
  /** Pairs demoted by gates — diagnostic info (AC-8.7, AC-8.5). */
  rejectedPairs?: RejectedPairRecord[];
}

export interface DetectedPairRecord {
  sourceClaimText: string;
  storedClaimText: string;
  label: string;
  reasoning: string;
  falsifier: string;
  changeEvidence?: string;
}

export interface RejectedPairRecord {
  sourceClaimText: string;
  storedClaimText: string;
  originalLabel: string;
  demotedTo: string;
  reason: string;
}

// ---------------------------------------------------------------------------
// Record
// ---------------------------------------------------------------------------

/**
 * Writes the ingest record to ingests/<timestamp>-<slug>.md.
 * Returns the path to the written file.
 */
export function writeIngestRecord(data: IngestRecordData): string {
  const base = getBaseDir();
  const ingestsDir = resolve(base, "ingests");

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const slug = buildSlugFromOrigin(data.sourceOrigin);
  const filename = `${timestamp}-${slug}.md`;
  const filePath = resolve(ingestsDir, filename);

  const content = formatRecord(data);
  writeFileSync(filePath, content, "utf-8");

  return filePath;
}

/**
 * Formats the ingest record as readable markdown.
 * Written as prose and headings a person reads (AC-5.2).
 */
function formatRecord(data: IngestRecordData): string {
  const lines: string[] = [];

  // Title
  lines.push(`# Ingest Record`);
  lines.push("");
  lines.push(`**Date:** ${new Date().toISOString().slice(0, 19).replace("T", " ")} UTC`);
  lines.push("");

  // Source
  lines.push("## Source");
  lines.push("");
  lines.push(`**Origin:** ${data.sourceOrigin}`);
  lines.push(`**Persisted to:** \`sources/${data.sourceFilename}\``);
  lines.push("");

  // Candidates retrieved
  lines.push("## Candidates Retrieved");
  lines.push("");
  if (data.candidates.length === 0 && data.droppedCandidates.length === 0) {
    lines.push("No candidates were retrieved — this is a new topic.");
  } else {
    if (data.candidates.length > 0) {
      for (const c of data.candidates) {
        lines.push(`- **${c.slug}** — ${c.reason}`);
      }
    }
    if (data.candidates.length === 0 && data.droppedCandidates.length > 0) {
      lines.push("All candidates were hallucinated (see below). New-topic path taken.");
    }
  }
  lines.push("");

  // Dropped candidates (hallucinated slugs)
  if (data.droppedCandidates.length > 0) {
    lines.push("### Dropped Candidates (Hallucinated Slugs)");
    lines.push("");
    lines.push("These candidates were returned by the model but do not exist in the page index:");
    lines.push("");
    for (const d of data.droppedCandidates) {
      lines.push(`- **${d.slug}** — model's reason: "${d.reason}"`);
      lines.push(`  Dropped because: ${d.dropReason}`);
    }
    lines.push("");
  }

  // Decisions
  lines.push("## Decisions");
  lines.push("");
  if (data.decisions.length === 0) {
    lines.push("No decisions were made (no candidates to evaluate).");
  } else {
    for (const d of data.decisions) {
      if (d.action === "weave") {
        lines.push(`- **Weave** into \`${d.slug}\` — ${d.reason}`);
      } else if (d.action === "skip") {
        lines.push(`- **Skip** \`${d.slug}\` — ${d.reason}`);
      } else if (d.action === "create") {
        lines.push(`- **Create** new page \`${d.suggestedSlug}\` ("${d.suggestedTitle}") — ${d.reason}`);
        if (d.rejectedCandidates.length > 0) {
          lines.push("");
          lines.push("  Rejected candidates considered before creating:");
          for (const rc of d.rejectedCandidates) {
            lines.push(`  - \`${rc.slug}\`: ${rc.reason}`);
          }
        }
      }
    }
  }
  lines.push("");

  // Pages changed
  lines.push("## Pages Changed");
  lines.push("");
  if (data.pagesChanged.length === 0) {
    lines.push("No pages were changed in this ingest.");
  } else {
    for (const p of data.pagesChanged) {
      lines.push(`- \`pages/${p.slug}.md\``);
    }
  }
  lines.push("");

  // Contradiction detection (AC-11.1, AC-11.2)
  lines.push("## Claim Comparison");
  lines.push("");
  if (data.comparisonPerformed === false) {
    lines.push("No comparison performed (no target pages to compare against).");
  } else if (data.detectedPairs && data.detectedPairs.length > 0) {
    lines.push(`Detected **${data.detectedPairs.length}** conflict(s):`);
    lines.push("");
    for (const pair of data.detectedPairs) {
      lines.push(`### ${pair.label.charAt(0).toUpperCase() + pair.label.slice(1)}`);
      lines.push("");
      lines.push(`- **Source claim:** ${pair.sourceClaimText}`);
      lines.push(`- **Stored claim:** ${pair.storedClaimText}`);
      lines.push(`- **Falsifier:** ${pair.falsifier}`);
      lines.push(`- **Reasoning:** ${pair.reasoning}`);
      if (pair.changeEvidence) {
        lines.push(`- **Change evidence:** "${pair.changeEvidence}"`);
      }
      lines.push("");
    }
  } else {
    lines.push("Claims were compared and none conflicted.");
  }
  lines.push("");

  // Demoted pairs (diagnostic — gate failures)
  if (data.rejectedPairs && data.rejectedPairs.length > 0) {
    lines.push("### Demoted Pairs (Gate Failures)");
    lines.push("");
    for (const rp of data.rejectedPairs) {
      lines.push(`- **${rp.originalLabel} → ${rp.demotedTo}**: "${rp.sourceClaimText}" vs "${rp.storedClaimText}"`);
      lines.push(`  Reason: ${rp.reason}`);
    }
    lines.push("");
  }

  // Rejected edits
  if (data.rejectedEdits.length > 0) {
    lines.push("## Rejected Edits");
    lines.push("");
    lines.push("These edits were planned but failed the invariant check (existing content must be preserved as a subsequence):");
    lines.push("");
    for (const re of data.rejectedEdits) {
      lines.push(`### Edit to \`${re.edit.page}\` at "${re.edit.anchor}"`);
      lines.push("");
      lines.push(`**Rejected because:** ${re.reason}`);
      lines.push("");
      lines.push("Planned insertion (not applied):");
      lines.push("");
      lines.push("```");
      lines.push(re.edit.insertion);
      lines.push("```");
      lines.push("");
    }
  } else {
    lines.push("## Rejected Edits");
    lines.push("");
    lines.push("None — all planned edits passed the invariant check.");
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Extracts a short slug from the source origin for the filename.
 */
function buildSlugFromOrigin(origin: string): string {
  let name: string;
  try {
    const url = new URL(origin);
    const pathParts = url.pathname.split("/").filter(Boolean);
    name = pathParts.length > 0
      ? pathParts[pathParts.length - 1]
      : url.hostname;
  } catch {
    // Not a URL — use the last path segment
    const parts = origin.replace(/\\/g, "/").split("/").filter(Boolean);
    name = parts[parts.length - 1] ?? "source";
  }

  // Remove extension and slugify
  const dotIdx = name.lastIndexOf(".");
  if (dotIdx > 0) name = name.slice(0, dotIdx);

  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "source";
}
