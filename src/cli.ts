#!/usr/bin/env node
import { Command } from "commander";
import { ensureLayout } from "./layout.js";
import { ensureSchema } from "./schema.js";
import { acceptSource, isRejection } from "./accept.js";
import { syncPagesFromDisk, rebuildIndex } from "./pages.js";

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

    if (outcome.forced) {
      console.log(
        `[elenchus] forced re-ingest of source #${outcome.sourceId} (hash ${outcome.hash.slice(0, 8)}…).`
      );
    } else {
      console.log(
        `[elenchus] accepted source #${outcome.sourceId}\n` +
        `  origin:   ${outcome.origin}\n` +
        `  file:     sources/${outcome.filename}\n` +
        `  hash:     ${outcome.hash.slice(0, 8)}…\n` +
        `  size:     ${outcome.byteLength} bytes`
      );
    }

    // TODO: sections 3–9 (retrieve, decide, plan, verify, apply, record)
    console.log(`[elenchus] accept complete. Remaining stages not yet implemented.`);
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

program.parse();
