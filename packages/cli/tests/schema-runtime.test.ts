import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseSchemaTables } from '../src/schema-parser'
import { readSchemaAtRuntime, readSchemaTables, withImportTimeout, type SourcedSchemaTable } from '../src/schema-runtime'
import { writeWorkspaceFiles } from './helpers'

// The copy `@guren/orm` pins. A temp app outside the repo resolves `drizzle-orm` from
// Bun's global cache or not at all, so each fixture links this one explicitly.
const WORKSPACE_DRIZZLE = resolve(import.meta.dir, '../../orm/node_modules/drizzle-orm')
// Its built barrels import `drizzle-orm` from the directory above, the same copy.
const WORKSPACE_ORM = resolve(import.meta.dir, '../../orm')

const created: string[] = []

afterAll(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function createApp(files: Record<string, string>, options: { drizzle?: boolean } = {}): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'guren-schema-runtime-')))
  created.push(dir)
  await writeWorkspaceFiles(dir, files)
  if (options.drizzle !== false) {
    await mkdir(join(dir, 'node_modules'), { recursive: true })
    await symlink(WORKSPACE_DRIZZLE, join(dir, 'node_modules', 'drizzle-orm'), 'dir')
  }
  return dir
}

function tableOf(tables: SourcedSchemaTable[], identifier: string): SourcedSchemaTable {
  const table = tables.find((candidate) => candidate.identifier === identifier)
  if (!table) throw new Error(`no table ${identifier} in [${tables.map((candidate) => candidate.identifier).join(', ')}]`)
  return table
}

function columnOf(table: SourcedSchemaTable, name: string) {
  const column = table.columns.find((candidate) => candidate.name === name)
  if (!column) throw new Error(`no column ${name} in ${table.identifier}`)
  return column
}

const PG_SCHEMA = `import { sql } from 'drizzle-orm'
import {
  check, foreignKey, index, integer, pgTable, primaryKey, serial, text, timestamp, unique, uniqueIndex,
} from 'drizzle-orm/pg-core'

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql\`now()\`),
}

const slugColumn = () => text('slug').notNull().unique()

const auditIndexes = (table: { createdAt: any }) => [index('orgs_created_idx').on(table.createdAt)]

export const orgs = pgTable(
  'orgs',
  {
    id: serial('id').primaryKey(),
    slug: slugColumn(),
    ...timestamps,
  },
  (table) => auditIndexes(table),
)

export const members = pgTable('members', (t) => ({
  orgId: t.integer('org_id').notNull().references(() => orgs.id),
  userId: t.integer('user_id').notNull(),
  role: t.text('role').notNull().default('member'),
  token: t.text('token').$defaultFn(() => crypto.randomUUID()),
}), (table) => [
  primaryKey({ columns: [table.orgId, table.userId] }),
])

export const notes = pgTable(
  'notes',
  {
    id: serial('id').primaryKey(),
    parentId: integer('parent_id'),
    orgId: integer('org_id').notNull(),
    userId: integer('user_id').notNull(),
    title: text('title').notNull(),
    rank: integer('rank').notNull().default(0),
  },
  (table) => [
    foreignKey({ columns: [table.parentId], foreignColumns: [table.id], name: 'notes_parent_fk' }),
    foreignKey({ columns: [table.orgId, table.userId], foreignColumns: [members.orgId, members.userId], name: 'notes_member_fk' }),
    uniqueIndex('notes_title_idx').on(table.orgId, table.title),
    unique('notes_rank_unique').on(table.orgId, table.rank),
    index('notes_lower_title_idx').on(sql\`lower(\${table.title})\`),
    check('notes_rank_check', sql\`\${table.rank} >= 0\`),
  ],
)

export const schema = { orgs, members, notes }
export const NOTE_LIMIT = 10
`

