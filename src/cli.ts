#!/usr/bin/env node
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { Command } from "commander";
import { ensureLayout, getBaseDir } from "./layout.js";
import { ensureSchema } from "./schema.js";
import { acceptSource, isRejection } from "./accept.js";
import { syncPagesFromDisk, rebuildIndex } from "./pages.js";
import { retrieve } from "./retrieve.js";
import { decide } from "./decide.js";
import { plan } from "./plan.js";
import { applyEdits, withRetry } from "./apply.js";
import { writeIngestRecord } from "./record.js";
import { AnthropicClient } from "./model/anthropic.js";
import { RecordingClient } from "./model/recording.js";
import { resolveContradiction } from "./resolve.js";

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
    // Plan
    // -----------------------------------------------------------------------
    console.log("[elenchus] planning edits…");
    const planResult = await withRetry(
      () => plan(decideResult.decisions, sourceText, outcome.origin, model),
      "plan"
    );

    console.log(`[elenchus] ${planResult.edits.length} edit(s) planned`);

    // -----------------------------------------------------------------------
    // Verify + Apply
    // -----------------------------------------------------------------------
    console.log("[elenchus] verifying and applying…");
    const applyResult = applyEdits(planResult.edits);

    // -----------------------------------------------------------------------
    // Record
    // -----------------------------------------------------------------------
    const recordPath = writeIngestRecord({
      sourceOrigin: outcome.origin,
      sourceFilename: outcome.filename,
      candidates: retrieveResult.candidates,
      droppedCandidates: retrieveResult.dropped,
      newTopic: retrieveResult.newTopic,
      decisions: decideResult.decisions,
      pagesChanged: applyResult.written,
      rejectedEdits: applyResult.rejected,
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
    console.log(`  Edits rejected: ${applyResult.rejected.length}`);
    console.log(`  Record:         ${recordPath}`);
  });

program
  .command("index")
  .description("Rebuild index.md from current pages.")
  .action(() => {
    // Ensure on-disk layout and schema exist before any operation
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
