import { existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { findFirstExisting } from './discovery'
import { runCommand, slugifyProse } from './utils'

const DEFAULT_SCHEMA = 'db/schema.ts'
const DEFAULT_OUTPUT = 'db/migrations'
const DRIZZLE_CONFIG_CANDIDATES = [
  'drizzle.config.ts',
  'drizzle.config.mts',
  'drizzle.config.js',
  'drizzle.config.mjs',
]

export interface MakeMigrationOptions {
  name?: string
  schema?: string
  out?: string
}

/**
 * What `drizzle-kit generate` actually produced. The command exits 0 whether it
 * wrote a migration or printed "No schema changes, nothing to migrate.", so a ✔
 * off the exit code alone reports a migration that does not exist — and sends
 * the user back to `db:migrate`, which then repeats its own empty-folder
 * warning with nothing in between explaining why.
 */
export interface MakeMigrationResult {
  /**
   * The folder drizzle-kit wrote to, absolute. **Present only when it was
   * resolved from positive evidence** — an explicit `--out`, or the `out` the
   * drizzle config declares. Absent means `created` observed nothing and says
   * nothing: naming a folder drizzle-kit may not have written to is worse than
   * staying quiet, so the caller falls back to reporting the exit code.
   */
  migrationsFolder?: string
  /**
   * Migration folders that appeared during this run, by name. Empty alongside a
   * `migrationsFolder` is the "nothing to migrate" case, positively observed.
   */
  created: string[]
  /** The schema file drizzle-kit read, when known, for the caller's message. */
  schemaPath?: string
}

interface DrizzleConfig {
  out?: string
  schema?: string
}

function toSlug(value: string): string {
  return slugifyProse(value, '_', 'migration')
}

async function resolveDrizzleConfig(): Promise<string | undefined> {
  return (await findFirstExisting(process.cwd(), DRIZZLE_CONFIG_CANDIDATES)) ?? undefined
}

/**
 * One path from the config, or nothing when it names no single file. drizzle-kit
 * also accepts globs and arrays for `schema`, and a message telling the user to
 * edit a glob names a file that does not exist.
 */
function readPath(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' && !value.includes('*') ? value : undefined
}

/**
 * Reads the paths out of the drizzle config, which is the authority on them
 * whenever we hand drizzle-kit `--config` instead of explicit flags.
 *
 * Importing it runs the file, so every failure — a config that throws on a
 * missing env var, a `drizzle-kit` that will not resolve — reports "unknown"
 * rather than propagating: this is a reporting nicety layered over a command
 * that already did its job. `schema` is read only when it is a single path;
 * drizzle-kit also accepts globs and arrays, which name no one file to point a
 * user at.
 */
async function readDrizzleConfig(configPath: string): Promise<DrizzleConfig> {
  try {
    const module = await import(pathToFileURL(resolve(process.cwd(), configPath)).href)
    // drizzle-kit's loader adopts a promise-exporting config, so awaiting is
    // what keeps this reader looking at the same object the child process does.
    const config = ((await module.default) ?? module) as DrizzleConfig

    return { out: readPath(config?.out), schema: readPath(config?.schema) }
  } catch {
    return {}
  }
}

/**
 * drizzle-kit migration folder names in `folder` — one directory each, holding
 * a migration.sql. `@guren/orm` reads the same shape for the migrator, but
 * publishes only the summary types, so the CLI reads it here rather than
 * growing the ORM's public surface for one caller.
 */
function listMigrationNames(folder: string): string[] {
  if (!existsSync(folder)) {
    return []
  }

  return readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(resolve(folder, entry.name, 'migration.sql')))
    .map((entry) => entry.name)
}

export async function makeMigration(options: MakeMigrationOptions = {}): Promise<MakeMigrationResult> {
  const name = options.name?.trim() ? toSlug(options.name) : undefined
  const configPath = await resolveDrizzleConfig()
  const hasOverrides = options.schema != null || options.out != null
  const useConfig = Boolean(configPath) && !hasOverrides

  const schema = options.schema ?? (useConfig ? undefined : DEFAULT_SCHEMA)
  const out = options.out ?? (useConfig ? undefined : DEFAULT_OUTPUT)

  const args = ['x', 'drizzle-kit', 'generate']

  if (schema) {
    args.push('--schema', schema)
  }

  if (out) {
    args.push('--out', out)
  }

  if (name) {
    args.push(`--name=${name}`)
  }

  if (useConfig && configPath) {
    args.push('--config', configPath)
  }

  // Only the config branch leaves the paths unstated on the command line. Note
  // an app passing just `--schema` takes the DEFAULT_OUTPUT branch above, so
  // reading the config for `out` there would describe a folder drizzle-kit is
  // not writing to.
  const configured = useConfig && configPath ? await readDrizzleConfig(configPath) : {}
  const outDir = out ?? configured.out
  const migrationsFolder = outDir ? resolve(process.cwd(), outDir) : undefined
  const before = migrationsFolder ? new Set(listMigrationNames(migrationsFolder)) : new Set<string>()

  const bunExecutable = process.execPath || 'bun'
  await runCommand(bunExecutable, args)

  if (!migrationsFolder) {
    return { created: [] }
  }

  return {
    migrationsFolder,
    created: listMigrationNames(migrationsFolder).filter((entry) => !before.has(entry)),
    schemaPath: schema ?? configured.schema,
  }
}
