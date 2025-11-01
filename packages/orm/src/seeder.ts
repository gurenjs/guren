import { readdir } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

const SUPPORTED_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts'])

export interface SeederContext<TSchema extends Record<string, unknown>> {
  db: PostgresJsDatabase<TSchema>
}

export type SeederHandler<TSchema extends Record<string, unknown>> = (context: SeederContext<TSchema>) => unknown

function normalizeSeeder<TSchema extends Record<string, unknown>>(candidate: unknown): SeederHandler<TSchema> | undefined {
  if (!candidate) {
    return undefined
  }

  if (typeof candidate === 'function') {
    if ('prototype' in candidate && typeof (candidate as { prototype: unknown }).prototype === 'object') {
      const prototype = (candidate as { prototype: Record<string, unknown> }).prototype
      if (prototype && typeof prototype.run === 'function') {
        return async (context: SeederContext<TSchema>) => {
          const instance = new (candidate as new () => { run(ctx: SeederContext<TSchema>): unknown })()
          await instance.run(context)
        }
      }
    }

    return candidate as SeederHandler<TSchema>
  }

  if (typeof candidate === 'object') {
    const run = (candidate as Record<string, unknown>).run
    if (typeof run === 'function') {
      return run as SeederHandler<TSchema>
    }
  }

  return undefined
}

async function loadSeederModule<TSchema extends Record<string, unknown>>(path: string): Promise<SeederHandler<TSchema> | undefined> {
  const module = await import(pathToFileURL(path).href)
  const candidates = [
    module.default,
    module.seed,
    module.run,
    module.Seeder,
    module.default && typeof module.default === 'object' ? (module.default as Record<string, unknown>).run : undefined,
  ]

  for (const candidate of candidates) {
    const handler = normalizeSeeder<TSchema>(candidate)
    if (handler) {
      return handler
    }
  }

  return undefined
}

export async function loadSeeders<TSchema extends Record<string, unknown>>(directory: string | URL): Promise<Array<SeederHandler<TSchema>>> {
  const root = directory instanceof URL ? fileURLToPath(directory) : resolve(directory)
  const entries = await readdir(root, { withFileTypes: true })
  const files = entries
    .filter((entry) => entry.isFile() && SUPPORTED_EXTENSIONS.has(extname(entry.name)))
    .map((entry) => resolve(root, entry.name))
    .sort()

  const seeders: Array<SeederHandler<TSchema>> = []

  for (const file of files) {
    const handler = await loadSeederModule<TSchema>(file)
    if (handler) {
      seeders.push(handler)
    }
  }

  return seeders
}

export async function runSeeders<TSchema extends Record<string, unknown>>(db: PostgresJsDatabase<TSchema>, directory: string | URL): Promise<void> {
  const seeders = await loadSeeders<TSchema>(directory)

  for (const handler of seeders) {
    await handler({ db })
  }
}

export function defineSeeder<TSchema extends Record<string, unknown>>(handler: SeederHandler<TSchema>): SeederHandler<TSchema> {
  return handler
}
