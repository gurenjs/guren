// Generated from resources/js/pages — DO NOT EDIT
// Run `guren codegen` to regenerate.

import type { PageContract, PagePropsRecord } from '@guren/inertia-client'
import type { ApiRoutes } from '@/.guren/api-client.gen'
import type { PostResourceData } from '@/app/Http/Resources/PostResource'
import type { PaginatedPageProps, ValidationErrors } from '@guren/core'


export const pageManifest = {
  'auth/Login': './pages/auth/Login.tsx',
  'auth/Register': './pages/auth/Register.tsx',
  'dashboard/Index': './pages/dashboard/Index.tsx',
  'Home': './pages/Home.tsx',
  'posts/Edit': './pages/posts/Edit.tsx',
  'posts/Index': './pages/posts/Index.tsx',
  'posts/New': './pages/posts/New.tsx',
  'posts/Show': './pages/posts/Show.tsx',
  'profile/Edit': './pages/profile/Edit.tsx',
} as const

export type PageManifest = typeof pageManifest
export type PageId = keyof PageManifest
export type PagePath<TPage extends PageId = PageId> = PageManifest[TPage]

export const pageIds = Object.keys(pageManifest) as PageId[]

export function isPageId(value: string): value is PageId {
  return Object.prototype.hasOwnProperty.call(pageManifest, value)
}

type PostFormData = ApiRoutes['posts.store']['body']
/**
 * Auto-extracted Props types from page components.
 */
export interface PagePropsMap {
  'auth/Login': {
  email?: string
  errors?: ValidationErrors<'email' | 'password'>
}
  'auth/Register': {
  errors?: ValidationErrors<'name' | 'email' | 'password' | 'passwordConfirmation'>
}
  'dashboard/Index': {
  user?: { id: number; name: string; email: string } | null
}
  'Home': {
  latest: PostResourceData[]
}
  'posts/Edit': {
  post: PostFormData & { id: number }
}
  'posts/Index': PaginatedPageProps<PostResourceData> & {}
  'posts/Show': {
  post: PostResourceData
}
  'profile/Edit': {
  profile: { name: string; email: string }
  errors?: ValidationErrors<'name' | 'email' | 'password'>
  status?: string
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
  auth: {
    Login: defineGeneratedPage<'auth/Login', PagePropsMap['auth/Login']>('auth/Login', pageManifest['auth/Login']),
    Register: defineGeneratedPage<'auth/Register', PagePropsMap['auth/Register']>('auth/Register', pageManifest['auth/Register'])
  },
  dashboard: {
    Index: defineGeneratedPage<'dashboard/Index', PagePropsMap['dashboard/Index']>('dashboard/Index', pageManifest['dashboard/Index'])
  },
  Home: defineGeneratedPage<'Home', PagePropsMap['Home']>('Home', pageManifest['Home']),
  posts: {
    Edit: defineGeneratedPage<'posts/Edit', PagePropsMap['posts/Edit']>('posts/Edit', pageManifest['posts/Edit']),
    Index: defineGeneratedPage<'posts/Index', PagePropsMap['posts/Index']>('posts/Index', pageManifest['posts/Index']),
    New: defineGeneratedPage('posts/New', pageManifest['posts/New']),
    Show: defineGeneratedPage<'posts/Show', PagePropsMap['posts/Show']>('posts/Show', pageManifest['posts/Show'])
  },
  profile: {
    Edit: defineGeneratedPage<'profile/Edit', PagePropsMap['profile/Edit']>('profile/Edit', pageManifest['profile/Edit'])
  }
} as const
