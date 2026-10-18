import { describe, expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  isWideningTypeChange,
  judgeMigrations,
  readMigrationSources,
  scanMigrationSql,
  type DestructiveKind,
  type MigrationSource,
} from '../src/migration-guard'

const FIXTURES = join(import.meta.dir, 'fixtures/drizzle-kit-migrations')

function folder(dialect: string): { path: string; names: string[] } {
  const path = join(FIXTURES, dialect)
  const names = readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
  return { path, names }
}

function stepName(names: string[], step: number): string {
  return names.find((name) => name.endsWith(`_step${step}`))!
}

/** What a guard would refuse if only `step` were pending against a database that has the earlier ones. */
function pendingStep(dialect: string, step: number) {
  const { path, names } = folder(dialect)
  return judgeMigrations(readMigrationSources(path, [stepName(names, step)], 'db/migrations'))
}

function kinds(sql: string): DestructiveKind[] {
  return scanMigrationSql(sql).statements.map((statement) => statement.kind)
}

describe('drizzle-kit 1.0.0-rc.4 output', () => {
  for (const dialect of ['pg', 'mysql', 'sqlite']) {
    describe(dialect, () => {
      test('should pass the migration that creates the tables', () => {
        expect(pendingStep(dialect, 1).unacknowledged).toEqual([])
      })

      test('should report a dropped table at its line', () => {
        const [finding, ...rest] = pendingStep(dialect, 2).unacknowledged
        expect(rest).toEqual([])
        expect(finding).toMatchObject({ kind: 'drop-table', table: 'posts', line: 1 })
        expect(finding!.file).toMatch(/^db\/migrations\/\d+_step2\/migration\.sql$/)
      })

      test('should report a dropped column', () => {
        expect(pendingStep(dialect, 3).unacknowledged).toMatchObject([
          { kind: 'drop-column', table: 'users', column: 'bio', line: 1 },
        ])
      })

      test('should pass an added column', () => {
        expect(pendingStep(dialect, 5).unacknowledged).toEqual([])
      })
    })
  }

  test('should report both narrowed PostgreSQL columns, read from the snapshots', () => {
    expect(pendingStep('pg', 4).unacknowledged).toMatchObject([
      { kind: 'alter-column-type', column: 'age', line: 1 },
      { kind: 'alter-column-type', column: 'email', line: 2 },
    ])
  })

  test('should pass PostgreSQL widening the snapshots prove, though the SQL reads the same as narrowing', () => {
    expect(pendingStep('pg', 6).unacknowledged).toEqual([])
  })

  test('should report MySQL MODIFY COLUMN narrowing', () => {
    expect(pendingStep('mysql', 4).unacknowledged.map((finding) => finding.column)).toEqual(['age', 'email'])
  })

  test('should report the SQLite __new_ rebuild once, at its DROP TABLE line', () => {
    expect(pendingStep('sqlite', 4).unacknowledged).toMatchObject([
      { kind: 'table-rebuild', table: 'users', line: 10 },
    ])
  })

  test('should pass a SQLite rebuild that only adds a default or a foreign key, since the snapshots show every column copied', () => {
    const { path, names } = folder('sqlite-rebuild')
    for (const name of names.slice(1)) {
      const [source] = readMigrationSources(path, [name])
      expect(source!.scan.statements).toMatchObject([{ kind: 'table-rebuild', table: 'posts', copiedColumns: ['id', 'title', 'user_id'] }])
      expect(judgeMigrations([source!]).unacknowledged).toEqual([])
    }
  })

  test('should report a rebuild whose copy leaves a previous column behind', () => {
    const { path, names } = folder('sqlite-rebuild')
    const [source] = readMigrationSources(path, [names[1]!])
    const lossy = { ...source!, scan: { ...source!.scan, statements: source!.scan.statements.map((statement) => ({ ...statement, copiedColumns: ['id', 'title'] })) } }
    expect(judgeMigrations([lossy]).unacknowledged).toMatchObject([{ kind: 'table-rebuild' }])
  })

  test('should pass every migration on a fresh database, since each drop hits a table the run created', () => {
    for (const dialect of ['pg', 'mysql', 'sqlite']) {
      const { path, names } = folder(dialect)
      expect(judgeMigrations(readMigrationSources(path, names)).unacknowledged).toEqual([])
    }
  })

  test('should report the drops once the creating migration is applied', () => {
    const { path, names } = folder('pg')
    const report = judgeMigrations(readMigrationSources(path, names.slice(1)))
    expect(report.unacknowledged.map((finding) => finding.kind)).toEqual([
      'drop-table',
      'drop-column',
      'alter-column-type',
      'alter-column-type',
    ])
  })
})

