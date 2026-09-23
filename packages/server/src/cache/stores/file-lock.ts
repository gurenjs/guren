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

async function listTokens(lockPath: string): Promise<string[] | undefined> {
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

// A lock is a directory each contender writes its token file into; only one that
// then reads its own token alone holds it, and two writers into one directory
// cannot both. A waiter takes a lock over once it has seen the same holder at
// least `timeoutMs` apart: tokens are never reused, so that owner held it the whole
// time. Only this process's clock is read, never a file's timestamp.
export async function withFileLock<T>(lockPath: string, timeoutMs: number, callback: () => Promise<T>): Promise<T> {
  const token = randomUUID()
  let holder: string | undefined
  let takeOverAt = 0
  for (;;) {
    if (await succeeds(mkdir(lockPath), 'EEXIST')) {
      if (await succeeds(writeFile(join(lockPath, token), ''), 'ENOENT')) {
        const tokens = await listTokens(lockPath)
        if (tokens?.length === 1 && tokens[0] === token) break
        await removeToken(lockPath, token)
      }
      continue
    }
    if (holder === undefined || performance.now() >= takeOverAt) {
      const tokens = await listTokens(lockPath)
      if (tokens === undefined) continue
      // '' is an empty directory: an owner between mkdir and its token write, one that died there, or an older release's lock.
      const current = tokens.length > 1 ? undefined : tokens[0] ?? ''
      if (current !== undefined && current === holder) {
        if (current === '') await succeeds(rmdir(lockPath), 'ENOENT', 'ENOTEMPTY')
        else await removeToken(lockPath, current)
        holder = undefined
        continue
      }
      holder = current
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
