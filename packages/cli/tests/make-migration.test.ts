import { describe, expect, it, mock } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTempWorkspace } from './helpers'
import * as realUtils from '../src/utils'

const spawnCalls: Array<{ command: string; args: string[] }> = []

/**
 * What the faked `drizzle-kit generate` writes for the next call, or undefined
 * for the run that finds no schema changes. Without this the mock would create
 * nothing on every path, so a test asserting "nothing was generated" would pass
 * against a `makeMigration` that never looks at the folder at all.
 */
let nextGeneratedMigration: { folder: string; name: string } | undefined

// Mock `./utils`'s `runCommand` rather than `node:child_process` directly:
// `mock.module()` replaces a module in the process-wide registry for the
// rest of the test run (no per-file scoping), so mocking the shared
// built-in `node:child_process` would also poison unrelated tests that
// shell out for real (e.g. changed-files.test.ts calling real git). Mocking
// this package's own `./utils` module instead keeps the fake scoped to a
// file no other test touches. Spread the real module so anything besides
// `runCommand` (e.g. `writeFileSafe`) keeps its real behavior.
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

/** Queues one generated migration for the next `makeMigration()` call. */
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
    } finally {
      await workspace.cleanup()
    }
  })

  it('names the migration drizzle-kit generated', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-migration-created-')
    try {
      const root = process.cwd()
      generateOnNextRun(join(root, 'db/migrations'), '0000_add_users')

      const result = await makeMigration({ out: 'db/migrations' })

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
      const result = await makeMigration({ out: 'db/migrations' })

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

      const result = await makeMigration({ out: 'db/migrations' })

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

  it('watches the default folder when only --schema is overridden', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-migration-schema-only-')
    try {
      // A --schema override alone stops the config being passed to drizzle-kit,
      // so `out` falls to the default and the config's own out is not what gets
      // written to.
      await writeFile(
        join(workspace.dir, 'drizzle.config.ts'),
        "export default { out: './custom/migrations' }",
        'utf8',
      )
      generateOnNextRun(join(process.cwd(), 'db/migrations'), '0000_add_users')

      const result = await makeMigration({ schema: 'db/other-schema.ts' })

      expect(result.migrationsFolder).toBe(join(process.cwd(), 'db/migrations'))
      expect(result.created).toEqual(['0000_add_users'])
      expect(result.schemaPath).toBe('db/other-schema.ts')
      const call = spawnCalls.pop()
      expect(call?.args?.includes('--config')).toBe(false)
      expect(call?.args).toContain('db/migrations')
    } finally {
      await workspace.cleanup()
    }
  })

  it('reports nothing when the config declares no out directory', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-migration-no-out-')
    try {
      // drizzle-kit falls back to its own default here, which this reader has no
      // way to know. Naming a folder we did not watch would be worse than the
      // plain success message, so the folder stays unset.
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
      // Reading the config is a reporting nicety over a command that already
      // ran, so a config this reader chokes on must not turn into a thrown
      // `db:make`. drizzle-kit loads configs with its own bundler, so the two
      // do not always agree on what is loadable — this pins that the
      // disagreement costs a message, never the command.
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
