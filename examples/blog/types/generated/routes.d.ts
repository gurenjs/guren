// Generated from routes/web.ts — DO NOT EDIT
// Run `guren routes:types` to regenerate.

import type { RequestPayload, VisitOptions } from '@inertiajs/core'

export {}

declare namespace Guren {
  export type RouteMethod = 'GET' | 'PATCH' | 'POST' | 'PUT'

  export type RoutePath =
    '/'
    | '/dashboard'
    | '/login'
    | '/logout'
    | '/posts'
    | `/posts/${string}`
    | `/posts/${string}/edit`
    | '/posts/new'
    | '/profile'

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
