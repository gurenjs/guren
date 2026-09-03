/**
 * Type-safe form and error utilities for Guren + Inertia: bidirectional type
 * safety between frontend forms and a route's backend validation schema.
 */

/**
 * Extract the body type for a named route from the API routes registry.
 * @example type PostFormData = RouteBody<ApiRoutes, 'posts.store'>
 */
export type RouteBody<TRoutes, TName extends keyof TRoutes> =
  TRoutes[TName] extends { body: infer B } ? B : Record<string, unknown>

/** Typed validation errors keyed by field names from a route's body schema. */
export type RouteErrors<TBody> = Partial<Record<keyof TBody & string, string | string[]>>

/** Page props combined with typed error fields. */
export type PageWithErrors<TProps extends Record<string, unknown>, TBody> = TProps & {
  errors?: RouteErrors<TBody>
}
