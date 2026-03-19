import { describe, expect, it, mock } from 'bun:test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTempWorkspace } from './helpers'

const spawnCalls: Array<{ command: string; args: string[] }> = []

await mock.module('node:child_process', () => ({
  spawn: (command: string, args: string[]) => {
    spawnCalls.push({ command, args })
    return {
      on: (event: string, handler: (value?: number) => void) => {
        if (event === 'close') {
          handler(0)
        }
      },
    }
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
