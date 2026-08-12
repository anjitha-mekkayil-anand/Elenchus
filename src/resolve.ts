/**
 * Resolution — spec 2, section 7 (tasks 7.1–7.5)
 *
 * `elenchus resolve <id> --keep A|B --reason "..."`
 *
 * Resolution does NOT go through verifyEdit. The verify gate protects ingest
 * from destroying content (AC-4.1/AC-4.2). Resolution is an explicit human
 * command that changes the callout's state — it is not an ingest.
 *
 * Instead, resolution has its own narrower, mechanical check:
 * Before writing, assert that BOTH claim texts appear verbatim in the
 * post-resolution content. That is what AC-10.3 actually requires — the
 * rejected claim is retained, not that the callout is immutable.
 *
 * Nothing deletes a claim. The claims table is not written to at all —
 * no status flag, no soft delete, no marking.
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { getBaseDir } from "./layout.js";
import { ensureSchema } from "./schema.js";
import { formatContradictionId } from "./contradict.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResolveResult {
  success: true;
  id: string;
  kept: "A" | "B";
  reason: string;
}

export interface ResolveError {
  success: false;
  reason: string;
}

export type ResolveOutcome = ResolveResult | ResolveError;

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolves a contradiction by the given ID.
 *
 * Effects on success:
 * - Page callout rewritten: [!warning]→[!note], open→resolved, resolution line added
 * - Register entry moved from Open to Resolved section
 * - SQLite row updated: status, resolved_keep, resolved_at, resolved_reason
 *
 * On failure (unknown id, already resolved, invalid keep):
 * - Returns { success: false, reason } and changes NOTHING.
 */
