# Tasks — Contradiction Detection

From `requirements.md` + `design.md`. Target: **contradiction detection working end to end, demonstrable on the seeded corpus.**

Each task references the acceptance criteria it satisfies. A task is done when its criteria demonstrably hold — not when the code compiles.

Tasks marked 🤖 require real model calls (RecordingClient wraps them for fixtures). Tasks marked 🔧 are pure code or structure — no model needed.

---

## 1. Schema and storage

- [x] **1.1** 🔧 Add `claims` table to SQLite schema: `id`, `page`, `anchor`, `text`, `source_id`, `source_date`, `content_hash` → *AC-7.2*
- [x] **1.2** 🔧 Add `contradictions` table to SQLite schema: `id`, `claim_a`, `claim_b`, `kind`, `reasoning`, `status`, `resolved_keep`, `resolved_at`, `resolved_reason` → *AC-8.8, AC-10.2*
- [x] **1.3** 🔧 Create `contradictions.md` in on-disk layout (ensureLayout). Structure: open section first, then resolved section → *AC-9.4, NF-6*
- [x] **1.4** 🔧 Add `content_hash` column to the existing `pages` table. The current schema (`src/schema.ts`) has `slug`, `title`, `summary`, `created_at`, `updated_at` but no hash. Add `content_hash TEXT NOT NULL DEFAULT ''` — updated by Apply whenever a page is written. Required for AC-7.4's staleness check.

## 2. Extract — claims from source material

- [ ] **2.1** 🤖 `extractClaims(text, sourceId, sourceDate, model)` → array of `{ text }`. Send material to the model, get back discrete factual claims at assertion granularity. Claims are returned **unbound** — no page, no anchor, no hash — and held in memory for the Compare stage. → *AC-7.1*
- [ ] **2.2** 🤖 Prompt construction: instruct the model to return nothing for opinion, description, instruction, question → *AC-7.3*
- [ ] **2.3** 🔧 Unit test: a source that asserts nothing checkable produces zero claims → *AC-7.3*

## 3. Staleness — re-extract on hash mismatch

- [ ] **3.1** 🔧 On comparison, compute current page content hash and compare to stored `content_hash` on **page claims** → *AC-7.4*
- [ ] **3.2** 🤖 If the hash mismatches, re-extract that page's claims from the current file content, **persist them with the current content hash, replacing the stale rows**, then proceed with the comparison. → *AC-7.4, AC-7.2*
- [ ] **3.3** 🔧 Unit test: simulate a hand-edit (modify file, leave DB stale), verify re-extraction is triggered
- [ ] **3.4** 🔧 Unit test: after a re-extraction triggered by hand-edit, a second ingest of an unrelated source does **not** trigger re-extraction on that page again → *AC-7.4*

## 4. Compare — source claims × stored claims

- [ ] **4.1** 🤖 `compareClaims(sourceClaims, storedClaims, sourceText, model)` → array of classified pairs. Each pair gets one label: `neither`, `supersession`, `contradiction` → *AC-8.1, AC-8.2, AC-8.3, AC-8.4*
- [ ] **4.2** 🤖 Prompt construction: ask for the falsifier first (AC-8.7 gate), then event check (AC-8.3/AC-8.5 gate), then default to contradiction (AC-8.6) → *AC-8.5, AC-8.6, AC-8.7*
- [ ] **4.3** 🔧 Require and store reasoning for every contradiction or supersession → *AC-8.8*
- [ ] **4.4** 🔧 Pairs classified as `neither` are not stored (AC-8.4) unless the classifier returned a conflict with no falsifier (AC-8.7 — record as rejected pair)
- [ ] **4.5** 🔧 Comparison bounded by the pages this ingest is writing to — NOT the retrieved candidate set, NOT the whole base → *NF-5*
- [ ] **4.6** 🔧 Unit test (ReplayClient): a pair that is a refinement ("~50" vs "53") returns `neither` → *NF-8*
- [ ] **4.7** 🔧 Unit test (ReplayClient): a pair with a stated event returns `supersession` → *AC-8.3*
- [ ] **4.8** 🔧 Unit test (ReplayClient): a genuine conflict with no event returns `contradiction` → *AC-8.2*

## 5. Represent — on-page markers and register

- [ ] **5.1** 🔧 Contradiction callout format: `> [!warning] Contradiction — CD-NNN · open` block with both claims, sources, dates → *AC-9.1, AC-9.2, AC-9.5, NF-6*
- [ ] **5.2** 🔧 Supersession annotation format: `~~superseded YYYY-MM-DD by src/slug~~` appended to the existing claim's line → *AC-9.3*
- [ ] **5.3** 🔧 Write contradiction entries to the open section of `contradictions.md` → *AC-9.4, NF-6*
- [ ] **5.4** 🔧 Unit test: contradiction callout is a line insertion (passes the line-level invariant check) → *AC-9.1, verify gate*
- [ ] **5.5** 🔧 Unit test: supersession annotation appends to an existing line without altering lines around it (passes the line-level invariant check) → *AC-9.3, verify gate*

