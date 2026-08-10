# Elenchus

**A knowledge base that integrates rather than stores.**

> Named for the Socratic *elenchus* — the cross-examination that exposes the contradiction between what you have just said and what you already said.

**Status: spec stage.** No implementation yet. Built for the Ready, Spec, Ship (Kiro) hackathon; deadline 24 Aug 2026.

## The problem

Note apps and RAG pipelines both do the same thing: file what you give them, search it later. Neither reads what it already holds *at the moment new material arrives*.

So the collection grows and the understanding does not.

## What this does differently

On every ingest, Elenchus:

1. Retrieves the existing pages the new source touches
2. Decides **weave vs. new page** — defaulting to weave, because an orphan note is the failure mode
3. Applies the edits, **preserving everything already written** (enforced by deterministic code, not model judgement)
4. **Detects contradictions** with what it already holds, keeping both views dated rather than picking silently
5. Leaves a readable record of what it changed and why

## The operating line

> Store your learnings where you will **use** them, not where you learned them.

Notes filed by *where they came from* are notes you will not find when you need them.

## Provenance

The **practice** behind this is three years old — a manually maintained, LLM-written wiki. The **code** is not. No code is reused from it, because that vault is prose, not an application. First commit after 8 Aug 2026, per hackathon rules.

The design is opinionated because three years of running the loop by hand, without version control, taught which failures actually hurt.

## Specs

Spec-driven, in Kiro — specs written before any code:

- `.kiro/specs/ingest-loop/` — requirements (EARS), design, tasks
- `.kiro/steering/product.md` — always-on product context

Planned: spec 2 contradiction detection · spec 3 the change view · spec 4 offline test suite (recorded fixtures, replayed — a test asset, not a demo of the product).

## Running it

Not yet runnable.

When it is, this section will carry, per the hackathon's submission requirements: setup instructions · usage · required configuration · **API and service costs per ingest** · rate limits · testing instructions · working test credentials · attribution for third-party libraries and assets.

The app makes **real model calls** — that is the application. A separate offline test suite replays recorded runs for deterministic testing; it is `npm test`, not a demo of the product, and nothing in this repo will claim otherwise.
