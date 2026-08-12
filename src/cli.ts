#!/usr/bin/env node
import { resolve } from "node:path";
import { Command } from "commander";
import { ensureLayout, getBaseDir } from "./layout.js";
import { ensureSchema } from "./schema.js";
import { syncPagesFromDisk, rebuildIndex } from "./pages.js";
import { AnthropicClient } from "./model/anthropic.js";
import { RecordingClient } from "./model/recording.js";
import { resolveContradiction } from "./resolve.js";
import { runIngest } from "./ingest.js";

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
    ensureLayout();
    ensureSchema();

    const fixturesDir = resolve(getBaseDir(), "fixtures");
    const anthropic = new AnthropicClient();
    const model = new RecordingClient(anthropic, fixturesDir);

    try {
      const result = await runIngest(pathOrUrl, { force: opts.force }, model);

      console.log("");
      console.log("── Summary ──");
      console.log(`  Pages written:  ${result.pagesWritten.length}`);
      console.log(`  Pages created:  ${result.pagesCreated.length}`);
      console.log(`  Contradictions: ${result.contradictions.length}`);
      console.log(`  Edits rejected: ${result.editsRejected}`);
      console.log(`  Record:         ${result.recordPath}`);
    } catch (err) {
      console.error(`[elenchus] ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
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
