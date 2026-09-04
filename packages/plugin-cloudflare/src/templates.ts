import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The OAuth consent flow this plugin scaffolds, shipped as **real source files**
 * under `templates/mcp-oauth/` rather than string literals. A template's path
 * relative to that tree is exactly the path it is written to in the app, so the
 * relative import from `routes/mcp-oauth.ts` into `app/Http/Controllers/`
 * resolves in the template tree *and* in the scaffolded app. Real sources
 * because a template literal is TypeScript to no tool; these are inside the root
 * `tsconfig` program, so `bun run typecheck` compiles them as app-shaped code.
 * `templates/` is published and sits outside `dist/`, which is why the URL below
 * climbs one level and works from `dist/` and `src/` alike.
 */
const templateDir = fileURLToPath(new URL('../templates/mcp-oauth', import.meta.url))

/** The routes template, named once — the scaffold reports on it specifically. */
export const MCP_OAUTH_ROUTES_FILE = 'routes/mcp-oauth.ts'

/** The controller template, named for the assertions that read its source. */
export const MCP_OAUTH_CONTROLLER_FILE = 'app/Http/Controllers/McpOAuthController.ts'

/** The consent screen component, likewise. */
export const MCP_OAUTH_CONSENT_VIEW_FILE = 'app/View/McpOAuthConsentPage.tsx'

/** The error page component, likewise. */
export const MCP_OAUTH_ERROR_VIEW_FILE = 'app/View/McpOAuthErrorPage.tsx'

/**
 * Every file the consent-flow scaffold writes, in the order it writes them. A
 * list rather than a directory walk: a walk would silently start writing
 * anything that landed in the template tree, a stray `.d.ts` included.
 */
export const MCP_OAUTH_TEMPLATE_FILES = [
  MCP_OAUTH_CONSENT_VIEW_FILE,
  MCP_OAUTH_ERROR_VIEW_FILE,
  MCP_OAUTH_CONTROLLER_FILE,
  MCP_OAUTH_ROUTES_FILE,
] as const

/**
 * The registrar the routes template exports. Named here because two places spell
 * it — the template and the wiring instruction the scaffold prints — and a
 * rename updating only one would print an import of a missing function.
 */
export const MCP_OAUTH_REGISTRAR = 'registerMcpOAuthRoutes'

/** Read one shipped template, `path` in POSIX form and relative to the tree. */
export function loadMcpOAuthTemplate(path: string): string {
  return readFileSync(join(templateDir, ...path.split('/')), 'utf8')
}
