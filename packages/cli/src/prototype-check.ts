/**
 * Prototype wiring checks (RFC 0021 §5). Every rule here is a request-time
 * 500 or a dead link in the customer's walkthrough: a `prototype` route the
 * fixture cannot answer, a fixture entry naming no registered route, a
 * route the client matcher cannot tell from another. Content-activated: an
 * app with no fixture and no `prototype` route contributes nothing. The
 * fixture is read as source, anchored on `definePrototype(`; a dynamic
 * `routes` object is reported as unreadable rather than passed.
 */
import { relative, resolve } from 'node:path'
import type { CallExpression, File, ObjectExpression } from '@babel/types'
import type { RouteDefinition } from '@guren/core'
import { memberKeyName, objectLiteral, propertyValue, walk, type BabelNode } from './ast-walk'
import { check, type CheckResult } from './check-result'
import { fileExists, readIfExists } from './discovery'
import { discoverRoutePathFiles } from './route-path-check'
import type { ParseCache } from './parse-cache'
import { resolveAppEntry } from './provider-registrar'

/** `prototype` passed where a handler goes: `, prototype)` or `, prototype,` (options first). */
const PROTOTYPE_HANDLER_PATTERN = /[,(]\s*prototype\s*[),]/u

/**
 * Whether any routes file passes the `prototype` handler, by source, so a
 * caller can avoid loading the route graph for an app that never did.
 * A file that cannot be read counts as declaring, since silence there would
 * skip the load for the one app that needs it.
 */
export async function appDeclaresPrototypeRoutes(cwd: string, routesFile?: string): Promise<boolean> {
  const files = await discoverRoutePathFiles(cwd, routesFile)
  const declaring = await Promise.all(
    files.map(async (file) => {
      const source = await readIfExists(cwd, relative(cwd, file))
      return source === null ? true : PROTOTYPE_HANDLER_PATTERN.test(source)
    }),
  )
  return declaring.some(Boolean)
}

/** Where `guren add prototype` writes the fixture and the client entry imports it from. */
export const PROTOTYPE_FIXTURE_FILE = 'resources/js/prototype/index.ts'
const CLIENT_ENTRY_FILE = 'resources/js/app.tsx'

export interface FixtureRoutes {
  /** Route names the fixture's `routes` object declares with literal keys. */
  names: Set<string>
  /** Why the keys could not all be read, when they could not. */
  unreadable?: string
}

/**
 * The literal keys of `routes` in the first `definePrototype({...})` call. A
 * spread, a computed key or a non-literal argument means the set is not
 * knowable from source, which the caller reports instead of treating as empty.
 */
export function fixtureRoutesFromAst(ast: File): FixtureRoutes | null {
  let call: CallExpression | undefined
  walk(ast, (node) => {
    if (call || node.type !== 'CallExpression') return
    const callee = (node as unknown as CallExpression).callee
    const named =
      (callee.type === 'Identifier' && callee.name === 'definePrototype')
      || (callee.type === 'MemberExpression' && callee.property.type === 'Identifier' && callee.property.name === 'definePrototype')
    if (named) {
      call = node as unknown as CallExpression
      return false
    }
    return undefined
  })
  if (!call) return null

  const input = objectLiteral(call.arguments[0] as never)
  if (!input) return { names: new Set(), unreadable: 'definePrototype() is not called with an object literal' }

  const routes = objectLiteral(propertyValue(input, 'routes') as never)
  if (!routes) return { names: new Set(), unreadable: '`routes` is not an object literal' }

  return readKeys(routes)
}

function readKeys(routes: ObjectExpression): FixtureRoutes {
  const names = new Set<string>()
  for (const entry of routes.properties as unknown as BabelNode[]) {
    if (entry.type === 'SpreadElement') {
      return { names, unreadable: '`routes` contains a spread' }
    }
    const key = memberKeyName(entry as never)
    if (key === undefined) {
      return { names, unreadable: '`routes` contains a computed key' }
    }
    names.add(key)
  }
  return { names }
}

export interface PrototypeCheckOptions {
  cwd: string
  cache: ParseCache
  /** Loaded route definitions; `undefined` when the route graph could not be loaded. */
  definitions?: RouteDefinition[]
}

function describe(route: RouteDefinition): string {
  return `${route.method.toUpperCase()} ${route.path}${route.name ? ` (${route.name})` : ''}`
}

