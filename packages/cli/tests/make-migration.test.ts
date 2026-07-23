import { describe, expect, it, mock } from 'bun:test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTempWorkspace } from './helpers'
import * as realUtils from '../src/utils'

const spawnCalls: Array<{ command: string; args: string[] }> = []

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
  },
}))

const { makeMigration } = await import('../src/make-migration')

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
})
