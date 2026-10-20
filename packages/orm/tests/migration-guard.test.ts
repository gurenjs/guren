import { describe, expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  isWideningTypeChange,
  judgeMigrations,
  readMigrationSources,
  scanMigrationSql,
  type DestructiveKind,
  type MigrationDialect,
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

  test('should let CREATE TABLE IF NOT EXISTS exempt a later statement, as drizzle-kit 0.x wrote every create', () => {
    const report = judgeMigrations([
      source('a', 'CREATE TABLE IF NOT EXISTS "users" ("email_verified_at" timestamp);'),
      source('b', 'ALTER TABLE "users" ALTER COLUMN "email_verified_at" SET DATA TYPE timestamp with time zone;'),
    ])
    expect(report.unacknowledged).toEqual([])
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

describe('review regressions (PR #1206)', () => {
  const types = (entries: Array<[schema: string, table: string, column: string, type: string]>) =>
    new Map(entries.map(([schema, table, column, type]) => [[schema, table, column].join('\u0000'), type]))
  const source = (sql: string, columnTypes?: MigrationSource['columnTypes']): MigrationSource => ({ name: 'm', file: 'm.sql', scan: scanMigrationSql(sql), ...(columnTypes ? { columnTypes } : {}) })

  test('should report a narrowing cast that a repeated snapshot calls unchanged', () => {
    const same = types([['public', 'posts', 'title', 'varchar(255)']])
    const report = judgeMigrations([
      source('ALTER TABLE "posts" ALTER COLUMN "title" TYPE varchar(5) USING "title"::varchar(5);', { before: same, after: same }),
    ])
    expect(report.unacknowledged).toMatchObject([{ kind: 'alter-column-type' }])
  })

  test('should report a widening whose USING rewrites the values', () => {
    const before = types([['public', 'posts', 'title', 'varchar(50)']])
    const after = types([['public', 'posts', 'title', 'varchar(500)']])
    const report = judgeMigrations([
      source('ALTER TABLE "posts" ALTER COLUMN "title" SET DATA TYPE varchar(500) USING left("title", 1);', { before, after }),
    ])
    expect(report.unacknowledged).toHaveLength(1)
  })

  test("should not let archive.posts borrow public.posts's widening evidence", () => {
    const before = types([['public', 'posts', 'title', 'varchar(50)']])
    const after = types([['public', 'posts', 'title', 'varchar(500)']])
    const report = judgeMigrations([
      source('ALTER TABLE "archive"."posts" ALTER COLUMN "title" SET DATA TYPE varchar(500) USING "title"::varchar(500);', { before, after }),
    ])
    expect(report.unacknowledged).toHaveLength(1)
  })

  test('should not call varchar to tinytext widening', () => {
    expect(isWideningTypeChange('varchar(500)', 'tinytext')).toBe(false)
    expect(isWideningTypeChange('varchar(500)', 'text')).toBe(true)
  })

  test('should report a rebuild whose copy is emptied before the original is dropped', () => {
    const columns = types([['', 'posts', 'id', 'integer']])
    const sql = [
      'CREATE TABLE `__new_posts` (`id` integer PRIMARY KEY);',
      'INSERT INTO `__new_posts`(`id`) SELECT `id` FROM `posts`;',
      'DELETE FROM `__new_posts`;',
      'DROP TABLE `posts`;',
      'ALTER TABLE `__new_posts` RENAME TO `posts`;',
    ].join('\n')
    expect(judgeMigrations([source(sql, { before: columns, after: columns })]).unacknowledged).toMatchObject([{ kind: 'table-rebuild', line: 4 }])
  })

  test('should read SQLite bracket and string identifiers', () => {
    expect(kinds('DROP TABLE [posts];')).toEqual(['drop-table'])
    expect(kinds("DROP TABLE 'posts';")).toEqual(['drop-table'])
    expect(scanMigrationSql('ALTER TABLE [posts] DROP COLUMN title;').statements).toMatchObject([{ kind: 'drop-column', table: 'posts', column: 'title' }])
  })

  test('should report a destructive statement whose target cannot be read, rather than pass it', () => {
    expect(kinds('DROP TABLE ;')).toEqual(['drop-table'])
    expect(kinds('ALTER TABLE ( ) DROP COLUMN x;')).toEqual(['unreadable'])
  })

  test('should judge each DELETE on the WHERE at its own depth', () => {
    expect(kinds('WITH x AS (DELETE FROM scratch WHERE false RETURNING *) DELETE FROM posts;')).toEqual(['delete-all'])
    expect(kinds('DELETE FROM posts USING (SELECT id FROM other WHERE id > 0) x;')).toEqual(['delete-all'])
    expect(kinds('DELETE QUICK FROM posts;')).toEqual(['delete-all'])
    expect(kinds('DELETE LOW_PRIORITY FROM posts;')).toEqual(['delete-all'])
    expect(kinds('DELETE posts FROM posts JOIN users ON users.id = posts.user_id;')).toEqual(['delete-all'])
    expect(kinds('ALTER TABLE "posts" ADD CONSTRAINT "fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;')).toEqual([])
    expect(kinds('GRANT DELETE ON posts TO app;')).toEqual([])
  })

  test('should report every table of a multi-table TRUNCATE, so a fresh first target exempts nothing else', () => {
    const report = judgeMigrations([source('CREATE TABLE fresh (id int);\nTRUNCATE fresh, posts;')])
    expect(report.unacknowledged).toMatchObject([{ kind: 'truncate', table: 'posts' }])
  })

  test('should read SQL that MySQL executes inside what other dialects call a comment', () => {
    expect(kinds('SELECT 1--1; DROP TABLE posts;')).toEqual(['drop-table'])
    expect(kinds('/*!50000 DROP TABLE posts */;')).toEqual(['drop-table'])
    expect(kinds('-- DROP TABLE posts;')).toEqual([])
    expect(kinds('/* DROP TABLE posts */')).toEqual([])
  })
})

describe('post-merge review of #1206: fail closed', () => {
  const types = (entries: Array<[schema: string, table: string, column: string, type: string]>) =>
    new Map(entries.map(([schema, table, column, type]) => [[schema, table, column].join('\u0000'), type]))
  const dialectKinds = (sql: string, dialect?: MigrationDialect) => scanMigrationSql(sql, { dialect }).statements.map((statement) => statement.kind)

  test('should read a MySQL backslash-escaped quote, so a string cannot hide the statement after it', () => {
    const sql = "INSERT INTO notes VALUES ('it\\''); DROP TABLE users; -- ');"
    expect(dialectKinds(sql, 'mysql')).toEqual(['drop-table'])
    expect(dialectKinds(sql)).toEqual(['drop-table'])
    expect(dialectKinds(sql, 'postgres')).toEqual([])
  })

  test("should read a PostgreSQL E'' string's backslash escapes", () => {
    const sql = "INSERT INTO notes VALUES (E'it\\''); DROP TABLE users; -- ');"
    expect(dialectKinds(sql, 'postgres')).toEqual(['drop-table'])
    expect(dialectKinds(sql)).toEqual(['drop-table'])
  })

  test('should read a MySQL # line comment, so an apostrophe in it opens no string', () => {
    const sql = "# don't\nDROP TABLE users;\n-- '"
    expect(dialectKinds(sql, 'mysql')).toEqual(['drop-table'])
    expect(dialectKinds(sql)).toEqual(['drop-table'])
  })

  test('should scan the body of a CREATE PROCEDURE, FUNCTION or TRIGGER', () => {
    expect(kinds('CREATE PROCEDURE purge() BEGIN DROP TABLE users; END;')).toEqual(['drop-table'])
    expect(kinds('CREATE TRIGGER t AFTER INSERT ON a FOR EACH ROW DROP TABLE users;')).toEqual(['drop-table'])
    expect(kinds("CREATE FUNCTION purge() RETURNS void AS 'DROP TABLE users' LANGUAGE sql;")).toEqual(['drop-table'])
    expect(kinds('CREATE OR REPLACE FUNCTION purge() RETURNS void AS $$ TRUNCATE users $$ LANGUAGE sql;')).toEqual(['truncate'])
  })

  test('should report SQL built at run time as unreadable', () => {
    expect(kinds("DO $$ BEGIN EXECUTE 'DROP TABLE ' || 'users'; END $$;")).toContain('unreadable')
    expect(kinds("DO $$ BEGIN EXECUTE format('DROP TABLE %I', 'users'); END $$;")).toContain('unreadable')
    expect(kinds("DO $$ BEGIN EXECUTE 'DROP TABLE users'; END $$;")).toEqual(['drop-table'])
    expect(kinds('PREPARE s FROM @sql;')).toEqual(['unreadable'])
  })

  test('should report a dropped partition and a DROP … CASCADE', () => {
    expect(kinds('ALTER TABLE logs DROP PARTITION p2024;')).toEqual(['drop-partition'])
    expect(kinds('ALTER TABLE logs TRUNCATE PARTITION p2024;')).toEqual(['truncate'])
    expect(kinds('DROP TYPE "mood" CASCADE;')).toEqual(['drop-cascade'])
    expect(kinds('DROP DOMAIN email CASCADE;')).toEqual(['drop-cascade'])
    expect(kinds('DROP OWNED BY app;')).toEqual(['drop-cascade'])
    expect(kinds('DROP TYPE "mood";')).toEqual([])
    expect(kinds('DROP INDEX "users_email_idx";')).toEqual([])
  })

  test("should read MySQL's bare DECIMAL as DECIMAL(10,0), so (12,2) to DECIMAL is narrowing there", () => {
    expect(isWideningTypeChange('decimal(12,2)', 'decimal', 'mysql')).toBe(false)
    expect(isWideningTypeChange('decimal(12,2)', 'decimal')).toBe(false)
    expect(isWideningTypeChange('decimal(8,0)', 'decimal', 'mysql')).toBe(true)
    expect(isWideningTypeChange('numeric(12,2)', 'numeric', 'postgres')).toBe(true)
  })

  const rebuild = (copyTypes: string, extra = '') => [
    `CREATE TABLE \`__new_users\` (${copyTypes});`,
    'INSERT INTO `__new_users`(`id`, `age`) SELECT `id`, `age` FROM `users`;',
    'DROP TABLE `users`;',
    'ALTER TABLE `__new_users` RENAME TO `users`;',
    extra,
  ].join('\n')
  const sqliteSource = (sql: string, columnTypes: MigrationSource['columnTypes'], foreignKeys?: MigrationSource['foreignKeys']): MigrationSource => ({
    name: 'm', file: 'm.sql', dialect: 'sqlite', scan: scanMigrationSql(sql, { dialect: 'sqlite' }), columnTypes, ...(foreignKeys ? { foreignKeys } : {}),
  })

  test("should judge a rebuild by the copy's SQL types, so a --custom migration's repeated snapshot vouches for nothing", () => {
    const same = types([['', 'users', 'id', 'integer'], ['', 'users', 'age', 'text']])
    const narrowed = sqliteSource(rebuild('`id` integer PRIMARY KEY, `age` integer'), { before: same, after: same })
    expect(judgeMigrations([narrowed]).unacknowledged).toMatchObject([{ kind: 'table-rebuild', table: 'users' }])
    const kept = sqliteSource(rebuild('`id` integer PRIMARY KEY, `age` text DEFAULT \'0\''), { before: same, after: same })
    expect(judgeMigrations([kept]).unacknowledged).toEqual([])
  })

  test('should report a rebuild of a table another table references with ON DELETE CASCADE where foreign keys stay on', () => {
    const columns = types([['', 'users', 'id', 'integer'], ['', 'users', 'age', 'text']])
    const children = [{ table: 'posts', tableTo: 'users', onDelete: 'CASCADE' }]
    const source = sqliteSource(rebuild('`id` integer PRIMARY KEY, `age` text'), { before: columns, after: columns }, { before: children, after: children })
    expect(judgeMigrations([source]).unacknowledged).toMatchObject([{ kind: 'table-rebuild', table: 'users' }])
    expect(judgeMigrations([source], { foreignKeysEnforced: false }).unacknowledged).toEqual([])
    const restricted = sqliteSource(rebuild('`id` integer PRIMARY KEY, `age` text'), { before: columns, after: columns }, {
      before: [{ table: 'posts', tableTo: 'users', onDelete: 'NO ACTION' }],
    })
    expect(judgeMigrations([restricted]).unacknowledged).toEqual([])
  })

  test('should report a rebuild whose SQL declares a cascading reference to the rebuilt table, its own copy included', () => {
    const columns = types([['', 'users', 'id', 'integer'], ['', 'users', 'age', 'text']])
    const selfReferencing = sqliteSource(
      rebuild('`id` integer PRIMARY KEY, `age` text, `parent_id` integer REFERENCES `users`(`id`) ON DELETE cascade'),
      { before: columns, after: columns },
    )
    expect(judgeMigrations([selfReferencing]).unacknowledged).toMatchObject([{ kind: 'table-rebuild' }])
  })

  test('should read the dialect and the foreign keys from the snapshots', () => {
    const { path, names } = folder('sqlite-rebuild')
    const [source] = readMigrationSources(path, [names[2]!])
    expect(source!.dialect).toBe('sqlite')
    expect(source!.foreignKeys?.after).toEqual([{ table: 'posts', tableTo: 'users', onDelete: 'NO ACTION' }])
  })
})
