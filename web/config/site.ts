// Shared site metadata. Imported by both server controllers and React pages,
// so keep this module dependency-free and side-effect-free.

export const SITE_URL = 'https://gurenjs.vercel.app'
export const SITE_NAME = 'Guren'
export const GITHUB_URL = 'https://github.com/gurenjs/guren'
export const OG_IMAGE_PATH = '/og.png'

export const SITE_TITLE =
  'Guren — The Laravel feeling, at Bun speed. Fullstack TypeScript framework.'

export const SITE_DESCRIPTION = {
  en: 'Guren is a Bun-native fullstack TypeScript framework with Laravel-style ergonomics: MVC controllers, Drizzle ORM models, Inertia + React pages, and end-to-end type safety from route to component.',
  ja: 'Guren は Bun ネイティブのフルスタック TypeScript フレームワーク。Laravel 流の MVC コントローラ、Drizzle ORM モデル、Inertia + React ページ、ルートからコンポーネントまでの型安全性を備えています。',
} as const

/** Cache policy for machine-facing endpoints (sitemap, llms.txt, raw Markdown). */
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
