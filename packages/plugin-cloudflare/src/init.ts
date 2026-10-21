/**
 * `guren cloudflare:init` (RFC 0035 §3): moves an app onto the `cf` backend by
 * writing `cloudflare.config.ts`, `wrangler.config.ts` and `config/cloudflare.ts`.
 * It installs nothing and skips a file that exists unless forced. From a
 * `wrangler.jsonc` it carries over what decides which resources the Worker binds,
 * and names every setting it leaves behind.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { isRecord, readPackageJson } from './backend'
import {
  OAUTH_KV_BINDING,
  asArray,
  assertAgentsPluginUsable,
  configScopes,
  durableObjectBindings,
  durableObjectStorage,
  isPlaceholderId,
  readAgentRegistry,
  readWranglerConfig,
  workerName,
} from './build'
import { CF_VERSION, CF_WRANGLER_FLOOR } from './versions'

/** The build's D1 binding (`WorkerManifest.d1.binding`). */
const DATABASE_BINDING = 'DB'

export interface InitCloudflareOptions {
  rootDir: string
  force?: boolean
  /** Fixed in tests; otherwise wrangler.jsonc's date, or today. */
  compatibilityDate?: string
}

export interface InitCloudflareResult {
  written: string[]
  /** Files that existed and were left as they are. */
  skipped: string[]
  /** What the files took over from `wrangler.jsonc`. */
  carried: string[]
  /** What the move cannot settle by itself. */
  warnings: string[]
  /** devDependencies raised in package.json, as `name@range`; run `bun install` after. */
  dependencies: string[]
}

const FILES = ['cloudflare.config.ts', 'wrangler.config.ts', 'config/cloudflare.ts'] as const

/** wrangler.jsonc keys the build owns or init carries over; the rest are named as left behind. */
const HANDLED_KEYS = new Set([
  '$schema', 'name', 'main', 'compatibility_date', 'compatibility_flags', 'alias', 'define', 'assets',
  'd1_databases', 'kv_namespaces', 'durable_objects', 'migrations', 'vars',
])

interface Carried {
  worker: string
  compatibilityDate: string
  databaseName?: string
  oauthKvId?: string
  /** Durable Objects wrangler.jsonc hosts outside the agent registry, which gurenWorker() does not emit. */
  durableObjects: DurableObjectCarry[]
}

interface DurableObjectCarry {
  binding: string
  className: string
  storage: 'sqlite' | 'legacy-kv'
}

export async function initCloudflare(options: InitCloudflareOptions): Promise<InitCloudflareResult> {
  const root = resolve(options.rootDir)
  const wrangler = readWranglerConfig(resolve(root, 'wrangler.jsonc'))
  const defaultName = workerName(readPackageJson(root).name)
  const worker = typeof wrangler?.name === 'string' ? wrangler.name : defaultName
  const databaseName = wrangler ? bindingEntry(wrangler.d1_databases, DATABASE_BINDING)?.database_name : undefined
  const oauthKv = wrangler ? bindingEntry(wrangler.kv_namespaces, OAUTH_KV_BINDING) : undefined
  const carried: Carried = {
    worker,
    compatibilityDate: options.compatibilityDate
      ?? (typeof wrangler?.compatibility_date === 'string' ? wrangler.compatibility_date : new Date().toISOString().slice(0, 10)),
    ...(typeof databaseName === 'string' && databaseName !== worker ? { databaseName } : {}),
    // A placeholder id from an older scaffold is not carried; the plan resolves the namespace by name instead.
    ...(typeof oauthKv?.id === 'string' && !isPlaceholderId(oauthKv.id) ? { oauthKvId: oauthKv.id } : {}),
    durableObjects: [],
  }
  const durableObjects = wrangler ? sortDurableObjects(wrangler, await agentClasses(root)) : { carried: [], unmoved: [] }
  carried.durableObjects = durableObjects.carried

  const contents: Record<(typeof FILES)[number], string> = {
    'cloudflare.config.ts': cloudflareConfigSource(carried),
    'wrangler.config.ts': WRANGLER_CONFIG_SOURCE,
    'config/cloudflare.ts': deployConfigSource(oauthKv !== undefined, carried.databaseName),
  }
  const written: string[] = []
  const skipped: string[] = []
  for (const file of FILES) {
    const path = resolve(root, file)
    if (existsSync(path) && !options.force) {
      skipped.push(file)
      continue
    }
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, contents[file])
    written.push(file)
  }
  ignoreCfOutput(root)

  return {
    written,
    skipped,
    carried: wrangler ? describeCarried(carried, oauthKv !== undefined) : [],
    warnings: wrangler ? leftBehind(wrangler, durableObjects.unmoved) : [],
    dependencies: raiseCfDependencies(root),
  }
}

