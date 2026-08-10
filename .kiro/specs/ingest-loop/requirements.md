# Requirements — Ingest Loop

**Feature:** the core ingest loop. Spec 1 of the project; everything else depends on it.
**Status:** draft, 2026-08-09. Written before any implementation code exists.
**Out of scope, deliberately:** contradiction detection (spec 2), the diff view (spec 3), `--demo` mode (spec 4).

---

## Context

Elenchus is a knowledge base that **integrates** rather than **stores**.

Note apps and RAG pipelines both file what you give them and search it later. Neither reads what it already holds *at the moment new material arrives*, so the collection grows and the understanding does not. The ingest loop is where that difference is made or lost: it is the only place in the system where new material meets old.

The named failure mode this loop exists to prevent is **the orphan note** — a new page created for material that belonged inside a page that already existed.

---

## User stories

### US-1 — Ingest a source
**As** someone who has just read something worth keeping,
**I want** to hand the text to Elenchus,
**so that** what I already know is updated by it, rather than a new note being added next to it.

### US-2 — See what it decided and why
**As** the owner of the knowledge base,
**I want** every ingest to leave a record of which pages it touched and on what reasoning,
**so that** I can trust the edits without re-reading every page.

### US-3 — Never lose what was already written
**As** someone whose knowledge base has no version history,
**I want** existing content preserved when new content is woven in,
**so that** an ingest can never be the reason something is gone.

### US-4 — Not re-ingest the same thing twice
**As** someone who ingests over months,
**I want** an already-processed source recognised,
**so that** re-running does not duplicate pages or double-count claims.

---

## Acceptance criteria (EARS)

### Accepting a source

- **AC-1.1** — WHEN a user submits plain text or markdown, THE SYSTEM SHALL accept it as a source and assign it a stable source identifier.
- **AC-1.2** — WHEN a user submits a URL, THE SYSTEM SHALL fetch and extract its readable text before treating it as a source.
- **AC-1.3** — IF a submitted source is empty or contains no extractable text, THEN THE SYSTEM SHALL reject it with a stated reason and SHALL NOT create or modify any page.
- **AC-1.4** — WHEN a source is accepted, THE SYSTEM SHALL persist the original extracted text unmodified, and SHALL NOT edit or delete it thereafter.

### Retrieving what is already known

- **AC-2.1** — WHEN a source has been accepted, THE SYSTEM SHALL retrieve the existing pages most likely to be affected by it, before generating any edit.
- **AC-2.2** — WHERE no existing pages are retrieved above the relevance threshold, THE SYSTEM SHALL treat the source as opening a new topic.
- **AC-2.3** — THE SYSTEM SHALL make the retrieved candidate set visible in the ingest record, including pages it considered and did not edit.

> **Design note, not a requirement:** AC-2.3 exists because a retrieval miss and a reasoning miss look identical from the outside, and they have different fixes. This is the single most useful diagnostic in the system.

### Deciding weave vs. create

- **AC-3.1** — WHEN candidate pages have been retrieved, THE SYSTEM SHALL decide, per candidate, whether the source's material belongs inside that page.
- **AC-3.2** — THE SYSTEM SHALL default to weaving into an existing page, and SHALL create a new page only where no retrieved page can hold the material.
- **AC-3.3** — WHEN the system creates a new page, THE SYSTEM SHALL record which candidates it rejected and why.
- **AC-3.4** — THE SYSTEM SHALL be capable of weaving one source into more than one page in a single ingest.

### Applying edits

- **AC-4.1** — WHEN weaving into an existing page, THE SYSTEM SHALL preserve all existing content and SHALL NOT replace, truncate or silently rewrite it.
- **AC-4.2** — IF an edit would remove existing content, THEN THE SYSTEM SHALL reject that edit and record the rejection.
- **AC-4.3** — WHEN a page is edited, THE SYSTEM SHALL cite the source on the material it added.
- **AC-4.4** — WHEN all edits for an ingest have been applied, THE SYSTEM SHALL update the index so that it reflects current content.
- **AC-4.5** — IF any edit in an ingest fails to apply, THEN THE SYSTEM SHALL leave all pages in that ingest unchanged and SHALL report the failure.

> **AC-4.1 and AC-4.2 are the hard invariant.** They come from three years of running this by hand without version control: an integrating system that can also destroy is not usable, because you cannot check every edit. Weave or append — never replace.

### The ingest record

- **AC-5.1** — WHEN an ingest completes, THE SYSTEM SHALL write a record containing: the source identifier, the candidates retrieved, the weave/create decision per candidate with its reasoning, the pages changed, and any rejected edits.
- **AC-5.2** — THE SYSTEM SHALL make the ingest record readable without running the application.

### Idempotency

- **AC-6.1** — WHEN a source is submitted whose content matches one already ingested, THE SYSTEM SHALL report it as already processed and SHALL NOT modify any page.
- **AC-6.2** — WHERE the user explicitly forces re-ingest, THE SYSTEM SHALL proceed and SHALL record that the run was forced.

---

## Non-functional

- **NF-1** — Pages SHALL be stored as markdown files on disk, readable and editable without the application. *A knowledge base you can only read through its own UI is a lock-in, and a judge cannot verify it worked.*
- **NF-2** — A single ingest of a ~2,000-word source SHALL complete in under 60 seconds on a normal connection.
- **NF-3** — All model calls SHALL be routed through one interface, so that recorded responses can be replayed **in the test suite** without touching loop logic.
  > ⚠ **Scope of NF-3, corrected 2026-08-09 after reading the full hackathon rules.** Replay exists to make the loop *testable offline*. It is **not** a substitute for the application and must never be presented as the app working — the rules forbid *"simulated or hard-coded features presented as working functionality"* and treat a material difference between the demo and the real project as grounds for disqualification. The primary path is real model calls; judges are given a **working test credential** (§15/§17), which is the mechanism the rules actually provide for the no-payment requirement.
- **NF-4** — THE SYSTEM SHALL run with no admin rights and no global installs beyond Node.

---

## Explicitly not in this spec

Contradiction detection · the diff/changelog UI · `--demo` mode · auth · multi-user · graph visualisation · voice · file formats beyond text, markdown and URL.

Contradiction detection is spec 2 and is the project's differentiator — but it cannot be built before there is something to contradict. NF-3 exists so the offline test suite does not require rework here.

---

## Open questions

- **OQ-1** — Retrieval method for AC-2.1: embeddings, or index-and-title matching with a model pass? Embeddings are better at recall; titles are inspectable and cheaper to demo. **Resolved in `design.md`: title + summary first.**
- **OQ-2** — ✅ **RESOLVED 2026-08-09 against the full rules.** BYO key is fine, and real API calls are expected. The no-payment requirement (§17) is satisfied by supplying **working test credentials** with the submission, not by faking the model. The README must document API cost and rate limits (§15). Keys never go in the repository (§13). Consequence for this spec: none structural — only NF-3's stated purpose narrowed to *testing*.
