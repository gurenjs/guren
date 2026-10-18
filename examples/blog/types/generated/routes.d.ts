// Generated from routes/web.ts — DO NOT EDIT
// Run `guren codegen` to regenerate.

export {}

declare namespace Guren {
  export type RouteMethod = 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT'

  export type RoutePath =
    '/'
    | `/attachments/${string}/${string}`
    | `/auth/${string}`
    | `/auth/${string}/callback`
    | '/dashboard'
    | '/forgot-password'
    | '/health'
    | '/login'
    | '/logout'
    | '/posts'
    | `/posts/${string}`
    | `/posts/${string}/edit`
    | '/posts/new'
    | '/profile'
    | '/register'
    | '/reset-password'
    | '/verify-email'
    | '/verify-email/confirm'

  export type RouteUrl = RoutePath | `${RoutePath}?${string}`

  export interface RouteMeta {
    method: RouteMethod
    path: RoutePath
    name?: string
  }
}
