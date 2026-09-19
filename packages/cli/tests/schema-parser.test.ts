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
  // dialect's column builders, so one schema can legally mix them.
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

  it('reads a column map written behind a transparent wrapper', async () => {
    const workspace = await createTempWorkspace('guren-cli-schema-wrapped-')
    try {
      await mkdir(join(workspace.dir, 'db'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'db/schema.ts'),
        `import { pgTable, serial, timestamp } from 'drizzle-orm/pg-core'

export const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  createdAt: timestamp('created_at', { withTimezone: false } as const),
} satisfies Record<string, unknown>)
`,
        'utf8',
      )

      const tables = await parseSchemaTables(workspace.dir)

      // A wrapped column map must not hide the whole table.
      expect(tables.map((t) => t.identifier)).toEqual(['posts'])
    } finally {
      await workspace.cleanup()
    }
  })

  it('reads column options written behind a transparent wrapper', async () => {
    const workspace = await createTempWorkspace('guren-cli-schema-wrapped-options-')
    try {
      await mkdir(join(workspace.dir, 'db'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'db/schema.ts'),
        `import { pgTable, timestamp } from 'drizzle-orm/pg-core'

export const posts = pgTable('posts', {
  createdAt: timestamp('created_at', { withTimezone: false } as const),
})
`,
        'utf8',
      )

      const [posts] = await parseSchemaTables(workspace.dir)
      const createdAt = posts.columns.find((c) => c.name === 'createdAt')!

      // Wrapped options must not read as opaque: a written `false` would look
      // like an unknown and the timestamptz check would skip the column.
      expect(createdAt.opaqueOptions).toBeUndefined()
      expect(createdAt.withTimezone).toBe(false)
    } finally {
      await workspace.cleanup()
    }
  })

  it('reads a table and column name written behind a transparent wrapper', async () => {
    const workspace = await createTempWorkspace('guren-cli-schema-wrapped-names-')
    try {
      await mkdir(join(workspace.dir, 'db'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'db/schema.ts'),
        `import { pgTable, timestamp } from 'drizzle-orm/pg-core'

export const posts = pgTable('blog_posts' as const, {
  createdAt: timestamp('created_at' as const),
})
`,
        'utf8',
      )

      const [posts] = await parseSchemaTables(workspace.dir)

      // A lost name is not a lost column: the timestamptz warning names the
      // property, suggests the name-less builder form, and drops the SQL hint.
      expect(posts.tableName).toBe('blog_posts')
      expect(posts.columns.find((c) => c.name === 'createdAt')?.columnName).toBe('created_at')
    } finally {
      await workspace.cleanup()
    }
  })

  it('treats an options object carrying a spread as unreadable, wrapped or not', async () => {
    const workspace = await createTempWorkspace('guren-cli-schema-spread-')
    try {
      await mkdir(join(workspace.dir, 'db'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'db/schema.ts'),
        `import { pgTable, timestamp } from 'drizzle-orm/pg-core'

const SHARED = { withTimezone: true }

export const posts = pgTable('posts', {
  spread: timestamp('spread', { ...SHARED }),
  wrappedSpread: timestamp('wrapped_spread', { ...SHARED } as const),
  absent: timestamp('absent'),
})
`,
        'utf8',
      )

      const [posts] = await parseSchemaTables(workspace.dir)
      const columns = new Map(posts.columns.map((c) => [c.name, c]))

      // The spread may carry `withTimezone`, so its absence proves nothing —
      // concluding "unset" here warns about a column the runtime got right.
      expect(columns.get('spread')?.opaqueOptions).toBe(true)
      expect(columns.get('wrappedSpread')?.opaqueOptions).toBe(true)
      // Control: a genuinely option-less builder stays readable and warnable.
      expect(columns.get('absent')?.opaqueOptions).toBeUndefined()
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

async function parseSchema(source: string) {
  const workspace = await createTempWorkspace('guren-cli-schema-readers-')
  try {
    await mkdir(join(workspace.dir, 'db'), { recursive: true })
    await writeFile(join(workspace.dir, 'db/schema.ts'), source, 'utf8')
    return await parseSchemaTables(workspace.dir)
  } finally {
    await workspace.cleanup()
  }
}

describe('parseSchemaTables column defaults and uniqueness', () => {
  it('should report each default form as written, without evaluating it', async () => {
    const [table] = await parseSchema(`import { sql } from 'drizzle-orm'
import { pgTable, text, integer, timestamp, uuid, boolean } from 'drizzle-orm/pg-core'

export const posts = pgTable('posts', {
  id: uuid('id').defaultRandom().primaryKey(),
  status: text('status').notNull().default('draft'),
  views: integer('views').default(1 + 2),
  published: boolean('published').default(false as const),
  slug: text('slug').default(sql\`gen_slug()\`),
  typed: text('typed').default(sql<string>\`now()::text\`),
  createdAt: timestamp('created_at').defaultNow(),
  token: text('token').$defaultFn(() => crypto.randomUUID()),
  legacy: text('legacy').$default(makeLegacy),
  both: text('both').$defaultFn(() => 'runtime').default('database'),
  title: text('title'),
})
`)
    const defaults = Object.fromEntries(table.columns.map((column) => [column.name, column.default]))

    expect(defaults).toEqual({
      id: { kind: 'random' },
      status: { kind: 'value', text: "'draft'" },
      views: { kind: 'value', text: '1 + 2' },
      published: { kind: 'value', text: 'false as const' },
      slug: { kind: 'sql', text: 'sql`gen_slug()`' },
      typed: { kind: 'sql', text: 'sql<string>`now()::text`' },
      createdAt: { kind: 'now' },
      token: { kind: 'runtime', text: '() => crypto.randomUUID()' },
      legacy: { kind: 'runtime', text: 'makeLegacy' },
      both: { kind: 'value', text: "'database'" },
      title: undefined,
    })
    expect('default' in table.columns.find((column) => column.name === 'title')!).toBe(false)
  })

  it('should read .unique() on the column and leave the others false', async () => {
    const [table] = await parseSchema(`import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const users = sqliteTable('users', {
  email: text('email').notNull().unique(),
  handle: text('handle').unique('users_handle_key'),
  name: text('name'),
})
`)
    expect(table.columns.map((column) => [column.name, column.unique])).toEqual([
      ['email', true],
      ['handle', true],
      ['name', false],
    ])
    expect(table.columns.every((column) => column.opaqueBuilder === undefined)).toBe(true)
  })

  it('should read a chain through a type assertion and a namespace import', async () => {
    const [table] = await parseSchema(`import * as p from 'drizzle-orm/pg-core'

export const users = p.pgTable('users', {
  email: (p.text('email').unique() as any).default('x'),
  name: p.text('name').notNull() satisfies unknown,
})
`)
    const email = table.columns.find((column) => column.name === 'email')!
    expect(email.unique).toBe(true)
    expect(email.default).toEqual({ kind: 'value', text: "'x'" })
    expect(email.opaqueBuilder).toBeUndefined()

    const name = table.columns.find((column) => column.name === 'name')!
    expect(name.notNull).toBe(true)
    expect(name.opaqueBuilder).toBeUndefined()
  })

  it('should mark a column not visible when its chain does not start at a drizzle builder', async () => {
    const [table] = await parseSchema(`import { pgTable, text } from 'drizzle-orm/pg-core'
import { idColumn, slugColumn, shared } from './columns'

export const posts = pgTable('posts', {
  id: idColumn(),
  slug: slugColumn.notNull(),
  owner: shared.owner,
  kind: process.env.KIND ? text('kind') : text('kind').unique(),
  title: text('title').unique(),
})
`)
    const byName = Object.fromEntries(table.columns.map((column) => [column.name, column]))

    expect(byName.id.opaqueBuilder).toBe(true)
    expect(byName.slug.opaqueBuilder).toBe(true)
    expect(byName.slug.notNull).toBe(true)
    expect(byName.owner.opaqueBuilder).toBe(true)
    expect(byName.kind.opaqueBuilder).toBe(true)
    expect(byName.title.opaqueBuilder).toBeUndefined()
    expect(table.opaqueColumns).toBeUndefined()
  })

  it('should mark the column set not visible when it carries a spread or a computed key', async () => {
    const tables = await parseSchema(`import { pgTable, text } from 'drizzle-orm/pg-core'
import { timestamps, KEY } from './columns'

export const spread = pgTable('spread', { title: text('title'), ...timestamps })
export const computed = pgTable('computed', { [KEY]: text('k') })
export const plain = pgTable('plain', { title: text('title') })
`)
    expect(tables.map((table) => [table.identifier, table.opaqueColumns])).toEqual([
      ['spread', true],
      ['computed', true],
      ['plain', undefined],
    ])
  })
})

describe('parseSchemaTables table constraints', () => {
  const ARRAY_FORM = (factory: string, module: string) => `import { ${factory}, text, integer, index, uniqueIndex, unique, primaryKey, foreignKey, check } from 'drizzle-orm/${module}'
import { sql } from 'drizzle-orm'
import { users } from './users'

export const memberships = ${factory}('memberships', {
  userId: integer('user_id').notNull(),
  teamId: integer('team_id').notNull(),
  role: text('role'),
  email: text('email'),
  parentUserId: integer('parent_user_id'),
  parentTeamId: integer('parent_team_id'),
}, (table) => [
  primaryKey({ columns: [table.userId, table.teamId], name: 'memberships_pk' }),
  index('memberships_role_idx').on(table.role),
  uniqueIndex('memberships_email_idx').on(table.email, table.teamId.desc()),
  unique().on(table.role, table['email']),
  foreignKey({ columns: [table.userId], foreignColumns: [users.id], name: 'memberships_user_fk' }).onDelete('cascade'),
  foreignKey({ columns: [table.parentUserId, table.parentTeamId], foreignColumns: [table.userId, table.teamId] }),
  check('role_check', sql\`\${table.role} <> ''\`),
])
`

  const EXPECTED = [
    { kind: 'primaryKey', name: 'memberships_pk', columns: ['userId', 'teamId'] },
    { kind: 'index', name: 'memberships_role_idx', columns: ['role'] },
    { kind: 'uniqueIndex', name: 'memberships_email_idx', columns: ['email', 'teamId'] },
    { kind: 'unique', columns: ['role', 'email'] },
    { kind: 'foreignKey', name: 'memberships_user_fk', columns: ['userId'], references: { table: 'users', columns: ['id'] } },
    {
      kind: 'foreignKey',
      columns: ['parentUserId', 'parentTeamId'],
      references: { table: 'memberships', columns: ['userId', 'teamId'] },
    },
    { kind: 'check', name: 'role_check', columns: [] },
  ]

  for (const [factory, module] of [['pgTable', 'pg-core'], ['sqliteTable', 'sqlite-core'], ['mysqlTable', 'mysql-core']]) {
    it(`should read the array form of ${factory}'s extra config`, async () => {
      const [table] = await parseSchema(ARRAY_FORM(factory, module))

      expect(table.constraints).toEqual(EXPECTED)
      expect(table.opaqueConstraints).toBeUndefined()
    })
  }

  for (const [factory, module] of [['pgTable', 'pg-core'], ['sqliteTable', 'sqlite-core'], ['mysqlTable', 'mysql-core']]) {
    it(`should read the object form of ${factory}'s extra config`, async () => {
      const [table] = await parseSchema(`import { ${factory}, text, index, uniqueIndex, primaryKey } from 'drizzle-orm/${module}'

export const tags = ${factory}('tags', {
  name: text('name'),
  scope: text('scope'),
}, ({ name, scope: tagScope }) => {
  return {
    pk: primaryKey(name, tagScope),
    nameIdx: index('tags_name_idx').on(name),
    scopeIdx: uniqueIndex('tags_scope_idx').on(tagScope, name),
  } as const
})
`)
      expect(table.constraints).toEqual([
        { kind: 'primaryKey', columns: ['name', 'scope'] },
        { kind: 'index', name: 'tags_name_idx', columns: ['name'] },
        { kind: 'uniqueIndex', name: 'tags_scope_idx', columns: ['scope', 'name'] },
      ])
      expect(table.opaqueConstraints).toBeUndefined()
    })
  }

  it('should report no constraints, and nothing hidden, for a table without an extra config', async () => {
    const [table] = await parseSchema(`import { pgTable, text } from 'drizzle-orm/pg-core'

export const tags = pgTable('tags', { name: text('name') })
`)
    expect(table.constraints).toEqual([])
    expect(table.opaqueConstraints).toBeUndefined()
  })

  it('should read aliased and namespaced constraint builders and Postgres .using()', async () => {
    const [table] = await parseSchema(`import * as p from 'drizzle-orm/pg-core'
import { index as idx } from 'drizzle-orm/pg-core'

export const docs = p.pgTable('docs', {
  body: p.text('body'),
  title: p.text('title'),
}, (t) => [
  idx('docs_body_idx').using('gin', t.body),
  p.unique('docs_title_key').on(t.title).nullsNotDistinct(),
])
`)
    expect(table.constraints).toEqual([
      { kind: 'index', name: 'docs_body_idx', columns: ['body'] },
      { kind: 'unique', name: 'docs_title_key', columns: ['title'] },
    ])
    expect(table.opaqueConstraints).toBeUndefined()
  })

  it('should mark the extra config not visible when it is not a callback returning a literal', async () => {
    const tables = await parseSchema(`import { pgTable, text, index } from 'drizzle-orm/pg-core'
import { sharedIndexes, buildIndexes } from './indexes'

export const byIdentifier = pgTable('a', { name: text('name') }, sharedIndexes)
export const byHelper = pgTable('b', { name: text('name') }, (table) => buildIndexes(table))
export const byCondition = pgTable('c', { name: text('name') }, (table) => (process.env.X ? [] : [index('i').on(table.name)]))
`)
    expect(tables.map((table) => [table.identifier, table.constraints, table.opaqueConstraints])).toEqual([
      ['byIdentifier', [], true],
      ['byHelper', [], true],
      ['byCondition', [], true],
    ])
  })

  it('should keep the readable entries and mark the rest not visible', async () => {
    const tables = await parseSchema(`import { pgTable, text, index } from 'drizzle-orm/pg-core'
import { sharedIndexes, auditIndex, index as localIndex } from './indexes'

export const spreadArray = pgTable('a', { name: text('name') }, (table) => [index('a_idx').on(table.name), ...sharedIndexes(table)])
export const helperEntry = pgTable('b', { name: text('name') }, (table) => [auditIndex(table), index('b_idx').on(table.name)])
export const spreadObject = pgTable('c', { name: text('name') }, (table) => ({ ...sharedIndexes(table), nameIdx: index('c_idx').on(table.name) }))
export const localBuilder = pgTable('d', { name: text('name') }, (table) => [localIndex('d_idx').on(table.name)])
`)
    expect(tables.map((table) => [table.identifier, table.constraints, table.opaqueConstraints])).toEqual([
      ['spreadArray', [{ kind: 'index', name: 'a_idx', columns: ['name'] }], true],
      ['helperEntry', [{ kind: 'index', name: 'b_idx', columns: ['name'] }], true],
      ['spreadObject', [{ kind: 'index', name: 'c_idx', columns: ['name'] }], true],
      ['localBuilder', [], true],
    ])
  })

  it('should mark a constraint whose columns or name are expressions', async () => {
    const [table] = await parseSchema(`import { sql } from 'drizzle-orm'
import { pgTable, text, integer, index, uniqueIndex, primaryKey, foreignKey } from 'drizzle-orm/pg-core'
import { users, KEY_COLUMNS, PREFIX } from './shared'

export const accounts = pgTable('accounts', {
  email: text('email'),
  ownerId: integer('owner_id'),
}, (table) => [
  uniqueIndex('accounts_email_lower').on(sql\`lower(\${table.email})\`),
  index(\`\${PREFIX}_owner\`).on(table.ownerId),
  index('accounts_pending'),
  primaryKey({ columns: KEY_COLUMNS }),
  foreignKey({ columns: [table.ownerId], foreignColumns: [users.id, other.id] }),
  index('accounts_spread').on(...KEY_COLUMNS),
])
`)
    expect(table.constraints).toEqual([
      { kind: 'uniqueIndex', name: 'accounts_email_lower', columns: [], opaqueColumns: true },
      { kind: 'index', columns: ['ownerId'], opaqueName: true },
      { kind: 'index', name: 'accounts_pending', columns: [], opaqueColumns: true },
      { kind: 'primaryKey', columns: [], opaqueColumns: true },
      { kind: 'foreignKey', columns: ['ownerId'], opaqueColumns: true },
      { kind: 'index', name: 'accounts_spread', columns: [], opaqueColumns: true },
    ])
    expect(table.opaqueConstraints).toBeUndefined()
  })
})
