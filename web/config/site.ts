// Shared site metadata. Imported by both server controllers and React pages,
// so keep this module dependency-free and side-effect-free.

export const SITE_URL = 'https://gurenjs.vercel.app'
export const SITE_NAME = 'Guren'
export const GITHUB_URL = 'https://github.com/gurenjs/guren'
export const OG_IMAGE_PATH = '/og.png'

export const SITE_TITLE = {
  en: 'Guren — The Laravel feeling, in TypeScript. Built for Bun.',
  ja: 'Guren — Laravel の開発体験を TypeScript で。Bun ネイティブのフルスタックフレームワーク',
} as const

export const SITE_DESCRIPTION = {
  en: 'Guren is a Bun-native fullstack TypeScript framework with Laravel-style ergonomics: MVC controllers, Drizzle ORM models, Inertia + React pages, and end-to-end type safety from route to component.',
  ja: 'Guren は Bun ネイティブのフルスタック TypeScript フレームワーク。Laravel 流の MVC コントローラ、Drizzle ORM モデル、Inertia + React ページ、ルートからコンポーネントまでの型安全性を備えています。',
} as const

export function absoluteUrl(path: string): string {
  if (/^https?:\/\//u.test(path)) {
    return path
  }
  return `${SITE_URL}${path.startsWith('/') ? path : `/${path}`}`
}
