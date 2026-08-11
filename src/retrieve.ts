/**
 * Retrieve stage — tasks 4.2, 4.3
 *
 * Sends the page index to the model along with the source text.
 * The model returns candidate pages that the source could touch,
 * each with a reason. If no candidates clear the threshold, the
 * new-topic path is taken — this is a normal outcome, not an error.
 *
 * AC-2.1: retrieve existing pages most likely affected, before any edit.
 * AC-2.2: no candidates → new topic path.
 * AC-2.3: candidate set visible in the ingest record, including considered-but-not-edited.
 */

import type { ModelClient, ModelRequest } from "./model/types.js";
import { formatIndexForModel } from "./pages.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Candidate {
  slug: string;
  reason: string;
}

export interface RetrieveResult {
  /** Candidate pages the model identified as relevant. */
  candidates: Candidate[];
  /** True when no candidates were returned — the new-topic path. */
  newTopic: boolean;
  /** Raw model response for the ingest record. */
  rawResponse: string;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are the retrieval stage of a knowledge base called Elenchus.

Your job: given the current page index and a new source, identify which existing pages the source's material could belong in.

Rules:
- Return ONLY pages where the source adds something to what the page already covers.
- For each candidate, give a one-sentence reason why the source is relevant to that page.
- If NO existing page is a good fit, return an empty list — that is the correct answer for genuinely new topics.
- Do not invent pages that do not exist in the index.

Respond with a JSON array (no markdown fencing). Each element: {"slug": "<slug>", "reason": "<reason>"}.
If no pages match, respond with an empty array: []`;

function buildUserMessage(sourceText: string, index: string): string {
  return `## Current page index

${index}

## New source text

${sourceText}

---

Which existing pages does this source touch? Return a JSON array of candidates with reasons, or [] if this is a new topic.`;
}

// ---------------------------------------------------------------------------
// Retrieve
// ---------------------------------------------------------------------------

/**
 * Runs the retrieve stage: sends the index + source to the model,
 * parses the response into candidates.
 *
 * Returns a RetrieveResult with candidates (possibly empty for new topics).
 */
export async function retrieve(
  sourceText: string,
  model: ModelClient
): Promise<RetrieveResult> {
  const index = formatIndexForModel();

  const req: ModelRequest = {
    task: "retrieve",
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: buildUserMessage(sourceText, index),
      },
    ],
  };

  const response = await model.complete(req);
  const rawResponse = response.content;

  const candidates = parseCandidates(rawResponse);

  return {
    candidates,
    newTopic: candidates.length === 0,
    rawResponse,
  };
}

/**
 * Parses the model's response into candidate objects.
 * Expects a JSON array of {slug, reason} objects.
 */
function parseCandidates(raw: string): Candidate[] {
  // Strip markdown code fences if the model wraps them
  let text = raw.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }

  const parsed = JSON.parse(text);

  if (!Array.isArray(parsed)) {
    throw new Error(
      `Retrieve: expected JSON array from model, got ${typeof parsed}`
    );
  }

  return parsed.map((item: unknown) => {
    if (
      typeof item !== "object" ||
      item === null ||
      !("slug" in item) ||
      !("reason" in item)
    ) {
      throw new Error(
        `Retrieve: each candidate must have "slug" and "reason". Got: ${JSON.stringify(item)}`
      );
    }
    const obj = item as { slug: string; reason: string };
    return { slug: obj.slug, reason: obj.reason };
  });
}
