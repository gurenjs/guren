import { existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { findFirstExisting } from './discovery'
import { runCommand, slugifyProse } from './utils'

const DEFAULT_SCHEMA = 'db/schema.ts'
const DEFAULT_OUTPUT = 'db/migrations'
/**
 * The config filenames we probe for, ordered consistently with drizzle-kit.
 *
 * Not a copy of drizzle-kit's own default discovery, which probes only `.ts`,
 * `.js` and `.json`: when we hand the file over as an explicit `--config`, its
 * loader accepts `.mts`/`.mjs` even though it never looks for them itself.
 * Finding nothing is not a no-op — it leaves `dialect` with no source at all,
 * and `makeMigration()` refuses rather than run a command that cannot succeed.
 *
 * `drizzle.config.json` is probed even though drizzle-kit cannot currently load
 * one: `bun x drizzle-kit` runs it through its `#!/usr/bin/env node` shebang, and
 * under Node its `import()` of the config needs a `type: json` import attribute
 * it does not pass. Pointing it at the app's real config still beats overriding
 * with defaults — the user gets an error naming the file they wrote, instead of
 * drizzle-kit reporting a missing `dialect` they had in fact declared. Ordering
 * matters for the same reason drizzle-kit's does: a loadable config alongside a
 * `.json` must win.
 *
 * Bun *can* import a `.json` config, so on the flag path — where this process
 * reads the config itself instead of delegating — a JSON app works where the
 * `--config` path fails it. That asymmetry is a strict improvement, not a
 * contradiction: the flag path never needs drizzle-kit to load the file.
 *
 * Verified against drizzle-kit 1.0.0-rc.4 (the version the scaffold templates
 * pin) via `bun x drizzle-kit generate --config <file>`.
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
  /**
   * The drizzle dialect, passed through verbatim. Only reachable on the flag
   * path — see `makeMigration()` — and only needed when no config declares one.
   */
  dialect?: string
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
  /**
   * Config fields the flag path could not carry, named for the caller to warn
   * about. Empty on the `--config` path, which carries everything by
   * definition.
   *
   * `generate` exposes most of the config as flags, but not all of it, and an
   * unstated field silently reverts to drizzle-kit's default rather than
   * erroring — the same "quietly generates something else" failure the list
   * `schema` refusal exists to prevent, only milder, so it warns instead of
   * stopping.
   */
  droppedConfigFields: string[]
  /**
   * A drizzle config exists but this process could not import it, so the flag
   * path proceeded on defaults. Distinct from `droppedConfigFields`, which
   * names fields read and then left behind.
   */
  configUnreadable: boolean
}

