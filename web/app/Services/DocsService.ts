import { readdir, readFile } from 'node:fs/promises'
import { Dirent, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { renderMarkdownToHtml } from './MarkdownRenderer.js'

export interface DocSummary {
  slug: string
  title: string
  description?: string
}

export interface DocSection {
  title: string
  docs: DocSummary[]
}

export interface DocCategoryGroup {
  category: DocCategory
  title: string
  docs: DocSummary[]
  sections: DocSection[]
}

export interface DocPage extends DocSummary {
  category: DocCategory
  html: string
}

type ResolveDocsDirOptions = {
  importMetaDir?: string
  cwd?: string
  envDocsDir?: string | null
}

function findNearestDocsDir(startDir: string, maxDepth = 6): string | null {
  let currentDir = startDir

  for (let depth = 0; depth < maxDepth; depth += 1) {
    const candidate = resolve(currentDir, 'docs')
    if (existsSync(candidate)) {
      return candidate
    }

    const parent = dirname(currentDir)
    if (parent === currentDir) {
      break
    }
    currentDir = parent
  }

  return null
}

// Resolve docs relative to the repository root so it works regardless of where the server is launched or bundled.
export function resolveDefaultDocsDir(options: ResolveDocsDirOptions = {}): string {
  const envDir = options.envDocsDir ?? process.env.GUREN_DOCS_DIR ?? process.env.DOCS_DIR
  if (envDir) {
    const resolvedEnvDir = resolve(envDir)
    if (existsSync(resolvedEnvDir)) {
      return resolvedEnvDir
    }
  }

  const cwdMatch = findNearestDocsDir(options.cwd ?? process.cwd())
  if (cwdMatch) {
    return cwdMatch
  }

  const importMetaDir = options.importMetaDir ?? import.meta.dirname
  const importMetaMatch = findNearestDocsDir(importMetaDir)
  if (importMetaMatch) {
    return importMetaMatch
  }

  // Fallback to the original heuristic; this keeps behavior stable even if no docs directory is found.
  return resolve(importMetaDir, '../../..', 'docs')
}

const DEFAULT_DOCS_DIR = resolveDefaultDocsDir()
const DEFAULT_DOC_LOCALE: DocLocale = 'en'

const DOC_LOCALE_CONFIG = {
  en: { label: 'English', dir: 'en' },
  ja: { label: '日本語', dir: 'ja' },
} as const

interface DocSectionConfig {
  title: Record<DocLocale, string>
  slugs: readonly string[]
}

const GUIDE_SECTIONS: readonly DocSectionConfig[] = [
  {
    title: { en: 'Getting Started', ja: 'はじめに' },
    slugs: ['overview', 'why-guren', 'getting-started', 'first-steps', 'architecture'],
  },
  {
    title: { en: 'The Basics', ja: '基本' },
    slugs: ['routing', 'controllers', 'middleware', 'csrf', 'validation', 'error-handling', 'database', 'frontend'],
  },
  {
    title: { en: 'Security', ja: 'セキュリティ' },
    slugs: ['authentication', 'authorization', 'api-tokens', 'password-reset', 'email-verification', 'encryption'],
  },
  {
    title: { en: 'Digging Deeper', ja: '応用機能' },
    slugs: [
      'events',
      'queue',
      'cache',
      'mail',
      'notifications',
      'broadcasting',
      'storage',
      'scheduling',
      'rate-limiting',
      'logging',
      'health-checks',
      'i18n',
      'api-resources',
    ],
  },
  {
    title: { en: 'Testing & Deployment', ja: 'テストとデプロイ' },
    slugs: ['testing', 'deployment', 'serverless', 'operations'],
  },
  {
    title: { en: 'Reference', ja: 'リファレンス' },
    slugs: [
      'build-auth-app',
      'ship-api',
      'deploy-production',
      'troubleshoot',
      'cli',
      'plugins',
      'support-matrix',
      'upgrading',
      'release-policy',
      'glossary',
    ],
  },
]

const TUTORIAL_SECTIONS: readonly DocSectionConfig[] = [
  {
    title: { en: 'Build a Mini Blog', ja: 'ミニブログを作る' },
    slugs: ['overview', 'create-blog-post-app', 'authentication', 'relationships'],
  },
]

const OTHER_SECTION_TITLE: Record<DocLocale, string> = { en: 'Other', ja: 'その他' }

const DOC_CATEGORY_CONFIG = {
  guides: {
    title: { en: 'Guides', ja: 'ガイド' },
    dir: 'guides',
    sections: GUIDE_SECTIONS,
    order: GUIDE_SECTIONS.flatMap((section) => section.slugs),
  },
  tutorials: {
    title: { en: 'Tutorials', ja: 'チュートリアル' },
    dir: 'tutorials',
    sections: TUTORIAL_SECTIONS,
    order: TUTORIAL_SECTIONS.flatMap((section) => section.slugs),
  },
} as const

export type DocCategory = keyof typeof DOC_CATEGORY_CONFIG
export type DocLocale = keyof typeof DOC_LOCALE_CONFIG
const DOC_CATEGORY_KEYS = Object.keys(DOC_CATEGORY_CONFIG) as DocCategory[]
const DOC_LOCALE_KEYS = Object.keys(DOC_LOCALE_CONFIG) as DocLocale[]
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

export function normalizeDocLocale(value: string | undefined): DocLocale | null {
  if (!value) {
    return null
  }

  const trimmed = value.trim().replace(/\//gu, '').toLowerCase()
  if (!trimmed) {
    return null
  }

  return DOC_LOCALE_KEYS.includes(trimmed as DocLocale) ? (trimmed as DocLocale) : null
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

  async listDocs(locale: DocLocale = DEFAULT_DOC_LOCALE): Promise<DocCategoryGroup[]> {
    const groups = await Promise.all(
      DOC_CATEGORY_KEYS.map(async (category) => {
        const entries = await this.#readDirectory(category, locale)
        const docs = await Promise.all(
          entries
            .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
            .map(async (entry) => {
              const slug = this.#slugFromFilename(entry.name)
              const markdown = await this.#readMarkdownBySlug(category, slug, locale)
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
          title: DOC_CATEGORY_CONFIG[category].title[locale],
          docs,
          sections: this.#buildSections(category, docs, locale),
        }
      }),
    )

    return groups
  }

  #buildSections(category: DocCategory, docs: DocSummary[], locale: DocLocale): DocSection[] {
    const bySlug = new Map(docs.map((doc) => [doc.slug, doc]))
    const assigned = new Set<string>()

    const sections: DocSection[] = []
    for (const section of DOC_CATEGORY_CONFIG[category].sections) {
      const sectionDocs = section.slugs
        .map((slug) => bySlug.get(slug))
        .filter((doc): doc is DocSummary => doc !== undefined)
      for (const doc of sectionDocs) {
        assigned.add(doc.slug)
      }
      if (sectionDocs.length > 0) {
        sections.push({ title: section.title[locale], docs: sectionDocs })
      }
    }

    // Docs on disk that aren't listed in any section config still show up.
    const leftovers = docs.filter((doc) => !assigned.has(doc.slug))
    if (leftovers.length > 0) {
      sections.push({ title: OTHER_SECTION_TITLE[locale], docs: leftovers })
    }

    return sections
  }

  async getDoc(
    category: string | undefined,
    slug: string | undefined,
    locale: DocLocale = DEFAULT_DOC_LOCALE,
  ): Promise<DocPage | null> {
    const normalizedCategory = normalizeDocCategory(category)
    const normalizedSlug = normalizeDocSlug(slug)

    if (!normalizedCategory || !normalizedSlug) {
      return null
    }

    const markdown = await this.#readMarkdownBySlug(normalizedCategory, normalizedSlug, locale).catch(() => null)
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

  /** Raw markdown source for a doc, or null when the doc does not exist. Used by the .md endpoints and llms-full.txt. */
  async getRawMarkdown(
    category: string | undefined,
    slug: string | undefined,
    locale: DocLocale,
  ): Promise<string | null> {
    const normalizedCategory = normalizeDocCategory(category)
    const normalizedSlug = normalizeDocSlug(slug)

    if (!normalizedCategory || !normalizedSlug) {
      return null
    }

    return this.#readMarkdownBySlug(normalizedCategory, normalizedSlug, locale).catch(() => null)
  }

  async #readDirectory(category: DocCategory, locale: DocLocale): Promise<Dirent[]> {
    const dirPath = resolve(this.#rootForLocale(locale), DOC_CATEGORY_CONFIG[category].dir)
    return readdir(dirPath, { withFileTypes: true }).catch(() => [])
  }

  #docsPathForSlug(category: DocCategory, slug: string, locale: DocLocale): string {
    return resolve(this.#rootForLocale(locale), DOC_CATEGORY_CONFIG[category].dir, `${slug}.md`)
  }

  async #readMarkdownBySlug(category: DocCategory, slug: string, locale: DocLocale): Promise<string> {
    return readFile(this.#docsPathForSlug(category, slug, locale), 'utf8')
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

      // Descriptions render as plain text — strip inline markdown noise.
      return trimmed
        .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
        .replace(/[`*_]/gu, '')
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

  #rootForLocale(locale: DocLocale): string {
    const localeDir = DOC_LOCALE_CONFIG[locale].dir
    return localeDir ? resolve(this.#docsDir, localeDir) : this.#docsDir
  }
}

export const docsService = new DocsService()

export const DOC_LOCALE_OPTIONS = DOC_LOCALE_KEYS.map((code) => ({
  code,
  label: DOC_LOCALE_CONFIG[code].label,
}))
export { DEFAULT_DOC_LOCALE }
