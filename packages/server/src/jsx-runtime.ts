/**
 * The app-facing JSX runtime for server-rendered content views (RFC 0014).
 *
 * Application View files opt in with a per-file pragma:
 *
 * ```tsx
 * /** @jsxImportSource @guren/core *​/
 * ```
 *
 * which the compiler resolves to `@guren/core/jsx-runtime` →
 * `@guren/server/jsx-runtime` → here. Routing the pragma through the
 * framework rather than at `hono/jsx` directly means applications never
 * declare hono themselves, and the runtime that compiles their JSX is the
 * same hono copy `Controller.view()` renders with — by construction, not by
 * install-layout luck.
 */
export * from 'hono/jsx/jsx-runtime'
