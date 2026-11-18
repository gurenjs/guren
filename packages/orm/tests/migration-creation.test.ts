import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { readCreationStatements, snapshotRecordsCreation, type MigrationDialect } from '../src/migration-guard'

const CREATION = join(import.meta.dir, 'fixtures/drizzle-kit-migrations/creation')
const DIALECTS: Array<[folder: string, dialect: MigrationDialect]> = [['pg', 'postgres'], ['mysql', 'mysql'], ['sqlite', 'sqlite']]

function run(folder: string) {
  const [base, head] = readdirSync(join(CREATION, folder), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  const read = (name: string, file: string) => readFileSync(join(CREATION, folder, name!, file), 'utf8')
  return { sql: read(head!, 'migration.sql'), baseSql: read(base!, 'migration.sql'), snapshot: JSON.parse(read(head!, 'snapshot.json')), previous: JSON.parse(read(base!, 'snapshot.json')) }
}

describe('readCreationStatements', () => {
  test('should read what drizzle-kit writes for added tables, their indexes and their foreign keys', () => {
    const read = readCreationStatements(run('pg').sql, 'postgres')!
    const typed = read.map((statement) => (statement.kind === 'create-table' ? { ...statement, columns: statement.columns.map((column) => `${column.name} ${column.type}`) } : statement))

    expect(typed).toEqual([
      { kind: 'create-table', table: 'comments', columns: ['id serial', 'body text', 'post_id integer', 'created_at timestamp with time zone'], foreignKeys: [], uniques: [] },
      {
        kind: 'create-table', table: 'tags', foreignKeys: [], uniques: [],
        columns: ['id serial', 'slug text', 'label text', 'weight numeric(8,2)', 'active boolean', 'meta jsonb', 'ref uuid', 'seen_on date', 'postId integer', 'createdAt timestamp with time zone'],
      },
      { kind: 'create-index', table: 'comments', columns: ['post_id'], unique: false },
      { kind: 'create-index', table: 'tags', columns: ['ref'], unique: false },
      { kind: 'create-index', table: 'tags', columns: ['label', 'weight'], unique: false },
      { kind: 'add-foreign-key', table: 'comments', foreignKey: { columns: ['post_id'], table: 'posts', columnsTo: ['id'], onDelete: 'CASCADE' } },
      { kind: 'add-foreign-key', table: 'tags', foreignKey: { columns: ['postId'], table: 'posts', columnsTo: ['id'], onDelete: 'SET NULL' } },
    ])
  })

  test("should read each column's modifiers and default as the SQL writes them", () => {
    const tags = (folder: string, dialect: MigrationDialect) => {
      const table = readCreationStatements(run(folder).sql, dialect)!.find((statement) => statement.kind === 'create-table' && statement.table === 'tags')
      return table?.kind === 'create-table' ? Object.fromEntries(table.columns.map(({ name, type: _type, ...rest }) => [name, rest])) : undefined
    }

    expect(tags('pg', 'postgres')).toMatchObject({
      id: { primaryKey: true, notNull: false, autoIncrement: false },
      slug: { unique: true, notNull: true },
      label: { notNull: true, default: "'untitled'" },
      weight: { notNull: false, unique: false },
      active: { default: 'false' },
      createdAt: { notNull: true, default: 'now()' },
    })
    expect(tags('mysql', 'mysql')).toMatchObject({ id: { primaryKey: true, autoIncrement: true }, slug: { unique: false }, createdAt: { default: '(current_timestamp)' } })
    expect(tags('sqlite', 'sqlite')).toMatchObject({ id: { primaryKey: true, autoIncrement: true }, slug: { unique: true }, createdAt: { default: '(unixepoch())' } })
  })

  test('should read a MySQL unique index and SQLite foreign keys inside the table', () => {
    const mysql = readCreationStatements(run('mysql').sql, 'mysql')
    const sqlite = readCreationStatements(run('sqlite').sql, 'sqlite')

    expect(mysql?.find((statement) => statement.table === 'tags' && statement.kind === 'create-table')).toMatchObject({ uniques: [['slug']] })
    expect(sqlite?.filter((statement) => statement.kind === 'create-table').map((statement) => statement.kind === 'create-table' && statement.foreignKeys)).toEqual([
      [{ columns: ['post_id'], table: 'posts', columnsTo: ['id'], onDelete: 'CASCADE' }],
      [{ columns: ['postId'], table: 'posts', columnsTo: ['id'], onDelete: 'SET NULL' }],
    ])
  })

  test("should read a composite key in the order the SQL writes it, MySQL's unnamed one included", () => {
    const mysql = 'CREATE TABLE `m` (\n\t`tenant_id` int NOT NULL,\n\t`item_id` int NOT NULL,\n\tCONSTRAINT PRIMARY KEY(`tenant_id`,`item_id`)\n);\n'
    const pg = 'CREATE TABLE "m" (\n\t"tenant_id" integer,\n\t"item_id" integer,\n\tCONSTRAINT "m_pkey" PRIMARY KEY("item_id","tenant_id")\n);\n'

    expect(readCreationStatements(mysql, 'mysql')).toMatchObject([{ kind: 'create-table', primaryKey: ['tenant_id', 'item_id'] }])
    expect(readCreationStatements(pg, 'postgres')).toMatchObject([{ kind: 'create-table', primaryKey: ['item_id', 'tenant_id'] }])
    expect(readCreationStatements(mysql.replace('CONSTRAINT PRIMARY KEY', 'CONSTRAINT CHECK'), 'mysql')).toBeUndefined()
  })

  test.each(DIALECTS)('should read every %s migration of the run', (folder, dialect) => {
    const { sql, baseSql } = run(folder)

    expect(readCreationStatements(sql, dialect)?.length).toBeGreaterThan(0)
    expect(readCreationStatements(baseSql, dialect)?.map((statement) => statement.table)).toEqual(['posts', 'users'])
  })

  test.each([
    ['a trigger', 'CREATE TRIGGER "t" AFTER INSERT ON "comments" FOR EACH ROW EXECUTE FUNCTION f();'],
    ['a function body', 'CREATE TABLE "a" ("id" serial PRIMARY KEY);\nDO $$ BEGIN DELETE FROM "posts"; END $$;'],
    ['a name qualified by a schema', 'CREATE TABLE "public"."a" ("id" serial PRIMARY KEY);'],
    ['an unquoted name', 'CREATE TABLE a ("id" serial PRIMARY KEY);'],
    ['a table made from a query', 'CREATE TABLE "a" AS SELECT * FROM "posts";'],
    ['a row written', 'CREATE TABLE "a" ("id" serial PRIMARY KEY);\nINSERT INTO "posts" ("id") VALUES (1);'],
    ['a table dropped', 'CREATE TABLE "a" ("id" serial PRIMARY KEY);\nDROP TABLE "posts";'],
    ['a column added to a table', 'ALTER TABLE "posts" ADD COLUMN "x" text;'],
    ['a default calling another function', 'CREATE TABLE "a" ("id" uuid DEFAULT gen_random_uuid() PRIMARY KEY);'],
    ['a default holding a query', 'CREATE TABLE "a" ("id" integer DEFAULT (SELECT 1));'],
    ['a column naming another table', 'CREATE TABLE "a" ("post_id" integer REFERENCES "posts"("id"));'],
    ['a check', 'CREATE TABLE "a" ("id" integer, CHECK ("id" > 0));'],
    ['an index with a method', 'CREATE TABLE "a" ("id" integer);\nCREATE INDEX "i" ON "a" USING gin ("id");'],
    ['a partial index', 'CREATE TABLE "a" ("id" integer);\nCREATE INDEX "i" ON "a" ("id") WHERE "id" > 0;'],
    ['an expression index', 'CREATE TABLE "a" ("id" integer);\nCREATE INDEX "i" ON "a" (lower("id"));'],
    ['an unterminated string', `CREATE TABLE "a" ("id" text DEFAULT 'x);`],
    ['a modifier written twice', 'CREATE TABLE "a" ("id" integer NOT NULL NOT NULL);'],
    ['a column with no type', 'CREATE TABLE "a" ("id" NOT NULL);'],
    ['a default that is a name', 'CREATE TABLE "a" ("id" integer DEFAULT id);'],
  ])('should read nothing from %s', (_label, sql) => {
    expect(readCreationStatements(sql, 'postgres')).toBeUndefined()
  })

  test('should read nothing from text MySQL executes inside a comment, whatever the dialect', () => {
    const sql = `${run('pg').sql}\n/*!50000 DROP TABLE users */`

    expect(readCreationStatements(sql, 'postgres')).toBeUndefined()
    expect(readCreationStatements('CREATE TABLE `a` (`id` int);\n--x DROP TABLE users', 'mysql')).toBeUndefined()
  })

  test("should read nothing where the dialect's readings split a string differently", () => {
    // Read with backslash escapes, ` -- ` opens a comment that hides `z`; read without them, the table has three columns.
    const sql = "CREATE TABLE `a` (`x` text DEFAULT 'a\\', `y` text DEFAULT ' -- ', `z` text\n);"

    expect(readCreationStatements(sql, 'mysql')).toBeUndefined()
  })

  test.each(DIALECTS)('should read nothing on %s behind a separator the migrator splits on', (folder, dialect) => {
    const { sql } = run(folder)

    // drizzle's migrator cuts the raw text at the separator, so the DROP runs as its own piece.
    expect(readCreationStatements(`${sql}\n-- x --> statement-breakpoint DROP TABLE users;\n`, dialect)).toBeUndefined()
    expect(readCreationStatements(`${sql}\n/* --> statement-breakpoint\nDROP TABLE users;\n/* --> statement-breakpoint\n-- */`, dialect)).toBeUndefined()
    const q = folder === 'mysql' ? '`' : '"'
    const quoted = `CREATE TABLE ${q}a${q} (${q}x${q} text DEFAULT 'b');`

    expect(readCreationStatements(quoted, dialect)).toHaveLength(1)
    expect(readCreationStatements(quoted.replace("'b'", "'--> statement-breakpoint'"), dialect)).toBeUndefined()
  })

  test('should read nothing holding a carriage return, which ends a PostgreSQL line comment', () => {
    expect(readCreationStatements(`${run('pg').sql}\n-- x\rDROP TABLE "users";\n`, 'postgres')).toBeUndefined()
  })
})

describe('snapshotRecordsCreation', () => {
  test.each(DIALECTS)('should hold a %s snapshot that adds what the SQL creates to the previous one', (folder, dialect) => {
    const { sql, snapshot, previous } = run(folder)

    expect(snapshotRecordsCreation(previous, snapshot, readCreationStatements(sql, dialect)!)).toBe(true)
  })

  test.each(DIALECTS)('should not hold a %s snapshot that misstates a created column or touches another table', (folder, dialect) => {
    const { sql, snapshot, previous } = run(folder)
    const statements = readCreationStatements(sql, dialect)!
    const edited = (edit: (ddl: Array<Record<string, unknown>>) => void) => {
      const copy = structuredClone(snapshot)
      edit(copy.ddl)
      return snapshotRecordsCreation(previous, copy, statements)
    }

    expect(edited((ddl) => void (ddl.find((entry) => entry.entityType === 'columns' && entry.table === 'tags' && entry.name === 'slug')!.type = 'varchar(1)'))).toBe(false)
    expect(edited((ddl) => void ddl.push({ entityType: 'columns', table: 'posts', name: 'title', type: 'text', notNull: false }))).toBe(false)
    expect(edited((ddl) => void (ddl.find((entry) => entry.entityType === 'fks' && entry.table === 'comments')!.onDelete = 'NO ACTION'))).toBe(false)
    expect(edited((ddl) => void ddl.push({ entityType: 'checks', table: 'tags', name: 'c', value: 'true' }))).toBe(false)
    expect(edited((ddl) => void ddl.splice(ddl.findIndex((entry) => entry.entityType === 'columns' && entry.table === 'tags'), 1))).toBe(false)
  })

  test('should not hold a snapshot that renames, skips the previous one, or changes dialect', () => {
    const { sql, snapshot, previous } = run('pg')
    const statements = readCreationStatements(sql, 'postgres')!

    expect(snapshotRecordsCreation(previous, { ...snapshot, renames: ['public.a->public.b'] }, statements)).toBe(false)
    expect(snapshotRecordsCreation(previous, { ...snapshot, prevIds: ['00000000-0000-0000-0000-000000000000'] }, statements)).toBe(false)
    expect(snapshotRecordsCreation({ ...previous, dialect: 'mysql' }, snapshot, statements)).toBe(false)
    expect(snapshotRecordsCreation(undefined, snapshot, statements)).toBe(false)
  })
})
