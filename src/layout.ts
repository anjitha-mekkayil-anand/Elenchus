import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Returns the base directory for Elenchus data.
 * Currently the working directory — can be overridden later via env or config.
 */
export function getBaseDir(): string {
  return process.cwd();
}

/**
 * Ensures the on-disk layout exists:
 *   pages/    — markdown knowledge-base pages (NF-1)
 *   sources/  — immutable extracted source text (AC-1.4)
 *   ingests/  — one markdown record per ingest (AC-5.2)
 *   index.md  — title + summary per page, kept current (AC-4.4)
 *   contradictions.md — register of open and resolved contradictions (AC-9.4, NF-6)
 *
 * Safe to call multiple times; only creates what is missing.
 */
export function ensureLayout(): void {
  const base = getBaseDir();

  const dirs = ["pages", "sources", "ingests"];
  for (const dir of dirs) {
    const dirPath = resolve(base, dir);
    if (!existsSync(dirPath)) {
      mkdirSync(dirPath, { recursive: true });
    }
  }

  const indexPath = resolve(base, "index.md");
  if (!existsSync(indexPath)) {
    writeFileSync(
      indexPath,
      "# Index\n\n<!-- Auto-maintained by elenchus. One entry per page: title + summary. -->\n",
      "utf-8"
    );
  }

  // Contradictions register (AC-9.4, NF-6): open section first, resolved section after.
  // Idempotent: never overwrites an existing register.
  const contradictionsPath = resolve(base, "contradictions.md");
  if (!existsSync(contradictionsPath)) {
    writeFileSync(
      contradictionsPath,
      "# Contradictions\n\n" +
        "<!-- Register of detected contradictions. Maintained by elenchus. -->\n\n" +
        "## Open\n\n" +
        "<!-- Open contradictions appear here. -->\n\n" +
        "## Resolved\n\n" +
        "<!-- Resolved contradictions are moved here with their resolution. -->\n",
      "utf-8"
    );
  }
}
