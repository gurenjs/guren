import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { repoRoot } from './workspace-packages.ts'

/**
 * Every workflow pins its own Bun version, and they drifted: CI on 1.3.14 while
 * the release gate stayed on 1.3.11, so a green CI stopped being evidence the
 * release would be green (`bun test --isolate` shares one globals context per
 * run on 1.3.11 and one per file on 1.3.14). Workflows are discovered rather
 * than listed, so a new one that pins Bun is covered the day it is added.
 */
const WORKFLOW_DIR = join(repoRoot, '.github/workflows')

/**
 * `bun-version: '1.2.3'`, list item or not, quoted or not: recognising only one
 * spelling would read the other as "this workflow pins nothing". `${{ ... }}`
 * expressions, comments, and the matrix list are excluded.
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
    // Everything below is measured against this, so an unrecognised matrix has
    // to fail loudly rather than vacuously pass.
    expect(matrix.length).toBeGreaterThan(0)
  })

  // The first entry, not the only one: adding a version is how a new Bun is
  // trialled, and that must not turn this into the check people delete.
  const primary = matrix[0]!

  it.each(workflowFiles().filter((file) => file !== 'ci.yml'))(
    '%s pins the Bun version CI tests first',
    (file) => {
      const pins = pinnedVersions(readFileSync(join(WORKFLOW_DIR, file), 'utf8'))
      for (const pin of pins) expect(pin).toBe(primary)
    },
  )

  it("ci.yml's own pins stay inside its matrix", () => {
    // `include:` repeats the version to attach per-version settings; one that
    // fell out of the matrix would configure a job that never runs.
    for (const pin of pinnedVersions(ci)) expect(matrix).toContain(pin)
  })

  it('leaves no workflow installing Bun unpinned', () => {
    // An unpinned setup-bun follows the action default: the same drift, quieter.
    const unpinned = workflowFiles().filter((file) => {
      const source = readFileSync(join(WORKFLOW_DIR, file), 'utf8')
      if (!source.includes('oven-sh/setup-bun')) return false
      return pinnedVersions(source).length === 0 && matrixVersions(source).length === 0
    })

    expect(unpinned).toEqual([])
  })
})
