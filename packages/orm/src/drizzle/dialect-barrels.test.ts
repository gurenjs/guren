import { describe, test, expect } from 'bun:test'
import { getTableColumns } from 'drizzle-orm'

import * as pg from './pg'
import * as mysql from './mysql'
import * as sqlite from './sqlite'
import * as mixed from '../drizzle'

describe('@guren/orm/drizzle/pg', () => {
  test('varchar is the Postgres builder, so pgTable assembles without throwing', () => {
    // The mixed barrel's varchar is the MySQL builder; pgTable throws
    // `colBuilder.buildExtraConfigColumn is not a function` on it (#379).
    const probe = pg.pgTable('probe', {
      id: pg.serial('id').primaryKey(),
      name: pg.varchar('name', { length: 20 }),
    })

    const columns = getTableColumns(probe)
    expect(columns.name).toBeInstanceOf(pg.PgColumn)
  })

  test('exports the builders a real schema needs beyond the mixed barrel', () => {
    const missing = [
      'varchar',
      'unique',
      'index',
      'primaryKey',
      'foreignKey',
      'pgEnum',
      'numeric',
      'date',
      'uniqueIndex',
    ].filter((name) => typeof (pg as Record<string, unknown>)[name] !== 'function')

    expect(missing).toEqual([])
  })

  test('exports sql from drizzle-orm', () => {
    expect(typeof pg.sql).toBe('function')
  })
})

describe('@guren/orm/drizzle/mysql', () => {
  test('varchar is the MySQL builder, so mysqlTable assembles without throwing', () => {
    const probe = mysql.mysqlTable('probe', {
      id: mysql.int('id').primaryKey().autoincrement(),
      name: mysql.varchar('name', { length: 20 }),
    })

    const columns = getTableColumns(probe)
    expect(columns.name).toBeInstanceOf(mysql.MySqlColumn)
  })

  test('exports sql from drizzle-orm', () => {
    expect(typeof mysql.sql).toBe('function')
  })
})

describe('@guren/orm/drizzle/sqlite', () => {
  test('sqliteTable assembles from the barrel alone', () => {
    const probe = sqlite.sqliteTable('probe', {
      id: sqlite.integer('id').primaryKey({ autoIncrement: true }),
      name: sqlite.text('name').notNull(),
    })

    const columns = getTableColumns(probe)
    expect(columns.name).toBeInstanceOf(sqlite.SQLiteColumn)
  })

  test('exports sql from drizzle-orm', () => {
    expect(typeof sqlite.sql).toBe('function')
  })
})

describe('@guren/orm/drizzle (mixed barrel, kept for compatibility)', () => {
  test('the MySQL exports still resolve to the MySQL builders', async () => {
    // Pinned so removing the MySQL exports (a breaking change) is a
    // deliberate major-release decision, not a drive-by edit.
    const mysqlCore = await import('drizzle-orm/mysql-core')
    expect(mixed.varchar).toBe(mysqlCore.varchar)
    expect(mixed.mysqlTable).toBe(mysqlCore.mysqlTable)
    expect(mixed.int).toBe(mysqlCore.int)
    expect(mixed.datetime).toBe(mysqlCore.datetime)
  })
})

describe('package exports map', () => {
  // Self-referencing imports resolve through package.json `exports` into
  // dist/, so these fail on a subpath mapping typo the source-relative
  // imports above cannot see. They require a built dist/ (`bun run build`),
  // like the CLI tests that load @guren/server through its dist.
  test('each dialect subpath resolves to its dialect, not a colliding name', async () => {
    const [pgDist, mysqlDist, pgCore, mysqlCore, sqliteDist, sqliteCore] = await Promise.all([
      import('@guren/orm/drizzle/pg'),
      import('@guren/orm/drizzle/mysql'),
      import('drizzle-orm/pg-core'),
      import('drizzle-orm/mysql-core'),
      import('@guren/orm/drizzle/sqlite'),
      import('drizzle-orm/sqlite-core'),
    ])

    expect(pgDist.varchar).toBe(pgCore.varchar)
    expect(mysqlDist.varchar).toBe(mysqlCore.varchar)
    expect(sqliteDist.sqliteTable).toBe(sqliteCore.sqliteTable)
  })
})
