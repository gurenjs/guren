/**
 * Kept so `@guren/core/internal/redact-query-params` stays the specifier plugins
 * write. The rule lives in `@guren/server` because core builds after server, so
 * a server module cannot import a core one. Named, not `export *`: the import-floor
 * audit reads a star re-export at the lowest server core's range admits.
 */
export { redactQueryParams, redactedMessage } from '@guren/server/internal/redact-query-params'
