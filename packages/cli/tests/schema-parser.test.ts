import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { parseSchemaTables, parseSchemaTableColumns } from '../src/schema-parser'
import { createTempWorkspace } from './helpers'

const ROOT_SCHEMA = `import { pgTable, serial, text, integer } from 'drizzle-orm/pg-core'

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: text('email').notNull(),
})

export const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
  authorId: integer('author_id').notNull().references(() => users.id),
  excerpt: text('excerpt'),
})
`

describe('parseSchemaTables', () => {
  it('extracts identifiers, table names, column types, constraints, and references', async () => {
    const workspace = await createTempWorkspace('guren-cli-schema-parser-')
    try {
      await mkdir(join(workspace.dir, 'db'), { recursive: true })
      await writeFile(join(workspace.dir, 'db/schema.ts'), ROOT_SCHEMA, 'utf8')

      const tables = await parseSchemaTables(workspace.dir)

      expect(tables.map((t) => t.identifier)).toEqual(['users', 'posts'])

      const posts = tables.find((t) => t.identifier === 'posts')!
      expect(posts.tableName).toBe('posts')
      expect(posts.module).toBeNull()

      const id = posts.columns.find((c) => c.name === 'id')!
      expect(id.type).toBe('serial')
      expect(id.primaryKey).toBe(true)

      const title = posts.columns.find((c) => c.name === 'title')!
      expect(title.type).toBe('text')
      expect(title.notNull).toBe(true)

      const authorId = posts.columns.find((c) => c.name === 'authorId')!
      expect(authorId.references).toEqual({ table: 'users', column: 'id' })
      expect(authorId.notNull).toBe(true)

      const excerpt = posts.columns.find((c) => c.name === 'excerpt')!
      expect(excerpt.notNull).toBe(false)
      expect(excerpt.references).toBeUndefined()
    } finally {
      await workspace.cleanup()
    }
  })

  it('scans module schemas and tags their tables', async () => {
    const workspace = await createTempWorkspace('guren-cli-schema-modules-')
    try {
      await mkdir(join(workspace.dir, 'modules/billing/db'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'modules/billing/db/schema.ts'),
        `import { pgTable, serial } from 'drizzle-orm/pg-core'
export const invoices = pgTable('invoices', { id: serial('id') })
`,
        'utf8',
      )

      const tables = await parseSchemaTables(workspace.dir)

      expect(tables).toHaveLength(1)
      expect(tables[0].identifier).toBe('invoices')
      expect(tables[0].module).toBe('billing')
    } finally {
      await workspace.cleanup()
    }
  })

  it('tolerates missing and unparsable schema files', async () => {
    const workspace = await createTempWorkspace('guren-cli-schema-missing-')
    try {
      expect(await parseSchemaTables(workspace.dir)).toEqual([])

      await mkdir(join(workspace.dir, 'db'), { recursive: true })
      await writeFile(join(workspace.dir, 'db/schema.ts'), 'not valid typescript {{{', 'utf8')
      expect(await parseSchemaTables(workspace.dir)).toEqual([])
    } finally {
      await workspace.cleanup()
    }
  })
})

describe('parseSchemaTableColumns', () => {
  it('keeps the narrow identifier→column-names view', async () => {
    const workspace = await createTempWorkspace('guren-cli-schema-columns-')
    try {
      await mkdir(join(workspace.dir, 'db'), { recursive: true })
      await writeFile(join(workspace.dir, 'db/schema.ts'), ROOT_SCHEMA, 'utf8')

      const columns = await parseSchemaTableColumns(workspace.dir)

      expect(columns?.get('posts')).toEqual(['id', 'title', 'authorId', 'excerpt'])
      expect(columns?.get('users')).toEqual(['id', 'email'])
    } finally {
      await workspace.cleanup()
    }
  })

  it('returns null when no tables exist', async () => {
    const workspace = await createTempWorkspace('guren-cli-schema-none-')
    try {
      expect(await parseSchemaTableColumns(workspace.dir)).toBeNull()
    } finally {
      await workspace.cleanup()
    }
  })
})
