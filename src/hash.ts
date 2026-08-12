/**
 * Content hashing — single source of truth for page content hashes.
 *
 * Used by:
 *   - Task 3.1 (staleness check): hash the current file, compare to stored hash.
 *   - Task 6.5 (persist page claims): hash the file as written, store alongside claims.
 *
 * The hash is computed on the file's raw bytes exactly as they are on disk:
 * no trimming, no line-ending normalisation, no trailing-newline handling.
 * Whatever Apply writes is what gets hashed.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * Computes a SHA-256 hash of the given content buffer or string.
 * Returns the full hex digest.
 */
export function contentHash(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Reads a file from disk and returns its content hash.
 * Hashes the raw bytes — no normalisation.
 */
export function contentHashOfFile(filePath: string): string {
  const bytes = readFileSync(filePath);
  return contentHash(bytes);
}
