import { mock } from 'bun:test'
import { consola as realConsola } from 'consola'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const repoRoot = resolve(import.meta.dir, '../../..')

/** The CLI entry these tests spawn. */
export const CLI_BIN_PATH = join(repoRoot, 'packages/cli/src/bin.ts')

/**
 * The *built* CLI entry, for assertions about how the published package
 * behaves rather than how the sources do. `CLI_BIN_PATH` runs from `src/`,
 * where anything resolved relative to `import.meta.url` lands somewhere else
 * than it does in `dist/`.
 */
export const CLI_DIST_BIN = join(repoRoot, 'packages/cli/dist/bin.js')

/**
 * The built artifact this package's tests reach `@guren/server` through.
 * `@guren/core` resolves to source, but its `export * from '@guren/server'`
 * follows the workspace symlink to server's `exports`, which point at
 * `dist/index.js` (see .claude/rules/common-pitfalls.md).
 */
export const SERVER_DIST_ENTRY = join(repoRoot, 'packages/server/dist/index.js')

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
 * Point a fixture app's `@guren/core` at this checkout.
 *
 * A fixture that gets imported rather than only parsed — `guren context`
 * loads `routes/*.ts` for real — needs the import to resolve from a temp
 * directory that has no node_modules. Bun resolves that by walking up from
 * the file and then falling back to its global install cache, so on a machine
 * that has ever installed Guren the fixture silently binds to the *published*
 * package (verified: `~/.bun/install/cache/@guren/core@1.7.0/dist/index.js`),
 * and on a machine that has not, the import throws. Either way the test is
 * measuring the environment. This makes it measure the workspace.
 */
