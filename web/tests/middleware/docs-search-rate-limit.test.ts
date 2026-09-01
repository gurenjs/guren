import { describe, expect, it } from 'vitest'

import type { Context } from '@guren/core'
import { docsSearchRateLimitKey } from '../../app/Http/Middleware/docs-search-rate-limit.js'

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
