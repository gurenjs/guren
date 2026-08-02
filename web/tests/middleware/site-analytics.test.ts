import { describe, expect, it, vi } from 'vitest'

// The real module drags in the Cloudflare build pipeline, which vitest cannot
// resolve; every test here injects its own dataset resolver anyway.
vi.mock('@guren/plugin-cloudflare', () => ({
  getWorkersEnv: () => {
    throw new Error('workers env is not captured in tests')
  },
}))

import {
  classifyContent,
  classifyUserAgent,
  createSiteAnalyticsMiddleware,
  primaryLanguage,
  referrerHost,
} from '../../app/Http/Middleware/site-analytics.js'

type Middleware = ReturnType<typeof createSiteAnalyticsMiddleware>
type MiddlewareContext = Parameters<Middleware>[0]

interface DataPoint {
  blobs?: string[]
  doubles?: number[]
  indexes?: string[]
}

function contextFor(
  url: string,
  { headers = {}, cf, status = 200 }: {
    headers?: Record<string, string>
    cf?: { country?: string }
    status?: number
  } = {},
) {
  const lowered = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  )
  return {
    req: {
      url,
      method: 'GET',
      header: (name: string) => lowered[name.toLowerCase()],
      raw: { cf },
    },
    res: { status },
  } as unknown as MiddlewareContext
}

async function record(url: string, options?: Parameters<typeof contextFor>[1]) {
  const points: DataPoint[] = []
  const middleware = createSiteAnalyticsMiddleware(() => ({
    writeDataPoint: (point: DataPoint) => {
      points.push(point)
    },
  }))
  await middleware(contextFor(url, options), async () => {})
  return points
}

describe('classifyUserAgent', () => {
  it('should classify AI agents before the generic bot pattern matches', () => {
    expect(classifyUserAgent('Mozilla/5.0 (compatible; ClaudeBot/1.0)')).toBe('ai-agent')
    expect(classifyUserAgent('Mozilla/5.0 (compatible; GPTBot/1.1)')).toBe('ai-agent')
    expect(classifyUserAgent('PerplexityBot/1.0')).toBe('ai-agent')
  })

  it('should classify crawlers and HTTP clients as bots', () => {
    expect(classifyUserAgent('Mozilla/5.0 (compatible; Googlebot/2.1)')).toBe('bot')
    expect(classifyUserAgent('curl/8.4.0')).toBe('bot')
  })

  it('should classify browsers as human and empty as unknown', () => {
    expect(
      classifyUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1'),
    ).toBe('human')
    expect(classifyUserAgent('')).toBe('unknown')
  })
})

describe('classifyContent', () => {
  it('should bucket the agent-facing mirrors separately from pages', () => {
    expect(classifyContent('/llms.txt')).toBe('llms')
    expect(classifyContent('/docs/guides/getting-started.md')).toBe('markdown')
    expect(classifyContent('/docs/guides/getting-started')).toBe('docs')
    expect(classifyContent('/blog/some-post')).toBe('blog')
    expect(classifyContent('/')).toBe('home')
    expect(classifyContent('/login')).toBe('other')
  })
})

describe('referrerHost', () => {
  it('should keep only the host and drop same-site referrers', () => {
    expect(referrerHost('https://news.ycombinator.com/item?id=1', 'guren.dev')).toBe(
      'news.ycombinator.com',
    )
    expect(referrerHost('https://guren.dev/docs', 'guren.dev')).toBe('')
    expect(referrerHost('not a url', 'guren.dev')).toBe('')
    expect(referrerHost(undefined, 'guren.dev')).toBe('')
  })
})

describe('primaryLanguage', () => {
  it('should reduce Accept-Language to the primary subtag', () => {
    expect(primaryLanguage('ja-JP,ja;q=0.9,en;q=0.8')).toBe('ja')
    expect(primaryLanguage('en-US')).toBe('en')
    expect(primaryLanguage('*')).toBe('')
    expect(primaryLanguage(undefined)).toBe('')
  })
})

describe('createSiteAnalyticsMiddleware', () => {
  it('should write one data point with the documented layout', async () => {
    const points = await record('https://guren.dev/docs/guides/getting-started', {
      headers: {
        'user-agent': 'Mozilla/5.0 Safari/604.1',
        referer: 'https://zenn.dev/some-article',
        'accept-language': 'ja-JP,ja;q=0.9',
      },
      cf: { country: 'JP' },
    })

    expect(points).toHaveLength(1)
    const point = points[0]!
    expect(point.indexes).toEqual(['human'])
    expect(point.blobs?.slice(0, 8)).toEqual([
      '/docs/guides/getting-started',
      'docs',
      'human',
      'zenn.dev',
      'ja',
      'JP',
      'GET',
      'initial',
    ])
    expect(point.doubles?.[0]).toBe(200)
    expect(point.doubles?.[1]).toBeGreaterThanOrEqual(0)
  })

  it('should mark Inertia navigations and AI agent fetches', async () => {
    const [inertia] = await record('https://guren.dev/blog', {
      headers: { 'user-agent': 'Mozilla/5.0', 'x-inertia': 'true' },
    })
    expect(inertia?.blobs?.[7]).toBe('inertia')

    const [agent] = await record('https://guren.dev/docs/guides/getting-started.md', {
      headers: { 'user-agent': 'Claude-User/1.0' },
    })
    expect(agent?.indexes).toEqual(['ai-agent'])
    expect(agent?.blobs?.[1]).toBe('markdown')
  })

  it('should cap oversized paths so the data point stays writable', async () => {
    const [point] = await record(`https://guren.dev/${'a'.repeat(20_000)}`, {
      headers: { 'user-agent': 'Mozilla/5.0' },
    })
    expect(point?.blobs?.[0]?.length).toBeLessThanOrEqual(512)
  })

  it('should still record when the downstream handler throws', async () => {
    const points: DataPoint[] = []
    const middleware = createSiteAnalyticsMiddleware(() => ({
      writeDataPoint: (point: DataPoint) => {
        points.push(point)
      },
    }))

    await expect(
      middleware(contextFor('https://guren.dev/boom', { status: 500 }), async () => {
        throw new Error('downstream failure')
      }),
    ).rejects.toThrow('downstream failure')
    expect(points).toHaveLength(1)
  })

  it('should be a no-op without a dataset and never break the response', async () => {
    const middleware = createSiteAnalyticsMiddleware(() => undefined)
    let reached = false
    await middleware(contextFor('https://guren.dev/'), async () => {
      reached = true
    })
    expect(reached).toBe(true)

    const throwing = createSiteAnalyticsMiddleware(() => {
      throw new Error('env not captured')
    })
    await expect(
      throwing(contextFor('https://guren.dev/'), async () => {}),
    ).resolves.toBeUndefined()
  })
})
