import { resolve } from 'node:path'
import { literalString, walk } from './ast-walk'
import {
  discoverModuleRoutesFiles,
  discoverRoutesFiles,
  fileExists,
  findFirstExisting,
  listModuleNames,
  moduleRoutesEntryCandidates,
  toPosixRelative,
} from './discovery'
import type { ParseCache } from './parse-cache'
import { extractPathParamNames, PATH_PARAM_PATTERN } from './utils'
import { check, type CheckResult } from './check-result'

/**
 * Route registration methods, mapped to the argument index holding the path.
 * A hand-kept mirror of `Router`'s path-taking surface in @guren/server: anything
 * added there that takes a path belongs here too. `on` is at index 1 because its
 * signature is `on(method, path, ...)`. `group`/`resource` paths are not routes
 * themselves but are concatenated onto every route they cover.
 */
const ROUTE_PATH_ARGUMENT: Record<string, number> = {
  get: 0,
  post: 0,
  put: 0,
  patch: 0,
  delete: 0,
  query: 0,
  on: 1,
  group: 0,
  resource: 0,
}

/**
 * The name Hono binds for the first `:name*` parameter in a path, or `null` when the path
 * is fine. `/files/:slug*` registers the parameter `slug*` (verified against hono 4.13.1):
 * the route does not match `/files/a/b` and `param('slug')` is undefined. Only the label
 * is examined, so `:path{.+}` and a bare `*` segment are left alone — and the shared
 * pattern must keep `*` in the label, or this silently reports nothing.
 */
function firstStarSuffixedName(path: string): string | null {
  return extractPathParamNames(path).find((name) => name.endsWith('*')) ?? null
}

/**
 * The path this one should have been, with every `:name*` rewritten to the multi-segment
 * form `:name{.+}`. Driven by the same pattern that found the parameter, so detection and
 * fix cannot disagree. A parameter carrying both a star and a constraint (`:slug*{[a-z]+}`)
 * has no single obvious rewrite and is left as written.
 */
function withoutStarSuffixes(path: string): string {
  return path.replace(PATH_PARAM_PATTERN, (token: string, boundary: string, label: string) => {
    if (!label.endsWith('*') || token.includes('{')) return token
    return `${boundary}:${label.slice(0, -1)}{.+}${token.endsWith('?') ? '?' : ''}`
  })
}

/** A route path literal found in a routes file. */
interface RoutePathLiteral {
  path: string
  /** The method it was registered with, for the message. */
  method: string
}

/**
 * Route path literals a routes file registers. Walks the whole program, since routes are
 * registered inside `group()` callbacks and chained builders, and matches by property name
 * alone; the two guards against inventing routes are that the literal looks like a path
 * and that an argument follows it (a `Map` keyed by a path-shaped string passes the key
 * alone). Static literals only, so an interpolated path is missed, never invented.
 */
function routePathLiterals(program: unknown): RoutePathLiteral[] {
  const found: RoutePathLiteral[] = []

  walk(program, (node) => {
    if (node.type !== 'CallExpression') return
    const callee = node.callee as
      | { type?: string; computed?: boolean; property?: { type?: string; name?: string } }
      | undefined
    if (callee?.type !== 'MemberExpression' || callee.computed) return
    const method = callee.property?.type === 'Identifier' ? callee.property.name : undefined
    if (method === undefined) return

    const index = ROUTE_PATH_ARGUMENT[method]
    if (index === undefined) return

    const args = (node.arguments ?? []) as unknown[]
    if (args.length <= index + 1) return

    const path = literalString(args[index])
    if (path === null || !path.startsWith('/')) return

    found.push({ path, method })
  })

  return found
}

/**
 * Every file this check reads: the project's `routes/`, each module's `routes/`, and each
 * module's single-file `routes.ts` entry — the last is not redundant, since
 * `discoverModuleRoutesFiles` drops a module with no `routes/` *directory*, the shape
 * `make:module` scaffolds. Known gaps, both in `modules/<name>/index.ts`: an inline
 * `defineModule({ routes: (router) => ... })` and `defineModule({ prefix })`.
 */
export async function discoverRoutePathFiles(cwd: string, routesFile?: string): Promise<string[]> {
  const [projectFiles, moduleDirectories, moduleNames] = await Promise.all([
    discoverRoutesFiles(cwd),
    discoverModuleRoutesFiles(cwd),
    listModuleNames(cwd),
  ])

  const moduleEntries = await Promise.all(
    moduleNames.map((moduleName) => findFirstExisting(cwd, moduleRoutesEntryCandidates(`modules/${moduleName}`))),
  )

  const files = new Set([
    ...projectFiles,
    ...moduleDirectories.flatMap(({ files: moduleFiles }) => moduleFiles),
    ...moduleEntries.filter((entry): entry is string => entry !== null).map((entry) => resolve(cwd, entry)),
  ])

  if (routesFile !== undefined && (await fileExists(cwd, routesFile))) {
    files.add(resolve(cwd, routesFile))
  }

  return [...files].sort()
}

export interface RoutePathCheckOptions {
  cwd: string
  cache: ParseCache
  /** Absolute paths from {@link discoverRoutePathFiles}, `--changed`-filtered. */
  files: string[]
}

/**
 * Warns about route paths using `:name*`, which reads as a wildcard and is not one.
 * Nothing else reports it: the route registers, the app boots, and the only symptom is a
 * 404 for every URL the author expected to match. Findings only, so a clean app adds no
 * lines. `warn` because a parameter genuinely named `slug*` is legal — but not
 * `advisory`, so `check --ci` gates on it.
 */
export async function checkRoutePathParams(options: RoutePathCheckOptions): Promise<CheckResult[]> {
  const { cwd, cache, files } = options
  const results: CheckResult[] = []

  for (const filePath of files) {
    const parsed = await cache.get(filePath)
    if (!parsed) continue

    const relPath = toPosixRelative(cwd, filePath)
    const reported = new Set<string>()

    for (const { path, method } of routePathLiterals(parsed.ast.program)) {
      if (reported.has(path)) continue
      const name = firstStarSuffixedName(path)
      if (name === null) continue
      reported.add(path)

      results.push(
        check(
          `route-path-modifier:${relPath}:${path}`,
          `${relPath} route path`,
          'warn',
          `${method}('${path}') reads as a wildcard, but ':name*' is not wildcard syntax in Hono: it registers a `
          + `single-segment parameter named literally '${name}'. A request spanning more than one segment 404s, and `
          + `req.param('${name.slice(0, -1)}') is undefined.`,
          `Use a constrained parameter to match across segments — '${withoutStarSuffixes(path)}'. If a single `
          + `segment was intended, drop the '*' instead.`,
          relPath,
        ),
      )
    }
  }

  return results
}
