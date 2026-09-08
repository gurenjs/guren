import { describe, test, expect } from 'bun:test'
import {
  sweepOAuthStorage,
  OAUTH_PURGE_BATCH,
  OAUTH_PURGE_INTERVAL_MS,
  OAUTH_PURGE_MARKER,
  type OAuthPurgeResult,
  type OAuthPurgerLike,
  type OAuthSweepEnv,
} from './oauth-sweep'

const CLEAN: OAuthPurgeResult = { done: true }

/** Records what the sweep asked of the provider, answering per call. */
function purger(results: OAuthPurgeResult[] = [], throws?: Error) {
  const calls: unknown[] = []
  const oauth: OAuthPurgerLike<OAuthSweepEnv> = {
    purgeExpiredData(_env, options) {
      if (throws) return Promise.reject(throws)
      const result = results[calls.length] ?? CLEAN
      calls.push(options)
      return Promise.resolve(result)
    },
  }
  return { oauth, calls }
}

/** Just the two KV methods the sweep reaches for, over a plain map. */
function fakeEnv(marker?: string) {
  const store = new Map<string, string>()
  if (marker !== undefined) store.set(OAUTH_PURGE_MARKER, marker)
  return {
    OAUTH_KV: {
      get: (key: string) => Promise.resolve(store.get(key) ?? null),
      put: (key: string, value: string) => {
        store.set(key, value)
        return Promise.resolve()
      },
    },
    store,
  }
}

function collector() {
  const warnings: unknown[][] = []
  const errors: unknown[][] = []
  return {
    warnings,
    errors,
    logger: {
      warn: (...args: unknown[]) => warnings.push(args),
      error: (...args: unknown[]) => errors.push(args),
    },
  }
}

const AT = 1_000_000

describe('sweepOAuthStorage', () => {
  test('should sweep both passes separately and record the run when no marker exists', async () => {
    const { oauth, calls } = purger()
    const env = fakeEnv()

    await sweepOAuthStorage(oauth, { scheduledTime: AT }, env)

    // Two calls, because the provider returns as soon as the grant pass fills its
    // budget and the token pass behind it would then never run at all.
    expect(calls).toEqual([
      { batchSize: OAUTH_PURGE_BATCH, purgeOrphanedTokens: false },
      { batchSize: OAUTH_PURGE_BATCH, purgeOrphanedGrants: false, purgeExpiredGrants: false },
    ])
    expect(env.store.get(OAUTH_PURGE_MARKER)).toBe(String(AT))
  })

  test('should skip a firing inside the interval, leaving the marker alone', async () => {
    const { oauth, calls } = purger()
    const env = fakeEnv(String(AT))

    // A `* * * * *` app reaches here 59 more times before the next sweep is due.
    await sweepOAuthStorage(oauth, { scheduledTime: AT + OAUTH_PURGE_INTERVAL_MS - 60_000 }, env)

    expect(calls).toEqual([])
    expect(env.store.get(OAUTH_PURGE_MARKER)).toBe(String(AT))
  })

  test('should sweep once the interval has elapsed', async () => {
    const { oauth, calls } = purger()
    const env = fakeEnv(String(AT))

    await sweepOAuthStorage(oauth, { scheduledTime: AT + OAUTH_PURGE_INTERVAL_MS }, env)

    expect(calls).toHaveLength(2)
    expect(env.store.get(OAUTH_PURGE_MARKER)).toBe(String(AT + OAUTH_PURGE_INTERVAL_MS))
  })

  test('should fall back to the wall clock when the event carries no scheduled time', async () => {
    const { oauth, calls } = purger()
    const env = fakeEnv()

    await sweepOAuthStorage(oauth, {}, env)

    expect(calls).toHaveLength(2)
    expect(Number(env.store.get(OAUTH_PURGE_MARKER))).toBeGreaterThan(0)
  })

  test('should sweep past a marker it cannot read as a number', async () => {
    const { oauth, calls } = purger()
    const env = fakeEnv('not-a-timestamp')

    await sweepOAuthStorage(oauth, { scheduledTime: AT }, env)

    // NaN fails the comparison, so an unreadable marker self-heals rather than
    // wedging the sweep off forever.
    expect(calls).toHaveLength(2)
    expect(env.store.get(OAUTH_PURGE_MARKER)).toBe(String(AT))
  })

  test('should sweep past a marker dated ahead of the firing', async () => {
    const { oauth, calls } = purger()
    const env = fakeEnv(String(AT + OAUTH_PURGE_INTERVAL_MS))

    await sweepOAuthStorage(oauth, { scheduledTime: AT }, env)

    // A negative elapsed is under the interval too, so an unguarded comparison
    // would skip this firing and every one after it.
    expect(calls).toHaveLength(2)
    expect(env.store.get(OAUTH_PURGE_MARKER)).toBe(String(AT))
  })

  test('should report a failed sweep without rethrowing, and back off from it', async () => {
    const { oauth } = purger([], new Error('Too many subrequests'))
    const { logger, errors } = collector()
    const env = fakeEnv()

    // The app's own tasks run after this call and must still be reached.
    await sweepOAuthStorage(oauth, { scheduledTime: AT }, env, logger)

    expect(errors).toHaveLength(1)
    // The marker was claimed first, so a sweep that cannot finish waits out the
    // interval. Retrying every firing would burn the same budget once a minute.
    expect(env.store.get(OAUTH_PURGE_MARKER)).toBe(String(AT))
  })

  test('should name a sweep that stopped at its batch limit', async () => {
    const { oauth } = purger([{ done: false }, { done: true }])
    const { logger, warnings } = collector()

    await sweepOAuthStorage(oauth, { scheduledTime: AT }, fakeEnv(), logger)

    // Records past the window are unreachable for good, so a capped pass is the
    // one thing an operator has to be told about.
    expect(warnings).toHaveLength(1)
  })

  test('should stay quiet when both passes completed', async () => {
    const { oauth } = purger()
    const { logger, warnings, errors } = collector()

    await sweepOAuthStorage(oauth, { scheduledTime: AT }, fakeEnv(), logger)

    expect(warnings).toEqual([])
    expect(errors).toEqual([])
  })
})
