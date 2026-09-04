import { describe, expect, it, mock } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createTempWorkspace, runCliBin } from './helpers'
import * as realUtils from '../src/utils'

const repoRoot = resolve(import.meta.dir, '../../..')

/**
 * The real `drizzle-kit` bin plus a directory it can resolve `drizzle-orm`
 * from, or undefined when neither is installed. Resolved from `examples/blog`
 * (bun's isolated layout keeps both out of the root `node_modules`); undefined
 * rather than a throw keeps the suite runnable without the examples installed.
 */
function resolveDrizzleKit(): { bin: string; nodeModules: string } | undefined {
  const from = join(repoRoot, 'examples/blog')
  try {
    // `Bun.resolveSync` can answer from the root `.bun/` store even when blog
    // was never installed, leaving the symlink below dangling.
    if (!existsSync(join(from, 'node_modules'))) {
      return undefined
    }

    const bin = join(dirname(Bun.resolveSync('drizzle-kit/package.json', from)), 'bin.cjs')
    // The generated schema imports `drizzle-orm/pg-core`, which drizzle-kit
    // resolves from the *workspace*. A throw here is the skip signal.
    Bun.resolveSync('drizzle-orm/pg-core', from)

    // blog's own link farm, not the resolved path: node's resolver finds
    // nothing by bare specifier under bun's isolated layout.
    return { bin, nodeModules: join(from, 'node_modules') }
  } catch {
    return undefined
  }
}

const spawnCalls: Array<{ command: string; args: string[] }> = []

/**
 * What the faked `drizzle-kit generate` writes for the next call, or undefined
 * for the run that finds no schema changes. Without it, "nothing was generated"
 * would also pass against a `makeMigration` that never reads the folder.
 */
let nextGeneratedMigration: { folder: string; name: string } | undefined

// Mock `./utils`'s `runCommand` rather than `node:child_process`: `mock.module()`
// is process-wide with no per-file scoping, so faking the built-in would poison
// tests that really shell out (changed-files.test.ts runs git). Spread the real
// module so `writeFileSafe` and friends keep their behavior.
await mock.module('../src/utils', () => ({
  ...realUtils,
  runCommand: async (command: string, args: string[]) => {
    spawnCalls.push({ command, args })

    if (nextGeneratedMigration) {
      const { folder, name } = nextGeneratedMigration
      nextGeneratedMigration = undefined
      await mkdir(join(folder, name), { recursive: true })
      await writeFile(join(folder, name, 'migration.sql'), 'CREATE TABLE users ();', 'utf8')
    }
  },
}))

const { makeMigration } = await import('../src/make-migration')

function generateOnNextRun(folder: string, name: string): void {
  nextGeneratedMigration = { folder, name }
}

