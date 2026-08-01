import { mock } from 'bun:test'
import { consola as realConsola } from 'consola'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

export interface TempWorkspace {
  dir: string
  originalCwd: string
  cleanup: () => Promise<void>
}

/**
 * Write a fake installed package into node_modules, with optional extra
 * files relative to the package directory.
 */
export async function writeInstalledPackage(
  name: string,
  packageJson: Record<string, unknown>,
  files: Record<string, string> = {},
  baseDir: string = process.cwd(),
): Promise<void> {
  const packageDir = join(baseDir, 'node_modules', name)
  await mkdir(packageDir, { recursive: true })
  await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name, ...packageJson }, null, 2))

  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = join(packageDir, relativePath)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, content)
  }
}

/**
 * Write a fake locally-installed package the way Bun materializes `file:`,
 * `link:`, and `workspace:` dependencies: node_modules/<name> is a real
 * directory tree whose files are individual symlinks into the source
 * directory.
 */
export async function linkInstalledPackage(
  name: string,
  packageJson: Record<string, unknown>,
  files: Record<string, string> = {},
  baseDir: string = process.cwd(),
): Promise<void> {
  const sourceDir = join(baseDir, 'local-packages', name)
  const packageDir = join(baseDir, 'node_modules', name)

  const contents: Record<string, string> = {
    'package.json': JSON.stringify({ name, ...packageJson }, null, 2),
    ...files,
  }

  for (const [relativePath, content] of Object.entries(contents)) {
    const sourcePath = join(sourceDir, relativePath)
    await mkdir(dirname(sourcePath), { recursive: true })
    await writeFile(sourcePath, content)

    const linkPath = join(packageDir, relativePath)
    await mkdir(dirname(linkPath), { recursive: true })
    await symlink(sourcePath, linkPath)
  }
}

/**
 * The `db/schema.ts` a fresh app starts from, per dialect. Kept in the shape
 * `create-guren-app` scaffolds so the patchers are exercised against what
 * users actually have on disk — notably, MySQL apps import their builders
 * from `drizzle-orm/mysql-core`, never from the PostgreSQL-first
 * `@guren/orm/drizzle` subpath.
 */
export const PG_SCHEMA_FIXTURE = `import { pgTable, serial, text, timestamp } from '@guren/orm/drizzle'

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})
`

export const MYSQL_SCHEMA_FIXTURE = `import { mysqlTable, int, varchar, timestamp } from 'drizzle-orm/mysql-core'

export const users = mysqlTable('users', {
  id: int('id').primaryKey().autoincrement(),
  name: varchar('name', { length: 255 }).notNull(),
  email: varchar('email', { length: 255 }).notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})
`

export const SQLITE_SCHEMA_FIXTURE = `import { sqliteTable, integer, text } from '@guren/orm/drizzle'

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  email: text('email').notNull(),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
})
`

export async function createTempWorkspace(prefix: string): Promise<TempWorkspace> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  const originalCwd = process.cwd()
  process.chdir(dir)

  return {
    dir,
    originalCwd,
    async cleanup() {
      process.chdir(originalCwd)
      await rm(dir, { recursive: true, force: true })
    },
  }
}

/**
 * A consola stand-in that silences output without hiding the rest of the API.
 *
 * `mock.module()` is not undone between files in Bun's shared process, so a
 * hand-listed stub silently breaks any later file that calls a method it forgot
 * — which is how `box` came to be missing. Inheriting from the real instance
 * keeps every other method callable; the printing ones are shadowed explicitly,
 * because inherited ones still reach the real logger.
 */
export function createConsolaStub(extra: Record<string, unknown> = {}): typeof realConsola {
  return Object.assign(Object.create(realConsola) as typeof realConsola, {
    info: mock(() => {}),
    success: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    log: mock(() => {}),
    box: mock(() => {}),
    ...extra,
  })
}
