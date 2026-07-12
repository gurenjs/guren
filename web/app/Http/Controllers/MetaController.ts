import { Controller } from '@guren/core'
import { GITHUB_URL, SITE_DESCRIPTION, SITE_NAME, absoluteUrl } from '../../../config/site.js'
import { docsService, type DocCategoryGroup } from '../../Services/DocsService.js'

const CACHE_HEADER = 'public, max-age=3600'

function xmlEscape(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
}

function docPaths(category: string, slug: string): { en: string; ja: string } {
  return {
    en: `/docs/${category}/${slug}`,
    ja: `/docs/ja/${category}/${slug}`,
  }
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

/**
 * Machine-facing endpoints: sitemap.xml for crawlers, llms.txt / llms-full.txt
 * for LLM agents (llmstxt.org convention).
 */
export default class MetaController extends Controller {
  async sitemap(): Promise<Response> {
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

    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
      ...entries,
      '</urlset>',
      '',
    ].join('\n')

    return new Response(xml, {
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Cache-Control': CACHE_HEADER,
      },
    })
  }

  async llms(): Promise<Response> {
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
          const url = absoluteUrl(`/docs/${group.category}/${doc.slug}.md`)
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

    return new Response(lines.join('\n'), {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': CACHE_HEADER,
      },
    })
  }

  async llmsFull(): Promise<Response> {
    const categories = await docsService.listDocs('en')
    const chunks: string[] = [
      `# ${SITE_NAME} — Full Documentation`,
      '',
      `> ${SITE_DESCRIPTION.en}`,
      '',
      `Source: ${absoluteUrl('/docs')} — per-page Markdown is available by appending \`.md\` to any docs URL.`,
      '',
    ]

    for (const group of categories) {
      chunks.push(await this.#concatCategory(group))
    }

    return new Response(chunks.join('\n'), {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': CACHE_HEADER,
      },
    })
  }

  async #concatCategory(group: DocCategoryGroup): Promise<string> {
    const parts: string[] = []

    for (const doc of group.docs) {
      const markdown = await docsService.getRawMarkdown(group.category, doc.slug, 'en')
      if (!markdown) {
        continue
      }
      parts.push('---')
      parts.push(`<!-- ${absoluteUrl(`/docs/${group.category}/${doc.slug}`)} -->`)
      parts.push('')
      parts.push(markdown.trim())
      parts.push('')
    }

    return parts.join('\n')
  }
}
