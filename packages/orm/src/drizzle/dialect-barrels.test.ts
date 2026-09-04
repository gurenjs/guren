import { describe, test, expect } from 'bun:test'
import { getTableColumns } from 'drizzle-orm'
import * as pgCore from 'drizzle-orm/pg-core'
import * as mysqlCore from 'drizzle-orm/mysql-core'
import * as sqliteCore from 'drizzle-orm/sqlite-core'

import * as pg from './pg'
import * as mysql from './mysql'
import * as sqlite from './sqlite'
import * as mixed from '../drizzle'

describe('per-dialect barrels', () => {
  // Derived from the dialect core's own export surface: narrowing `export *`
  // to a curated list must fail here.
  const barrels = [
    ['pg', pg, pgCore],
    ['mysql', mysql, mysqlCore],
    ['sqlite', sqlite, sqliteCore],
  ] as const

  for (const [name, barrel, core] of barrels) {
    test(`${name} re-exports drizzle-orm/${name}-core wholesale plus sql`, () => {
      const missing = Object.keys(core).filter((key) => !(key in barrel))
      expect(missing).toEqual([])
      expect(typeof barrel.sql).toBe('function')
    })
  }

  test('pg varchar is the Postgres builder, so pgTable assembles without throwing', () => {
    // The mixed barrel's varchar is the MySQL builder; pgTable throws
    // `colBuilder.buildExtraConfigColumn is not a function` on it (#379).
    const probe = pg.pgTable('probe', {
      id: pg.serial('id').primaryKey(),
      name: pg.varchar('name', { length: 20 }),
    })

    expect(getTableColumns(probe).name).toBeInstanceOf(pg.PgColumn)
  })

  test('mysql varchar is the MySQL builder, so mysqlTable assembles without throwing', () => {
    const probe = mysql.mysqlTable('probe', {
      id: mysql.int('id').primaryKey().autoincrement(),
      name: mysql.varchar('name', { length: 20 }),
    })

    expect(getTableColumns(probe).name).toBeInstanceOf(mysql.MySqlColumn)
  })

  test('sqliteTable assembles from the barrel alone', () => {
    const probe = sqlite.sqliteTable('probe', {
      id: sqlite.integer('id').primaryKey({ autoIncrement: true }),
      name: sqlite.text('name').notNull(),
    })

    expect(getTableColumns(probe).name).toBeInstanceOf(sqlite.SQLiteColumn)
  })
})

describe('@guren/orm/drizzle (mixed barrel, kept for compatibility)', () => {
  test('the MySQL exports still resolve to the MySQL builders', () => {
    // Pinned so removing the MySQL exports (a breaking change) is a
    // deliberate major-release decision, not a drive-by edit.
    expect(mixed.varchar).toBe(mysqlCore.varchar)
    expect(mixed.mysqlTable).toBe(mysqlCore.mysqlTable)
    expect(mixed.int).toBe(mysqlCore.int)
    expect(mixed.datetime).toBe(mysqlCore.datetime)
  })

  test('the unqualified helpers stay pg-core, and sql stays available', () => {
    expect(mixed.pgTable).toBe(pgCore.pgTable)
    expect(mixed.integer).toBe(pgCore.integer)
    expect(typeof mixed.sql).toBe('function')
  })
})

// These require a built dist/ (`bun run build`).
describe('dist artifacts', () => {
  test('every exports-map entry points at a file that exists in dist', async () => {
    // Checked on the filesystem: Bun resolves `@guren/orm/*` through the root
    // tsconfig paths straight to src/, so an import-based check would stay
    // green with a broken map.
    const packageRoot = new URL('../../', import.meta.url)
    const pkg = await Bun.file(new URL('package.json', packageRoot)).json()

    const missing: string[] = []
    for (const [subpath, targets] of Object.entries<Record<string, string>>(pkg.exports)) {
      for (const target of Object.values(targets)) {
        if (!(await Bun.file(new URL(target, packageRoot)).exists())) {
          missing.push(`${subpath} -> ${target}`)
        }
      }
    }

    expect(missing).toEqual([])
  })

  test('each dist dialect entry re-exports its own dialect core', async () => {
    for (const name of ['pg', 'mysql', 'sqlite'] as const) {
      const js = await Bun.file(new URL(`../../dist/drizzle/${name}.js`, import.meta.url)).text()
      expect(js).toContain(`drizzle-orm/${name}-core`)
    }
  })

  test('the @deprecated JSDoc survives the dts rollup for the MySQL value exports', async () => {
    // The rollup drops JSDoc on `export { … } from`, which is why the mixed
    // barrel re-declares these as consts. Only the artifact can show a regress.
    const dts = await Bun.file(new URL('../../dist/drizzle.d.ts', import.meta.url)).text()

    for (const name of ['mysqlTable', 'int', 'varchar', 'datetime']) {
      const deprecatedJsdocAbove = new RegExp(
        String.raw`/\*\*(?:(?!\*/)[\s\S])*@deprecated(?:(?!\*/)[\s\S])*\*/\s*declare const ${name}\b`,
      )
      expect(dts).toMatch(deprecatedJsdocAbove)
    }
  })
})