const SQLITE_SCHEMA = `import { sql } from 'drizzle-orm'
import { check, foreignKey, index, integer, primaryKey, sqliteTable, text, unique, uniqueIndex } from 'drizzle-orm/sqlite-core'

const timestamps = {
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql\`(unixepoch())\`),
}
const slugColumn = () => text('slug').notNull().unique()
const extras = (table: { slug: any }) => [index('orgs_slug_idx').on(table.slug)]

export const orgs = sqliteTable('orgs', { id: integer('id').primaryKey(), slug: slugColumn(), ...timestamps }, (table) => extras(table))

export const members = sqliteTable('members', (t) => ({
  orgId: t.integer('org_id').notNull().references(() => orgs.id),
  userId: t.integer('user_id').notNull(),
  role: t.text('role').notNull().default('member'),
  token: t.text('token').$defaultFn(() => crypto.randomUUID()),
}), (table) => [primaryKey({ columns: [table.orgId, table.userId] })])

export const notes = sqliteTable('notes', {
  id: integer('id').primaryKey(),
  parentId: integer('parent_id'),
  orgId: integer('org_id').notNull(),
  userId: integer('user_id').notNull(),
  rank: integer('rank').notNull().default(0),
}, (table) => [
  foreignKey({ columns: [table.parentId], foreignColumns: [table.id], name: 'notes_parent_fk' }),
  foreignKey({ columns: [table.orgId, table.userId], foreignColumns: [members.orgId, members.userId], name: 'notes_member_fk' }),
  uniqueIndex('notes_rank_idx').on(table.orgId, table.rank),
  unique('notes_user_unique').on(table.userId, table.rank),
  check('notes_rank_check', sql\`\${table.rank} >= 0\`),
])
`

const MYSQL_SCHEMA = `import { sql } from 'drizzle-orm'
import { check, foreignKey, index, int, mysqlTable, primaryKey, timestamp, unique, uniqueIndex, varchar } from 'drizzle-orm/mysql-core'

const timestamps = {
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').default(sql\`CURRENT_TIMESTAMP\`),
}
const slugColumn = () => varchar('slug', { length: 64 }).notNull().unique()
const extras = (table: { slug: any }) => [index('orgs_slug_idx').on(table.slug)]

export const orgs = mysqlTable('orgs', { id: int('id').primaryKey().autoincrement(), slug: slugColumn(), ...timestamps }, (table) => extras(table))

export const members = mysqlTable('members', (t) => ({
  orgId: t.int('org_id').notNull().references(() => orgs.id),
  userId: t.int('user_id').notNull(),
  role: t.varchar('role', { length: 32 }).notNull().default('member'),
  token: t.varchar('token', { length: 64 }).$defaultFn(() => crypto.randomUUID()),
}), (table) => [primaryKey({ columns: [table.orgId, table.userId] })])

export const notes = mysqlTable('notes', {
  id: int('id').primaryKey().autoincrement(),
  parentId: int('parent_id'),
  orgId: int('org_id').notNull(),
  userId: int('user_id').notNull(),
  rank: int('rank').notNull().default(0),
}, (table) => [
  foreignKey({ columns: [table.parentId], foreignColumns: [table.id], name: 'notes_parent_fk' }),
  foreignKey({ columns: [table.orgId, table.userId], foreignColumns: [members.orgId, members.userId], name: 'notes_member_fk' }),
  uniqueIndex('notes_rank_idx').on(table.orgId, table.rank),
  unique('notes_user_unique').on(table.userId, table.rank),
  check('notes_rank_check', sql\`\${table.rank} >= 0\`),
])
`

