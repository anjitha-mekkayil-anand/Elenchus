/**
 * Ingest pipeline — extracted from cli.ts for testability.
 *
 * Exports `runIngest(pathOrUrl, opts, model)` which is the complete ingest
 * pipeline from accept through record. The CLI action handler calls this
 * with a real AnthropicClient; tests call it with ReplayClient.
 */

import { resolve } from "node:path";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { ensureLayout, getBaseDir } from "./layout.js";
import { ensureSchema, getDb } from "./schema.js";
import { acceptSource, isRejection } from "./accept.js";
import { syncPagesFromDisk, rebuildIndex } from "./pages.js";
import { retrieve } from "./retrieve.js";
import { decide } from "./decide.js";
import { plan } from "./plan.js";
import type { Edit } from "./plan.js";
import { applyEdits, withRetry } from "./apply.js";
import { writeIngestRecord } from "./record.js";
import type { DetectedPairRecord, RejectedPairRecord } from "./record.js";
import { extractClaims } from "./extract.js";
import { ensurePageClaims, getSeedSourceId } from "./staleness.js";
import { compareClaims } from "./compare.js";
import type { ClassifiedPair, RejectedPair, StoredClaimForCompare } from "./compare.js";
import {
  formatContradictionCallout,
  formatContradictionId,
  formatSupersessionAnnotation,
  addToRegister,
} from "./contradict.js";
import type { ContradictionEntry } from "./contradict.js";
import {
  insertSourceClaimsAsPageClaims,
  refreshClaimHashes,
  getPageContentHash,
} from "./persist.js";
import type { ModelClient } from "./model/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IngestOpts {
  force?: boolean;
  /** Override source date (ISO date string). Defaults to today. Used by tests for deterministic replay. */
  sourceDate?: string;
}

