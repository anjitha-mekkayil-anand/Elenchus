/**
 * Compare stage — tasks 4.1–4.5
 *
 * Sends source claims and stored page claims to the model in a single call.
 * The model identifies pairs that conflict and classifies each as:
 *   - neither (refinement, restatement, different scope)
 *   - supersession (source states an event that changed the fact)
 *   - contradiction (genuine conflict, no stated event)
 *
 * Gates enforced in code (not trusted from the model):
 *   - AC-8.7: falsifier required for contradiction/supersession — demote to neither if missing.
 *   - AC-8.5: changeEvidence must be a verbatim substring of sourceText for supersession —
 *             demote to contradiction if unverifiable.
 *
 * NF-5: comparison bounded to pages this ingest is writing to (caller's responsibility).
 * AC-9.2: no confidence scores, no ranking.
 * AC-10.1: nothing in this module resolves a contradiction.
 */

import type { ModelClient, ModelRequest } from "./model/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SourceClaim {
  text: string;
}

export interface StoredClaimForCompare {
  id: number;
  text: string;
  page: string;
  source_date: string;
}

export type PairLabel = "neither" | "supersession" | "contradiction";

export interface ClassifiedPair {
  sourceClaim: SourceClaim;
  storedClaim: StoredClaimForCompare;
  label: PairLabel;
  /** What would have to be false for both claims to hold (AC-8.7). */
  falsifier: string;
  /** AC-8.8: reasoning for the classification. */
  reasoning: string;
  /** For supersession: verbatim span from source text stating the change (AC-8.5). */
  changeEvidence?: string;
}

export interface RejectedPair {
  sourceClaim: SourceClaim;
  storedClaim: StoredClaimForCompare;
  originalLabel: PairLabel;
  demotedTo: PairLabel;
  reason: string;
}