describe('makeMigration', () => {
  it('uses the drizzle config when available', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-migration-')
    try {
      await writeFile(join(workspace.dir, 'drizzle.config.ts'), 'export default {}', 'utf8')

      await makeMigration()

      const call = spawnCalls.pop()
      expect(call?.args).toContain('--config')
      expect(call?.args).toContain('drizzle.config.ts')
      expect(call?.args?.includes('--schema')).toBe(false)
      expect(call?.args?.includes('--out')).toBe(false)
    } finally {
      await workspace.cleanup()
    }
  })

  it('uses a drizzle.config.json, the format drizzle-kit names as its own default', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-migration-json-')
    try {
      await writeFile(
        join(workspace.dir, 'drizzle.config.json'),
        '{ "dialect": "postgresql", "schema": "db/schema.ts", "out": "db/migrations" }',
        'utf8',
      )

      await makeMigration()

      const call = spawnCalls.pop()
      expect(call?.args).toContain('--config')
      expect(call?.args).toContain('drizzle.config.json')
      expect(call?.args?.includes('--schema')).toBe(false)
      expect(call?.args?.includes('--out')).toBe(false)
    } finally {
      await workspace.cleanup()
    }
  })

  it('prefers a loadable config over the json drizzle-kit cannot import', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-migration-order-')
    try {
      await writeFile(join(workspace.dir, 'drizzle.config.js'), 'export default {}', 'utf8')
      await writeFile(join(workspace.dir, 'drizzle.config.json'), '{}', 'utf8')

      await makeMigration()

      const call = spawnCalls.pop()
      expect(call?.args).toContain('drizzle.config.js')
      expect(call?.args?.includes('drizzle.config.json')).toBe(false)
    } finally {
      await workspace.cleanup()
    }
  })

  it('applies overrides and slugifies names', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-migration-override-')
    try {
      await writeFile(
        join(workspace.dir, 'drizzle.config.ts'),
        "export default { dialect: 'postgresql' }",
        'utf8',
      )

      await makeMigration({
        name: 'Add Users',
        schema: 'db/schema.ts',
        out: 'db/migrations',
      })

      const call = spawnCalls.pop()
      expect(call?.args).toContain('--schema')
      expect(call?.args).toContain('db/schema.ts')
      expect(call?.args).toContain('--out')
      expect(call?.args).toContain('db/migrations')
      expect(call?.args).toContain('--name=add_users')
      // Overrides drop `--config`, which drizzle-kit refuses alongside other
      // flags, so the dialect has to be restated or the run cannot succeed.
      expect(call?.args?.includes('--config')).toBe(false)
      expect(call?.args).toContain('--dialect')
      expect(call?.args).toContain('postgresql')
    } finally {
      await workspace.cleanup()
    }
  })

  it('carries the dialect onto the documented --schema/--out override flow', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-migration-documented-')
    try {
      // The exact invocation docs/ja/guides/database.md prints under
      // "マイグレーションの生成"; it failed with `dialect: undefined` before.
      await writeFile(
        join(workspace.dir, 'drizzle.config.ts'),
        "export default { dialect: 'postgresql', schema: './db/schema.ts', out: './db/migrations' }",
        'utf8',
      )

      await makeMigration({ schema: './custom/schema.ts', out: './custom/migrations' })

      const call = spawnCalls.pop()
      expect(call?.args).toEqual([
        'x',
        'drizzle-kit',
        'generate',
        '--dialect',
        'postgresql',
        '--schema',
        './custom/schema.ts',
        '--out',
        './custom/migrations',
      ])
    } finally {
      await workspace.cleanup()
    }
  })

  it('carries the driver, which selects a transport within the dialect', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-migration-driver-')
    try {
      await writeFile(
        join(workspace.dir, 'drizzle.config.ts'),
        "export default { dialect: 'postgresql', driver: 'aws-data-api', out: './db/migrations' }",
        'utf8',
      )

      await makeMigration({ schema: './db/schema.ts' })

      const call = spawnCalls.pop()
      expect(call?.args).toContain('--driver')
      expect(call?.args).toContain('aws-data-api')
    } finally {
      await workspace.cleanup()
    }
  })

  it('generates with no config at all when --dialect supplies what none declares', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-migration-dialect-flag-')
    try {
      // The no-config fallback: its DEFAULT_SCHEMA/DEFAULT_OUTPUT could never
      // succeed while `dialect` went unstated.
      await makeMigration({ dialect: 'sqlite' })

      const call = spawnCalls.pop()
      expect(call?.args).toEqual([
        'x',
        'drizzle-kit',
        'generate',
        '--dialect',
        'sqlite',
        '--schema',
        'db/schema.ts',
        '--out',
        'db/migrations',
      ])
    } finally {
      await workspace.cleanup()
    }
  })

  it('refuses, naming the dialect, when no config and no flag declare one', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-migration-no-dialect-')
    try {
      await expect(makeMigration()).rejects.toThrow(/No drizzle config found.*dialect.*--dialect/s)
      // Refused before spawning: drizzle-kit's own `dialect: undefined` names
      // flags the user never typed.
      expect(spawnCalls.length).toBe(0)
    } finally {
      await workspace.cleanup()
    }
  })

  it('names the config when it is the file that declares no dialect', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-migration-config-no-dialect-')
    try {
      await writeFile(join(workspace.dir, 'drizzle.config.ts'), "export default { out: './db/migrations' }", 'utf8')

      await expect(makeMigration({ out: './other' })).rejects.toThrow(
        /drizzle\.config\.ts declares no `dialect`/,
      )
      expect(spawnCalls.length).toBe(0)
    } finally {
      await workspace.cleanup()
    }
  })

  it('distinguishes a config it could not load from one missing a dialect', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-migration-unloadable-')
    try {
      // The two send the user to different fixes, and only one is their
      // config's fault.
      await writeFile(
        join(workspace.dir, 'drizzle.config.ts'),
        "import 'a-package-that-is-not-installed'\nexport default { dialect: 'sqlite' }",
        'utf8',
      )

      await expect(makeMigration({ out: './other' })).rejects.toThrow(/Could not load drizzle\.config\.ts/)
      expect(spawnCalls.length).toBe(0)
    } finally {
      await workspace.cleanup()
    }
  })

  it('refuses a list schema rather than generating half the tables', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-migration-list-schema-')
    try {
      // `--schema` takes one value and a repeated flag keeps only the last, so
      // carrying a list would drop tables silently.
      await writeFile(
        join(workspace.dir, 'drizzle.config.ts'),
        "export default { dialect: 'sqlite', schema: ['./db/schema.ts', './modules/*/db/schema.ts'] }",
        'utf8',
      )

      await expect(makeMigration({ out: './other' })).rejects.toThrow(/declares `schema` as a list/)
      expect(spawnCalls.length).toBe(0)
    } finally {
      await workspace.cleanup()
    }
  })

  it('names the migration drizzle-kit generated', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-migration-created-')
    try {
      const root = process.cwd()
      generateOnNextRun(join(root, 'db/migrations'), '0000_add_users')

      const result = await makeMigration({ out: 'db/migrations', dialect: 'sqlite' })

      expect(result.created).toEqual(['0000_add_users'])
      expect(result.migrationsFolder).toBe(join(root, 'db/migrations'))
      spawnCalls.pop()
    } finally {
      await workspace.cleanup()
    }
  })

  it('reports no migration when drizzle-kit found no schema changes', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-migration-unchanged-')
    try {
      // drizzle-kit prints "No schema changes, nothing to migrate." and exits 0,
      // so the folder is the only evidence that nothing was written.
      const result = await makeMigration({ out: 'db/migrations', dialect: 'sqlite' })

      expect(result.created).toEqual([])
      // Set, so the caller can tell "watched, nothing appeared" from "not watched".
      expect(result.migrationsFolder).toBe(join(process.cwd(), 'db/migrations'))
      spawnCalls.pop()
    } finally {
      await workspace.cleanup()
    }
  })

  it('ignores migrations that were already there', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-migration-existing-')
    try {
      const folder = join(workspace.dir, 'db/migrations')
      await mkdir(join(folder, '0000_create_users'), { recursive: true })
      await writeFile(join(folder, '0000_create_users', 'migration.sql'), '', 'utf8')
      generateOnNextRun(folder, '0001_add_posts')

      const result = await makeMigration({ out: 'db/migrations', dialect: 'sqlite' })

      expect(result.created).toEqual(['0001_add_posts'])
      spawnCalls.pop()
    } finally {
      await workspace.cleanup()
    }
  })

  it('resolves the output folder from the drizzle config', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-migration-config-out-')
    try {
      await writeFile(
        join(workspace.dir, 'drizzle.config.ts'),
        "export default { schema: './db/schema.ts', out: './custom/migrations' }",
        'utf8',
      )
      generateOnNextRun(join(process.cwd(), 'custom/migrations'), '0000_from_config')

      const result = await makeMigration()

      expect(result.migrationsFolder).toBe(join(process.cwd(), 'custom/migrations'))
      expect(result.created).toEqual(['0000_from_config'])
      expect(result.schemaPath).toBe('./db/schema.ts')
      spawnCalls.pop()
    } finally {
      await workspace.cleanup()
    }
  })

  it('keeps the config out when only --schema is overridden', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-migration-schema-only-')
    try {
      // A --schema override alone stops `--config` being passed, so every field
      // it declares has to be restated — `out` included, or the app's history
      // splits across two directories.
      await writeFile(
        join(workspace.dir, 'drizzle.config.ts'),
        "export default { dialect: 'sqlite', out: './custom/migrations' }",
        'utf8',
      )
      generateOnNextRun(join(process.cwd(), 'custom/migrations'), '0000_add_users')

      const result = await makeMigration({ schema: 'db/other-schema.ts' })

      expect(result.migrationsFolder).toBe(join(process.cwd(), 'custom/migrations'))
      expect(result.created).toEqual(['0000_add_users'])
      expect(result.schemaPath).toBe('db/other-schema.ts')
      const call = spawnCalls.pop()
      expect(call?.args?.includes('--config')).toBe(false)
      expect(call?.args).toContain('./custom/migrations')
    } finally {
      await workspace.cleanup()
    }
  })

  it('reports nothing when the config declares no out directory', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-migration-no-out-')
    try {
      // drizzle-kit falls back to its own default here, which this reader cannot
      // know, so the folder stays unset rather than naming one we did not watch.
      await writeFile(join(workspace.dir, 'drizzle.config.ts'), "export default { dialect: 'sqlite' }", 'utf8')

      const result = await makeMigration()

      expect(result.migrationsFolder).toBeUndefined()
      expect(result.created).toEqual([])
      spawnCalls.pop()
    } finally {
      await workspace.cleanup()
    }
  })

  it('does not fail db:make when the config cannot be read', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-migration-bad-config-')
    try {
      // drizzle-kit loads configs with its own bundler, so the two do not always
      // agree on what is loadable; the disagreement costs a message, never the
      // command.
      await writeFile(
        join(workspace.dir, 'drizzle.config.ts'),
        "import 'a-package-that-is-not-installed'\nexport default { out: './db/migrations' }",
        'utf8',
      )

      const result = await makeMigration()

      expect(result.migrationsFolder).toBeUndefined()
      expect(result.created).toEqual([])
      spawnCalls.pop()
    } finally {
      await workspace.cleanup()
    }
  })

  it('reads a promise-exporting config, which drizzle-kit accepts', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-migration-promise-config-')
    try {
      await writeFile(
        join(workspace.dir, 'drizzle.config.ts'),
        "export default Promise.resolve({ out: './custom/migrations' })",
        'utf8',
      )
      generateOnNextRun(join(process.cwd(), 'custom/migrations'), '0000_from_promise')

      const result = await makeMigration()

      expect(result.migrationsFolder).toBe(join(process.cwd(), 'custom/migrations'))
      expect(result.created).toEqual(['0000_from_promise'])
      spawnCalls.pop()
    } finally {
      await workspace.cleanup()
    }
  })

  /**
   * The one test that can observe drizzle-kit *rejecting* what it was handed:
   * everything above asserts against a mocked `runCommand`, which accepts any
   * argument list. Verified to fail without the fix — the same run minus
   * `--dialect` exits 1 with "Please provide required params: [x] dialect".
   */
  it('builds an argument list real drizzle-kit accepts', async () => {
    const drizzleKit = resolveDrizzleKit()
    if (!drizzleKit) {
      // A silent pass would read as "the args were verified" when nothing ran.
      console.warn('[make-migration] skipped: no drizzle-kit installed (run `bun install` at the repo root)')
      return
    }

    const workspace = await createTempWorkspace('guren-cli-make-migration-e2e-')
    try {
      // drizzle-kit reads the schema with node's resolver from the cwd, so the
      // workspace needs a `drizzle-orm` to resolve; symlinking beats installing.
      await symlink(drizzleKit.nodeModules, join(workspace.dir, 'node_modules'), 'dir')
      await mkdir(join(workspace.dir, 'custom'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'custom/schema.ts'),
        "import { pgTable, serial, text } from 'drizzle-orm/pg-core'\n" +
          "export const widgets = pgTable('widgets', { id: serial('id').primaryKey(), label: text('label').notNull() })\n",
        'utf8',
      )
      // Declares the dialect *and* the driver the override path has to carry
      // across, so the real binary sees both flags rather than just `--dialect`.
      await writeFile(
        join(workspace.dir, 'drizzle.config.ts'),
        "export default { dialect: 'postgresql', driver: 'aws-data-api', " +
          "schema: './db/schema.ts', out: './db/migrations' }",
        'utf8',
      )

      // The documented override invocation.
      await makeMigration({ schema: './custom/schema.ts', out: './custom/migrations' })
      const call = spawnCalls.pop()
      expect(call?.args?.[0]).toBe('x')
      expect(call?.args?.[1]).toBe('drizzle-kit')

      // Drop the `bun x drizzle-kit` prefix; run the same generate args for real.
      expect(call?.args).toContain('--driver')

      const result = spawnSync('node', [drizzleKit.bin, ...(call?.args ?? []).slice(2)], {
        cwd: workspace.dir,
        encoding: 'utf8',
      })

      // Surface drizzle-kit's own output on failure; a bare status tells you
      // nothing about which argument it objected to.
      if (result.status !== 0) {
        throw new Error(
          `drizzle-kit rejected ${(call?.args ?? []).slice(2).join(' ')}\n${result.stdout}\n${result.stderr}`,
        )
      }
      const generated = readdirSync(join(workspace.dir, 'custom/migrations'))
      expect(generated.length).toBe(1)
      const sql = await readFile(
        join(workspace.dir, 'custom/migrations', generated[0] as string, 'migration.sql'),
        'utf8',
      )
      // The overridden schema is what it read, not the config's.
      expect(sql).toContain('CREATE TABLE "widgets"')
    } finally {
      await workspace.cleanup()
    }
    // Spawns a real drizzle-kit, which reads and bundles the schema — well past
    // bun's 5s default on a cold run.
  }, 60_000)

  it('reports a config field the flag path cannot restate', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-migration-dropped-')
    try {
      // `--breakpoints` has no negation, so `false` cannot be restated and
      // drizzle-kit re-enables it. Measured: the same schema yields one
      // `--> statement-breakpoint` via flags and none via `--config`.
      await writeFile(
        join(workspace.dir, 'drizzle.config.ts'),
        "export default { dialect: 'postgresql', breakpoints: false, out: './db/migrations' }",
        'utf8',
      )

      const result = await makeMigration({ schema: './db/schema.ts' })

      expect(result.droppedConfigFields).toEqual(['breakpoints'])
      spawnCalls.pop()
    } finally {
      await workspace.cleanup()
    }
  })

  it('reports nothing dropped when the config is passed whole', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-migration-nothing-dropped-')
    try {
      await writeFile(
        join(workspace.dir, 'drizzle.config.ts'),
        "export default { dialect: 'postgresql', breakpoints: false, out: './db/migrations' }",
        'utf8',
      )

      const result = await makeMigration()

      // The `--config` path carries every field by definition.
      expect(result.droppedConfigFields).toEqual([])
      spawnCalls.pop()
    } finally {
      await workspace.cleanup()
    }
  })

  it('does not name the config schema when the override is a glob', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-migration-glob-override-')
    try {
      // The override is what drizzle-kit reads, and a glob names no one file;
      // the config's `schema` would name a file unrelated to this run.
      await writeFile(
        join(workspace.dir, 'drizzle.config.ts'),
        "export default { dialect: 'sqlite', schema: './db/schema.ts', out: './db/migrations' }",
        'utf8',
      )

      const result = await makeMigration({ schema: './modules/*/db/schema.ts' })

      expect(result.schemaPath).toBeUndefined()
      spawnCalls.pop()
    } finally {
      await workspace.cleanup()
    }
  })

  it('names a non-glob override as the file to edit', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-migration-named-override-')
    try {
      await writeFile(
        join(workspace.dir, 'drizzle.config.ts'),
        "export default { dialect: 'sqlite', schema: './db/schema.ts', out: './db/migrations' }",
        'utf8',
      )

      const result = await makeMigration({ schema: './custom/schema.ts' })

      expect(result.schemaPath).toBe('./custom/schema.ts')
      spawnCalls.pop()
    } finally {
      await workspace.cleanup()
    }
  })

  it('reports a config it could not load while --dialect carried the run', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-migration-unreadable-proceed-')
    try {
      // drizzle-kit bundles configs with its own loader, so it may read one this
      // process cannot — and the defaults below then describe another schema.
      await writeFile(
        join(workspace.dir, 'drizzle.config.ts'),
        "import 'a-package-that-is-not-installed'\nexport default { schema: './custom/schema.ts' }",
        'utf8',
      )

      const result = await makeMigration({ dialect: 'sqlite' })

      expect(result.configUnreadable).toBe(true)
      const call = spawnCalls.pop()
      expect(call?.args).toContain('db/schema.ts')
    } finally {
      await workspace.cleanup()
    }
  })

  it('keeps --name on the config path, which drizzle-kit whitelists', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-migration-name-config-')
    try {
      // `generate` collides `--config` only with driver/breakpoints/schema/out/
      // dialect, and whitelists name/custom/ignoreConflicts/explain/output/
      // hints/hintsFile. So the primary documented invocation keeps both.
      await writeFile(
        join(workspace.dir, 'drizzle.config.ts'),
        "export default { dialect: 'sqlite', out: './db/migrations' }",
        'utf8',
      )

      await makeMigration({ name: 'add posts table' })

      const call = spawnCalls.pop()
      expect(call?.args).toContain('--config')
      expect(call?.args).toContain('--name=add_posts_table')
      expect(call?.args?.includes('--dialect')).toBe(false)
    } finally {
      await workspace.cleanup()
    }
  })

  it('does not name a brace or wildcard pattern as the file to edit', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-migration-brace-glob-')
    try {
      // drizzle-kit expands `schema` with glob.sync, so `{a,b}` and `?` are
      // patterns just as much as `*`.
      await writeFile(
        join(workspace.dir, 'drizzle.config.ts'),
        "export default { dialect: 'sqlite', out: './db/migrations' }",
        'utf8',
      )

      const result = await makeMigration({ schema: './db/{posts,users}.ts' })

      expect(result.schemaPath).toBeUndefined()
      spawnCalls.pop()
    } finally {
      await workspace.cleanup()
    }
  })

  it('does not claim a fallback when both paths were overridden', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-migration-no-fallback-')
    try {
      // The config is unreadable, but nothing fell back to a default: both
      // paths came from the caller, so there is no substitution to report.
      await writeFile(
        join(workspace.dir, 'drizzle.config.ts'),
        "import 'a-package-that-is-not-installed'\nexport default { schema: './x.ts' }",
        'utf8',
      )

      const result = await makeMigration({
        dialect: 'sqlite',
        schema: './custom/schema.ts',
        out: './custom/migrations',
      })

      expect(result.configUnreadable).toBe(false)
      spawnCalls.pop()
    } finally {
      await workspace.cleanup()
    }
  })

  it('does not name a glob schema as the file to edit', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-migration-glob-schema-')
    try {
      await writeFile(
        join(workspace.dir, 'drizzle.config.ts'),
        "export default { schema: './modules/*/db/schema.ts', out: './db/migrations' }",
        'utf8',
      )

      const result = await makeMigration()

      // The folder is still watched; only the schema is unnameable.
      expect(result.migrationsFolder).toBe(join(process.cwd(), 'db/migrations'))
      expect(result.schemaPath).toBeUndefined()
      spawnCalls.pop()
    } finally {
      await workspace.cleanup()
    }
  })
})

