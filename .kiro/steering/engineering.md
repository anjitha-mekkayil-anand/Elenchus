# Engineering Rules

> Rule 1 restates `esm.md` in the context of the full list. Both files stay.

These were derived from defects in this repository. They are not hypothetical.

1. **ESM only.** `"type": "module"`. No `require()` anywhere. Vitest and tsx both provide CJS interop and plain Node does not, so a `require()` passes the whole test suite and crashes on first run.

2. **Built is not wired.** No component is done until it has a call site in the pipeline. A formatter imported and never called once shipped with 172 tests green.

3. **No test may assert an empty result from a live model call.** Such a test passes when the model returns nothing at all. Gate tests use stubs and include at least one discriminating pair.

4. **Seed and demo data must contain the thing being detected.** Zero findings is indistinguishable from zero problems.

5. **A rollback must roll something back.** No empty loops with explanatory comments.

6. **Fail clean with no API key.** No fallback, no demo mode, no stub client reachable from the CLI. Recorded fixtures exist only as an offline test suite.

7. **Never commit a key.** `.env.example` only.

8. **A substring word-list cannot assert a semantic property**, and must never be applied to text the user supplied. It cannot distinguish affirming a thing from denying it, and it fails on legitimate content containing the word. Assert the property structurally, or assert against this code's own literals.
