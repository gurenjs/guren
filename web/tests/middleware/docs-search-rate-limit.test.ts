import { describe, expect, it } from 'vitest'

import type { Context } from '@guren/core'
import {
  docsSearchRateLimitKey,
  SweepingRateLimitStore,
} from '../../app/Http/Middleware/docs-search-rate-limit.js'

function context(options: { headers?: Record<string, string>; address?: string }): Context {
  const headers = new Headers(options.headers)
  return {
    req: {
      raw: new Request('http://guren.dev/docs/search?q=x'),
      header: (name: string) => headers.get(name) ?? undefined,
    },
    env: options.address ? { server: { requestIP: () => ({ address: options.address }) } } : undefined,
  } as unknown as Context
}

describe('docsSearchRateLimitKey', () => {
  it('prefers the address Cloudflare puts on the request', () => {
    expect(docsSearchRateLimitKey(context({ headers: { 'cf-connecting-ip': '203.0.113.7' } }))).toBe(
      '203.0.113.7',
    )
  })

  it('falls back to the socket peer when Bun is serving', () => {
    expect(docsSearchRateLimitKey(context({ address: '127.0.0.1' }))).toBe('127.0.0.1')
  })

  it('only shares one bucket when neither is available', () => {
    // This is the framework default's behaviour on Workers, and the reason
    // this key generator exists: one visitor's burst would lock out everyone.
    expect(docsSearchRateLimitKey(context({}))).toBe('__shared__')
  })
})

describe('SweepingRateLimitStore', () => {
  const WINDOW = 60_000

  it('counts within the window and starts over after it', async () => {
    let now = 1_800_000_000_000
    const store = new SweepingRateLimitStore(() => now)

    expect((await store.increment('a', WINDOW)).count).toBe(1)
    expect((await store.increment('a', WINDOW)).count).toBe(2)

    now += WINDOW + 1
    expect((await store.increment('a', WINDOW)).count).toBe(1)
  })

  it('does not grow without bound as addresses come and go', async () => {
    // The store only drops an expired entry when its own key is seen again,
    // and the key is a visitor's address. Without the sweep, an isolate holds
    // one entry per address it has ever served, for as long as it lives.
    let now = 1_800_000_000_000
    const store = new SweepingRateLimitStore(() => now)

    for (let visitor = 0; visitor < 2000; visitor++) {
      await store.increment(`203.0.113.${visitor}`, WINDOW)
      now += 100
    }

    expect(store.size).toBeLessThan(2000)
  })
})
