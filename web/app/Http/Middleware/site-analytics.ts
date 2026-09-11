import { defineMiddleware } from '@guren/core'
import { getWorkersEnv } from '@guren/plugin-cloudflare'

/**
 * Cookie-less, server-side analytics into Workers Analytics Engine: this audience
 * blocks beacons and agents run no JavaScript. No cookies, IPs, full referrers or
 * full user agents are stored, so no consent banner. SQL API: index1 ua class;
 * blob1..10 path, content, ua class, referrer host ('' = direct/same-site), language,
 * country, method, initial|inertia, UA token, ref tag; double1..2 status, ms.
 */

interface AnalyticsEngineDataset {
  writeDataPoint(event: { blobs?: string[]; doubles?: number[]; indexes?: string[] }): void
}

interface AnalyticsEnv {
  SITE_ANALYTICS?: AnalyticsEngineDataset
}

// Checked before the generic bot pattern — most of these user agents also
// contain "bot". From each vendor's documented robots.txt crawlers, plus the
// coding-agent CLIs seen in access logs.
const AI_AGENT_PATTERN =
  /GPTBot|OAI-SearchBot|ChatGPT-User|ClaudeBot|Claude-Web|Claude-User|Claude-SearchBot|claude-code|anthropic-ai|PerplexityBot|Perplexity-User|Google-Extended|GoogleAgent|Applebot-Extended|meta-externalagent|cohere-ai|DuckAssistBot|YouBot|MistralAI|Devin|Cursor/i

const BOT_PATTERN =
  /bot|crawler|spider|crawl|slurp|headless|python-requests|python-httpx|python-urllib|go-http-client|curl|wget|scrapy|feedfetcher|facebookexternalhit|preview|monitor|uptime/i

export type UserAgentClass = 'human' | 'ai-agent' | 'bot' | 'unknown'

export function classifyUserAgent(userAgent: string): UserAgentClass {
  if (!userAgent) return 'unknown'
  if (AI_AGENT_PATTERN.test(userAgent)) return 'ai-agent'
  if (BOT_PATTERN.test(userAgent)) return 'bot'
  return 'human'
}

// The alternative that matched, so an over-broad one shows up in the data. Every
// alternative is a literal, which keeps this to a fixed vocabulary rather than
// arbitrary user-agent text.
export function userAgentToken(userAgent: string): string {
  const match = AI_AGENT_PATTERN.exec(userAgent) ?? BOT_PATTERN.exec(userAgent)
  return match ? match[0].toLowerCase() : ''
}

export function classifyContent(pathname: string): string {
  if (pathname === '/llms.txt' || pathname === '/llms-full.txt') return 'llms'
  // Feed clients poll it on a timer; under `blog` it would count as reading.
  if (pathname === '/blog/rss.xml') return 'feed'
  if (pathname.endsWith('.md')) return 'markdown'
  if (pathname === '/' || pathname === '') return 'home'
  if (pathname === '/docs' || pathname.startsWith('/docs/')) return 'docs'
  if (pathname === '/blog' || pathname.startsWith('/blog/')) return 'blog'
  return 'other'
}

// Analytics Engine rejects a whole data point when its blobs exceed the size
// limit, and a URL can be ~16 KB. Anything longer than a real path is scanner
// noise, so truncate rather than lose the point.
const MAX_PATH_LENGTH = 512
const MAX_HOST_LENGTH = 256

export function referrerHost(referrer: string | undefined, ownHost: string): string {
  if (!referrer) return ''
  try {
    const host = new URL(referrer).hostname
    return host === ownHost ? '' : host.slice(0, MAX_HOST_LENGTH)
  } catch {
    return ''
  }
}

// The channel an outbound link names itself, for hosts that send no Referer.
// Only a short slug is kept.
const REF_TAG_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/

export function refTag(searchParams: URLSearchParams): string {
  const raw = (searchParams.get('ref') || searchParams.get('utm_source') || '').trim().toLowerCase()
  return REF_TAG_PATTERN.test(raw) ? raw : ''
}

export function primaryLanguage(acceptLanguage: string | undefined): string {
  if (!acceptLanguage) return ''
  const first = acceptLanguage.split(',', 1)[0] ?? ''
  const tag = first.split(';', 1)[0]?.trim() ?? ''
  const subtag = tag.split('-', 1)[0] ?? ''
  // An unparseable header yields garbage, not a language; cap defensively.
  return /^[a-zA-Z]{2,8}$/.test(subtag) ? subtag.toLowerCase() : ''
}

function workersDataset(): AnalyticsEngineDataset | undefined {
  try {
    return getWorkersEnv<AnalyticsEnv>().SITE_ANALYTICS
  } catch {
    // Not on Workers (Bun dev server, tests) — analytics is a no-op there.
    return undefined
  }
}

export function createSiteAnalyticsMiddleware(
  resolveDataset: () => AnalyticsEngineDataset | undefined = workersDataset,
) {
  return defineMiddleware(async (c, next) => {
    const startedAt = Date.now()
    try {
      await next()
    } finally {
      try {
        const dataset = resolveDataset()
        if (dataset) {
          const url = new URL(c.req.url)
          const userAgent = c.req.header('user-agent') ?? ''
          const uaClass = classifyUserAgent(userAgent)
          const cf = (c.req.raw as { cf?: { country?: string } }).cf
          dataset.writeDataPoint({
            indexes: [uaClass],
            blobs: [
              url.pathname.slice(0, MAX_PATH_LENGTH),
              classifyContent(url.pathname),
              uaClass,
              referrerHost(c.req.header('referer'), url.hostname),
              primaryLanguage(c.req.header('accept-language')),
              cf?.country ?? '',
              c.req.method,
              c.req.header('x-inertia') ? 'inertia' : 'initial',
              userAgentToken(userAgent),
              refTag(url.searchParams),
            ],
            doubles: [c.res?.status ?? 0, Date.now() - startedAt],
          })
        }
      } catch {
        // Analytics must never break a response.
      }
    }
  })
}

export const recordSiteAnalytics = createSiteAnalyticsMiddleware()
