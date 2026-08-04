import { chmod, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import { GIT_TIMEOUT_MS, initGitRepository, isInsideGitWorkTree } from '../src/git'
import { createTempWorkspace } from './helpers'

const originalPath = process.env.PATH ?? ''

/**
 * Put a `git` on PATH that never returns for the given subcommand.
 *
 * The scaffolder shells out to whatever `git` the user has, and the failure
 * this guards against — a git that blocks instead of exiting — cannot be
 * provoked from a real one on demand.
 */
async function stallingGitOnPath(dir: string, subcommand: string): Promise<void> {
  const shim = join(dir, 'git')
  await writeFile(
    shim,
    [
      '#!/bin/sh',
      'for arg in "$@"; do',
      `  if [ "$arg" = "${subcommand}" ]; then`,
      // Outlives any timeout under test, and survives SIGTERM the way a
      // process blocked in a syscall would.
      "    trap '' TERM INT",
      '    sleep 60',
      '  fi',
      'done',
      'exit 0',
    ].join('\n'),
    'utf8',
  )
  await chmod(shim, 0o755)
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

      const started = Date.now()
      // The budget covers all three steps, so leave the preceding `init`/`add`
      // room to clear — including the one-off cost Bun's first timed spawn pays.
      const result = initGitRepository(workspace.dir, { timeoutMs: 4_000 })
      const elapsed = Date.now() - started

      expect(result).toEqual({ ok: false, failedStep: 'commit' })
      // Without the timeout this call never returns; the bound is what the
      // caller's "initialize the repository manually" warning depends on.
      expect(elapsed).toBeLessThan(20_000)
    } finally {
      await workspace.cleanup()
    }
  })

  it('reports "not a work tree" rather than hanging when git stalls', async () => {
    const workspace = await createTempWorkspace('guren-create-app-git-stall-rev-parse-')
    try {
      await stallingGitOnPath(workspace.dir, 'rev-parse')

      expect(isInsideGitWorkTree(workspace.dir, { timeoutMs: 500 })).toBe(false)
    } finally {
      await workspace.cleanup()
    }
  })

  it('reports the step that failed', async () => {
    const workspace = await createTempWorkspace('guren-create-app-git-missing-')
    try {
      // An empty PATH entry leaves no `git` to find at all.
      process.env.PATH = workspace.dir

      expect(initGitRepository(workspace.dir)).toEqual({ ok: false, failedStep: 'init' })
    } finally {
      await workspace.cleanup()
    }
  })

  it('commits a real repository through the default budget', async () => {
    const workspace = await createTempWorkspace('guren-create-app-git-real-')
    try {
      await writeFile(join(workspace.dir, 'file.txt'), 'contents\n', 'utf8')

      expect(GIT_TIMEOUT_MS).toBeGreaterThan(0)
      expect(initGitRepository(workspace.dir)).toEqual({ ok: true })
    } finally {
      await workspace.cleanup()
    }
  })
})
