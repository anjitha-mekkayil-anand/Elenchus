# This project is ESM

`package.json` sets `"type": "module"` and ships `dist/cli.js` as the `elenchus` bin,
run by plain Node.

Never use `require()`, `__dirname` or `__filename` in `src/`. They do not exist in an
ES module and will throw at runtime. Use top-level `import`, and `import.meta.url` with
`fileURLToPath` where a path to the current file is needed.

This will not be caught by the test suite. Vitest and tsx both provide CJS interop, so
a `require()` passes every test and every dev run, then crashes the first time someone
runs the built CLI. It happened once, in `src/resolve.ts`, during section 7.
