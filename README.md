# Elenchus

**A knowledge base that integrates rather than stores.**

> Named for the Socratic *elenchus* — the cross-examination that exposes the contradiction between what you have just said and what you already said.

Built for the Ready, Spec, Ship (Kiro) hackathon.

---

## The problem

Note apps and RAG pipelines do the same thing: file what you give them, search it later. Neither reads what it already holds *at the moment new material arrives*.

So the collection grows and the understanding does not.

There is a second failure, and it is the expensive one. When a system holds two claims that cannot both be true, it hands you whichever one it happened to retrieve. The embedding chooses. Nothing tells you a choice was made. A knowledge base that is confidently wrong is worse than one that is merely incomplete, because you stop checking it.

## What it does

On every ingest:

1. Retrieves the existing pages the new source touches
2. Decides **weave vs. new page** — defaulting to weave, because an orphan note is the failure mode
3. Extracts the claims the source asserts, and the claims the target pages already hold
4. **Classifies every conflicting pair**: a contradiction, a supersession, or neither
5. Applies edits that **cannot remove what was already written** — enforced by deterministic code, not model judgement
6. Holds both sides of a contradiction, dated and sourced, and **refuses to pick**
7. Leaves a record of what it changed and why

It does not decide which claim is right. It is specified so that it cannot. Refusing to resolve is the feature.

## Why the hard part is telling *changed* from *disagrees*

A rescheduled date is not a dispute. Two sources disagreeing about a fact is not an update. Getting these backwards in either direction is costly, and they cost differently:

- Filing a real conflict as an update **silently marks a live claim outdated** — the same silent pick, wearing a timestamp
- Filing an ordinary update as a conflict fills the register with noise, and a register full of noise is one nobody opens

So the two are not given equal benefit of the doubt. Uncertainty defaults to contradiction, and **supersession has to be earned**: the source must *state* that the thing changed. Not imply it, not merely be more recent. A 2026 article repeating a 2019 error is both recent and wrong.

That rule is enforced in code, not requested of a model. A pair classified as a supersession must carry a verbatim span of the source that states the change, and the span is substring-checked against the source text. If it is not literally there, the classification is demoted to contradiction.

The same shape applies one level up: any pair claimed as a conflict must carry a *falsifier* — the specific thing that would have to be false for both claims to hold. Missing falsifier, no conflict. Both gates are code decisions with tests, not instructions in a prompt.

---

## Setup

Requires **Node 20+**. No admin rights, no global installs, no database server.

```bash
git clone https://github.com/anjitha-mekkayil-anand/Elenchus.git
cd Elenchus
npm install
npm run build
```

Set an Anthropic API key:

```bash
export ANTHROPIC_API_KEY=sk-ant-...     # macOS / Linux
setx ANTHROPIC_API_KEY sk-ant-...       # Windows
```

**A working test credential is supplied with the hackathon submission form**, per §15/§17. No key is committed to this repository, and none ever will be — see `.env.example`.

## Usage

```bash
npm run seed                       # copy the demo corpus into pages/ and build the index
npm start -- ingest <path|url>     # ingest a source
npm start -- resolve CD-001 --keep B --reason "why"
```

`npm start` runs the built CLI (`node dist/cli.js`). Installing the package globally gives you `elenchus` directly.

### Seeing it work

Three sources are committed under `examples/`, one for each behaviour.

```bash
npm run seed

npm start -- ingest examples/food-safety-update.md
# The seed corpus says bacteria multiply rapidly between 4 °C and 60 °C.
# This source says 5 °C to 63 °C, and never says anything changed.
# → contradiction. Both claims held on the page, dated and sourced.

npm start -- ingest examples/poultry-temperature-revision.md
# This one states that the figure was revised, in 2024, from 82 °C to 74 °C.
# → supersession. The prior claim is annotated, not removed, and no
#   entry is added to the register — a settled change is not an open question.

npm start -- ingest examples/fermentation-timing.md
# "14 days" against a stored "about two weeks".
# → nothing. Precision is not disagreement.
```