function bindingEntry(entries: unknown, binding: string): Record<string, unknown> | undefined {
  return asArray(entries).find((entry): entry is Record<string, unknown> => isRecord(entry) && entry.binding === binding)
}

function describeCarried(carried: Carried, mcpOAuth: boolean): string[] {
  return [
    `the Worker name "${carried.worker}" and compatibility date ${carried.compatibilityDate}`,
    ...(carried.databaseName ? [`the D1 database "${carried.databaseName}" (resourceNames.DB)`] : []),
    ...(mcpOAuth ? [`the OAUTH_KV binding (mcpOAuth: true${carried.oauthKvId ? `, its namespace id in cloudflare.config.ts` : ''})`] : []),
    ...carried.durableObjects.map((object) => `the Durable Object ${object.binding} (${object.className}, ${object.storage} storage) as a cf export`),
  ]
}

/** Settings cf does not read, so the first cf deploy would drop them unannounced. */
function leftBehind(wrangler: Record<string, unknown>, unmoved: readonly string[]): string[] {
  const warnings: string[] = []
  const keys = Object.keys(wrangler).filter((key) => !HANDLED_KEYS.has(key))
  const flags = asArray(wrangler.compatibility_flags).filter((flag) => flag !== 'nodejs_compat')
  const vars = isRecord(wrangler.vars) ? Object.keys(wrangler.vars).filter((key) => key !== 'NODE_ENV') : []
  const extraBindings = [...asArray(wrangler.d1_databases), ...asArray(wrangler.kv_namespaces)]
    .filter(isRecord)
    .filter((entry) => entry.binding !== DATABASE_BINDING && entry.binding !== OAUTH_KV_BINDING)
    .map((entry) => String(entry.binding))
  const notCarried = [
    ...keys,
    ...flags.map((flag) => `compatibility_flags ${String(flag)}`),
    ...vars.map((key) => `vars.${key}`),
    ...extraBindings.map((binding) => `the ${binding} binding`),
  ]
  if (notCarried.length > 0) {
    warnings.push(`wrangler.jsonc sets ${notCarried.join(', ')}, which cf does not read. Add them to cloudflare.config.ts after the gurenWorker() spread before deploying.`)
  }
  if (declaresDurableObjects(wrangler)) {
    warnings.push('wrangler.jsonc declares Durable Objects through `migrations`, which cloudflare.config.ts now declares as `exports`. Whether a deployed class keeps its storage across that move is unconfirmed (RFC 0035 Open Question 5), so try it on a staging Worker first.')
  }
  if (asArray(wrangler.migrations).some((step) => isRecord(step) && ['renamed_classes', 'deleted_classes', 'transferred_classes'].some((key) => asArray(step[key]).length > 0))) {
    warnings.push('wrangler.jsonc migrations rename, delete or transfer a Durable Object class; init does not carry those steps. Declare them with exports.durableObject({ state }) in cloudflare.config.ts.')
  }
  if (unmoved.length > 0) {
    warnings.push(`The Durable Object binding ${unmoved.join(', ')} points at another Worker or at a class no migration declares; bind it in cloudflare.config.ts with bindings.durableObject().`)
  }
  return warnings
}

/** The agent classes gurenWorker() hosts from config/agents.ts, the registry the build reads. */
async function agentClasses(root: string): Promise<Set<string>> {
  if (!existsSync(resolve(root, 'config/agents.ts'))) return new Set()
  assertAgentsPluginUsable(root)
  return new Set((await readAgentRegistry(root)).exports.map((agent) => agent.export))
}

/**
 * The top-level Durable Object bindings: an agent's is gurenWorker()'s, one whose class a
 * migration declares is carried with its storage, and the rest (another Worker's, or a class
 * no migration declares) are named for the developer to bind.
 */
function sortDurableObjects(wrangler: Record<string, unknown>, agents: ReadonlySet<string>): { carried: DurableObjectCarry[]; unmoved: string[] } {
  const storage = durableObjectStorage(wrangler)
  const carried: DurableObjectCarry[] = []
  const unmoved: string[] = []
  for (const entry of durableObjectBindings(wrangler)) {
    if (entry.scriptName === undefined && agents.has(entry.className)) continue
    const kind = entry.scriptName === undefined ? storage.get(entry.className) : undefined
    if (kind) carried.push({ binding: entry.name, className: entry.className, storage: kind })
    else unmoved.push(entry.name)
  }
  return { carried, unmoved }
}

/**
 * Raises what the cf backend needs in package.json's devDependencies (RFC 0035 §7):
 * `cf` when absent, and `wrangler` when its declared range admits a version below the delegate floor.
 */
