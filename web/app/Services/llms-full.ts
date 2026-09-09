// llms-full.txt per llmstxt.org: every English doc's markdown in one file.
// Built once at prerender time into public/ (where Workers Static Assets
// answer before the Worker runs) and live by MetaController outside
// production, from the same function, so the two cannot drift.
import { absoluteUrl, docPaths, SITE_DESCRIPTION, SITE_NAME } from '../../config/site.js'
import type { DocCategoryGroup, DocLocale } from './docs-config.js'

/** What the builder reads: `DocsService` satisfies it, and so does a test double. */
export interface LlmsFullSource {
  listDocs(locale: DocLocale): Promise<DocCategoryGroup[]>
  getRawMarkdown(category: string, slug: string, locale: DocLocale): Promise<string | null>
}

export async function buildLlmsFull(source: LlmsFullSource): Promise<string> {
  const categories = await source.listDocs('en')

  const chunks: string[] = [
    `# ${SITE_NAME} — Full Documentation`,
    '',
    `> ${SITE_DESCRIPTION.en}`,
    '',
    `Source: ${absoluteUrl('/docs')} — per-page Markdown is available by appending \`.md\` to any docs URL.`,
    '',
  ]

  const categoryChunks = await Promise.all(
    categories.map((group) => concatCategory(source, group)),
  )
  chunks.push(...categoryChunks)

  return chunks.join('\n')
}

async function concatCategory(source: LlmsFullSource, group: DocCategoryGroup): Promise<string> {
  const markdowns = await Promise.all(
    group.docs.map((doc) => source.getRawMarkdown(group.category, doc.slug, 'en')),
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