interface DrizzleConfig {
  out?: string
  /** A single path fit to name in a message — never a glob. See `readPath`. */
  schema?: string
  /**
   * What `--schema` can be handed as one flag. Wider than `schema` above: a
   * glob is one argument drizzle-kit expands itself, it just names no one file
   * to point a user at.
   */
  schemaFlag?: string
  /**
   * `schema` was declared as a list. drizzle-kit takes one `--schema`, and a
   * repeated flag keeps only the last — verified against 1.0.0-rc.4, where
   * `--schema db/schema.ts --schema modules/a/db/schema.ts` generated the
   * second file's tables and silently dropped the first's. So the flag path
   * cannot carry a list, and must say so rather than emit half a migration.
   */
  schemaIsList?: boolean
  /** Passed through verbatim; drizzle-kit owns the valid set. See `readDialect`. */
  dialect?: string
  /** Passed through verbatim alongside `dialect` — `aws-data-api`, `pglite`, … */
  driver?: string
  /**
   * Only `false` is interesting. `--breakpoints` is a boolean flag with no
   * negation, so a config disabling them cannot be restated on the command
   * line; leaving it unstated re-enables them. Measured against 1.0.0-rc.4:
   * the same schema yields one `--> statement-breakpoint` via `--config` with
   * `breakpoints: false`, and none via flags.
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
 * One path from the config, or nothing when it names no single file. drizzle-kit
 * also accepts globs and arrays for `schema`, and a message telling the user to
 * edit a glob names a file that does not exist.
 *
 * Every glob metacharacter counts, not just `*`: drizzle-kit expands `schema`
 * with `glob.sync`, so `./db/{posts,users}.ts` and `./db/schema.?ts` are
 * patterns too, and naming one as the file to edit is the same mistake `*`
 * was already guarded against.
 */
const GLOB_METACHARACTERS = /[*?[\]{}]/

function readPath(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' && !GLOB_METACHARACTERS.test(value) ? value : undefined
}

/**
 * What `--schema` can be handed, or nothing when the config states no schema at
 * all. A glob is fine here where `readPath` rejects it: drizzle-kit expands it
 * itself, verified against 1.0.0-rc.4.
 */
function readSchemaFlag(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * A dialect/driver string, passed to drizzle-kit verbatim.
 *
 * Deliberately not narrowed to `SchemaDialect` ('sqlite' | 'pg' | 'mysql'):
 * drizzle-kit 1.0.0-rc.4 also accepts `turso`, `singlestore`, `mssql`,
 * `cockroach` and `duckdb`, so mapping through that type would answer a turso
 * app with `sqlite` and generate quietly different SQL. drizzle-kit owns the
 * valid set and rejects a typo with a message naming every option, which beats
 * a second copy of the list here going stale.
 */
function readVerbatim(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Reads the drizzle config, which is the authority on what drizzle-kit needs
 * whenever we cannot simply hand it `--config`.
 *
 * Importing it runs the file, so a failure — a config that throws on a missing
 * env var, a `drizzle-kit` that will not resolve — is reported as `unreadable`
 * rather than propagating. That distinction matters now that the flag path
 * depends on this reader: "your config declares no dialect" and "we could not
 * read your config" send the user to different fixes, and only the first is
 * their config's fault.
 */
async function readDrizzleConfig(configPath: string): Promise<DrizzleConfig> {
  try {
    const module = await import(pathToFileURL(resolve(process.cwd(), configPath)).href)
    // drizzle-kit's loader adopts a promise-exporting config, so awaiting is
    // what keeps this reader looking at the same object the child process does.
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
 * Why no dialect could be resolved, phrased as the fix rather than as
 * drizzle-kit's `dialect: undefined`. Reached only on the flag path, where
 * drizzle-kit never sees the config and so cannot name it for us.
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
  const hasOverrides = options.schema != null || options.out != null || options.dialect != null
  const useConfig = Boolean(configPath) && !hasOverrides

  // Read the config on both branches now. The flag path needs it most: any
  // override drops `--config`, and drizzle-kit 1.0.0-rc.4 refuses that
  // combination — "You can't use both --config and other cli options for
  // generate command", exit 1 — so the flags have to restate what the config
  // would have supplied, `dialect` above all.
  //
  // The refusal is per-flag, not blanket: `generate` whitelists `name`,
  // `custom`, `ignoreConflicts`, `explain`, `output`, `hints` and `hintsFile`
  // as safe beside `--config`, and collides only on `driver`, `breakpoints`,
  // `schema`, `out` and `dialect` (drizzle-kit's `assertCollisions`). That is
  // why `--name` below rides along on either branch.
  //
  // "What it can": `generate` takes dialect, driver, schema, out and name as
  // flags, which covers the fields that decide *what* is generated and *where*.
  // `breakpoints: false` is the measured exception, reported rather than
  // carried. `tablesFilter`/`schemaFilter` were checked and do not apply to
  // `generate` at all (push/pull only), and rc.4's Config has no top-level
  // `casing` nor a `migrations.prefix` — so neither is a gap here.
  const configured = configPath ? await readDrizzleConfig(configPath) : {}

  const args = ['x', 'drizzle-kit', 'generate']

  // Ahead of the branch because `--name` belongs to neither: drizzle-kit
  // whitelists it beside `--config`, so it rides along whichever way the rest
  // of the arguments are assembled.
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
    // drizzle-kit requires `dialect` and will not infer it. Refusing here names
    // the field and the fix; letting the child run reports `dialect: undefined`
    // against flags the user never typed.
    const dialect = options.dialect ?? configured.dialect
    if (!dialect) {
      throw new Error(describeMissingDialect(configPath, configured))
    }

    // A list `schema` cannot survive the trip: `--schema` takes one value and a
    // repeated flag keeps only the last, so carrying it would generate part of
    // the app's tables and drop the rest without a word. The default template
    // documents `schema: ['./db/schema.ts', './modules/*/db/schema.ts']`, so
    // this is reachable by following its own comment.
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
    // `driver` selects a transport within a dialect (`aws-data-api`, `pglite`,
    // …). Dropping it would silently switch the app off the one its config
    // names, so it rides along whenever the config states one.
    if (configured.driver) {
      args.push('--driver', configured.driver)
    }
    args.push('--schema', schema)
    args.push('--out', out)

    if (configured.breakpointsDisabled) {
      droppedConfigFields.push('breakpoints')
    }

    // An unreadable config states nothing, so an un-overridden `schema`/`out`
    // fell back to the defaults above while a config file sits right there.
    // drizzle-kit loads configs with its own bundler, so it may well have read
    // the one this process could not — generating from a schema the app never
    // named.
    //
    // Only when something actually fell back: overriding both paths leaves the
    // config nothing to have supplied, and warning there would describe a
    // substitution that did not happen.
    if (configured.unreadable && (options.schema == null || options.out == null)) {
      configUnreadable = true
    }
  }

  // The config branch is the only one that leaves the paths unstated on the
  // command line, so it is the only one that has to ask the config where the
  // output went. The flag branch resolved `out` above, from the override, the
  // config, or the default, in that order.
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
