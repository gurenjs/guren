/**
 * The JSX runtime application View files compile against (RFC 0014):
 *
 * ```tsx
 * /** @jsxImportSource @guren/core *​/
 * ```
 *
 * A pure re-export of `@guren/server/jsx-runtime` (itself hono's), so the
 * pragma, `Controller.view()`'s renderer, and the framework all share one
 * hono copy. Apps never declare hono.
 */
export * from '@guren/server/jsx-runtime'
