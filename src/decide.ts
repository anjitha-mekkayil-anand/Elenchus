/**
 * Decide stage — tasks 5.1–5.4
 *
 * Per candidate: weave or skip, with reasoning (AC-3.1).
 * Create a new page only when no candidate can hold the material (AC-3.2).
 * On create, record the rejected candidates and why (AC-3.3).
 * Allow one source to weave into several pages in one run (AC-3.4).
 */

import type { ModelClient, ModelRequest } from "./model/types.js";
import type { Candidate } from "./retrieve.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WeaveDecision {
  action: "weave";
  slug: string;
  reason: string;
}

export interface SkipDecision {
  action: "skip";
  slug: string;
  reason: string;
}

export interface CreateDecision {
  action: "create";
  suggestedSlug: string;
  suggestedTitle: string;
  reason: string;
  rejectedCandidates: Array<{ slug: string; reason: string }>;
}

export type Decision = WeaveDecision | SkipDecision | CreateDecision;

export interface DecideResult {
  /** Per-candidate decisions (weave or skip). */
  decisions: Decision[];
  /** Raw model response for the ingest record. */
  rawResponse: string;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are the decision stage of a knowledge base called Elenchus.

Your job: given a new source and a set of candidate pages that might be relevant, decide for EACH candidate whether the source's material belongs inside that page (weave) or does not (skip).

Rules:
- Default to weave. An orphan page is the failure mode — create only when truly necessary.
- A source CAN weave into multiple pages in one run. That is normal when a source touches multiple topics.
- If NONE of the candidates can hold the material, say so — a new page will be created.
- For each decision, give a one-sentence reason.

Respond with a JSON object (no markdown fencing):
{
  "decisions": [
    {"slug": "<slug>", "action": "weave", "reason": "..."},
    {"slug": "<slug>", "action": "skip", "reason": "..."}
  ],
  "create": null
}

If NO candidate can hold the material and a new page is needed:
{
  "decisions": [
    {"slug": "<slug>", "action": "skip", "reason": "..."}
  ],
  "create": {"slug": "<suggested-slug>", "title": "<suggested-title>", "reason": "Why a new page is needed."}
}`;

const NEW_TOPIC_SYSTEM_PROMPT = `You are the decision stage of a knowledge base called Elenchus.

No existing pages match the new source. Your job: propose a page to hold this material.

Respond with a JSON object (no markdown fencing):
{"slug": "<short-kebab-case-slug>", "title": "<Human-readable title>", "reason": "Why this page is needed."}`;

function buildUserMessage(
  sourceText: string,
  candidates: Candidate[]
): string {
  const candidateList = candidates
    .map((c) => `- [${c.slug}]: ${c.reason}`)
    .join("\n");

  return `## New source text

${sourceText}

## Candidate pages (from retrieval)

${candidateList}

---

For each candidate: weave or skip? If none can hold this material, request a new page.`;
}

function buildNewTopicMessage(sourceText: string): string {
  return `## New source text

${sourceText}

---

No existing pages match. Propose a slug and title for a new page to hold this material.`;
}

// ---------------------------------------------------------------------------
// Decide
// ---------------------------------------------------------------------------

/**
 * Runs the decide stage.
 *
 * If candidates are provided, asks the model to decide per candidate.
 * If no candidates (new topic from retrieve), asks the model to propose
 * a slug and title for the new page.
 */
export async function decide(
  sourceText: string,
  candidates: Candidate[],
  model: ModelClient
): Promise<DecideResult> {
  // AC-3.2: If no candidates at all (new topic path), ask model to name the page
  if (candidates.length === 0) {
    const req: ModelRequest = {
      task: "decide-new-topic",
      system: NEW_TOPIC_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: buildNewTopicMessage(sourceText),
        },
      ],
    };

    const response = await model.complete(req);
    const rawResponse = response.content;
    const proposal = parseNewTopicProposal(rawResponse);

    return {
      decisions: [
        {
          action: "create",
          suggestedSlug: proposal.slug,
          suggestedTitle: proposal.title,
          reason: proposal.reason,
          rejectedCandidates: [],
        },
      ],
      rawResponse,
    };
  }

  const req: ModelRequest = {
    task: "decide",
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: buildUserMessage(sourceText, candidates),
      },
    ],
  };

  const response = await model.complete(req);
  const rawResponse = response.content;

  const decisions = parseDecisions(rawResponse, candidates);

  return { decisions, rawResponse };
}

/**
 * Parses the model's response into decisions.
 */
function parseDecisions(raw: string, candidates: Candidate[]): Decision[] {
  // Strip markdown code fences if present
  let text = raw.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }

  const parsed = JSON.parse(text) as {
    decisions: Array<{ slug: string; action: string; reason: string }>;
    create: { slug: string; title: string; reason: string } | null;
  };

  if (!parsed.decisions || !Array.isArray(parsed.decisions)) {
    throw new Error(
      `Decide: expected "decisions" array in model response.`
    );
  }

  const results: Decision[] = [];

  for (const d of parsed.decisions) {
    if (d.action === "weave") {
      results.push({ action: "weave", slug: d.slug, reason: d.reason });
    } else if (d.action === "skip") {
      results.push({ action: "skip", slug: d.slug, reason: d.reason });
    } else {
      throw new Error(
        `Decide: unknown action "${d.action}" for slug "${d.slug}".`
      );
    }
  }

  // AC-3.2, AC-3.3: If all candidates were skipped and create is requested
  if (parsed.create) {
    const skippedCandidates = candidates
      .map((c) => {
        const decision = parsed.decisions.find((d) => d.slug === c.slug);
        return {
          slug: c.slug,
          reason: decision?.reason ?? "No reason given by model.",
        };
      });

    results.push({
      action: "create",
      suggestedSlug: parsed.create.slug,
      suggestedTitle: parsed.create.title,
      reason: parsed.create.reason,
      rejectedCandidates: skippedCandidates,
    });
  }

  return results;
}

/**
 * Parses the model's response for the new-topic (zero candidates) path.
 * Expects: {"slug": "...", "title": "...", "reason": "..."}
 */
function parseNewTopicProposal(raw: string): { slug: string; title: string; reason: string } {
  let text = raw.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }

  const parsed = JSON.parse(text) as { slug?: string; title?: string; reason?: string };

  if (!parsed.slug || !parsed.title || !parsed.reason) {
    throw new Error(
      `Decide (new topic): model must return "slug", "title", and "reason". Got: ${text}`
    );
  }

  return { slug: parsed.slug, title: parsed.title, reason: parsed.reason };
}
