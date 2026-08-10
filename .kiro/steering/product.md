# Product steering — Elenchus

Always-on context for Kiro. Read before any spec or implementation work in this repo.

## What Elenchus is

A knowledge base that **integrates** rather than **stores**.

Note apps and RAG pipelines both file what you give them and search it later. Neither reads what it already holds *at the moment new material arrives* — so the collection grows and the understanding does not.

Elenchus reads what it already knows before it writes. Named for the Socratic *elenchus*: the cross-examination that exposes the contradiction between what you have just said and what you already said.

## The operating line

> Store your learnings where you will **use** them, not where you learned them.

Notes filed by *where they came from* are notes you will not find when you need them.

## The two hard rules

1. **Weave, never replace.** Existing content is preserved on every edit. An edit that removes content is rejected by deterministic code, not by model judgement. This is not a preference — a system that integrates and can also destroy is unusable, because the owner cannot check every edit.
2. **Never pick silently.** When a new source contradicts what is written, hold both views with dates and sources. Choosing quietly is how a knowledge base becomes confidently wrong.

## The named failure mode

**The orphan note** — a new page created for material that belonged inside a page that already existed. Default to weaving. Creating a page is the exception and must be justified in the ingest record.

## Non-negotiables

- **Markdown on disk is the product; the database is bookkeeping.** Delete the DB and the knowledge survives.
- **Every decision is inspectable.** Candidates retrieved, reasoning, rejected edits — all readable without running the app. A retrieval miss and a reasoning miss look identical from outside and have different fixes.
- **Plan and apply are separate stages.** A model that decides and writes in one motion cannot be checked before it acts.
- Runs with no admin rights, no global installs beyond Node.

## Who it is for

Someone who reads a lot and wants their understanding to compound rather than their archive to grow. The design is opinionated because it comes from three years of running this loop by hand, without version control, and learning which failures actually hurt.

## Provenance — state plainly, do not bury

The **practice** is three years old. The **code** is not. No code is reused from the manual version, which is prose, not an application. First commit after 8 Aug 2026.

## Scope discipline

Out, and staying out: auth · multi-user · graph visualisation · voice · mobile · file formats beyond text, markdown and URL.

Finishing beats ambition. A small working thing outscores a large half-built one.
