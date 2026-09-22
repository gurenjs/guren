import { describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Hono } from 'hono'
import { MemoryStore, FileStore, TaggedCache } from '../src/cache'
import { EventManager, Event } from '../src/events'
import { Scheduler, getNextOccurrence, parseCron } from '../src/scheduling'
import { createRateLimitMiddleware, MemoryRateLimitStore } from '../src/http/middleware/rate-limit'
import { LocalDriver } from '../src/storage/drivers/LocalDriver'
import { MemoryDriver } from '../src/storage/drivers/MemoryDriver'
import { S3Driver } from '../src/storage/drivers/S3Driver'

describe('runtime consistency', () => {
  for (const kind of ['memory', 'file'] as const) {
    it(`${kind} counters retain concurrent increments and their original deadline`, async () => {
      const path = await mkdtemp(join(tmpdir(), 'cache-consistency-'))
      let now = 1000
      const stores = kind === 'memory'
        ? [new MemoryStore({ checkPeriod: 0, now: () => now })]
        : [new FileStore({ path, now: () => now }), new FileStore({ path, now: () => now })]
      try {
        await stores[0].set('count', 0, 1)
        now = 1900
        const results = await Promise.all(Array.from({ length: 20 }, (_, index) => stores[index % stores.length].increment('count')))
        expect(results.sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1))
        expect(await stores[0].get<number>('count')).toBe(20)
        now = 2000
        expect(await stores[0].get<number>('count')).toBeNull()
        expect(await stores[0].increment('count')).toBe(1)
      } finally {
        await rm(path, { recursive: true, force: true })
      }
    })
  }

  it('serves a file key whose lock an earlier process abandoned', async () => {
    const path = await mkdtemp(join(tmpdir(), 'cache-abandoned-lock-'))
    const store = new FileStore({ path })
    try {
      await store.set('count', 1)
      const hash = new Bun.CryptoHasher('sha256').update('count').digest('hex')
      await mkdir(join(path, hash.slice(0, 2), `${hash}.cache.lock`))
      expect(await store.get<number>('count')).toBe(1)
      await store.set('count', 2)
      expect(await store.ttl('count')).toBe(-1)
      expect(await store.increment('count')).toBe(3)
      expect(await store.get<number>('count')).toBe(3)
    } finally {
      await rm(path, { recursive: true, force: true })
    }
  }, 15000)

  it('coordinates file counters across separate processes', async () => {
    const path = await mkdtemp(join(tmpdir(), 'cache-processes-'))
    const store = new FileStore({ path })
    const moduleUrl = new URL('../src/cache/stores/FileStore.ts', import.meta.url).href
    const code = `import { FileStore } from ${JSON.stringify(moduleUrl)};
      const store = new FileStore({ path: process.argv[1] });
      for (let index = 0; index < 25; index++) await store.increment('count');`
    try {
      await store.set('count', 0)
      const run = promisify(execFile)
      await Promise.all([run('bun', ['-e', code, path], { timeout: 10000 }), run('bun', ['-e', code, path], { timeout: 10000 })])
      expect(await store.get<number>('count')).toBe(50)
    } finally {
      await rm(path, { recursive: true, force: true })
    }
  })

  it('does not evict another entry when updating a full memory cache', async () => {
    const store = new MemoryStore({ maxSize: 2, checkPeriod: 0 })
    await store.set('a', 1)
    await store.set('b', 2)
    await store.set('b', 3)
    expect(await store.get<number>('a')).toBe(1)
    expect(await store.get<number>('b')).toBe(3)
  })

  it('keeps tagged caches working on a store without add()', async () => {
    const backing = new MemoryStore({ checkPeriod: 0 })
    const store = Object.assign(Object.create(backing) as MemoryStore, { add: undefined })
    const tagged = new TaggedCache(store, ['posts'])
    await tagged.set('a', 1)
    expect(await tagged.get<number>('a')).toBe(1)
    await tagged.flush()
    expect(await tagged.get<number>('a')).toBeNull()
  })

  it('shares initial tag namespaces across instances without losing writes or mixing tags', async () => {
    const store = new MemoryStore({ checkPeriod: 0 })
    const first = new TaggedCache(store, ['posts'])
    const second = new TaggedCache(store, ['posts'])
    const other = new TaggedCache(store, ['comments'])
    await Promise.all([first.set('a', 1), second.set('b', 2), other.set('a', 3)])
    expect(await first.get<number>('a')).toBe(1)
    expect(await first.get<number>('b')).toBe(2)
    expect(await other.get<number>('a')).toBe(3)
    await first.flush()
    expect(await second.get<number>('a')).toBeNull()
    expect(await second.get<number>('b')).toBeNull()
    expect(await other.get<number>('a')).toBe(3)
    await second.set('a', 4)
    expect(await first.get<number>('a')).toBe(4)
  })

  it('allows the first two concurrent requests when the limit is two', async () => {
    const store = new MemoryRateLimitStore(0)
    const app = new Hono()
    app.use('*', createRateLimitMiddleware({ limit: 2, store, keyGenerator: () => 'same' }))
    app.get('/', (ctx) => ctx.text('ok'))
    try {
      const responses = await Promise.all(Array.from({ length: 3 }, () => app.request('/')))
      expect(responses.map((response) => response.status).sort()).toEqual([200, 200, 429])
    } finally { store.destroy() }
  })

  it('claims once listeners before concurrent emits and removes successes before later errors', async () => {
    class Changed extends Event {}
    const events = new EventManager()
    let calls = 0
    events.once(Changed, async () => { calls++; await Promise.resolve() })
    await Promise.all([events.emit(new Changed()), events.emit(new Changed())])
    expect(calls).toBe(1)
    events.once(Changed, () => { calls++ }, { priority: 10 })
    events.on(Changed, () => { throw new Error('later') })
    await expect(events.emit(new Changed())).rejects.toThrow('later')
    await expect(events.emit(new Changed())).rejects.toThrow('later')
    expect(calls).toBe(2)
  })

  it('applies the scheduler timezone while preserving task overrides', () => {
    const scheduler = new Scheduler({ timezone: 'Asia/Tokyo' })
    scheduler.schedule((schedule) => {
      schedule.call(() => {}).dailyAt('09:00').name('default')
      schedule.call(() => {}).dailyAt('09:00').tz('UTC').name('override')
    })
    expect(scheduler.getDueTasks(new Date('2026-01-01T00:00:00Z')).map((task) => task.getName())).toEqual(['default'])
    expect(scheduler.getDueTasks(new Date('2026-01-01T09:00:00Z')).map((task) => task.getName())).toEqual(['override'])
  })

  it('rejects malformed cron fields and zero steps', () => {
    for (const expression of ['*/0 * * * *', '1-5/0 * * * *', 'bogus * * * *', '60 * * * *', '1-999999999999 * * * *', '5-1 * * * *']) {
      expect(() => parseCron(expression)).toThrow('Invalid cron field')
    }
  })

  it('finds leap-day occurrences beyond one year and rejects impossible dates', () => {
    const next = getNextOccurrence('0 0 29 2 *', new Date(2026, 0, 1))
    expect([next.getFullYear(), next.getMonth(), next.getDate()]).toEqual([2028, 1, 29])
    expect(() => getNextOccurrence('0 0 30 2 *', new Date(2026, 0, 1))).toThrow('Could not find')
  })

  it('preserves reserved characters in storage URL object keys', () => {
    const url = 'https://files.example.test'
    const drivers = [new LocalDriver({ root: tmpdir(), url }), new MemoryDriver({ url }), new S3Driver({ bucket: 'example', url })]
    for (const driver of drivers) {
      const parsed = new URL(driver.url('reports/report#1?100%.pdf'))
      expect(decodeURIComponent(parsed.pathname)).toBe('/reports/report#1?100%.pdf')
      expect(parsed.search).toBe('')
      expect(parsed.hash).toBe('')
    }
  })
})
