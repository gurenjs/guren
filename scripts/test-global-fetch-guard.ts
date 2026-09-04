// Preloaded into `bun test` to make a leaked `globalThis.fetch` loud: a test
// file leaves `globalThis.fetch` exactly as it found it.
//
// Whether a stub reaches the next file is a Bun detail, not a promise — under
// `--isolate` 1.3.14 gives each file fresh globals, 1.3.11 shares one context
// for the run, so the suite passed on CI's pin and failed on the release
// workflow's. Per file, not per test: Bun runs `afterEach` innermost-first, so
// a per-test check would fire before a well-behaved file's own restore.

import { afterAll, beforeAll } from 'bun:test'

/** What `fetch` was when this file started. */
let fileStartFetch: typeof globalThis.fetch

// Per file rather than once per run: a process-wide baseline would blame every
// file downstream of the leak as well as the one that caused it.
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

  // Back before reporting, so the next file is judged on its own behaviour.
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
