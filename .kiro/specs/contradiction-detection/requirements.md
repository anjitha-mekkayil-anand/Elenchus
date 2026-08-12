# Requirements — Contradiction Detection

**Feature:** spec 2 of Elenchus. The project's differentiator, and the demo shot.
**Status:** draft, 2026-08-11. Written before any implementation code exists.
**Depends on:** spec 1 (ingest loop).
**Out of scope, deliberately:** the change view (spec 3), the offline test suite (spec 4).

Numbering continues spec 1's, which ended at AC-6.2 and NF-4. Nothing here renumbers anything there.

---

## Context

Spec 1 makes new material meet old material. This spec is what happens when they disagree.

The named failure mode this spec exists to prevent is **the silent pick** — a system holds two claims that cannot both be true, and hands you whichever one it happened to retrieve, with no signal that the other exists. Every RAG pipeline does this by construction: the embedding chooses, nothing surfaces the choice, and a knowledge base that is confidently wrong is worse than one that is merely incomplete, because you stop checking it.

The orphan note (spec 1) makes a base that grows without understanding. The silent pick makes a base that *loses* understanding it already had. That is the more expensive failure, and it is invisible.

**What this spec is not.** It is not a truth engine. Elenchus does not decide which claim is right, and is specified so that it cannot. It notices, it holds both with their sources and dates, and it hands the judgement to the person who owns the base. Refusing to resolve is the feature.

---

## User stories

### US-5 — Be told when new material conflicts with what I already wrote
**As** someone ingesting over months,
**I want** a conflict with an existing page surfaced at the moment it arrives,
**so that** I find out from the system rather than from acting on the wrong one.

### US-6 — Tell "this changed" apart from "these disagree"
**As** someone whose base holds facts that legitimately change,
**I want** a rescheduled date treated differently from a disputed fact,
**so that** ordinary updates do not fill the base with false conflicts, and real conflicts are not filed away as updates.

### US-7 — Find every open disagreement without re-reading the base
**As** the owner of the base,
**I want** one place that lists what is currently in dispute,
**so that** I can work through them deliberately instead of discovering them by accident.

### US-8 — Settle a disagreement myself, and have it stay settled
**As** the only person who can actually adjudicate,
**I want** my resolution recorded and honoured,
**so that** the system stops re-raising something I have already decided — unless new material genuinely reopens it.

---

## Acceptance criteria (EARS)

### Extracting claims

- **AC-7.1** — WHEN material is written to a page, THE SYSTEM SHALL extract the discrete factual claims that material asserts, and SHALL store each with its source identifier and the source's date.
- **AC-7.2** — THE SYSTEM SHALL record, for each stored claim, the page and the location within that page where it is asserted.
- **AC-7.3** — WHERE material asserts nothing checkable — opinion, description, instruction, question — THE SYSTEM SHALL store no claim for it.
- **AC-7.4** — IF a page's content has changed outside the application, THEN THE SYSTEM SHALL re-extract that page's claims before using them in a comparison.

> **AC-7.4 exists because NF-1 is a promise.** Pages are editable in any editor, so a stored claim table can go stale. A detector reasoning from stale claims produces confident nonsense, which is the exact failure this spec is meant to prevent.

### Detecting

- **AC-8.1** — WHEN a source has been accepted and its target pages decided, THE SYSTEM SHALL compare the source's claims against the stored claims of those pages, before any edit is applied.
- **AC-8.2** — WHEN a new claim and a stored claim cannot both be true, THE SYSTEM SHALL classify the pair as a **contradiction**.
- **AC-8.3** — WHEN a new claim differs from a stored claim AND the new source states an event that accounts for the change, THE SYSTEM SHALL classify the pair as a **supersession**.
- **AC-8.4** — WHEN a new claim differs from a stored claim only in precision, scope or wording, THE SYSTEM SHALL classify the pair as **neither**, and SHALL record nothing.
- **AC-8.5** — THE SYSTEM SHALL NOT classify a pair as a supersession on the basis of recency alone.
- **AC-8.6** — IF a pair is a genuine conflict but it is uncertain whether an event accounts for it, THEN THE SYSTEM SHALL classify it as a contradiction.
- **AC-8.7** — IF it cannot be stated what would have to be false for both claims to hold, THEN THE SYSTEM SHALL classify the pair as neither.
- **AC-8.8** — THE SYSTEM SHALL record its reasoning for every pair it classifies as a contradiction or a supersession.

