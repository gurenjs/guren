import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll } from 'bun:test'

export interface TempWorkspace {
  dir: string
  cleanup: () => Promise<void>
}

/**
 * A throwaway directory for one test.
 *
 * Deliberately does *not* `process.chdir()` into it: Bun runs every test file
 * in one shared process, so the working directory is global state. A test that
 * times out keeps running, and its `finally` then chdir'd and `rm -rf`'d out
 * from under whichever test had started in the meantime — one slow test failed
 * three. Callers pass absolute paths instead.
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
 * Give `git commit` an identity for the duration of the calling file.
 *
 * The scaffolder deliberately leaves identity to the user's own `git config`,
 * and CI runners don't configure one globally the way most developer machines
 * do — so a test that commits has to supply one, or it passes only on the
 * machines that happen to have it. File-wide rather than per test: a per-test
 * restore in a `finally` runs late when that test overruns, leaving the
 * variables set for whatever ran in the meantime.
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
