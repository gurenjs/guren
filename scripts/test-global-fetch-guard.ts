// Preloaded into `bun test` to make a leaked `globalThis.fetch` loud.
//
// Tests stub `fetch` to drive code that talks HTTP. Whether that stub can reach
// the *next* test file is a Bun implementation detail, not a promise: under
// `--isolate` Bun 1.3.14 gives each file a fresh globals context, but 1.3.11
// shares one for the whole run. On 1.3.11 an unrestored stub answered every
// later `fetch()` in the process — including the port/stop tests fetching their
// own freshly bound servers, which then read 200 where the app returns 404.
// The suite passed on the version CI pinned and failed on the version the
// release workflow pinned, which is the worst place to discover it.
//
// So the invariant is stated here rather than inherited from a runtime: a test
// file leaves `globalThis.fetch` exactly as it found it.
//
// Per file, not per test. Bun runs `afterEach` hooks innermost-first, so a
// per-test check here would fire *before* the restoring `afterEach` a
// well-behaved file already registers, and report every one of them as a leak.
// `afterAll` is also where the invariant actually bites — cross-file reach is
// the whole hazard.

import { afterAll, beforeAll } from 'bun:test'

/** What `fetch` was when this file started. */
let fileStartFetch: typeof globalThis.fetch

// Snapshotted per file rather than once for the run: on a shared-context Bun a
// process-wide baseline would blame every file downstream of the leak as well
// as the one that caused it.
beforeAll(() => {
  fileStartFetch = globalThis.fetch
})

const ADVICE = [
  '',
  '  Capture the real fetch at module scope and put it back in an afterEach:',
  '',
  '    const realFetch = globalThis.fetch',
  '    afterEach(() => { globalThis.fetch = realFetch })',
  '',
  '  Capture it at module scope, not inside a describe body — a value read',
  '  there is already whatever an earlier describe left behind, so restoring',
  '  to it re-pins the replacement instead of clearing it. `mock.restore()`',
  '  does not help: it unwinds spyOn(), not a plain assignment.',
].join('\n')

afterAll(() => {
  const current = globalThis.fetch
  if (current === fileStartFetch) return

  // Put it back before reporting, so the next file is judged on its own
  // behaviour instead of inheriting this one's.
  globalThis.fetch = fileStartFetch

  throw new Error(
    [
      'this test file replaced globalThis.fetch and did not restore it',
      `  left behind: ${describeFetch(current)}`,
      `  expected:    ${describeFetch(fileStartFetch)}`,
      ADVICE,
    ].join('\n'),
  )
})

function describeFetch(value: typeof globalThis.fetch): string {
  const source = String(value)
  return source.length > 120 ? `${source.slice(0, 120)}…` : source
}
