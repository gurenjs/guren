import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'bun:test'
import { DIALECT_BARRELS, isDrizzleBuilderSpecifier, MIXED_DRIZZLE_BARREL } from '../src/drizzle-specifiers'
import { parseSchemaTables, type SchemaColumn, type SchemaTable } from '../src/schema-parser'
import { createTempWorkspace } from './helpers'

const REPO_ROOT = resolve(import.meta.dir, '../../..')
const DATABASE_TEMPLATES = join(REPO_ROOT, 'packages/create-app/templates/database')

async function parseSchema(source: string | { copyFrom: string }): Promise<SchemaTable[]> {
  const workspace = await createTempWorkspace('guren-cli-drizzle-specifiers-')
  try {
    await mkdir(join(workspace.dir, 'db'), { recursive: true })
    const target = join(workspace.dir, 'db/schema.ts')
    if (typeof source === 'string') await writeFile(target, source, 'utf8')
    else await copyFile(source.copyFrom, target)
    return await parseSchemaTables(workspace.dir)
  } finally {
    await workspace.cleanup()
  }
}

function column(table: SchemaTable, name: string): SchemaColumn {
  const found = table.columns.find((candidate) => candidate.name === name)
  if (!found) throw new Error(`no column ${name} in ${table.identifier}`)
  return found
}

describe('isDrizzleBuilderSpecifier', () => {
  let ormExports: string[]

  beforeAll(async () => {
    const manifest = JSON.parse(await readFile(join(REPO_ROOT, 'packages/orm/package.json'), 'utf8')) as {
      exports: Record<string, unknown>
    }
    ormExports = Object.keys(manifest.exports)
  })

  it('accepts every ./drizzle* subpath @guren/orm exports', () => {
    const subpaths = ormExports.filter((key) => key.startsWith('./drizzle'))

    expect(subpaths.length).toBeGreaterThan(0)
    for (const subpath of subpaths) {
      expect({ subpath, accepted: isDrizzleBuilderSpecifier(`@guren/orm${subpath.slice(1)}`) }).toEqual({ subpath, accepted: true })
    }
  })

  it('names only barrels @guren/orm actually exports', () => {
    for (const specifier of [MIXED_DRIZZLE_BARREL, ...Object.values(DIALECT_BARRELS)]) {
      expect(ormExports).toContain(`.${specifier.slice('@guren/orm'.length)}`)
    }
  })

  it('accepts drizzle-orm itself and rejects modules that do not re-export its builders', () => {
    expect(isDrizzleBuilderSpecifier('drizzle-orm')).toBe(true)
    expect(isDrizzleBuilderSpecifier('drizzle-orm/pg-core')).toBe(true)
    expect(isDrizzleBuilderSpecifier('@guren/orm')).toBe(false)
    expect(isDrizzleBuilderSpecifier('@guren/core')).toBe(false)
    expect(isDrizzleBuilderSpecifier('./columns')).toBe(false)
    expect(isDrizzleBuilderSpecifier('drizzle-orm-helpers')).toBe(false)
  })
})

// Without the barrels accepted, every column below reads `opaqueBuilder: true` and every
// barrel-built constraint goes unread: the `opaqueBuilder` and `constraints` assertions
// are the ones that fail. Types and options were read either way.
describe('parseSchemaTables on the create-app database templates', () => {
  it('covers every template driver', async () => {
    expect((await readdir(DATABASE_TEMPLATES)).sort()).toEqual(['mysql', 'postgres', 'sqlite'])
  })

  it('reads the postgres template columns as drizzle builders', async () => {
    const [users] = await parseSchema({ copyFrom: join(DATABASE_TEMPLATES, 'postgres/db/schema.ts') })

    expect(users.dialect).toBe('pg')
    expect(users.columns.filter((candidate) => candidate.opaqueBuilder)).toEqual([])
    expect(column(users, 'id')).toMatchObject({ type: 'serial', primaryKey: true })
    expect(column(users, 'email')).toMatchObject({ type: 'text', notNull: true })
    expect(column(users, 'createdAt')).toMatchObject({
      columnName: 'created_at',
      type: 'timestamp',
      withTimezone: true,
      notNull: true,
      default: { kind: 'now' },
    })
  })

  it('reads the mysql template columns as drizzle builders', async () => {
    const [users] = await parseSchema({ copyFrom: join(DATABASE_TEMPLATES, 'mysql/db/schema.ts') })

    expect(users.dialect).toBe('mysql')
    expect(users.columns.filter((candidate) => candidate.opaqueBuilder)).toEqual([])
    expect(column(users, 'id')).toMatchObject({ type: 'int', primaryKey: true })
    expect(column(users, 'name')).toMatchObject({ type: 'varchar', notNull: true })
    expect(column(users, 'createdAt')).toMatchObject({ type: 'timestamp', notNull: true, default: { kind: 'now' } })
  })

  it('reads the sqlite template columns as drizzle builders', async () => {
    const [users] = await parseSchema({ copyFrom: join(DATABASE_TEMPLATES, 'sqlite/db/schema.ts') })

    expect(users.dialect).toBe('sqlite')
    expect(users.columns.filter((candidate) => candidate.opaqueBuilder)).toEqual([])
    expect(column(users, 'id')).toMatchObject({ type: 'integer', primaryKey: true })
    expect(column(users, 'createdAt')).toMatchObject({
      type: 'text',
      notNull: true,
      runtimeDefault: '() => new Date().toISOString()',
    })
  })
})

describe('parseSchemaTables on a scaffold-shaped schema', () => {
  const SCAFFOLDED = `import { index, pgTable, serial, text, uniqueIndex } from '@guren/orm/drizzle/pg'

export const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  slug: text('slug').notNull(),
  title: text('title').notNull(),
}, (table) => [
  uniqueIndex('posts_slug_unique').on(table.slug),
  index('posts_title_idx').on(table.title),
])
`

  it('reads extra-config constraints built from the barrel', async () => {
    const [posts] = await parseSchema(SCAFFOLDED)

    expect(posts.opaqueConstraints).toBeUndefined()
    expect(posts.constraints).toEqual([
      { kind: 'uniqueIndex', name: 'posts_slug_unique', columns: ['slug'] },
      { kind: 'index', name: 'posts_title_idx', columns: ['title'] },
    ])
  })

  it('reads the mixed @guren/orm/drizzle barrel and a namespace import from a dialect barrel', async () => {
    const [mixed] = await parseSchema(`import { pgTable, serial, text } from '@guren/orm/drizzle'

export const tags = pgTable('tags', { id: serial('id').primaryKey(), name: text('name').notNull() })
`)
    expect(mixed.columns.filter((candidate) => candidate.opaqueBuilder)).toEqual([])

    const [namespaced] = await parseSchema(`import * as p from '@guren/orm/drizzle/sqlite'

export const notes = p.sqliteTable('notes', { id: p.integer('id').primaryKey() }, (table) => [p.index('notes_id_idx').on(table.id)])
`)
    expect(namespaced.columns.filter((candidate) => candidate.opaqueBuilder)).toEqual([])
    expect(namespaced.constraints).toEqual([{ kind: 'index', name: 'notes_id_idx', columns: ['id'] }])
  })

  it('still marks a column from a local helper as not visible', async () => {
    const [posts] = await parseSchema(`import { pgTable, serial } from '@guren/orm/drizzle/pg'
import { idColumn } from './columns'

export const posts = pgTable('posts', { id: idColumn(), other: serial('other') })
`)
    expect(column(posts, 'id').opaqueBuilder).toBe(true)
    expect(column(posts, 'other').opaqueBuilder).toBeUndefined()
  })
})