export async function checkPrototypeRoutes(options: PrototypeCheckOptions): Promise<CheckResult[]> {
  const { cwd, cache } = options
  const definitions = options.definitions ?? []
  const fixturePath = resolve(cwd, PROTOTYPE_FIXTURE_FILE)
  const hasFixture = await fileExists(cwd, PROTOTYPE_FIXTURE_FILE)
  const prototypeRoutes = definitions.filter((route) => route.prototype)

  if (!hasFixture && prototypeRoutes.length === 0) {
    return checkClientWiringWithoutFixture(cwd)
  }

  const results: CheckResult[] = []
  const title = 'Prototype routes'

  for (const route of prototypeRoutes) {
    if (!route.name) {
      results.push(
        check(
          `prototype-route-unnamed:${route.method}:${route.path}`,
          title,
          'fail',
          `${describe(route)} uses the prototype handler but has no name; the fixture is keyed by route name, so the boot fails.`,
          'Chain .name() on the route or pass { name } in its options.',
        ),
      )
    }
    if (route.agent) {
      results.push(
        check(
          `prototype-route-agent:${route.name ?? route.path}`,
          title,
          'fail',
          `${describe(route)} declares .agent() metadata while still on its fixture, so the tool manifest would advertise an action nothing implements.`,
          'Replace the prototype handler with a controller before exposing the route as a tool, or drop .agent() until then.',
        ),
      )
    }
  }

  if (prototypeRoutes.length > 0) {
    results.push(await checkAppWiring(cwd, prototypeRoutes))
  }

  let fixture: FixtureRoutes | null = null
  if (hasFixture) {
    const parsed = await cache.get(fixturePath)
    fixture = parsed ? fixtureRoutesFromAst(parsed.ast) : null
    const relPath = relative(cwd, fixturePath)
    if (!parsed) {
      results.push(check('prototype-fixture-unreadable', title, 'warn', `${relPath} could not be parsed, so its entries were not checked.`, undefined, relPath))
    } else if (!fixture) {
      results.push(
        check(
          'prototype-fixture-unreadable',
          title,
          'warn',
          `${relPath} has no definePrototype() call, so its entries were not checked.`,
          'Export `definePrototype({ manifest, routes })` as the default export.',
          relPath,
        ),
      )
    } else if (fixture.unreadable) {
      results.push(
        check(
          'prototype-fixture-unreadable',
          title,
          'warn',
          `${relPath}: ${fixture.unreadable}, so its entries were not checked (unreadable, not passed).`,
          'Declare every route with a literal key so the check and the client can read them.',
          relPath,
        ),
      )
      fixture = null
    }
  } else if (prototypeRoutes.length > 0) {
    results.push(
      check(
        'prototype-fixture-missing',
        title,
        'fail',
        `${prototypeRoutes.length} route(s) use the prototype handler but ${PROTOTYPE_FIXTURE_FILE} does not exist, so the boot fails.`,
        'Run `bunx guren add prototype`, or replace the handlers with controllers.',
      ),
    )
  }

  if (fixture && options.definitions) {
    results.push(...checkEntries(fixture, options.definitions, prototypeRoutes, relative(cwd, fixturePath)))
  } else if (fixture) {
    // Without the graph an orphaned entry is invisible, and silence would read
    // as "every entry names a route".
    results.push(
      check(
        'prototype-fixture-unverified',
        title,
        'warn',
        `${relative(cwd, fixturePath)} declares ${fixture.names.size} entries, but the route graph did not load, so they were not checked against the registered routes.`,
        'Fix the route graph (see the route-graph result of `bunx guren check`), then run: bunx guren check --prototype',
        relative(cwd, fixturePath),
      ),
    )
  }

  if (results.length === 0) {
    const covered = prototypeRoutes.length > 0
      ? `${prototypeRoutes.length} prototype route(s) have a fixture entry`
      : 'every fixture entry names a registered route'
    results.push(check('prototype-routes', title, 'pass', `${covered}; the prototype wiring is consistent.`))
  }

  return results
}

