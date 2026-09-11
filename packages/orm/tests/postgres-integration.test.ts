import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { eq, sql } from 'drizzle-orm'
import { integer, pgTable, serial, timestamp, varchar } from 'drizzle-orm/pg-core'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { createPostgresDatabase, type PostgresDatabase } from '../src/postgres'
import { Model, type PaginatedResult, type TransactionHandle } from '../src/Model'
import { SoftDeletes } from '../src/SoftDeletes'
import { DrizzleAdapter } from '../src/adapters/drizzle-adapter'

// postgres.test.ts mocks `postgres` and the migrator away, so it can assert a
// migration run *happens* but never that the database ends up usable. CI supplies
// POSTGRES_URL from its postgres service; locally, start one with `bun run db:up`.
// POSTGRES_URL needs a user allowed to create a database, since the reset below
// drops every schema in the one it runs against.
const POSTGRES_URL = process.env.POSTGRES_URL
const describePostgres = POSTGRES_URL ? describe : describe.skip

// Derived rather than taken from POSTGRES_URL, which is what an app puts in DATABASE_URL.
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

interface OutsideClient {
  db: PostgresJsDatabase<Record<string, never>>
  close: () => Promise<void>
}

/**
 * A connection of its own, outside every transaction this file opens: a model
 * call inside a callback joins the ambient transaction, so a premise about what
 * other connections can see has to be read through a second client. Selected
 * through drizzle, not the raw driver, so the column mapping still applies.
 */