Then open `pages/food-safety.md`, `pages/cooking-basics.md` and `contradictions.md`.

The difference between the first two is the whole project. One source disagrees and one source *reports a change*, and only the second is allowed to retire what came before — a rule enforced in code, not requested of a model: a supersession must quote the sentence stating the change, and that quote is checked against the source text.

Everything is plain markdown on disk. You do not need this application to read what it produced — which is the point, and also how you verify it did what it says.

## Configuration

| | |
|---|---|
| `ANTHROPIC_API_KEY` | Required. No fallback, no offline mode — the app fails with a clear message if absent |
| Model | `claude-opus-5` |
| `pages/` | The knowledge base. Markdown, hand-editable |
| `sources/` | Extracted source text, never modified after ingest |
| `ingests/` | One readable record per ingest |
| `contradictions.md` | The register: open first, resolved after |
| `index.md` | Title and one-line summary per page |
| `elenchus.db` | SQLite — hashes, claims, contradictions, run log |

**Markdown is the product; SQLite is bookkeeping.** Delete the database and the knowledge survives, because contradictions are written on the pages, not only in a table.

Pages are meant to be edited by hand. If a page changes outside the app, its stored claims are re-derived on next use rather than trusted — a detector reasoning from stale claims produces confident nonsense, which is the failure this project exists to prevent.

## Cost and rate limits

Real model calls. There is no simulated mode.

| | |
|---|---|
| Model | `claude-opus-5` |
| API calls per ingest | ~7 (retrieve, decide, extract source, extract page, compare, plan) |
| Tokens per ingest | ~7,900 in · ~2,100 out |
| Approximate cost per ingest | **~$0.28** |
| Rate limits | Whatever your Anthropic account tier allows. This application adds no limiting of its own and makes calls sequentially |

Costs scale with the source and with how many pages it touches. Comparison is bounded to the pages an ingest actually writes to, so cost grows with relevance rather than with the size of the base.

## Testing

```bash
npm test        # 177 tests, no network required
```

The suite runs offline against **recorded fixtures**: real API responses captured during development and replayed deterministically.

**This is a test asset, not a demo of the product, and it is never presented as the application running.** The application makes real calls; that is the only mode it has. The replay client is not reachable from the CLI — nothing in the shipped path can select it.

Some tests use stubbed model responses to prove the classifier's gates behave: that a conflict with no falsifier is demoted, that a supersession whose evidence is not in the source is demoted, and that one with verbatim evidence survives. The last two exist as a pair on purpose — either alone would pass against a gate that always demoted, or never did.

---

## How Kiro was used

Spec-driven, and the specs came first every time.

`.kiro/specs/` holds requirements (EARS), design, and a task list per feature, each written before its implementation. `.kiro/steering/` holds always-on context. Both are tracked in the repository; the spec trail *is* the development history.

| Spec | Content | PRs |
|---|---|---|
| `ingest-loop/` | Accept → retrieve → decide → plan → verify → apply → record | #1–#10 |
| `contradiction-detection/` | Claim extraction, staleness, classification, representation, resolution | #11–#17 `[UPDATE]` |

Each section ran through Kiro's spec-to-task cycle: requirements and design, then a generated task list referencing the acceptance criteria each task satisfies, then implementation one section per pull request.

### What that actually bought

Mistakes still happened. Specs made them collide visibly instead of compounding quietly.

Three examples, all kept in the record rather than tidied away:

**A design that was right in principle and wrong in its artefact.** The design claimed contradiction handling composed with the invariant protecting existing content, needing no new machinery. It did not. The supersession annotation was specified as an inline append to the claim's own line, and the invariant check requires every existing line to survive *verbatim* — so the verify gate would have rejected it. Moving the annotation to its own line fixed it with no change to the gate. Found by the agent implementing the spec, not by the person who wrote it.

**A crash that passed 148 tests.** A `require()` in a `"type": "module"` project. Vitest and tsx both provide CJS interop; plain Node does not. It passed every test and every dev run, and would have thrown on the first command a judge ran. The steering file added afterwards records *why the tests could not catch it*, which is the part that would otherwise be relearned.

