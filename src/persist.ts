/**
 * Persist stage — task 6.5 (rewritten)
 *
 * After Apply writes pages, this stage persists source claims as page claims
 * DIRECTLY — no re-extraction needed because the source material was woven
 * into the page by Plan/Apply.
 *
 * Source claims become page claims by binding them to:
 *   - page slug (the page they were woven into)
 *   - anchor (the weave edit's anchor that placed them)
 *   - content_hash (of the page as written, filled in after Apply)
 *
 * This avoids the design conflict where AC-7.1 says source claims are unbound
 * and never stored, but contradictions.claim_a/claim_b require both sides to
 * be claims(id) rows. The resolution: once woven, a source claim IS a page
 * claim. No matching, no fallback, no re-extraction.
 *
 * ensurePageClaims keeps its job for seed pages and hand-edited pages
 * (AC-7.4 and AC-7.7). Only the post-Apply path changes.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getBaseDir } from "./layout.js";
import { getDb } from "./schema.js";
import { contentHash } from "./hash.js";
import type { ExtractedClaim } from "./extract.js";

/**
 * Inserts source claims as page claims for a specific page.
 * Returns the inserted claim IDs (needed for contradiction rows).
 *
 * @param pageSlug - The page the claims were woven into.
 * @param claims - The source claims to persist as page claims.
 * @param sourceId - The source that asserted these claims.
 * @param sourceDate - Date string for the claims.
 * @param anchor - The weave anchor where the material was placed.
 * @param contentHash - Hash of the page as written (computed after Apply).
 */
export function insertSourceClaimsAsPageClaims(
  pageSlug: string,
  claims: ExtractedClaim[],
  sourceId: number,
  sourceDate: string,
  anchor: string,
  hash: string
): number[] {
  const db = getDb();
  const insertStmt = db.prepare(
    "INSERT INTO claims (page, anchor, text, source_id, source_date, content_hash) VALUES (?, ?, ?, ?, ?, ?)"
  );

  const ids: number[] = [];
  for (const claim of claims) {
    const result = insertStmt.run(pageSlug, anchor, claim.text, sourceId, sourceDate, hash);
    ids.push(Number(result.lastInsertRowid));
  }
  return ids;
}

/**
 * Updates the content_hash on ALL active claims for a page.
 * Called after Apply writes the page — the page grew, so existing claims'
 * stored hashes would otherwise mismatch and trigger pointless re-extraction.
 * The existing claims are still true (the invariant guarantees content was
 * only added), so refreshing their hash is correct.
 */
export function refreshClaimHashes(pageSlug: string, newHash: string): void {
  const db = getDb();
  db.prepare(
    "UPDATE claims SET content_hash = ? WHERE page = ? AND superseded_at IS NULL"
  ).run(newHash, pageSlug);
}

/**
 * Computes the content hash of a page file as written on disk.
 */
export function getPageContentHash(pageSlug: string): string {
  const pagePath = resolve(getBaseDir(), "pages", `${pageSlug}.md`);
  const bytes = readFileSync(pagePath);
  return contentHash(bytes);
}