async function openOutsideClient(url: string, database: string): Promise<OutsideClient> {
  const { default: postgres } = await import('postgres')
  const { drizzle } = await import('drizzle-orm/postgres-js')
  const client = postgres(databaseUrl(url, database), { max: 1 })
  return { db: drizzle({ client }), close: () => client.end({ timeout: 0 }) }
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
    // beforeAll may have thrown before `database` was assigned; don't mask that failure here.
    await database?.closeDatabase()
  })

  it('runs migrations and queries through the real driver', async () => {
    const db = await database.getDatabase()

    await db.execute(sql`INSERT INTO "widgets" ("name") VALUES ('gear')`)
    const widgets = (await db.execute(sql`SELECT "name" FROM "widgets"`)) as unknown as Array<{ name: string }>
    expect(widgets.map((widget) => widget.name)).toEqual(['gear'])
  })

  it('clears table contents on reset and leaves migrations applied', async () => {
    // Explicit setup rather than what the preceding test left behind: the
    // contract under test must be what fails here, not the fixture.
    await database.migrateDatabase()
    const db = await database.getDatabase()
    await db.execute(sql`INSERT INTO "widgets" ("name") VALUES ('sprocket')`)

    await database.resetDatabase()

    const status = await database.migrationStatus()
    expect(status[0]).toMatchObject({ applied: true })

    // issue-400 repro: the handle predates the reset, so nothing re-migrates on
    // the way to the query.
    const widgets = (await db.execute(sql`SELECT "name" FROM "widgets"`)) as unknown as Array<{ name: string }>
    expect(widgets).toEqual([])
  })

  it('separates a missing tracker from a tracker it cannot read', async () => {
    // The SQLSTATEs the absorbed-error rule is written against, measured here
    // rather than assumed: a fresh database (no `drizzle` schema at all) is
    // 42P01 undefined_table, and a tracker whose columns drifted is 42703.
    // Only the first may be reported as "nothing applied" — the second, read
    // as all-pending, invites a re-run of migrations that were applied.
    const db = await database.getDatabase()

    await db.execute(sql`DROP SCHEMA IF EXISTS "drizzle" CASCADE`)
    expect(await database.migrationStatus()).toEqual([
      { name: '20240101000000_init', applied: false, appliedAt: null },
    ])

    await db.execute(sql`CREATE SCHEMA "drizzle"`)
    await db.execute(sql`CREATE TABLE "drizzle"."__drizzle_migrations" ("id" serial PRIMARY KEY)`)
    await expect(database.migrationStatus()).rejects.toThrow(/column "name" does not exist/)

    // Leave a migrated database behind for whatever runs next.
    await database.resetDatabase()
  })

  it('drops views on reset, not just base tables', async () => {
    // `widgets` has to exist for the view to select from it.
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

// Eager loading against a real transaction. Only a pooled driver makes this
// observable: the fake adapters hand every query the same store, so a relation
// query that ignores `trx` still reads as correct.
describePostgres('eager loading inside a transaction (requires POSTGRES_URL)', () => {
  let database: PostgresDatabase
  let outside: OutsideClient

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
      // With the default single-connection pool, a relation query that skips the
      // transaction would block on the connection the transaction holds instead of
      // returning rows it cannot see — and Bun charges that timeout to the next test.
      clientOptions: { max: 5 },
    })
    await database.resetDatabase()
    DrizzleAdapter.configure((await database.getDatabase()) as never)
    outside = await openOutsideClient(url, RELATIONS_DATABASE)
  })

  afterAll(async () => {
    await outside?.close()
    await database?.closeDatabase()
  })

  /**
   * Run a body inside a transaction, then unwind it so its fixtures stay out of
   * later tests. The rollback signal is thrown only after the body's assertions
   * have run, and every other error propagates untouched.
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

      // The premise: nothing outside the transaction can see either row yet, so a
      // relation query on another connection finds no author. If that stops
      // holding, the assertion below passes for free.
      const fromPool = await outside.db.select().from(authorsTable).where(eq(authorsTable.id, author.id))
      expect(fromPool).toEqual([])

      const [loaded] = (await Article.newQuery({ trx })
        .where('id', article.id)
        .with('author')
        .get()) as Array<ArticleRecord & { author: AuthorRecord | null }>

      expect(loaded.author).toMatchObject({ id: author.id, name: 'Ada' })

    })
  })

  it('discards only the inner writes when the outer callback catches the nested error', async () => {
    await inRolledBackTransaction(async (trx) => {
      const author = (await Author.create({ name: 'Barbara' }, { trx })) as AuthorRecord

      await Article.transaction(async (_inner, innerArticle) => {
        await innerArticle.create({ title: 'On Maize', authorId: author.id })
        throw new Error('boom')
      }).catch(() => undefined)

      await Article.create({ title: 'On Transposons', authorId: author.id }, { trx })

      // The nested call ran in a savepoint, so its insert is gone and the
      // outer transaction is still usable.
      const articles = (await Article.newQuery({ trx }).where('authorId', author.id).get()) as ArticleRecord[]
      expect(articles.map((article) => article.title)).toEqual(['On Transposons'])
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

// Its own database, for the same reason the relations block has one.
const SOFT_DELETE_DATABASE = 'guren_orm_soft_delete_test'

function createSoftDeleteMigrationsFolder(): string {
  const migrationsFolder = mkdtempSync(join(tmpdir(), 'guren-orm-postgres-soft-delete-'))
  const migrationDir = join(migrationsFolder, '20240101000000_init')
  mkdirSync(migrationDir, { recursive: true })
  writeFileSync(
    join(migrationDir, 'migration.sql'),
    'CREATE TABLE "notes" ("id" serial PRIMARY KEY NOT NULL, "title" varchar(255) NOT NULL,'
    + ' "deleted_at" timestamp with time zone);\n',
  )
  return migrationsFolder
}

const notesTable = pgTable('notes', {
  id: serial('id').primaryKey(),
  title: varchar('title', { length: 255 }).notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
})

type NoteRecord = typeof notesTable.$inferSelect

// The SoftDeletes mixin builds its own scoped query for every write, so each one
// is a place the caller's `trx` can be dropped. The fake adapters cannot see that
// happen — they hand the pool and the transaction the same store — so only a
// pooled driver makes an escaped write observable.
describePostgres('SoftDeletes inside a transaction (requires POSTGRES_URL)', () => {
  let database: PostgresDatabase
  let outside: OutsideClient

  class Note extends SoftDeletes(Model<NoteRecord>) {
    static override table = notesTable
  }

  beforeAll(async () => {
    const url = POSTGRES_URL as string
    await ensureTestDatabase(url, SOFT_DELETE_DATABASE)
    database = createPostgresDatabase({
      migrationsFolder: createSoftDeleteMigrationsFolder(),
      connectionString: () => databaseUrl(url, SOFT_DELETE_DATABASE),
      // Same reason as the relations block: on a single-connection pool the reads
      // below would block on the connection the transaction holds.
      clientOptions: { max: 5 },
    })
    await database.resetDatabase()
    DrizzleAdapter.configure((await database.getDatabase()) as never)
    outside = await openOutsideClient(url, SOFT_DELETE_DATABASE)
  })

  afterAll(async () => {
    await outside?.close()
    await database?.closeDatabase()
  })

  /**
   * Committed before the transaction opens. A row created *inside* it is invisible
   * to the pool whatever the write did, which would pass every assertion for free.
   */
  async function seedNote(title: string, deletedAt: Date | null = null): Promise<NoteRecord> {
    return (await Note.create({ title, deletedAt })) as NoteRecord
  }

  /** Runs the body in a transaction, then unwinds it without failing the test. */
  async function rolledBack(body: (trx: TransactionHandle) => Promise<void>): Promise<void> {
    await Note.transaction(async (trx) => {
      await body(trx)
      throw new RollbackSignal()
    }).catch((error: unknown) => {
      if (!(error instanceof RollbackSignal)) throw error
    })
  }

  /**
   * Reads on the second connection, which is both outside the open transaction
   * and past the softDelete scope that would otherwise hide the row.
   */
  async function fromPool(id: number): Promise<NoteRecord | null> {
    const [row] = await outside.db.select().from(notesTable).where(eq(notesTable.id, id))
    return row ?? null
  }

  it('unwinds a soft delete made through the transaction-bound scope', async () => {
    const note = await seedNote('scoped-delete')

    await Note.transaction(async (_trx, txNote) => {
      await txNote.delete({ id: note.id })

      // The premise: the write is invisible outside the transaction that made it.
      expect((await fromPool(note.id))?.deletedAt).toBeNull()

      throw new RollbackSignal()
    }).catch((error: unknown) => {
      if (!(error instanceof RollbackSignal)) throw error
    })

    // With the handle dropped, the UPDATE ran on the pool and outlived the rollback.
    expect((await fromPool(note.id))?.deletedAt).toBeNull()
  })

  it('unwinds a soft delete made through the static form', async () => {
    const note = await seedNote('static-delete')

    await rolledBack(async (trx) => {
      await Note.delete({ id: note.id }, { trx })
      expect((await fromPool(note.id))?.deletedAt).toBeNull()
    })

    expect((await fromPool(note.id))?.deletedAt).toBeNull()
  })

  it('unwinds a restore()', async () => {
    const note = await seedNote('trashed-restore', new Date('2020-01-01T00:00:00Z'))

    await rolledBack(async (trx) => {
      await Note.restore({ id: note.id }, { trx })
      expect((await fromPool(note.id))?.deletedAt).not.toBeNull()
    })

    expect((await fromPool(note.id))?.deletedAt).not.toBeNull()
  })

  it('unwinds a forceDelete()', async () => {
    const note = await seedNote('trashed-force', new Date('2020-01-01T00:00:00Z'))

    await rolledBack(async (trx) => {
      await Note.forceDelete({ id: note.id }, { trx })
      expect(await fromPool(note.id)).not.toBeNull()
    })

    // A hard delete that escapes the rollback cannot be undone.
    expect(await fromPool(note.id)).not.toBeNull()
  })

  it('reads rows the transaction trashed with withTrashed() and onlyTrashed()', async () => {
    await rolledBack(async (trx) => {
      const note = (await Note.create({ title: 'tx-trashed', deletedAt: null }, { trx })) as NoteRecord
      await Note.delete({ id: note.id }, { trx })

      expect(await Note.onlyTrashed({ trx }).where('id', note.id).get()).toHaveLength(1)
      expect(await Note.withTrashed({ trx }).where('id', note.id).get()).toHaveLength(1)

      // On another connection the row does not exist yet, trashed or not.
      expect(await fromPool(note.id)).toBeNull()
    })
  })
})
