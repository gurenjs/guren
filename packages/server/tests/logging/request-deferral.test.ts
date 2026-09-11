/**
 * The wiring half of the workerd suite (`logger.workerd.test.ts`), which cannot
 * bundle a whole `Application`: that `app.fetch` hands the request's
 * `waitUntil` to a logger it never passed it to, and that a sync channel, a
 * rejecting one, and a context without `waitUntil` all stay what they were.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from 'bun:test'
import type { ExecutionContext } from 'hono'

import { createApp } from '../../src/http/Application'
import { Logger } from '../../src/logging'
import type { LogChannel } from '../../src/logging/types'
import { requestDeferrer, runInRequestScope } from '../../src/support/request-deferrer'

let reported: Mock<typeof console.error>

beforeEach(() => {
  reported = spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  reported.mockRestore()
})

function collector(): { deferred: Promise<unknown>[]; ctx: { waitUntil: (work: Promise<unknown>) => void } } {
  const deferred: Promise<unknown>[] = []
  return { deferred, ctx: { waitUntil: (work) => void deferred.push(work) } }
}

function pendingChannel(): { channel: LogChannel; settle: () => void } {
  let settle: () => void = () => {}
  const channel: LogChannel = { log: () => new Promise<void>((done) => { settle = done }) }
  return { channel, settle: () => settle() }
}

describe('Logger inside a request scope', () => {
  test('should hand an async channel\'s write to waitUntil while it is still pending', async () => {
    const { deferred, ctx } = collector()
    const { channel, settle } = pendingChannel()

    runInRequestScope(ctx, () => new Logger([channel]).info('hello'))

    // Still pending on return: the one property `waitUntil` needs.
    expect(deferred).toHaveLength(1)
    settle()
    await expect(deferred[0]).resolves.toBeUndefined()
  })

  test('should hand waitUntil nothing for a sync channel', () => {
    const { deferred, ctx } = collector()
    const lines: string[] = []

    runInRequestScope(ctx, () => new Logger([{ log: (entry) => void lines.push(entry.message) }]).info('hello'))

    expect(lines).toEqual(['hello'])
    expect(deferred).toEqual([])
  })

  test('should defer a rejecting write already caught and report it as before', async () => {
    const { deferred, ctx } = collector()

    runInRequestScope(ctx, () => new Logger([{ log: async () => { throw new Error('service down') } }]).info('hello'))

    await expect(deferred[0]).resolves.toBeUndefined()
    expect(reported.mock.calls.map((call) => String(call[1]))).toEqual(['Error: service down'])
  })

  test('should keep the scope across an await', async () => {
    const { deferred, ctx } = collector()
    const { channel, settle } = pendingChannel()

    await runInRequestScope(ctx, async () => {
      await new Promise((done) => setTimeout(done, 1))
      new Logger([channel]).info('later')
    })

    expect(deferred).toHaveLength(1)
    settle()
  })

  test('should defer nothing outside a request, even while another is in flight', async () => {
    const { deferred, ctx } = collector()
    const { channel, settle } = pendingChannel()
    let release: () => void = () => {}

    const inFlight = runInRequestScope(ctx, () => new Promise<void>((done) => { release = done }))
    new Logger([channel]).info('boot')

    expect(deferred).toEqual([])
    release()
    await inFlight
    settle()
  })
})

describe('runInRequestScope', () => {
  test('should enter no scope for a context with no callable waitUntil', () => {
    for (const ctx of [undefined, null, {}, { waitUntil: 'not a function' }]) {
      expect(runInRequestScope(ctx, () => requestDeferrer())).toBeUndefined()
    }
  })

  test('should bind waitUntil to its context', () => {
    const received: Promise<unknown>[] = []
    const ctx = {
      queue: received,
      waitUntil(this: { queue: Promise<unknown>[] }, work: Promise<unknown>) { this.queue.push(work) },
    }
    const work = Promise.resolve()

    runInRequestScope(ctx, () => requestDeferrer()!(work))

    expect(received).toEqual([work])
  })
})

describe('Application.fetch', () => {
  test('should give a route\'s async log write the waitUntil it was handed', async () => {
    const { deferred, ctx } = collector()
    const { channel, settle } = pendingChannel()
    const logger = new Logger([channel])
    const app = createApp()
    app.router.get('/log', async () => {
      await new Promise((done) => setTimeout(done, 1))
      logger.info('from a route')
      return 'ok'
    })
    await app.boot()

    const response = await app.fetch(new Request('http://example.com/log'), undefined, ctx as unknown as ExecutionContext)

    expect(response.status).toBe(200)
    expect(deferred).toHaveLength(1)
    settle()
    await expect(deferred[0]).resolves.toBeUndefined()
  })
})
