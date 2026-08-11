/**
 * Plan stage — tasks 6.1–6.3
 *
 * Produces edits as { page, anchor, insertion } — additions only, nothing applied.
 * Includes the FULL CURRENT PAGE CONTENT in the weave prompt (6.2, design.md rule).
 * Attaches a citation of the source to added material (6.3, AC-4.3).
 *
 * "A model asked to weave without being shown the page it is weaving into
 *  will rewrite it — that is the direct cause of AC-4.1 violations, and it
 *  is a prompt-construction rule, not a validation rule." — design.md
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ModelClient, ModelRequest } from "./model/types.js";
import type { Decision, WeaveDecision, CreateDecision } from "./decide.js";
import { getBaseDir } from "./layout.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Edit {
  /** The page slug this edit targets. */
  page: string;
  /** Section heading or location where the insertion belongs. */
  anchor: string;
  /** The text to insert (additions only). Includes citation. */
  insertion: string;
}

export interface PlanResult {
  /** Planned edits — not yet applied. */
  edits: Edit[];
  /** Raw model responses for the ingest record. */
  rawResponses: string[];
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const WEAVE_SYSTEM_PROMPT = `You are the planning stage of a knowledge base called Elenchus.

Your job: given the FULL CURRENT CONTENT of a page and new source material, produce insertions that weave the source into the page.

Rules:
- Produce ADDITIONS ONLY. Never remove, rewrite, or reorganise existing content.
- Each edit is an insertion at a specific anchor (a section heading in the page).
- If no existing section fits, you may propose a new section heading as the anchor.
- Keep insertions concise and factual.
- The citation will be attached automatically — do not include it yourself.

Respond with a JSON array (no markdown fencing). Each element:
{"anchor": "<section heading or new heading>", "insertion": "<text to insert>"}

If the source adds nothing meaningful to this page, return an empty array: []`;

function buildWeaveMessage(
  pageContent: string,
  pageSlug: string,
  sourceText: string,
  sourceOrigin: string
): string {
  return `## Full current page content [${pageSlug}]

${pageContent}

## New source material

Origin: ${sourceOrigin}

${sourceText}

---

Produce insertions to weave the source material into this page. Return a JSON array of {anchor, insertion} objects, or [] if nothing to add.`;
}

// ---------------------------------------------------------------------------
// Citation (AC-4.3)
// ---------------------------------------------------------------------------

/**
 * Builds the citation string to attach to every insertion.
 */
function buildCitation(sourceOrigin: string): string {
  const date = new Date().toISOString().slice(0, 10);
  return `*(Source: ${sourceOrigin}, ingested ${date})*`;
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

/**
 * Reads the full content of a page from disk.
 * Returns the content or null if the page does not exist.
 */
function readPageContent(slug: string): string | null {
  const pagePath = resolve(getBaseDir(), "pages", `${slug}.md`);
  if (!existsSync(pagePath)) {
    return null;
  }
  return readFileSync(pagePath, "utf-8");
}

/**
 * Runs the plan stage for a set of decisions.
 *
 * For each weave decision: sends full page content + source to the model,
 * gets back planned insertions with citations attached.
 *
 * For create decisions: produces a single edit that creates the new page
 * with the source material as initial content.
 */
export async function plan(
  decisions: Decision[],
  sourceText: string,
  sourceOrigin: string,
  model: ModelClient
): Promise<PlanResult> {
  const edits: Edit[] = [];
  const rawResponses: string[] = [];
  const citation = buildCitation(sourceOrigin);

  for (const decision of decisions) {
    if (decision.action === "weave") {
      const result = await planWeave(
        decision,
        sourceText,
        sourceOrigin,
        citation,
        model
      );
      edits.push(...result.edits);
      rawResponses.push(result.rawResponse);
    } else if (decision.action === "create") {
      const result = planCreate(decision, sourceText, citation);
      edits.push(...result.edits);
    }
    // "skip" decisions produce no edits
  }

  return { edits, rawResponses };
}

/**
 * Plans edits for a weave decision.
 * Includes the FULL current page content in the prompt (task 6.2).
 */
async function planWeave(
  decision: WeaveDecision,
  sourceText: string,
  sourceOrigin: string,
  citation: string,
  model: ModelClient
): Promise<{ edits: Edit[]; rawResponse: string }> {
  const pageContent = readPageContent(decision.slug);

  if (pageContent === null) {
    // Page referenced but not on disk — treat as empty page
    // (shouldn't happen if pipeline is correct, but handle gracefully)
    return {
      edits: [{
        page: decision.slug,
        anchor: "(new page)",
        insertion: `${sourceText}\n\n${citation}`,
      }],
      rawResponse: "(page not found on disk — created from source)",
    };
  }

  const req: ModelRequest = {
    task: "plan",
    system: WEAVE_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: buildWeaveMessage(pageContent, decision.slug, sourceText, sourceOrigin),
      },
    ],
  };

  const response = await model.complete(req);
  const rawResponse = response.content;

  const insertions = parseInsertions(rawResponse);

  // Attach citation to each insertion (AC-4.3)
  const edits: Edit[] = insertions.map((ins) => ({
    page: decision.slug,
    anchor: ins.anchor,
    insertion: `${ins.insertion}\n\n${citation}`,
  }));

  return { edits, rawResponse };
}

/**
 * Plans edits for a create decision.
 * Creates the initial page content from the source with citation.
 */
function planCreate(
  decision: CreateDecision,
  sourceText: string,
  citation: string
): { edits: Edit[] } {
  const pageContent =
    `# ${decision.suggestedTitle}\n\n${sourceText}\n\n${citation}\n`;

  return {
    edits: [{
      page: decision.suggestedSlug,
      anchor: "(new page)",
      insertion: pageContent,
    }],
  };
}

/**
 * Parses the model's insertion response.
 * Expects a JSON array of {anchor, insertion} objects.
 */
function parseInsertions(raw: string): Array<{ anchor: string; insertion: string }> {
  let text = raw.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }

  const parsed = JSON.parse(text);

  if (!Array.isArray(parsed)) {
    throw new Error(
      `Plan: expected JSON array from model, got ${typeof parsed}`
    );
  }

  return parsed.map((item: unknown) => {
    if (
      typeof item !== "object" ||
      item === null ||
      !("anchor" in item) ||
      !("insertion" in item)
    ) {
      throw new Error(
        `Plan: each edit must have "anchor" and "insertion". Got: ${JSON.stringify(item)}`
      );
    }
    const obj = item as { anchor: string; insertion: string };
    return { anchor: obj.anchor, insertion: obj.insertion };
  });
}
