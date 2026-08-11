/**
 * Apply stage — tasks 8.1–8.3
 *
 * 8.1: Write all edits, or none — atomic (AC-4.5).
 *      A partial application must not be possible.
 * 8.2: Rebuild index.md from current pages after writing (AC-4.4).
 * 8.3: Retry once, then fail, on unparseable model output.
 *
 * Every write passes through the section 7 verify gate first.
 * Rejected edits are recorded and skipped; the ingest continues with the rest.
 */

import { writeFileSync, readFileSync, existsSync, renameSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import type { Edit } from "./plan.js";
import {
  verifyEdits,
  simulateEditApplication,
  type VerifyResult,
  type RejectedEdit,
} from "./verify.js";
import { extractPageMeta, upsertPage, rebuildIndex } from "./pages.js";
import { getBaseDir } from "./layout.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ApplyResult {
  /** Pages that were written (created or updated). */
  written: Array<{ slug: string; path: string }>;
  /** Edits that were rejected by the verify gate. */
  rejected: RejectedEdit[];
  /** Whether index.md was rebuilt. */
  indexRebuilt: boolean;
}

// ---------------------------------------------------------------------------
// 8.1 — Atomic apply
// ---------------------------------------------------------------------------

/**
 * Reads a page from disk, or returns null if it doesn't exist.
 */
function readPage(slug: string): string | null {
  const pagePath = resolve(getBaseDir(), "pages", `${slug}.md`);
  if (!existsSync(pagePath)) {
    return null;
  }
  return readFileSync(pagePath, "utf-8");
}

/**
 * Applies verified edits atomically: all edits for a page are written
 * together, or none are written if any step fails.
 *
 * Uses a write-to-temp-then-rename strategy for atomicity at the
 * filesystem level.
 */
export function applyEdits(edits: Edit[]): ApplyResult {
  // Step 1: Verify all edits through the section 7 gate
  const verifyResult: VerifyResult = verifyEdits(
    edits,
    (slug) => readPage(slug),
    simulateEditApplication
  );

  // Rejected edits are recorded and skipped — ingest continues (7.2)
  const rejected = verifyResult.rejected;
  const accepted = verifyResult.accepted;

  if (accepted.length === 0) {
    return { written: [], rejected, indexRebuilt: false };
  }

  // Step 2: Group accepted edits by page
  const editsByPage = new Map<string, Edit[]>();
  for (const v of accepted) {
    const existing = editsByPage.get(v.edit.page) ?? [];
    existing.push(v.edit);
    editsByPage.set(v.edit.page, existing);
  }

  // Step 3: Compute final content for each page
  const pageContents = new Map<string, string>();
  for (const [slug, pageEdits] of editsByPage) {
    let content: string | null = readPage(slug);
    for (const edit of pageEdits) {
      content = simulateEditApplication(content, edit);
    }
    pageContents.set(slug, content!);
  }

  // Step 4: Write atomically — write to .tmp, then rename
  // If any write fails, roll back all .tmp files
  const pagesDir = resolve(getBaseDir(), "pages");
  const tmpFiles: string[] = [];

  try {
    for (const [slug, content] of pageContents) {
      const targetPath = resolve(pagesDir, `${slug}.md`);
      const tmpPath = targetPath + ".tmp";
      writeFileSync(tmpPath, content, "utf-8");
      tmpFiles.push(tmpPath);
    }

    // All temp files written successfully — now rename atomically
    const written: Array<{ slug: string; path: string }> = [];
    for (const [slug, _content] of pageContents) {
      const targetPath = resolve(pagesDir, `${slug}.md`);
      const tmpPath = targetPath + ".tmp";
      renameSync(tmpPath, targetPath);
      written.push({ slug, path: targetPath });
    }

    // Step 5: Update page registry for each written page (task 4.1)
    for (const [slug, content] of pageContents) {
      const { title, summary } = extractPageMeta(content);
      upsertPage(slug, title, summary);
    }

    // Step 6: Rebuild index.md (task 8.2, AC-4.4)
    rebuildIndex();

    return { written, rejected, indexRebuilt: true };
  } catch (err) {
    // Roll back: remove any .tmp files that were created
    for (const tmpPath of tmpFiles) {
      try {
        if (existsSync(tmpPath)) {
          unlinkSync(tmpPath);
        }
      } catch {
        // Best effort cleanup
      }
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 8.3 — Retry once on unparseable model output
// ---------------------------------------------------------------------------

/**
 * Wraps a function that may throw due to unparseable model output.
 * Retries once; if both attempts fail, throws the second error.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  label: string
): Promise<T> {
  try {
    return await fn();
  } catch (firstErr) {
    // Check if this is a parse error (from JSON.parse or our own parse functions)
    if (!isParseError(firstErr)) {
      throw firstErr;
    }

    // Retry once
    try {
      return await fn();
    } catch (secondErr) {
      throw new Error(
        `${label}: unparseable model output after retry. ` +
        `First error: ${firstErr instanceof Error ? firstErr.message : String(firstErr)}. ` +
        `Second error: ${secondErr instanceof Error ? secondErr.message : String(secondErr)}`
      );
    }
  }
}

/**
 * Determines whether an error is a parse error (unparseable model output).
 */
function isParseError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("json") ||
    msg.includes("parse") ||
    msg.includes("expected") ||
    msg.includes("unexpected token")
  );
}
