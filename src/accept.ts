/**
 * Accept stage — tasks 2.1–2.5
 *
 * Reads a source (file path or URL), validates it, hashes it for
 * idempotency, persists the raw text to sources/, and records it in SQLite.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, basename, extname } from "node:path";
import { getBaseDir } from "./layout.js";
import { ensureSchema } from "./schema.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AcceptResult {
  sourceId: number;
  hash: string;
  filename: string;
  origin: string;
  byteLength: number;
  alreadyIngested: boolean;
  forced: boolean;
}

export interface RejectionResult {
  rejected: true;
  reason: string;
}

export type AcceptOutcome = AcceptResult | RejectionResult;

export function isRejection(outcome: AcceptOutcome): outcome is RejectionResult {
  return "rejected" in outcome && outcome.rejected === true;
}

// ---------------------------------------------------------------------------
// 2.1 — Read plain text / markdown from a path (AC-1.1)
// ---------------------------------------------------------------------------

/**
 * Reads text content from a local file path.
 * Supports .txt, .md, and extensionless files (treated as plain text).
 */
export function readSourceFromPath(filePath: string): string {
  const resolved = resolve(filePath);

  if (!existsSync(resolved)) {
    throw new Error(`Source file not found: ${resolved}`);
  }

  const content = readFileSync(resolved, "utf-8");
  return content;
}

// ---------------------------------------------------------------------------
// 2.2 — Fetch a URL and extract readable text (AC-1.2)
// ---------------------------------------------------------------------------

/**
 * Fetches a URL and extracts its readable text content.
 * For HTML responses, strips tags to extract text.
 * For text/* responses, returns content as-is.
 */
