import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, rmdir, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { withFileLock } from '../../src/cache/stores/file-lock'

async function until(condition: () => boolean): Promise<void> {
  const deadline = performance.now() + 5000
  while (!condition()) {
    if (performance.now() > deadline) throw new Error('condition not reached within 5s')
    await Bun.sleep(5)
  }
}

describe('withFileLock', () => {
  let directory: string
  let lockPath: string
  let releases: (() => void)[]
  let calls: Promise<unknown>[]

  function hold() {
    const gate = Promise.withResolvers<void>()
    releases.push(gate.resolve)
    return gate
  }

  function lock<T>(timeoutMs: number, callback: () => Promise<T>): Promise<T> {
    const call = withFileLock(lockPath, timeoutMs, callback)
    calls.push(call)
    return call
  }

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'file-lock-'))
    lockPath = join(directory, 'key.cache.lock')
    releases = []
    calls = []
  })

  // A failed assertion leaves holders and waiters running, and a waiter recreates a missing directory.
  afterEach(async () => {
    for (const release of releases) release()
    await Promise.allSettled(calls)
    await rm(directory, { recursive: true, force: true })
  })

  it('keeps a second caller out until the holder releases, then removes the lock', async () => {
    const events: string[] = []
    const held = hold()
    const first = lock(60_000, async () => {
      events.push('first:in')
      await held.promise
      events.push('first:out')
    })
    await until(() => events.includes('first:in'))
    const second = lock(60_000, async () => {
      events.push('second:in')
    })
    await Bun.sleep(50)
    expect(events).toEqual(['first:in'])

    held.resolve()
    await Promise.all([first, second])
    expect(events).toEqual(['first:in', 'first:out', 'second:in'])
    expect(existsSync(lockPath)).toBe(false)
  })

  it('takes over a lock held past the timeout, and the displaced holder does not release its successor', async () => {
    const events: string[] = []
    const firstHeld = hold()
    const secondHeld = hold()
    const first = lock(50, async () => {
      events.push('first:in')
      await firstHeld.promise
      events.push('first:out')
    })
    await until(() => events.includes('first:in'))
    const second = lock(50, async () => {
      events.push('second:in')
      await secondHeld.promise
      events.push('second:out')
    })
    // The documented cost of a takeover: a writer stalled past the timeout overlaps the next one.
    await until(() => events.includes('second:in'))
    expect(events).toEqual(['first:in', 'second:in'])

    firstHeld.resolve()
    await first
    const third = lock(60_000, async () => {
      events.push('third:in')
    })
    await Bun.sleep(50)
    expect(events).toEqual(['first:in', 'second:in', 'first:out'])

    secondHeld.resolve()
    await Promise.all([second, third])
    expect(events).toEqual(['first:in', 'second:in', 'first:out', 'second:out', 'third:in'])
  })

  it('times each holder separately, so a waiter queued behind short holds takes none of them over', async () => {
    // Token files stand in for another process's owners, handing the lock on without it ever being free.
    await mkdir(lockPath)
    await writeFile(join(lockPath, 'owner-a'), '')
    let entered = false
    const waiter = lock(600, async () => {
      entered = true
    })
    await Bun.sleep(200)
    await writeFile(join(lockPath, 'owner-b'), '')
    await unlink(join(lockPath, 'owner-a'))

    // The waiter has waited past the timeout, but owner-b has held the lock for less than it.
    await Bun.sleep(600)
    expect(entered).toBe(false)
    expect(existsSync(join(lockPath, 'owner-b'))).toBe(true)

    await unlink(join(lockPath, 'owner-b'))
    await rmdir(lockPath)
    await waiter
    expect(entered).toBe(true)
    expect(existsSync(lockPath)).toBe(false)
  })

  it('creates a missing parent directory for the lock', async () => {
    lockPath = join(directory, 'cleared', 'key.cache.lock')
    expect(await lock(60_000, async () => 'ran')).toBe('ran')
    expect(existsSync(join(directory, 'cleared'))).toBe(true)
    expect(existsSync(lockPath)).toBe(false)
  })

  it('takes over an empty lock directory, which a process that died before writing its token leaves', async () => {
    await mkdir(lockPath)
    expect(await lock(50, async () => 'ran')).toBe('ran')
    expect(existsSync(lockPath)).toBe(false)
  })

  it('takes over a directory two contenders died in, between writing their tokens and checking them', async () => {
    await mkdir(lockPath)
    await writeFile(join(lockPath, 'dead-a'), '')
    await writeFile(join(lockPath, 'dead-b'), '')
    expect(await lock(50, async () => 'ran')).toBe('ran')
    expect(existsSync(lockPath)).toBe(false)
  })
})
