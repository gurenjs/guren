import { deriveAgentTools } from '../agent/derive'
import type { Container } from '../container/Container'
import type { GurenModule } from '../container/defineModule'
import { toJsonSchema } from '../internal/zod-json-schema'
import { toPlainJson } from './plain-json'
import type { RouteDefinition, Router } from '../mvc/Router'
import type { AppManifest, ManifestWarning, MiddlewareEntry, ProviderEntry, RouteEntry } from './types'

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
  const { aliases: middlewareAliases, routes: chains } = sources.router.describeMiddleware()
  const routes = describeRoutes(sources, definitions, chains, warnings)

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
  // `undefined` keys (a route's absent `name`, for example) are dropped by the copy,
  // so the in-memory manifest equals its `--json` output key for key.
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
      middleware: chains[index] ?? [],
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
