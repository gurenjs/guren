// Docs metadata shared by the runtime stores, DocsService, and the prerender
// script. Keep this module dependency-free (no fs, no markdown/shiki) — it is
// part of the request path on every deploy target.

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

export const DEFAULT_DOC_LOCALE: DocLocale = 'en'

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
    slugs: ['routing', 'controllers', 'middleware', 'csrf', 'validation', 'error-handling', 'database', 'frontend', 'views'],
  },
  {
    title: { en: 'Security', ja: 'セキュリティ' },
    slugs: ['authentication', 'oauth', 'authorization', 'api-tokens', 'password-reset', 'email-verification', 'encryption'],
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
      'attachments',
      'scheduling',
      'console',
      'rate-limiting',
      'logging',
      'health-checks',
      'i18n',
      'api-resources',
      'markdown',
    ],
  },
  {
    title: { en: 'Testing & Deployment', ja: 'テストとデプロイ' },
    slugs: ['testing', 'deployment', 'serverless', 'cloudflare', 'operations'],
  },
  {
    title: { en: 'AI-Native Development', ja: 'AIネイティブ開発' },
    slugs: ['spec-anchored'],
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

export const DOC_CATEGORY_KEYS = Object.keys(DOC_CATEGORY_CONFIG) as DocCategory[]
export const DOC_LOCALE_KEYS = Object.keys(DOC_LOCALE_CONFIG) as DocLocale[]

const DOC_ORDER_INDEX: Record<DocCategory, Map<string, number>> = DOC_CATEGORY_KEYS.reduce(
  (acc, category) => {
    acc[category] = new Map(
      DOC_CATEGORY_CONFIG[category].order.map((slug, index) => [slug, index]),
    )
    return acc
  },
  {} as Record<DocCategory, Map<string, number>>,
)

export function docCategoryTitle(category: DocCategory, locale: DocLocale): string {
  return DOC_CATEGORY_CONFIG[category].title[locale]
}

export function docCategoryDir(category: DocCategory): string {
  return DOC_CATEGORY_CONFIG[category].dir
}

export function docLocaleDir(locale: DocLocale): string {
  return DOC_LOCALE_CONFIG[locale].dir
}

export const DOC_LOCALE_OPTIONS = DOC_LOCALE_KEYS.map((code) => ({
  code,
  label: DOC_LOCALE_CONFIG[code].label,
}))

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

export function extractDocTitle(markdown: string, slug: string): string {
  const match = markdown.match(/^#\s+(.+?)\s*$/imu)
  if (match?.[1]) {
    return match[1].trim()
  }

  return humanizeSlug(slug)
}

export function extractDocDescription(markdown: string): string | undefined {
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

function humanizeSlug(value: string): string {
  return value
    .split(/[-_/]/u)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ')
}

export function compareDocs(category: DocCategory, a: DocSummary, b: DocSummary): number {
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

export function buildDocSections(
  category: DocCategory,
  docs: DocSummary[],
  locale: DocLocale,
): DocSection[] {
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

/**
 * Prebuilt content is served in production, or when explicitly opted into
 * locally. Lives here rather than beside a store so callers that only need
 * the decision (the landing page's code samples) do not pull a generated
 * data module into their import graph.
 */
export function shouldUsePrerendered(prerendered: boolean): boolean {
  return (
    prerendered &&
    (process.env.NODE_ENV === 'production' || process.env.GUREN_DOCS_PRERENDERED === '1')
  )
}
