import { deriveAgentTools } from '../agent/derive'
import { resourceAbilityForMethod } from '../authorization/middleware'
import type { Container } from '../container/Container'
import type { GurenModule } from '../container/defineModule'
import type { AuthPluginOptions } from '../http/Application'
import { toJsonSchema } from '../internal/zod-json-schema'
import type { RouteDefinition, Router } from '../mvc/Router'
import type {
  AppManifest,
  AttachmentsEntry,
  MiddlewareEntry,
  ManifestWarning,
  ProviderEntry,
  RouteEntry,
  SessionEntry,
} from './types'

/** Where each module's routes landed in the registry, `[start, end)`. */
export interface ModuleRouteRange {
  readonly module: string
  readonly start: number
  readonly end: number
}

export interface ManifestSources {
  readonly router: Router
  readonly container: Container
  readonly providers: ProviderEntry[]
  readonly providerWarnings: ManifestWarning[]
  readonly modules: ReadonlyArray<GurenModule>
  readonly moduleRouteRanges: ReadonlyArray<ModuleRouteRange>
  readonly authOptions?: AuthPluginOptions
  readonly hasBootCallback: boolean
}

const SCHEMA_KEYS = ['params', 'query', 'body', 'output'] as const

/** Builds the manifest from a registered, mounted, unbooted app (RFC 0026 §1). */
export function buildAppManifest(sources: ManifestSources): AppManifest {
  const warnings: ManifestWarning[] = [...sources.providerWarnings]
  if (sources.hasBootCallback) {
    warnings.push({
      code: 'boot-callback-skipped',
      message: 'createApp({ boot }) was not run: introspection stops before boot, so routes or middleware it adds are not in this manifest.',
    })
  }

  const definitions = sources.router.definitions()
  const { aliases, routes: chains } = sources.router.describeMiddleware()
  const routes = describeRoutes(sources, definitions, chains, warnings)
  const middlewareAliases: Record<string, MiddlewareEntry> = {}
  for (const [name, entry] of Object.entries(aliases)) {
    middlewareAliases[name] = withAbility(entry)
  }

  const derived = deriveAgentTools(definitions)
  for (const message of derived.warnings) warnings.push({ code: 'agent-tool', message })

  const manifest: AppManifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    entry: { file: null, root: process.cwd(), stage: 'register' },
    runtime: {
      bun: process.versions.bun ?? null,
      node: process.versions.node ?? null,
      platform: process.platform,
    },
    providers: sources.providers,
    modules: sources.modules.map((gurenModule) => ({
      name: gurenModule.name,
      ...(gurenModule.prefix === undefined ? {} : { prefix: gurenModule.prefix }),
      providers: gurenModule.providers.map((provider) => provider.name),
      commands: gurenModule.commands.map((command) => command.name),
      routeCount: routes.filter((route) => route.module === gurenModule.name).length,
    })),
    routes,
    middlewareAliases,
    bindings: sources.container.getBindings().sort(),
    agentTools: derived.tools,
    warnings,
  }

  const read = <T>(key: string, describe: (service: unknown) => T | undefined): T | undefined =>
    readSection(sources.container, key, describe, warnings)

  const session = describeSession(sources, warnings)
  if (session) manifest.session = session
  const auth = read('auth', (service) => callDescribe<AppManifest['auth']>(service))
  if (auth) manifest.auth = auth
  for (const key of ['cache', 'storage', 'queue'] as const) {
    const entry = read(key, (service) => callDescribe<AppManifest[typeof key]>(service))
    if (entry) manifest[key] = entry
  }
  const attachments = read('attachments', (service) => callDescribe<Omit<AttachmentsEntry, 'delivery'> & {
    delivery?: { prefix: string; routeName: string }
  }>(service))
  if (attachments) {
    const { delivery, ...rest } = attachments
    manifest.attachments = delivery
      ? { ...rest, delivery: { ...delivery, mounted: definitions.some((route) => route.name === delivery.routeName) } }
      : rest
  }

  return manifest
}