export function resolveContradiction(
  id: string,
  keep: string,
  reason: string
): ResolveOutcome {
  // Validate keep value
  if (keep !== "A" && keep !== "B") {
    return { success: false, reason: `--keep must be "A" or "B", got "${keep}".` };
  }

  const db = ensureSchema();

  // Parse numeric id from CD-NNN format
  const numericId = parseContradictionId(id);
  if (numericId === null) {
    return { success: false, reason: `Unknown contradiction id: "${id}". Expected format: CD-NNN.` };
  }

  // Look up the contradiction row
  const row = db.prepare(
    "SELECT id, claim_a, claim_b, status FROM contradictions WHERE id = ?"
  ).get(numericId) as { id: number; claim_a: number; claim_b: number; status: string } | undefined;

  if (!row) {
    return { success: false, reason: `Contradiction ${id} not found.` };
  }

  if (row.status === "resolved") {
    return { success: false, reason: `Contradiction ${id} is already resolved.` };
  }

  // Look up both claim texts (for the narrow check)
  const claimA = db.prepare("SELECT text FROM claims WHERE id = ?").get(row.claim_a) as { text: string } | undefined;
  const claimB = db.prepare("SELECT text FROM claims WHERE id = ?").get(row.claim_b) as { text: string } | undefined;

  if (!claimA || !claimB) {
    return { success: false, reason: `Claims for ${id} not found in database.` };
  }

  // Find and rewrite the callout on the page
  const cdId = formatContradictionId(numericId);
  const pageSlug = findPageWithCallout(cdId);
  if (!pageSlug) {
    return { success: false, reason: `Callout for ${id} not found on any page.` };
  }

  const pagePath = resolve(getBaseDir(), "pages", `${pageSlug}.md`);
  const pageContent = readFileSync(pagePath, "utf-8");
  const resolvedAt = new Date().toISOString().slice(0, 10);

  const newPageContent = rewriteCalloutToResolved(pageContent, cdId, keep, reason, resolvedAt);

  // Narrow mechanical check (AC-10.3): both claim texts must appear in post-resolution content
  if (!newPageContent.includes(claimA.text)) {
    return { success: false, reason: `Resolution would lose claim A text — AC-10.3 violation.` };
  }
  if (!newPageContent.includes(claimB.text)) {
    return { success: false, reason: `Resolution would lose claim B text — AC-10.3 violation.` };
  }

  // Move register entry from Open to Resolved
  const registerPath = resolve(getBaseDir(), "contradictions.md");
  const registerContent = readFileSync(registerPath, "utf-8");
  const newRegisterContent = moveToResolved(registerContent, cdId, keep, reason, resolvedAt);

  // All checks passed — write atomically (page, register, then DB)
  writeFileSync(pagePath, newPageContent, "utf-8");
  writeFileSync(registerPath, newRegisterContent, "utf-8");

  // Update SQLite row
  db.prepare(
    "UPDATE contradictions SET status = 'resolved', resolved_keep = ?, resolved_at = ?, resolved_reason = ? WHERE id = ?"
  ).run(keep, resolvedAt, reason, numericId);

  return { success: true, id: cdId, kept: keep as "A" | "B", reason };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parses CD-NNN to a numeric id. Returns null if format doesn't match.
 */
function parseContradictionId(id: string): number | null {
  const match = id.match(/^CD-(\d+)$/i);
  if (!match) return null;
  return parseInt(match[1], 10);
}

/**
 * Finds the page (slug) containing the callout for the given CD-NNN id.
 * Scans all pages in pages/.
 */
function findPageWithCallout(cdId: string): string | null {
  const pagesDir = resolve(getBaseDir(), "pages");
  const files = readdirSync(pagesDir).filter((f) => f.endsWith(".md"));

  for (const file of files) {
    const content = readFileSync(resolve(pagesDir, file), "utf-8");
    if (content.includes(`Contradiction — ${cdId}`)) {
      return file.replace(/\.md$/, "");
    }
  }
  return null;
}

/**
 * Rewrites the callout from open to resolved.
 *
 * Changes:
 * - [!warning] → [!note]
 * - · open → · resolved
 * - Adds resolution line at the end of the callout block
 *
 * The two claim lines (A, B) and the reasoning line are UNTOUCHED.
 */
export function rewriteCalloutToResolved(
  pageContent: string,
  cdId: string,
  keep: "A" | "B",
  reason: string,
  resolvedAt: string
): string {
  const lines = pageContent.split("\n");
  const headerIdx = lines.findIndex((l) =>
    l.includes(`Contradiction — ${cdId}`) && l.includes("· open")
  );

  if (headerIdx === -1) {
    return pageContent; // Callout not found — no change
  }

  // Rewrite the header line
  lines[headerIdx] = lines[headerIdx]
    .replace("[!warning]", "[!note]")
    .replace("· open", "· resolved");

  // Find the end of the callout block (lines starting with ">")
  let endIdx = headerIdx + 1;
  while (endIdx < lines.length && lines[endIdx].startsWith(">")) {
    endIdx++;
  }

  // Insert resolution line at the end of the callout (before the first non-> line)
  const resolutionLine = `> **Resolved ${resolvedAt} — kept ${keep}.** ${reason}`;
  lines.splice(endIdx, 0, resolutionLine);

  return lines.join("\n");
}

/**
 * Moves an entry from the Open section to the Resolved section of the register.
 * The entry's heading is changed from "open" to "resolved" and a resolution note is added.
 * Total entry count is preserved — nothing is lost.
 */
export function moveToResolved(
  registerContent: string,
  cdId: string,
  keep: "A" | "B",
  reason: string,
  resolvedAt: string
): string {
  const lines = registerContent.split("\n");

  // Find the entry heading in the Open section
  const entryHeadingIdx = lines.findIndex((l) =>
    l.includes(`### ${cdId}`) && l.includes("— open")
  );

  if (entryHeadingIdx === -1) {
    return registerContent; // Entry not found — no change
  }

  // Find the extent of this entry (until next ### or ## heading or end)
  let entryEnd = entryHeadingIdx + 1;
  while (entryEnd < lines.length && !lines[entryEnd].startsWith("##")) {
    entryEnd++;
  }

  // Extract the entry lines
  const entryLines = lines.slice(entryHeadingIdx, entryEnd);

  // Rewrite the heading to "resolved"
  entryLines[0] = entryLines[0].replace("— open", "— resolved");

  // Add resolution note at the end of the entry
  entryLines.push(`- **Resolved ${resolvedAt} — kept ${keep}.** ${reason}`);
  entryLines.push("");

  // Remove the entry from its current position
  lines.splice(entryHeadingIdx, entryEnd - entryHeadingIdx);

  // Find the ## Resolved heading and insert after it
  const resolvedIdx = lines.findIndex((l) => l.startsWith("## Resolved"));
  if (resolvedIdx === -1) {
    // Fallback: append at end
    lines.push(...entryLines);
  } else {
    // Insert after the ## Resolved heading line (and any comment line after it)
    let insertAt = resolvedIdx + 1;
    while (insertAt < lines.length && (lines[insertAt].startsWith("<!--") || lines[insertAt].trim() === "")) {
      insertAt++;
    }
    lines.splice(insertAt, 0, ...entryLines);
  }

  return lines.join("\n");
}
