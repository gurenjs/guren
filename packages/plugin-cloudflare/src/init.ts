/**
 * `guren cloudflare:init` (RFC 0035 §3): moves an app onto the `cf` backend by
 * writing `cloudflare.config.ts`, `wrangler.config.ts` and `config/cloudflare.ts`.
 * It installs nothing and skips a file that exists unless forced. From a
 * `wrangler.jsonc` it carries over what decides which resources the Worker binds,
 * and names every setting it leaves behind.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { isRecord } from './backend'
import {
  OAUTH_KV_BINDING,
  asArray,
  configScopes,
  isPlaceholderId,
  readPackageJson,
  readWranglerConfig,
  workerName,
} from './build'

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

export function initCloudflare(options: InitCloudflareOptions): InitCloudflareResult {
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
    warnings: wrangler ? leftBehind(wrangler) : [],
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
  if (declaresDurableObjects(wrangler)) {
    warnings.push('wrangler.jsonc declares Durable Objects through `migrations`; on cf they are `exports`. Whether a deployed class keeps its storage across that move is unconfirmed (RFC 0035 Open Question 5), so try it on a staging Worker first.')
  }
  return warnings
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