function describeRoutes(
  sources: ManifestSources,
  definitions: RouteDefinition[],
  chains: MiddlewareEntry[][],
  warnings: ManifestWarning[],
): RouteEntry[] {
  const moduleAt = (index: number): string | null =>
    sources.moduleRouteRanges.find((range) => index >= range.start && index < range.end)?.module ?? null

  return definitions.map((definition, index) => {
    const { schemas, controller, middlewareNames, ...rest } = definition
    const label = `${definition.method} ${definition.path}`
    const entry: RouteEntry = {
      ...rest,
      module: moduleAt(index),
      middleware: (chains[index] ?? []).map((middleware) => withAbility(middleware, definition.method)),
      schemas: {},
    }

    for (const key of SCHEMA_KEYS) {
      const schema = schemas?.[key]
      if (!schema) continue
      const notes: string[] = []
      const json = toJsonSchema(schema, notes, `${label} ${key}`, key === 'output' ? 'output' : 'input')
      entry.schemas[key] = json ?? { unreadable: notes.join(' ') || 'not a readable Zod schema' }
      if (json) for (const message of notes) warnings.push({ code: 'schema-partial', message, route: label })
    }

    if (controller) {
      entry.controller = { name: controller.name, action: controller.action, file: null, exportName: null, resolved: 'name-only' }
    }
    return entry
  })
}

/**
 * The one ability a middleware checks, derived from the authorization stamp
 * the framework's middlewares already carry (RFC 0007, RFC 0016 §4). A
 * resource check resolves through the verb map only where the route's method
 * is known, so an alias entry outside a route leaves it absent.
 */
function withAbility(entry: MiddlewareEntry, method?: string): MiddlewareEntry {
  const authorization = entry.capabilities.authorization
  if (!authorization) return entry
  if (authorization.mode === 'all' && authorization.abilities.length === 1) {
    return { ...entry, ability: authorization.abilities[0]! }
  }
  if (method && authorization.abilities.length === 0 && authorization.resource?.fromMethodMap) {
    const ability = resourceAbilityForMethod(method)
    if (ability) return { ...entry, ability }
  }
  return entry
}

function describeSession(sources: ManifestSources, warnings: ManifestWarning[]): SessionEntry | undefined {
  const described = readSection(sources.container, 'session', (service) =>
    callDescribe<Omit<SessionEntry, 'source'>>(service), warnings)
  if (described) return { source: 'manager', ...described }

  const auth = sources.authOptions
  if (!auth || auth.autoSession === false) return undefined

  const store = auth.sessionOptions?.store
  if (store === undefined) {
    return { source: 'none', default: 'memory', stores: { memory: { driver: 'memory', perProcess: true } } }
  }

  // A thunk is not called: that would build the store this manifest must not resolve.
  const driver = typeof store === 'function' ? null : store.constructor.name
  return {
    source: 'auth.sessionOptions.store',
    default: 'sessionOptions.store',
    stores: { 'sessionOptions.store': { driver, perProcess: driver === null ? null : driver === 'MemorySessionStore' } },
  }
}

function callDescribe<T>(service: unknown): T | undefined {
  const describe = (service as { describe?: unknown } | null | undefined)?.describe
  return typeof describe === 'function' ? (describe.call(service) as T) : undefined
}

/**
 * A section is read only when its container key exists after registration.
 * A manager whose construction throws is reported, never taken as absent.
 */
function readSection<T>(
  container: Container,
  key: string,
  describe: (service: unknown) => T | undefined,
  warnings: ManifestWarning[],
): T | undefined {
  if (!container.has(key)) return undefined
  try {
    return describe(container.make(key))
  } catch (error) {
    warnings.push({
      code: 'section-unreadable',
      message: `"${key}" is bound but could not be described: ${error instanceof Error ? error.message : String(error)}`,
    })
    return undefined
  }
}
