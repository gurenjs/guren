/**
 * A lock file holding the writer's process id, around one read, edit and atomic rename. A lock
 * whose process is alive is waited on and then reported, never broken: breaking a live holder's
 * lock loses one of two writes after both reported success. The board store and the navigation
 * writer hold theirs here.
 */

import { link, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const LOCK_RETRY_MS = 50
/** A lock with no id in it for this long was left by a writer that died before writing one. */
const ABANDONED_MS = 5000

async function lockHolder(path: string): Promise<number | undefined> {
  const text = await readFile(path, 'utf8').catch(() => '')
  const pid = Number.parseInt(text, 10)
  return Number.isInteger(pid) && pid > 0 ? pid : undefined
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM is a live process this one may not signal.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function isAbandoned(path: string): Promise<boolean> {
  const written = await stat(path).then(
    (stats) => stats.mtimeMs,
    () => undefined,
  )
  return written !== undefined && Date.now() - written > ABANDONED_MS
}

/** Removes a lock left by `dead`, or an empty one. Moved aside first: only one of several waiters wins the rename. */
async function clearDeadLock(path: string, dead: number | undefined): Promise<void> {
  const aside = `${path}.${process.pid}`
  try {
    await rename(path, aside)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  // Another waiter cleared it and took the lock between the read and the rename: give that one back.
  if ((await lockHolder(aside)) !== dead) await link(aside, path).catch(() => undefined)
  await rm(aside, { force: true })
}

/** Runs `run` holding `<dir>/<name>`; `dir` is created git-ignored. `locked` builds the error once `waitMs` passes. */
export async function withFileLock<T>(dir: string, name: string, waitMs: number, run: () => Promise<T>, locked: (who: string) => Error): Promise<T> {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, '.gitignore'), '*\n', { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error
  })
  const path = join(dir, name)
  const deadline = Date.now() + waitMs

  for (;;) {
    try {
      await writeFile(path, `${process.pid}\n`, { flag: 'wx' })
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    // An empty lock is a writer between creating it and writing its id, so it counts as held until it is old.
    const holder = await lockHolder(path)
    if (holder === undefined ? await isAbandoned(path) : !isAlive(holder)) {
      await clearDeadLock(path, holder)
      continue
    }
    if (Date.now() >= deadline) throw locked(holder === undefined ? 'another process' : `process ${holder}`)
    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS))
  }

  try {
    return await run()
  } finally {
    await rm(path, { force: true })
  }
}
