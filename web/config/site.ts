// Shared site metadata. Imported by both server controllers and React pages,
// so keep this module dependency-free and side-effect-free.

export const SITE_URL = 'https://guren.dev'
export const SITE_NAME = 'Guren'
export const GITHUB_URL = 'https://github.com/gurenjs/guren'
export const OG_IMAGE_PATH = '/og.png'

// Links to our own GitHub repositories deliberately omit `noreferrer`: the
// referrer is what attributes a visit to guren.dev in that repository's own
// traffic view, and nothing else can measure a click leaving the site.
// `noopener` still closes the window.opener handle.
export const OWN_REPO_LINK_REL = 'noopener'

export const SITE_TITLE =
  'Guren — The Bun-first fullstack TypeScript framework'

export const SITE_DESCRIPTION = {
  en: 'Guren is a Bun-first fullstack TypeScript framework: Laravel-style conventions, end-to-end type safety from route to React component, and mechanical verification your coding agent runs itself. Develop on Bun; deploy to Bun, AWS Lambda, Vercel, or Cloudflare Workers.',
  ja: 'Guren は Bun ファーストのフルスタック TypeScript フレームワーク。Laravel 流の規約、ルートから React コンポーネントまでの型安全、コーディングエージェント自身が実行できる機械検証を備えます。開発は Bun で行い、デプロイ先は Bun、AWS Lambda、Vercel、Cloudflare Workers から選べます。',
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
 * The blog's published-date format, shared by the server-rendered post page and
 * the React index. Pinned to UTC, or the same instant formats as different
 * dates depending on where it renders.
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
