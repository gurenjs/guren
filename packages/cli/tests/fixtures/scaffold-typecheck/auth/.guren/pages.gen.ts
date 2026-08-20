// Companion for typechecking templates/scaffold/auth (tsconfig.templates.json):
// the real `guren codegen` output for an app holding exactly those templates.
// To refresh after changing an auth view's Props: run `makeAuth` with
// `--verify` into a fixture app (plus a `Home.tsx` page), run
// `generatePageTypes({ extractProps: true })` there, and copy the result here.

import type { PageContract, PagePropsRecord } from '@guren/inertia-client'
import type { ValidationErrors } from '@guren/core'


export const pageManifest = {
  'auth/ForgotPassword': './pages/auth/ForgotPassword.tsx',
  'auth/Login': './pages/auth/Login.tsx',
  'auth/Register': './pages/auth/Register.tsx',
  'auth/ResetPassword': './pages/auth/ResetPassword.tsx',
  'auth/VerifyEmail': './pages/auth/VerifyEmail.tsx',
  'dashboard/Index': './pages/dashboard/Index.tsx',
  'Home': './pages/Home.tsx',
  'profile/Edit': './pages/profile/Edit.tsx',
} as const

export type PageManifest = typeof pageManifest
export type PageId = keyof PageManifest
export type PagePath<TPage extends PageId = PageId> = PageManifest[TPage]

export const pageIds = Object.keys(pageManifest) as PageId[]

export function isPageId(value: string): value is PageId {
  return Object.prototype.hasOwnProperty.call(pageManifest, value)
}

/**
 * Auto-extracted Props types from page components.
 */
export interface PagePropsMap {
  'auth/ForgotPassword': {
  errors?: ValidationErrors<'email'>
  status?: string
}
  'auth/Login': {
  email?: string
  errors?: ValidationErrors<'email' | 'password'>
}
  'auth/Register': {
  errors?: ValidationErrors<'name' | 'email' | 'password' | 'passwordConfirmation'>
}
  'auth/ResetPassword': {
  token: string
  email: string
  errors?: ValidationErrors<'token' | 'password' | 'passwordConfirmation'>
}
  'auth/VerifyEmail': {
  status?: string
}
  'dashboard/Index': {
  user?: { id: number; name: string; email: string } | null
}
  'Home': { message: string }
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
    ForgotPassword: defineGeneratedPage<'auth/ForgotPassword', PagePropsMap['auth/ForgotPassword']>('auth/ForgotPassword', pageManifest['auth/ForgotPassword']),
    Login: defineGeneratedPage<'auth/Login', PagePropsMap['auth/Login']>('auth/Login', pageManifest['auth/Login']),
    Register: defineGeneratedPage<'auth/Register', PagePropsMap['auth/Register']>('auth/Register', pageManifest['auth/Register']),
    ResetPassword: defineGeneratedPage<'auth/ResetPassword', PagePropsMap['auth/ResetPassword']>('auth/ResetPassword', pageManifest['auth/ResetPassword']),
    VerifyEmail: defineGeneratedPage<'auth/VerifyEmail', PagePropsMap['auth/VerifyEmail']>('auth/VerifyEmail', pageManifest['auth/VerifyEmail'])
  },
  dashboard: {
    Index: defineGeneratedPage<'dashboard/Index', PagePropsMap['dashboard/Index']>('dashboard/Index', pageManifest['dashboard/Index'])
  },
  Home: defineGeneratedPage<'Home', PagePropsMap['Home']>('Home', pageManifest['Home']),
  profile: {
    Edit: defineGeneratedPage<'profile/Edit', PagePropsMap['profile/Edit']>('profile/Edit', pageManifest['profile/Edit'])
  }
} as const
