import { defineMiddleware } from '@guren/core'
import { getWorkersEnv } from '@guren/plugin-cloudflare'

/**
 * First-party, cookie-less request analytics into Workers Analytics Engine.
 *
 * Server-side measurement is the only kind this site's audience does not
 * defeat: developers run ad blockers that drop client-side beacons, and AI
 * agents fetching the Markdown mirrors never execute JavaScript at all.
 * Nothing user-identifying is stored — no cookies, no IPs, no full referrer
 * URLs — so no consent banner is needed.
 *
 * Data point layout (query these positions via the SQL API):
 *   index1: user-agent class (human / ai-agent / bot / unknown)
 *   blob1:  pathname
 *   blob2:  content class (home / docs / blog / markdown / llms / other)
 *   blob3:  user-agent class (again, so blobs are self-contained)
 *   blob4:  referrer host ('' for direct or same-site)
 *   blob5:  primary Accept-Language subtag
 *   blob6:  country code from Cloudflare
 *   blob7:  HTTP method
 *   blob8:  navigation type (initial / inertia)
 *   double1: response status
 *   double2: duration in milliseconds
 */

interface AnalyticsEngineDataset {
  writeDataPoint(event: { blobs?: string[]; doubles?: number[]; indexes?: string[] }): void
}

interface AnalyticsEnv {
  SITE_ANALYTICS?: AnalyticsEngineDataset
}

// AI agents and assistants, checked before the generic bot pattern — most of
// their user agents also contain "bot". Sources: the crawlers each vendor
// documents for robots.txt, plus the coding-agent CLIs seen in access logs.
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

export function referrerHost(referrer: string | undefined, ownHost: string): string {
  if (!referrer) return ''
  try {
    const host = new URL(referrer).hostname
    return host === ownHost ? '' : host
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
              url.pathname,
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