/**
 * A stand-in for the `drizzle-kit` `bun x` would fetch, written where `bun x`
 * looks first (`node_modules/.bin` under the invocation cwd). Records its argv
 * and exits 0, which is what keeps this test off the network.
 */
async function seedDrizzleKitStub(dir: string): Promise<void> {
  const binDir = join(dir, 'node_modules', '.bin')
  await mkdir(binDir, { recursive: true })
  const stub = join(binDir, 'drizzle-kit')
  await writeFile(stub, '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$GUREN_TEST_ARGV_OUT"\n', 'utf8')
  await chmod(stub, 0o755)
  // Declares a dialect because `--schema`/`--out` drop `--config`, and the flag
  // path has to restate it. Config-path cases never name one on the line.
  await writeFile(join(dir, 'drizzle.config.ts'), "export default { dialect: 'sqlite' }", 'utf8')
}

/**
 * The argv `make:migration` actually hands drizzle-kit, from a real spawn of the
 * CLI. Spawned rather than imported because what is under test is bin.ts's citty
 * arg *declaration*: citty resolves positionals and string flags from different
 * places, so declaring `name` a positional dropped `--name <value>` silently.
 */
async function drizzleKitArgvFor(cliArgs: string[]): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), 'guren-cli-make-migration-argv-'))
  try {
    await seedDrizzleKitStub(dir)
    const argvOut = join(dir, 'argv.txt')

    const exitCode = await runCliBin(['make:migration', ...cliArgs], dir, {
      env: { GUREN_TEST_ARGV_OUT: argvOut },
    })
    expect(exitCode).toBe(0)

    const recorded = await readFile(argvOut, 'utf8')
    return recorded.split('\n').filter((line) => line.length > 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('make:migration name argument', () => {
  // The whole argv, not a `toContain`: containment passes just as happily on
  // `--name=add_smoke_probe --name=wrong`, the shape a repeated flag produced.
  const NAMED_ARGV = ['generate', '--name=add_smoke_probe', '--config', 'drizzle.config.ts']

  const forms: Array<[string, string[]]> = [
    ['--name <value>', ['--name', 'add smoke probe']],
    ['--name=<value>', ['--name=add smoke probe']],
    ['a bare positional', ['add smoke probe']],
    // Last-wins. Unnormalized, citty hands back a `string[]` here and
    // `makeMigration()` dies on `options.name?.trim is not a function`.
    ['a repeated --name', ['--name', 'ignored', '--name', 'add smoke probe']],
  ]

  for (const [label, cliArgs] of forms) {
    it(`passes the name to drizzle-kit when given as ${label}`, async () => {
      const argv = await drizzleKitArgvFor(cliArgs)

      expect(argv).toEqual(NAMED_ARGV)
    })
  }

  // `--schema` and `--out` take the same citty array, and failed more quietly:
  // comma-joined into a single path and handed over with a 0 exit code.
  it('takes the last value of a repeated --schema or --out', async () => {
    const argv = await drizzleKitArgvFor([
      '--schema',
      'a/schema.ts',
      '--schema',
      'b/schema.ts',
      '--out',
      'a/migrations',
      '--out',
      'b/migrations',
    ])

    // `--dialect` joins them: the overrides drop `--config`, so the dialect the
    // config declares has to be restated on the line.
    expect(argv).toEqual([
      'generate',
      '--dialect',
      'sqlite',
      '--schema',
      'b/schema.ts',
      '--out',
      'b/migrations',
    ])
  })

  // A bare `--name` was inert while the argument was a positional. It reaches
  // `makeMigration()` now, so pin the fallback to drizzle-kit's own naming.
  for (const [label, cliArgs] of [
    ['no name is given', [] as string[]],
    ['`--name` is given no value', ['--name']],
  ] as const) {
    it(`leaves drizzle-kit to name the migration when ${label}`, async () => {
      const argv = await drizzleKitArgvFor([...cliArgs])

      expect(argv.some((arg) => arg.startsWith('--name'))).toBe(false)
    })
  }
})
