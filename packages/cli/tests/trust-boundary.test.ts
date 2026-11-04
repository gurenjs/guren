import { describe, expect, it } from 'bun:test'
import type { GraphCoverage } from '../src/application-graph'
import {
  exposureBoundary,
  fixBoundary,
  orderTrustBoundary,
  renderTrustBoundary,
  responseBoundary,
  runtimeBoundary,
  type ExposureBoundaryInput,
} from '../src/trust-boundary'

const complete: GraphCoverage = { status: 'complete', reasons: [] }

function exposure(overrides: Partial<ExposureBoundaryInput> = {}): ExposureBoundaryInput {
  return {
    coverage: { tree: complete, imports: complete, placement: complete, graph: complete },
    consistency: 'stable',
    lockfile: 'bun.lock',
    framework: 0,
    unknown: 0,
    unhashed: 0,
    unresolved: [],
    ...overrides,
  }
}

describe('runtimeBoundary', () => {
  it('names the advisory source only when the runtime was checked', () => {
    expect(runtimeBoundary(undefined)).toEqual([{ from: 'runtime', message: 'The Bun runtime was not checked against its advisories in this run.' }])

    const unavailable = runtimeBoundary({ coverage: { status: 'unavailable', reasons: [{ code: 'advisories-unavailable', message: "oven-sh/bun's advisories could not be read (offline)." }] } })
    expect(unavailable.map((entry) => entry.message)).toEqual(["The Bun runtime was not checked: oven-sh/bun's advisories could not be read (offline)."])

    const checked = runtimeBoundary({ coverage: { status: 'partial', reasons: [{ code: 'inexact-version', message: 'Dockerfile:1 oven/bun:1 names no single Bun release, so it is not matched.', file: 'Dockerfile' }] } })
    expect(checked[0]!.message).toContain("oven-sh/bun's repository advisories only")
    expect(checked[1]).toEqual({ from: 'runtime', message: 'Dockerfile:1 oven/bun:1 names no single Bun release, so it is not matched.', file: 'Dockerfile' })
  })
})

describe('exposureBoundary', () => {
  it('lists only what the run read: framework packages, partial readers, a changed snapshot and the lockfile', () => {
    expect(exposureBoundary(exposure()).map((entry) => entry.from)).toEqual(['lockfile'])

    const entries = exposureBoundary(exposure({
      framework: 3,
      unknown: 1,
      unhashed: 2,
      unresolved: [{ from: 'controller:OAuthController', relation: 'validates', target: 'CallbackQuerySchema', reason: 'unresolved-validator' }],
      consistency: 'changed',
      coverage: {
        tree: complete,
        imports: { status: 'partial', reasons: [{ code: 'not-installed', message: 'app/x.ts:3 imports nope, which no installed package or app file answers.', file: 'app/x.ts' }] },
        placement: complete,
        graph: complete,
      },
    }))
    expect(entries.map((entry) => entry.from)).toEqual(['framework', 'graph', 'graph', 'imports', 'snapshot', 'lockfile'])
    expect(entries[0]!.message).toStartWith('3 installed packages are reached by no app import except through @guren packages')
    expect(entries[2]!.message).toBe('validates from controller:OAuthController to CallbackQuerySchema is unresolved: unresolved-validator')
    expect(entries[1]!.message).toStartWith('1 installed package is attributed to no route')
    expect(entries.at(-1)!.message).toBe('Bun checks the integrity hashes in bun.lock at install; Guren reads the lockfile as written. 2 entries carry no hash (workspace, file: or link: packages).')
  })

  it('claims no lockfile integrity when no lockfile was read', () => {
    expect(exposureBoundary(exposure({ lockfile: null }))).toEqual([])
  })
})

describe('responseBoundary and fixBoundary', () => {
  it('lists each unread response value with where it is', () => {
    expect(responseBoundary([{ file: 'app/C.ts', line: 7, where: 'C.show', expression: 'lookup(id)', reason: 'the reader could not follow this value' }]))
      .toEqual([{ from: 'response', message: 'C.show lookup(id): the reader could not follow this value, so it is not judged safe.', file: 'app/C.ts', line: 7 }])
    expect(responseBoundary([])).toEqual([])
  })

  it('lists a candidate fix with its reason, and says so when fixes were not proposed', () => {
    const advisory = { package: 'js-yaml', ghsa: 'GHSA-AAAA-BBBB-CCCC' }
    expect(fixBoundary([], true)).toEqual([])
    expect(fixBoundary([advisory], false)).toEqual([{ from: 'fix', message: 'No fix was proposed for the advisories (--no-fix).' }])
    expect(fixBoundary([{ ...advisory, fix: { status: 'verified', steps: [] } }], true)).toEqual([])
    expect(fixBoundary([{ ...advisory, fix: { status: 'candidate', reason: 'bun.lock could not be copied.', steps: [] } }], true))
      .toEqual([{ from: 'fix', message: 'js-yaml (GHSA-AAAA-BBBB-CCCC): the fix is a candidate, not verified: bun.lock could not be copied.' }])
  })
})

describe('renderTrustBoundary', () => {
  it('orders by source, caps each source and prefixes a file the message does not open with', () => {
    const entries = orderTrustBoundary([
      { from: 'lockfile', message: 'L' },
      ...responseBoundary([1, 2, 3].map((line) => ({ file: 'app/C.ts', line, where: 'C.show', reason: 'unread' }))),
      { from: 'runtime', message: 'R' },
    ])
    expect(renderTrustBoundary(entries, 2)).toEqual([
      'What these results rest on without checking:',
      '  runtime: R',
      '  response: app/C.ts:1 C.show: unread, so it is not judged safe.',
      '  response: app/C.ts:2 C.show: unread, so it is not judged safe.',
      '  response: and 1 more (--json lists them under trustBoundary)',
      '  lockfile: L',
    ])
    expect(renderTrustBoundary([])).toEqual([])
  })
})
