/**
 * Development twin of `jsx-runtime.ts` — compilers emit imports from the
 * `/jsx-dev-runtime` subpath in dev transforms. See `jsx-runtime.ts` for why
 * the pragma routes through the framework.
 */
export * from 'hono/jsx/jsx-dev-runtime'