> **Critical: supersession appends to a line. The verify-stage invariant must stay line-level, not character-level.** Spec 2 depends on the fix already applied in spec 1. Task 5.5 is the regression test that proves it still holds.

## 6. Wire into the pipeline

- [ ] **6.1** 🔧 Insert Extract stage between Decide and Plan in `cli.ts`: extract source claims (unbound) after decide, before plan → *AC-7.1, design.md pipeline*
- [ ] **6.2** 🔧 Insert Compare stage between Extract and Plan: compare source claims against stored **page** claims on target pages → *AC-8.1, design.md pipeline*
- [ ] **6.3** 🔧 Modify Plan stage: when contradictions or supersessions are detected, include callout/annotation edits in the planned edits alongside weave edits → *AC-9.1, AC-9.3, AC-9.5*
- [ ] **6.4** 🔧 After Apply, write register entries and store contradictions in SQLite → *AC-9.4*
- [ ] **6.5** 🔧 After Apply, persist **page claims** bound to page slug, anchor, and the page's content hash **as written**. These are the rows future ingests compare against. → *AC-7.2, design.md stage [6a]*
- [ ] **6.6** 🔧 Extend the ingest record to name each detected pair with classification and reasoning → *AC-11.1*
- [ ] **6.7** 🔧 Extend the ingest record: when no contradictions detected, state explicitly that claims were compared and none conflicted → *AC-11.2*
- [ ] **6.8** 🔧 Roll back the whole ingest if register write fails after pages are written → *AC-4.5, design.md failure handling*

## 7. Resolution

- [ ] **7.1** 🔧 CLI command: `elenchus resolve <id> --keep A|B --reason "..."` → *AC-10.2*
- [ ] **7.2** 🔧 On resolve: rewrite callout to `resolved`, name kept claim, retain rejected claim on page → *AC-10.2, AC-10.3*
- [ ] **7.3** 🔧 On resolve: move register entry from open to resolved section with reason → *AC-10.2*
- [ ] **7.4** 🔧 On resolve: update SQLite row (status, resolved_keep, resolved_at, resolved_reason) → *AC-10.2*
- [ ] **7.5** 🔧 Reject with stated reason if id is unknown or already resolved
- [ ] **7.6** 🔧 Unit test: resolve keeps rejected claim on page, does not delete → *AC-10.3*
- [ ] **7.7** 🔧 Unit test: resolve an unknown id → rejected, nothing changed

## 8. Reopen

- [ ] **8.1** 🔧 During Compare: if a new claim contradicts a previously-resolved claim, reopen the entry rather than creating a new one → *AC-10.4*
- [ ] **8.2** 🔧 On reopen: surface the prior resolution and its reason in the callout and the register → *AC-10.4*
- [ ] **8.3** 🤖 Unit test (ReplayClient): ingest source that contradicts a resolved claim → entry reopened, prior reason surfaced → *AC-10.4*

## 9. Auto-resolution prohibition

- [ ] **9.1** 🔧 Unit test: ingest two sources that agree with side B of an open contradiction → contradiction remains open, status unchanged → *AC-10.1*

> **This test exists because it is the failure mode. Do not pass it by not checking.**

## 10. Prove on the corpus

- [ ] **10.1** 🤖 Add a demo source to `fixtures/` that contradicts an existing seeded page (e.g. a food-safety claim)
- [ ] **10.2** 🤖 Ingest it: verify contradiction detected, callout written, register updated
- [ ] **10.3** 🤖 Add a demo source with a supersession (e.g. a rescheduled date)
- [ ] **10.4** 🤖 Ingest it: verify supersession annotation written, no register entry
- [ ] **10.5** 🤖 Add a refinement source ("~50" → "53"): verify classified as `neither`, no marker written → *NF-8*
- [ ] **10.6** 🤖 Record all runs through RecordingClient — these are the demo corpus for spec 4

---

## Done means

`elenchus ingest` detects contradictions and supersessions, holds both views on the page, maintains a readable register, and never resolves automatically. `elenchus resolve` settles one. Reopening works. Refinements produce no noise.

**Then and only then:** spec 3, the change view.

---

## Cut order if time is at risk

1. **Section 8** (reopen) — complex and AC-10.4 is deferrable to post-deadline
2. **10.3–10.5** (supersession and refinement corpus proofs) — contradiction is the headline
3. **3.1 and 3.2 together, or neither** — a half-cut (detect staleness but reason from stale claims anyway) is the worst of the three states: it is the confident-nonsense failure AC-7.4 exists to prevent, now with a detector that says nothing. If they go, state in the README that hand-edited pages are not re-checked.

**Never cut:** sections 4–6 (the detection pipeline) or section 5 (representation). Without them there is no spec 2, and the project's differentiator disappears. Section 9 (the AC-10.1 prohibition test) is one test and must not be cut — it is the spec's thesis.
