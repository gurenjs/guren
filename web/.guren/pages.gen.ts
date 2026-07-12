// Generated from resources/js/pages — DO NOT EDIT
// Run `guren codegen` to regenerate.

import type { PageContract, PagePropsRecord } from '@guren/inertia-client'


export const pageManifest = {
  'Docs/Index': './pages/Docs/Index.tsx',
  'Docs/Show': './pages/Docs/Show.tsx',
  'Home': './pages/Home.tsx',
} as const

export type PageManifest = typeof pageManifest
export type PageId = keyof PageManifest
export type PagePath<TPage extends PageId = PageId> = PageManifest[TPage]

export const pageIds = Object.keys(pageManifest) as PageId[]

export function isPageId(value: string): value is PageId {
  return Object.prototype.hasOwnProperty.call(pageManifest, value)
}

type DocSummary = {
  slug: string
  title: string
  description?: string
}

type DocSection = {
  title: string
  docs: DocSummary[]
}

type DocCategoryGroup = {
  category: string
  title: string
  docs: DocSummary[]
  sections: DocSection[]
}

type LocaleLink = {
  code: string
  label: string
  href: string
  active?: boolean
}

type DocPage = DocSummary & {
  category: string
  html: string
}
/**
 * Auto-extracted Props types from page components.
 */
export interface PagePropsMap {
  'Docs/Index': {
  categories: DocCategoryGroup[]
  locale: string
  locales?: LocaleLink[]
  basePath: string
}
  'Docs/Show': {
  categories: DocCategoryGroup[]
  doc: DocPage | null
  active?: { category: string; slug: string }
  locale: string
  locales?: LocaleLink[]
  basePath: string
}
  'Home': {
  message: string
  codeExamples: Record<string, string>
}
}

export type InferPageProps<TId extends PageId> =
  TId extends keyof PagePropsMap ? PagePropsMap[TId] : Record<string, never>

function defineGeneratedPage<TId extends string, TProps extends PagePropsRecord = Record<string, never>>(
  id: TId,
  path: string,
): PageContract<TId, TProps> {
  return {
    id,
    component: id,
    path,
    props<TNextProps extends PagePropsRecord>() {
      return defineGeneratedPage(id, path) as PageContract<TId, TNextProps>
    },
  } as PageContract<TId, TProps>
}

export const pages = {
  Docs: {
    Index: defineGeneratedPage<'Docs/Index', PagePropsMap['Docs/Index']>('Docs/Index', pageManifest['Docs/Index']),
    Show: defineGeneratedPage<'Docs/Show', PagePropsMap['Docs/Show']>('Docs/Show', pageManifest['Docs/Show'])
  },
  Home: defineGeneratedPage<'Home', PagePropsMap['Home']>('Home', pageManifest['Home'])
} as const