**Two specification clauses that could not both hold.** One section was built under "nothing deletes a claim", with a foreign key enforcing it. A later task said re-extraction "replaces the stale rows". Replacing means deleting, and deleting a claim cited by a contradiction fails on that key. The constraint surfaced the conflict at design time rather than letting a cascade quietly delete the evidence behind a recorded contradiction.

Every pull request was reviewed against its diff rather than its summary. That mattered: the summaries were consistently accurate about what had been done and quiet about what had been decided along the way.

---

## Real-world value

This is not a hypothetical user.

The practice behind Elenchus is three years old — a manually maintained, LLM-written wiki of roughly 185 pages, with a weekly consistency check and a monthly sweep for contradictions between pages. The design is opinionated because running that loop by hand, without version control, taught which failures actually hurt:

- **The orphan note** — a new page created for material that belonged inside one that already existed. The collection grows; the understanding does not.
- **The silent pick** — two incompatible claims held at once, with whichever one surfaced today treated as the answer.
- **Destructive edits** — the reason the invariant is enforced by code. An integrating system that can also destroy is unusable, because you cannot check every edit.

The monthly contradiction sweep is the specific job this automates. Done by hand it is slow, and it only finds what you thought to look for. Done at ingest, it happens at the one moment the comparison is cheap: when the new material is already in front of you.

## Provenance

The **practice** is three years old. The **code** is not.

No code is reused from that vault, because it is prose, not an application. First commit 10 Aug 2026, within the competition period. Stating this plainly seemed better than leaving it to be discovered.

## Scope — what was deliberately left out

Named, because an unnamed cut looks like an unfinished feature:

Authentication · multi-user · graph visualisation · voice input · mobile · embeddings-based retrieval · file formats beyond text, markdown and URL · reconciling a source against itself · confidence scores.

Two of those were considered and rejected rather than skipped:

**Embeddings.** Retrieval matches on titles and one-line summaries and asks the model which pages a source could touch. Embeddings have better recall on paraphrase. They were rejected because the candidate set has to be legible: an inspectable retrieval miss can be fixed, an opaque one is a shrug. This limits scale to hundreds of pages rather than thousands, which is the honest trade and is recorded rather than hidden.

**Confidence scores.** A number invites ranking, and ranking is exactly what the system must not do to two claims it is holding open.

## Known limitations

Found while building, and left in rather than papered over:

**Related conflicts are not grouped.** Each claim pair is classified on its own, so one disagreement a human would read as a single thing can produce two entries. The demo's temperature conflict does exactly this: the range itself, and a holding-time rule stated over that range. Both are genuine; grouping them is a feature, not a fix.

**A supersession annotation sits at the end of its section**, not beside the claim it annotates. Claims are deliberately restated to stand alone, so a claim's wording usually does not appear on the page and cannot be located there. The annotation quotes the claim it supersedes, so it reads correctly at a distance.

**Reopening a resolved contradiction matches on claim identity.** If the page was hand-edited and its claims re-derived in the meantime, that link breaks and the disagreement is raised as new rather than reopened with its history.

**Page claims carry coarse attribution.** Material woven in by an ingest is attributed to its source; content that was already there is attributed to the seed corpus. The citation left on the page by an earlier ingest is not yet read back to attribute more precisely.

**Retrieval matches on titles and summaries**, so this works at the scale of hundreds of pages, not thousands. See above for why that trade was taken.

## Attribution

| | |
|---|---|
| [`@anthropic-ai/sdk`](https://github.com/anthropics/anthropic-sdk-typescript) | Model calls |
| [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) | Storage |
| [`commander`](https://github.com/tj/commander.js) | CLI |
| [`vitest`](https://vitest.dev), [`tsx`](https://github.com/privatenumber/tsx), [`typescript`](https://www.typescriptlang.org) | Development |

The demo corpus in `demo-pages/` was written for this project.

Built with [Kiro](https://kiro.dev).
