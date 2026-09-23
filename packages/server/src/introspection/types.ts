import type { DerivedAgentTool } from '../agent/derive'
import type { MiddlewareCapabilities } from '../http/middleware/capabilities'
import type { JsonSchemaObject } from '../internal/zod-json-schema'
import type { RouteDefinition } from '../mvc/Router'

/**
 * What `Application.introspect()` reports (RFC 0026 §1): the app after every
 * provider and every route registered, before anything mounted or booted. Plain
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
  session?: SessionEntry
  auth?: AuthEntry
  cache?: DriverMapEntry
  storage?: DriverMapEntry
  queue?: DriverMapEntry
  attachments?: AttachmentsEntry
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
  /** The one ability this middleware checks: a single-ability check, or on a route the verb-map ability of a resource check. */
  ability?: string
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

/** `driver` and `perProcess` are null for an `auth.sessionOptions.store` thunk, which only calling it would answer. */
export interface SessionStoreEntry {
  /** The configured driver name, or the store's constructor name for `auth.sessionOptions.store`. */
  driver: string | null
  /** The `database` driver's table, by its SQL name. */
  table?: string
  perProcess: boolean | null
}

export interface SessionEntry {
  source: 'manager' | 'auth.sessionOptions.store' | 'none'
  default: string
  stores: Record<string, SessionStoreEntry>
}

export interface AuthProviderEntry {
  /** `model` for `useModel()`; `custom` for a factory passed to `registerProvider()`. */
  kind: 'model' | 'custom'
  model?: string
  /** The hasher's constructor name; null for a custom provider, whose hasher only its factory knows. */
  hasher: string | null
  /**
   * The format a framework hasher writes, matched by exact class: `DefaultHasher`
   * reports one class name for scrypt and Argon2id. Null for a subclass or an app's own hasher.
   */
  algorithm: 'scrypt' | 'argon2' | 'bcrypt' | null
  /** Whether writing needs `Bun.password` (`ScryptHasher`, `DefaultHasher` on argon2); null where `algorithm` is. */
  requiresBun: boolean | null
}

export interface AuthEntry {
  guards: string[]
  defaultGuard: string | null
  /** The hasher new passwords are written with (`createApp({ auth: { hasher } })`), by constructor name. */
  hasher: string
  /** As on {@link AuthProviderEntry}. */
  algorithm: 'scrypt' | 'argon2' | 'bcrypt' | null
  requiresBun: boolean | null
  providers: Record<string, AuthProviderEntry>
}

export interface DriverMapEntry {
  default: string
  /** `driver` is null for an entry registered as a bare factory, whose driver is unknowable without calling it. */
  entries: Record<string, { driver: string | null }>
}

export interface AttachmentsEntry {
  configured: boolean
  table?: string
  disk?: string
  /** `route: false` is a disk configured `serve: 'direct'`, whose URLs bypass the delivery route. */
  disks?: Record<string, { visibility: 'public' | 'private'; route: boolean; serve: 'auto' | 'redirect' | 'proxy' }>
  delivery?: { prefix: string; routeName: string; mounted: boolean }
}

/** What an attachments engine reports of itself; the manifest adds `delivery.mounted` from the route registry. */
export type AttachmentsDescription = Omit<AttachmentsEntry, 'delivery'> & {
  delivery?: Omit<NonNullable<AttachmentsEntry['delivery']>, 'mounted'>
}

export interface ManifestWarning {
  code: string
  message: string
  provider?: string
  route?: string
  /** The container key a `config-unverified` warning left unbound, so a reader can tell that section from an absent one. */
  key?: string
}