export interface CompareResult {
  /** Pairs classified as contradiction or supersession — ready for storage. */
  conflicts: ClassifiedPair[];
  /** Pairs demoted due to gate failures — diagnostic, for the ingest record. */
  rejected: RejectedPair[];
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are the claim-comparison stage of a knowledge base called Elenchus.

Your job: given a list of NEW claims (from a source being ingested) and a list of STORED claims (already on a page), identify pairs where the two claims cannot both be true.

## Classification order

For each conflicting pair, determine its label in this order:

### 1. Neither — refinement, restatement, added qualification, different scope

Before deciding a pair conflicts, state what would have to be FALSE for both claims to hold simultaneously. Write that sentence (the "falsifier"). If you cannot write it — if both can be true at the same time — the pair is NOT a conflict. Label it "neither".

Examples of "neither":
- "roughly 50 poems" vs "53 poems" — precision, not conflict. Both can be true.
- "the deadline is 23 Aug 23:59 UTC" vs "the deadline is 24 Aug 05:29 IST" — same instant in different time zones. Both are true simultaneously.
- "vitamins are lost during cooking" vs "water-soluble vitamins are easily lost during cooking" — the second adds specificity. Both can be true.

### 2. Supersession — the source states an event that changed the fact

The NEW source must explicitly state that a change occurred — a reschedule, a revision, a correction, a version bump. Something in the text that says "this became that."

You MUST provide a VERBATIM quote from the source text as evidence of the stated change. Copy the exact words — do not paraphrase, do not summarise.

CRITICAL: recency alone is NEVER sufficient for supersession. A newer source is not automatically right. The source must SAY the thing changed. If it merely states a different value without mentioning a change, that is a contradiction, not a supersession.

### 3. Contradiction — genuine conflict, no stated event

The default for everything that is a real conflict and is not demonstrably a supersession. When in doubt between supersession and contradiction, choose contradiction (AC-8.6).

## Output format

Return a JSON array of objects. Each object represents ONE conflicting pair:

{
  "sourceIndex": <0-based index into the NEW claims list>,
  "storedIndex": <0-based index into the STORED claims list>,
  "label": "neither" | "supersession" | "contradiction",
  "falsifier": "<what would have to be false for both to hold — REQUIRED for supersession and contradiction, empty string for neither>",
  "reasoning": "<one-sentence explanation of the classification>",
  "changeEvidence": "<VERBATIM quote from source text stating the change — REQUIRED for supersession, omit for others>"
}

Rules:
- Reference claims by INDEX only. Never restate claim text in the output.
- Only include pairs that have SOME relationship (conflict, supersession, or near-miss). Unrelated pairs must NOT appear.
- If no pairs conflict at all, return an empty array: []
- Indices must be valid: sourceIndex in [0, len(new)-1], storedIndex in [0, len(stored)-1].

No markdown fencing. No commentary. Just the JSON array.`;

function buildUserMessage(
  sourceClaims: SourceClaim[],
  storedClaims: StoredClaimForCompare[],
  sourceText: string
): string {
  const newList = sourceClaims
    .map((c, i) => `  [${i}] ${c.text}`)
    .join("\n");

  const storedList = storedClaims
    .map((c, i) => `  [${i}] ${c.text}`)
    .join("\n");

  return `## NEW claims (from the source being ingested)

${newList}

## STORED claims (already on pages)

${storedList}

## Source text (for verifying change evidence)

${sourceText}

---

Identify conflicting pairs. Return a JSON array, or [] if no conflicts exist.`;
}

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------

/**
 * Compares source claims against stored page claims via a single model call.
 *
 * Returns classified pairs (conflicts) and rejected pairs (gate demotions).
 * Pairs labelled "neither" by the model are discarded (AC-8.4).
 * Pairs missing a falsifier are demoted to "neither" and recorded as rejected.
 * Supersessions with unverifiable changeEvidence are demoted to "contradiction".
 */
export async function compareClaims(
  sourceClaims: SourceClaim[],
  storedClaims: StoredClaimForCompare[],
  sourceText: string,
  model: ModelClient
): Promise<CompareResult> {
  // If either list is empty, no comparison is possible.
  if (sourceClaims.length === 0 || storedClaims.length === 0) {
    return { conflicts: [], rejected: [] };
  }

  const req: ModelRequest = {
    task: "compare",
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: buildUserMessage(sourceClaims, storedClaims, sourceText),
      },
    ],
  };

  const response = await model.complete(req);
  const rawPairs = parseResponse(response.content, sourceClaims.length, storedClaims.length);

  // Apply gates and classify.
  const conflicts: ClassifiedPair[] = [];
  const rejected: RejectedPair[] = [];

  for (const raw of rawPairs) {
    const sourceClaim = sourceClaims[raw.sourceIndex];
    const storedClaim = storedClaims[raw.storedIndex];

    // Gate 1: AC-8.7 — falsifier required for contradiction/supersession.
    if (
      (raw.label === "contradiction" || raw.label === "supersession") &&
      (!raw.falsifier || raw.falsifier.trim().length === 0)
    ) {
      rejected.push({
        sourceClaim,
        storedClaim,
        originalLabel: raw.label,
        demotedTo: "neither",
        reason: "AC-8.7: no falsifier stated — cannot confirm these claims conflict.",
      });
      continue;
    }

    // Gate 2: AC-8.5 — supersession requires verifiable change evidence.
    if (raw.label === "supersession") {
      const evidence = raw.changeEvidence?.trim() ?? "";
      if (evidence.length === 0 || !sourceText.includes(evidence)) {
        // Demote to contradiction (AC-8.6: uncertainty defaults to contradiction).
        const demotionReason = evidence.length === 0
          ? "AC-8.5: no change evidence provided for supersession."
          : `AC-8.5: changeEvidence "${evidence}" not found verbatim in source text.`;

        // Still a real conflict — demote to contradiction, not neither.
        conflicts.push({
          sourceClaim,
          storedClaim,
          label: "contradiction",
          falsifier: raw.falsifier,
          reasoning: `${raw.reasoning} [Demoted from supersession: ${demotionReason}]`,
          changeEvidence: undefined,
        });

        rejected.push({
          sourceClaim,
          storedClaim,
          originalLabel: "supersession",
          demotedTo: "contradiction",
          reason: demotionReason,
        });
        continue;
      }

      // Valid supersession.
      conflicts.push({
        sourceClaim,
        storedClaim,
        label: "supersession",
        falsifier: raw.falsifier,
        reasoning: raw.reasoning,
        changeEvidence: evidence,
      });
      continue;
    }

    // Contradiction with valid falsifier — keep as-is.
    if (raw.label === "contradiction") {
      conflicts.push({
        sourceClaim,
        storedClaim,
        label: "contradiction",
        falsifier: raw.falsifier,
        reasoning: raw.reasoning,
      });
      continue;
    }

    // "neither" — AC-8.4: not stored, just discarded.
    // But if the model returned it with a falsifier, it's a rejected pair (AC-8.7 inverse:
    // classifier returned a conflict with no valid falsifier logic). Actually, "neither"
    // means the model correctly identified no conflict. Just discard.
  }

  return { conflicts, rejected };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

interface RawPair {
  sourceIndex: number;
  storedIndex: number;
  label: PairLabel;
  falsifier: string;
  reasoning: string;
  changeEvidence?: string;
}

/**
 * Parses the model's JSON response into raw pair objects.
 * Validates indices against input sizes. Invalid indices cause a hard failure.
 */
function parseResponse(
  raw: string,
  sourceCount: number,
  storedCount: number
): RawPair[] {
  let content = raw.trim();
  if (content.startsWith("```")) {
    content = content.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }

  const parsed = JSON.parse(content);

  if (!Array.isArray(parsed)) {
    throw new Error(
      `Compare: expected JSON array from model, got ${typeof parsed}`
    );
  }

  const validLabels = new Set(["neither", "supersession", "contradiction"]);
  const results: RawPair[] = [];

  for (const item of parsed) {
    if (typeof item !== "object" || item === null) {
      throw new Error(`Compare: each element must be an object. Got: ${JSON.stringify(item)}`);
    }

    const obj = item as Record<string, unknown>;

    // Validate required fields.
    if (typeof obj.sourceIndex !== "number" || typeof obj.storedIndex !== "number") {
      throw new Error(
        `Compare: sourceIndex and storedIndex must be numbers. Got: ${JSON.stringify(item)}`
      );
    }

    // Validate index ranges.
    if (obj.sourceIndex < 0 || obj.sourceIndex >= sourceCount) {
      throw new Error(
        `Compare: sourceIndex ${obj.sourceIndex} out of range [0, ${sourceCount - 1}].`
      );
    }
    if (obj.storedIndex < 0 || obj.storedIndex >= storedCount) {
      throw new Error(
        `Compare: storedIndex ${obj.storedIndex} out of range [0, ${storedCount - 1}].`
      );
    }

    const label = obj.label as string;
    if (!validLabels.has(label)) {
      throw new Error(
        `Compare: label must be "neither", "supersession", or "contradiction". Got: "${label}"`
      );
    }

    results.push({
      sourceIndex: obj.sourceIndex as number,
      storedIndex: obj.storedIndex as number,
      label: label as PairLabel,
      falsifier: (obj.falsifier as string) ?? "",
      reasoning: (obj.reasoning as string) ?? "",
      changeEvidence: obj.changeEvidence as string | undefined,
    });
  }

  return results;
}
