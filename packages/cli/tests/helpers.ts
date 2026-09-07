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
 * The *built* CLI entry, for assertions about the published package.
 * `CLI_BIN_PATH` runs from `src/`, where anything resolved relative to
 * `import.meta.url` lands somewhere else than it does in `dist/`.
 */
export const CLI_DIST_BIN = join(repoRoot, 'packages/cli/dist/bin.js')

/**
 * The built artifact this package's tests reach `@guren/server` through:
 * `@guren/core` resolves to source, but its `export *` follows the workspace
 * symlink to server's `exports`, which point at `dist/index.js`.
 */
export const SERVER_DIST_ENTRY = join(repoRoot, 'packages/server/dist/index.js')

export interface TempWorkspace {
  dir: string
  originalCwd: string
  cleanup: () => Promise<void>
}

/** Write a fake installed package into node_modules. */
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
 * Point a fixture app's `@guren/core` at this checkout. A fixture that is
 * imported for real resolves from a temp directory with no node_modules, and
 * Bun then falls back to its global install cache — binding the *published*
 * package (measured: `@guren/core@1.7.0`) or throwing, either way measuring
 * the machine rather than the workspace.
 */
export async function linkWorkspaceCore(baseDir: string): Promise<void> {
  await linkWorkspacePackage('core', baseDir)
}

/** Symlink `packages/<name>` into `baseDir/node_modules/@guren/<name>`, as a workspace install would. */
export async function linkWorkspacePackage(name: string, baseDir: string): Promise<void> {
  const linkPath = join(baseDir, 'node_modules', '@guren', name)
  await mkdir(dirname(linkPath), { recursive: true })
  await symlink(join(repoRoot, 'packages', name), linkPath, 'dir')
}

/** The oxlint shim this workspace lints with, for tests that drive the real binary. */
export const OXLINT_BIN = join(repoRoot, 'node_modules', '.bin', 'oxlint')

/**
 * Lint one fixture through the real oxlint: `.oxlintrc.json` carries `config`, and
 * only the `rules` it names are enabled. Returns oxlint's `--format unix` stdout.
 * Throws on stderr output, and on the message-less `file:0:0:` line oxlint prints
 * when a plugin throws mid-file — otherwise a broken plugin reads as "no findings".
 */
