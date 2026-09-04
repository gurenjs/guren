import { defineMiddleware } from '@guren/core'
import { getWorkersEnv } from '@guren/plugin-cloudflare'

/**
 * Cookie-less, server-side request analytics into Workers Analytics Engine: this
 * audience blocks client beacons and AI agents run no JavaScript. No cookies, IPs
 * or full referrers are stored, so no consent banner. SQL API positions: index1 ua
 * class; blob1..8 pathname, content class, ua class, referrer host ('' = direct or
 * same-site), Accept-Language, country, method, initial|inertia; double1..2 status, ms.
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

export function classifyContent(pathname: string): string {
  if (pathname === '/llms.txt' || pathname === '/llms-full.txt') return 'llms'
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
          const uaClass = classifyUserAgent(c.req.header('user-agent') ?? '')
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