export interface IngestResult {
  sourceId: number;
  pagesWritten: string[];
  pagesCreated: string[];
  contradictions: string[];
  editsRejected: number;
  recordPath: string;
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export async function runIngest(
  pathOrUrl: string,
  opts: IngestOpts,
  model: ModelClient
): Promise<IngestResult> {
  ensureLayout();
  ensureSchema();

  // Accept
  const outcome = await acceptSource(pathOrUrl, { force: opts.force });
  if (isRejection(outcome)) {
    throw new Error(`Rejected: ${outcome.reason}`);
  }
  if (outcome.alreadyIngested && !outcome.forced) {
    throw new Error(`Already ingested (source #${outcome.sourceId}). Use force: true.`);
  }

  const sourceTextPath = resolve(getBaseDir(), "sources", outcome.filename);
  const sourceText = readFileSync(sourceTextPath, "utf-8");
  syncPagesFromDisk();

  // Retrieve
  const retrieveResult = await withRetry(() => retrieve(sourceText, model), "retrieve");

  // Decide
  const decideResult = await withRetry(
    () => decide(sourceText, retrieveResult.candidates, model), "decide"
  );
  const weaves = decideResult.decisions.filter((d) => d.action === "weave");
  const creates = decideResult.decisions.filter((d) => d.action === "create");

  // Extract source claims (6.1)
  const sourceDate = opts.sourceDate ?? new Date().toISOString().slice(0, 10);
  const sourceClaims = await withRetry(
    () => extractClaims(sourceText, outcome.filename, sourceDate, model), "extract"
  );

  // Compare (6.2) — bounded to pages this ingest is writing to (NF-5)
  const targetSlugs = weaves.map((d) => d.slug);
  let allConflicts: ClassifiedPair[] = [];
  let allRejectedPairs: RejectedPair[] = [];
  let comparisonPerformed = false;

  if (targetSlugs.length > 0 && sourceClaims.length > 0) {
    comparisonPerformed = true;
    const storedClaims: StoredClaimForCompare[] = [];
    const seedSourceId = getSeedSourceId();

    for (const slug of targetSlugs) {
      const result = await ensurePageClaims(slug, seedSourceId, sourceDate, model);
      for (const c of result.claims) {
        storedClaims.push({ id: c.id, text: c.text, page: c.page, source_date: c.source_date });
      }
    }

    if (storedClaims.length > 0) {
      const compareResult = await withRetry(
        () => compareClaims(sourceClaims, storedClaims, sourceText, model), "compare"
      );
      allConflicts = compareResult.conflicts;
      allRejectedPairs = compareResult.rejected;
    }
  }

  // Plan phase 1 — weave edits
  const planResult = await withRetry(
    () => plan(decideResult.decisions, sourceText, outcome.origin, model), "plan"
  );

  const weaveAnchors = new Map<string, string>();
  for (const edit of planResult.edits) {
    if (edit.anchor !== "(new page)" && !weaveAnchors.has(edit.page)) {
      weaveAnchors.set(edit.page, edit.anchor);
    }
  }

  // Cache pre-Apply content for rollback (6.8)
  const pagesDir = resolve(getBaseDir(), "pages");
  const preApplyContent = new Map<string, string | null>();
  const allTargetPages = new Set<string>();
  for (const edit of planResult.edits) allTargetPages.add(edit.page);
  for (const conflict of allConflicts) allTargetPages.add(conflict.storedClaim.page);
  for (const slug of allTargetPages) {
    const pagePath = resolve(pagesDir, `${slug}.md`);
    preApplyContent.set(slug, existsSync(pagePath) ? readFileSync(pagePath, "utf-8") : null);
  }

  // Verify + Apply phase 1
  const applyResult = applyEdits(planResult.edits);

  // Transaction: insert claims, conflict rows, build phase-2 edits
  const db = getDb();
  const writtenSlugs = applyResult.written.map((w) => w.slug);
  const contradictionIds: string[] = [];
  const phase2Edits: Edit[] = [];
  const supersededClaimIds = new Set<number>(); // dedup: one annotation per stored claim
  try {
    db.exec("BEGIN TRANSACTION");

    // 6.5: Insert ALL source claims as page claims
    const claimIdsByText = new Map<string, number>();
    for (const slug of writtenSlugs) {
      const hash = getPageContentHash(slug);
      const anchor = weaveAnchors.get(slug) ?? "full-page";
      const ids = insertSourceClaimsAsPageClaims(
        slug, sourceClaims, outcome.sourceId, sourceDate, anchor, hash
      );
      for (let i = 0; i < sourceClaims.length; i++) {
        claimIdsByText.set(sourceClaims[i].text, ids[i]);
      }
      refreshClaimHashes(slug, hash);
    }

    // 6.4 + 8.1: Insert conflict rows, handling reopens
    for (const conflict of allConflicts) {
      const claimBId = claimIdsByText.get(conflict.sourceClaim.text);
      if (!claimBId) {
        throw new Error(
          `Cannot persist conflict: source claim "${conflict.sourceClaim.text}" not inserted as page claim.`
        );
      }

      // 8.1: Check for existing resolved contradiction on this claim
      const existingResolved = db.prepare(
        "SELECT id, resolved_keep, resolved_at, resolved_reason FROM contradictions " +
        "WHERE claim_a = ? AND status = 'resolved'"
      ).get(conflict.storedClaim.id) as {
        id: number; resolved_keep: string | null; resolved_at: string | null; resolved_reason: string | null;
      } | undefined;

      if (existingResolved && conflict.label === "contradiction") {
        // 8.1: Reopen — preserve resolution history
        db.prepare(
          "UPDATE contradictions SET status = 'open', claim_b = ?, reasoning = ? WHERE id = ?"
        ).run(claimBId, conflict.reasoning, existingResolved.id);

        const cdId = formatContradictionId(existingResolved.id);
        contradictionIds.push(cdId);

        const { claimASlug, claimADate } = lookupClaimASource(db, conflict.storedClaim.id, conflict.storedClaim.source_date);
        const sourceSlug = outcome.filename.replace(/\.txt$/, "");

        // 8.2: Callout shows prior resolution
        const priorInfo = existingResolved.resolved_reason
          ? `Previously resolved: kept ${existingResolved.resolved_keep} (${existingResolved.resolved_at}). Reason: ${existingResolved.resolved_reason}. Reopened by new material.`
          : "Previously resolved. Reopened by new material.";

        const entry: ContradictionEntry = {
          id: cdId,
          claimA: { text: conflict.storedClaim.text, sourceSlug: claimASlug, sourceDate: claimADate },
          claimB: { text: conflict.sourceClaim.text, sourceSlug: sourceSlug, sourceDate },
          reasoning: `${conflict.reasoning} | ${priorInfo}`,
        };

        addToRegister(entry);
        phase2Edits.push(buildCalloutEdit(db, conflict.storedClaim.id, conflict.storedClaim.page, entry));

      } else {
        // Normal insertion
        const insertResult = db.prepare(
          "INSERT INTO contradictions (claim_a, claim_b, kind, reasoning) VALUES (?, ?, ?, ?)"
        ).run(conflict.storedClaim.id, claimBId, conflict.label, conflict.reasoning);

        if (conflict.label === "contradiction") {
          const cdId = formatContradictionId(Number(insertResult.lastInsertRowid));
          contradictionIds.push(cdId);

          const { claimASlug, claimADate } = lookupClaimASource(db, conflict.storedClaim.id, conflict.storedClaim.source_date);
          const sourceSlug = outcome.filename.replace(/\.txt$/, "");

          const entry: ContradictionEntry = {
            id: cdId,
            claimA: { text: conflict.storedClaim.text, sourceSlug: claimASlug, sourceDate: claimADate },
            claimB: { text: conflict.sourceClaim.text, sourceSlug: sourceSlug, sourceDate },
            reasoning: conflict.reasoning,
          };

          addToRegister(entry);
          phase2Edits.push(buildCalloutEdit(db, conflict.storedClaim.id, conflict.storedClaim.page, entry));

        } else if (conflict.label === "supersession") {
          // Deduplicate: one annotation per superseded stored claim per ingest.
          // Multiple source claims may supersede the same stored claim — the DB
          // rows stay (honest audit record), but only one annotation on the page.
          if (supersededClaimIds.has(conflict.storedClaim.id)) continue;
          supersededClaimIds.add(conflict.storedClaim.id);

          const sourceSlug = outcome.filename.replace(/\.txt$/, "");
          const annotation = formatSupersessionAnnotation({
            existingClaimText: conflict.storedClaim.text,
            supersessionDate: sourceDate,
            sourceSlug,
          });
          const anchorRow = db.prepare(
            "SELECT anchor FROM claims WHERE id = ?"
          ).get(conflict.storedClaim.id) as { anchor: string } | undefined;
          phase2Edits.push({
            page: conflict.storedClaim.page,
            anchor: "## " + (anchorRow?.anchor || "full-page"),
            insertion: annotation,
          });
        }
      }
    }

    db.exec("COMMIT");
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }

    // Roll back file writes
    for (const [slug, original] of preApplyContent) {
      const pagePath = resolve(pagesDir, `${slug}.md`);
      try {
        if (original === null) {
          if (existsSync(pagePath)) unlinkSync(pagePath);
        } else {
          writeFileSync(pagePath, original, "utf-8");
        }
      } catch { /* best effort */ }
    }
    syncPagesFromDisk();
    rebuildIndex();

    throw new Error(
      `Post-Apply transaction failed — rolled back. Cause: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Apply phase 2 — callout and annotation edits
  if (phase2Edits.length > 0) {
    const phase2Result = applyEdits(phase2Edits);
    for (const w of phase2Result.written) {
      if (!writtenSlugs.includes(w.slug)) {
        writtenSlugs.push(w.slug);
        applyResult.written.push(w);
      }
    }
    for (const r of phase2Result.rejected) applyResult.rejected.push(r);
    for (const w of phase2Result.written) {
      refreshClaimHashes(w.slug, getPageContentHash(w.slug));
    }
  }

  // Record (6.6, 6.7)
  const detectedPairs: DetectedPairRecord[] = allConflicts.map((c) => ({
    sourceClaimText: c.sourceClaim.text,
    storedClaimText: c.storedClaim.text,
    label: c.label,
    reasoning: c.reasoning,
    falsifier: c.falsifier,
    changeEvidence: c.changeEvidence,
  }));

  const rejectedPairRecords: RejectedPairRecord[] = allRejectedPairs.map((r) => ({
    sourceClaimText: r.sourceClaim.text,
    storedClaimText: r.storedClaim.text,
    originalLabel: r.originalLabel,
    demotedTo: r.demotedTo,
    reason: r.reason,
  }));

  const recordPath = writeIngestRecord({
    sourceOrigin: outcome.origin,
    sourceFilename: outcome.filename,
    candidates: retrieveResult.candidates,
    droppedCandidates: retrieveResult.dropped,
    newTopic: retrieveResult.newTopic,
    decisions: decideResult.decisions,
    pagesChanged: applyResult.written,
    rejectedEdits: applyResult.rejected,
    detectedPairs,
    comparisonPerformed,
    rejectedPairs: rejectedPairRecords,
  });

  return {
    sourceId: outcome.sourceId,
    pagesWritten: writtenSlugs,
    pagesCreated: applyResult.written
      .filter((w) => creates.some((d) => d.action === "create" && d.suggestedSlug === w.slug))
      .map((w) => w.slug),
    contradictions: contradictionIds,
    editsRejected: applyResult.rejected.length,
    recordPath,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function lookupClaimASource(
  db: ReturnType<typeof getDb>,
  claimId: number,
  fallbackDate: string
): { claimASlug: string; claimADate: string } {
  const row = db.prepare(
    "SELECT source_id, source_date FROM claims WHERE id = ?"
  ).get(claimId) as { source_id: number; source_date: string } | undefined;
  const sourceRow = row
    ? db.prepare("SELECT filename FROM sources WHERE id = ?").get(row.source_id) as { filename: string } | undefined
    : undefined;
  return {
    claimASlug: sourceRow?.filename?.replace(/\.txt$/, "") ?? "seed-corpus",
    claimADate: row?.source_date ?? fallbackDate,
  };
}

function buildCalloutEdit(
  db: ReturnType<typeof getDb>,
  storedClaimId: number,
  page: string,
  entry: ContradictionEntry
): Edit {
  const callout = formatContradictionCallout(entry);
  const anchorRow = db.prepare(
    "SELECT anchor FROM claims WHERE id = ?"
  ).get(storedClaimId) as { anchor: string } | undefined;
  return {
    page,
    anchor: "## " + (anchorRow?.anchor || "full-page"),
    insertion: callout,
  };
}
