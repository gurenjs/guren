// A lock is a directory of token files, each written once by one acquisition
// attempt. An attempt holds the lock only when it then reads its own token alone,
// which two attempts writing into one directory cannot both do: an empty directory
// has no holder, so removing one is always safe. A waiter takes a lock over when it
// reads the same entries `timeoutMs` apart, as they were there the whole time; only
// this process's clock is read. An older release's lock is an empty directory, so
// the two releases do not reliably exclude each other.
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

// Best effort: whatever a failure leaves behind is taken over after the timeout.
async function remove(lockPath: string, names: string[]): Promise<void> {
  for (const name of names) await unlink(join(lockPath, name)).catch(() => undefined)
  await rmdir(lockPath).catch(() => undefined)
}

async function tryAcquire(lockPath: string): Promise<string | undefined> {
  try {
    await mkdir(lockPath)
  } catch (error) {
    if (hasCode(error, 'EEXIST')) return undefined
    if (!hasCode(error, 'ENOENT')) throw error
    // FileStore.clear() removed the parent.
    await mkdir(dirname(lockPath), { recursive: true })
    return tryAcquire(lockPath)
  }
  const token = randomUUID()
  let held = false
  try {
    await writeFile(join(lockPath, token), '')
    const entries = await entriesOf(lockPath)
    held = entries?.length === 1 && entries[0] === token
  } catch (error) {
    // ENOENT: a waiter removed the directory while it was still empty.
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
        await remove(lockPath, [token])
      }
    }
    if (seen === undefined || performance.now() >= takeOverAt) {
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
