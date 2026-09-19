import { afterAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseSchemaTables } from '../src/schema-parser'
import { readSchemaAtRuntime, readSchemaTables, type SourcedSchemaTable } from '../src/schema-runtime'

// The copy `@guren/orm` pins. A temp app outside the repo resolves `drizzle-orm` from
// Bun's global cache or not at all, so each fixture links this one explicitly.
const WORKSPACE_DRIZZLE = resolve(import.meta.dir, '../../orm/node_modules/drizzle-orm')

const created: string[] = []

afterAll(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function createApp(files: Record<string, string>, options: { drizzle?: boolean } = {}): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'guren-schema-runtime-')))
  created.push(dir)
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true })
    await writeFile(join(dir, path), content)
  }
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
    test('should load the drizzle copy the fixture links, not another one', async () => {
      const app = await createApp({ 'db/schema.ts': PG_SCHEMA })
      const [file] = await readSchemaAtRuntime(app)

      if (file?.status !== 'read') throw new Error(`expected a runtime read, got ${JSON.stringify(file)}`)
      expect(await realpath(file.drizzleEntry)).toStartWith(await realpath(WORKSPACE_DRIZZLE))
    })

    // A module namespace lists its exports alphabetically, not in source order.
    test('should report every exported table as runtime and skip exports that are not tables', async () => {
      const app = await createApp({ 'db/schema.ts': PG_SCHEMA })
      const { tables } = await readSchemaTables(app)

      expect(tables.map((table) => [table.identifier, table.source, table.dialect])).toEqual([
        ['members', 'runtime', 'pg'],
        ['notes', 'runtime', 'pg'],
        ['orgs', 'runtime', 'pg'],
      ])
      expect(tables.some((table) => table.opaqueColumns || table.opaqueConstraints)).toBe(false)
    })

    test('should read spread columns, a helper builder and a helper-built extra config', async () => {
      const app = await createApp({ 'db/schema.ts': PG_SCHEMA })
      const orgs = tableOf((await readSchemaTables(app)).tables, 'orgs')

      expect(orgs.columns.map((column) => column.name)).toEqual(['id', 'slug', 'createdAt', 'updatedAt'])
      expect(columnOf(orgs, 'slug')).toMatchObject({ columnName: 'slug', notNull: true, unique: true, sqlType: 'text' })
      expect(columnOf(orgs, 'slug').opaqueBuilder).toBeUndefined()
      expect(columnOf(orgs, 'createdAt')).toMatchObject({ columnName: 'created_at', notNull: true, withTimezone: true })
      expect(orgs.constraints).toEqual([{ kind: 'index', name: 'orgs_created_idx', columns: ['createdAt'] }])
    })

    test('should keep the builder name from the static reader only where it was drizzle\'s own', async () => {
      const app = await createApp({ 'db/schema.ts': PG_SCHEMA })
      const orgs = tableOf((await readSchemaTables(app)).tables, 'orgs')

      expect(columnOf(orgs, 'id').type).toBe('serial')
      expect(columnOf(orgs, 'slug').type).toBeUndefined()
    })

    test('should report defaults as drizzle holds them without calling user functions', async () => {
      const app = await createApp({ 'db/schema.ts': PG_SCHEMA })
      const { tables } = await readSchemaTables(app)
      const members = tableOf(tables, 'members')

      expect(columnOf(tableOf(tables, 'orgs'), 'createdAt').default).toEqual({ kind: 'sql', text: 'now()' })
      expect(columnOf(tableOf(tables, 'orgs'), 'updatedAt').default).toEqual({ kind: 'sql', text: 'now()' })
      expect(columnOf(members, 'role').default).toEqual({ kind: 'value', text: '"member"' })
      expect(columnOf(tableOf(tables, 'notes'), 'rank').default).toEqual({ kind: 'value', text: '0' })
      expect(columnOf(members, 'token').default).toBeUndefined()
      expect(columnOf(members, 'token').runtimeDefault).toContain('randomUUID')
      expect(columnOf(members, 'role').runtimeDefault).toBeUndefined()
    })

    test('should read the columns callback form and its composite primary key', async () => {
      const app = await createApp({ 'db/schema.ts': PG_SCHEMA })
      const members = tableOf((await readSchemaTables(app)).tables, 'members')

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

    test('should read composite and self-referencing foreign keys by property name', async () => {
      const app = await createApp({ 'db/schema.ts': PG_SCHEMA })
      const notes = tableOf((await readSchemaTables(app)).tables, 'notes')

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

    test('should read uniqueIndex, unique().on() and check, and mark an expression index opaque', async () => {
      const app = await createApp({ 'db/schema.ts': PG_SCHEMA })
      const notes = tableOf((await readSchemaTables(app)).tables, 'notes')
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
      test('should pick the dialect and read spread, helper and callback columns', async () => {
        const app = await createApp({ 'db/schema.ts': source })
        const { tables } = await readSchemaTables(app)

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

      test('should read composite keys, unique constraints and checks', async () => {
        const app = await createApp({ 'db/schema.ts': source })
        const { tables } = await readSchemaTables(app)
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

    async function expectStaticFallback(app: string, reason: RegExp): Promise<void> {
      const { tables, files } = await readSchemaTables(app)
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
      await expectStaticFallback(app, /db\/schema\.ts threw on import: DATABASE_URL is required/)
    })

    test('should fall back to the static reader when the schema imports a module that does not exist', async () => {
      const app = await createApp({ 'db/schema.ts': `import '../config/database'\n${OPAQUE_SCHEMA}` })
      await expectStaticFallback(app, /db\/schema\.ts threw on import/)
    })

    test('should fall back to the static reader when the app has no drizzle-orm', async () => {
      const app = await createApp({ 'db/schema.ts': OPAQUE_SCHEMA }, { drizzle: false })
      await expectStaticFallback(app, /drizzle-orm could not be loaded from the app/)
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

    test('should report nothing for an app with no schema file', async () => {
      const app = await createApp({ 'package.json': '{}' })
      expect(await readSchemaTables(app)).toEqual({ tables: [], files: [] })
    })
  })
})
