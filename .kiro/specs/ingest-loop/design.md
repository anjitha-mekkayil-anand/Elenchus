# Design — Ingest Loop

Companion to `requirements.md`. Resolves OQ-1. Written before implementation, 2026-08-09.

---

## Shape

```
source in
   │
   ▼
[1] Accept ──── persist raw, hash for idempotency (AC-1.4, AC-6.1)
   │
   ▼
[2] Retrieve ── candidate pages + why each was a candidate (AC-2.x)
   │
   ▼
[3] Decide ──── per candidate: weave / skip / (else) create  (AC-3.x)
   │
   ▼
[4] Plan ────── produce edits as *additions only*, unapplied  (AC-4.1)
   │
   ▼
[5] Verify ──── reject any edit that removes content         (AC-4.2)
   │
   ▼
[6] Apply ───── all-or-nothing, then reindex                 (AC-4.4, AC-4.5)
   │
   ▼
[7] Record ──── the ingest record                            (AC-5.x)
```

**Plan and Apply are separate stages, and that is the load-bearing decision.** Step 4 produces edits without writing anything; step 5 checks them against the invariant; step 6 writes. A model that decides and writes in one motion cannot be checked before it acts. This split is also what makes AC-4.5 (all-or-nothing) achievable at all.

---

## OQ-1 resolved — retrieval

**Decision: title-and-summary matching first, embeddings only if recall proves inadequate.**

Every page carries a one-line summary maintained on write. Retrieval sends the index — titles plus summaries — to the model and asks which pages this source could touch.

| | Title + summary | Embeddings |
|---|---|---|
| Recall | Weaker on paraphrase | Better |
| Inspectable | **The candidate set is human-readable and so is the reasoning** | Opaque similarity scores |
| Demo | Judge sees *why* a page was a candidate | Judge sees a number |
| Cost to build | Hours | A day, plus a vector store |
| Fails at | Thousands of pages | — |

Chosen because at the scale that matters here (tens to low hundreds of pages) recall is not the binding constraint, and **AC-2.3 requires the candidate set to be legible.** An inspectable retrieval miss is fixable; an opaque one is a shrug. Scale is the known limit — record it in the README rather than pretending otherwise.

*Revisit if the seeded demo corpus shows retrieval misses on paraphrase. That is the trigger, not a feeling.*

---

## Storage

```
pages/           <- markdown, one file per page, the actual product (NF-1)
sources/         <- extracted source text, immutable (AC-1.4)
ingests/         <- one record per ingest, markdown (AC-5.2)
index.md         <- title + one-line summary per page, kept current (AC-4.4)
elenchus.db      <- SQLite: hashes, source metadata, page summaries, run log
```

**Markdown on disk is the product; SQLite is bookkeeping.** Delete the database and the knowledge survives. That ordering is deliberate and worth one line in the README — it is the difference between a knowledge base and an app that happens to hold text.

---

## The model interface (NF-3)

One interface, three implementations:

```
interface ModelClient {
  complete(req: ModelRequest): Promise<ModelResponse>
}
```

- `AnthropicClient` — real calls. **This is the application.**
- `RecordingClient` — wraps the real one, writes every request/response pair to `fixtures/`
- `ReplayClient` — serves from `fixtures/`, no network, no key. **Test harness only.**

**⚠ Boundary, set 2026-08-09 and not to be blurred later.** `ReplayClient` exists so the loop can be tested offline and deterministically. It is `npm test`. It is **not** a demo mode, is never shown as the app running, and is never described as such in the README or the video — the rules treat *"simulated features presented as working functionality"* as a disqualification matter, and a material gap between the demo and the real project as the same. Judges run the real thing with a supplied test credential.

**The recording client is the fixture generator**, so every real call made from day one becomes a free test case. That is the reason to build all three early — not to avoid API cost at judging time.

Every model call carries: the task, the source, the retrieved candidates, and the current content of any page being edited. **A model asked to weave without being shown the page it is weaving into will rewrite it** — that is the direct cause of AC-4.1 violations, and it is a prompt-construction rule, not a validation rule.

---

## Enforcing the invariant (AC-4.2)

The verify stage is deterministic code, not a model judgement.

An edit is `{ page, anchor, insertion }` — never a whole-file rewrite. Verify checks that the post-edit content **contains the pre-edit content as a subsequence**. If it does not, the edit is rejected and recorded.

This makes the invariant mechanically true rather than well-intentioned. It also means a weave can only add — reorganising an existing page is out of scope for this loop, and any need for it surfaces as a rejection rather than as silent damage.

*Cost: the model cannot fix a typo it notices while weaving. Accepted. Losing content is worse than keeping a typo.*

---

## Failure handling

| Failure | Behaviour |
|---|---|
| URL fetch fails | Reject at accept (AC-1.3), nothing written |
| Retrieval returns nothing | Treat as new topic (AC-2.2), not an error |
| Model returns unparseable output | Retry once, then fail the ingest whole (AC-4.5) |
| One edit fails verify | Reject that edit, record it, **continue with the rest** |
| Any edit fails to write | Roll back all writes in the ingest (AC-4.5) |

Note the deliberate asymmetry: a **rejected** edit (invariant violation) does not fail the ingest, because the rejection is information worth keeping. A **failed write** does, because a half-applied ingest leaves the base in a state nobody reasoned about.

---

## Stack

Node + TypeScript · SQLite (`better-sqlite3`) · markdown on disk · Vite frontend in a later spec — **this loop is CLI-first**, so it can be built, tested and demoed before any UI exists.

---

## What this design deliberately does not do

- No reorganising of existing pages — additions only
- No partial ingest — all edits apply or none write
- No embeddings until a recorded miss justifies them
- No UI

## Open

- **OQ-2 (from requirements) is still open** — verify BYO-key against the hackathon rules. Does not block this loop.
- Anchor granularity for insertions: section-level or paragraph-level? Start section-level; drop to paragraph only if weaves land in the wrong place in the demo corpus.
