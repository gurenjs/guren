import { deriveAgentTools } from '../agent/derive'
import { resourceAbilityForMethod } from '../authorization/middleware'
import type { Container } from '../container/Container'
import type { GurenModule } from '../container/defineModule'
import type { AuthPluginOptions } from '../http/Application'
import { toJsonSchema } from '../internal/zod-json-schema'
import type { RouteDefinition, Router } from '../mvc/Router'
import type {
  AppManifest,
  AttachmentsDescription,
  AuthEntry,
  DriverMapEntry,
  ManifestWarning,
  MiddlewareEntry,
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

interface ManifestSources {
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
  for (const [name, entry] of Object.entries(aliases)) middlewareAliases[name] = withAbility(entry)

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

  const section = <T>(key: string): T | undefined => {
    const read = readSection<T>(sources, key, warnings)
    return read.status === 'described' ? read.value : undefined
  }

  const session = describeSession(sources, warnings)
  if (session) manifest.session = session
  const auth = section<AuthEntry>('auth')
  if (auth) manifest.auth = auth
  for (const key of ['cache', 'storage', 'queue'] as const) {
    const entry = section<DriverMapEntry>(key)
    if (entry) manifest[key] = entry
  }
  const attachments = section<AttachmentsDescription>('attachments')
  if (attachments) {
    const { delivery, ...rest } = attachments
    manifest.attachments = delivery
      ? { ...rest, delivery: { ...delivery, mounted: sources.router.hasRoute(delivery.routeName) } }
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
      // Undefined fields dropped, so the in-memory manifest and its JSON agree key for key.
      ...Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined)) as typeof rest,
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
  const read = readSection<Omit<SessionEntry, 'source'>>(sources, 'session', warnings)
  if (read.status === 'described') return { source: 'manager', ...read.value }
  // Anything but a plain absence was warned about; the fallback below would contradict it.
  if (read.status !== 'absent') return undefined

  const auth = sources.authOptions
  if (!auth || auth.autoSession === false) return undefined

  const store = auth.sessionOptions?.store
  if (store === undefined) {
    // A provider that threw may have been the one binding `session`; `none` would claim otherwise.
    const thrown = sources.providers.filter((provider) => provider.register === 'threw')
    if (thrown.length > 0) {
      warnings.push({
        code: 'section-unverified',
        message: `"session" is unbound, and ${thrown.map((provider) => provider.name).join(', ')} threw before it could be ruled out as its provider.`,
      })
      return undefined
    }
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

type SectionRead<T> = { status: 'described'; value: T } | { status: 'absent' | 'unverified' | 'unreadable' }

/**
 * A section is read only when its container key exists after registration.
 * One a deferred provider supplies, or whose manager throws on construction,
 * is warned about and told apart from a plain absence.
 */
function readSection<T>(sources: ManifestSources, key: string, warnings: ManifestWarning[]): SectionRead<T> {
  const { container } = sources
  if (!container.has(key)) {
    const deferred = sources.providers.find((provider) => provider.register === 'skipped' && provider.provides.includes(key))
    if (!deferred) return { status: 'absent' }
    warnings.push({
      code: 'section-unverified',
      message: `"${key}" is supplied by the deferred ${deferred.name}, which registers only after boot.`,
      provider: deferred.name,
    })
    return { status: 'unverified' }
  }

  try {
    const service = container.make(key) as { describe?: () => T } | null | undefined
    if (typeof service?.describe === 'function') return { status: 'described', value: service.describe() }
    warnings.push({ code: 'section-unverified', message: `"${key}" is bound to something with no describe().` })
    return { status: 'unverified' }
  } catch (error) {
    warnings.push({
      code: 'section-unreadable',
      message: `"${key}" is bound but could not be described: ${error instanceof Error ? error.message : String(error)}`,
    })
    return { status: 'unreadable' }
  }
}
