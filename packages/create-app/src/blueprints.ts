import { randomBytes } from 'node:crypto'
import { cp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { directoryExists, fileExists, toPackageName, toTitleCase } from './utils'

export const APP_BLUEPRINTS = ['default', 'api', 'blog', 'worker'] as const
export type AppBlueprintName = (typeof APP_BLUEPRINTS)[number]
export type RenderingMode = 'spa' | 'ssr'

export const DATABASE_DRIVERS = ['sqlite', 'postgres', 'mysql'] as const
export type DatabaseDriver = (typeof DATABASE_DRIVERS)[number]

/**
 * The directory holding every template a blueprint can copy from. It is the
 * only source tree in this package's `files` field, so a layer resolved outside
 * it scaffolds fine from the monorepo and ENOENTs from an npm install: that is
 * how the `blog` blueprint shipped broken for releases, overlaying
 * `examples/blog`, which no tarball contains.
 *
 * Layers are therefore named, not pathed — `TemplateName` makes a layer outside
 * this directory unrepresentable rather than merely asserted against.
 */
export const TEMPLATES_ROOT = fileURLToPath(new URL('../templates', import.meta.url))

type TemplateName = 'default' | 'default-ssr' | 'api-only' | 'blog'

export function templateDir(name: TemplateName): string {
  return join(TEMPLATES_ROOT, name)
}

/**
 * Every template that ships a manifest — `blog` and `default-ssr` overlay one
 * instead. Exported because a template's `package.json` is the one manifest in
 * this repository that resolves against npm, so more than one gate has to read
 * exactly this set: `scripts/sync-template-deps.ts` keeps their versions
 * following the workspace, and `scripts/smoke/local-packages.ts` derives from
 * their dependencies which packages a smoke must resolve from the checkout.
 */
export async function templateManifests(): Promise<string[]> {
  const paths: string[] = []

  for (const entry of await readdir(TEMPLATES_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue
    }
    const path = join(TEMPLATES_ROOT, entry.name, 'package.json')
    if (await fileExists(path)) {
      paths.push(path)
    }
  }

  return paths
}

interface BlueprintContext {
  appName: string
  appTitle: string
  destination: string
  packageName: string
  renderingMode: RenderingMode
  database: DatabaseDriver
}

export interface AppBlueprint {
  name: AppBlueprintName
  description: string
  baseTemplate: TemplateName
  overlayTemplates: Partial<Record<RenderingMode, TemplateName[]>>
  transformFiles: string[]
  /**
   * Set when the template already ships the authentication stack. `--auth` runs
   * `guren add auth --force` afterwards, which would overwrite the template's
   * own controllers, routes, and User model with the generic ones.
   */
  includesAuth?: boolean
  postScaffold?: (context: BlueprintContext) => Promise<void>
}

export interface ScaffoldAppBlueprintOptions {
  blueprint?: string
  destination: string
  renderingMode: RenderingMode
  database: DatabaseDriver
}

const DEFAULT_TRANSFORM_FILES = [
  'README.md',
  'package.json',
  'public/index.html',
  'bin/serve.ts',
  'app/Http/Controllers/HomeController.ts',
  'resources/js/pages/Home.tsx',
]

const API_TRANSFORM_FILES = [
  'README.md',
  'package.json',
  'bin/serve.ts',
]

// Transforms run once, after every layer has landed, and each path is read
// unconditionally — so this lists every tokenised file in the scaffolded tree,
// base template and overlay alike, not just what the overlay ships.
const BLOG_TRANSFORM_FILES = [
  ...DEFAULT_TRANSFORM_FILES,
  'resources/js/components/Layout.tsx',
  'db/seeders/001_users.ts',
]

const blueprintRegistry: Record<AppBlueprintName, AppBlueprint> = {
  default: {
    name: 'default',
    description: 'The standard Guren starter blueprint.',
    baseTemplate: 'default',
    overlayTemplates: {
      ssr: ['default-ssr'],
    },
    transformFiles: DEFAULT_TRANSFORM_FILES,
  },
  api: {
    name: 'api',
    description: 'API-only starter — no Inertia, no React, no frontend assets.',
    baseTemplate: 'api-only',
    overlayTemplates: {},
    transformFiles: API_TRANSFORM_FILES,
  },
  blog: {
    name: 'blog',
    description: 'Blog starter — posts CRUD, session auth, and a seeded demo account.',
    baseTemplate: 'default',
    // The overlay lands last in both modes so its pages and controllers win, and
    // SSR still gets `default-ssr` — the blueprint this replaces overlaid only
    // itself in SSR mode and shipped an app with no ssr.tsx entry.
    overlayTemplates: {
      spa: ['blog'],
      ssr: ['default-ssr', 'blog'],
    },
    transformFiles: BLOG_TRANSFORM_FILES,
    includesAuth: true,
  },
  worker: {
    name: 'worker',
    description: 'Full-stack app pre-configured with queue, events, cache, and scheduling',
    baseTemplate: 'default',
    overlayTemplates: {
      ssr: ['default-ssr'],
    },
    transformFiles: DEFAULT_TRANSFORM_FILES,
    postScaffold: async ({ destination }) => {
      let runBlueprint: (name: string, opts: { force: boolean }) => Promise<string[]>
      try {
        ;({ runBlueprint } = await import('@guren/cli'))
      } catch {
        return
      }
      const originalCwd = process.cwd()
      try {
        process.chdir(destination)
        await runBlueprint('queue', { force: true })
        await runBlueprint('events', { force: true })
        await runBlueprint('cache', { force: true })
        await runBlueprint('schedule', { force: true })
      } finally {
        process.chdir(originalCwd)
      }
    },
  },
}

function replaceTokens(content: string, tokens: Map<string, string>): string {
  let updated = content
  for (const [token, replacement] of tokens) {
    updated = updated.split(token).join(replacement)
  }
  return updated
}

// npm strips files literally named `.gitignore` from published tarballs, so
// templates carry them undotted; see packages/create-app/CLAUDE.md.
const TEMPLATE_DOTFILES = new Map<string, string>([['_gitignore', '.gitignore']])

async function copyLayer(layer: TemplateName, destination: string): Promise<void> {
  // Collected from the copy itself rather than by walking the destination:
  // `--force` scaffolds into a directory that may already hold files this
  // layer never wrote, and those are none of our business to rename. A Set
  // because neither Node nor Bun documents `filter` as running exactly once
  // per entry, and a repeat would make the second rename fail on ENOENT.
  const dotfiles = new Set<string>()
  const source = templateDir(layer)

  await cp(source, destination, {
    recursive: true,
    force: true,
    filter: (sourcePath) => {
      if (TEMPLATE_DOTFILES.has(basename(sourcePath))) {
        dotfiles.add(relative(source, sourcePath))
      }
      return true
    },
  })

  // Per layer, not once after every layer has copied: an overlay shipping its
  // own ignore file has to win over the base template's, and a single restore
  // at the end would rename the base's leftover on top of it.
  for (const path of dotfiles) {
    const dotted = TEMPLATE_DOTFILES.get(basename(path)) as string
    await rename(join(destination, path), join(destination, dirname(path), dotted))
  }
}

async function applyTokenTransforms(destination: string, files: string[], tokens: Map<string, string>): Promise<void> {
  for (const file of files) {
    const path = join(destination, file)
    const content = await readFile(path, 'utf8')
    const updated = replaceTokens(content, tokens)
    if (updated !== content) {
      await writeFile(path, updated, 'utf8')
    }
  }
}

async function scaffoldEnvFiles(destination: string): Promise<void> {
  const envExamplePath = join(destination, '.env.example')
  const envPath = join(destination, '.env')

  let envExample: string
  try {
    envExample = await readFile(envExamplePath, 'utf8')
  } catch {
    return
  }

  const appKey = `base64:${randomBytes(32).toString('base64')}`
  const envContent = envExample.replace(/^APP_KEY=.*$/mu, `APP_KEY=${appKey}`)
  await writeFile(envPath, envContent.endsWith('\n') ? envContent : `${envContent}\n`, 'utf8')
}

/* ---------- Database-specific file generators ---------- */

// `seederContext` is the alias a seeder in this app must be annotated with:
// the bare `SeederContext` is PostgreSQL-shaped and rejects a MySQL or SQLite
// schema. The generated config re-exports it under one driver-independent name
// so the seeders themselves stay portable.
const DATABASE_DEFAULTS = {
  postgres: { url: 'postgres://guren:guren@localhost:54322/guren', dialect: 'postgresql', dep: { postgres: '^3.4.3' }, factory: 'createPostgresDatabase', seederContext: 'PostgresSeederContext' },
  mysql:    { url: 'mysql://guren:guren@localhost:33306/guren',    dialect: 'mysql',      dep: { mysql2: '^3.11.3' },  factory: 'createMySqlDatabase',    seederContext: 'MySqlSeederContext' },
  sqlite:   { url: './data/guren.db',                              dialect: 'sqlite',     dep: null,                   factory: 'createSqliteDatabase',   seederContext: 'SqliteSeederContext' },
} as const satisfies Record<
  DatabaseDriver,
  { url: string; dialect: string; dep: Record<string, string> | null; factory: string; seederContext: string }
>

function generateDatabaseConfig(driver: DatabaseDriver): string {
  const { url, factory, seederContext } = DATABASE_DEFAULTS[driver]

  // SQLite is configured by file path rather than connection string, so it is
  // the one driver that carries a resolver (and the test-database rule).
  const body =
    driver === 'sqlite'
      ? `// \`bun test\` sets NODE_ENV=test automatically, so the test suite reads and
// writes a separate SQLite file and never touches the development database —
// this takes priority over DATABASE_URL, which .env sets unconditionally.
// Override the test DB path itself with TEST_DATABASE_URL if needed (e.g. to
// shard parallel CI runs); DATABASE_URL is still authoritative outside tests.
function resolveDatabaseFilename(): string {
  if (process.env.NODE_ENV === 'test') {
    return process.env.TEST_DATABASE_URL ?? './data/guren.test.db'
  }
  return process.env.DATABASE_URL ?? '${url}'
}

const database = ${factory}({
  migrationsFolder: new URL('../db/migrations', import.meta.url),
  seedersFolder: new URL('../db/seeders', import.meta.url),
  filename: resolveDatabaseFilename,
})`
      : `const database = ${factory}({
  migrationsFolder: new URL('../db/migrations', import.meta.url),
  seedersFolder: new URL('../db/seeders', import.meta.url),
  connectionString: () => process.env.DATABASE_URL ?? '${url}',
})`

  return `import { ${factory}, type ${seederContext} } from '@guren/orm'

${body}

export const { getDatabase, migrateDatabase, closeDatabase, configureOrm, seedDatabase, resetDatabase, migrationStatus } = database

/** Annotate seeders with this: \`defineSeeder(async ({ db }: AppSeederContext) => {})\`. */
export type AppSeederContext = ${seederContext}
`
}

// Each dialect imports from its own `@guren/orm/drizzle/<dialect>` barrel —
// the same modules `guren add auth` / `add resource` merge new columns into.
function generateSchema(driver: DatabaseDriver): string {
  if (driver === 'postgres') {
    return `import { pgTable, serial, text, timestamp } from '@guren/orm/drizzle/pg'

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
`
  }

  if (driver === 'mysql') {
    return `import { mysqlTable, int, varchar, timestamp } from '@guren/orm/drizzle/mysql'

export const users = mysqlTable('users', {
  id: int('id').primaryKey().autoincrement(),
  name: varchar('name', { length: 255 }).notNull(),
  email: varchar('email', { length: 255 }).notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})
`
  }

  return `import { sqliteTable, integer, text } from '@guren/orm/drizzle/sqlite'

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  email: text('email').notNull(),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
})
`
}

/**
 * Templates whose app code needs more than the single `users` table above ship
 * their own schema, one file per driver, as `db/schema.<driver>.ts`. The variant
 * for the selected driver becomes `db/schema.ts` and the rest are deleted.
 *
 * The indirection exists because `applyDatabaseConfig` has to overwrite
 * `db/schema.ts` — a template carrying a plain `db/schema.ts` written for one
 * driver would otherwise be handed to users who picked another. The blueprint
 * this replaced worked around that by regenerating its schema from a copy kept
 * in this file, which then drifted from the columns its own controllers read.
 *
 * A template that ships some variants but not the selected one is a packaging
 * bug, not a reason to fall back to the generic schema: the fallback would
 * scaffold an app whose models reference tables that do not exist.
 */
function schemaVariantPath(destination: string, driver: DatabaseDriver): string {
  return join(destination, `db/schema.${driver}.ts`)
}

async function resolveSchema(destination: string, driver: DatabaseDriver): Promise<string> {
  const shipped = (await Promise.all(
    DATABASE_DRIVERS.map(async (name) => (await fileExists(schemaVariantPath(destination, name)) ? name : null)),
  )).filter((name) => name !== null)

  if (shipped.length === 0) {
    return generateSchema(driver)
  }

  if (!shipped.includes(driver)) {
    throw new Error(
      `This template ships a database schema for ${shipped.join(', ')} but not for ${driver}. ` +
      'This build of create-guren-app is incomplete — please report it at ' +
      'https://github.com/gurenjs/guren/issues.',
    )
  }

  return readFile(schemaVariantPath(destination, driver), 'utf8')
}

function generateDrizzleConfig(driver: DatabaseDriver): string {
  const { url, dialect } = DATABASE_DEFAULTS[driver]

  return `import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './db/schema.ts',
  out: './db/migrations',
  dialect: '${dialect}',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '${url}',
  },
})
`
}

/**
 * True when the driver runs in a container the scaffolder provisions — the one
 * fact that decides docker-compose.yml, the db:up/db:down scripts, and whether
 * the next-steps output mentions starting a database.
 */
export function usesDatabaseContainer(driver: DatabaseDriver): boolean {
  return generateDockerCompose(driver) !== null
}

function generateDockerCompose(driver: DatabaseDriver): string | null {
  if (driver === 'postgres') {
    return `services:
  postgres:
    image: postgres:17-alpine
    ports:
      - '54322:5432'
    environment:
      POSTGRES_USER: guren
      POSTGRES_PASSWORD: guren
      POSTGRES_DB: guren
    volumes:
      - postgres_data:/var/lib/postgresql/data

volumes:
  postgres_data:
`
  }

  if (driver === 'mysql') {
    return `services:
  mysql:
    image: mysql:8.4
    ports:
      - '33306:3306'
    environment:
      MYSQL_ROOT_PASSWORD: guren
      MYSQL_USER: guren
      MYSQL_PASSWORD: guren
      MYSQL_DATABASE: guren
    volumes:
      - mysql_data:/var/lib/mysql

volumes:
  mysql_data:
`
  }

  return null
}

async function applyDatabaseConfig(destination: string, driver: DatabaseDriver): Promise<void> {
  const { url, dep } = DATABASE_DEFAULTS[driver]
  const dockerCompose = generateDockerCompose(driver)

  // Resolved before the writes below so a template missing the selected driver's
  // schema fails while `db/schema.ts` still holds whatever the copy left there.
  const schema = await resolveSchema(destination, driver)

  // Write all DB-variant files in parallel — including SQLite, since an overlay
  // template may ship a schema written for one driver that has to be replaced
  // with the driver the user actually selected.
  await Promise.all([
    writeFile(join(destination, 'config/database.ts'), generateDatabaseConfig(driver), 'utf8'),
    writeFile(join(destination, 'db/schema.ts'), schema, 'utf8'),
    // Independent of the write above: the selected variant's contents are
    // already in `schema`, and no variant shares a path with db/schema.ts.
    ...DATABASE_DRIVERS.map((name) => rm(schemaVariantPath(destination, name), { force: true })),
    writeFile(join(destination, 'drizzle.config.ts'), generateDrizzleConfig(driver), 'utf8'),
    dockerCompose ? writeFile(join(destination, 'docker-compose.yml'), dockerCompose, 'utf8') : Promise.resolve(),
    // Update .env and .env.example with the correct DATABASE_URL
    ...['.env', '.env.example'].map(async (envFile) => {
      const envPath = join(destination, envFile)
      try {
        const content = await readFile(envPath, 'utf8')
        await writeFile(envPath, content.replace(/^DATABASE_URL=.*$/mu, `DATABASE_URL=${url}`), 'utf8')
      } catch {
        // .env may not exist yet for .env.example-only templates
      }
    }),
  ])

  // SQLite needs neither a driver dependency nor a container, so both edits are skipped.
  if (dep || dockerCompose) {
    const packageJsonPath = join(destination, 'package.json')
    const raw = await readFile(packageJsonPath, 'utf8')
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string>; dependencies?: Record<string, string> }

    if (dep) {
      pkg.dependencies ??= {}
      Object.assign(pkg.dependencies, dep)
    }

    // Without these, the generated docker-compose.yml is something the user has
    // to discover on their own — and an unstarted container surfaces only as a
    // migration failure.
    if (dockerCompose) {
      pkg.scripts ??= {}
      pkg.scripts['db:up'] = 'docker compose up -d'
      pkg.scripts['db:down'] = 'docker compose down'
    }

    await writeFile(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
  }
}

export function listAppBlueprints(): AppBlueprintName[] {
  return [...APP_BLUEPRINTS]
}

/**
 * The templates a blueprint copies from, in copy order: base first, then
 * overlays, each overwriting what came before. Omit `renderingMode` for every
 * mode the blueprint supports — what the packaging checks need; pass one for
 * the templates a single scaffold will actually copy.
 *
 * Repeats are returned as-is rather than deduped: a name listed twice means
 * "copy it again at this point", and collapsing it would silently change which
 * template wins.
 */
export function listBlueprintTemplates(
  blueprint: AppBlueprint,
  renderingMode?: RenderingMode,
): TemplateName[] {
  const overlays = renderingMode
    ? blueprint.overlayTemplates[renderingMode] ?? []
    : Object.values(blueprint.overlayTemplates).flat()

  return [blueprint.baseTemplate, ...overlays]
}

export async function assertBlueprintLayersExist(blueprint: AppBlueprint, renderingMode: RenderingMode): Promise<void> {
  for (const layer of listBlueprintTemplates(blueprint, renderingMode)) {
    if (!await directoryExists(templateDir(layer))) {
      throw new Error(
        `Blueprint "${blueprint.name}" is missing its template directory "${templateDir(layer)}". ` +
        'This build of create-guren-app is incomplete — please report it at ' +
        'https://github.com/gurenjs/guren/issues and try `npm create guren-app@latest` meanwhile.',
      )
    }
  }
}

export function getAppBlueprint(name: string | undefined): AppBlueprint {
  const blueprintName = (name ?? 'default') as AppBlueprintName
  const blueprint = blueprintRegistry[blueprintName]
  if (!blueprint) {
    throw new Error(`Unknown blueprint "${name}". Available blueprints: ${listAppBlueprints().join(', ')}`)
  }
  return blueprint
}

export async function scaffoldAppBlueprint(options: ScaffoldAppBlueprintOptions): Promise<AppBlueprint> {
  const blueprint = getAppBlueprint(options.blueprint)
  const appName = basename(options.destination)
  const packageName = toPackageName(appName)
  const appTitle = toTitleCase(appName)
  const context: BlueprintContext = {
    appName,
    appTitle,
    destination: options.destination,
    packageName,
    renderingMode: options.renderingMode,
    database: options.database,
  }
  const tokenMap = new Map<string, string>([
    ['guren-app-placeholder', packageName],
    ['__APP_TITLE__', appTitle],
    ['__APP_NAME__', appName],
  ])

  // Checked up front so a missing layer fails before anything is written —
  // otherwise the base template lands and the user is left with a half-built app.
  await assertBlueprintLayersExist(blueprint, options.renderingMode)

  for (const layer of listBlueprintTemplates(blueprint, options.renderingMode)) {
    await copyLayer(layer, options.destination)
  }

  await applyTokenTransforms(options.destination, blueprint.transformFiles, tokenMap)
  await scaffoldEnvFiles(options.destination)
  await applyDatabaseConfig(options.destination, options.database)
  await blueprint.postScaffold?.(context)
  return blueprint
}
