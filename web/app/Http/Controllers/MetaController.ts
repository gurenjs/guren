import { Controller } from '@guren/core'
import {
  DOCS_CACHE_CONTROL,
  GITHUB_URL,
  SITE_DESCRIPTION,
  SITE_NAME,
  absoluteUrl,
  docPaths,
} from '../../../config/site.js'
import { docsService, type DocCategoryGroup } from '../../Services/DocsService.js'

function xmlEscape(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
}

function sitemapEntry(path: string, alternates?: { en: string; ja: string }): string {
  const links = alternates
    ? [
        `    <xhtml:link rel="alternate" hreflang="en" href="${xmlEscape(absoluteUrl(alternates.en))}" />`,
        `    <xhtml:link rel="alternate" hreflang="ja" href="${xmlEscape(absoluteUrl(alternates.ja))}" />`,
        `    <xhtml:link rel="alternate" hreflang="x-default" href="${xmlEscape(absoluteUrl(alternates.en))}" />`,
      ].join('\n')
    : ''

  return ['  <url>', `    <loc>${xmlEscape(absoluteUrl(path))}</loc>`, links, '  </url>']
    .filter(Boolean)
    .join('\n')
}

// Docs content is immutable per deploy, so each body is built once per process
// (Cache-Control alone does not spare the origin — max-age has no CDN guarantee).
const bodyCache = new Map<string, Promise<string>>()

function cachedBody(key: string, build: () => Promise<string>): Promise<string> {
  let cached = bodyCache.get(key)

  if (!cached) {
    cached = build().catch((err) => {
      bodyCache.delete(key)
      throw err
    })
    bodyCache.set(key, cached)
  }

  return cached
}

/** Test hook: clear memoized endpoint bodies. */
export function resetMetaBodyCache(): void {
  bodyCache.clear()
}

/**
 * Machine-facing endpoints: sitemap.xml for crawlers, llms.txt / llms-full.txt
 * for LLM agents (llmstxt.org convention).
 */
export default class MetaController extends Controller {
  async sitemap(): Promise<Response> {
    const xml = await cachedBody('sitemap', buildSitemap)

    return this.text(xml, {
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Cache-Control': DOCS_CACHE_CONTROL,
      },
    })
  }

  async llms(): Promise<Response> {
    const body = await cachedBody('llms', buildLlms)

    return this.text(body, { headers: { 'Cache-Control': DOCS_CACHE_CONTROL } })
  }

  async llmsFull(): Promise<Response> {
    const body = await cachedBody('llms-full', buildLlmsFull)

    return this.text(body, { headers: { 'Cache-Control': DOCS_CACHE_CONTROL } })
  }
}

async function buildSitemap(): Promise<string> {
  const categories = await docsService.listDocs('en')

  const entries: string[] = [
    sitemapEntry('/'),
    sitemapEntry('/docs', { en: '/docs', ja: '/docs/ja' }),
    sitemapEntry('/docs/ja', { en: '/docs', ja: '/docs/ja' }),
  ]

  for (const group of categories) {
    for (const doc of group.docs) {
      const paths = docPaths(group.category, doc.slug)
      entries.push(sitemapEntry(paths.en, paths))
      entries.push(sitemapEntry(paths.ja, paths))
    }
  }

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    ...entries,
    '</urlset>',
    '',
  ].join('\n')
}

async function buildLlms(): Promise<string> {
  const categories = await docsService.listDocs('en')

  const lines: string[] = [
    `# ${SITE_NAME}`,
    '',
    `> ${SITE_DESCRIPTION.en}`,
    '',
    'Guren pairs Laravel-style conventions (controllers, models, middleware, validation) with the TypeScript ecosystem: Bun runtime, Hono HTTP, Drizzle ORM, and Inertia.js + React. Codegen keeps routes, page props, and API clients typed end to end.',
    '',
    'Every documentation page is also available as raw Markdown: append `.md` to its URL.',
    '',
  ]

  for (const group of categories) {
    lines.push(`## ${group.title}`)
    lines.push('')
    for (const section of group.sections) {
      for (const doc of section.docs) {
        const url = absoluteUrl(`${docPaths(group.category, doc.slug).en}.md`)
        lines.push(`- [${doc.title}](${url})${doc.description ? `: ${doc.description}` : ''}`)
      }
    }
    lines.push('')
  }

  lines.push('## Optional')
  lines.push('')
  lines.push(`- [Full documentation as one file](${absoluteUrl('/llms-full.txt')})`)
  lines.push(`- [GitHub repository](${GITHUB_URL})`)
  lines.push(`- [Japanese documentation](${absoluteUrl('/docs/ja')})`)
  lines.push('')

  return lines.join('\n')
}

async function buildLlmsFull(): Promise<string> {
  const categories = await docsService.listDocs('en')

  const chunks: string[] = [
    `# ${SITE_NAME} — Full Documentation`,
    '',
    `> ${SITE_DESCRIPTION.en}`,
    '',
    `Source: ${absoluteUrl('/docs')} — per-page Markdown is available by appending \`.md\` to any docs URL.`,
    '',
  ]

  const categoryChunks = await Promise.all(categories.map(concatCategory))
  chunks.push(...categoryChunks)

  return chunks.join('\n')
}

async function concatCategory(group: DocCategoryGroup): Promise<string> {
  const markdowns = await Promise.all(
    group.docs.map((doc) => docsService.getRawMarkdown(group.category, doc.slug, 'en')),
  )

  const parts: string[] = []

  group.docs.forEach((doc, index) => {
    const markdown = markdowns[index]
    if (!markdown) {
      return
    }
    parts.push('---')
    parts.push(`<!-- ${absoluteUrl(docPaths(group.category, doc.slug).en)} -->`)
    parts.push('')
    parts.push(markdown.trim())
    parts.push('')
  })

  return parts.join('\n')
}
