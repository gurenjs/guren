import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { sql } from 'drizzle-orm'
import { integer, pgTable, serial, varchar } from 'drizzle-orm/pg-core'
import { createPostgresDatabase, type PostgresDatabase } from '../src/postgres'
import { Model, type PaginatedResult, type TransactionHandle } from '../src/Model'
import { DrizzleAdapter } from '../src/adapters/drizzle-adapter'

// The unit tests in postgres.test.ts mock `postgres` and the migrator away, so
// they can assert that a migration run *happens* but never that the database
// ends up usable. CI supplies POSTGRES_URL from its postgres service; locally,
// start one with `bun run db:up`. POSTGRES_URL needs a user allowed to create a
// database, since the reset below drops every schema in the one it runs against.
const POSTGRES_URL = process.env.POSTGRES_URL
const describePostgres = POSTGRES_URL ? describe : describe.skip

// Derived rather than taken from POSTGRES_URL, which is the same string a
// scaffolded app puts in DATABASE_URL.
const TEST_DATABASE = 'guren_orm_test'

function databaseUrl(url: string, database: string): string {
  const target = new URL(url)
  target.pathname = `/${database}`
  return target.toString()
}

async function ensureTestDatabase(url: string, database: string = TEST_DATABASE): Promise<void> {
  const { default: postgres } = await import('postgres')
  const admin = postgres(databaseUrl(url, 'postgres'), { max: 1 })
  try {
    const existing = await admin.unsafe(`SELECT 1 FROM pg_database WHERE datname = '${database}'`)
    // Postgres has no CREATE DATABASE IF NOT EXISTS.
    if (existing.length === 0) {
      await admin.unsafe(`CREATE DATABASE "${database}"`)
    }
  } finally {
    await admin.end({ timeout: 0 })
  }
}

function createMigrationsFolder(): string {
  const migrationsFolder = mkdtempSync(join(tmpdir(), 'guren-orm-postgres-integration-'))
  const migrationDir = join(migrationsFolder, '20240101000000_init')
  mkdirSync(migrationDir, { recursive: true })
  writeFileSync(
    join(migrationDir, 'migration.sql'),
    'CREATE TABLE "widgets" ("id" serial PRIMARY KEY NOT NULL, "name" varchar(255) NOT NULL);',
  )
  return migrationsFolder
}

describePostgres('createPostgresDatabase against a real PostgreSQL server (requires POSTGRES_URL)', () => {
  let database: PostgresDatabase

  beforeAll(async () => {
    const url = POSTGRES_URL as string
    await ensureTestDatabase(url)
    database = createPostgresDatabase({
      migrationsFolder: createMigrationsFolder(),
      connectionString: () => databaseUrl(url, TEST_DATABASE),
    })
    await database.resetDatabase()
  })

  afterAll(async () => {
    // beforeAll may have thrown before `database` was assigned — don't mask
    // that failure with a "Cannot read properties of undefined" here.
    await database?.closeDatabase()
  })

  it('runs migrations and queries through the real driver', async () => {
    const db = await database.getDatabase()

    await db.execute(sql`INSERT INTO "widgets" ("name") VALUES ('gear')`)
    const widgets = (await db.execute(sql`SELECT "name" FROM "widgets"`)) as unknown as Array<{ name: string }>
    expect(widgets.map((widget) => widget.name)).toEqual(['gear'])
  })

  it('clears table contents on reset and leaves migrations applied', async () => {
    // Explicit setup rather than relying on what the preceding test (or the
    // reset in beforeAll) left behind: the contract under test must be what
    // fails here, not the fixture.
    await database.migrateDatabase()
    const db = await database.getDatabase()
    await db.execute(sql`INSERT INTO "widgets" ("name") VALUES ('sprocket')`)

    await database.resetDatabase()

    const status = await database.migrationStatus()
    expect(status[0]).toMatchObject({ applied: true })

    // Queryable without an explicit migrateDatabase(): the reset re-applied it.
    // This is the issue-400 repro — the handle predates the reset, so nothing
    // re-migrates on the way to the query.
    const widgets = (await db.execute(sql`SELECT "name" FROM "widgets"`)) as unknown as Array<{ name: string }>
    expect(widgets).toEqual([])
  })

  it('drops views on reset, not just base tables', async () => {
    // `widgets` has to exist for the view to select from it, whatever the
    // preceding test left behind.
    await database.migrateDatabase()
    const db = await database.getDatabase()
    await db.execute(sql`CREATE OR REPLACE VIEW "widget_names" AS SELECT "name" FROM "widgets"`)

    await database.resetDatabase()

    // Only what the migrations rebuild survives — the view is not among them.
    const remaining = (await db.execute(
      sql`SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public'`,
    )) as unknown as Array<{ name: string }>
    expect(remaining.map((row) => row.name)).not.toContain('widget_names')
    expect(remaining.map((row) => row.name)).toContain('widgets')
  })
})

