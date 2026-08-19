import { access } from 'node:fs/promises'
import { resolve } from 'node:path'
import { runCommand, slugifyProse } from './utils'

const DEFAULT_SCHEMA = 'db/schema.ts'
const DEFAULT_OUTPUT = 'db/migrations'
/**
 * The config filenames we probe for, ordered consistently with drizzle-kit.
 *
 * Not a copy of drizzle-kit's own default discovery, which probes only `.ts`,
 * `.js` and `.json`: we always hand the file over as an explicit `--config`, and
 * its loader accepts `.mts`/`.mjs` that way even though it never looks for them
 * itself. Finding nothing is not a no-op — `makeMigration()` then passes
 * `--schema`/`--out` defaults that ignore whatever the app's config declares.
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
}

function toSlug(value: string): string {
  return slugifyProse(value, '_', 'migration')
}

async function resolveDrizzleConfig(): Promise<string | undefined> {
  const cwd = process.cwd()

  for (const candidate of DRIZZLE_CONFIG_CANDIDATES) {
    const absolute = resolve(cwd, candidate)
    try {
      await access(absolute)
      return candidate
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue
      }

      throw error
    }
  }

  return undefined
}

export async function makeMigration(options: MakeMigrationOptions = {}): Promise<void> {
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

  const bunExecutable = process.execPath || 'bun'
  await runCommand(bunExecutable, args)
}
