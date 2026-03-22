// Generated from resources/js/pages — DO NOT EDIT
// Run `guren codegen` to regenerate.

import type { PageContract, PagePropsRecord } from '@guren/inertia-client'

export const pageManifest = {
  'contracts': './pages/contracts.ts',
  'Home': './pages/Home.tsx',
} as const

export type PageManifest = typeof pageManifest
export type PageId = keyof PageManifest
export type PagePath<TPage extends PageId = PageId> = PageManifest[TPage]

export const pageIds = Object.keys(pageManifest) as PageId[]

export function isPageId(value: string): value is PageId {
  return Object.prototype.hasOwnProperty.call(pageManifest, value)
}

function defineGeneratedPage<TId extends string>(
  id: TId,
  path: string,
): PageContract<TId, Record<string, never>> {
  return {
    id,
    component: id,
    path,
    props<TNextProps extends PagePropsRecord>() {
      return defineGeneratedPage(id, path) as PageContract<TId, TNextProps>
    },
  } as PageContract<TId, Record<string, never>>
}

export const pages = {
  contracts: defineGeneratedPage('contracts', pageManifest['contracts']),
  Home: defineGeneratedPage('Home', pageManifest['Home'])
} as const
