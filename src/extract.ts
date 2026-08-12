/**
 * Extract stage — tasks 2.1, 2.2
 *
 * Sends source material to the model and receives back discrete factual
 * claims at assertion granularity. Claims are returned UNBOUND — no page,
 * no anchor, no hash — and held in memory for the Compare stage.
 *
 * AC-7.1: extract claims asserted by the source.
 * AC-7.3: material that asserts nothing checkable (falsifier test) produces no claims.
 * AC-7.5: every reference resolved into the claim in its most definitional form.
 * AC-7.6: extract only what the source asserts; do not manufacture assertions from framing.
 */

import type { ModelClient, ModelRequest } from "./model/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExtractedClaim {
  /** A single factual assertion, self-contained and understandable in isolation. */
  text: string;
  /** The nearest preceding heading in the source. Used as the section anchor for page claims. */
  anchor: string;
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

## What is NOT a claim — the falsifier test (AC-7.3)

Ask: "What would have to be false for this material to be wrong?"

If that question cannot be answered, the material asserts nothing checkable and you must produce no claim for it. This covers:

- Opinions or value judgments where nothing is falsifiable ("X is worth understanding")
- Questions
- Section headings or titles used as labels

Note: a prescription or instruction CAN be a claim if it asserts something falsifiable. Two sources prescribing opposite things is a genuine conflict. Extract the falsifiable assertion a prescription carries, not the imperative form.

If the entire source material contains no checkable factual assertions, return an empty array. This is correct, not an error.

## Do NOT manufacture assertions (AC-7.6)

Extract ONLY what the source actually asserts. Do NOT:

- Convert a heading, topic label, subtitle, or noun-phrase framing into a proposition
- Add causal claims ("to prevent X") that the source does not state
- Turn a category description ("Preventing foodborne illness through proper handling") into a factual claim about prevention effectiveness

A subtitle like "Preventing foodborne illness through proper handling, storage, and preparation" is a TOPIC LABEL — it names what the section is about, not an assertion that proper handling prevents illness. Do not extract it.

The test: if the source would read identically as a bullet point on a table of contents, it is framing, not a claim.

## Reference resolution (AC-7.5)

Resolve every reference a claim depends on into the claim itself, in the most DEFINITIONAL form the source provides — the number, the date, the named entity.

Rules:
- Never resolve a reference to a section heading.
- Never resolve a reference to a term the source defines elsewhere — use the definition itself.
- If two claims derive from the same referent, they MUST resolve it identically.

BAD: "Perishable food should not remain in the temperature danger zone for more than one hour when the ambient temperature is above 32 °C." (borrows section heading)
GOOD: "Perishable food should not remain in the temperature range of 4 °C to 60 °C for more than one hour when the ambient temperature is above 32 °C." (uses the definitional form)

The cost of inconsistent resolution is a detection gap: a later source revising the range contradicts one claim and sails past the other because they no longer share a comparable surface.

## Output format

Respond with a JSON array of objects. Each object has two fields:
- "text": the claim
- "anchor": the nearest preceding markdown heading (## or ###) under which this claim appears in the source. If the claim appears before any heading, use the document title (# heading). Use the heading text only, without the # characters.

Example: [{"text": "Bacteria multiply rapidly between 4 °C and 60 °C.", "anchor": "Temperature Danger Zone"}]

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

Extract all discrete factual claims from this source. Return a JSON array of {"text": "...", "anchor": "..."} objects, or [] if no checkable assertions are present.`;
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
    .map((item: { text: string; anchor?: string }) => ({
      text: item.text.trim(),
      anchor: typeof item.anchor === "string" && item.anchor.trim().length > 0
        ? item.anchor.trim()
        : "full-page",
    }));
}
