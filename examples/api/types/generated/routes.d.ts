// Generated from routes/api.ts — DO NOT EDIT
// Run `guren codegen` to regenerate.

import type { RequestPayload, VisitOptions } from '@inertiajs/core'

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

declare module '@inertiajs/react' {
  interface BaseInertiaLinkProps {
    href: Guren.RouteUrl
  }
}

declare module '@inertiajs/core' {
  interface Router {
    visit(href: Guren.RouteUrl, options?: VisitOptions): void
    get(url: Guren.RouteUrl, data?: RequestPayload, options?: Omit<VisitOptions, 'method' | 'data'>): void
    post(url: Guren.RouteUrl, data?: RequestPayload, options?: Omit<VisitOptions, 'method' | 'data'>): void
    put(url: Guren.RouteUrl, data?: RequestPayload, options?: Omit<VisitOptions, 'method' | 'data'>): void
    patch(url: Guren.RouteUrl, data?: RequestPayload, options?: Omit<VisitOptions, 'method' | 'data'>): void
    delete(url: Guren.RouteUrl, options?: Omit<VisitOptions, 'method'>): void
    replace(url: Guren.RouteUrl, options?: Omit<VisitOptions, 'replace'>): void
  }
}