export async function linkWorkspaceCore(baseDir: string): Promise<void> {
  const linkPath = join(baseDir, 'node_modules', '@guren', 'core')
  await mkdir(dirname(linkPath), { recursive: true })
  await symlink(join(repoRoot, 'packages', 'core'), linkPath, 'dir')
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
 * users actually have on disk — each dialect imports its builders from its
 * own `@guren/orm/drizzle/<dialect>` barrel.
 */
export const PG_SCHEMA_FIXTURE = `import { pgTable, serial, text, timestamp } from '@guren/orm/drizzle/pg'

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})
`

export const MYSQL_SCHEMA_FIXTURE = `import { mysqlTable, int, varchar, timestamp } from '@guren/orm/drizzle/mysql'

export const users = mysqlTable('users', {
  id: int('id').primaryKey().autoincrement(),
  name: varchar('name', { length: 255 }).notNull(),
  email: varchar('email', { length: 255 }).notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})
`

export const SQLITE_SCHEMA_FIXTURE = `import { sqliteTable, integer, text } from '@guren/orm/drizzle/sqlite'

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  email: text('email').notNull(),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
})
`

/**
 * A routes file that genuinely resolves `@guren/core` at runtime.
 *
 * `Router` is used as a *value*, twice over on purpose. An import used only
 * in type position is erased by the transpiler, so such a fixture never
 * resolves the package at all and cannot detect anything about how it
 * resolved — and the `instanceof` holds only if the fixture got the same
 * class the loading process passed in, which a separately-resolved copy
 * would not be.
 *
 * One copy because two tests are each other's control: linked via
 * {@link linkWorkspaceCore} it must load, unlinked it must fail to resolve.
 * The pair proves nothing unless both run the same fixture.
 */
export const CORE_RESOLVING_ROUTES_FIXTURE = `import { Router } from '@guren/core'

export function registerWebRoutes(router: Router): void {
  if (!(router instanceof Router)) throw new Error('resolved a different @guren/core')
  router.get('/posts', () => new Response('ok')).name('posts.index')
}
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
 * The one spelling of "an app `isConfirmedApiOnlyApp` recognizes", for every
 * test that asks a scaffolder to refuse one.
 *
 * Callers that build a file record rather than seeding a directory spread
 * {@link API_ONLY_APP_FILES} instead. Each caller used to seed its own, and the
 * copies had already drifted in which dependencies they declared — so a change to what the predicate reads would
 * have had to be re-verified against three subtly different apps. `db/schema.ts`
 * is here because a scaffolder that got past the refusal would patch it, and a
 * test cannot assert it was left alone unless it exists.
 */
export const API_ONLY_APP_FILES: Record<string, string> = {
  'routes/api.ts': API_ROUTES_FIXTURE,
  'db/schema.ts': PG_SCHEMA_FIXTURE,
  'package.json': JSON.stringify({
    name: 'api-app',
    dependencies: { '@guren/cli': '^2.2.0', '@guren/core': '^1.5.1', '@guren/orm': '^2.2.0' },
  }),
}

export async function seedApiOnlyApp(dir: string): Promise<void> {
  await writeWorkspaceFiles(dir, API_ONLY_APP_FILES)
}

/**
 * The counterpart to {@link API_ONLY_APP_FILES}: a minimal app the Inertia
 * scaffolders accept. The schema deliberately has no `users` table (makeAuth
 * patches one in, and tests assert on the patch), `src/app.ts` imports the
 * registrar so provider wiring has something to patch, and `Home.tsx` keeps a
 * real `Props` interface — the scaffold-typecheck pages.gen fixture includes
 * its extracted props, so changing it means regenerating that fixture.
 */
export const INERTIA_APP_FILES: Record<string, string> = {
  'src/app.ts': `import { createApp } from '@guren/core'
import registerWebRoutes from '../routes/web.js'

const app = createApp({
  routes: registerWebRoutes,
})

export default app
`,
  'routes/web.ts': DEFAULT_ROUTES_FIXTURE,
  'db/schema.ts': `import { pgTable, serial, text, timestamp } from '@guren/orm/drizzle/pg'

export const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
`,
  'resources/js/pages/Home.tsx': `interface Props { message: string }
export default function Home({ message }: Props) { return <h1>{message}</h1> }
`,
}

export async function seedInertiaApp(dir: string): Promise<void> {
  await writeWorkspaceFiles(dir, INERTIA_APP_FILES)
}

/** One page component, for tests about an app that acquired one it cannot render. */
export const PAGE_COMPONENT_FIXTURE = 'export default function Home() { return null }\n'

/**
 * The middle sentence `assertNotApiOnly` writes into every refusal — the two
 * signals it read. One spelling for the same reason `seedApiOnlyApp` is: the
 * tests used to hand-copy this regex, and a wording change in app-surface.ts
 * would have meant hunting every copy across three files.
 */
export const API_ONLY_REFUSAL = /no @guren\/inertia-client dependency and no routes\/web\.ts/

/**
 * A file from the api-only starter as `create-guren-app` ships it.
 *
 * Read rather than approximated: the reduced fixtures above are how these tests
 * describe a *shape*, not a substitute for the template itself.
 */
export async function readApiOnlyTemplateFile(relativePath: string): Promise<string> {
  return readFile(join(import.meta.dir, '../../create-app/templates/api-only', relativePath), 'utf8')
}

/**
 * The api-only starter as shipped, reduced to the two files
 * `isConfirmedApiOnlyApp` reads — for tests that only need the predicate to
 * recognize a real starter rather than the whole app on disk.
 *
 * `seedApiOnlyApp` above is a hand-written approximation, and an approximation
 * cannot notice the template gaining an `@guren/inertia-client` dependency or a
 * `routes/web.ts`: every synthetic test would stay green while real users
 * stopped being recognized. Whichever behaviour hangs off the predicate — a
 * refusal, or `make:controller` flipping its output dialect — wants one case
 * seeded from the shipped files.
 */
export async function seedShippedApiOnlyApp(dir: string): Promise<void> {
  await writeWorkspaceFiles(dir, {
    'routes/api.ts': await readApiOnlyTemplateFile('routes/api.ts'),
    'package.json': await readApiOnlyTemplateFile('package.json'),
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

/** The `src/app.ts` shape the provider-wiring patches expect. */
export const APP_FIXTURE = `import { createApp } from '@guren/core'

const app = createApp({
  routes: () => {},
  providers: [],
})

export default app
`

/**
 * An app file with no providers array to patch — the provider-wiring twin of
 * `REGISTRAR_LESS_ROUTES_FIXTURE`.
 */
export const PROVIDERLESS_APP_FIXTURE = `import { createApp } from '@guren/core'

const app = createApp({
  routes: () => {},
})

export default app
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

  // Bun's last resort for a bare specifier it cannot resolve is to *install*
  // it — from the global cache, and from npm when the cache misses. A fixture
  // here has no node_modules, so every `@guren/*` import in a file a CLI
  // process actually loads resolves to whatever the machine happens to have
  // installed, or to whatever npm serves today (measured: `@guren/core@1.7.0`
  // from ~/.bun/install/cache on one machine, a fresh 1.8.0 download on a
  // cache miss, and a hard failure on a runner that cannot reach the
  // registry). Disabling it makes an unlinked fixture fail loudly instead of
  // silently binding the *published* package and calling that a test of this
  // checkout. Use `linkWorkspaceCore()` for fixtures that need the real thing.
  //
  // Here rather than in a bunfig of our own, because bunfig lookup is cwd-only
  // (it does not walk up — verified from examples/blog and web/) and this is
  // the cwd the tests spawn CLI processes with. The test *runner* needs no
  // such setting: `bun run` auto-installs and `bun test` does not, so an
  // in-process fixture import cannot reach an ambient copy either way — a
  // canary in tests/fixture-resolution-guard.test.ts pins that, since a Bun
  // that changed it would expose every in-process fixture at once.
  //
  // Written *before* the chdir, deliberately: an await between chdir and the
  // return is a suspension point where a timed-out test abandons the helper
  // with cwd moved and no `cleanup()` to move it back — which the cwd guard
  // then reports against whichever file happened to be running.
  //
  // One consequence to know about: the workspace is therefore never *empty*.
  // `create-app` refuses to scaffold into a non-empty directory (its check is
  // `readdir(dir).length === 0`), so a test pointing `guren new` at one of
  // these needs `--force` — the error it gets otherwise names the directory
  // and nothing about this file.
  await writeFile(join(dir, 'bunfig.toml'), '[install]\nauto = "disable"\n')

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
 * Throw unless every named build artifact exists.
 *
 * An unbuilt checkout does not fail as a wrong answer, it fails as no answer:
 * a spawned CLI dies on module resolution and exits 1, which an exit-code
 * assertion cannot tell apart from the command reporting a real failure — and
 * a test that reads that as a verdict sends the next reader hunting a
 * regression in product code that is fine. Checked as a precondition rather
 * than sniffed from a crash so it also covers the tests that reach built code
 * by importing a fixture, and so it never blames the build for a fixture's own
 * unresolvable import.
 */
export function assertWorkspaceBuilt(artifacts: string[]): void {
  const missing = artifacts.filter((artifact) => !existsSync(artifact))
  if (missing.length === 0) return

  throw new Error(
    [
      'the workspace has not been built — run `bun run build:clean` first:',
      ...missing.map((artifact) => `  missing ${relative(repoRoot, artifact)}`),
    ].join('\n'),
  )
}

// Each checkTypes() call builds a full tsc program. On a warm TypeScript
// cache that takes a few seconds, but in a fresh worktree (cold node_modules,
// no incremental state) a single probe has been measured at 10–25s normally
// and 70s right after a full monorepo build — far past bun:test's 5s default.
// checkTypes() is synchronous, so a timeout cannot interrupt it anyway; the
// limit only needs to sit above the slowest observed cold start, not near it.
export const COLD_TSC_TIMEOUT = 180_000

/**
 * The `compilerOptions` object of a tsconfig.json, as `tsc` reads it. Kept as
 * plain JSON rather than the compiler API's enums: TypeScript 7 ships no
 * JavaScript API, so every compile gate here drives the `tsc` binary.
 */
export type TsconfigCompilerOptions = Record<string, unknown>

/**
 * Base compiler options for compiling a generated module plus its usage probe
 * in a temp directory. Spread and extend rather than mutate — several compile
 * gates share it.
 *
 * No @types scan (`types: []`): the default type-root walk climbs ancestor
 * directories, so a TMPDIR inside a workspace would silently pull in — and
 * type-check — every @types package it finds there.
 */
export const GENERATED_MODULE_COMPILER_OPTIONS: TsconfigCompilerOptions = {
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  target: 'ES2022',
  module: 'ESNext',
  moduleResolution: 'Bundler',
  lib: ['es2022', 'dom'],
  types: [],
}

const TSC_BIN = join(repoRoot, 'node_modules/typescript/bin/tsc')

/**
 * Resolve a tsconfig the way `tsc` does (`extends` chains, defaults) and
 * return its compilerOptions with every relative path (`paths` targets,
 * `rootDir`, `typeRoots`, …) made absolute against the config's directory, so the result can be handed to
 * {@link checkTypes}, which writes its own tsconfig elsewhere.
 */
export function resolvedCompilerOptions(configPath: string): TsconfigCompilerOptions {
  const result = Bun.spawnSync([process.execPath, TSC_BIN, '--showConfig', '-p', configPath], {
    cwd: dirname(configPath),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  // A config that no longer parses (broken extends, invalid option) must fail
  // here, not come back as weakened defaults this gate then compiles against.
  if (result.exitCode !== 0) {
    throw new Error(`tsc --showConfig failed for ${configPath}:\n${result.stdout}${result.stderr}`)
  }
  const { compilerOptions = {} } = JSON.parse(result.stdout.toString()) as {
    compilerOptions?: TsconfigCompilerOptions
  }
  const configDir = dirname(configPath)
  const absolute = (target: string): string => resolve(configDir, target)
  const paths = compilerOptions.paths as Record<string, string[]> | undefined
  if (paths) {
    compilerOptions.paths = Object.fromEntries(
      Object.entries(paths).map(([alias, targets]) => [alias, targets.map(absolute)]),
    )
  }
  for (const key of ['rootDir', 'outDir', 'declarationDir', 'baseUrl'] as const) {
    if (typeof compilerOptions[key] === 'string') compilerOptions[key] = absolute(compilerOptions[key])
  }
  for (const key of ['rootDirs', 'typeRoots'] as const) {
    if (Array.isArray(compilerOptions[key])) compilerOptions[key] = (compilerOptions[key] as string[]).map(absolute)
  }
  return compilerOptions
}

/**
 * Type-check `rootNames` with `tsc` and return each diagnostic as a
 * `file:line TSxxxx: message` string — the compile gate for generated output.
 * An accepted `@ts-expect-error` probe surfaces as TS2578, so zero diagnostics
 * proves both polarities: valid usage compiled AND every bad-usage probe
 * errored.
 *
 * The tsconfig is written to its own temp directory: `rootNames` and every
 * path in `compilerOptions` must therefore be absolute.
 */
export function checkTypes(rootNames: string[], compilerOptions: TsconfigCompilerOptions): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'guren-check-types-'))
  try {
    const configPath = join(dir, 'tsconfig.json')
    writeFileSync(configPath, JSON.stringify({ compilerOptions, files: rootNames }))
    const result = Bun.spawnSync([process.execPath, TSC_BIN, '-p', configPath, '--pretty', 'false'], {
      cwd: dir,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const output = `${result.stdout}${result.stderr}`
    const diagnostics = [...output.matchAll(/^(?:(.+?)\((\d+),\d+\): )?error (TS\d+): (.*)$/gm)].map(
      ([, file, line, code, message]) => (file ? `${basename(file)}:${line} ${code}: ${message}` : `${code}: ${message}`),
    )
    // Exit 1 with no parseable diagnostic (a crashed compiler, an unreadable
    // config) must not read as "zero diagnostics".
    if (result.exitCode !== 0 && diagnostics.length === 0) {
      throw new Error(`tsc exited ${result.exitCode} without diagnostics:\n${output}`)
    }
    return diagnostics
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Spawn the CLI bin as a subprocess and return its exit code. */
export async function runCliBin(
  args: string[],
  cwd: string,
  options: { env?: Record<string, string> } = {},
): Promise<number> {
  assertWorkspaceBuilt([SERVER_DIST_ENTRY])

  const proc = Bun.spawn(['bun', CLI_BIN_PATH, ...args], {
    cwd,
    env: options.env ? { ...process.env, ...options.env } : undefined,
    stdout: 'ignore',
    stderr: 'ignore',
  })
  return proc.exited
}

/**
 * {@link runCliBin}, capturing both streams instead of discarding them.
 *
 * `NODE_ENV` is dropped rather than inherited: Bun's test runner sets it to
 * `test`, which drops consola to the warn level in the child and hides the
 * info-level output these assertions inspect — so a test would read the
 * environment rather than the command. Deleting it is what a plain terminal
 * invocation looks like; setting it to `production` would also unhide the
 * output but flips every gate in the framework that keys on production.
 */
export async function runCliBinCaptured(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  assertWorkspaceBuilt([SERVER_DIST_ENTRY])

  const { NODE_ENV: _testEnv, ...env } = process.env
  const proc = Bun.spawn(['bun', CLI_BIN_PATH, ...args], {
    cwd,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exitCode }
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
