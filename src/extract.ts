/**
 * Extract stage — tasks 2.1, 2.2
 *
 * Sends source material to the model and receives back discrete factual
 * claims at assertion granularity. Claims are returned UNBOUND — no page,
 * no anchor, no hash — and held in memory for the Compare stage.
 *
 * AC-7.1: extract claims asserted by the source.
 * AC-7.3: opinion, description, instruction, and question produce no claims.
 */

import type { ModelClient, ModelRequest } from "./model/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExtractedClaim {
  /** A single factual assertion, self-contained and understandable in isolation. */
  text: string;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are the claim-extraction stage of a knowledge base called Elenchus.

Your job: given a piece of source material, extract every discrete factual claim it asserts.

## What counts as a claim

A claim is ONE assertion that could be true or false, stated in its own words. It is NOT a sentence and NOT a paragraph.

- One sentence can carry multiple claims. Split them.
- One claim can span multiple sentences of qualification. Merge them into one statement.
- Sentence-splitting is wrong. Extract assertions, not sentences.

## Each claim MUST stand alone

A claim will later be compared against a claim from a DIFFERENT source, months apart, with NO surrounding text. So every claim must be fully self-contained:

- Resolve all pronouns ("it", "they", "this") to their referent.
- Replace "the above", "as mentioned", or any reference that depends on neighbouring text with the actual subject.
- Include enough context that the claim is understandable without the source document.

BAD: "It moved to 3 September." (What moved?)
GOOD: "The AI-103 exam is scheduled for 3 September."

BAD: "This is important for health."
GOOD: "Adequate vitamin D intake is important for bone health."

## What is NOT a claim — produce nothing for these

- Opinions or value judgments ("X is worth understanding", "Y is interesting")
- Descriptions of what something IS without asserting a checkable fact ("Food safety is a topic")
- Instructions or imperatives ("Always wash your hands", "Heat oil before adding food")
- Questions
- Section headings or titles used as labels
- Introductory framing that asserts nothing ("This section covers...")

If the entire source material contains no checkable factual assertions, return an empty array. This is correct, not an error.

## Output format

Respond with a JSON array of objects. Each object has one field: "text" containing the claim.

Example: [{"text": "Bacteria multiply rapidly between 4 °C and 60 °C."}]

If no claims are found: []

No markdown fencing. No commentary. Just the JSON array.`;

function buildUserMessage(
  text: string,
  sourceId: string,
  sourceDate: string
): string {
  return `## Source metadata

Source ID: ${sourceId}
Source date: ${sourceDate}

## Source material

${text}

---

Extract all discrete factual claims from this source. Return a JSON array of {"text": "..."} objects, or [] if no checkable assertions are present.`;
}

// ---------------------------------------------------------------------------
// Extract
// ---------------------------------------------------------------------------

/**
 * Extracts discrete factual claims from source material using the model.
 *
 * Returns an array of claims at assertion granularity. Each claim is
 * self-contained and understandable in isolation. Returns an empty array
 * if the source asserts nothing checkable (AC-7.3).
 */
export async function extractClaims(
  text: string,
  sourceId: string,
  sourceDate: string,
  model: ModelClient
): Promise<ExtractedClaim[]> {
  const req: ModelRequest = {
    task: "extract",
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: buildUserMessage(text, sourceId, sourceDate),
      },
    ],
  };

  const response = await model.complete(req);
  return parseClaims(response.content);
}

/**
 * Parses the model's response into claim objects.
 * Expects a JSON array of {text} objects.
 */
function parseClaims(raw: string): ExtractedClaim[] {
  // Strip markdown code fences if the model wraps them
  let content = raw.trim();
  if (content.startsWith("```")) {
    content = content.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }

  const parsed = JSON.parse(content);

  if (!Array.isArray(parsed)) {
    throw new Error(
      `Extract: expected JSON array from model, got ${typeof parsed}`
    );
  }

  // Validate and filter: each element must have a non-empty "text" field
  return parsed
    .filter((item: unknown) => {
      if (typeof item !== "object" || item === null || !("text" in item)) {
        return false;
      }
      const obj = item as { text: unknown };
      return typeof obj.text === "string" && obj.text.trim().length > 0;
    })
    .map((item: { text: string }) => ({ text: item.text.trim() }));
}
