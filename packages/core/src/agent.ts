/**
 * The browser-safe agent dispatch surface (RFC 0016 §3). `export *` rather than
 * an allowlist like `./lambda` and `./redis`: `@guren/server/agent` is already
 * the curated entry, and restating its names would need keeping in sync.
 */
export * from '@guren/server/agent'
