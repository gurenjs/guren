/**
 * `guren cloudflare:init` (RFC 0035 §3): moves an app onto the `cf` backend by
 * writing `cloudflare.config.ts`, `wrangler.config.ts` and `config/cloudflare.ts`.
 * It installs nothing, raises `cf` and `wrangler` in package.json, and skips a file that
 * exists unless forced. From a `wrangler.jsonc` it carries over what decides which
 * resources the Worker binds, and names every setting it leaves behind.
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
  }

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
    warnings: wrangler ? [...leftBehind(wrangler), ...await durableObjectWarnings(root, wrangler)] : [],
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
  ]
}

/** Settings cf does not read, so the first cf deploy would drop them unannounced. */
function leftBehind(wrangler: Record<string, unknown>): string[] {
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
  return warnings
}

/**
 * gurenWorker() declares the agents config/agents.ts registers as cf `exports`, and the generated
 * worker exports only those classes. Any other live class, or a binding to another Worker, has no
 * declaration on cf, so the first deploy could drop its storage; each is named.
 */
async function durableObjectWarnings(root: string, wrangler: Record<string, unknown>): Promise<string[]> {
  if (!declaresDurableObjects(wrangler)) return []
  const warnings = ['wrangler.jsonc declares Durable Objects through `migrations`; on cf, gurenWorker() declares the registered agents as `exports`. Whether a deployed class keeps its storage across that move is unconfirmed (RFC 0035 Open Question 5), so try it on a staging Worker first.']

  let agents: Set<string>
  try {
    agents = await agentClasses(root)
  } catch (error) {
    return [...warnings, `config/agents.ts could not be read (${error instanceof Error ? error.message : String(error)}), so which Durable Objects are agents is unknown; check every class before deploying.`]
  }
  const live = new Set(configScopes(wrangler).flatMap(({ config }) => [...durableObjectStorage(config).keys()]))
  const unregistered = [...live].filter((name) => !agents.has(name))
  if (unregistered.length > 0) {
    warnings.push(`The Durable Object class ${unregistered.join(', ')} is not an agent in config/agents.ts. The worker cloudflare:build generates exports only registered agents, so on cf nothing declares it: register it as an agent, or export it from the worker and declare it with exports.durableObject().`)
  }
  const remote = configScopes(wrangler).flatMap(({ config }) => durableObjectBindings(config).filter((entry) => entry.scriptName !== undefined).map((entry) => entry.name))
  if (remote.length > 0) {
    warnings.push(`The Durable Object binding ${remote.join(', ')} points at another Worker; bind it in cloudflare.config.ts with bindings.durableObject().`)
  }
  if (asArray(wrangler.migrations).some((step) => isRecord(step) && ['renamed_classes', 'deleted_classes', 'transferred_classes'].some((key) => asArray(step[key]).length > 0))) {
    warnings.push('wrangler.jsonc migrations rename, delete or transfer a Durable Object class; declare those steps with exports.durableObject({ state }) in cloudflare.config.ts.')
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
 * Raises what the cf backend needs in package.json (RFC 0035 §7): `cf` and `wrangler` when absent
 * or when the declared range starts below the verified version. A range it cannot read (`latest`,
 * `catalog:`, `workspace:*`) is left as it is: the preflight checks what is installed.
 */
function raiseCfDependencies(root: string): string[] {
  const path = resolve(root, 'package.json')
  let text: string
  let manifest: unknown
  try {
    text = readFileSync(path, 'utf8')
    manifest = JSON.parse(text)
  } catch {
    return []
  }
  if (!isRecord(manifest)) return []
  const dependencies = isRecord(manifest.dependencies) ? { ...manifest.dependencies } : undefined
  const devDependencies = isRecord(manifest.devDependencies) ? { ...manifest.devDependencies } : {}
  const raised: Record<string, string> = {}
  for (const [name, floor, range] of [['cf', CF_VERSION, CF_VERSION], ['wrangler', CF_WRANGLER_FLOOR, `^${CF_WRANGLER_FLOOR}`]] as const) {
    const declared = dependencies?.[name] ?? devDependencies[name]
    if (declared === undefined || startsBelow(declared, floor)) raised[name] = range
  }
  if (Object.keys(raised).length === 0) return []

  for (const [name, range] of Object.entries(raised)) {
    // A CLI belongs in devDependencies; one declared under dependencies is raised where it is.
    if (dependencies && name in dependencies) dependencies[name] = range
    else devDependencies[name] = range
  }
  const indent = /^(\s+)"/m.exec(text)?.[1] ?? '  '
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const json = JSON.stringify({ ...manifest, ...(dependencies ? { dependencies } : {}), devDependencies }, null, indent)
  writeFileSync(path, `${json.replaceAll('\n', eol)}${eol}`)
  return Object.entries(raised).map(([name, range]) => `${name}@${range}`)
}

/** Whether a range's lowest version (`^4.140`, `>=4.129.0 <5`, `1.0.0-beta.10`) is below `floor`; false when there is none to read. */
function startsBelow(range: unknown, floor: string): boolean {
  const match = typeof range === 'string' ? /(\d+)(?:\.(\d+))?(?:\.(\d+))?(-[\w.]+)?/.exec(range) : null
  if (!match) return false
  const lowest = `${match[1]}.${match[2] ?? 0}.${match[3] ?? 0}${match[4] ?? ''}`
  // `-0` admits a release's pre-releases, as the preflight does; a floor that is one already compares as is.
  return !Bun.semver.satisfies(lowest, `>=${floor}${floor.includes('-') ? '' : '-0'}`)
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
  const env = carried.oauthKvId
    ? `
      env: { ...worker.env, OAUTH_KV: bindings.kv({ id: ${JSON.stringify(carried.oauthKvId)} }) },`
    : ''
  return `import { ${carried.oauthKvId ? 'bindings, ' : ''}defineConfig } from 'cf/config'
import { gurenWorker } from '@guren/plugin-cloudflare/config'

export default defineConfig(async () => {
  const worker = await gurenWorker({ name: ${JSON.stringify(carried.worker)} })
  return {
    worker: {
      ...worker,
      compatibilityDate: ${JSON.stringify(carried.compatibilityDate)},${env}
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
