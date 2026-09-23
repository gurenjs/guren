import type { DerivedAgentTool } from '../agent/derive'
import type { MiddlewareCapabilities } from '../http/middleware/capabilities'
import type { JsonSchemaObject } from '../internal/zod-json-schema'
import type { RouteDefinition } from '../mvc/Router'

/**
 * What `Application.introspect()` reports (RFC 0026 §1): the app after every
 * provider registered and every route mounted, before anything booted. Plain
 * JSON throughout, so `guren introspect --json` prints it as it is.
 */
export interface AppManifest {
  schemaVersion: 1
  generatedAt: string
  /** `file` is null when `introspect()` ran in process rather than under the CLI, which names the entry it imported. */
  entry: { file: string | null; root: string; stage: 'register' }
  runtime: { bun: string | null; node: string | null; platform: string }
  providers: ProviderEntry[]
  modules: ModuleEntry[]
  routes: RouteEntry[]
  middlewareAliases: Record<string, MiddlewareEntry>
  /** Container keys present after `register()`, sorted. */
  bindings: string[]
  agentTools: DerivedAgentTool[]
  warnings: ManifestWarning[]
}

/** How a provider was registered. `app.register` is a provider added through `Application.register()` after construction. */
export type ProviderSource = 'framework' | 'options.providers' | 'module' | 'app.register'

/** `skipped` is a deferred provider: it registers on the first `make()` after boot, which introspection never reaches. */
export type ProviderRegisterOutcome = 'ran' | 'introspect-hook' | 'threw' | 'skipped'

export interface ProviderEntry {
  /** `constructor.name`, durable because Guren forbids identifier mangling. */
  name: string
  source: ProviderSource
  module?: string
  deferred: boolean
  provides: string[]
  register: ProviderRegisterOutcome
  error?: string
}

export interface ModuleEntry {
  name: string
  prefix?: string
  /** Class names, like `ProviderEntry.name`. */
  providers: string[]
  /** Class names; the console keys a command by the name in its `signature`. */
  commands: string[]
  routeCount: number
}

export interface ControllerRef {
  name: string
  action: string
  /** Project-relative; null when identity matching found no file. */
  file: string | null
  /** `'default'` or the named export; null with `file`. */
  exportName: string | null
  resolved: 'identity' | 'name-only'
}

export interface MiddlewareEntry {
  kind: 'alias' | 'group' | 'inline'
  /** The alias or group name; an inline handler's function name, or null. */
  name: string | null
  /** A group's aliases, expanded through nested groups. */
  members?: string[]
  capabilities: MiddlewareCapabilities
  /** A name no alias or group registers; `mount()` refuses it. */
  unresolved?: true
  /** A group's members no alias registers, which `mount()` refuses the same way. */
  unresolvedMembers?: string[]
}

export type JsonSchema = JsonSchemaObject

export type RouteSchemaEntry = JsonSchema | { unreadable: string }

export type RouteEntry = Omit<RouteDefinition, 'schemas' | 'controller' | 'middlewareNames'> & {
  module: string | null
  controller?: ControllerRef
  /** In the order `mount()` runs them: named, then group-scoped inline, then route-local inline. */
  middleware: MiddlewareEntry[]
  schemas: Partial<Record<'params' | 'query' | 'body' | 'output', RouteSchemaEntry>>
}

export interface ManifestWarning {
  code: string
  message: string
  provider?: string
  route?: string
}
