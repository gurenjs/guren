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

describe('runCheck — Attachable models without configureAttachments', () => {
  const ATTACHABLE_MODEL = `import { Attachable, hasOneAttached } from '@guren/core'
import { defineModel } from '@guren/orm'
import { posts } from '../../db/schema.js'

export class Post extends Attachable(defineModel(posts), {
  cover: hasOneAttached(),
}) {}
`

  const CONFIG = `import { configureAttachments } from '@guren/core'
import { posts } from '../db/schema.js'

export const { Attachment } = configureAttachments({
  table: posts,
  storage: () => ({}) as never,
  disk: 'media',
})`

  async function writeModel(dir: string, relPath = 'app/Models/Post.ts', source = ATTACHABLE_MODEL): Promise<void> {
    await mkdir(join(dir, relPath, '..'), { recursive: true })
    await writeFile(join(dir, relPath), source, 'utf8')
  }

  it('fails an Attachable model when no configureAttachments() call exists', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-attachable-missing-')
    try {
      await writeModel(workspace.dir)

      const report = await runCheck({ cwd: workspace.dir })

      const result = report.checks.find((c) => c.key.startsWith('attachments-model:'))
      expect(result).toBeDefined()
      expect(result!.status).toBe('fail')
      expect(result!.message).toContain('Post')
      expect(result!.suggestion).toContain('guren add attachments')
    } finally {
      await workspace.cleanup()
    }
  })

  it('passes an Attachable model when a configureAttachments() call exists', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-attachable-configured-')
    try {
      await writeModel(workspace.dir)
      await mkdir(join(workspace.dir, 'config'), { recursive: true })
      await writeFile(join(workspace.dir, 'config/attachments.ts'), CONFIG, 'utf8')

      const report = await runCheck({ cwd: workspace.dir })

      const result = report.checks.find((c) => c.key.startsWith('attachments-model:'))
      expect(result).toBeDefined()
      expect(result!.status).toBe('pass')
    } finally {
      await workspace.cleanup()
    }
  })

  it('sees a configureAttachments call made through a namespace import', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-attachable-namespace-')
    try {
      await writeModel(workspace.dir)
      await mkdir(join(workspace.dir, 'config'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'config/attachments.ts'),
        `import * as core from '@guren/core'
import { posts } from '../db/schema.js'

export const { Attachment } = core.configureAttachments({
  table: posts,
  storage: () => ({}) as never,
  disk: 'media',
})`,
        'utf8',
      )

      const report = await runCheck({ cwd: workspace.dir })

      const result = report.checks.find((c) => c.key.startsWith('attachments-model:'))
      expect(result).toBeDefined()
      expect(result!.status).toBe('pass')
    } finally {
      await workspace.cleanup()
    }
  })

  it('does not treat a mention of configureAttachments in a comment as a config', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-attachable-comment-')
    try {
      await writeModel(workspace.dir)
      await mkdir(join(workspace.dir, 'config'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'config/notes.ts'),
        '// TODO: call configureAttachments() here\nexport const notes = true\n',
        'utf8',
      )

      const report = await runCheck({ cwd: workspace.dir })

      const result = report.checks.find((c) => c.key.startsWith('attachments-model:'))
      expect(result).toBeDefined()
      expect(result!.status).toBe('fail')
    } finally {
      await workspace.cleanup()
    }
  })

  it('contributes nothing to apps without Attachable models', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-attachable-none-')
    try {
      await writeModel(
        workspace.dir,
        'app/Models/Post.ts',
        `import { defineModel } from '@guren/orm'
import { posts } from '../../db/schema.js'

export class Post extends defineModel(posts) {}
`,
      )

      const report = await runCheck({ cwd: workspace.dir })

      expect(report.checks.find((c) => c.key.startsWith('attachments-model:'))).toBeUndefined()
    } finally {
      await workspace.cleanup()
    }
  })

  it('sees an Attachable model inside a module', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-attachable-module-')
    try {
      await writeModel(workspace.dir, 'modules/media/app/Models/Clip.ts', `import { Attachable, hasManyAttached } from '@guren/core'
import { defineModel } from '@guren/orm'
import { clips } from '../../db/schema.js'

export class Clip extends Attachable(defineModel(clips), {
  stills: hasManyAttached(),
}) {}
`)

      const report = await runCheck({ cwd: workspace.dir })

      const result = report.checks.find((c) => c.key.startsWith('attachments-model:'))
      expect(result).toBeDefined()
      expect(result!.status).toBe('fail')
      expect(result!.message).toContain('Clip')
    } finally {
      await workspace.cleanup()
    }
  })
})
