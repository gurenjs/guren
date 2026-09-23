import { mkdir, readdir, rmdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const POLL_MS = 5

async function succeeds(operation: Promise<unknown>, ...tolerated: string[]): Promise<boolean> {
  try {
    await operation
    return true
  } catch (error) {
    if (tolerated.includes((error as NodeJS.ErrnoException).code ?? '')) return false
    throw error
  }
}

async function listEntries(lockPath: string): Promise<string[] | undefined> {
  try {
    return await readdir(lockPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

// A missing token means a waiter took the lock over, or FileStore.clear() removed the tree.
async function removeToken(lockPath: string, token: string): Promise<void> {
  if (await succeeds(unlink(join(lockPath, token)), 'ENOENT')) await succeeds(rmdir(lockPath), 'ENOENT', 'ENOTEMPTY')
}

// The lock is a directory of token files, each written once by one acquisition
// attempt; an attempt holds the lock when it reads its own token alone, which two
// attempts writing into one directory cannot both do. A waiter takes over when it
// reads the same entries `timeoutMs` apart, as they were present throughout; only
// this process's clock is read. An empty directory has no owner from this release.
export async function withFileLock<T>(lockPath: string, timeoutMs: number, callback: () => Promise<T>): Promise<T> {
  let token = ''
  let seen: string | undefined
  let takeOverAt = 0
  for (;;) {
    if (await succeeds(mkdir(lockPath), 'EEXIST')) {
      token = randomUUID()
      if (await succeeds(writeFile(join(lockPath, token), ''), 'ENOENT')) {
        const entries = await listEntries(lockPath)
        if (entries?.length === 1 && entries[0] === token) break
        await removeToken(lockPath, token)
      }
      continue
    }
    if (seen === undefined || performance.now() >= takeOverAt) {
      const entries = await listEntries(lockPath)
      if (entries === undefined) continue
      const current = entries.sort().join('/')
      if (current === seen) {
        for (const entry of entries) await succeeds(unlink(join(lockPath, entry)), 'ENOENT')
        await succeeds(rmdir(lockPath), 'ENOENT', 'ENOTEMPTY')
        seen = undefined
        continue
      }
      seen = current
      takeOverAt = performance.now() + timeoutMs
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
  try {
    return await callback()
  } finally {
    await removeToken(lockPath, token)
  }
}