> **AC-8.5 through AC-8.7 are the whole difficulty of this spec, and they pull in opposite directions on purpose.**
>
> AC-8.6 defaults *toward* contradiction: a wrongly-filed supersession marks a live claim as outdated, which is the silent pick wearing a timestamp.
> AC-8.7 defaults *away from* it: a register full of non-conflicts is one nobody opens, and an ignored register is the same as no register.
> AC-8.5 stops the cheap way out. Newer is not truer — a 2026 article repeating a 2019 error is both recent and wrong. Supersession requires the source to *say* the thing changed, not merely to be more recent than what it disagrees with.

### Holding both

- **AC-9.1** — WHEN a contradiction is detected, THE SYSTEM SHALL record both claims on the affected page, each with its source and date, and SHALL NOT remove or alter the existing claim.
- **AC-9.2** — THE SYSTEM SHALL NOT select, rank, order by confidence, or otherwise present either claim as the correct one.
- **AC-9.3** — WHEN a supersession is detected, THE SYSTEM SHALL add the new claim and annotate the prior claim as superseded, naming the date and the source that superseded it, and SHALL NOT remove the prior claim.
- **AC-9.4** — WHEN a contradiction is recorded, THE SYSTEM SHALL add an entry to a contradictions register readable without running the application.
- **AC-9.5** — THE SYSTEM SHALL make an open contradiction visible on the page itself, not only in the register.

> **AC-9.5 is not redundant with AC-9.4.** A register you must remember to open is a register you will not open. The page is where the claim gets used, and a conflict is only useful at the point of use — which is the same principle the whole project is built on: *store your learnings where you will use them, not where you learned them.*

### Resolution

- **AC-10.1** — THE SYSTEM SHALL NOT resolve a contradiction automatically, including where later material agrees with one side.
- **AC-10.2** — WHEN a user resolves a contradiction, THE SYSTEM SHALL record which claim was kept, when, and the stated reason.
- **AC-10.3** — WHEN a contradiction is resolved, THE SYSTEM SHALL retain the rejected claim and its source, and SHALL NOT delete it from the page.
- **AC-10.4** — WHERE new material contradicts a claim whose contradiction was previously resolved, THE SYSTEM SHALL reopen it AND SHALL surface the prior resolution and its reason.

> **AC-10.1 is the one that will feel wrong to implement.** When two later sources agree against one earlier one, closing it automatically is one line of code and reads as helpfulness. It is the silent pick with a quorum. A majority of sources is not adjudication — it is a popularity count over whatever happened to be ingested, which is a property of the reading list, not of the world.

### The ingest record

- **AC-11.1** — WHEN an ingest detects contradictions or supersessions, THE SYSTEM SHALL name each pair in the ingest record with its classification and reasoning.
- **AC-11.2** — WHERE an ingest detects none, THE SYSTEM SHALL state in the record that claims were compared and none conflicted.

> AC-11.2 is AC-2.3's logic one layer up: *checked and clean* and *never checked* must not look the same from the outside. They have different fixes.

---

## Non-functional

- **NF-5** — Comparison SHALL be bounded by the pages retrieved for the ingest, so that cost grows with relevance and not with the size of the base.
- **NF-6** — The register and the on-page markers SHALL be plain markdown, readable and editable without the application (continues NF-1).
- **NF-7** — Contradiction detection SHALL keep a single ingest within the NF-2 budget of 60 seconds for a ~2,000-word source.
- **NF-8** — On the seeded demo corpus, THE SYSTEM SHALL record no contradiction for any pair the corpus labels a refinement or a restatement.

> **NF-8 is the only honest way to specify precision.** "No false positives" is unmeasurable in general and would be a wish, not a requirement. Against a labelled corpus it is a test that either passes or fails, and the corpus is being generated anyway as a by-product of real runs (spec 1, NF-3).

---

## Explicitly not in this spec

Truth ranking · confidence scores · auto-resolution · sweeping the whole base for conflicts outside an ingest · reconciling contradictions *within* a single source · a UI for resolution beyond a command.

---

## Open questions

- **OQ-3** — Are claims extracted at write time or at comparison time? *Resolved in `design.md`: write time.*
- **OQ-4** — What is the granularity of a claim — a sentence, or an assertion that may span several? *Resolved in `design.md`.*
- **OQ-5** — If one ingest weaves a source into two pages and the source contradicts *itself* across them, is that in scope? Currently out (see above), but it is the first thing a judge could try to break. Decide before the video, not during it.
- **OQ-6** — Does resolving a contradiction re-extract the affected claims, or annotate them in place? Affects whether AC-10.4's reopen check compares against the original claim or the resolved one.
