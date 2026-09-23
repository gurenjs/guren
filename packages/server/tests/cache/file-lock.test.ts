import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
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

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'file-lock-'))
    lockPath = join(directory, 'key.cache.lock')
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('keeps a second caller out until the holder releases, then removes the lock', async () => {
    const events: string[] = []
    const held = Promise.withResolvers<void>()
    const first = withFileLock(lockPath, 60_000, async () => {
      events.push('first:in')
      await held.promise
      events.push('first:out')
    })
    await until(() => events.includes('first:in'))
    const second = withFileLock(lockPath, 60_000, async () => {
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
    const firstHeld = Promise.withResolvers<void>()
    const secondHeld = Promise.withResolvers<void>()
    const first = withFileLock(lockPath, 50, async () => {
      events.push('first:in')
      await firstHeld.promise
      events.push('first:out')
    })
    await until(() => events.includes('first:in'))
    const second = withFileLock(lockPath, 50, async () => {
      events.push('second:in')
      await secondHeld.promise
      events.push('second:out')
    })
    // The documented cost of a takeover: a writer stalled past the timeout overlaps the next one.
    await until(() => events.includes('second:in'))
    expect(events).toEqual(['first:in', 'second:in'])

    firstHeld.resolve()
    await first
    const third = withFileLock(lockPath, 60_000, async () => {
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
    const waiter = withFileLock(lockPath, 300, async () => {
      entered = true
    })
    await Bun.sleep(150)
    await writeFile(join(lockPath, 'owner-b'), '')
    await unlink(join(lockPath, 'owner-a'))

    // The waiter has waited past the timeout, but owner-b has held the lock for less than it.
    await Bun.sleep(200)
    expect(entered).toBe(false)
    expect(existsSync(join(lockPath, 'owner-b'))).toBe(true)

    await waiter
    expect(entered).toBe(true)
    expect(existsSync(lockPath)).toBe(false)
  })

  it('takes over an empty lock directory, which a process that died before writing its token leaves', async () => {
    await mkdir(lockPath)
    expect(await withFileLock(lockPath, 50, async () => 'ran')).toBe('ran')
    expect(existsSync(lockPath)).toBe(false)
  })
})