function checkEntries(
  fixture: FixtureRoutes,
  definitions: RouteDefinition[],
  prototypeRoutes: RouteDefinition[],
  relPath: string,
): CheckResult[] {
  const results: CheckResult[] = []
  const title = 'Prototype routes'
  const byName = new Map(definitions.filter((route) => route.name).map((route) => [route.name!, route]))

  for (const route of prototypeRoutes) {
    if (route.name && !fixture.names.has(route.name)) {
      results.push(
        check(
          `prototype-route-unanswered:${route.name}`,
          title,
          'fail',
          `${describe(route)} uses the prototype handler but ${relPath} has no '${route.name}' entry, so the boot fails.`,
          `Add '${route.name}' to \`routes\` in ${relPath}, or replace the handler with a controller.`,
          relPath,
        ),
      )
    }
  }

  for (const name of fixture.names) {
    if (!byName.has(name)) {
      results.push(
        check(
          `prototype-fixture-orphan:${name}`,
          title,
          'fail',
          `${relPath} answers '${name}', but no registered route has that name; the entry is dead and its page is unreachable in the prototype.`,
          'Remove the entry, or register (and name) the route it was written for.',
          relPath,
        ),
      )
    }
  }

  const seen = new Map<string, RouteDefinition>()
  for (const route of definitions) {
    if (!route.name) continue
    const key = `${route.method.toUpperCase()} ${route.path}`
    const other = seen.get(key)
    if (other) {
      results.push(
        check(
          `prototype-route-ambiguous:${route.name}`,
          title,
          'fail',
          `${describe(route)} and ${describe(other)} share a method and path; the prototype's URL matcher cannot tell which fixture entry answers.`,
          'Give the two routes distinct paths, or drop the one the prototype should not serve.',
        ),
      )
    } else {
      seen.set(key, route)
    }
  }

  const unreachable = definitions.filter(
    (route) => route.name && route.method.toUpperCase() === 'GET' && !fixture.names.has(route.name),
  )
  if (unreachable.length > 0) {
    // Advisory: a walkthrough rarely covers every screen, and a gate that fails
    // on coverage would fail every app that keeps its fixture after promotion.
    results.push({
      ...check(
        'prototype-pages-unreachable',
        title,
        'warn',
        `${unreachable.length} named GET route(s) have no fixture entry and are not reachable in the prototype: ${unreachable.map((route) => route.name).join(', ')}.`,
        `Add entries to ${relPath} for the screens the walkthrough should reach; a link to one of these opens the 404 dialog.`,
        relPath,
      ),
      advisory: true,
    })
  }

  return results
}

/** `createApp()` must hand the fixture over, or the boot fails on the first prototype route. */
async function checkAppWiring(cwd: string, prototypeRoutes: RouteDefinition[]): Promise<CheckResult> {
  const key = 'prototype-app-wiring'
  const title = 'Prototype routes'
  const appPath = await resolveAppEntry(cwd)
  const entry = appPath === null ? null : await readIfExists(cwd, appPath)

  if (entry !== null && /\bprototype\s*:/u.test(entry)) {
    return check(key, title, 'pass', `${appPath} passes a prototype loader to createApp().`)
  }

  return check(
    key,
    title,
    'fail',
    `${prototypeRoutes.length} route(s) use the prototype handler, but ${appPath ?? 'the app entry'} does not pass \`prototype\` to createApp(), so the boot fails.`,
    "Add `prototype: () => import('../resources/js/prototype/index.js')` to createApp(), or run `bunx guren add prototype`.",
    appPath ?? undefined,
  )
}

/**
 * The client entry can name a fixture module that does not exist: the
 * production build is fine (the branch is dead), and `--mode prototype` fails
 * at the first import. Reported even when nothing else activates the suite.
 */
async function checkClientWiringWithoutFixture(cwd: string): Promise<CheckResult[]> {
  const entry = await readIfExists(cwd, CLIENT_ENTRY_FILE)
  if (entry === null || !/\bprototype\s*:/u.test(entry) || !entry.includes('./prototype')) return []
  return [
    check(
      'prototype-client-wiring',
      'Prototype routes',
      'fail',
      `${CLIENT_ENTRY_FILE} wires a prototype module into startInertiaClient(), but ${PROTOTYPE_FIXTURE_FILE} does not exist; \`vite --mode prototype\` fails at that import.`,
      'Run `bunx guren add prototype` to write the fixture, or remove the `prototype` option from startInertiaClient().',
      CLIENT_ENTRY_FILE,
    ),
  ]
}
