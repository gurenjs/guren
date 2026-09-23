// A lock is a directory of token files, each written once by one acquisition
// attempt. An attempt holds the lock only when it then reads its own token alone,
// which two attempts writing into one directory cannot both do: an empty directory
// has no holder, so removing one is always safe. A waiter takes a lock over when it
// reads the same entries `timeoutMs` apart, as they were there the whole time; only
// this process's clock is read.
import { mkdir, readdir, rmdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

const POLL_MS = 5

function hasCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code
}

async function entriesOf(lockPath: string): Promise<string[] | undefined> {
  try {
    return await readdir(lockPath)
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return undefined
    throw error
  }
}

// Another attempt or FileStore.clear() got there first; rmdir reports a non-empty
// directory as ENOTEMPTY, or as EEXIST on some systems.
function ignoreRaced(error: unknown): void {
  if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].some((code) => hasCode(error, code))) throw error
}

async function remove(lockPath: string, names: string[]): Promise<void> {
  for (const name of names) await unlink(join(lockPath, name)).catch(ignoreRaced)
  await rmdir(lockPath).catch(ignoreRaced)
}

async function tryAcquire(lockPath: string): Promise<string | undefined> {
  try {
    await mkdir(lockPath)
  } catch (error) {
    if (hasCode(error, 'EEXIST')) return undefined
    if (!hasCode(error, 'ENOENT')) throw error
    // The parent may not exist yet, or FileStore.clear() removed it.
    await mkdir(dirname(lockPath), { recursive: true })
    return tryAcquire(lockPath)
  }
  const token = randomUUID()
  let held = false
  try {
    await writeFile(join(lockPath, token), '')
    const entries = await readdir(lockPath)
    held = entries.length === 1 && entries[0] === token
  } catch (error) {
    // ENOENT: another attempt or FileStore.clear() removed the directory.
    if (!hasCode(error, 'ENOENT')) throw error
  } finally {
    if (!held) await remove(lockPath, [token])
  }
  return held ? token : undefined
}

export async function withFileLock<T>(lockPath: string, timeoutMs: number, callback: () => Promise<T>): Promise<T> {
  let seen: string | undefined
  let takeOverAt = 0
  for (;;) {
    const token = await tryAcquire(lockPath)
    if (token !== undefined) {
      try {
        return await callback()
      } finally {
        // The update is already written; a lock left behind is taken over after the timeout.
        await remove(lockPath, [token]).catch(() => undefined)
      }
    }
    if (performance.now() >= takeOverAt) {
      const entries = await entriesOf(lockPath)
      if (entries === undefined) continue
      const current = entries.sort().join('/')
      if (current === seen) {
        await remove(lockPath, entries)
        seen = undefined
        continue
      }
      seen = current
      takeOverAt = performance.now() + timeoutMs
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
}
