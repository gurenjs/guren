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

// These types are designed to be augmented by the generated routes.gen.ts
// via module augmentation or by passing the route manifest as a generic.

/**
 * Base route manifest shape. Users provide their generated RouteManifest.
 */
export interface RouteManifestLike {
  [name: string]: { method: string; path: string }
}

// Verbatim mirror of PATH_PARAM_TYPE_HELPERS in @guren/cli's
// routes-types-fragments.ts (its JSDoc has the why); pinned character for
// character by routes-types-fragments.test.ts there.
type SegmentParamKey<TSegment extends string> = TSegment extends `:${infer TParam}`
  ? TParam extends `${infer TName}{${string}`
    ? TName
    : TParam extends `${infer TName}?`
      ? TName
      : TParam
  : never
type PathParamKeys<TPath extends string> = TPath extends `${infer THead}/${infer TRest}`
  ? SegmentParamKey<THead> | PathParamKeys<TRest>
  : SegmentParamKey<TPath>
type HasPathParams<TPath extends string> = [PathParamKeys<TPath>] extends [never] ? false : true
type PathParamsOf<TPath extends string> =
  HasPathParams<TPath> extends false
    ? Record<string, never>
    : { [TKey in PathParamKeys<TPath>]: string | number }

// Verbatim mirror of PATH_PARAM_RUNTIME_HELPERS, from the same fragment
// module and under the same pin test as the type helpers above: token-based
// substitution, so a param name that prefixes another cannot corrupt it and
// keys the path lacks are no-ops.
function substituteParams(path: string, params?: Record<string, string | number>): string {
  if (!params) {
    return path
  }

  return path.replace(/(^|\/):([A-Za-z0-9_-]+\*?)(?:\{[^{}]*\{[^{}]*\}[^{}]*\}|\{[^{}]*\})?\??/gu, (match, prefix, key) => {
    if (!Object.prototype.hasOwnProperty.call(params, key)) {
      return match
    }

    return `${prefix}${encodeURIComponent(String(params[key]))}`
  })
}

type OmitHref<T> = Omit<T, 'href'>

export type TypedLinkProps<
  TManifest extends RouteManifestLike,
  TName extends keyof TManifest & string,
> = OmitHref<InertiaLinkProps> & {
  route: TName
} & (
  HasPathParams<TManifest[TName]['path']> extends true
    ? { params: PathParamsOf<TManifest[TName]['path']> }
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

    const href = substituteParams(entry.path, params)

    return React.createElement(InertiaLink, { ...rest, href } as any)
  }

  return TypedLink as <TName extends keyof TManifest & string>(
    props: TypedLinkProps<TManifest, TName>,
  ) => React.ReactElement
}

export type TypedFormProps<
  TManifest extends RouteManifestLike,
  TName extends keyof TManifest & string,
> = Omit<React.FormHTMLAttributes<HTMLFormElement>, 'action' | 'method'> & {
  route: TName
  method?: 'get' | 'post' | 'put' | 'patch' | 'delete'
} & (
  HasPathParams<TManifest[TName]['path']> extends true
    ? { params: PathParamsOf<TManifest[TName]['path']> }
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

    const action = substituteParams(entry.path, params)

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
