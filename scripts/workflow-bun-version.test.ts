import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { repoRoot } from './workspace-packages.ts'

/**
 * Every workflow pins its own Bun version, and nothing until now compared them.
 * They drifted: CI moved to 1.3.14 while the release gate stayed on 1.3.11, so
 * a green CI stopped being evidence that the release would be green — and the
 * v2.6.0 release found out the expensive way, with five tests failing in the
 * publish job on a commit CI had already passed. (`bun test --isolate` shares
 * one globals context per run on 1.3.11 and one per file on 1.3.14, so a test
 * that replaced `globalThis.fetch` reached the next file on the release runner
 * and nowhere else.)
 *
 * The workflows are discovered rather than listed: a new one that pins Bun is
 * covered the day it is added, which a hand-kept list cannot promise.
 */
const WORKFLOW_DIR = join(repoRoot, '.github/workflows')

/**
 * `bun-version: '1.2.3'`, list item or not, quoted or not — YAML allows both
 * spellings and a guard that only recognised one would read the other as "this
 * workflow pins nothing", which is a different (and wrong) complaint.
 * `${{ ... }}` expressions, comments, and the matrix list are excluded.
 */
const PINNED =
  /^[^\S\n]*(?:-[^\S\n]*)?bun-version:[^\S\n]*(?:(['"])([^'"]+)\1|([^\s'"#$[][^\s#]*))[^\S\n]*$/
/** `bun-version: ['1.2.3', '1.4.0']` — CI's version matrix. */
const MATRIX = /^[^\S\n]*bun-version:[^\S\n]*\[([^\]]*)\]/m

function workflowFiles(): string[] {
  return [...new Bun.Glob('*.{yml,yaml}').scanSync({ cwd: WORKFLOW_DIR })].sort()
}

/** Every literal Bun version a workflow pins, in file order. */
export function pinnedVersions(source: string): string[] {
  return source
    .split('\n')
    .map((line) => {
      const match = PINNED.exec(line)
      return match?.[2] ?? match?.[3]
    })
    .filter((version): version is string => version !== undefined)
}

/** The versions CI's matrix fans out over, in declaration order. */
export function matrixVersions(source: string): string[] {
  const list = MATRIX.exec(source)?.[1]
  if (list === undefined) return []
  return list
    .split(',')
    .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ''))
    .filter((entry) => entry.length > 0)
}

describe('workflow Bun pins', () => {
  const ci = readFileSync(join(WORKFLOW_DIR, 'ci.yml'), 'utf8')
  const matrix = matrixVersions(ci)

  it('reads a version matrix out of ci.yml', () => {
    // Everything below is measured against this, so a matrix this stops
    // recognising has to fail loudly rather than vacuously pass.
    expect(matrix.length).toBeGreaterThan(0)
  })

  // The first matrix entry, not the only one: adding a version to CI's matrix
  // is how a new Bun is trialled, and that must not turn this into the check
  // people delete.
  const primary = matrix[0]!

  it.each(workflowFiles().filter((file) => file !== 'ci.yml'))(
    '%s pins the Bun version CI tests first',
    (file) => {
      const pins = pinnedVersions(readFileSync(join(WORKFLOW_DIR, file), 'utf8'))
      for (const pin of pins) expect(pin).toBe(primary)
    },
  )

  it("ci.yml's own pins stay inside its matrix", () => {
    // `include:` entries repeat the version to attach per-version settings; a
    // value that fell out of the matrix list would configure a job that never
    // runs.
    for (const pin of pinnedVersions(ci)) expect(matrix).toContain(pin)
  })

  it('leaves no workflow installing Bun unpinned', () => {
    // A setup-bun step with no version follows whatever the action defaults to,
    // which is the same drift by a quieter route.
    const unpinned = workflowFiles().filter((file) => {
      const source = readFileSync(join(WORKFLOW_DIR, file), 'utf8')
      if (!source.includes('oven-sh/setup-bun')) return false
      return pinnedVersions(source).length === 0 && matrixVersions(source).length === 0
    })

    expect(unpinned).toEqual([])
  })
})
