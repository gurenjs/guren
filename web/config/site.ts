// Shared site metadata. Imported by both server controllers and React pages,
// so keep this module dependency-free and side-effect-free.

export const SITE_URL = 'https://guren.dev'
export const SITE_NAME = 'Guren'
export const GITHUB_URL = 'https://github.com/gurenjs/guren'
export const OG_IMAGE_PATH = '/og.png'

export const SITE_TITLE =
  'Guren — The fullstack TypeScript framework for the AI-agent era.'

export const SITE_DESCRIPTION = {
  en: 'Guren is a fullstack TypeScript framework built for AI-agent-driven development: Laravel-style conventions, end-to-end type safety from route to React component, and mechanical verification your agent runs itself — Bun-native, deployable anywhere.',
  ja: 'Guren は AI エージェント時代のためのフルスタック TypeScript フレームワーク。人間とエージェントが同じ地図で開発できるよう、Laravel 流の規約、ルートから React コンポーネントまでの型安全、エージェント自身が実行できる機械検証を備えます。Bun ネイティブで、デプロイ先は自由です。',
} as const

/** Cache policy for machine-facing endpoints (sitemap, llms.txt, RSS, raw Markdown). */
export const DOCS_CACHE_CONTROL = 'public, max-age=3600'

export function absoluteUrl(path: string): string {
  if (/^https?:\/\//u.test(path)) {
    return path
  }
  return `${SITE_URL}${path.startsWith('/') ? path : `/${path}`}`
}

/** Document title format shared by server-rendered titles and the Seo component. */
export function pageTitle(base: string): string {
  return `${base} — ${SITE_NAME}`
}

export type DocLocale = 'en' | 'ja'

export function docsBasePath(locale: DocLocale): string {
  return locale === 'en' ? '/docs' : `/docs/${locale}`
}

/** Locale variants of a docs page URL — single owner of the /docs vs /docs/ja scheme. */
export function docPaths(category: string, slug: string): { en: string; ja: string } {
  return {
    en: `${docsBasePath('en')}/${category}/${slug}`,
    ja: `${docsBasePath('ja')}/${category}/${slug}`,
  }
}

/**
 * The blog's published-date format, shared by the server-rendered post page
 * and the React index. Pinned to UTC: the post page renders on the server
 * now, and without an explicit zone the same instant formats as different
 * dates depending on where it renders (server region vs. reader's browser).
 */
const POST_DATE_FORMAT = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  timeZone: 'UTC',
})

export function formatPostDate(iso: string | null): string {
  if (!iso) return ''
  return POST_DATE_FORMAT.format(new Date(iso))
}
