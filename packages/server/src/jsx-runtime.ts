/**
 * The app-facing JSX runtime for server-rendered content views (RFC 0014).
 * View files point their `@jsxImportSource` pragma at `@guren/core`, which
 * resolves here and then to hono: apps never declare hono themselves, and their
 * JSX compiles against the same hono copy `Controller.view()` renders with.
 */
export * from 'hono/jsx/jsx-runtime'
