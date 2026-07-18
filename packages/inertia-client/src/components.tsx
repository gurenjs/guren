/**
 * Type-safe route-name-based Link and Form components for Guren + Inertia.
 *
 * These wrap Inertia's `<Link>` with route name resolution, providing
 * compile-time checking of route names and parameters.
 *
 * @example
 * ```tsx
 * import { Link, Form } from '@guren/inertia-client/components'
 *
 * // ✅ Route name autocomplete, params type-checked
 * <Link route="posts.show" params={{ id: 1 }}>View post</Link>
 *
 * // ❌ Compile error: missing required param 'id'
 * <Link route="posts.show">View post</Link>
 *
 * // ✅ Form with typed route
 * <Form route="posts.store" method="post">...</Form>
 * ```
 */
import React from 'react'
import { Link as InertiaLink, router } from '@inertiajs/react'
import type { InertiaLinkProps } from '@inertiajs/react'

// ─── Route type infrastructure ───────────────────────────────
// These types are designed to be augmented by the generated routes.gen.ts
// via module augmentation or by passing the route manifest as a generic.

/**
 * Base route manifest shape. Users provide their generated RouteManifest.
 */
export interface RouteManifestLike {
  [name: string]: { method: string; path: string }
}

type ExtractParams<TPath extends string> =
  TPath extends `${string}:${infer Param}/${infer Rest}`
    ? (Param extends `${infer Key}?` ? Key : Param) | ExtractParams<`/${Rest}`>
    : TPath extends `${string}:${infer Param}`
      ? Param extends `${infer Key}?` ? Key : Param
      : never

type RouteParamsFor<TPath extends string> =
  [ExtractParams<TPath>] extends [never]
    ? Record<string, never>
    : { [K in ExtractParams<TPath>]: string | number }

type HasParams<TPath extends string> =
  [ExtractParams<TPath>] extends [never] ? false : true

// ─── Link component ──────────────────────────────────────────

type OmitHref<T> = Omit<T, 'href'>

export type TypedLinkProps<
  TManifest extends RouteManifestLike,
  TName extends keyof TManifest & string,
> = OmitHref<InertiaLinkProps> & {
  route: TName
} & (
  HasParams<TManifest[TName]['path']> extends true
    ? { params: RouteParamsFor<TManifest[TName]['path']> }
    : { params?: never }
)

/**
 * Create a typed Link component factory bound to your route manifest.
 *
 * @example
 * ```tsx
 * import { routeManifest } from '@/.guren/routes.gen'
 * const Link = createTypedLink(routeManifest)
 *
 * <Link route="posts.show" params={{ id: 1 }}>View</Link>
 * ```
 */
export function createTypedLink<TManifest extends RouteManifestLike>(manifest: TManifest) {
  function TypedLink<TName extends keyof TManifest & string>(
    props: TypedLinkProps<TManifest, TName>,
  ) {
    const { route: routeName, params, ...rest } = props as TypedLinkProps<TManifest, string> & { params?: Record<string, string | number> }
    const entry = manifest[routeName]
    if (!entry) throw new Error(`Route [${routeName}] not defined.`)

    let href = entry.path
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        href = href.replace(`:${key}`, encodeURIComponent(String(value)))
      }
    }

    return React.createElement(InertiaLink, { ...rest, href } as any)
  }

  return TypedLink as <TName extends keyof TManifest & string>(
    props: TypedLinkProps<TManifest, TName>,
  ) => React.ReactElement
}

// ─── Form component ──────────────────────────────────────────

export type TypedFormProps<
  TManifest extends RouteManifestLike,
  TName extends keyof TManifest & string,
> = Omit<React.FormHTMLAttributes<HTMLFormElement>, 'action' | 'method'> & {
  route: TName
  method?: 'get' | 'post' | 'put' | 'patch' | 'delete'
} & (
  HasParams<TManifest[TName]['path']> extends true
    ? { params: RouteParamsFor<TManifest[TName]['path']> }
    : { params?: never }
)

/**
 * Create a typed Form component factory bound to your route manifest.
 */
export function createTypedForm<TManifest extends RouteManifestLike>(manifest: TManifest) {
  function TypedForm<TName extends keyof TManifest & string>(
    props: TypedFormProps<TManifest, TName>,
  ) {
    const { route: routeName, params, method, children, ...rest } = props as TypedFormProps<TManifest, string> & { params?: Record<string, string | number> }
    const entry = manifest[routeName]
    if (!entry) throw new Error(`Route [${routeName}] not defined.`)

    let action = entry.path
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        action = action.replace(`:${key}`, encodeURIComponent(String(value)))
      }
    }

    const httpMethod = method ?? entry.method.toLowerCase()

    const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      const formData = new FormData(event.currentTarget)
      const data = Object.fromEntries(formData.entries())
      ;(router as any)[httpMethod](action, data)
    }

    return React.createElement('form', { ...rest, onSubmit: handleSubmit }, children)
  }

  return TypedForm as <TName extends keyof TManifest & string>(
    props: TypedFormProps<TManifest, TName>,
  ) => React.ReactElement
}
