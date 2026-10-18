// Generated from routes/api.ts — DO NOT EDIT
// Run `guren codegen` to regenerate.

export {}

declare namespace Guren {
  export type RouteMethod = 'DELETE' | 'GET' | 'POST' | 'PUT'

  export type RoutePath =
    '/api/auth/login'
    | '/api/auth/register'
    | '/api/auth/tokens'
    | `/api/auth/tokens/${string}`
    | '/api/auth/user'
    | '/api/tasks'
    | `/api/tasks/${string}`

  export type RouteUrl = RoutePath | `${RoutePath}?${string}`

  export interface RouteMeta {
    method: RouteMethod
    path: RoutePath
    name?: string
  }
}
