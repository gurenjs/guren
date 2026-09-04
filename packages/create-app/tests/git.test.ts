import { chmod, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'bun:test'
import { initGitRepository, isInsideGitWorkTree } from '../src/git'
import { createTempWorkspace, useGitIdentity } from './helpers'

useGitIdentity()

const originalPath = process.env.PATH ?? ''

/**
 * Put a `git` on PATH that never returns for the given subcommand. A real git
 * cannot be made to block on demand.
 */
async function stallingGitOnPath(dir: string, subcommand: string): Promise<void> {
  const shim = join(dir, 'git')
  // `trap` makes it survive SIGTERM the way a process blocked in a syscall
  // would; the sleep outlives any budget under test.
  const script = `#!/bin/sh\n[ "$1" = "${subcommand}" ] && { trap '' TERM INT; sleep 60; }\nexit 0\n`
  await writeFile(shim, script, 'utf8')
  await chmod(shim, 0o755)
  // The first exec of a freshly written file costs a few hundred milliseconds;
  // spending it here keeps it out of the budgets the tests hand the scaffolder.
  spawnSync(shim, ['--warm'], { stdio: 'pipe' })
  process.env.PATH = `${dir}:${originalPath}`
}

describe('git helpers', () => {
  afterEach(() => {
    process.env.PATH = originalPath
  })

  it('gives up on a git that never exits instead of hanging the scaffolder', async () => {
    const workspace = await createTempWorkspace('guren-create-app-git-stall-')
    try {
      await stallingGitOnPath(workspace.dir, 'commit')

      // Without the budget this call never returns, and the caller's
      // "initialize the repository manually" warning is never reached.
      expect(initGitRepository(workspace.dir, { timeoutMs: 500 }))
        .toMatchObject({ ok: false, failedStep: 'commit' })
    } finally {
      await workspace.cleanup()
    }
  })

  it('treats a work-tree probe it had to kill as "inside a repository"', async () => {
    const workspace = await createTempWorkspace('guren-create-app-git-stall-rev-parse-')
    try {
      await stallingGitOnPath(workspace.dir, 'rev-parse')

      // The caller declines `git init` on true, so an unreadable answer has to
      // decline as well rather than nest a repository in the user's checkout.
      expect(isInsideGitWorkTree(workspace.dir, { timeoutMs: 200 })).toBe(true)
    } finally {
      await workspace.cleanup()
    }
  })

  it('stays on the graceful path when there is no git at all', async () => {
    const workspace = await createTempWorkspace('guren-create-app-git-missing-')
    try {
      // An empty PATH entry leaves no `git` to find.
      process.env.PATH = workspace.dir

      // Not "inside a repository" — a missing git must not read as one, or the
      // scaffolder would silently skip git init instead of reporting it.
      expect(isInsideGitWorkTree(workspace.dir)).toBe(false)
      expect(initGitRepository(workspace.dir))
        .toEqual({ ok: false, failedStep: 'init', command: 'git init' })
    } finally {
      await workspace.cleanup()
    }
  })

  it('commits a real repository through the default budget', async () => {
    const workspace = await createTempWorkspace('guren-create-app-git-real-')
    try {
      await writeFile(join(workspace.dir, 'file.txt'), 'contents\n', 'utf8')

      expect(initGitRepository(workspace.dir)).toEqual({ ok: true })
    } finally {
      await workspace.cleanup()
    }
  })
})
