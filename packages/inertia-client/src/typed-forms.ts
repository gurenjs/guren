/**
 * Type-safe form and error utilities for Guren + Inertia.
 *
 * These types enable bidirectional type safety between frontend forms
 * and backend route validation schemas.
 */

/**
 * Extract the body type for a named route from the API routes registry.
 *
 * @example
 * ```typescript
 * import type { ApiRoutes } from '@/.guren/api-client.gen'
 * import type { RouteBody } from '@guren/inertia-client/typed-forms'
 *
 * type PostFormData = RouteBody<ApiRoutes, 'posts.store'>
 * ```
 */
export type RouteBody<
  TRoutes extends Record<string, { body?: unknown }>,
  TName extends keyof TRoutes,
> = TRoutes[TName] extends { body: infer B } ? B : Record<string, unknown>

/**
 * Typed validation errors keyed by field names from a route's body schema.
 *
 * @example
 * ```typescript
 * import type { RouteErrors } from '@guren/inertia-client/typed-forms'
 *
 * // errors.title  — ✅ autocomplete
 * // errors.titl   — ❌ compile error
 * type PostErrors = RouteErrors<{ title: string; body: string }>
 * ```
 */
export type RouteErrors<TBody> = Partial<Record<keyof TBody & string, string | string[]>>

/**
 * Props shape for pages that receive validation errors.
 * Combines page-specific props with typed error fields.
 */
export type PageWithErrors<TProps extends Record<string, unknown>, TBody> = TProps & {
  errors?: RouteErrors<TBody>
}
