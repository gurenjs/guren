import { readdir } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

const SUPPORTED_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts'])

export interface SeederContext {
  db: PostgresJsDatabase
}

export type SeederHandler = (context: SeederContext) => unknown

function normalizeSeeder(candidate: unknown): SeederHandler | undefined {
  if (!candidate) {
    return undefined
  }

  if (typeof candidate === 'function') {
    if ('prototype' in candidate && typeof (candidate as { prototype: unknown }).prototype === 'object') {
      const prototype = (candidate as { prototype: Record<string, unknown> }).prototype
      if (prototype && typeof prototype.run === 'function') {
        return async (context: SeederContext) => {
          const instance = new (candidate as new () => { run(ctx: SeederContext): unknown })()
          await instance.run(context)
        }
      }
    }

    return candidate as SeederHandler
  }

  if (typeof candidate === 'object') {
    const run = (candidate as Record<string, unknown>).run
    if (typeof run === 'function') {
      return run as SeederHandler
    }
  }

  return undefined
}

async function loadSeederModule(path: string): Promise<SeederHandler | undefined> {
  const module = await import(pathToFileURL(path).href)
  const candidates = [
    module.default,
    module.seed,
    module.run,
    module.Seeder,
    module.default && typeof module.default === 'object' ? (module.default as Record<string, unknown>).run : undefined,
  ]

  for (const candidate of candidates) {
    const handler = normalizeSeeder(candidate)
    if (handler) {
      return handler
    }
  }

  return undefined
}

export async function loadSeeders(directory: string | URL): Promise<Array<SeederHandler>> {
  const root = directory instanceof URL ? fileURLToPath(directory) : resolve(directory)
  const entries = await readdir(root, { withFileTypes: true })
  const files = entries
    .filter((entry) => entry.isFile() && SUPPORTED_EXTENSIONS.has(extname(entry.name)))
    .map((entry) => resolve(root, entry.name))
    .sort()

  const seeders: Array<SeederHandler> = []

  for (const file of files) {
    const handler = await loadSeederModule(file)
    if (handler) {
      seeders.push(handler)
    }
  }

  return seeders
}

export async function runSeeders(db: PostgresJsDatabase, directory: string | URL): Promise<void> {
  const seeders = await loadSeeders(directory)

  for (const handler of seeders) {
    await handler({ db })
  }
}

export function defineSeeder(handler: SeederHandler): SeederHandler {
  return handler
}
