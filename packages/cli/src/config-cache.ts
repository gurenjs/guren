import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync, readFileSync } from 'node:fs'
import { join, resolve, basename, extname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { consola } from 'consola'

export interface ConfigCacheOptions {
  configDir?: string
  appRoot?: string
  cacheDir?: string
  json?: boolean
}

const DEFAULT_CONFIG_DIR = 'config'
const DEFAULT_CACHE_DIR = 'bootstrap/cache'
const CACHE_FILE = 'config.json'

/** Cache all configuration files into a single JSON file. */
export async function cacheConfig(options: ConfigCacheOptions = {}): Promise<string> {
  const appRoot = options.appRoot ? resolve(options.appRoot) : process.cwd()
  const configDir = resolve(appRoot, options.configDir ?? DEFAULT_CONFIG_DIR)
  const cacheDir = resolve(appRoot, options.cacheDir ?? DEFAULT_CACHE_DIR)

  if (!existsSync(configDir)) {
    throw new Error(`Config directory not found: ${configDir}`)
  }

  if (!existsSync(cacheDir)) {
    mkdirSync(cacheDir, { recursive: true })
  }

  const configFiles = getConfigFiles(configDir)
  const config: Record<string, unknown> = {}

  for (const file of configFiles) {
    const key = basename(file, extname(file))

    try {
      const module = await import(pathToFileURL(file).href)
      config[key] = module.default ?? module.config ?? module
    } catch (error) {
      consola.warn(
        `Failed to load config file ${file}: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  const cacheFile = join(cacheDir, CACHE_FILE)
  const cacheContent = JSON.stringify(config, null, 2)
  writeFileSync(cacheFile, cacheContent, 'utf-8')

  consola.success(`Configuration cached to ${cacheFile}`)
  consola.info(`Cached ${Object.keys(config).length} configuration file(s).`)

  return cacheFile
}

/** Clear the configuration cache. */
export function clearConfigCache(options: ConfigCacheOptions = {}): boolean {
  const appRoot = options.appRoot ? resolve(options.appRoot) : process.cwd()
  const cacheDir = resolve(appRoot, options.cacheDir ?? DEFAULT_CACHE_DIR)
  const cacheFile = join(cacheDir, CACHE_FILE)

  if (existsSync(cacheFile)) {
    unlinkSync(cacheFile)
    consola.success('Configuration cache cleared.')
    return true
  }

  consola.info('No configuration cache found.')
  return false
}

/** Load cached configuration. */
export function loadCachedConfig(options: ConfigCacheOptions = {}): Record<string, unknown> | null {
  const appRoot = options.appRoot ? resolve(options.appRoot) : process.cwd()
  const cacheDir = resolve(appRoot, options.cacheDir ?? DEFAULT_CACHE_DIR)
  const cacheFile = join(cacheDir, CACHE_FILE)

  if (!existsSync(cacheFile)) {
    return null
  }

  try {
    const content = readFileSync(cacheFile, 'utf-8')
    return JSON.parse(content) as Record<string, unknown>
  } catch {
    return null
  }
}

export function hasConfigCache(options: ConfigCacheOptions = {}): boolean {
  const appRoot = options.appRoot ? resolve(options.appRoot) : process.cwd()
  const cacheDir = resolve(appRoot, options.cacheDir ?? DEFAULT_CACHE_DIR)
  const cacheFile = join(cacheDir, CACHE_FILE)

  return existsSync(cacheFile)
}

function getConfigFiles(dir: string, files: string[] = []): string[] {
  const entries = readdirSync(dir)

  for (const entry of entries) {
    const fullPath = join(dir, entry)
    const stat = statSync(fullPath)

    if (stat.isDirectory()) {
      getConfigFiles(fullPath, files)
    } else if (entry.endsWith('.ts') || entry.endsWith('.js') || entry.endsWith('.mjs')) {
      if (!entry.includes('.test.') && !entry.includes('.spec.')) {
        files.push(fullPath)
      }
    }
  }

  return files
}

export function showConfigCacheInfo(options: ConfigCacheOptions = {}): void {
  const appRoot = options.appRoot ? resolve(options.appRoot) : process.cwd()
  const cacheDir = resolve(appRoot, options.cacheDir ?? DEFAULT_CACHE_DIR)
  const cacheFile = join(cacheDir, CACHE_FILE)

  if (!existsSync(cacheFile)) {
    if (options.json) {
      console.log(JSON.stringify({ cached: false, file: cacheFile }, null, 2))
      return
    }
    consola.info('Configuration is not cached.')
    consola.info(`Run \`guren config:cache\` to cache your configuration.`)
    return
  }

  const stat = statSync(cacheFile)
  const config = loadCachedConfig(options)
  const keys = config ? Object.keys(config) : []

  if (options.json) {
    console.log(JSON.stringify({
      cached: true,
      file: cacheFile,
      size: stat.size,
      modified: stat.mtime.toISOString(),
      configs: keys,
    }, null, 2))
    return
  }

  consola.info('Configuration cache info:')
  console.log(`  File: ${cacheFile}`)
  console.log(`  Size: ${formatBytes(stat.size)}`)
  console.log(`  Modified: ${stat.mtime.toISOString()}`)
  console.log(`  Configs: ${keys.join(', ') || 'none'}`)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
