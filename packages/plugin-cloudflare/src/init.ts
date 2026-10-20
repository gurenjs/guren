/**
 * `guren cloudflare:init` (RFC 0035 §3): moves an app onto the `cf` backend by
 * writing `cloudflare.config.ts`, `wrangler.config.ts` and `config/cloudflare.ts`.
 * It writes no file that exists unless forced, installs nothing, and carries over
 * what a `wrangler.jsonc` already decided: the D1 database name and `OAUTH_KV`.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { bindsOAuthKv, readWranglerConfig, workerName } from './build'

export interface InitCloudflareOptions {
  rootDir: string
  force?: boolean
  /** Fixed in tests; otherwise today. */
  compatibilityDate?: string
}

export interface InitCloudflareResult {
  written: string[]
  /** What the files took over from `wrangler.jsonc`. */
  carried: string[]
  /** What the move cannot settle by itself. */
  warnings: string[]
}

const FILES = ['cloudflare.config.ts', 'wrangler.config.ts', 'config/cloudflare.ts'] as const

export function initCloudflare(options: InitCloudflareOptions): InitCloudflareResult {
  const root = resolve(options.rootDir)
  const existing = FILES.filter((file) => existsSync(resolve(root, file)))
  if (existing.length > 0 && !options.force) {
    throw new Error(`Cloudflare init: ${existing.join(', ')} already exist. Pass --force to overwrite them.`)
  }

  const name = workerName(readPackageName(root))
  const wrangler = readWranglerConfig(resolve(root, 'wrangler.jsonc'))
  const databaseName = wrangler ? firstDatabaseName(wrangler) : undefined
  const mcpOAuth = wrangler ? bindsOAuthKv(wrangler) : false
  const carried = [
    ...(databaseName && databaseName !== name ? [`the D1 database "${databaseName}" (resourceNames.DB)`] : []),
    ...(mcpOAuth ? ['the OAUTH_KV binding (mcpOAuth: true)'] : []),
  ]

  const contents: Record<(typeof FILES)[number], string> = {
    'cloudflare.config.ts': cloudflareConfigSource(name, options.compatibilityDate ?? new Date().toISOString().slice(0, 10)),
    'wrangler.config.ts': WRANGLER_CONFIG_SOURCE,
    'config/cloudflare.ts': deployConfigSource({ mcpOAuth, ...(databaseName && databaseName !== name ? { databaseName } : {}) }),
  }
  for (const file of FILES) {
    const path = resolve(root, file)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, contents[file])
  }
  ignoreCfOutput(root)
  const warnings = wrangler && wrangler.durable_objects !== undefined
    ? ['wrangler.jsonc declares Durable Objects through `migrations`; on cf they are `exports`. Whether a deployed class keeps its storage across that move is unconfirmed (RFC 0035 Open Question 5), so try it on a staging Worker first.']
    : []
  return { written: [...FILES], carried, warnings }
}

function readPackageName(root: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { name?: unknown }
    return typeof manifest.name === 'string' ? manifest.name : undefined
  } catch {
    return undefined
  }
}

function firstDatabaseName(config: Record<string, unknown>): string | undefined {
  const databases = config.d1_databases
  const first = Array.isArray(databases) ? (databases[0] as { database_name?: unknown } | undefined) : undefined
  return typeof first?.database_name === 'string' ? first.database_name : undefined
}

/** `cf build` writes `.cloudflare/`, which is output; the build's own `.guren/cloudflare/` ignores itself. */
function ignoreCfOutput(root: string): void {
  const path = resolve(root, '.gitignore')
  const current = existsSync(path) ? readFileSync(path, 'utf8') : ''
  if (/^\/?\.cloudflare\/?$/m.test(current)) return
  appendFileSync(path, `${current === '' || current.endsWith('\n') ? '' : '\n'}.cloudflare/\n`)
}

function cloudflareConfigSource(name: string, compatibilityDate: string): string {
  return `import { defineConfig } from 'cf/config'
import { gurenWorker } from '@guren/plugin-cloudflare/config'

export default defineConfig(async () => {
  const worker = await gurenWorker({ name: ${JSON.stringify(name)} })
  return {
    worker: {
      ...worker,
      compatibilityDate: ${JSON.stringify(compatibilityDate)},
    },
  }
})
`
}

const WRANGLER_CONFIG_SOURCE = `import { defineWranglerConfig } from 'wrangler/experimental-config'
import { gurenWranglerBundle } from '@guren/plugin-cloudflare/config'

export default defineWranglerConfig(gurenWranglerBundle())
`

function deployConfigSource(input: { mcpOAuth: boolean; databaseName?: string }): string {
  const lines = [`  mcpOAuth: ${input.mcpOAuth},`]
  if (input.databaseName) lines.push(`  resourceNames: { DB: ${JSON.stringify(input.databaseName)} },`)
  return `import { defineCloudflareConfig } from '@guren/plugin-cloudflare/config'

export default defineCloudflareConfig({
${lines.join('\n')}
})
`
}