export async function readSourceFromUrl(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Elenchus/0.1.0 (knowledge-base ingest)",
      Accept: "text/html, text/plain, text/markdown, */*",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch URL: ${url} — HTTP ${response.status} ${response.statusText}`
    );
  }

  const contentType = response.headers.get("content-type") ?? "";
  const body = await response.text();

  // If HTML, do a basic extraction of text content
  if (contentType.includes("text/html")) {
    return extractTextFromHtml(body);
  }

  // For text/plain, text/markdown, etc. — return as-is
  return body;
}

/**
 * Basic HTML-to-text extraction.
 * Strips script/style blocks, tags, collapses whitespace.
 */
export function extractTextFromHtml(html: string): string {
  let text = html;

  // Remove script and style blocks entirely
  text = text.replace(/<script[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, "");

  // Replace block-level elements with newlines
  text = text.replace(/<\/(p|div|h[1-6]|li|tr|blockquote|pre|article|section)>/gi, "\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<hr\s*\/?>/gi, "\n---\n");

  // Remove all remaining tags
  text = text.replace(/<[^>]+>/g, "");

  // Decode common HTML entities
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)))
    .replace(/&\w+;/g, ""); // remaining named entities → remove

  // Collapse whitespace: multiple spaces → one, preserve newlines
  text = text.replace(/[^\S\n]+/g, " ");
  // Collapse multiple blank lines into at most two newlines
  text = text.replace(/\n{3,}/g, "\n\n");

  return text.trim();
}

// ---------------------------------------------------------------------------
// 2.3 — Reject empty / no-extractable-text (AC-1.3)
// ---------------------------------------------------------------------------

/**
 * Validates that extracted text is non-empty and has meaningful content.
 * Returns null if valid, or a rejection reason string if not.
 */
export function validateContent(text: string): string | null {
  if (text.length === 0) {
    return "Source is empty — contains no text at all.";
  }

  // Strip whitespace and check if anything remains
  const stripped = text.replace(/\s+/g, "").trim();
  if (stripped.length === 0) {
    return "Source contains only whitespace — no extractable text.";
  }

  // Minimum meaningful content threshold (at least a short sentence)
  if (stripped.length < 10) {
    return `Source too short to be meaningful (${stripped.length} non-whitespace characters). Minimum is 10.`;
  }

  return null; // valid
}

// ---------------------------------------------------------------------------
// 2.5 — Content hash for duplicate detection (AC-6.1, AC-6.2)
// ---------------------------------------------------------------------------

/**
 * Computes the SHA-256 hash of the extracted text content.
 * Used as the stable source identifier for idempotency.
 */
export function hashContent(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

/**
 * Checks whether a source with this hash has already been ingested.
 * Returns the existing source ID if found, null otherwise.
 */
export function findExistingSource(hash: string): number | null {
  const db = ensureSchema();
  const row = db
    .prepare("SELECT id FROM sources WHERE hash = ?")
    .get(hash) as { id: number } | undefined;
  return row?.id ?? null;
}

// ---------------------------------------------------------------------------
// 2.4 — Persist raw extracted text to sources/, write-once (AC-1.4)
// ---------------------------------------------------------------------------

/**
 * Persists the raw extracted text to sources/<hash-prefix>-<slug>.<ext>.
 * Write-once: if the file already exists, it is not overwritten.
 * Returns the filename (relative to sources/).
 */
export function persistSource(
  text: string,
  hash: string,
  origin: string
): string {
  const base = getBaseDir();
  const sourcesDir = resolve(base, "sources");

  // Build a meaningful filename from the origin
  const slug = slugifyOrigin(origin);
  const prefix = hash.slice(0, 8);
  const filename = `${prefix}-${slug}.txt`;
  const filePath = resolve(sourcesDir, filename);

  // Write-once: do not overwrite if already exists (AC-1.4)
  if (!existsSync(filePath)) {
    writeFileSync(filePath, text, "utf-8");
  }

  return filename;
}

/**
 * Produces a short, filesystem-safe slug from an origin path or URL.
 */
function slugifyOrigin(origin: string): string {
  // For URLs, use the last path segment or hostname
  let name: string;
  try {
    const url = new URL(origin);
    const pathParts = url.pathname.split("/").filter(Boolean);
    name = pathParts.length > 0
      ? pathParts[pathParts.length - 1]
      : url.hostname;
  } catch {
    // Not a URL — use the basename
    name = basename(origin);
  }

  // Remove extension
  const ext = extname(name);
  if (ext) {
    name = name.slice(0, -ext.length);
  }

  // Slugify: lowercase, replace non-alnum with hyphens, collapse, trim
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "source";
}

// ---------------------------------------------------------------------------
// Top-level accept orchestrator
// ---------------------------------------------------------------------------

/**
 * The full accept pipeline:
 * 1. Read from path or URL (2.1, 2.2)
 * 2. Validate content (2.3)
 * 3. Hash for idempotency (2.5)
 * 4. Check for duplicates (2.5)
 * 5. Persist to sources/ (2.4)
 * 6. Record in SQLite
 *
 * Returns either an AcceptResult or a RejectionResult.
 */
export async function acceptSource(
  pathOrUrl: string,
  opts: { force?: boolean } = {}
): Promise<AcceptOutcome> {
  // Step 1: Read from path or URL
  let text: string;
  const isUrl = /^https?:\/\//i.test(pathOrUrl);

  if (isUrl) {
    try {
      text = await readSourceFromUrl(pathOrUrl);
    } catch (err) {
      return {
        rejected: true,
        reason: `URL fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  } else {
    try {
      text = readSourceFromPath(pathOrUrl);
    } catch (err) {
      return {
        rejected: true,
        reason: `File read failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // Step 2: Validate content (AC-1.3)
  const rejectionReason = validateContent(text);
  if (rejectionReason !== null) {
    return { rejected: true, reason: rejectionReason };
  }

  // Step 3: Hash for idempotency (AC-6.1)
  const hash = hashContent(text);

  // Step 4: Check for duplicates
  const existingId = findExistingSource(hash);
  if (existingId !== null && !opts.force) {
    return {
      sourceId: existingId,
      hash,
      filename: "",
      origin: pathOrUrl,
      byteLength: Buffer.byteLength(text, "utf-8"),
      alreadyIngested: true,
      forced: false,
    };
  }

  // Step 5: Persist to sources/ (AC-1.4)
  const filename = persistSource(text, hash, pathOrUrl);
  const byteLength = Buffer.byteLength(text, "utf-8");

  // Step 6: Record in SQLite
  const db = ensureSchema();

  if (existingId !== null && opts.force) {
    // Forced re-ingest: source row already exists, just return it (AC-6.2)
    return {
      sourceId: existingId,
      hash,
      filename,
      origin: pathOrUrl,
      byteLength,
      alreadyIngested: true,
      forced: true,
    };
  }

  // New source: insert into DB
  const result = db
    .prepare(
      "INSERT INTO sources (hash, filename, origin, byte_length) VALUES (?, ?, ?, ?)"
    )
    .run(hash, filename, pathOrUrl, byteLength);

  return {
    sourceId: Number(result.lastInsertRowid),
    hash,
    filename,
    origin: pathOrUrl,
    byteLength,
    alreadyIngested: false,
    forced: false,
  };
}
