import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { runCheck } from '../src/check'
import { createTempWorkspace } from './helpers'

describe('runCheck — configureAttachments table binding', () => {
  const SCHEMA_WITH_ATTACHMENTS = `import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
export const attachments = sqliteTable('attachments', {
  id: text('id').primaryKey(),
  path: text('path').notNull(),
})`

  const SCHEMA_WITHOUT_ATTACHMENTS = `import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
export const posts = sqliteTable('posts', {
  id: integer('id').primaryKey(),
})`

  function configSource(tableName = 'attachments'): string {
    return `import { configureAttachments } from '@guren/core'
import { ${tableName} } from '../db/schema.js'

export const { Attachment } = configureAttachments({
  table: ${tableName},
  storage: () => ({}) as never,
  disk: 'media',
})`
  }

  async function writeApp(dir: string, options: { schema: string; config?: string }): Promise<void> {
    await mkdir(join(dir, 'db'), { recursive: true })
    await writeFile(join(dir, 'db/schema.ts'), options.schema, 'utf8')
    if (options.config) {
      await mkdir(join(dir, 'config'), { recursive: true })
      await writeFile(join(dir, 'config/attachments.ts'), options.config, 'utf8')
    }
  }

  it('passes when the bound table is declared in db/schema.ts', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-attachments-pass-')
    try {
      await writeApp(workspace.dir, { schema: SCHEMA_WITH_ATTACHMENTS, config: configSource() })

      const report = await runCheck({ cwd: workspace.dir })

      const result = report.checks.find((c) => c.key.startsWith('attachments-config:'))
      expect(result).toBeDefined()
      expect(result!.status).toBe('pass')
    } finally {
      await workspace.cleanup()
    }
  })

  it('fails when the bound table is missing from db/schema.ts', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-attachments-fail-')
    try {
      await writeApp(workspace.dir, { schema: SCHEMA_WITHOUT_ATTACHMENTS, config: configSource() })

      const report = await runCheck({ cwd: workspace.dir })

      const result = report.checks.find((c) => c.key.startsWith('attachments-config:'))
      expect(result).toBeDefined()
      expect(result!.status).toBe('fail')
      expect(result!.message).toContain("'attachments'")
      expect(result!.suggestion).toContain('db/schema.ts')
    } finally {
      await workspace.cleanup()
    }
  })

  it('judges an aliased import by its exported name', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-attachments-alias-')
    try {
      const config = `import { configureAttachments } from '@guren/core'
import { attachments as att } from '../db/schema.js'

export const { Attachment } = configureAttachments({
  table: att,
  storage: () => ({}) as never,
  disk: 'media',
})`
      await writeApp(workspace.dir, { schema: SCHEMA_WITH_ATTACHMENTS, config })

      const report = await runCheck({ cwd: workspace.dir })

      const result = report.checks.find((c) => c.key.startsWith('attachments-config:'))
      expect(result).toBeDefined()
      expect(result!.status).toBe('pass')
    } finally {
      await workspace.cleanup()
    }
  })

  it('stays silent when the table cannot be traced to a schema import', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-attachments-opaque-')
    try {
      // Imported from somewhere other than db/schema: existence cannot be
      // judged, and a symbol the check cannot trace is not a missing one.
      const config = `import { configureAttachments } from '@guren/core'
import { attachments } from './tables.js'

export const { Attachment } = configureAttachments({
  table: attachments,
  storage: () => ({}) as never,
  disk: 'media',
})`
      await writeApp(workspace.dir, { schema: SCHEMA_WITHOUT_ATTACHMENTS, config })

      const report = await runCheck({ cwd: workspace.dir })

      expect(report.checks.find((c) => c.key.startsWith('attachments-config:'))).toBeUndefined()
    } finally {
      await workspace.cleanup()
    }
  })

  it('contributes nothing to apps without configureAttachments', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-attachments-absent-')
    try {
      await writeApp(workspace.dir, { schema: SCHEMA_WITHOUT_ATTACHMENTS })

      const report = await runCheck({ cwd: workspace.dir })

      expect(report.checks.find((c) => c.key.startsWith('attachments-config:'))).toBeUndefined()
    } finally {
      await workspace.cleanup()
    }
  })

  it('fails a module config whose own schema lacks the table, even when the root declares it', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-attachments-module-miss-')
    try {
      // Root declares `attachments`, but the module config imports the
      // module's schema — which does not. Existence is per schema module.
      await writeApp(workspace.dir, { schema: SCHEMA_WITH_ATTACHMENTS })
      await mkdir(join(workspace.dir, 'modules/media/db'), { recursive: true })
      await writeFile(join(workspace.dir, 'modules/media/db/schema.ts'), SCHEMA_WITHOUT_ATTACHMENTS, 'utf8')
      await mkdir(join(workspace.dir, 'modules/media/config'), { recursive: true })
      await writeFile(join(workspace.dir, 'modules/media/config/attachments.ts'), configSource(), 'utf8')

      const report = await runCheck({ cwd: workspace.dir })

      const result = report.checks.find((c) => c.key.startsWith('attachments-config:'))
      expect(result).toBeDefined()
      expect(result!.status).toBe('fail')
      expect(result!.suggestion).toContain('modules/media/db/schema.ts')
    } finally {
      await workspace.cleanup()
    }
  })

  it('sees a table exported by a module schema', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-attachments-module-')
    try {
      await writeApp(workspace.dir, { schema: SCHEMA_WITHOUT_ATTACHMENTS })
      await mkdir(join(workspace.dir, 'modules/media/db'), { recursive: true })
      await writeFile(join(workspace.dir, 'modules/media/db/schema.ts'), SCHEMA_WITH_ATTACHMENTS, 'utf8')
      await mkdir(join(workspace.dir, 'modules/media/config'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'modules/media/config/attachments.ts'),
        configSource(),
        'utf8',
      )

      const report = await runCheck({ cwd: workspace.dir })

      const result = report.checks.find((c) => c.key.startsWith('attachments-config:'))
      expect(result).toBeDefined()
      expect(result!.status).toBe('pass')
    } finally {
      await workspace.cleanup()
    }
  })
})
