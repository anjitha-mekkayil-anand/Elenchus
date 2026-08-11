# Tasks — Ingest Loop

From `requirements.md` + `design.md`. Target: **ingest loop working end to end by Wed 13 Aug.**

Each task names the acceptance criteria it satisfies. A task is done when its criteria demonstrably hold — not when the code compiles.

---

## 1. Skeleton

- [x] **1.1** Node + TypeScript project; `tsconfig`, scripts, `.gitignore` (must ignore `.env`, `elenchus.db`, `pages/`, `sources/`, `ingests/` for local runs)
- [x] **1.2** CLI entry: `elenchus ingest <path|url>`, `elenchus index`
- [x] **1.3** SQLite schema — sources, pages, ingests, edits — with `better-sqlite3`
- [x] **1.4** On-disk layout created on first run: `pages/`, `sources/`, `ingests/`, `index.md`
  - *Satisfies NF-1, NF-4*

## 2. Accept

- [x] **2.1** Read plain text / markdown from a path → **AC-1.1**
- [x] **2.2** Fetch a URL and extract readable text → **AC-1.2**
- [x] **2.3** Reject empty / no-extractable-text with a stated reason, writing nothing → **AC-1.3**
- [x] **2.4** Persist raw extracted text to `sources/`, write-once → **AC-1.4**
- [x] **2.5** Content hash → duplicate detection; `--force` flag records a forced run → **AC-6.1, AC-6.2**

> Ship 2.1 and 2.4 before anything else. Everything downstream needs a source on disk to work against.

## 3. Model interface

- [ ] **3.1** `ModelClient` interface + `AnthropicClient` → **NF-3**
- [ ] **3.2** `RecordingClient` wrapper writing request/response pairs to `fixtures/`
- [ ] **3.3** `ReplayClient` reading from `fixtures/`, no network — **test harness only, never presented as the app running** (see the boundary note in `design.md`)
  - *Build 3.2 and 3.3 now, not later — every real call made from today onward becomes a free fixture. The reason is deterministic tests, not avoiding API cost at judging time; judges get a working test credential instead.*

## 4. Retrieve

- [ ] **4.1** Maintain title + one-line summary per page; keep current on write
- [ ] **4.2** Send the index to the model; get back candidates **with a reason each** → **AC-2.1, AC-2.3**
- [ ] **4.3** No candidates above threshold → new-topic path, not an error → **AC-2.2**

## 5. Decide

- [ ] **5.1** Per candidate: weave / skip, with reasoning → **AC-3.1**
- [ ] **5.2** Create a new page only when no candidate can hold the material → **AC-3.2**
- [ ] **5.3** On create, record the rejected candidates and why → **AC-3.3**
- [ ] **5.4** Allow one source to weave into several pages in one run → **AC-3.4**

## 6. Plan

- [ ] **6.1** Emit edits as `{ page, anchor, insertion }` — additions only, nothing applied yet
- [ ] **6.2** **Include the full current page content in the weave prompt** — the prompt-construction rule from `design.md`; omitting it is the direct cause of rewrite-instead-of-weave
- [ ] **6.3** Citation of the source attached to added material → **AC-4.3**

## 7. Verify — the invariant

- [ ] **7.1** Deterministic check: post-edit content contains pre-edit content as a subsequence → **AC-4.2**
- [ ] **7.2** Rejected edits recorded, ingest **continues** → *the deliberate asymmetry in `design.md`*
- [ ] **7.3** Unit tests, adversarial: an edit that truncates, one that reorders, one that "fixes" a typo, one that rewrites a heading. **All four must be rejected.**
  - *Satisfies **AC-4.1**, the hard invariant. **Do not move past section 7 until 7.3 is green.** Every later feature writes through this gate; if it leaks, it leaks everywhere and silently.*

## 8. Apply

- [ ] **8.1** Write all edits, or none → **AC-4.5**
- [ ] **8.2** Rebuild `index.md` from current pages → **AC-4.4**
- [ ] **8.3** Retry-once-then-fail on unparseable model output

## 9. Record

- [ ] **9.1** Write `ingests/<timestamp>-<slug>.md`: source, candidates + reasons, decisions + reasoning, pages changed, rejected edits → **AC-5.1**
- [ ] **9.2** Readable as a file without running the app → **AC-5.2**

> The ingest record is not logging. It is the artefact that makes the app's judgement inspectable, and it is what gets shown in the demo video and quoted in the writeup. Write it as something a person reads.

## 10. Prove the loop

- [ ] **10.1** Seed 3–4 short pages by hand as a starting base
- [ ] **10.2** Ingest a real source that **should** weave → confirm it wove, did not create
- [ ] **10.3** Ingest a real source on a genuinely new topic → confirm it created, and recorded why it rejected the candidates
- [ ] **10.4** Re-ingest 10.2's source → confirm no-op → **AC-6.1**
- [ ] **10.5** Record all of the above through `RecordingClient` — **this is the demo corpus, captured as a by-product**

---

## Done means

`elenchus ingest` handles both paths, weaves by default, cannot destroy content, leaves a readable record, and no-ops on a repeat. Fixtures exist for every run made.

**Then and only then:** spec 2, contradiction detection — the differentiator.

---

## Cut order if 13 Aug is at risk

1. **2.2** URL fetch — paste the text instead
2. **5.4** multi-page weave — one page per ingest
3. **8.3** retry logic — fail on first bad parse

**Never cut:** section 7 (the invariant) or 3.2/3.3 (the fixture clients). Section 7 is the app's one promise. 3.2/3.3 are what make the loop testable at all, and retrofitting them later costs more than building them now.
