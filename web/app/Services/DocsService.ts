import { readdir, readFile } from 'node:fs/promises'
import { Dirent } from 'node:fs'
import { resolve } from 'node:path'
import { renderMarkdownToHtml } from './MarkdownRenderer.js'

export interface DocSummary {
  slug: string
  title: string
  description?: string
}

export interface DocCategoryGroup {
  category: DocCategory
  title: string
  docs: DocSummary[]
}

export interface DocPage extends DocSummary {
  category: DocCategory
  html: string
}

const DEFAULT_DOCS_DIR = resolve(process.cwd(), '../docs')
const FEATURED_DOC_ORDER = [
  'getting-started',
  'architecture',
  'routing',
  'controllers',
  'database',
  'frontend',
  'authentication',
  'testing',
  'deployment',
]
const TUTORIAL_DOC_ORDER = ['overview', 'create-blog-post-app', 'authentication', 'relationships']

const DOC_CATEGORY_CONFIG = {
  guides: {
    title: 'Guides',
    dir: 'guides',
    order: FEATURED_DOC_ORDER,
  },
  tutorials: {
    title: 'Tutorials',
    dir: 'tutorials',
    order: TUTORIAL_DOC_ORDER,
  },
} as const

export type DocCategory = keyof typeof DOC_CATEGORY_CONFIG
const DOC_CATEGORY_KEYS = Object.keys(DOC_CATEGORY_CONFIG) as DocCategory[]
const DOC_ORDER_INDEX: Record<DocCategory, Map<string, number>> = DOC_CATEGORY_KEYS.reduce(
  (acc, category) => {
    acc[category] = new Map(
      DOC_CATEGORY_CONFIG[category].order.map((slug, index) => [slug, index]),
    )
    return acc
  },
  {} as Record<DocCategory, Map<string, number>>,
)

export function normalizeDocCategory(value: string | undefined): DocCategory | null {
  if (!value) {
    return null
  }

  const trimmed = value.trim().replace(/^\//u, '').toLowerCase()
  if (!trimmed) {
    return null
  }

  const segment = trimmed.split('/')[0]
  if (!segment) {
    return null
  }

  return DOC_CATEGORY_KEYS.includes(segment as DocCategory)
    ? (segment as DocCategory)
    : null
}

export function normalizeDocSlug(value: string | undefined): string | null {
  if (!value) {
    return null
  }

  const trimmed = value.trim().replace(/^\//u, '').replace(/\.md$/iu, '')

  if (!trimmed || trimmed.includes('..') || trimmed.includes('/')) {
    return null
  }

  return trimmed
}

export class DocsService {
  #docsDir: string

  constructor(docsDir: string = DEFAULT_DOCS_DIR) {
    this.#docsDir = docsDir
  }

  async listDocs(): Promise<DocCategoryGroup[]> {
    const groups = await Promise.all(
      DOC_CATEGORY_KEYS.map(async (category) => {
        const entries = await this.#readDirectory(category)
        const docs = await Promise.all(
          entries
            .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
            .map(async (entry) => {
              const slug = this.#slugFromFilename(entry.name)
              const markdown = await this.#readMarkdownBySlug(category, slug)
              const title = this.#extractTitle(markdown, slug)
              const description = this.#extractDescription(markdown)

              return {
                slug,
                title,
                description,
              }
            }),
        )

        docs.sort((a, b) => this.#compareDocs(category, a, b))

        return {
          category,
          title: DOC_CATEGORY_CONFIG[category].title,
          docs,
        }
      }),
    )

    return groups
  }

  async getDoc(category: string | undefined, slug: string | undefined): Promise<DocPage | null> {
    const normalizedCategory = normalizeDocCategory(category)
    const normalizedSlug = normalizeDocSlug(slug)

    if (!normalizedCategory || !normalizedSlug) {
      return null
    }

    const markdown = await this.#readMarkdownBySlug(normalizedCategory, normalizedSlug).catch(() => null)
    if (!markdown) {
      return null
    }

    const title = this.#extractTitle(markdown, normalizedSlug)
    const description = this.#extractDescription(markdown)
    const html = await renderMarkdownToHtml(markdown)

    return {
      category: normalizedCategory,
      slug: normalizedSlug,
      title,
      description,
      html,
    }
  }

  async #readDirectory(category: DocCategory): Promise<Dirent[]> {
    const dirPath = resolve(this.#docsDir, DOC_CATEGORY_CONFIG[category].dir)
    return readdir(dirPath, { withFileTypes: true }).catch(() => [])
  }

  #docsPathForSlug(category: DocCategory, slug: string): string {
    return resolve(this.#docsDir, DOC_CATEGORY_CONFIG[category].dir, `${slug}.md`)
  }

  async #readMarkdownBySlug(category: DocCategory, slug: string): Promise<string> {
    return readFile(this.#docsPathForSlug(category, slug), 'utf8')
  }

  #slugFromFilename(filename: string): string {
    return filename.replace(/\.md$/iu, '')
  }

  #extractTitle(markdown: string, slug: string): string {
    const match = markdown.match(/^#\s+(.+?)\s*$/imu)
    if (match?.[1]) {
      return match[1].trim()
    }

    return this.#humanize(slug)
  }

  #extractDescription(markdown: string): string | undefined {
    const lines = markdown.split(/\r?\n/u)
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) {
        continue
      }

      if (trimmed.startsWith('#')) {
        continue
      }

      return trimmed
    }

    return undefined
  }

  #humanize(value: string): string {
    return value
      .split(/[-_/]/u)
      .filter(Boolean)
      .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
      .join(' ')
  }

  #compareDocs(category: DocCategory, a: DocSummary, b: DocSummary): number {
    const orderIndex = DOC_ORDER_INDEX[category]
    const orderA = orderIndex.get(a.slug)
    const orderB = orderIndex.get(b.slug)

    if (orderA !== undefined && orderB !== undefined) {
      return orderA - orderB
    }

    if (orderA !== undefined) {
      return -1
    }

    if (orderB !== undefined) {
      return 1
    }

    return a.title.localeCompare(b.title)
  }
}

export const docsService = new DocsService()
