#!/usr/bin/env node
import { Command } from "commander";
import { ensureLayout } from "./layout.js";
import { ensureSchema } from "./schema.js";

const program = new Command();

program
  .name("elenchus")
  .description("A knowledge base that integrates rather than stores.")
  .version("0.1.0");

program
  .command("ingest <pathOrUrl>")
  .description("Ingest a source (local file path or URL) into the knowledge base.")
  .option("--force", "Force re-ingest even if source was already processed")
  .action((pathOrUrl: string, opts: { force?: boolean }) => {
    // Ensure on-disk layout and schema exist before any operation
    ensureLayout();
    ensureSchema();

    console.error(
      `[elenchus] ingest: not yet implemented.\n` +
      `  source: ${pathOrUrl}\n` +
      `  force:  ${opts.force ?? false}\n` +
      `  → This is a stub. Implementation arrives in tasks 2.x.`
    );
    process.exit(1);
  });

program
  .command("index")
  .description("Rebuild index.md from current pages.")
  .action(() => {
    // Ensure on-disk layout and schema exist before any operation
    ensureLayout();
    ensureSchema();

    console.error(
      `[elenchus] index: not yet implemented.\n` +
      `  → This is a stub. Implementation arrives in task 8.2.`
    );
    process.exit(1);
  });

program.parse();