describe('readSchemaTables', () => {
  describe('pg shapes the static reader marks opaque', () => {
    let app: string
    let tables: SourcedSchemaTable[]

    beforeAll(async () => {
      app = await createApp({ 'db/schema.ts': PG_SCHEMA })
      tables = (await readSchemaTables(app)).tables
    })

    test('should load the drizzle copy the fixture links, not another one', async () => {
      const [file] = await readSchemaAtRuntime(app)

      if (file?.status !== 'read') throw new Error(`expected a runtime read, got ${JSON.stringify(file)}`)
      expect(await realpath(file.drizzleEntry)).toStartWith(await realpath(WORKSPACE_DRIZZLE))
    })

    // A module namespace lists its exports alphabetically, not in source order.
    test('should report every exported table as runtime and skip exports that are not tables', () => {
      expect(tables.map((table) => [table.identifier, table.source, table.dialect])).toEqual([
        ['members', 'runtime', 'pg'],
        ['notes', 'runtime', 'pg'],
        ['orgs', 'runtime', 'pg'],
      ])
      expect(tables.some((table) => table.opaqueColumns || table.opaqueConstraints)).toBe(false)
    })

    test('should read spread columns, a helper builder and a helper-built extra config', () => {
      const orgs = tableOf(tables, 'orgs')

      expect(orgs.columns.map((column) => column.name)).toEqual(['id', 'slug', 'createdAt', 'updatedAt'])
      expect(columnOf(orgs, 'slug')).toMatchObject({ columnName: 'slug', notNull: true, unique: true, sqlType: 'text' })
      expect(columnOf(orgs, 'slug').opaqueBuilder).toBeUndefined()
      expect(columnOf(orgs, 'createdAt')).toMatchObject({ columnName: 'created_at', notNull: true, withTimezone: true })
      expect(orgs.constraints).toEqual([{ kind: 'index', name: 'orgs_created_idx', columns: ['createdAt'] }])
    })

    test('should keep the builder name from the static reader only where it was drizzle\'s own', () => {
      const orgs = tableOf(tables, 'orgs')

      expect(columnOf(orgs, 'id').type).toBe('serial')
      expect(columnOf(orgs, 'slug').type).toBeUndefined()
    })

    test('should report defaults as drizzle holds them without calling user functions', () => {
      const members = tableOf(tables, 'members')

      expect(columnOf(tableOf(tables, 'orgs'), 'createdAt').default).toEqual({ kind: 'sql', text: 'now()' })
      expect(columnOf(tableOf(tables, 'orgs'), 'updatedAt').default).toEqual({ kind: 'sql', text: 'now()' })
      expect(columnOf(members, 'role').default).toEqual({ kind: 'value', text: '"member"' })
      expect(columnOf(tableOf(tables, 'notes'), 'rank').default).toEqual({ kind: 'value', text: '0' })
      expect(columnOf(members, 'token').default).toBeUndefined()
      expect(columnOf(members, 'token').runtimeDefault).toContain('randomUUID')
      expect(columnOf(members, 'role').runtimeDefault).toBeUndefined()
    })

    test('should read the columns callback form and its composite primary key', () => {
      const members = tableOf(tables, 'members')

      expect(members.columns.map((column) => [column.name, column.columnName])).toEqual([
        ['orgId', 'org_id'],
        ['userId', 'user_id'],
        ['role', 'role'],
        ['token', 'token'],
      ])
      expect(columnOf(members, 'orgId').references).toEqual({ table: 'orgs', column: 'id' })
      expect(members.constraints.filter((entry) => entry.kind === 'primaryKey')).toEqual([
        expect.objectContaining({ kind: 'primaryKey', columns: ['orgId', 'userId'] }),
      ])
    })

    test('should read composite and self-referencing foreign keys by property name', () => {
      const notes = tableOf(tables, 'notes')

      expect(notes.constraints.filter((entry) => entry.kind === 'foreignKey')).toEqual([
        { kind: 'foreignKey', name: 'notes_parent_fk', columns: ['parentId'], references: { table: 'notes', columns: ['id'] } },
        {
          kind: 'foreignKey',
          name: 'notes_member_fk',
          columns: ['orgId', 'userId'],
          references: { table: 'members', columns: ['orgId', 'userId'] },
        },
      ])
      expect(columnOf(notes, 'parentId').references).toEqual({ table: 'notes', column: 'id' })
      expect(columnOf(notes, 'orgId').references).toBeUndefined()
    })

    test('should read uniqueIndex, unique().on() and check, and mark an expression index opaque', () => {
      const notes = tableOf(tables, 'notes')
      const others = notes.constraints.filter((entry) => entry.kind !== 'foreignKey')

      expect(others).toEqual([
        { kind: 'uniqueIndex', name: 'notes_title_idx', columns: ['orgId', 'title'] },
        { kind: 'index', name: 'notes_lower_title_idx', columns: [], opaqueColumns: true },
        { kind: 'unique', name: 'notes_rank_unique', columns: ['orgId', 'rank'] },
        { kind: 'check', name: 'notes_rank_check', columns: [] },
      ])
    })
  })

  for (const [dialect, source, createdDefault] of [
    ['sqlite', SQLITE_SCHEMA, '(unixepoch())'],
    ['mysql', MYSQL_SCHEMA, '(now())'],
  ] as const) {
    describe(`${dialect} shapes the static reader marks opaque`, () => {
      let tables: SourcedSchemaTable[]

      beforeAll(async () => {
        tables = (await readSchemaTables(await createApp({ 'db/schema.ts': source }))).tables
      })

      test('should pick the dialect and read spread, helper and callback columns', () => {
        expect(tables.map((table) => [table.identifier, table.source, table.dialect])).toEqual([
          ['members', 'runtime', dialect],
          ['notes', 'runtime', dialect],
          ['orgs', 'runtime', dialect],
        ])
        const orgs = tableOf(tables, 'orgs')
        expect(columnOf(orgs, 'slug')).toMatchObject({ notNull: true, unique: true })
        expect(columnOf(orgs, 'createdAt')).toMatchObject({ columnName: 'created_at', default: { kind: 'sql', text: createdDefault } })
        expect(orgs.constraints).toEqual([{ kind: 'index', name: 'orgs_slug_idx', columns: ['slug'] }])

        const members = tableOf(tables, 'members')
        expect(columnOf(members, 'role').default).toEqual({ kind: 'value', text: '"member"' })
        expect(columnOf(members, 'token').runtimeDefault).toContain('randomUUID')
        expect(columnOf(members, 'orgId').references).toEqual({ table: 'orgs', column: 'id' })
      })

      test('should read composite keys, unique constraints and checks', () => {
        const notes = tableOf(tables, 'notes')
        const byKind = (kind: string) => notes.constraints.filter((entry) => entry.kind === kind)

        expect(tableOf(tables, 'members').constraints.filter((entry) => entry.kind === 'primaryKey')).toEqual([
          expect.objectContaining({ columns: ['orgId', 'userId'] }),
        ])
        expect(byKind('foreignKey')).toEqual([
          { kind: 'foreignKey', name: 'notes_parent_fk', columns: ['parentId'], references: { table: 'notes', columns: ['id'] } },
          {
            kind: 'foreignKey',
            name: 'notes_member_fk',
            columns: ['orgId', 'userId'],
            references: { table: 'members', columns: ['orgId', 'userId'] },
          },
        ])
        expect(byKind('uniqueIndex')).toEqual([{ kind: 'uniqueIndex', name: 'notes_rank_idx', columns: ['orgId', 'rank'] }])
        expect(byKind('unique')).toEqual([{ kind: 'unique', name: 'notes_user_unique', columns: ['userId', 'rank'] }])
        expect(byKind('check')).toEqual([{ kind: 'check', name: 'notes_rank_check', columns: [] }])
      })
    })
  }

  describe('modules', () => {
    test('should read each module schema and resolve a foreign key into the root schema', async () => {
      const app = await createApp({
        'db/schema.ts': `import { pgTable, serial } from 'drizzle-orm/pg-core'
export const users = pgTable('users', { id: serial('id').primaryKey() })
`,
        'modules/billing/index.ts': 'export default {}\n',
        'modules/billing/db/schema.ts': `import { integer, pgTable, serial } from 'drizzle-orm/pg-core'
import { users } from '../../../db/schema'
const owner = () => integer('user_id').notNull().references(() => users.id)
export const invoices = pgTable('invoices', { id: serial('id').primaryKey(), userId: owner() })
`,
      })
      const { tables, files } = await readSchemaTables(app)

      expect(files.map((file) => [file.module, file.path, file.status])).toEqual([
        [null, 'db/schema.ts', 'read'],
        ['billing', 'modules/billing/db/schema.ts', 'read'],
      ])
      const invoices = tableOf(tables, 'invoices')
      expect(invoices.module).toBe('billing')
      expect(columnOf(invoices, 'userId').references).toEqual({ table: 'users', column: 'id' })
    })
  })

  describe('failure is data', () => {
    const OPAQUE_SCHEMA = `import { pgTable, serial, timestamp } from 'drizzle-orm/pg-core'
const timestamps = { createdAt: timestamp('created_at').defaultNow() }
const extras = () => []
export const posts = pgTable('posts', { id: serial('id').primaryKey(), ...timestamps }, () => extras())
`

    async function expectStaticFallback(app: string, reason: RegExp, options = {}): Promise<void> {
      const { tables, files } = await readSchemaTables(app, options)
      const staticTables = await parseSchemaTables(app)

      expect(files).toHaveLength(1)
      expect(files[0]).toMatchObject({ module: null, path: 'db/schema.ts', status: 'unreadable' })
      expect(files[0]?.status === 'unreadable' ? files[0].reason : '').toMatch(reason)

      expect(tables).toHaveLength(1)
      const posts = tableOf(tables, 'posts')
      expect(posts.source).toBe('static')
      expect(posts.runtimeUnreadable).toMatch(reason)
      expect(posts.opaqueColumns).toBe(true)
      expect(posts.opaqueConstraints).toBe(true)
      expect(posts.columns).toEqual(staticTables[0]?.columns ?? [])
    }

    test('should fall back to the static reader when the schema throws on import', async () => {
      const app = await createApp({
        'db/schema.ts': `${OPAQUE_SCHEMA}\nif (!process.env.GUREN_SCHEMA_RUNTIME_TEST_URL) throw new Error('DATABASE_URL is required')\n`,
      })
      await expectStaticFallback(app, /db\/schema\.ts could not be imported: DATABASE_URL is required/)
    })

    test('should fall back to the static reader when the schema imports a module that does not exist', async () => {
      const app = await createApp({ 'db/schema.ts': `import '../config/database'\n${OPAQUE_SCHEMA}` })
      await expectStaticFallback(app, /db\/schema\.ts could not be imported/)
    })

    // Measured: Bun 1.3.14 on Linux resolves a dynamic import while its top-level await is
    // still pending, so there the schema reads as a table in ~10ms and the timeout never fires.
    test.skipIf(process.platform === 'linux')('should fall back to the static reader when the real import never settles', async () => {
      const app = await createApp({ 'db/schema.ts': `${OPAQUE_SCHEMA}\nawait new Promise((done) => setTimeout(done, 10_000))\n` })
      await expectStaticFallback(app, /could not be imported: the import did not finish within 50ms/, { importTimeoutMs: 50 })
    })

    test('should fall back to the static reader when the injected import never settles', async () => {
      const app = await createApp({ 'db/schema.ts': OPAQUE_SCHEMA })
      await expectStaticFallback(app, /could not be imported: the import did not finish within 10ms/, {
        importTimeoutMs: 10,
        importSchema: () => new Promise<never>(() => {}),
      })
    })

    test('should reject an import that outlives the timeout and settle with one that does not', async () => {
      const pending = new Promise<never>(() => {})
      await expect(withImportTimeout(pending, 20)).rejects.toThrow('the import did not finish within 20ms')
      await expect(withImportTimeout(Promise.resolve('read'), 20)).resolves.toBe('read')
      await expect(withImportTimeout(Promise.reject(new Error('DATABASE_URL is required')), 20)).rejects.toThrow('DATABASE_URL is required')
    })

    test('should fall back to the static reader when the app has no drizzle-orm', async () => {
      const app = await createApp({ 'db/schema.ts': OPAQUE_SCHEMA }, { drizzle: false })
      await expectStaticFallback(app, /drizzle-orm could not be loaded from the app: .*Cannot find (module|package) '?drizzle-orm/)
    })

    test('should fall back to the static reader when no export is a drizzle table', async () => {
      const app = await createApp({ 'db/schema.ts': OPAQUE_SCHEMA.replace('export const posts', 'const posts') + 'export const tables = { posts }\n' })
      await expectStaticFallback(app, /no export of db\/schema\.ts is a drizzle table/)
    })

    test('should keep a table the file does not export as static beside its runtime tables', async () => {
      const app = await createApp({
        'db/schema.ts': `import { pgTable, serial } from 'drizzle-orm/pg-core'
const shared = { id: serial('id').primaryKey() }
export const posts = pgTable('posts', { ...shared })
const drafts = pgTable('drafts', { ...shared })
export const lookalike = { name: 'posts', columns: [] }
`,
      })
      const { tables } = await readSchemaTables(app)

      expect(tables.map((table) => [table.identifier, table.source])).toEqual([
        ['posts', 'runtime'],
        ['drafts', 'static'],
      ])
      expect(tableOf(tables, 'drafts').opaqueColumns).toBe(true)
      expect(tableOf(tables, 'drafts').runtimeUnreadable).toMatch(/does not export drafts as a drizzle table/)
    })

    test('should read a pgSchema table and report an aliased export once, under its declared name', async () => {
      const app = await createApp({
        'db/schema.ts': `import { pgSchema, pgTable, integer, serial } from 'drizzle-orm/pg-core'
export const posts = pgTable('posts', { id: serial('id').primaryKey() })
export { posts as articles }
export const events = pgSchema('audit').table('events', { id: serial('id').primaryKey(), postId: integer('post_id').references(() => posts.id) })
`,
      })
      const { tables } = await readSchemaTables(app)

      expect(tables.map((table) => [table.identifier, table.tableName, table.source])).toEqual([
        ['events', 'events', 'runtime'],
        ['posts', 'posts', 'runtime'],
      ])
      expect(columnOf(tableOf(tables, 'events'), 'postId').references).toEqual({ table: 'posts', column: 'id' })
    })

    test('should attribute a table re-exported by another schema file to the file that declares it', async () => {
      const app = await createApp({
        'db/schema.ts': `import { pgTable, serial } from 'drizzle-orm/pg-core'
export const users = pgTable('users', { id: serial('id').primaryKey() })
export * from '../modules/billing/db/schema'
`,
        'modules/billing/index.ts': 'export default {}\n',
        'modules/billing/db/schema.ts': `import { pgTable, serial } from 'drizzle-orm/pg-core'
const shared = { id: serial('id').primaryKey() }
export const invoices = pgTable('invoices', { ...shared })
`,
      })
      const { tables } = await readSchemaTables(app)

      expect(tables.map((table) => [table.module, table.identifier, table.source])).toEqual([
        [null, 'users', 'runtime'],
        ['billing', 'invoices', 'runtime'],
      ])
    })

    test('should read a schema again after it was edited in the same process', async () => {
      const app = await createApp({
        'db/schema.ts': `import { pgTable, serial } from 'drizzle-orm/pg-core'
export const posts = pgTable('posts', { id: serial('id').primaryKey() })
`,
      })
      await readSchemaTables(app)
      await writeFile(
        join(app, 'db/schema.ts'),
        `import { pgTable, serial, text } from 'drizzle-orm/pg-core'
const extra = { title: text('title') }
export const posts = pgTable('posts', { id: serial('id').primaryKey(), ...extra })
`,
      )
      await utimes(join(app, 'db/schema.ts'), new Date(), new Date(Date.now() + 5000))

      const posts = tableOf((await readSchemaTables(app)).tables, 'posts')
      expect(posts.source).toBe('runtime')
      expect(posts.columns.map((column) => column.name)).toEqual(['id', 'title'])
    })

    test('should name a table inside a SQL default and mark a chunk it cannot render', async () => {
      const app = await createApp({
        'db/schema.ts': `import { sql } from 'drizzle-orm'
import { integer, pgTable, serial } from 'drizzle-orm/pg-core'
export const counters = pgTable('counters', { id: serial('id').primaryKey() })
export const rows = pgTable('rows', {
  next: integer('next').default(sql\`(select max(\${counters.id}) from \${counters})\`),
  bound: integer('bound').default(sql\`\${sql.placeholder('limit')}\`),
})
`,
      })
      const rows = tableOf((await readSchemaTables(app)).tables, 'rows')

      expect(columnOf(rows, 'next')).toMatchObject({ default: { kind: 'sql', text: '(select max(id) from counters)' } })
      expect(columnOf(rows, 'next').opaqueDefault).toBeUndefined()
      expect(columnOf(rows, 'bound')).toMatchObject({ default: { kind: 'sql', text: '?' }, opaqueDefault: true })
    })

    test('should keep the builder name of a column imported from an @guren/orm barrel', async () => {
      const app = await createApp({
        'db/schema.ts': `import { pgTable, serial, text } from '@guren/orm/drizzle/pg'
export const users = pgTable('users', { id: serial('id').primaryKey(), email: text('email').notNull() })
`,
      })
      await mkdir(join(app, 'node_modules', '@guren'), { recursive: true })
      await symlink(WORKSPACE_ORM, join(app, 'node_modules', '@guren', 'orm'), 'dir')

      const users = tableOf((await readSchemaTables(app)).tables, 'users')

      expect(users.source).toBe('runtime')
      expect(columnOf(users, 'id')).toMatchObject({ type: 'serial', primaryKey: true })
      expect(columnOf(users, 'email')).toMatchObject({ type: 'text', notNull: true })
    })

    test('should report nothing for an app with no schema file', async () => {
      const app = await createApp({ 'package.json': '{}' })
      expect(await readSchemaTables(app)).toEqual({ tables: [], files: [] })
    })
  })
})
