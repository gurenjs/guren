import { resolve } from 'node:path'
import { walk } from './ast-walk'
import {
  discoverModuleRoutesFiles,
  discoverRoutesFiles,
  fileExists,
  findFirstExisting,
  listModuleNames,
  toPosixRelative,
} from './discovery'
import type { ParseCache } from './parse-cache'
import { check, type CheckResult } from './check-result'

/**
 * Route registration methods, mapped to the argument index holding the path.
 *
 * `on` is the odd one out because its signature is `on(method, path, ...)`
 * (`Router.on` in @guren/server takes single strings, not Hono's array form),
 * so reading argument 0 for it would inspect the HTTP verb and never see the
 * path.
 *
 * `group(prefix, callback)` is deliberately included even though a prefix is
 * not a route path: it is concatenated onto every path registered inside the
 * callback, so a modifier there is the same defect spread over more routes.
 * Its `group(callback)` overload passes no string, which the literal check
 * below rules out on its own.
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
}

/**
 * The parameter name a path segment registers, when that name ends with `*`
 * — the `/:slug*` shape — and `null` for every other segment.
 *
 * Deliberately narrower than a path-param lexer: this asks a yes/no question
 * per segment rather than enumerating a path's parameter names, so it needs
 * none of the boundary and nesting rules a full lexer carries. When
 * `PATH_PARAM_PATTERN` (packages/cli/src/utils.ts) lands, derive from it
 * rather than growing a second lexer here.
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
 * Only the name is examined, so all four are left alone. A trailing `?`
 * (optional parameter) is stripped first, so `/:slug*?` is caught as well.
 */
function starSuffixedName(segment: string): string | null {
  if (!segment.startsWith(':')) return null
  const brace = segment.indexOf('{')
  const name = brace === -1 ? segment.slice(1).replace(/\?$/u, '') : segment.slice(1, brace)
  return name.endsWith('*') ? name : null
}

/** One `:name*` parameter, as found in a path. */
interface StarSuffixedParam {
  /** The parameter name Hono actually registers, e.g. `slug*`. */
  name: string
  /** The name without its trailing `*`, e.g. `slug` — what the author meant. */
  intended: string
}

/**
 * The `:name*` parameters in a route path, in order. Empty for every path
 * that is fine.
 */
function starSuffixedParams(path: string): StarSuffixedParam[] {
  return path.split('/').flatMap((segment) => {
    const name = starSuffixedName(segment)
    return name === null ? [] : [{ name, intended: name.slice(0, -1) }]
  })
}

/**
 * The path this one should have been, with each `:name*` rewritten to the
 * multi-segment form `:name{.+}`.
 *
 * Rebuilt from the split segments rather than patched by string replacement,
 * so a name appearing twice, or as a prefix of another, cannot rewrite the
 * wrong one. A segment carrying both a star and a constraint (`:slug*{[a-z]+}`)
 * has no single obvious rewrite, so it is left as written — the finding still
 * names it, and the fallback half of the suggestion still applies.
 */
function withoutStarSuffixes(path: string): string {
  return path
    .split('/')
    .map((segment) => {
      const name = starSuffixedName(segment)
      return name !== null && segment === `:${name}` ? `:${name.slice(0, -1)}{.+}` : segment
    })
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
 * Static-literal only, and the literal must start with `/`. Both halves keep
 * the loose member-call match honest — a path built by concatenation is
 * invisible (a miss, never an invention), and an ordinary `map.get('key')`
 * inside a routes file cannot be mistaken for a route.
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

    const args = (node.arguments ?? []) as Array<{ type?: string; value?: unknown }>
    const argument = args[index]
    if (argument?.type !== 'StringLiteral' || typeof argument.value !== 'string') return
    if (!argument.value.startsWith('/')) return

    found.push({ path: argument.value, method })
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
 * one routes file most modules have. `--routes` is included for the same
 * reason: an app that keeps its entry outside `routes/` would otherwise have
 * its busiest file skipped.
 *
 * Known gap: routes registered inline in a module descriptor
 * (`defineModule({ routes: (router) => ... })` in `modules/<name>/index.ts`).
 * Reading descriptors here would mean parsing files this check otherwise has
 * no reason to open, for a shape the scaffolders do not write.
 */
export async function discoverRoutePathFiles(cwd: string, routesFile?: string): Promise<string[]> {
  const files = new Set(await discoverRoutesFiles(cwd))

  for (const { files: moduleFiles } of await discoverModuleRoutesFiles(cwd)) {
    for (const file of moduleFiles) files.add(file)
  }

  for (const moduleName of await listModuleNames(cwd)) {
    const entry = await findFirstExisting(
      cwd,
      ['ts', 'mts', 'js', 'mjs'].map((extension) => `modules/${moduleName}/routes.${extension}`),
    )
    if (entry !== null) files.add(resolve(cwd, entry))
  }

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
 * routing guide itself recommended until recently, so apps written against it
 * carry the mistake with nothing to tell them.
 *
 * Findings only: a `pass` per route path would bury every other result under
 * one line per route. A `warn` rather than a `fail` because a parameter
 * genuinely named `slug*` is legal, if unlikely — and plain `guren check`
 * does not gate on exit code anyway, so this cannot redden an app's CI.
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
      const params = starSuffixedParams(path)
      if (params.length === 0 || reported.has(path)) continue
      reported.add(path)

      const [first] = params
      const named = params.map((param) => `'${param.name}'`).join(', ')

      results.push(
        check(
          `route-path-modifier:${relPath}:${path}`,
          `${relPath} route path`,
          'warn',
          `${method}('${path}') reads as a wildcard, but ':name*' is not wildcard syntax in Hono: it registers a `
          + `single-segment parameter named literally ${named}. A request spanning more than one segment 404s, and `
          + `req.param('${first.intended}') is undefined.`,
          `Use a constrained parameter to match across segments — '${withoutStarSuffixes(path)}'. If a single `
          + `segment was intended, drop the '*' instead.`,
          relPath,
        ),
      )
    }
  }

  return results
}
