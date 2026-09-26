import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FileStore } from '../../src/cache/stores/FileStore'

describe('FileStore expired entries under concurrent writers', () => {
  let directory: string
  let store: FileStore
  let now: number
  let pauses: Map<number, () => Promise<void>>

  // Parks the `call`-th file read (1-based) after it has read the file, until the returned release runs.
  // cleanup() reads each file unlocked (read 1), then again once moved aside (read 2).
  function pauseRead(call: number): { reached: Promise<void>; release: () => void } {
    const reached = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    pauses.set(call, async () => {
      reached.resolve()
      await gate.promise
    })
    return { reached: reached.promise, release: gate.resolve }
  }

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'file-store-expiry-'))
    now = 1000
    store = new FileStore({ path: directory, now: () => now })
    pauses = new Map()
    const read = store['readCacheFile'].bind(store)
    let calls = 0
    store['readCacheFile'] = async <T>(filePath: string) => {
      const item = await read<T>(filePath)
      await pauses.get(++calls)?.()
      return item
    }
    await store.set('count', 7, 1)
    now = 5000
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('keeps a counter increment() wrote after get() read the expired entry', async () => {
    const paused = pauseRead(1)
    const read = store.get<number>('count')
    await paused.reached
    expect(await store.increment('count')).toBe(1)
    paused.release()

    expect(await read).toBeNull()
    expect(await store.increment('count')).toBe(2)
  })

  it('lets only one add() win on a key whose expired entry ttl() read', async () => {
    const paused = pauseRead(1)
    const read = store.ttl('count')
    await paused.reached
    expect(await store.add('count', 'first')).toBe(true)
    paused.release()

    expect(await read).toBe(-2)
    expect(await store.add('count', 'second')).toBe(false)
    expect(await store.get<string>('count')).toBe('first')
  })

  it('keeps an entry set() replaced after cleanup() read the expired one', async () => {
    const paused = pauseRead(1)
    const cleaning = store.cleanup()
    await paused.reached
    await store.set('count', 8)
    paused.release()

    expect(await cleaning).toBe(0)
    expect(await store.get<number>('count')).toBe(8)
  })

  it('keeps a newer set() over the entry cleanup() moved aside', async () => {
    const paused = pauseRead(2)
    const cleaning = store.cleanup()
    await paused.reached
    await store.set('count', 9)
    paused.release()

    expect(await cleaning).toBe(1)
    expect(await store.get<number>('count')).toBe(9)
    const [subdirectory] = await readdir(directory)
    expect((await readdir(join(directory, subdirectory))).filter((name) => !name.endsWith('.cache'))).toEqual([])
  })

  it('keeps the newer of two set() calls racing the entry cleanup() restores', async () => {
    const unlocked = pauseRead(1)
    const aside = pauseRead(2)
    const cleaning = store.cleanup()
    await unlocked.reached
    await store.set('count', 8)
    unlocked.release()
    await aside.reached
    await store.set('count', 9)
    aside.release()

    expect(await cleaning).toBe(0)
    expect(await store.get<number>('count')).toBe(9)
    const [subdirectory] = await readdir(directory)
    expect((await readdir(join(directory, subdirectory))).filter((name) => !name.endsWith('.cache'))).toEqual([])
  })

  it('does not bring back an entry delete() removed while cleanup() had it aside', async () => {
    const unlocked = pauseRead(1)
    const aside = pauseRead(2)
    const cleaning = store.cleanup()
    await unlocked.reached
    await store.set('count', 8)
    unlocked.release()
    await aside.reached
    const deleting = store.delete('count')
    // Unlocked, the delete would finish inside the window; locked, it waits for cleanup().
    await Promise.race([deleting, Bun.sleep(50)])
    aside.release()

    expect(await cleaning).toBe(0)
    expect(await deleting).toBe(true)
    expect(await store.get<number>('count')).toBeNull()
  })
})