/** Unwinds a transaction after its assertions have run, without failing it. */
class RollbackSignal extends Error {}

// Its own database: the block above resets the one it uses, which drops every
// table in it, and these fixtures have to survive alongside them.
const RELATIONS_DATABASE = 'guren_orm_relations_test'

function createRelationsMigrationsFolder(): string {
  const migrationsFolder = mkdtempSync(join(tmpdir(), 'guren-orm-postgres-relations-'))
  const migrationDir = join(migrationsFolder, '20240101000000_init')
  mkdirSync(migrationDir, { recursive: true })
  writeFileSync(
    join(migrationDir, 'migration.sql'),
    'CREATE TABLE "authors" ("id" serial PRIMARY KEY NOT NULL, "name" varchar(255) NOT NULL);\n'
    // The migrator splits on this marker; the newlines are load-bearing, since
    // `--` would otherwise comment out the statement that follows it.
    + '--> statement-breakpoint\n'
    + 'CREATE TABLE "articles" ("id" serial PRIMARY KEY NOT NULL, "title" varchar(255) NOT NULL,'
    + ' "author_id" integer NOT NULL);\n',
  )
  return migrationsFolder
}

const authorsTable = pgTable('authors', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
})

const articlesTable = pgTable('articles', {
  id: serial('id').primaryKey(),
  title: varchar('title', { length: 255 }).notNull(),
  authorId: integer('author_id').notNull(),
})

type AuthorRecord = typeof authorsTable.$inferSelect
type ArticleRecord = typeof articlesTable.$inferSelect

