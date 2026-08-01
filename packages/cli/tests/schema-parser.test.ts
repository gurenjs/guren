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

  it('recognizes aliased and namespace-qualified table factories', async () => {
    const workspace = await createTempWorkspace('guren-cli-schema-alias-')
    try {
      await mkdir(join(workspace.dir, 'db'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'db/schema.ts'),
        `import { pgTable as table, serial } from 'drizzle-orm/pg-core'
import * as p from 'drizzle-orm/pg-core'

export const users = table('users', { id: serial('id') })
export const posts = p.pgTable('posts', { id: serial('id') })
`,
        'utf8',
      )

      const tables = await parseSchemaTables(workspace.dir)

      expect(tables.map((t) => t.identifier).sort()).toEqual(['posts', 'users'])
      // Both forms have to resolve the dialect too, not just the table.
      expect(tables.map((t) => t.dialect)).toEqual(['pg', 'pg'])
    } finally {
      await workspace.cleanup()
    }
  })

  // Per-table rather than per-file: drizzle's table builders accept a foreign
  // dialect's column builders, so one schema can legally mix them and a
  // dialect-gated consumer has to judge a table at a time.
  it('records each table\'s dialect separately in a mixed schema', async () => {
    const workspace = await createTempWorkspace('guren-cli-schema-dialect-')
    try {
      await mkdir(join(workspace.dir, 'db'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'db/schema.ts'),
        `import { pgTable, serial, timestamp } from 'drizzle-orm/pg-core'
import { sqliteTable, integer } from 'drizzle-orm/sqlite-core'
import { mysqlTable, int, timestamp as mysqlTimestamp } from 'drizzle-orm/mysql-core'

export const posts = pgTable('posts', {
  id: serial('id'),
  createdAt: timestamp('created_at'),
})
export const notes = sqliteTable('notes', {
  id: integer('id'),
  createdAt: integer('created_at', { mode: 'timestamp' }),
})
export const logs = mysqlTable('logs', {
  id: int('id'),
  createdAt: mysqlTimestamp('created_at'),
})
`,
        'utf8',
      )

      const tables = await parseSchemaTables(workspace.dir)
      const dialects = new Map(tables.map((t) => [t.identifier, t.dialect]))

      expect(dialects.get('posts')).toBe('pg')
      expect(dialects.get('notes')).toBe('sqlite')
      expect(dialects.get('logs')).toBe('mysql')
    } finally {
      await workspace.cleanup()
    }
  })

  it('records withTimezone as written and the database column name', async () => {
    const workspace = await createTempWorkspace('guren-cli-schema-timezone-')
    try {
      await mkdir(join(workspace.dir, 'db'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'db/schema.ts'),
        `import { pgTable, timestamp } from 'drizzle-orm/pg-core'

export const posts = pgTable('posts', {
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: false }),
  publishedAt: timestamp('published_at'),
  reviewedAt: timestamp('reviewed_at', { mode: 'string' }),
  slots: timestamp('slots', { withTimezone: true }).array(),
  deletedAt: timestamp({ withTimezone: true }),
})
`,
        'utf8',
      )

      const [posts] = await parseSchemaTables(workspace.dir)
      const columns = new Map(posts.columns.map((c) => [c.name, c]))

      // Read off the innermost builder, so a chain and .array() don't hide it.
      expect(columns.get('createdAt')?.withTimezone).toBe(true)
      expect(columns.get('slots')?.type).toBe('timestamp[]')
      expect(columns.get('slots')?.withTimezone).toBe(true)

      // `false` and "omitted" are distinct facts, however a consumer treats them.
      expect(columns.get('updatedAt')?.withTimezone).toBe(false)
      expect(columns.get('publishedAt')?.withTimezone).toBeUndefined()
      expect(columns.get('reviewedAt')?.withTimezone).toBeUndefined()

      expect(columns.get('createdAt')?.columnName).toBe('created_at')
      // Name-less builder form: the name is derived, but options still parse.
      expect(columns.get('deletedAt')?.columnName).toBeUndefined()
      expect(columns.get('deletedAt')?.withTimezone).toBe(true)
    } finally {
      await workspace.cleanup()
    }
  })

  it('separates "option not set" from "options not readable"', async () => {
    const workspace = await createTempWorkspace('guren-cli-schema-opaque-')
    try {
      await mkdir(join(workspace.dir, 'db'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'db/schema.ts'),
        `import { pgTable, timestamp } from 'drizzle-orm/pg-core'

const INSTANT = { withTimezone: true } as const

export const posts = pgTable('posts', {
  plain: timestamp('plain'),
  viaConstant: timestamp('via_constant', INSTANT),
  viaAssertion: timestamp('via_assertion', { withTimezone: true as const }),
})
`,
        'utf8',
      )

      const [posts] = await parseSchemaTables(workspace.dir)
      const columns = new Map(posts.columns.map((c) => [c.name, c]))

      // Inline options, option genuinely absent — a consumer may conclude "unset".
      expect(columns.get('plain')?.withTimezone).toBeUndefined()
      expect(columns.get('plain')?.opaqueOptions).toBeUndefined()

      // Options behind an identifier — nothing is readable, so the absent
      // `withTimezone` proves nothing and the column says so.
      expect(columns.get('viaConstant')?.withTimezone).toBeUndefined()
      expect(columns.get('viaConstant')?.opaqueOptions).toBe(true)

      // `as const` is unwrapped: this is a plain `true`, not an unknown.
      expect(columns.get('viaAssertion')?.withTimezone).toBe(true)
      expect(columns.get('viaAssertion')?.opaqueOptions).toBeUndefined()
    } finally {
      await workspace.cleanup()
    }
  })

  it('ignores a computed option key rather than reading the identifier as its name', async () => {
    const workspace = await createTempWorkspace('guren-cli-schema-computed-key-')
    try {
      await mkdir(join(workspace.dir, 'db'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'db/schema.ts'),
        `import { pgTable, timestamp } from 'drizzle-orm/pg-core'

declare const withTimezone: string

export const posts = pgTable('posts', {
  createdAt: timestamp('created_at', { [withTimezone]: true }),
})
`,
        'utf8',
      )

      const [posts] = await parseSchemaTables(workspace.dir)

      expect(posts.columns[0].withTimezone).toBeUndefined()
    } finally {
      await workspace.cleanup()
    }
  })

  it('extracts references from block-bodied arrows and function expressions', async () => {
    const workspace = await createTempWorkspace('guren-cli-schema-refs-')
    try {
      await mkdir(join(workspace.dir, 'db'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'db/schema.ts'),
        `import { pgTable, serial, integer, text } from 'drizzle-orm/pg-core'

export const users = pgTable('users', { id: serial('id') })

export const posts = pgTable('posts', {
  id: serial('id'),
  authorId: integer('author_id').references(() => { return users.id }),
  editorId: integer('editor_id').references(function () { return users.id }),
  tags: text('tags').array(),
})
`,
        'utf8',
      )

      const tables = await parseSchemaTables(workspace.dir)
      const posts = tables.find((t) => t.identifier === 'posts')!

      expect(posts.columns.find((c) => c.name === 'authorId')?.references).toEqual({
        table: 'users',
        column: 'id',
      })
      expect(posts.columns.find((c) => c.name === 'editorId')?.references).toEqual({
        table: 'users',
        column: 'id',
      })
      expect(posts.columns.find((c) => c.name === 'tags')?.type).toBe('text[]')
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
