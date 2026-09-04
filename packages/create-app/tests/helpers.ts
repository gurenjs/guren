import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll } from 'bun:test'

export interface TempWorkspace {
  dir: string
  cleanup: () => Promise<void>
}

/**
 * A throwaway directory for one test. Deliberately does *not* `process.chdir()`
 * into it: the working directory is global state across Bun's one test process,
 * and a timed-out test's `finally` then chdir'd and `rm -rf`'d out from under
 * whichever test had started meanwhile. Callers pass absolute paths instead.
 */
export async function createTempWorkspace(prefix: string): Promise<TempWorkspace> {
  const dir = await mkdtemp(join(tmpdir(), prefix))

  return {
    dir,
    async cleanup() {
      await rm(dir, { recursive: true, force: true })
    },
  }
}

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Guren Test',
  GIT_AUTHOR_EMAIL: 'guren-test@example.com',
  GIT_COMMITTER_NAME: 'Guren Test',
  GIT_COMMITTER_EMAIL: 'guren-test@example.com',
} as const

/**
 * Give `git commit` an identity for the duration of the calling file. The
 * scaffolder leaves identity to the user's own `git config`, which CI runners
 * do not set, so a committing test would otherwise pass only on developer
 * machines. File-wide rather than per test: a per-test restore in a `finally`
 * runs late when that test overruns.
 */
export function useGitIdentity(): void {
  const previous = Object.fromEntries(
    Object.keys(GIT_IDENTITY).map((key) => [key, process.env[key]]),
  )

  beforeAll(() => {
    Object.assign(process.env, GIT_IDENTITY)
  })

  afterAll(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}
