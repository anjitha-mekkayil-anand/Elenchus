/**
 * Contradiction representation — spec 2, section 5 (tasks 5.1–5.3)
 *
 * Pure functions that produce on-page text from classified pairs:
 * - 5.1: Contradiction callout (Obsidian callout, degrades to quoted text)
 * - 5.2: Supersession annotation (own line, inserted after the claim)
 * - 5.3: Register entries in contradictions.md
 *
 * These functions take already-classified pairs and produce text.
 * Nothing here decides anything — detection is section 4.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getBaseDir } from "./layout.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClaimRef {
  text: string;
  sourceSlug: string;
  sourceDate: string;
}

export interface ContradictionEntry {
  /** Derived from contradictions.id, zero-padded to 3 digits. */
  id: string;
  /** A is the EXISTING claim, B is the NEW one. Always. (AC-9.2) */
  claimA: ClaimRef;
  claimB: ClaimRef;
  reasoning: string;
}

export interface SupersessionEntry {
  /** The existing claim text (may be multi-line). */
  existingClaimText: string;
  /** Date the supersession occurred. */
  supersessionDate: string;
  /** Source slug that caused the supersession. */
  sourceSlug: string;
}

// ---------------------------------------------------------------------------
// Display helper — strip hash prefix from source slugs
// ---------------------------------------------------------------------------

/**
 * Strips the leading 8-hex-character prefix from a source slug for display.
 * e.g., "8271c9cd-food-safety-update" → "food-safety-update"
 *
 * The hash prefix ensures uniqueness on disk (from acceptSource) but is
 * noise in callouts, annotations, and the register. This is a rendering
 * change only — stored filenames keep their hash.
 *
 * If the slug doesn't match the pattern (e.g., "seed-corpus"), return as-is.
 */
export function displaySlug(slug: string): string {
  // Pattern: 8 hex chars followed by a dash, then the rest
  const match = slug.match(/^[0-9a-f]{8}-(.+)$/);
  return match ? match[1] : slug;
}

// ---------------------------------------------------------------------------
// 5.1 — Contradiction callout (pure function, no I/O)
// ---------------------------------------------------------------------------

/**
 * Produces a markdown callout block for an open contradiction.
 * Renders in Obsidian, degrades to readable quoted text elsewhere (NF-6).
 *
 * A is the existing claim, B is the new one. This ordering is structural
 * and non-evaluative (AC-9.2 forbids ranking or preference).
 */
export function formatContradictionCallout(entry: ContradictionEntry): string {
  return (
    `> [!warning] Contradiction — ${entry.id} · open\n` +
    `> **A** — ${entry.claimA.sourceDate} · \`src/${displaySlug(entry.claimA.sourceSlug)}\` — ${entry.claimA.text}\n` +
    `> **B** — ${entry.claimB.sourceDate} · \`src/${displaySlug(entry.claimB.sourceSlug)}\` — ${entry.claimB.text}\n` +
    `> ${entry.reasoning}`
  );
}

/**
 * Derives the CD-NNN identifier from a contradictions.id primary key.
 * Zero-padded to three digits. Single source of truth — no separate counter.
 */
export function formatContradictionId(numericId: number): string {
  return `CD-${String(numericId).padStart(3, "0")}`;
}

// ---------------------------------------------------------------------------
// 5.2 — Supersession annotation (pure function, no I/O)
// ---------------------------------------------------------------------------

/**
 * Produces the supersession annotation as a standalone line to INSERT
 * immediately after the last line of the existing claim's anchor region.
 *
 * This is a PURE LINE INSERTION. The existing claim line is not modified.
 * isSubsequence(pre, post) passes unchanged — every pre-edit line still
 * appears verbatim, in order. No exemption, no weakened check, no change
 * to the verify gate.
 *
 * No strikethrough: AC-9.3 says "annotate the prior claim and do not remove
 * it." A strikethrough renders the claim as crossed out — visually removed,
 * carrying a "this is dead" signal the requirement does not want.
 *
 * Placement rule: INSERT A NEW LINE immediately after the last line of the
 * claim's anchor region. (Claims may span multiple lines per design.md.)
 */
export function formatSupersessionAnnotation(entry: SupersessionEntry): string {
  return `*superseded ${entry.supersessionDate} by \`src/${displaySlug(entry.sourceSlug)}\`*`;
}

// ---------------------------------------------------------------------------
// 5.3 — Register entries in contradictions.md (I/O)
// ---------------------------------------------------------------------------

/**
 * Adds a contradiction entry to the Open section of contradictions.md.
 * The register is NOT append-only (entries move to Resolved later),
 * but this function only adds — never removes or reorders existing entries.
 */
export function addToRegister(entry: ContradictionEntry): void {
  const base = getBaseDir();
  const registerPath = resolve(base, "contradictions.md");
  const content = readFileSync(registerPath, "utf-8");

  const registerEntry = formatRegisterEntry(entry);

  // Insert after the "## Open" heading and its comment line
  const openHeadingIdx = content.indexOf("## Open");
  if (openHeadingIdx === -1) {
    throw new Error("contradictions.md is missing the '## Open' section heading.");
  }

  // Find the end of the line after ## Open (skip the heading line itself)
  const afterOpenHeading = content.indexOf("\n", openHeadingIdx);
  if (afterOpenHeading === -1) {
    throw new Error("contradictions.md: unexpected format after '## Open'.");
  }

  // Find the next non-empty, non-comment line after ## Open to insert before,
  // or the ## Resolved heading — whichever comes first.
  // We insert just before ## Resolved (at the end of the Open section).
  const resolvedIdx = content.indexOf("## Resolved");
  if (resolvedIdx === -1) {
    throw new Error("contradictions.md is missing the '## Resolved' section heading.");
  }

  // Insert the new entry just before ## Resolved, with a blank line separator
  const before = content.slice(0, resolvedIdx).trimEnd();
  const after = content.slice(resolvedIdx);

  const newContent = before + "\n\n" + registerEntry + "\n\n" + after;
  writeFileSync(registerPath, newContent, "utf-8");
}

/**
 * Formats a single register entry for contradictions.md.
 * Plain markdown, readable without the application (NF-6).
 */
export function formatRegisterEntry(entry: ContradictionEntry): string {
  return (
    `### ${entry.id} — open\n\n` +
    `- **A** — ${entry.claimA.sourceDate} · \`src/${displaySlug(entry.claimA.sourceSlug)}\` — ${entry.claimA.text}\n` +
    `- **B** — ${entry.claimB.sourceDate} · \`src/${displaySlug(entry.claimB.sourceSlug)}\` — ${entry.claimB.text}\n` +
    `- **Reasoning:** ${entry.reasoning}`
  );
}
