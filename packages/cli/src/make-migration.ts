import { existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { findFirstExisting } from './discovery'
import { runCommand, slugifyProse } from './utils'

const DEFAULT_SCHEMA = 'db/schema.ts'
const DEFAULT_OUTPUT = 'db/migrations'
/**
 * Wider than drizzle-kit's own discovery (`.ts`/`.js`/`.json`): its loader
 * accepts an explicit `--config` pointing at `.mts`/`.mjs` too. `.json` is
 * probed although drizzle-kit cannot load one under its Node shebang, because
 * an error naming the user's own config beats a missing-`dialect` report for a
 * dialect they did declare. Order matters — a loadable config must beat a
 * `.json`. Verified against drizzle-kit 1.0.0-rc.4.
 */
const DRIZZLE_CONFIG_CANDIDATES = [
  'drizzle.config.ts',
  'drizzle.config.mts',
  'drizzle.config.js',
  'drizzle.config.mjs',
  'drizzle.config.json',
]

export interface MakeMigrationOptions {
  name?: string
  schema?: string
  out?: string
  /** Passed through verbatim; only reachable on the flag path. */
  dialect?: string
}

/**
 * What `drizzle-kit generate` actually produced. It exits 0 whether it wrote a
 * migration or printed "No schema changes, nothing to migrate.", so a success
 * report off the exit code alone announces a migration that does not exist.
 */
export interface MakeMigrationResult {
  /**
   * The absolute folder drizzle-kit wrote to, **only when resolved from
   * positive evidence** (an explicit `--out`, or the config's `out`). Absent
   * means `created` observed nothing and says nothing.
   */
  migrationsFolder?: string
  /**
   * Migration folders that appeared during this run. Empty alongside a
   * `migrationsFolder` is "nothing to migrate", positively observed.
   */
  created: string[]
  /** The schema file drizzle-kit read, when known, for the caller's message. */
  schemaPath?: string
  /**
   * Config fields the flag path could not carry, for the caller to warn about;
   * empty on the `--config` path. An unstated field silently reverts to
   * drizzle-kit's default rather than erroring.
   */
  droppedConfigFields: string[]
  /**
   * A config exists but could not be imported, so the flag path proceeded on
   * defaults — distinct from `droppedConfigFields`, which was read then left.
   */
  configUnreadable: boolean
}

interface DrizzleConfig {
  out?: string
  /** A single path fit to name in a message — never a glob. See `readPath`. */
  schema?: string
  /**
   * What `--schema` can be handed as one flag. Wider than `schema` above: a
   * glob is one argument drizzle-kit expands itself.
   */
  schemaFlag?: string
  /**
   * `schema` was declared as a list, which the flag path cannot carry:
   * drizzle-kit takes one `--schema` and a repeated flag keeps only the last
   * (verified against 1.0.0-rc.4, silently dropping the earlier file's tables).
   */
  schemaIsList?: boolean
  /** Passed through verbatim; drizzle-kit owns the valid set. See `readDialect`. */
  dialect?: string
  /** Passed through verbatim alongside `dialect` — `aws-data-api`, `pglite`, … */
  driver?: string
  /**
   * Only `false` is interesting: `--breakpoints` has no negation, so a config
   * disabling them cannot be restated on the command line and leaving it
   * unstated re-enables them (measured against 1.0.0-rc.4).
   */
  breakpointsDisabled?: boolean
  /** Importing the config threw, so its fields are unknown rather than unset. */
  unreadable?: boolean
}

function toSlug(value: string): string {
  return slugifyProse(value, '_', 'migration')
}

async function resolveDrizzleConfig(): Promise<string | undefined> {
  return (await findFirstExisting(process.cwd(), DRIZZLE_CONFIG_CANDIDATES)) ?? undefined
}

/**
 * drizzle-kit expands `schema` with `glob.sync`, so every metacharacter counts,
 * not just `*` — telling the user to edit `./db/{posts,users}.ts` names a file
 * that does not exist.
 */
const GLOB_METACHARACTERS = /[*?[\]{}]/

function readPath(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' && !GLOB_METACHARACTERS.test(value) ? value : undefined
}

/**
 * A glob is fine here where `readPath` rejects it: drizzle-kit expands it
 * itself, verified against 1.0.0-rc.4.
 */
function readSchemaFlag(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Deliberately not narrowed to `SchemaDialect`: drizzle-kit 1.0.0-rc.4 also
 * accepts `turso`, `singlestore`, `mssql`, `cockroach` and `duckdb`, so
 * mapping through that type would answer a turso app with `sqlite` and
 * generate quietly different SQL. drizzle-kit owns the valid set.
 */
function readVerbatim(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Importing the config runs it, so a failure (a throw on a missing env var, an
 * unresolvable `drizzle-kit`) becomes `unreadable` rather than propagating:
 * "declares no dialect" and "could not be read" send the user to different
 * fixes, and only the first is their config's fault.
 */
async function readDrizzleConfig(configPath: string): Promise<DrizzleConfig> {
  try {
    const module = await import(pathToFileURL(resolve(process.cwd(), configPath)).href)
    // drizzle-kit's loader adopts a promise-exporting config, so awaiting is
    // what keeps this reader on the same object the child process sees.
    const config = ((await module.default) ?? module) as Record<string, unknown>

    return {
      out: readPath(config?.out),
      schema: readPath(config?.schema),
      schemaFlag: readSchemaFlag(config?.schema),
      schemaIsList: Array.isArray(config?.schema),
      dialect: readVerbatim(config?.dialect),
      driver: readVerbatim(config?.driver),
      breakpointsDisabled: config?.breakpoints === false,
    }
  } catch {
    return { unreadable: true }
  }
}

/**
 * Reached only on the flag path, where drizzle-kit never sees the config and
 * so could only report `dialect: undefined` against flags nobody typed.
 */
function describeMissingDialect(configPath: string | undefined, configured: DrizzleConfig): string {
  if (!configPath) {
    return (
      'No drizzle config found, so `dialect` is unknown and drizzle-kit cannot generate. ' +
      'Create a drizzle.config.ts declaring `dialect`, or pass --dialect.'
    )
  }

  if (configured.unreadable) {
    return (
      `Could not load ${configPath} to read its \`dialect\`, and drizzle-kit needs one. ` +
      'Fix the config so it imports cleanly, or pass --dialect.'
    )
  }

  return (
    `${configPath} declares no \`dialect\`, and drizzle-kit needs one. ` +
    'Add it to the config, or pass --dialect.'
  )
}

/**
 * `@guren/orm` reads this same shape for the migrator but publishes only the
 * summary types, so the CLI reads it here rather than widening that surface.
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
  const hasOverrides = options.schema != null || options.out != null || options.dialect != null
  const useConfig = Boolean(configPath) && !hasOverrides

  // Read on both branches: any override drops `--config`, and drizzle-kit
  // 1.0.0-rc.4 refuses that combination outright ("You can't use both --config
  // and other cli options for generate command"), so the flags must restate
  // what the config would have supplied. Its `assertCollisions` only rejects
  // `driver`, `breakpoints`, `schema`, `out` and `dialect` beside `--config`,
  // which is why `--name` below rides along on either branch. `breakpoints:
  // false` is the one field flags cannot carry.
  const configured = configPath ? await readDrizzleConfig(configPath) : {}

  const args = ['x', 'drizzle-kit', 'generate']

  // Ahead of the branch: drizzle-kit whitelists `--name` beside `--config`.
  if (name) {
    args.push(`--name=${name}`)
  }

  const droppedConfigFields: string[] = []
  let configUnreadable = false
  let schema: string | undefined
  let out: string | undefined

  if (useConfig && configPath) {
    args.push('--config', configPath)
  } else {
    // drizzle-kit requires `dialect` and will not infer it; refusing here names
    // the field and the fix.
    const dialect = options.dialect ?? configured.dialect
    if (!dialect) {
      throw new Error(describeMissingDialect(configPath, configured))
    }

    // `--schema` takes one value and a repeated flag keeps only the last, so
    // carrying a list would generate part of the app's tables and drop the
    // rest silently. Reachable from the default template's own comment, which
    // documents `schema: ['./db/schema.ts', './modules/*/db/schema.ts']`.
    if (options.schema == null && configured.schemaIsList) {
      throw new Error(
        `${configPath} declares \`schema\` as a list, which cannot be passed as a single --schema ` +
          '— drizzle-kit would keep only the last entry and silently skip the rest. ' +
          'Pass --schema with one path or glob, or drop the overrides so the config is used as a whole.',
      )
    }

    schema = options.schema ?? configured.schemaFlag ?? DEFAULT_SCHEMA
    out = options.out ?? configured.out ?? DEFAULT_OUTPUT

    args.push('--dialect', dialect)
    // `driver` selects a transport within a dialect (`aws-data-api`, `pglite`),
    // so dropping it would silently switch the app off the one it named.
    if (configured.driver) {
      args.push('--driver', configured.driver)
    }
    args.push('--schema', schema)
    args.push('--out', out)

    if (configured.breakpointsDisabled) {
      droppedConfigFields.push('breakpoints')
    }

    // An un-overridden `schema`/`out` just fell back to the defaults while a
    // config sits right there — and drizzle-kit's own bundler may well read
    // the file this process could not. Guarded on something having actually
    // fallen back, so overriding both paths warns about nothing.
    if (configured.unreadable && (options.schema == null || options.out == null)) {
      configUnreadable = true
    }
  }

  // Only the config branch leaves the paths unstated on the command line, so
  // only it has to ask the config where the output went.
  const outDir = out ?? (useConfig ? configured.out : undefined)
  const migrationsFolder = outDir ? resolve(process.cwd(), outDir) : undefined
  const before = migrationsFolder ? new Set(listMigrationNames(migrationsFolder)) : new Set<string>()

  const bunExecutable = process.execPath || 'bun'
  await runCommand(bunExecutable, args)

  if (!migrationsFolder) {
    return { created: [], droppedConfigFields, configUnreadable }
  }

  return {
    migrationsFolder,
    created: listMigrationNames(migrationsFolder).filter((entry) => !before.has(entry)),
    // Per branch, never `??` across them: on the flag path a glob override
    // makes `readPath` undefined, and falling through to the config's `schema`
    // would name a file drizzle-kit did not read.
    schemaPath: useConfig ? configured.schema : readPath(schema),
    droppedConfigFields,
    configUnreadable,
  }
}
