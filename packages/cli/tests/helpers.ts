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

export const SQLITE_SCHEMA_FIXTURE = `import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core'

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  email: text('email').notNull(),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
})
`

/**
 * The `routes/web.ts` the two app templates scaffold.
 *
 * The blog one is the shape that broke every route-wiring patch: it names the
 * registrar's parameter `baseRouter` and rebinds it to `router` inside the
 * body, because `aliasMiddleware()` has to be captured for the return type
 * that carries the alias names. Kept here so the parser, the blueprints, and
 * `make:auth` are all tested against one copy of what users have on disk.
 */
export const DEFAULT_ROUTES_FIXTURE = `import { Router } from '@guren/core'

export function registerWebRoutes(router: Router): void {
  router.get('/', () => 'home')
}

export default registerWebRoutes
`

/**
 * Whether `chmod 0o000` actually denies this process a read.
 *
 * It does not for uid 0, so a test that makes a file unreadable and asserts the
 * graceful path would simply take the readable path and pass having proved
 * nothing. CI runs unprivileged, but a root container (a local `docker run`) is
 * one command away — better an explicit skip there than a vacuous green.
 */
export const CAN_DENY_FILE_READS = process.getuid === undefined || process.getuid() !== 0

/**
 * The api-only starter's entry file: `routes/api.ts`, and no `routes/web.ts`
 * anywhere. Scaffolders that emit Inertia pages have nothing to write into an
 * app shaped like this.
 */
export const API_ROUTES_FIXTURE = `import { Router } from '@guren/core'

export function registerApiRoutes(router: Router): void {
  router.get('/health', (c) => c.json({ status: 'ok' }))
}
`

/**
 * The api-only starter reduced to the two signals `isConfirmedApiOnlyApp`
 * reads: a manifest that does not name `@guren/inertia-client`, and no
 * `routes/web.ts`. One copy, so the dependency set the refusal tests pin
 * cannot drift between files. `blueprints.test.ts` anchors this reduction to
 * the real `create-app/templates/api-only` files.
 */
export async function seedApiOnlyWorkspace(dir: string): Promise<void> {
  await writeWorkspaceFiles(dir, {
    'routes/api.ts': API_ROUTES_FIXTURE,
    'package.json': JSON.stringify({
      name: 'api-app',
      dependencies: { '@guren/cli': '^2.2.0', '@guren/core': '^1.5.1', '@guren/orm': '^2.2.0' },
    }),
  })
}

export const BLOG_ROUTES_FIXTURE = `import { Router, requireAuthenticated } from '@guren/core'

export function registerWebRoutes(baseRouter: Router): void {
  const router = baseRouter.aliasMiddleware('auth', requireAuthenticated({ redirectTo: '/login' }))

  router.get('/', () => 'home')
}

export default registerWebRoutes
`

/** A routes file with no registrar to patch — the loud-failure path. */
export const REGISTRAR_LESS_ROUTES_FIXTURE = `import { Router } from '@guren/core'

const router = new Router()
router.get('/', () => 'home')

export default router
`

/**
 * Runs `task` with `consola.warn` collecting into an array instead of
 * printing. Scoped to the call and restored in a `finally`, unlike
 * `createConsolaStub`, which is for the process-wide `mock.module('consola')`
 * path and cannot observe a module that imported consola directly.
 */
export async function captureWarnings<T>(task: () => Promise<T>): Promise<{ result: T; warnings: string[] }> {
  const warnings: string[] = []
  const original = realConsola.warn
  realConsola.warn = ((...args: unknown[]) => {
    warnings.push(args.map(String).join(' '))
  }) as typeof realConsola.warn

  try {
    return { result: await task(), warnings }
  } finally {
    realConsola.warn = original
  }
}

/** Materialize a fixture tree from `relative path → contents` under `dir`. */
export async function writeWorkspaceFiles(
  dir: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [relPath, contents] of Object.entries(files)) {
    const filePath = join(dir, relPath)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, contents, 'utf8')
  }
}

/**
 * Known hazard, deliberately left in place: the `process.chdir()` below is
 * global state in Bun's shared test process, so a test that overruns can
 * chdir and `rm -rf` out from under whichever test started meanwhile. See
 * packages/create-app/tests/helpers.ts, where the same helper dropped it.
 * Untangling it here is a real refactor rather than a test-side edit — most
 * of this package's commands resolve paths against `process.cwd()`, and
 * several test files chdir directly instead of going through this helper.
 */
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
