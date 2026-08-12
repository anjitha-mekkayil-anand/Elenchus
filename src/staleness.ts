/**
 * Staleness detection and re-extraction — tasks 3.1, 3.2
 *
 * Before comparing source claims against a page's stored claims, this module
 * checks whether the stored claims are current:
 *
 *   - AC-7.4: if the page's content has changed (hash mismatch), re-extract.
 *   - AC-7.7: if the page has no stored active claims, re-extract (cache miss).
 *
 * Re-extraction marks old rows superseded (never deletes) and inserts new ones.
 * Contradictions keep referencing superseded rows, so history survives and the
 * foreign key never breaks.
 */

import { resolve } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { getBaseDir } from "./layout.js";
import { getDb } from "./schema.js";
import { contentHash } from "./hash.js";
import { extractClaims } from "./extract.js";
import type { ModelClient } from "./model/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StoredClaim {
  id: number;
  page: string;
  anchor: string;
  text: string;
  source_id: number;
  source_date: string;
  content_hash: string;
}

export interface StalenessResult {
  /** The active claims for this page after any re-extraction. */
  claims: StoredClaim[];
  /** Whether re-extraction was triggered (hash mismatch or no active claims). */
  reExtracted: boolean;
  /** The current content hash of the page on disk. */
  currentHash: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Gets or creates the seed-corpus source row. Used when page claims need
 * attribution but no specific source is responsible (e.g., seeded pages).
 */
export function getSeedSourceId(): number {
  const db = getDb();
  const seedHash = createHash("sha256").update("seed-corpus").digest("hex");
  const existing = db.prepare("SELECT id FROM sources WHERE hash = ?").get(seedHash) as { id: number } | undefined;
  if (existing) return existing.id;

  const result = db.prepare(
    "INSERT INTO sources (hash, filename, origin, byte_length) VALUES (?, ?, ?, ?)"
  ).run(seedHash, "seed-corpus", "seed-corpus", 0);
  return Number(result.lastInsertRowid);
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/**
 * Ensures the page's stored claims are current before comparison.
 *
 * 1. Reads the page file from disk and computes its content hash.
 * 2. Queries active claims (superseded_at IS NULL) for that page.
 * 3. If no active claims exist OR the stored content_hash doesn't match
 *    the current file hash → re-extract.
 * 4. Returns the active claims (fresh or existing).
 *
 * @param pageSlug - The page to check (filename stem in pages/).
 * @param sourceId - Source ID to use for newly extracted claims.
 * @param sourceDate - Source date to use for newly extracted claims.
 * @param model - ModelClient for extraction (real or replay).
 */
export async function ensurePageClaims(
  pageSlug: string,
  sourceId: number,
  sourceDate: string,
  model: ModelClient
): Promise<StalenessResult> {
  const db = getDb();
  const pageFile = resolve(getBaseDir(), "pages", `${pageSlug}.md`);

  if (!existsSync(pageFile)) {
    // Page file does not exist — nothing to compare against.
    return { claims: [], reExtracted: false, currentHash: "" };
  }

  // Read file and compute hash on raw bytes — no normalisation (see hash.ts).
  const fileContent = readFileSync(pageFile);
  const currentHash = contentHash(fileContent);

  // Query active claims for this page.
  const activeClaims = db
    .prepare(
      "SELECT id, page, anchor, text, source_id, source_date, content_hash FROM claims WHERE page = ? AND superseded_at IS NULL"
    )
    .all(pageSlug) as StoredClaim[];

  // Check: do we need re-extraction?
  // AC-7.7: no active claims → cache miss → re-extract
  // AC-7.4: hash mismatch → stale → re-extract
  const needsReExtraction =
    activeClaims.length === 0 ||
    activeClaims.some((c) => c.content_hash !== currentHash);

  if (!needsReExtraction) {
    return { claims: activeClaims, reExtracted: false, currentHash };
  }

  // Re-extract: mark existing active claims as superseded, then insert new ones.
  const now = new Date().toISOString();

  // Supersede all active claims for this page.
  db.prepare(
    "UPDATE claims SET superseded_at = ? WHERE page = ? AND superseded_at IS NULL"
  ).run(now, pageSlug);

  // Extract claims from the current page content.
  const pageText = fileContent.toString("utf-8");
  const extracted = await extractClaims(pageText, `page/${pageSlug}`, sourceDate, model);

  // Insert new claims with the current content hash.
  const insertStmt = db.prepare(
    "INSERT INTO claims (page, anchor, text, source_id, source_date, content_hash) VALUES (?, ?, ?, ?, ?, ?)"
  );

  for (const claim of extracted) {
    insertStmt.run(pageSlug, claim.anchor, claim.text, sourceId, sourceDate, currentHash);
  }

  // Note: we do NOT update pages.content_hash here.
  // claims.content_hash is the single source of truth for staleness (Decision 3, section 6).
  // pages.content_hash is unused — staleness reads from claims rows directly.

  // Return the freshly inserted claims.
  const freshClaims = db
    .prepare(
      "SELECT id, page, anchor, text, source_id, source_date, content_hash FROM claims WHERE page = ? AND superseded_at IS NULL"
    )
    .all(pageSlug) as StoredClaim[];

  return { claims: freshClaims, reExtracted: true, currentHash };
}