describe('scanMigrationSql (hand-written; drizzle-kit never writes these without a prompt or --custom)', () => {
  test('should report renames in each dialect spelling', () => {
    expect(kinds('ALTER TABLE "users" RENAME COLUMN "name" TO "full_name";')).toEqual(['rename'])
    expect(kinds('ALTER TABLE "users" RENAME TO "people";')).toEqual(['rename'])
    expect(kinds('RENAME TABLE `users` TO `people`;')).toEqual(['rename'])
    expect(kinds('ALTER TABLE `users` CHANGE COLUMN `name` `full_name` text;')).toEqual(['rename', 'alter-column-type'])
  })

  test('should report TRUNCATE and an unfiltered DELETE, not a filtered one', () => {
    expect(kinds('TRUNCATE TABLE "sessions";')).toEqual(['truncate'])
    expect(kinds('DELETE FROM "sessions";')).toEqual(['delete-all'])
    expect(kinds('DELETE FROM "sessions" WHERE "expires_at" < now();')).toEqual([])
  })

  test('should report DROP SCHEMA and every table of a multi-table DROP', () => {
    expect(kinds('DROP SCHEMA "billing" CASCADE;')).toEqual(['drop-schema'])
    expect(scanMigrationSql('DROP TABLE IF EXISTS "a", "b";').statements.map((s) => s.table)).toEqual(['a', 'b'])
  })

  test('should report each action of a combined ALTER TABLE', () => {
    expect(kinds('ALTER TABLE t DROP COLUMN a, ADD COLUMN b text, ALTER COLUMN c TYPE int;')).toEqual([
      'drop-column',
      'alter-column-type',
    ])
  })

  test('should not report constraint and index drops, or column default changes', () => {
    expect(kinds('ALTER TABLE "users" DROP CONSTRAINT "users_email_unique";')).toEqual([])
    expect(kinds('ALTER TABLE `users` DROP INDEX `users_email_unique`;')).toEqual([])
    expect(kinds('ALTER TABLE "users" ALTER COLUMN "age" DROP DEFAULT;')).toEqual([])
    expect(kinds('ALTER TABLE "users" ALTER COLUMN "age" SET NOT NULL;')).toEqual([])
    expect(kinds('DROP INDEX "users_age_idx";')).toEqual([])
  })

  test('should ignore the words inside comments, strings and quoted identifiers', () => {
    const sql = [
      '-- DROP TABLE "users";',
      "/* DROP TABLE x; */ INSERT INTO notes (body) VALUES ('DROP TABLE users; it''s fine');",
      'CREATE TABLE "drop table" ("id" integer);',
    ].join('\n')
    expect(kinds(sql)).toEqual([])
  })

  test('should scan a dollar-quoted DO block as SQL', () => {
    const findings = scanMigrationSql('SELECT 1;\nDO $$\nBEGIN\n  DROP TABLE legacy;\nEND\n$$;').statements
    expect(findings).toMatchObject([{ kind: 'drop-table', table: 'legacy', line: 4 }])
  })

  test('should report an unterminated string as unreadable rather than pass what follows', () => {
    expect(scanMigrationSql("INSERT INTO t VALUES ('oops);\nDROP TABLE t;").statements).toMatchObject([
      { kind: 'unreadable', line: 1 },
    ])
  })

  test('should read the marker and its reason only from a comment', () => {
    expect(scanMigrationSql('-- guren:allow-destructive: posts moved to articles\nDROP TABLE posts;').acknowledged).toEqual({
      line: 1,
      reason: 'posts moved to articles',
    })
    expect(scanMigrationSql('-- guren:allow-destructive\nDROP TABLE posts;').acknowledged).toEqual({ line: 1 })
    expect(scanMigrationSql("SELECT '-- guren:allow-destructive';\nDROP TABLE posts;").acknowledged).toBeNull()
    expect(scanMigrationSql('-- guren:allow-destructiveness\nDROP TABLE posts;').acknowledged).toBeNull()
  })

  test('should keep schema qualification so a table in another schema is not exempted', () => {
    const source = (name: string, sql: string): MigrationSource => ({ name, file: `${name}.sql`, scan: scanMigrationSql(sql) })
    const report = judgeMigrations([
      source('a', 'CREATE TABLE "users" ("id" integer);'),
      source('b', 'DROP TABLE "archive"."users";'),
    ])
    expect(report.unacknowledged).toMatchObject([{ table: 'archive.users' }])
  })
})

