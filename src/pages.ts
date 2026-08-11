/**
 * Page registry — task 4.1
 *
 * Maintains title + one-line summary per page in SQLite (the `pages` table).
 * Keeps the registry current on every write to a page file.
 * Also rebuilds index.md from the registry.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, basename } from "node:path";
import { getBaseDir } from "./layout.js";
import { ensureSchema } from "./schema.js";

export interface PageEntry {
  slug: string;
  title: string;
  summary: string;
}

/**
 * Reads a page's markdown file and extracts its title (first # heading)
 * and summary (first non-empty paragraph after the title).
 */
export function extractPageMeta(content: string): { title: string; summary: string } {
  const lines = content.split("\n");

  let title = "";
  let summary = "";
  let pastTitle = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Title: first heading
    if (!title && trimmed.startsWith("# ")) {
      title = trimmed.slice(2).trim();
      pastTitle = true;
      continue;
    }

    // Summary: first non-empty, non-heading line after the title
    if (pastTitle && !summary && trimmed.length > 0 && !trimmed.startsWith("#")) {
      summary = trimmed;
      break;
    }
  }

  return { title: title || "Untitled", summary };
}

/**
 * Registers or updates a page in the SQLite registry.
 * Call this after writing a page file to keep the registry current.
 */
export function upsertPage(slug: string, title: string, summary: string): void {
  const db = ensureSchema();

  const existing = db.prepare("SELECT id FROM pages WHERE slug = ?").get(slug) as
    | { id: number }
    | undefined;

  if (existing) {
    db.prepare(
      "UPDATE pages SET title = ?, summary = ?, updated_at = datetime('now') WHERE slug = ?"
    ).run(title, summary, slug);
  } else {
    db.prepare("INSERT INTO pages (slug, title, summary) VALUES (?, ?, ?)").run(
      slug,
      title,
      summary
    );
  }
}

/**
 * Returns all pages in the registry, ordered by slug.
 */
export function listPages(): PageEntry[] {
  const db = ensureSchema();
  return db
    .prepare("SELECT slug, title, summary FROM pages ORDER BY slug")
    .all() as PageEntry[];
}

/**
 * Syncs the page registry from disk — reads all .md files in pages/,
 * extracts metadata, and upserts into the registry.
 */
export function syncPagesFromDisk(): void {
  const pagesDir = resolve(getBaseDir(), "pages");
  if (!existsSync(pagesDir)) return;

  const files = readdirSync(pagesDir).filter((f) => f.endsWith(".md"));

  for (const file of files) {
    const slug = basename(file, ".md");
    const content = readFileSync(resolve(pagesDir, file), "utf-8");
    const { title, summary } = extractPageMeta(content);
    upsertPage(slug, title, summary);
  }
}

/**
 * Rebuilds index.md from the current page registry.
 */
export function rebuildIndex(): void {
  const pages = listPages();
  const base = getBaseDir();

  let content = "# Index\n\n<!-- Auto-maintained by elenchus. One entry per page: title + summary. -->\n\n";

  for (const page of pages) {
    content += `- **${page.title}** — ${page.summary || "(no summary)"}\n`;
  }

  writeFileSync(resolve(base, "index.md"), content, "utf-8");
}

/**
 * Formats the index for sending to the model during retrieval.
 * Returns the list of pages as a structured text block.
 */
export function formatIndexForModel(): string {
  const pages = listPages();

  if (pages.length === 0) {
    return "(no pages exist yet)";
  }

  return pages
    .map((p) => `- [${p.slug}] ${p.title}: ${p.summary || "(no summary)"}`)
    .join("\n");
}
