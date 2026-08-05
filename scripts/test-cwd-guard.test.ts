import { describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { isAllowed, strayScaffoldOutput } from './test-cwd-guard.ts'

/**
 * The guard is the thing that turns a silent, intermittent repo-pollution bug
 * into a failing test, so a guard that quietly stops detecting is worse than
 * none. Its two predicates are pure, which is what makes them testable here
 * without reaching into a lifecycle hook.
 */
describe('test-cwd-guard predicates', () => {
  const repoRoot = resolve(import.meta.dir, '..')

  describe('isAllowed', () => {
    it('accepts the directory the run started in', () => {
      expect(isAllowed(process.cwd())).toBe(true)
    })

    it('accepts a temp workspace, which tests legitimately chdir into', () => {
      expect(isAllowed(mkdtempSync(join(tmpdir(), 'guren-cwd-guard-')))).toBe(true)
    })

    it('rejects a package directory — the directory the reported stray output was rooted at', () => {
      expect(isAllowed(join(repoRoot, 'packages/cli'))).toBe(false)
    })

    it('rejects the filesystem root', () => {
      expect(isAllowed('/')).toBe(false)
    })

    it('does not treat a sibling sharing the temp-dir prefix as inside it', () => {
      expect(isAllowed(`${tmpdir()}-evil`)).toBe(false)
    })
  })

  describe('strayScaffoldOutput', () => {
    it('reports nothing for a clean checkout', () => {
      // Every watched directory is either absent or was present before the run
      // started; both mean "not this run's doing".
      expect(strayScaffoldOutput()).toEqual([])
    })
  })
})
