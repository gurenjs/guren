import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

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
