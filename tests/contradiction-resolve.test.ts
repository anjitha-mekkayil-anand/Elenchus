/**
 * Unit tests for contradiction detection spec 2, section 7 — resolution.
 *
 * - 7.2: Callout rewritten to resolved, both claims retained
 * - 7.3: Register entry moved from Open to Resolved
 * - 7.5: Reject on unknown id, already resolved, invalid --keep
 * - 7.6: Resolve keeps rejected claim on page (AC-10.3)
 * - 7.7: Resolve unknown id → rejected, nothing changed
 * - Narrow check: both claim texts appear in post-resolution content
 * - Register preservation: moving entry does not lose others
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureLayout } from "../src/layout.js";
import { ensureSchema, _resetDb } from "../src/schema.js";
import { resolveContradiction, rewriteCalloutToResolved, moveToResolved } from "../src/resolve.js";
import { formatContradictionCallout, addToRegister, type ContradictionEntry } from "../src/contradict.js";

// ---------------------------------------------------------------------------
// Helper: set up a full contradiction scenario
// ---------------------------------------------------------------------------

function seedContradiction(tmpDir: string): { cdId: string; pageSlug: string; entry: ContradictionEntry } {
  const db = ensureSchema();

  // Insert a source
  db.prepare(
    "INSERT INTO sources (hash, filename, origin, byte_length) VALUES (?, ?, ?, ?)"
  ).run("abc123", "test-src.txt", "/test.md", 100);

  // Insert two claims
  db.prepare(
    "INSERT INTO claims (page, anchor, text, source_id, source_date, content_hash) VALUES (?, ?, ?, ?, ?, ?)"
  ).run("food-safety", "## Temperature", "Danger zone is 4–60 °C.", 1, "2026-01-01", "hash1");
  db.prepare(
    "INSERT INTO claims (page, anchor, text, source_id, source_date, content_hash) VALUES (?, ?, ?, ?, ?, ?)"
  ).run("food-safety", "## Temperature", "Danger zone is 5–57 °C.", 1, "2026-08-10", "hash2");

  // Insert a contradiction row
  db.prepare(
    "INSERT INTO contradictions (claim_a, claim_b, kind, reasoning, status) VALUES (?, ?, ?, ?, ?)"
  ).run(1, 2, "contradiction", "Different thresholds stated as absolute.", "open");

  const entry: ContradictionEntry = {
    id: "CD-001",
    claimA: { text: "Danger zone is 4–60 °C.", sourceSlug: "textbook", sourceDate: "2026-01-01" },
    claimB: { text: "Danger zone is 5–57 °C.", sourceSlug: "new-source", sourceDate: "2026-08-10" },
    reasoning: "Different thresholds stated as absolute.",
  };

  // Write the callout on the page
  const pagesDir = join(tmpDir, "pages");
  const callout = formatContradictionCallout(entry);
  const pageContent = `# Food Safety\n\n## Temperature\n\nBacteria multiply rapidly.\n\n${callout}\n`;
  writeFileSync(join(pagesDir, "food-safety.md"), pageContent, "utf-8");

  // Write the register entry
  addToRegister(entry);

  return { cdId: "CD-001", pageSlug: "food-safety", entry };
}

// ---------------------------------------------------------------------------
// 7.2 — Callout rewritten to resolved (pure function tests)
// ---------------------------------------------------------------------------

describe("rewriteCalloutToResolved (task 7.2)", () => {
  it("changes [!warning] to [!note] and open to resolved", () => {
    const callout = formatContradictionCallout({
      id: "CD-001",
      claimA: { text: "A claim.", sourceSlug: "s1", sourceDate: "2026-01-01" },
      claimB: { text: "B claim.", sourceSlug: "s2", sourceDate: "2026-02-01" },
      reasoning: "Conflict.",
    });
    const page = `# Page\n\n${callout}\n\nMore content.\n`;

    const result = rewriteCalloutToResolved(page, "CD-001", "B", "B is correct", "2026-08-12");

    expect(result).toContain("[!note]");
    expect(result).toContain("· resolved");
    expect(result).not.toContain("[!warning]");
    expect(result).not.toContain("· open");
  });

  it("adds the resolution line at the end of the callout", () => {
    const callout = formatContradictionCallout({
      id: "CD-001",
      claimA: { text: "A.", sourceSlug: "s1", sourceDate: "2026-01-01" },
      claimB: { text: "B.", sourceSlug: "s2", sourceDate: "2026-02-01" },
      reasoning: "Conflict.",
    });
    const page = `# Page\n\n${callout}\n\nAfter.\n`;

    const result = rewriteCalloutToResolved(page, "CD-001", "A", "A was verified", "2026-08-12");

    expect(result).toContain("> **Resolved 2026-08-12 — kept A.** A was verified");
  });

  it("preserves both claim lines verbatim (AC-10.3)", () => {
    const callout = formatContradictionCallout({
      id: "CD-001",
      claimA: { text: "Kiro requires Pro.", sourceSlug: "docs", sourceDate: "2026-08-09" },
      claimB: { text: "Kiro runs on Free.", sourceSlug: "test", sourceDate: "2026-08-11" },
      reasoning: "No change stated.",
    });
    const page = `# Page\n\n${callout}\n`;

    const result = rewriteCalloutToResolved(page, "CD-001", "B", "tested it", "2026-08-12");

    expect(result).toContain("Kiro requires Pro.");
    expect(result).toContain("Kiro runs on Free.");
  });
});

// ---------------------------------------------------------------------------
// 7.3 — Register entry moved from Open to Resolved
// ---------------------------------------------------------------------------

describe("moveToResolved (task 7.3)", () => {
  it("moves entry from Open to Resolved section", () => {
    const register =
      "# Contradictions\n\n## Open\n\n### CD-001 — open\n\n- **A** — claim A\n- **B** — claim B\n\n## Resolved\n\n";

    const result = moveToResolved(register, "CD-001", "B", "tested", "2026-08-12");

    // Not in Open anymore (heading changed)
    expect(result).not.toContain("### CD-001 — open");
    // In Resolved
    expect(result).toContain("### CD-001 — resolved");
    // After ## Resolved heading
    const resolvedIdx = result.indexOf("## Resolved");
    const entryIdx = result.indexOf("### CD-001 — resolved");
    expect(entryIdx).toBeGreaterThan(resolvedIdx);
  });

  it("adds resolution note to the moved entry", () => {
    const register =
      "# Contradictions\n\n## Open\n\n### CD-001 — open\n\n- **A** — x\n- **B** — y\n\n## Resolved\n\n";

    const result = moveToResolved(register, "CD-001", "A", "verified in lab", "2026-08-12");

    expect(result).toContain("**Resolved 2026-08-12 — kept A.** verified in lab");
  });

  it("preserves all other entries (total count unchanged)", () => {
    const register =
      "# Contradictions\n\n## Open\n\n" +
      "### CD-001 — open\n\n- **A** — first A\n- **B** — first B\n\n" +
      "### CD-002 — open\n\n- **A** — second A\n- **B** — second B\n\n" +
      "## Resolved\n\n" +
      "### CD-000 — resolved\n\n- **A** — zero A\n- **B** — zero B\n\n";

    const result = moveToResolved(register, "CD-001", "B", "reason", "2026-08-12");

    // CD-002 still in Open
    expect(result).toContain("### CD-002 — open");
    expect(result).toContain("second A");
    // CD-000 still in Resolved
    expect(result).toContain("### CD-000 — resolved");
    expect(result).toContain("zero A");
    // CD-001 moved to Resolved
    expect(result).toContain("### CD-001 — resolved");
    expect(result).toContain("first A");
  });
});

// ---------------------------------------------------------------------------
// Full integration: resolveContradiction
// ---------------------------------------------------------------------------

describe("resolveContradiction integration (tasks 7.1–7.7)", () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "elenchus-resolve-"));
    originalCwd = process.cwd();
    process.chdir(tmpDir);
    ensureLayout();
    ensureSchema();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    _resetDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resolves an open contradiction — page, register, and DB updated (7.1–7.4)", () => {
    seedContradiction(tmpDir);

    const outcome = resolveContradiction("CD-001", "B", "tested it myself");

    expect(outcome.success).toBe(true);
    if (outcome.success) {
      expect(outcome.kept).toBe("B");
    }

    // Page: callout is now [!note] · resolved
    const page = readFileSync(join(tmpDir, "pages", "food-safety.md"), "utf-8");
    expect(page).toContain("[!note]");
    expect(page).toContain("· resolved");
    expect(page).toContain("**Resolved");
    expect(page).toContain("kept B");

    // Register: entry moved to Resolved
    const register = readFileSync(join(tmpDir, "contradictions.md"), "utf-8");
    expect(register).toContain("### CD-001 — resolved");
    expect(register).not.toContain("### CD-001 — open");

    // DB: status updated
    const db = ensureSchema();
    const row = db.prepare("SELECT status, resolved_keep, resolved_reason FROM contradictions WHERE id = 1").get() as any;
    expect(row.status).toBe("resolved");
    expect(row.resolved_keep).toBe("B");
    expect(row.resolved_reason).toBe("tested it myself");
  });

  it("keeps the rejected claim on the page (7.6, AC-10.3)", () => {
    seedContradiction(tmpDir);

    resolveContradiction("CD-001", "B", "B is right");

    const page = readFileSync(join(tmpDir, "pages", "food-safety.md"), "utf-8");
    // Both claims must still be present
    expect(page).toContain("Danger zone is 4–60 °C.");
    expect(page).toContain("Danger zone is 5–57 °C.");
  });

  it("rejects unknown id — nothing changed (7.5, 7.7)", () => {
    seedContradiction(tmpDir);

    // Capture state before
    const pageBefore = readFileSync(join(tmpDir, "pages", "food-safety.md"), "utf-8");
    const registerBefore = readFileSync(join(tmpDir, "contradictions.md"), "utf-8");

    const outcome = resolveContradiction("CD-999", "A", "reason");

    expect(outcome.success).toBe(false);
    if (!outcome.success) {
      expect(outcome.reason).toContain("not found");
    }

    // Nothing changed
    expect(readFileSync(join(tmpDir, "pages", "food-safety.md"), "utf-8")).toBe(pageBefore);
    expect(readFileSync(join(tmpDir, "contradictions.md"), "utf-8")).toBe(registerBefore);

    // DB unchanged
    const db = ensureSchema();
    const row = db.prepare("SELECT status FROM contradictions WHERE id = 1").get() as any;
    expect(row.status).toBe("open");
  });

  it("rejects already-resolved id — nothing changed (7.5)", () => {
    seedContradiction(tmpDir);

    // First resolve succeeds
    resolveContradiction("CD-001", "A", "first resolution");

    // Capture state after first resolution
    const pageAfterFirst = readFileSync(join(tmpDir, "pages", "food-safety.md"), "utf-8");
    const registerAfterFirst = readFileSync(join(tmpDir, "contradictions.md"), "utf-8");

    // Second resolve fails
    const outcome = resolveContradiction("CD-001", "B", "change my mind");

    expect(outcome.success).toBe(false);
    if (!outcome.success) {
      expect(outcome.reason).toContain("already resolved");
    }

    // Nothing changed from first resolution
    expect(readFileSync(join(tmpDir, "pages", "food-safety.md"), "utf-8")).toBe(pageAfterFirst);
    expect(readFileSync(join(tmpDir, "contradictions.md"), "utf-8")).toBe(registerAfterFirst);
  });

  it("rejects invalid --keep value — nothing changed (7.5)", () => {
    seedContradiction(tmpDir);

    const pageBefore = readFileSync(join(tmpDir, "pages", "food-safety.md"), "utf-8");
    const registerBefore = readFileSync(join(tmpDir, "contradictions.md"), "utf-8");

    const outcome = resolveContradiction("CD-001", "C", "invalid");

    expect(outcome.success).toBe(false);
    if (!outcome.success) {
      expect(outcome.reason).toContain("A");
      expect(outcome.reason).toContain("B");
    }

    expect(readFileSync(join(tmpDir, "pages", "food-safety.md"), "utf-8")).toBe(pageBefore);
    expect(readFileSync(join(tmpDir, "contradictions.md"), "utf-8")).toBe(registerBefore);
  });
});
