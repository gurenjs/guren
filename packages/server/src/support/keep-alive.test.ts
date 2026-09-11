/**
 * The three orderings directly, rather than only through the callers that rely
 * on them. Each is wrong in a way a long-lived runtime cannot show: a
 * deferred rejection is an unhandled rejection in workerd, and a `defer` that
 * throws there would otherwise fail the call the channel was only recording.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn, type Mock } from 'bun:test'

import { keepAlive } from './keep-alive'
import { runInRequestScope } from './request-deferrer'

describe('keepAlive', () => {
  let warn: Mock<typeof console.warn>

  beforeEach(() => {
    warn = spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warn.mockRestore()
  })

  function warnings(): string {
    return warn.mock.calls.flat().map(String).join('\n')
  }

  function channel(run: () => void | Promise<void>, failures: unknown[] = []) {
    return { run, onFailure: (error: unknown) => void failures.push(error), label: 'the trail' }
  }

  test('should defer the settled promise, not the caller-visible one', async () => {
    const deferred: Promise<unknown>[] = []
    let settle: (() => void) | undefined

    keepAlive(channel(() => new Promise<void>((done) => { settle = done })), (work) => void deferred.push(work))

    // Still pending on return: the one property `waitUntil` needs, and the
    // reason the call may not await its own record.
    expect(deferred).toHaveLength(1)
    settle!()
    await expect(deferred[0]).resolves.toBeUndefined()
  })

  test('should hand defer an already-caught promise, never a rejecting one', async () => {
    const failures: unknown[] = []
    const deferred: Promise<unknown>[] = []

    keepAlive(
      channel(() => Promise.reject(new Error('sink is down')), failures),
      (work) => void deferred.push(work),
    )

    await expect(deferred[0]).resolves.toBeUndefined()
    expect(failures.map(String)).toEqual(['Error: sink is down'])
  })

  test('should report a synchronous throw and defer nothing', () => {
    const failures: unknown[] = []
    const deferred: Promise<unknown>[] = []

    expect(() =>
      keepAlive(
        channel(() => {
          throw new Error('no transport configured')
        }, failures),
        (work) => void deferred.push(work),
      ),
    ).not.toThrow()

    expect(failures.map(String)).toEqual(['Error: no transport configured'])
    expect(deferred).toEqual([])
  })

  test('should warn under its label when defer itself throws', () => {
    const failures: unknown[] = []

    expect(() =>
      keepAlive(channel(() => {}, failures), () => {
        throw new Error('Cannot perform I/O on behalf of a different request')
      }),
    ).not.toThrow()

    // The channel ran; only keeping it alive failed, so `onFailure` — which
    // says the record was dropped — must not be the one to report it.
    expect(failures).toEqual([])
    expect(warnings()).toContain('the trail could not be deferred')
  })

  test('should fall back to the waitUntil of the request being served', () => {
    const deferred: Promise<unknown>[] = []

    runInRequestScope({ waitUntil: (work: Promise<unknown>) => void deferred.push(work) }, () =>
      keepAlive(channel(() => {}), undefined),
    )

    expect(deferred).toHaveLength(1)
  })

  test('should prefer an explicit defer over the request\'s', () => {
    const fromRequest: Promise<unknown>[] = []
    const explicit: Promise<unknown>[] = []

    runInRequestScope({ waitUntil: (work: Promise<unknown>) => void fromRequest.push(work) }, () =>
      keepAlive(channel(() => {}), (work) => void explicit.push(work)),
    )

    expect(explicit).toHaveLength(1)
    expect(fromRequest).toEqual([])
  })

  test('should run the channel with no deferrer, as off Workers', async () => {
    const ran: string[] = []

    keepAlive(channel(() => void ran.push('once')), undefined)

    expect(ran).toEqual(['once'])
    expect(warnings()).toBe('')
  })
})
