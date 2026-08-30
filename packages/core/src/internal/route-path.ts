/**
 * Re-export of `@guren/server/internal/route-path`, kept so
 * `@guren/core/internal/route-path` stays the specifier every consumer outside
 * `@guren/server` writes — `@guren/openapi` lexes route paths with it and
 * depends on `@guren/core`, not on the server package.
 *
 * The rule lives in `@guren/server` for the build-order reason the JSON Schema
 * walker beside it records: core's index is `export * from '@guren/server'`,
 * so core builds after server and a server module cannot import a core one.
 */
export * from '@guren/server/internal/route-path'
