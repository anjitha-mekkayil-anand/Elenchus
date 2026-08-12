/**
 * Persist stage — task 6.5
 *
 * After Apply writes pages, this stage persists page claims bound to:
 *   - page slug
 *   - section anchor (from extraction)
 *   - content hash as written
 *
 * These are the rows future ingests compare against.
 * Uses the same contentHash() from src/hash.ts that staleness reads —
 * one hash function, one place.
 *
 * Called by: section 6 pipeline wiring (cli.ts), after Apply succeeds.
 * Other caller: ensurePageClaims (staleness.ts) — for re-extraction on hash mismatch.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getBaseDir } from "./layout.js";
import { getDb } from "./schema.js";
import { contentHash } from "./hash.js";
import { extractClaims } from "./extract.js";
import type { ModelClient } from "./model/types.js";

/**
 * Persists page claims for a set of pages that were just written by Apply.
 *
 * For each page:
 * 1. Reads the page file as written (raw bytes → hash).
 * 2. Extracts claims with section-level anchors.
 * 3. Supersedes any existing active claims for that page.
 * 4. Inserts the new claims with the current content hash.
 *
 * @param writtenPages - slugs of pages that Apply wrote.
 * @param sourceId - the source that triggered this ingest (for attribution).
 * @param sourceDate - date string for the claims.
 * @param model - ModelClient for extraction.
 */
export async function persistPageClaims(
  writtenPages: string[],
  sourceId: number,
  sourceDate: string,
  model: ModelClient
): Promise<void> {
  const db = getDb();
  const base = getBaseDir();
  const now = new Date().toISOString();

  for (const slug of writtenPages) {
    const pagePath = resolve(base, "pages", `${slug}.md`);
    const fileContent = readFileSync(pagePath);
    const hash = contentHash(fileContent);
    const pageText = fileContent.toString("utf-8");

    // Supersede existing active claims for this page.
    db.prepare(
      "UPDATE claims SET superseded_at = ? WHERE page = ? AND superseded_at IS NULL"
    ).run(now, slug);

    // Extract claims from the page as written.
    const extracted = await extractClaims(pageText, `page/${slug}`, sourceDate, model);

    // Insert new claims with the content hash as written.
    const insertStmt = db.prepare(
      "INSERT INTO claims (page, anchor, text, source_id, source_date, content_hash) VALUES (?, ?, ?, ?, ?, ?)"
    );

    for (const claim of extracted) {
      insertStmt.run(slug, claim.anchor, claim.text, sourceId, sourceDate, hash);
    }
  }
}
