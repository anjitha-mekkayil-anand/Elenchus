/**
 * Verify stage — tasks 7.1, 7.2
 *
 * The hard invariant (AC-4.1, AC-4.2): existing content is never destroyed.
 *
 * 7.1: Deterministic check — post-edit content contains pre-edit content
 *      as a subsequence. This is CODE, not a model call.
 * 7.2: Rejected edits are recorded and the ingest CONTINUES.
 *      A rejected edit must not abort the run.
 *
 * "It cannot destroy what is already written. Everything downstream
 *  writes through this gate." — tasks.md
 */

import type { Edit } from "./plan.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VerifiedEdit {
  edit: Edit;
  status: "accepted";
}

export interface RejectedEdit {
  edit: Edit;
  status: "rejected";
  reason: string;
}

export type VerifyOutcome = VerifiedEdit | RejectedEdit;

export interface VerifyResult {
  /** Edits that passed the invariant check — safe to apply. */
  accepted: VerifiedEdit[];
  /** Edits that failed the invariant — recorded, ingest continues. */
  rejected: RejectedEdit[];
}

// ---------------------------------------------------------------------------
// 7.1 — Line-level subsequence check
// ---------------------------------------------------------------------------

/**
 * Checks whether every non-empty line of `pre` appears verbatim, in order,
 * in `post`. Lines may be inserted between them — that is the point of
 * weaving — but no original line may be altered, split, or moved.
 *
 * This is LINE-level, not character-level. A character-level check leaks
 * because appended text can supply characters needed to reconstruct
 * destroyed content.
 *
 * No normalisation, no trimming, no whitespace collapsing: a reflow is
 * a rewrite.
 *
 * This is deterministic code — no model call, no heuristic.
 */
export function isSubsequence(pre: string, post: string): boolean {
  const preLines = pre.split("\n");
  const postLines = post.split("\n");

  let pi = 0; // pointer into preLines
  let qi = 0; // pointer into postLines

  while (pi < preLines.length && qi < postLines.length) {
    // Skip empty lines in pre — they carry no content to protect
    if (preLines[pi] === "") {
      pi++;
      continue;
    }

    if (preLines[pi] === postLines[qi]) {
      pi++;
    }
    qi++;
  }

  // Skip any trailing empty lines in pre
  while (pi < preLines.length && preLines[pi] === "") {
    pi++;
  }

  return pi === preLines.length;
}

// ---------------------------------------------------------------------------
// 7.1 + 7.2 — Verify edits
// ---------------------------------------------------------------------------

/**
 * Verifies a single edit against the invariant.
 *
 * For weave edits (existing page): the post-edit content must contain
 * the pre-edit content as a subsequence.
 *
 * For create edits (new page): no pre-existing content to protect,
 * so the check always passes.
 *
 * @param edit - The planned edit
 * @param preContent - The current page content before the edit (null for new pages)
 * @param postContent - The page content after the edit would be applied
 */
export function verifyEdit(
  edit: Edit,
  preContent: string | null,
  postContent: string
): VerifyOutcome {
  // New pages have no pre-existing content to protect
  if (preContent === null || edit.anchor === "(new page)") {
    return { edit, status: "accepted" };
  }

  if (!isSubsequence(preContent, postContent)) {
    return {
      edit,
      status: "rejected",
      reason:
        `Invariant violation (AC-4.1): post-edit content does not contain ` +
        `pre-edit content as a subsequence. The edit to page "${edit.page}" ` +
        `at anchor "${edit.anchor}" would destroy or reorder existing content.`,
    };
  }

  return { edit, status: "accepted" };
}

/**
 * Verifies a batch of edits. Rejected edits are recorded and the
 * ingest continues (7.2) — a rejected edit does not abort the run.
 *
 * @param edits - Planned edits from the plan stage
 * @param getPreContent - Function to get current page content by slug (null if page doesn't exist)
 * @param simulatePost - Function that simulates what the page would look like after the edit
 */
export function verifyEdits(
  edits: Edit[],
  getPreContent: (slug: string) => string | null,
  simulatePost: (preContent: string | null, edit: Edit) => string
): VerifyResult {
  const accepted: VerifiedEdit[] = [];
  const rejected: RejectedEdit[] = [];

  for (const edit of edits) {
    const preContent = getPreContent(edit.page);
    const postContent = simulatePost(preContent, edit);
    const outcome = verifyEdit(edit, preContent, postContent);

    if (outcome.status === "accepted") {
      accepted.push(outcome);
    } else {
      rejected.push(outcome);
    }
  }

  return { accepted, rejected };
}

/**
 * Default simulation of applying an edit: appends the insertion after
 * the anchor line. If the anchor is not found, appends at the end.
 *
 * This is the simplest correct simulation — section 8 (Apply) may
 * refine insertion logic, but the invariant check uses this to predict
 * the post-edit state.
 */
export function simulateEditApplication(
  preContent: string | null,
  edit: Edit
): string {
  // New page — the insertion IS the page content
  if (preContent === null || edit.anchor === "(new page)") {
    return edit.insertion;
  }

  const lines = preContent.split("\n");
  const anchorIndex = lines.findIndex((line) => line.trim() === edit.anchor);

  if (anchorIndex === -1) {
    // Anchor not found — append at end
    return preContent + "\n\n" + edit.insertion;
  }

  // Find the end of the section under the anchor (next heading or end)
  let insertAt = anchorIndex + 1;
  for (let i = anchorIndex + 1; i < lines.length; i++) {
    if (lines[i].match(/^#{1,6}\s/)) {
      break;
    }
    insertAt = i + 1;
  }

  // Insert after the section content
  const before = lines.slice(0, insertAt);
  const after = lines.slice(insertAt);
  return [...before, "", edit.insertion, ...after].join("\n");
}
