# Design — Contradiction Detection

Companion to `requirements.md`. Resolves OQ-3 and OQ-4. Written before implementation, 2026-08-11.

---

## Where it sits in the loop

Spec 1's pipeline, with two stages inserted between Decide and Plan:

```
[1] Accept
[2] Retrieve
[3] Decide ───── target pages chosen
   │
   ▼
[3a] Extract ─── claims asserted by the source            (AC-7.1)
   │
   ▼
[3b] Compare ─── source claims × stored claims on targets (AC-8.x)
   │
   ▼
[4] Plan ─────── edits now also carry both-views blocks
                 and supersession annotations              (AC-9.x)
[5] Verify
[6] Apply
[7] Record ───── + register entry                          (AC-9.4, AC-11.x)
```

**It goes after Decide, not after Retrieve.** Comparison needs to know which pages are actually being written to. Retrieval deliberately over-fetches — AC-2.3 requires it to surface pages it considered and rejected — and comparing against rejected candidates would generate conflicts on pages this ingest is not touching, which is noise the register cannot absorb (NF-8).

**It goes before Plan, not after Apply.** A contradiction changes *what edit gets written*, so it cannot be a post-hoc sweep. Detecting after the fact would mean writing the new claim as though it were uncontested and then annotating it, which is a silent pick that gets corrected — and if the annotation step fails, a silent pick that does not.

---

## OQ-3 and OQ-4 resolved — claims

**Decision: extract at write time, at assertion granularity, stored in SQLite against a page hash.**

A claim is one assertion that could be true or false, held in its own words — not a sentence, and not a paragraph. One sentence can carry two claims ("the exam moved to 3 Sep and prep has not started"); one claim can span three sentences of qualification. Sentence-splitting is cheaper and produces claims that are individually meaningless, which makes every comparison a coin toss.

| | Extract at write time | Extract at compare time |
|---|---|---|
| Cost per ingest | One pass over new material | One pass over every candidate page, every time |
| Cost as base grows | Flat | Grows with page size and count |
| Inspectable | **A claim table you can read** — what the system thinks each page asserts | Nothing persists; a bad comparison leaves no evidence |
| Staleness | Real, if pages are hand-edited | None |
| Debugging | A wrong contradiction is traceable to a wrong claim | A wrong contradiction is untraceable |

Chosen for the same reason spec 1 chose title-and-summary retrieval over embeddings: **the intermediate artefact is the diagnostic.** When the detector gets something wrong, the claim table shows whether it misread the source or misjudged the pair, and those have different fixes. Without it, every failure is a shrug.

**Staleness is the cost, and AC-7.4 pays it.** Each page row carries a content hash. On retrieval, a page whose hash does not match its content has its claims re-extracted before comparison. Hand-editing is therefore supported and slightly slower, which is the correct trade for a base whose files are the product.

---

## The classification, which is the whole spec

Every pair reaching the classifier gets one of three labels. The prompt asks for them in this order, because the cheap failures are at the ends.

**1. Neither** — refinement, restatement, added qualification, different scope.
The gate is AC-8.7: *state what would have to be false for both to hold.* If that sentence cannot be written, the pair is not a conflict. This is a construction rule, not a validation rule — the same shape as spec 1's "a model asked to weave without being shown the page will rewrite it." Asking for the falsifier up front is what stops the classifier from pattern-matching "these look different" into "these disagree."

**2. Supersession** — the new source states an event that changed the fact.
The gate is AC-8.3 and AC-8.5 together: the *source* must state the change. Not the dates, not the ordering, not a judgement that the newer one sounds more current. A reschedule, a revision, a correction, a version bump — something in the text that says *this became that*. Absent it, the pair falls through to contradiction.

**3. Contradiction** — a genuine conflict with no stated event behind it.
The default for everything that is a real conflict and is not demonstrably a supersession (AC-8.6).

**The asymmetry is deliberate and is the design's main claim.** Getting *neither → contradiction* wrong costs noise. Getting *contradiction → supersession* wrong costs a live claim silently marked outdated. Those are not the same size of mistake, so they do not get the same benefit of the doubt.

### Worked examples

| Pair | Label | Why |
|---|---|---|
| "the exam is booked for 12 Aug" → "the exam is booked for 3 Sep" | **Supersession** | The later source states a reschedule. An event is named. |
| "Kiro Web requires a Pro subscription" (docs) → "Kiro Web runs on the Free plan" (observed) | **Contradiction** | Both are currently asserted, nothing says either changed. Newer does not win: the docs may be stale, or the free tier may be a temporary promotion. Holding both with sources is the only honest state. |
| "roughly 50 poems" → "53 poems" | **Neither** | Precision, not conflict. Nothing has to be false. |
| "the deadline is 23 Aug 23:59 UTC" → "the deadline is 24 Aug 05:29 IST" | **Neither** | Same instant, different frame. The falsifier test catches this; a date-diff check would not. |

