/**
 * `@guren/core/agent` — the browser-safe agent dispatch surface (RFC 0016 §3).
 *
 * `export *` rather than an allowlist, unlike `./lambda` and `./redis`: those
 * mirror a whole feature index and curate what an application should reach
 * for, while `@guren/server/agent` is already the curated entry — it exists
 * precisely to be small and to stay free of the application graph. Restating
 * its names here would give the same surface two definitions to keep in sync,
 * and an addition on the server side that never arrived would look like a
 * missing feature rather than a missing line.
 */
export * from '@guren/server/agent'
