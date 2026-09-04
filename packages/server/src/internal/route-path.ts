/**
 * The one Hono route-path lexing rule, shared by the router's substitution and
 * binding scanners, RFC 0016's agent tool input, and `@guren/openapi`'s path
 * template. Two lexers is how `/files/:name*` came to yield the parameter
 * `name` in openapi and `name*` — what Hono registers — everywhere else; what
 * legitimately differs is rendering, at the call site (`stripExplodeModifier`).
 * Internal per `contributing/api-stability.md`; re-exported by
 * `@guren/core/internal/route-path`, since core's index is
 * `export * from '@guren/server'` and a server module cannot import a core one.
 */

// A param starts only at a segment boundary (`/status/foo:bar` is a literal), an
// attached regex constraint is consumed whole, and the `*` sits *inside* the
// capture because Hono keeps it in the parameter's name; the `?` does not.
// The constraint is spelled to one level of nesting rather than with a nested
// quantifier so a scan stops at the next brace: the `\{[^}]*\}(?:[^/]*\})*`
// shape it replaces was quadratic (CodeQL js/polynomial-redos; 2.9s for a
// 16k-char path, vs 1.9ms here).
export const PATH_PARAM_PATTERN = /(^|\/):([A-Za-z0-9_-]+\*?)(?:\{[^{}]*\{[^{}]*\}[^{}]*\}|\{[^{}]*\})?\??/gu

/**
 * Param labels in path order, exactly as Hono registers them: constraints
 * dropped, a trailing `*` kept (part of the name), a trailing `?` dropped.
 */
export function extractPathParamNames(path: string): string[] {
  return Array.from(path.matchAll(PATH_PARAM_PATTERN), (match) => match[2]!)
}