export function lintFixture(options: {
  config: { jsPlugins: string[]; rules: Record<string, string> }
  file: string
  source: string
  cwd?: string
}): string {
  const dir = options.cwd ?? mkdtempSync(join(tmpdir(), 'guren-oxlint-'))
  try {
    writeFileSync(join(dir, '.oxlintrc.json'), JSON.stringify(options.config))
    writeFileSync(join(dir, options.file), options.source)
    const denies = Object.keys(options.config.rules).flatMap((rule) => ['-D', rule])
    const result = Bun.spawnSync([OXLINT_BIN, '-c', '.oxlintrc.json', '-A', 'all', ...denies, '--format', 'unix', options.file], {
      cwd: dir,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const stdout = result.stdout.toString()
    const stderr = result.stderr.toString()
    if (stderr.trim() !== '') throw new Error(`oxlint wrote to stderr:\n${stderr}`)
    if (stdout.split('\n').some((line) => line.startsWith(`${options.file}:0:0:`))) {
      throw new Error(`the plugin threw while linting the fixture:\n${stdout}`)
    }
    return stdout
  } finally {
    if (options.cwd === undefined) rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Write a fake locally-installed package the way Bun materializes `file:`,
 * `link:` and `workspace:` deps: a real directory tree under
 * node_modules/<name> whose files are symlinks into the source directory.
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
 * The `db/schema.ts` a fresh app starts from, per dialect, in the shape
 * `create-guren-app` scaffolds: each dialect imports its builders from its own
 * `@guren/orm/drizzle/<dialect>` barrel.
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
 * A routes file that genuinely resolves `@guren/core` at runtime. `Router` is
 * used as a *value*: a type-only import is erased and resolves nothing, and
 * the `instanceof` holds only if the fixture got the loading process's own
 * class. One copy, because the linked and unlinked tests are each other's
 * control.
 */
export const CORE_RESOLVING_ROUTES_FIXTURE = `import { Router } from '@guren/core'

export function registerWebRoutes(router: Router): void {
  if (!(router instanceof Router)) throw new Error('resolved a different @guren/core')
  router.get('/posts', () => new Response('ok')).name('posts.index')
}
`

/**
 * The `routes/web.ts` the two app templates scaffold. The blog shape names the
 * registrar's parameter `baseRouter` and rebinds it, because
 * `aliasMiddleware()` must be captured for the return type carrying the alias
 * names; one copy serves the parser, the blueprints and `make:auth`.
 */
export const DEFAULT_ROUTES_FIXTURE = `import { Router } from '@guren/core'

export function registerWebRoutes(router: Router): void {
  router.get('/', () => 'home')
}

export default registerWebRoutes
`

/**
 * Whether `chmod 0o000` actually denies this process a read. It does not for
 * uid 0, where an unreadable-file test would take the readable path and pass
 * having proved nothing — better an explicit skip than a vacuous green.
 */
export const CAN_DENY_FILE_READS = process.getuid === undefined || process.getuid() !== 0

/**
 * The api-only starter's entry file: `routes/api.ts`, and no `routes/web.ts`
 * anywhere, so Inertia scaffolders have nothing to write into it.
 */
export const API_ROUTES_FIXTURE = `import { Router } from '@guren/core'

export function registerApiRoutes(router: Router): void {
  router.get('/health', (c) => c.json({ status: 'ok' }))
}
`

/**
 * The one spelling of "an app `isConfirmedApiOnlyApp` recognizes"; per-caller
 * copies had already drifted in the dependencies they declared. `db/schema.ts`
 * is here so a test can assert a scaffolder past the refusal left it alone.
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
 * scaffolders accept. The schema has no `users` table (makeAuth patches one
 * in), `src/app.ts` imports the registrar so provider wiring has something to
 * patch, and `Home.tsx`'s `Props` are baked into the scaffold-typecheck
 * pages.gen fixture — changing it means regenerating that fixture.
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

/**
 * The shape `guren add attachments` leaves behind, reduced to what the
 * `make:feature --attach` preflight reads. Parsed only, never executed — the
 * throwing storage thunk keeps that honest.
 */
export async function seedAttachmentsConfig(dir: string): Promise<void> {
  await writeWorkspaceFiles(dir, {
    'config/attachments.ts': `import { configureAttachments } from '@guren/core'
import { attachments } from '../db/schema.js'

export const { Attachment } = configureAttachments({
  table: attachments,
  storage: () => {
    throw new Error('unused in tests')
  },
})
`,
  })
}

/** One page component, for tests about an app that acquired one it cannot render. */
export const PAGE_COMPONENT_FIXTURE = 'export default function Home() { return null }\n'

/**
 * The middle sentence `assertNotApiOnly` writes into every refusal. One
 * spelling, so a wording change in app-surface.ts is not hunted across files.
 */
export const API_ONLY_REFUSAL = /no @guren\/inertia-client dependency and no routes\/web\.ts/

/**
 * A file from the api-only starter as `create-guren-app` ships it. Read rather
 * than approximated: the reduced fixtures above describe a *shape*.
 */
export async function readApiOnlyTemplateFile(relativePath: string): Promise<string> {
  return readFile(join(import.meta.dir, '../../create-app/templates/api-only', relativePath), 'utf8')
}

/**
 * The generic `db/schema.ts` a scaffolded app is given. No template carries
 * it: `applyDatabaseConfig` picks one by driver and writes it over whatever
 * the template copy left, so the api-only template ships none of its own.
 */
export async function readShippedSchemaFile(driver: 'postgres' | 'mysql' | 'sqlite' = 'sqlite'): Promise<string> {
  return readFile(join(import.meta.dir, `../../create-app/templates/database/${driver}/db/schema.ts`), 'utf8')
}

/**
 * The api-only starter as shipped, reduced to the two files
 * `isConfirmedApiOnlyApp` reads. `seedApiOnlyApp` is a hand-written
 * approximation, which cannot notice the template gaining an
 * `@guren/inertia-client` dependency or a `routes/web.ts` — so whatever hangs
 * off the predicate wants one case seeded from the shipped files.
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
 * printing. Scoped to the call, unlike `createConsolaStub`, which serves the
 * process-wide `mock.module('consola')` path.
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
 * global state in Bun's shared test process, so an overrunning test can chdir
 * and `rm -rf` out from under whichever test started meanwhile. The workspace
 * is also never empty (see the bunfig), so a test pointing `guren new` at one
 * needs `--force`.
 */
export async function createTempWorkspace(prefix: string): Promise<TempWorkspace> {
  const dir = await mkdtemp(join(tmpdir(), prefix))

  // Bun's last resort for an unresolvable bare specifier is to *install* it,
  // from the global cache or npm, so an unlinked fixture silently binds the
  // *published* `@guren/*` (measured: `@guren/core@1.7.0`) instead of this
  // checkout. Written before the chdir because bunfig lookup is cwd-only and an
  // await after it is a suspension point a timed-out test abandons with cwd moved.
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
 * Throw unless every named build artifact exists. On an unbuilt checkout a
 * spawned CLI dies on module resolution and exits 1, which an exit-code
 * assertion cannot tell from the command reporting a real failure. A
 * precondition rather than a crash sniff, so it also covers tests that reach
 * built code by importing a fixture.
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

// Each checkTypes() call spawns the native tsc: the slowest caller measures
// about 0.5s per case, the whole five-file compile suite under 2s. The limit
// sits well above that because Bun bills a timeout to whatever runs next.
export const TSC_TIMEOUT = 30_000

/**
 * The `compilerOptions` object of a tsconfig.json, as plain JSON rather than
 * the compiler API's enums: TypeScript 7 ships no JavaScript API, so every
 * compile gate here drives the `tsc` binary.
 */
export interface TsconfigCompilerOptions {
  paths?: Record<string, string[]>
  rootDir?: string
  rootDirs?: string[]
  typeRoots?: string[]
  [option: string]: unknown
}

/**
 * Base compiler options for compiling a generated module plus its usage probe
 * in a temp directory; spread rather than mutate, several gates share it.
 * `types: []` because the default type-root walk climbs ancestor directories,
 * so a TMPDIR inside a workspace would type-check every @types it finds.
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
 * Resolve a tsconfig the way `tsc` does and return its compilerOptions with
 * every relative path made absolute against the config's directory, since
 * {@link checkTypes} writes its own tsconfig elsewhere.
 */
export function resolvedCompilerOptions(configPath: string): TsconfigCompilerOptions {
  const spawnOptions = { cwd: dirname(configPath), stdout: 'pipe', stderr: 'pipe' } as const
  // --showConfig exits 0 and prints whatever it could read, so a config that
  // fails to parse would come back as weakened defaults: the diagnostics
  // come from a separate no-check run.
  const probe = Bun.spawnSync([process.execPath, TSC_BIN, '-p', configPath, '--listFilesOnly', '--pretty', 'false'], spawnOptions)
  if (probe.exitCode !== 0) {
    const diagnostics = `${probe.stdout}${probe.stderr}`.split('\n').filter((line) => /error TS\d+/.test(line))
    throw new Error(`tsc rejected ${configPath}:\n${diagnostics.join('\n')}`)
  }
  const result = Bun.spawnSync([process.execPath, TSC_BIN, '--showConfig', '-p', configPath], spawnOptions)
  if (result.exitCode !== 0) {
    throw new Error(`tsc --showConfig failed for ${configPath}:\n${result.stdout}${result.stderr}`)
  }
  const { compilerOptions = {} } = JSON.parse(result.stdout.toString()) as {
    compilerOptions?: TsconfigCompilerOptions
  }
  const configDir = dirname(configPath)
  const absolute = (target: string): string => resolve(configDir, target)
  if (compilerOptions.paths) {
    compilerOptions.paths = Object.fromEntries(
      Object.entries(compilerOptions.paths).map(([alias, targets]) => [alias, targets.map(absolute)]),
    )
  }
  if (compilerOptions.rootDir) compilerOptions.rootDir = absolute(compilerOptions.rootDir)
  if (compilerOptions.rootDirs) compilerOptions.rootDirs = compilerOptions.rootDirs.map(absolute)
  if (compilerOptions.typeRoots) compilerOptions.typeRoots = compilerOptions.typeRoots.map(absolute)
  return compilerOptions
}

/**
 * Type-check `rootNames` with `tsc`, returning each diagnostic as
 * `file:line TSxxxx: message`. An accepted `@ts-expect-error` probe surfaces
 * as TS2578, so zero diagnostics proves both polarities. The tsconfig is
 * written to its own temp directory, so every path passed must be absolute.
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
 * {@link runCliBin}, capturing both streams. `NODE_ENV` is dropped rather than
 * inherited: Bun's test runner sets it to `test`, which drops consola to warn
 * level in the child and hides the info output these assertions inspect.
 * `production` would unhide it too, but flips every production gate.
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
 * `mock.module()` is not undone between files in Bun's shared process, so a
 * hand-listed stub breaks any later file calling a method it forgot;
 * inheriting keeps the rest callable, and the printing ones are shadowed.
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

/**
 * The one spelling of an app `check` and `audit` pass on with nothing linked
 * (measured): a registrar, its controller, and the two manifests `check` expects.
 * The gate and hook tests spread a `package.json` over it.
 */
export const GATE_APP_FILES: Record<string, string> = {
  'routes/web.ts': `class HomeController {
  async index() { return null }
}
export default function registerRoutes(router: any) {
  router.get('/', [HomeController, 'index'])
}
`,
  'app/Http/Controllers/HomeController.ts': `export class HomeController {
  async index() { return this.json({ ok: true }) }
}
`,
  '.guren/routes.gen.ts': 'export {}\n',
  '.guren/data.gen.ts': 'export {}\n',
}

export function gateAppFiles(scripts: Record<string, string>): Record<string, string> {
  return { ...GATE_APP_FILES, 'package.json': JSON.stringify({ name: 'gate-fixture', scripts }) }
}

/** Make the workspace's oxlint resolvable from `baseDir`, as an app install would. */
export async function linkOxlint(baseDir: string): Promise<void> {
  await mkdir(join(baseDir, 'node_modules'), { recursive: true })
  await symlink(join(repoRoot, 'node_modules', 'oxlint'), join(baseDir, 'node_modules', 'oxlint'), 'dir')
}

/**
 * Make `@guren/cli` resolvable from `baseDir` as this checkout's *source* (an
 * installed app resolves it through node_modules): a shim package whose entry
 * re-exports `packages/cli/src`, so a hook under test runs the current code
 * rather than whatever `dist/` was last built.
 */
export async function linkWorkspaceCliSource(baseDir: string): Promise<void> {
  const shim = join(baseDir, 'node_modules', '@guren', 'cli')
  await mkdir(shim, { recursive: true })
  await writeFile(join(shim, 'package.json'), JSON.stringify({ name: '@guren/cli', type: 'module', exports: './index.ts' }))
  await writeFile(join(shim, 'index.ts'), `export * from '${join(repoRoot, 'packages/cli/src/index.ts')}'\n`)
}

/**
 * A shipped agent hook, run the way the agent runs it: the template installed
 * into a temp app at `installPath` (the hooks locate the app from their own
 * directory), then `argv` (default `bun <hook>`) with the hook input on stdin,
 * from the app root or `subdir`. `setup` populates the app first.
 */
export async function runAgentHook(
  template: string,
  installPath: string,
  input: unknown,
  setup: (dir: string) => void | Promise<void>,
  options: { subdir?: string; argv?: string[] } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'guren-hook-'))
  try {
    // Bun would otherwise auto-install an unresolvable bare specifier from the registry.
    await writeFile(join(dir, 'bunfig.toml'), '[install]\nauto = "disable"\n')
    await linkWorkspaceCliSource(dir)
    const hook = join(dir, installPath)
    await mkdir(dirname(hook), { recursive: true })
    await writeFile(hook, await readFile(template, 'utf8'))
    await setup(dir)
    const result = Bun.spawnSync(options.argv ?? [process.execPath, hook], {
      cwd: options.subdir ? join(dir, options.subdir) : dir,
      stdin: Buffer.from(JSON.stringify(input)),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** `git init` in `dir`, so untracked files are its changed set. */
export function initGitRepo(dir: string): void {
  const result = Bun.spawnSync(['git', 'init', '-q'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(`git init failed: ${result.stderr.toString()}`)
}

/** The provider `guren add session` scaffolds. */
export const SESSION_PROVIDER = `import { createSessionManager, ServiceProvider } from '@guren/core'
import { sessionConfig } from '../../config/session'

export default class SessionProvider extends ServiceProvider {
  register(): void {
    this.container.instance('session', createSessionManager(sessionConfig))
  }
}
`

/** A `config/session.ts` in the shape `guren add session` writes. */
export function sessionConfigSource(stores: string, selected = "process.env.SESSION_DRIVER ?? 'database'"): string {
  return `import { type SessionConfig } from '@guren/core'
import { sessions } from '../db/schema'

export const sessionConfig: SessionConfig = {
  default: ${selected},
  stores: { ${stores} },
}
`
}