describe('judgeMigrations', () => {
  const source = (name: string, sql: string): MigrationSource => ({ name, file: `${name}.sql`, scan: scanMigrationSql(sql) })

  test('should not let CREATE TABLE IF NOT EXISTS exempt a later drop, since it may have created nothing', () => {
    const report = judgeMigrations([source('a', 'CREATE TABLE IF NOT EXISTS "posts" ("id" integer);'), source('b', 'DROP TABLE "posts";')])
    expect(report.unacknowledged).toMatchObject([{ table: 'posts' }])
  })

  test('should exempt nothing when told the sources are not exactly the pending ones', () => {
    const sources = [source('a', 'CREATE TABLE "posts" ("id" integer);'), source('b', 'DROP TABLE "posts";')]
    expect(judgeMigrations(sources).unacknowledged).toEqual([])
    expect(judgeMigrations(sources, { exemptCreatedInRun: false }).unacknowledged).toMatchObject([{ migration: 'b' }])
  })

  test('should move an acknowledged migration out of the refusals, keeping its findings and reason', () => {
    const report = judgeMigrations([
      { name: 'm1', file: 'm1.sql', scan: scanMigrationSql('-- guren:allow-destructive: archived in #12\nDROP TABLE posts;') },
    ])
    expect(report.unacknowledged).toEqual([])
    expect(report.acknowledged).toMatchObject([{ migration: 'm1', reason: 'archived in #12', findings: [{ kind: 'drop-table' }] }])
  })

  test('should report a type change whose snapshots are missing', () => {
    const report = judgeMigrations([{ name: 'm', file: 'm.sql', scan: scanMigrationSql('ALTER TABLE t ALTER COLUMN c TYPE bigint;') }])
    expect(report.unacknowledged).toHaveLength(1)
  })
})

describe('isWideningTypeChange', () => {
  test.each([
    ['varchar(50)', 'varchar(500)'],
    ['varchar(255)', 'text'],
    ['smallint', 'integer'],
    ['int', 'bigint'],
    ['numeric(10,2)', 'numeric(12,2)'],
    ['text', 'longtext'],
    ['int unsigned', 'bigint unsigned'],
    ['varchar(50)', 'varchar(50)'],
  ])('%s -> %s widens', (before, after) => {
    expect(isWideningTypeChange(before, after)).toBe(true)
  })

  test.each([
    ['varchar(255)', 'varchar(50)'],
    ['text', 'varchar(255)'],
    ['integer', 'smallint'],
    ['numeric(10,2)', 'numeric(10,4)'],
    ['int', 'int unsigned'],
    ['integer', 'text'],
    ['timestamp', 'timestamptz'],
    ['jsonb', 'json'],
  ])('%s -> %s does not', (before, after) => {
    expect(isWideningTypeChange(before, after)).toBe(false)
  })
})