// Eager loading against a real transaction. A pooled driver is what makes this
// observable at all: the fake adapters hand every query the same store, so a
// relation query that ignores `trx` still returns the uncommitted parent's
// children and the bug reads as correct behavior.
describePostgres('eager loading inside a transaction (requires POSTGRES_URL)', () => {
  let database: PostgresDatabase

  class Author extends Model<AuthorRecord> {
    static override table = authorsTable
  }

  class Article extends Model<ArticleRecord> {
    static override table = articlesTable
  }

  Article.belongsTo('author', Author, 'authorId', 'id')
  Author.hasMany('articles', Article, 'authorId', 'id')

  beforeAll(async () => {
    const url = POSTGRES_URL as string
    await ensureTestDatabase(url, RELATIONS_DATABASE)
    database = createPostgresDatabase({
      migrationsFolder: createRelationsMigrationsFolder(),
      connectionString: () => databaseUrl(url, RELATIONS_DATABASE),
      // The default pool holds a single connection, which would turn the
      // symptom under test into a different one: a relation query that skips
      // the transaction would sit waiting for the connection the transaction
      // is holding rather than returning rows it cannot see. Bun charges a
      // timeout to whichever test runs next, so the failure would not even
      // point here.
      clientOptions: { max: 5 },
    })
    await database.resetDatabase()
    DrizzleAdapter.configure((await database.getDatabase()) as never)
  })

  afterAll(async () => {
    await database?.closeDatabase()
  })

  /**
   * Run a body inside a transaction, then unwind it so its fixtures stay out
   * of later tests. Two things here are load-bearing: the signal is thrown
   * only after the body's assertions have run, and every other error
   * propagates untouched — so a failed assertion still surfaces as itself
   * rather than as a rollback.
   */
  async function inRolledBackTransaction(
    body: (trx: TransactionHandle) => Promise<void>,
  ): Promise<void> {
    await Article.transaction(async (trx) => {
      await body(trx)
      throw new RollbackSignal()
    }).catch((error: unknown) => {
      if (!(error instanceof RollbackSignal)) throw error
    })
  }

  it('loads a belongsTo relation on the transaction that read its parent', async () => {
    await inRolledBackTransaction(async (trx) => {
      const author = (await Author.create({ name: 'Ada' }, { trx })) as AuthorRecord
      const article = (await Article.create(
        { title: 'On Engines', authorId: author.id },
        { trx },
      )) as ArticleRecord

      // The premise: nothing outside the transaction can see either row yet,
      // so a relation query that runs on the pool has no author to find. If
      // this ever stops holding, the assertion below passes for free.
      const fromPool = await Author.find(author.id)
      expect(fromPool).toBeNull()

      const [loaded] = (await Article.newQuery({ trx })
        .where('id', article.id)
        .with('author')
        .get()) as Array<ArticleRecord & { author: AuthorRecord | null }>

      expect(loaded.author).toMatchObject({ id: author.id, name: 'Ada' })

      // Rolling back keeps the fixture out of later runs; the assertions above
      // have already been made, so a failure still surfaces as itself.
    })
  })

  it('loads relations through paginate() on the transaction', async () => {
    await inRolledBackTransaction(async (trx) => {
      const author = (await Author.create({ name: 'Grace' }, { trx })) as AuthorRecord
      await Article.create({ title: 'On Compilers', authorId: author.id }, { trx })

      const page = (await Article.newQuery({ trx })
        .where('authorId', author.id)
        .with('author')
        .paginate(1, 10)) as PaginatedResult<ArticleRecord & { author: AuthorRecord | null }>

      expect(page.data).toHaveLength(1)
      expect(page.data[0].author).toMatchObject({ name: 'Grace' })

    })
  })

  it('loads a hasMany relation on the transaction that read its parent', async () => {
    await inRolledBackTransaction(async (trx) => {
      const author = (await Author.create({ name: 'Barbara' }, { trx })) as AuthorRecord
      await Article.create({ title: 'On Genomes', authorId: author.id }, { trx })

      const [loaded] = (await Author.newQuery({ trx })
        .where('id', author.id)
        .with('articles')
        .get()) as Array<AuthorRecord & { articles: ArticleRecord[] }>

      expect(loaded.articles.map((article) => article.title)).toEqual(['On Genomes'])

    })
  })

  it('carries the transaction down a nested relation path', async () => {
    // The recursion in loadRelationInto() re-enters on the related model, so
    // the second hop has its own chance to fall back to the pool.
    await inRolledBackTransaction(async (trx) => {
      const author = (await Author.create({ name: 'Katherine' }, { trx })) as AuthorRecord
      await Article.create({ title: 'On Orbits', authorId: author.id }, { trx })

      const [loaded] = (await Author.newQuery({ trx })
        .where('id', author.id)
        .with('articles.author')
        .get()) as Array<AuthorRecord & { articles: Array<ArticleRecord & { author: AuthorRecord | null }> }>

      expect(loaded.articles[0]?.author).toMatchObject({ name: 'Katherine' })

    })
  })

  it('counts related rows on the transaction with withCount()', async () => {
    await inRolledBackTransaction(async (trx) => {
      const author = (await Author.create({ name: 'Radia' }, { trx })) as AuthorRecord
      await Article.create({ title: 'On Trees', authorId: author.id }, { trx })
      await Article.create({ title: 'On Bridges', authorId: author.id }, { trx })

      const [loaded] = (await Author.withCount('articles', { id: author.id }, { trx })) as Array<
        AuthorRecord & { articlesCount: number }
      >

      expect(loaded.articlesCount).toBe(2)

    })
  })
})
