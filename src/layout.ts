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
}
