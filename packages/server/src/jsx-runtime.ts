/**
 * The app-facing JSX runtime for server-rendered content views (RFC 0014).
 *
 * Application View files opt in with a per-file `@jsxImportSource` pragma
 * pointing at `@guren/core`, which the compiler resolves to
 * `@guren/core/jsx-runtime` → here → hono. Routing the pragma through the
 * framework rather than at `hono/jsx` directly means applications never
 * declare hono themselves, and the runtime that compiles their JSX is the
 * same hono copy `Controller.view()` renders with — by construction, not by
 * install-layout luck.
 */
export * from 'hono/jsx/jsx-runtime'