That last row is the one that argues for a model classifier over string comparison.

---

## Representing it on the page

A markdown callout — renders in Obsidian, degrades to readable plain text everywhere else (NF-6):

> [!warning] Contradiction — CD-004 · open
> **A** — 2026-08-09 · `src/kiro-docs` — Kiro Web requires a Pro subscription.
> **B** — 2026-08-11 · `src/observed-signup` — Kiro Web runs on the Free plan.
> Neither source states a change. Unresolved.

Supersession is a one-line annotation, not a block — it is bookkeeping, not an open question:

`The exam is booked for 12 Aug. ~~superseded 2026-08-03 by src/reschedule-mail~~`

Both are additions. Neither removes a character of what was there.

---

## The invariant composes — no new enforcement needed

Spec 1's verify stage rejects any edit whose result does not contain the pre-edit content as a line-level subsequence. Every representation above is an insertion: the callout adds lines, the supersession annotation appends to a line's end without altering the lines around it.

So **contradiction handling cannot destroy content, and this required no new machinery.** That is the additions-only decision from spec 1 paying off one spec later, and it is the strongest argument available that the invariant was worth its cost — worth stating in the README rather than leaving for a judge to notice.

> One real constraint falls out of it. The annotation in the supersession example appends to an existing line, so the check must remain **line-level**, not character-level. This is exactly the defect caught during spec 1's build — a character-level check leaked the moment text was appended, which is when the app is doing its normal job. Spec 2 depends on that fix; a regression to character-level breaks supersession, not just tidiness.

---

## Storage

Additions to spec 1's layout:

```
contradictions.md   <- the register: open first, then resolved (AC-9.4)
```

SQLite additions:

```
claims          id · page · anchor · text · source_id · source_date · page_hash
contradictions  id · claim_a · claim_b · kind · reasoning · status
                   · resolved_keep · resolved_at · resolved_reason
```

`kind` is `contradiction` or `supersession`; supersessions are stored so AC-8.5 decisions are auditable, but only contradictions reach the register.

The ordering from spec 1 holds: **markdown is the product, SQLite is bookkeeping.** Delete the database and the contradictions survive, because they are written on the pages.

---

## Resolution

One command, no UI (out of scope):

```
elenchus resolve CD-004 --keep B --reason "signed up on the free plan and it worked"
```

Effect: the callout is rewritten to `resolved`, the kept claim is named, the rejected claim **stays on the page** with its source (AC-10.3), and the register row moves to the resolved section carrying the reason.

**Reopening (AC-10.4).** New material contradicting a resolved claim reopens the entry and surfaces the prior resolution and its reason, rather than raising a fresh one. Otherwise the same argument returns every few months with no memory that it was already had — which is the failure a knowledge base exists to prevent, reproduced inside the tool meant to prevent it.

---

## Failure handling

| Failure | Behaviour |
|---|---|
| Claim extraction returns nothing for a source | Proceed with the ingest; record that no checkable claims were found. Not an error — much material asserts nothing (AC-7.3) |
| Page hash mismatch on a candidate | Re-extract that page's claims, then compare (AC-7.4) |
| Classifier output unparseable | Retry once, then fail the ingest whole — consistent with spec 1 |
| Classifier returns a conflict with no falsifier stated | Treat as **neither** and record the rejected pair (AC-8.7) |
| Register write fails after pages are written | Roll back the whole ingest (AC-4.5). A page carrying an open contradiction that the register does not list is worse than no detection at all |
| Resolve names an unknown or already-resolved id | Reject with a stated reason, change nothing |

The last-but-one row is the one that will be tempting to soften, and should not be. A contradiction visible in only one of the two places is a base that looks checked and is not.

---

## What this design deliberately does not do

- No confidence scores — a number invites ranking, and AC-9.2 forbids ranking
- No auto-resolution, at any quorum
- No whole-base sweep — detection happens at ingest, bounded by the retrieved set (NF-5)
- No reconciliation of a source against itself (OQ-5, still open)
- No UI

---

## Open

- **OQ-5** — self-contradicting source across two pages in one ingest. Out of scope, but it is the first thing a judge could try. Decide before the video.
- **OQ-6** — does resolution re-extract or annotate in place? Determines what AC-10.4 compares against on reopen.
- **OQ-7** — Should a supersession whose event is stated by a *low-trust* source still count? There is no source-trust model and adding one is out of scope, so the current answer is yes, and the risk is a bad source retiring a good claim. The annotation is non-destructive and names the source, so it is recoverable — but say so in the README rather than leave it unnamed.
