import { deriveAgentTools } from '../agent/derive'
import { derivableAbility } from '../authorization/middleware'
import type { Container } from '../container/Container'
import type { GurenModule } from '../container/defineModule'
import type { AuthPluginOptions } from '../http/Application'
import { SessionManager, sessionDriverIsPerProcess } from '../http/middleware/session-manager'
import { toJsonSchema } from '../internal/zod-json-schema'
import { toPlainJson } from './plain-json'
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

/** Builds the manifest from a registered, unmounted, unbooted app (RFC 0026 §1). */
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

  // A route's absent `name` arrives as an `undefined` key; the copy drops it, so the
  // in-memory manifest equals its `--json` output key for key.
  return toPlainJson(manifest)
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

function withAbility(entry: MiddlewareEntry, method?: string): MiddlewareEntry {
  const ability = derivableAbility(entry.capabilities.authorization, method)
  return ability === undefined ? entry : { ...entry, ability }
}

function describeSession(sources: ManifestSources, warnings: ManifestWarning[]): SessionEntry | undefined {
  const read = readSection<Omit<SessionEntry, 'source'>>(sources, 'session', warnings)
  if (read.status === 'described') {
    // AuthServiceProvider refuses this pair only for a session it attaches itself.
    const auth = sources.authOptions
    if (auth && auth.autoSession !== false && auth.sessionOptions?.store !== undefined) {
      warnings.push({
        code: 'session-configured-twice',
        message: 'A "session" binding and createApp({ auth: { sessionOptions: { store } } }) both configure sessions; the app refuses to boot until one is removed.',
      })
    }
    return { source: 'manager', ...read.value }
  }
  // Anything but a plain absence was warned about; the fallback below would contradict it.
  if (read.status !== 'absent') return undefined

  const auth = sources.authOptions
  if (!auth || auth.autoSession === false) return undefined

  const store = auth.sessionOptions?.store
  // The session middleware's own fallback is the manager's default memory store.
  if (store === undefined) return { source: 'none', ...new SessionManager().describe() }

  // A thunk is not called: that would build the store this manifest must not resolve.
  const driver = typeof store === 'function' ? null : store.constructor.name
  return {
    source: 'auth.sessionOptions.store',
    default: 'sessionOptions.store',
    stores: { 'sessionOptions.store': { driver, perProcess: perProcessOfStoreClass(driver) } },
  }
}

/** The framework's store classes by the driver that builds them; core's `DatabaseSessionStore` included. */
const DRIVER_BY_STORE_CLASS: Readonly<Record<string, string>> = {
  MemorySessionStore: 'memory',
  CookieSessionStore: 'cookie',
  RedisSessionStore: 'redis',
  DatabaseSessionStore: 'database',
}

function perProcessOfStoreClass(storeClass: string | null): boolean | null {
  const driver = storeClass === null ? undefined : DRIVER_BY_STORE_CLASS[storeClass]
  return driver === undefined ? null : sessionDriverIsPerProcess(driver)
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
    if (deferred) {
      warnings.push({
        code: 'section-unverified',
        message: `"${key}" is supplied by the deferred ${deferred.name}, which registers only after boot.`,
        provider: deferred.name,
      })
      return { status: 'unverified' }
    }
    // RFC 0026 §2: a section behind a provider that threw is unverified, never absent.
    const thrown = sources.providers.filter((provider) => provider.register === 'threw')
    if (thrown.length === 0) return { status: 'absent' }
    warnings.push({
      code: 'section-unverified',
      message: `"${key}" is unbound, and ${thrown.map((provider) => provider.name).join(', ')} threw before it could be ruled out as its provider.`,
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