function raiseCfDependencies(root: string): string[] {
  const path = resolve(root, 'package.json')
  const { dependencies: declared, devDependencies: declaredDev } = readPackageJson(root)
  const range = (name: string) => declared?.[name] ?? declaredDev?.[name]
  const raised: Record<string, string> = {}
  if (range('cf') === undefined) raised.cf = CF_VERSION
  // The lowest version a range admits is its first: `^4.129.0`, `>=4.129 <5`. `-0` admits pre-releases, as the preflight does.
  const lowest = range('wrangler')?.match(/\d+\.\d+\.\d+(-[\w.]+)?/)?.[0]
  if (!lowest || !Bun.semver.satisfies(lowest, `>=${CF_WRANGLER_FLOOR}-0`)) raised.wrangler = `^${CF_WRANGLER_FLOOR}`
  if (Object.keys(raised).length === 0) return []

  let text: string
  let manifest: unknown
  try {
    text = readFileSync(path, 'utf8')
    manifest = JSON.parse(text)
  } catch {
    return []
  }
  if (!isRecord(manifest)) return []
  const devDependencies = isRecord(manifest.devDependencies) ? { ...manifest.devDependencies } : {}
  const dependencies = isRecord(manifest.dependencies) ? { ...manifest.dependencies } : undefined
  for (const [name, version] of Object.entries(raised)) {
    // A CLI belongs in devDependencies; one declared under dependencies is raised where it is.
    if (dependencies && name in dependencies) dependencies[name] = version
    else devDependencies[name] = version
  }
  const indent = /^(\s+)"/m.exec(text)?.[1] ?? '  '
  writeFileSync(path, `${JSON.stringify({ ...manifest, ...(dependencies ? { dependencies } : {}), devDependencies }, null, indent)}\n`)
  return Object.entries(raised).map(([name, version]) => `${name}@${version}`)
}

function declaresDurableObjects(wrangler: Record<string, unknown>): boolean {
  return configScopes(wrangler).some(({ config }) => {
    const bindings = isRecord(config.durable_objects) ? config.durable_objects.bindings : undefined
    return asArray(bindings).length > 0 || asArray(config.migrations).length > 0
  })
}

/** `cf build` writes `.cloudflare/`, which is output; the build's own `.guren/cloudflare/` ignores itself. */
function ignoreCfOutput(root: string): void {
  const path = resolve(root, '.gitignore')
  const current = existsSync(path) ? readFileSync(path, 'utf8') : ''
  if (/^\/?\.cloudflare\/?\r?$/m.test(current)) return
  appendFileSync(path, `${current === '' || current.endsWith('\n') ? '' : '\n'}.cloudflare/\n`)
}

function cloudflareConfigSource(carried: Carried): string {
  // A KV binding carries no name, so the namespace Wrangler bound is pinned by id here.
  const envEntries = [
    ...(carried.oauthKvId ? [`OAUTH_KV: bindings.kv({ id: ${JSON.stringify(carried.oauthKvId)} })`] : []),
    ...carried.durableObjects.map((object) => `${object.binding}: bindings.durableObject({ worker: ${JSON.stringify(carried.worker)}, exportName: ${JSON.stringify(object.className)} })`),
  ]
  const exportEntries = carried.durableObjects.map((object) => `${object.className}: exports.durableObject({ storage: ${JSON.stringify(object.storage)} })`)
  const spread = (key: 'env' | 'exports', entries: string[]) => (entries.length > 0 ? `
      ${key}: { ...worker.${key}, ${entries.join(', ')} },` : '')
  const imports = [...(envEntries.length > 0 ? ['bindings'] : []), 'defineConfig', ...(exportEntries.length > 0 ? ['exports'] : [])]
  return `import { ${imports.join(', ')} } from 'cf/config'
import { gurenWorker } from '@guren/plugin-cloudflare/config'

export default defineConfig(async () => {
  const worker = await gurenWorker({ name: ${JSON.stringify(carried.worker)} })
  return {
    worker: {
      ...worker,
      compatibilityDate: ${JSON.stringify(carried.compatibilityDate)},${spread('env', envEntries)}${spread('exports', exportEntries)}
    },
  }
})
`
}

const WRANGLER_CONFIG_SOURCE = `import { defineWranglerConfig } from 'wrangler/experimental-config'
import { gurenWranglerBundle } from '@guren/plugin-cloudflare/config'

export default defineWranglerConfig(gurenWranglerBundle())
`

function deployConfigSource(mcpOAuth: boolean, databaseName: string | undefined): string {
  const lines = [`  mcpOAuth: ${mcpOAuth},`]
  if (databaseName) lines.push(`  resourceNames: { DB: ${JSON.stringify(databaseName)} },`)
  return `import { defineCloudflareConfig } from '@guren/plugin-cloudflare/config'

export default defineCloudflareConfig({
${lines.join('\n')}
})
`
}
