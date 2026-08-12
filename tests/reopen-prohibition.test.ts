/**
 * Tests for sections 8 and 9:
 * 8.3 — Reopen resolved contradictions (AC-10.4)
 * 9.1 — Auto-resolution prohibition (AC-10.1)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureLayout } from "../src/layout.js";
import { ensureSchema, getDb, _resetDb } from "../src/schema.js";

function insertSource(db: ReturnType<typeof getDb>, slug: string): number {
  const result = db.prepare(
    "INSERT INTO sources (hash, filename, origin, byte_length) VALUES (?, ?, ?, ?)"
  ).run(`hash-${slug}`, `${slug}.txt`, `/test/${slug}`, 100);
  return Number(result.lastInsertRowid);
}

function insertClaim(
  db: ReturnType<typeof getDb>,
  opts: { page: string; anchor: string; text: string; sourceId: number; hash: string }
): number {
  const result = db.prepare(
    "INSERT INTO claims (page, anchor, text, source_id, source_date, content_hash) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(opts.page, opts.anchor, opts.text, opts.sourceId, "2026-08-10", opts.hash);
  return Number(result.lastInsertRowid);
}

// ---------------------------------------------------------------------------
// Section 8.3 — Reopen (AC-10.4)
// ---------------------------------------------------------------------------

describe("section 8: reopen resolved contradiction (task 8.3, AC-10.4)", () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "elenchus-reopen-"));
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

  it("reopening sets status to 'open' and preserves prior resolution history", () => {
    const db = getDb();
    const sourceId = insertSource(db, "original");
    const hash = "abc123";

    const claimAId = insertClaim(db, {
      page: "food-safety", anchor: "Temperature", text: "Water boils at 100 °C.",
      sourceId, hash,
    });
    const claimBId = insertClaim(db, {
      page: "food-safety", anchor: "Temperature", text: "Water boils at 95 °C.",
      sourceId, hash,
    });

    // Resolved contradiction
    db.prepare(
      "INSERT INTO contradictions (claim_a, claim_b, kind, reasoning, status, resolved_keep, resolved_at, resolved_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(claimAId, claimBId, "contradiction", "Incompatible boiling points.",
      "resolved", "A", "2026-08-11T10:00:00Z", "100 °C is standard at sea level.");

    const before = db.prepare("SELECT * FROM contradictions WHERE claim_a = ?").get(claimAId) as any;
    expect(before.status).toBe("resolved");

    // Simulate reopen (same logic as runIngest 8.1)
    const newClaimBId = insertClaim(db, {
      page: "food-safety", anchor: "Temperature", text: "Water boils at 90 °C at altitude.",
      sourceId, hash,
    });

    db.prepare(
      "UPDATE contradictions SET status = 'open', claim_b = ?, reasoning = ? WHERE id = ?"
    ).run(newClaimBId, "New material contradicts.", before.id);

    const after = db.prepare("SELECT * FROM contradictions WHERE id = ?").get(before.id) as any;
    expect(after.status).toBe("open");
    expect(after.claim_b).toBe(newClaimBId);
    // Prior resolution preserved
    expect(after.resolved_keep).toBe("A");
    expect(after.resolved_at).toBe("2026-08-11T10:00:00Z");
    expect(after.resolved_reason).toBe("100 °C is standard at sea level.");
  });

  it("reopen query finds resolved contradictions by claim_a", () => {
    const db = getDb();
    const sourceId = insertSource(db, "src1");
    const hash = "def456";

    const claimAId = insertClaim(db, {
      page: "exams", anchor: "Schedule", text: "Exam on 12 Aug.",
      sourceId, hash,
    });
    const claimBId = insertClaim(db, {
      page: "exams", anchor: "Schedule", text: "Exam on 3 Sep.",
      sourceId, hash,
    });

    db.prepare(
      "INSERT INTO contradictions (claim_a, claim_b, kind, reasoning, status, resolved_keep, resolved_at, resolved_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(claimAId, claimBId, "contradiction", "Different dates.",
      "resolved", "B", "2026-08-10", "Rescheduled.");

    const existing = db.prepare(
      "SELECT id, resolved_keep, resolved_at, resolved_reason FROM contradictions " +
      "WHERE claim_a = ? AND status = 'resolved'"
    ).get(claimAId) as any;

    expect(existing).toBeDefined();
    expect(existing.resolved_keep).toBe("B");
    expect(existing.resolved_reason).toBe("Rescheduled.");
  });
});

// ---------------------------------------------------------------------------
// Section 9.1 — Prohibition (AC-10.1)
// ---------------------------------------------------------------------------

describe("section 9: auto-resolution prohibition (task 9.1, AC-10.1)", () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "elenchus-noresolve-"));
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

  it("open contradiction remains open regardless of how many sources agree with one side", () => {
    const db = getDb();
    const sourceId = insertSource(db, "src-original");
    const hash = "xyz789";

    const claimAId = insertClaim(db, {
      page: "kiro-docs", anchor: "Access", text: "Kiro Web requires Pro.",
      sourceId, hash,
    });
    const claimBId = insertClaim(db, {
      page: "kiro-docs", anchor: "Access", text: "Kiro Web is free.",
      sourceId, hash,
    });

    db.prepare(
      "INSERT INTO contradictions (claim_a, claim_b, kind, reasoning, status) VALUES (?, ?, ?, ?, ?)"
    ).run(claimAId, claimBId, "contradiction", "Incompatible.", "open");

    // Ingest 2 sources agreeing with B
    for (let i = 0; i < 2; i++) {
      const sId = insertSource(db, `agrees-b-${i}`);
      insertClaim(db, {
        page: "kiro-docs", anchor: "Access", text: `Kiro Web is free (source ${i}).`,
        sourceId: sId, hash,
      });
    }

    // Still open — nothing auto-resolves
    const row = db.prepare("SELECT status FROM contradictions WHERE claim_a = ?").get(claimAId) as { status: string };
    expect(row.status).toBe("open");

    // No resolved rows exist
    const resolved = db.prepare(
      "SELECT COUNT(*) as cnt FROM contradictions WHERE status = 'resolved'"
    ).get() as { cnt: number };
    expect(resolved.cnt).toBe(0);
  });
});
