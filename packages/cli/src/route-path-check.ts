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
import { check, type CheckResult } from './check-result'

/**
 * Route registration methods, mapped to the argument index holding the path.
 *
 * A hand-kept mirror of `Router`'s path-taking surface in @guren/server, and
 * it shipped one short: `resource(path, controller)` spreads its path over up
 * to seven routes and was invisible until a review caught it. Anything added
 * to `Router` that takes a path belongs here too — an advertised check with a
 * silent hole reads as coverage.
 *
 * `on` is the odd one out because its signature is `on(method, path, ...)`
 * (`Router.on` takes single strings, not Hono's array form), so reading
 * argument 0 for it would inspect the HTTP verb and never see the path.
 *
 * `group(prefix, callback)` and `resource(path, controller)` are not route
 * paths themselves: both are concatenated onto every route they cover, so a
 * modifier there is the same defect spread wider. `group`'s
 * `group(callback)` overload passes no string, which the checks below rule
 * out on their own.
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
 * One path segment that names a `:name*` parameter — the `/:slug*` shape —
 * or `null` for every other segment.
 *
 * Detection and rewrite come out of the same read on purpose. Deriving the
 * corrected segment separately meant re-deciding, by string comparison,
 * whether the segment carried a constraint or a trailing `?`, and the two
 * reads had already disagreed: `/:slug*?` was reported and then handed back
 * to the user unchanged as its own fix.
 *
 * Deliberately narrower than a path-param lexer: this asks a yes/no question
 * per segment rather than enumerating a path's parameter names, so it needs
 * none of the boundary and nesting rules a full lexer carries. The repo's
 * canonical one lives in `routes-types-fragments.ts` (mirrored into
 * @guren/inertia-client under a verbatim pin test) — derive from that if this
 * ever needs to answer more than "does this name end in a star?".
 *
 * The rule is Hono's own (`getPattern`, verified against hono 4.13.1): a
 * segment beginning `:` takes everything up to an optional `{constraint}` as
 * the parameter *name*, `[^{}]+`, with no special meaning for `*`. So
 * `/files/:slug*` registers a single-segment parameter literally named
 * `slug*` — it does not match `/files/a/b`, and `c.req.param('slug')` is
 * undefined.
 *
 * What must NOT match, and why the naive "does the segment contain `*`" test
 * is wrong: `:path{.+}`, `:path{.*}` and `:t{[0-9]{2}}` are legitimate
 * constrained parameters, and a bare `*` segment is Hono's real wildcard.
 * Only the name is examined, so all four are left alone.
 */
function starSuffixedSegment(segment: string): { name: string; rewrite: string } | null {
  if (!segment.startsWith(':')) return null

  const brace = segment.indexOf('{')
  const optional = brace === -1 && segment.endsWith('?')
  const name = segment.slice(1, brace === -1 ? (optional ? -1 : undefined) : brace)
  if (!name.endsWith('*')) return null

  // A segment carrying both a star and a constraint (`:slug*{[a-z]+}`) has no
  // single obvious rewrite, so it is left as written — the finding still names
  // it, and the fallback half of the suggestion still applies.
  const rewrite = brace === -1 ? `:${name.slice(0, -1)}{.+}${optional ? '?' : ''}` : segment
  return { name, rewrite }
}

/**
 * The name Hono binds for the first `:name*` in a path, or `null` when the
 * path is fine. First rather than every one: the finding is phrased about a
 * single parameter, and the suggested path below fixes them all regardless.
 */
function firstStarSuffixedName(path: string): string | null {
  for (const segment of path.split('/')) {
    const found = starSuffixedSegment(segment)
    if (found) return found.name
  }
  return null
}

/**
 * The path this one should have been, with every `:name*` rewritten to the
 * multi-segment form `:name{.+}`.
 *
 * Rebuilt from the split segments rather than patched by string replacement,
 * so a name appearing twice, or as a prefix of another, cannot rewrite the
 * wrong one.
 */
function withoutStarSuffixes(path: string): string {
  return path
    .split('/')
    .map((segment) => starSuffixedSegment(segment)?.rewrite ?? segment)
    .join('/')
}

/** A route path literal found in a routes file. */
interface RoutePathLiteral {
  path: string
  /** The method it was registered with, for the message. */
  method: string
}

/**
 * Route path literals a routes file registers.
 *
 * Walks the whole program rather than its top-level statements: routes are
 * routinely registered inside a `router.middleware('auth').group((auth) => {
 * auth.get(...) })` callback, and a chained builder (`router.get(...).name()`)
 * only appears as a nested node too.
 *
 * The member call is matched by property name alone, since the receiver is
 * whatever the registrar named its parameter (`router`, `baseRouter`, `auth`
 * inside a group). Two guards keep that looseness from inventing routes: the
 * literal must look like a path, and something must follow it. Every
 * registration passes a handler, controller, or callback after the path, while
 * the lookalike this would otherwise report — a `Map` keyed by a path-shaped
 * string — passes the key alone.
 *
 * Static literals only, so a path assembled from a constant or an
 * interpolation is invisible: this misses rather than invents.
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
 * Every file this check reads: the project's `routes/`, each module's
 * `routes/`, and each module's single-file `routes.ts` entry.
 *
 * The last of those is not redundant. `discoverModuleRoutesFiles` drops a
 * module with no `routes/` *directory*, which is exactly the shape
 * `make:module` scaffolds — so a check built on it alone would never read the
 * one routes file most modules have. The candidate list is
 * `moduleRoutesEntryCandidates`' own, shared with the wiring check, so the two
 * cannot come to disagree about where a module keeps its routes. `--routes` is
 * included for a third reason: an app that keeps its entry outside `routes/`
 * would otherwise have its busiest file skipped.
 *
 * Two known gaps, both in a module's descriptor (`modules/<name>/index.ts`)
 * rather than a routes file: a registrar written inline as
 * `defineModule({ routes: (router) => ... })`, and `defineModule({ prefix })`,
 * which is applied as a `group(prefix)` around every route the module
 * registers. Reading descriptors means opening a second class of file and
 * matching a second AST shape, for the one place a path can hide that no
 * scaffolder writes a parameter into.
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
 * Warns about route paths using `:name*`, which reads as a wildcard and is
 * not one.
 *
 * Nothing else reports this. The route registers, the app boots, and the only
 * symptom is a 404 for every URL the author expected to match — a shape the
 * routing guide's own wildcard wording invited, so apps written against it
 * carry the mistake with nothing to tell them.
 *
 * Findings only: a `pass` per route path would bury every other result under
 * one line per route. A `warn` rather than a `fail` because a parameter
 * genuinely named `slug*` is legal, if unlikely. Not `advisory`, though — the
 * same class as an unmounted route registrar, so `check --ci` gates on it, and
 * an app carrying one goes red there until the path is fixed.
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
