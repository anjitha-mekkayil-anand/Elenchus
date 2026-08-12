#!/usr/bin/env node
import { resolve } from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { Command } from "commander";
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
import { AnthropicClient } from "./model/anthropic.js";
import { RecordingClient } from "./model/recording.js";
import { resolveContradiction } from "./resolve.js";
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
import { contentHash } from "./hash.js";

const program = new Command();

program
  .name("elenchus")
  .description("A knowledge base that integrates rather than stores.")
  .version("0.1.0");

program
  .command("ingest <pathOrUrl>")
  .description("Ingest a source (local file path or URL) into the knowledge base.")
  .option("--force", "Force re-ingest even if source was already processed")
  .action(async (pathOrUrl: string, opts: { force?: boolean }) => {
    // Ensure on-disk layout and schema exist before any operation
    ensureLayout();
    ensureSchema();

    // -----------------------------------------------------------------------
    // Accept
    // -----------------------------------------------------------------------
    const outcome = await acceptSource(pathOrUrl, { force: opts.force });

    if (isRejection(outcome)) {
      console.error(`[elenchus] rejected: ${outcome.reason}`);
      process.exit(1);
    }

    if (outcome.alreadyIngested && !outcome.forced) {
      console.log(
        `[elenchus] already ingested (source #${outcome.sourceId}, hash ${outcome.hash.slice(0, 8)}…). ` +
        `Use --force to re-ingest.`
      );
      process.exit(0);
    }

    console.log(
      `[elenchus] accepted source #${outcome.sourceId} (${outcome.byteLength} bytes)`
    );

    // Read the persisted source text for downstream stages
    const sourceTextPath = resolve(getBaseDir(), "sources", outcome.filename);
    const sourceText = readFileSync(sourceTextPath, "utf-8");

    // Build model client: AnthropicClient wrapped in RecordingClient (task 3.2)
    const fixturesDir = resolve(getBaseDir(), "fixtures");
    const anthropic = new AnthropicClient();
    const model = new RecordingClient(anthropic, fixturesDir);

    // Sync pages from disk so retrieve has the current index
    syncPagesFromDisk();

    // -----------------------------------------------------------------------
    // Retrieve
    // -----------------------------------------------------------------------
    console.log("[elenchus] retrieving candidates…");
    const retrieveResult = await withRetry(
      () => retrieve(sourceText, model),
      "retrieve"
    );

    if (retrieveResult.dropped.length > 0) {
      console.log(
        `[elenchus] dropped ${retrieveResult.dropped.length} hallucinated candidate(s)`
      );
    }

    if (retrieveResult.newTopic) {
      console.log("[elenchus] new topic — no existing pages matched.");
    } else {
      console.log(
        `[elenchus] ${retrieveResult.candidates.length} candidate(s) retrieved`
      );
    }

    // -----------------------------------------------------------------------
    // Decide
    // -----------------------------------------------------------------------
    console.log("[elenchus] deciding…");
    const decideResult = await withRetry(
      () => decide(sourceText, retrieveResult.candidates, model),
      "decide"
    );

    const weaves = decideResult.decisions.filter((d) => d.action === "weave");
    const creates = decideResult.decisions.filter((d) => d.action === "create");
    const skips = decideResult.decisions.filter((d) => d.action === "skip");
    console.log(
      `[elenchus] decisions: ${weaves.length} weave, ${creates.length} create, ${skips.length} skip`
    );

    // -----------------------------------------------------------------------
    // Extract source claims (6.1) — unbound, for comparison
    // -----------------------------------------------------------------------
    console.log("[elenchus] extracting source claims…");
    const sourceDate = new Date().toISOString().slice(0, 10);
    const sourceClaims = await withRetry(
      () => extractClaims(sourceText, outcome.filename, sourceDate, model),
      "extract"
    );
    console.log(`[elenchus] ${sourceClaims.length} source claim(s) extracted`);

    // -----------------------------------------------------------------------
    // Compare source claims against stored page claims (6.2)
    // Bounded to pages this ingest is writing to (NF-5).
    // -----------------------------------------------------------------------
    const targetSlugs = weaves.map((d) => d.slug);
    let allConflicts: ClassifiedPair[] = [];
    let allRejectedPairs: RejectedPair[] = [];
    let comparisonPerformed = false;

    if (targetSlugs.length > 0 && sourceClaims.length > 0) {
      console.log("[elenchus] comparing claims…");
      comparisonPerformed = true;

      // Gather stored claims for target pages, handling staleness/AC-7.7
      const storedClaims: StoredClaimForCompare[] = [];
      const seedSourceId = getSeedSourceId();

      for (const slug of targetSlugs) {
        const result = await ensurePageClaims(slug, seedSourceId, sourceDate, model);
        for (const c of result.claims) {
          storedClaims.push({
            id: c.id,
            text: c.text,
            page: c.page,
            source_date: c.source_date,
          });
        }
      }

      if (storedClaims.length > 0) {
        const compareResult = await withRetry(
          () => compareClaims(sourceClaims, storedClaims, sourceText, model),
          "compare"
        );
        allConflicts = compareResult.conflicts;
        allRejectedPairs = compareResult.rejected;
        console.log(
          `[elenchus] ${allConflicts.length} conflict(s) detected, ${allRejectedPairs.length} demoted`
        );
      } else {
        console.log("[elenchus] no stored claims to compare against");
      }
    }

    // -----------------------------------------------------------------------
    // Plan phase 1 — weave edits only (anchors now known)
    // -----------------------------------------------------------------------
    console.log("[elenchus] planning edits…");
    const planResult = await withRetry(
      () => plan(decideResult.decisions, sourceText, outcome.origin, model),
      "plan"
    );

    // Determine which pages each source claim lands on (from weave decisions)
    // For simplicity: all source claims are bound to ALL weave target pages.
    // The weave edit's anchor provides the placement.
    const weaveAnchors = new Map<string, string>(); // slug → first anchor used
    for (const edit of planResult.edits) {
      if (edit.anchor !== "(new page)" && !weaveAnchors.has(edit.page)) {
        weaveAnchors.set(edit.page, edit.anchor);
      }
    }

    // -----------------------------------------------------------------------
    // Cache pre-Apply page content for rollback (6.8)
    // -----------------------------------------------------------------------
    const pagesDir = resolve(getBaseDir(), "pages");
    const preApplyContent = new Map<string, string | null>();
    const allTargetPages = new Set<string>();
    for (const edit of planResult.edits) {
      allTargetPages.add(edit.page);
    }
    // Also include pages that will get callouts/annotations
    for (const conflict of allConflicts) {
      allTargetPages.add(conflict.storedClaim.page);
    }
    for (const slug of allTargetPages) {
      const pagePath = resolve(pagesDir, `${slug}.md`);
      if (existsSync(pagePath)) {
        preApplyContent.set(slug, readFileSync(pagePath, "utf-8"));
      } else {
        preApplyContent.set(slug, null);
      }
    }

    // -----------------------------------------------------------------------
    // Plan phase 2 — contradiction callouts and supersession annotations
    // These need DB ids, so we do: insert claims → insert contradiction rows
    // → get CD-NNN ids → build callout/annotation edits.
    //
    // But we need Apply to run first so the page exists with source material.
    // The two-phase approach: Apply weave edits first, then insert claims
    // and conflict rows in a transaction, then apply callout/annotation edits.
    // -----------------------------------------------------------------------

    // -----------------------------------------------------------------------
    // Verify + Apply (phase 1: weave edits)
    // -----------------------------------------------------------------------
    console.log("[elenchus] verifying and applying weave edits…");
    const applyResult = applyEdits(planResult.edits);
    console.log(`[elenchus] ${applyResult.written.length} page(s) written, ${applyResult.rejected.length} rejected`);

    // -----------------------------------------------------------------------
    // Transaction: insert source claims as page claims, insert conflict rows,
    // build and apply callout/annotation edits, refresh hashes.
    // On failure: roll back DB + restore files from preApplyContent.
    // -----------------------------------------------------------------------
    const db = getDb();
    const writtenSlugs = applyResult.written.map((w) => w.slug);
    const contradictionIds: string[] = [];
    const phase2Edits: Edit[] = [];

    try {
      db.exec("BEGIN TRANSACTION");

      // 6.5: Insert ALL source claims as page claims (not just conflicting ones).
      // A non-conflicting claim was still woven into the page, and if it never
      // becomes a page claim then a future source contradicting it finds nothing.
      const claimIdsByText = new Map<string, number>(); // claim text → claims.id

      for (const slug of writtenSlugs) {
        const hash = getPageContentHash(slug);
        const anchor = weaveAnchors.get(slug) ?? "full-page";

        const ids = insertSourceClaimsAsPageClaims(
          slug, sourceClaims, outcome.sourceId, sourceDate, anchor, hash
        );

        // Map claim text → id for contradiction row insertion
        for (let i = 0; i < sourceClaims.length; i++) {
          claimIdsByText.set(sourceClaims[i].text, ids[i]);
        }

        // Refresh hashes on ALL active claims for this page (existing ones too).
        // The page grew — existing claims' hashes would mismatch otherwise.
        refreshClaimHashes(slug, hash);
      }

      // 6.4: Insert contradiction and supersession rows, build page edits
      for (const conflict of allConflicts) {
        const claimBId = claimIdsByText.get(conflict.sourceClaim.text);
        if (!claimBId) {
          // Source claim was not persisted (page not in writtenSlugs). Fail the ingest.
          throw new Error(
            `Cannot persist conflict: source claim "${conflict.sourceClaim.text}" ` +
            `was not inserted as a page claim. This means the source material was ` +
            `not woven into any written page.`
          );
        }

        const insertResult = db.prepare(
          "INSERT INTO contradictions (claim_a, claim_b, kind, reasoning) VALUES (?, ?, ?, ?)"
        ).run(conflict.storedClaim.id, claimBId, conflict.label, conflict.reasoning);

        if (conflict.label === "contradiction") {
          const cdId = formatContradictionId(Number(insertResult.lastInsertRowid));
          contradictionIds.push(cdId);

          // Look up claim A's actual source info from the DB
          const claimARow = db.prepare(
            "SELECT source_id, source_date FROM claims WHERE id = ?"
          ).get(conflict.storedClaim.id) as { source_id: number; source_date: string } | undefined;

          const claimASourceRow = claimARow
            ? db.prepare("SELECT filename FROM sources WHERE id = ?").get(claimARow.source_id) as { filename: string } | undefined
            : undefined;

          const claimASlug = claimASourceRow?.filename?.replace(/\.txt$/, "") ?? "seed-corpus";
          const claimADate = claimARow?.source_date ?? conflict.storedClaim.source_date;

          const sourceSlug = outcome.filename.replace(/\.txt$/, "");

          const entry: ContradictionEntry = {
            id: cdId,
            claimA: {
              text: conflict.storedClaim.text,
              sourceSlug: claimASlug,
              sourceDate: claimADate,
            },
            claimB: {
              text: conflict.sourceClaim.text,
              sourceSlug: sourceSlug,
              sourceDate: sourceDate,
            },
            reasoning: conflict.reasoning,
          };

          // Write to register
          addToRegister(entry);

          // Build callout edit for the page (AC-9.5: visible on the page itself)
          const callout = formatContradictionCallout(entry);
          const claimAAnchorRow = db.prepare(
            "SELECT anchor FROM claims WHERE id = ?"
          ).get(conflict.storedClaim.id) as { anchor: string } | undefined;
          const calloutAnchor = claimAAnchorRow?.anchor || "full-page";
          phase2Edits.push({
            page: conflict.storedClaim.page,
            anchor: "## " + calloutAnchor,
            insertion: callout,
          });

        } else if (conflict.label === "supersession") {
          // Build supersession annotation for the page (AC-9.3)
          const sourceSlug = outcome.filename.replace(/\.txt$/, "");
          const annotation = formatSupersessionAnnotation({
            existingClaimText: conflict.storedClaim.text,
            supersessionDate: sourceDate,
            sourceSlug: sourceSlug,
          });

          // Place at the end of the stored claim's anchor section
          const storedAnchorRow = db.prepare(
            "SELECT anchor FROM claims WHERE id = ?"
          ).get(conflict.storedClaim.id) as { anchor: string } | undefined;
          const supersessionAnchor = storedAnchorRow?.anchor || "full-page";

          phase2Edits.push({
            page: conflict.storedClaim.page,
            anchor: "## " + supersessionAnchor,
            insertion: annotation,
          });
        }
      }

      db.exec("COMMIT");
    } catch (err) {
      // Roll back DB
      try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }

      // Roll back file writes — restore from cached originals
      for (const [slug, original] of preApplyContent) {
        const pagePath = resolve(pagesDir, `${slug}.md`);
        try {
          if (original === null) {
            // Page did not exist before — delete it
            if (existsSync(pagePath)) {
              const { unlinkSync } = await import("node:fs");
              unlinkSync(pagePath);
            }
          } else {
            // Restore original content
            writeFileSync(pagePath, original, "utf-8");
          }
        } catch { /* best effort */ }
      }

      // Rebuild index from restored state
      syncPagesFromDisk();
      rebuildIndex();

      throw new Error(
        `[elenchus] post-Apply transaction failed — files and DB rolled back. ` +
        `Cause: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // -----------------------------------------------------------------------
    // Apply phase 2 — callout and annotation edits (through verify gate)
    // -----------------------------------------------------------------------
    if (phase2Edits.length > 0) {
      console.log(`[elenchus] applying ${phase2Edits.length} callout/annotation edit(s)…`);
      const phase2Result = applyEdits(phase2Edits);
      // Merge written pages
      for (const w of phase2Result.written) {
        if (!writtenSlugs.includes(w.slug)) {
          writtenSlugs.push(w.slug);
          applyResult.written.push(w);
        }
      }
      for (const r of phase2Result.rejected) {
        applyResult.rejected.push(r);
      }

      // After phase 2, refresh hashes again (pages grew with callouts/annotations)
      for (const w of phase2Result.written) {
        const hash = getPageContentHash(w.slug);
        refreshClaimHashes(w.slug, hash);
      }
    }

    // -----------------------------------------------------------------------
    // Record (6.6, 6.7)
    // -----------------------------------------------------------------------
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

    // -----------------------------------------------------------------------
    // Summary
    // -----------------------------------------------------------------------
    const pagesWoven = applyResult.written.filter((w) =>
      weaves.some((d) => d.action === "weave" && d.slug === w.slug)
    ).length;
    const pagesCreated = applyResult.written.filter((w) =>
      creates.some((d) => d.action === "create" && d.suggestedSlug === w.slug)
    ).length;

    console.log("");
    console.log("── Summary ──");
    console.log(`  Pages woven:    ${pagesWoven}`);
    console.log(`  Pages created:  ${pagesCreated}`);
    console.log(`  Contradictions: ${contradictionIds.length}`);
    console.log(`  Edits rejected: ${applyResult.rejected.length}`);
    console.log(`  Record:         ${recordPath}`);
  });

program
  .command("index")
  .description("Rebuild index.md from current pages.")
  .action(() => {
    ensureLayout();
    ensureSchema();

    syncPagesFromDisk();
    rebuildIndex();
    console.log("[elenchus] index.md rebuilt from current pages.");
  });

program
  .command("resolve <id>")
  .description("Resolve an open contradiction.")
  .requiredOption("--keep <side>", "Which claim to keep: A or B")
  .requiredOption("--reason <reason>", "Stated reason for the resolution")
  .action((id: string, opts: { keep: string; reason: string }) => {
    ensureLayout();
    ensureSchema();

    const outcome = resolveContradiction(id, opts.keep, opts.reason);

    if (!outcome.success) {
      console.error(`[elenchus] resolve failed: ${outcome.reason}`);
      process.exit(1);
    }

    console.log(
      `[elenchus] resolved ${outcome.id} — kept ${outcome.kept}.\n` +
      `  Reason: ${outcome.reason}`
    );
  });

program.parse();
