import { randomBytes } from 'node:crypto'
import { cp, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { directoryExists, toPackageName, toTitleCase } from './utils'

export const APP_BLUEPRINTS = ['default', 'api', 'worker'] as const
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

type TemplateName = 'default' | 'default-ssr' | 'api-only'

export function templateDir(name: TemplateName): string {
  return join(TEMPLATES_ROOT, name)
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

async function copyLayer(layer: TemplateName, destination: string): Promise<void> {
  await cp(templateDir(layer), destination, { recursive: true, force: true })
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

const DATABASE_DEFAULTS = {
  postgres: { url: 'postgres://guren:guren@localhost:54322/guren', dialect: 'postgresql', dep: { postgres: '^3.4.3' } },
  mysql:    { url: 'mysql://guren:guren@localhost:33306/guren',    dialect: 'mysql',      dep: { mysql2: '^3.11.3' } },
  sqlite:   { url: './data/guren.db',                              dialect: 'sqlite',     dep: null },
} as const satisfies Record<DatabaseDriver, { url: string; dialect: string; dep: Record<string, string> | null }>

function generateDatabaseConfig(driver: DatabaseDriver): string {
  const { url } = DATABASE_DEFAULTS[driver]

  if (driver === 'postgres') {
    return `import { createPostgresDatabase } from '@guren/orm'

const database = createPostgresDatabase({
  migrationsFolder: new URL('../db/migrations', import.meta.url),
  seedersFolder: new URL('../db/seeders', import.meta.url),
  connectionString: () => process.env.DATABASE_URL ?? '${url}',
})

export const { getDatabase, migrateDatabase, closeDatabase, configureOrm, seedDatabase, resetDatabase, migrationStatus } = database
`
  }

  if (driver === 'mysql') {
    return `import { createMySqlDatabase } from '@guren/orm'

const database = createMySqlDatabase({
  migrationsFolder: new URL('../db/migrations', import.meta.url),
  seedersFolder: new URL('../db/seeders', import.meta.url),
  connectionString: () => process.env.DATABASE_URL ?? '${url}',
})

export const { getDatabase, migrateDatabase, closeDatabase, configureOrm, seedDatabase, resetDatabase, migrationStatus } = database
`
  }

  return `import { createSqliteDatabase } from '@guren/orm'

// \`bun test\` sets NODE_ENV=test automatically, so the test suite reads and
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

const database = createSqliteDatabase({
  migrationsFolder: new URL('../db/migrations', import.meta.url),
  seedersFolder: new URL('../db/seeders', import.meta.url),
  filename: resolveDatabaseFilename,
})

export const { getDatabase, migrateDatabase, closeDatabase, configureOrm, seedDatabase, resetDatabase, migrationStatus } = database
`
}

function generateSchema(driver: DatabaseDriver): string {
  if (driver === 'postgres') {
    return `import { pgTable, serial, text, timestamp } from '@guren/orm/drizzle'

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})
`
  }

  if (driver === 'mysql') {
    return `import { mysqlTable, int, varchar, timestamp } from '@guren/orm/drizzle'

export const users = mysqlTable('users', {
  id: int('id').primaryKey().autoincrement(),
  name: varchar('name', { length: 255 }).notNull(),
  email: varchar('email', { length: 255 }).notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})
`
  }

  // SQLite uses drizzle-orm directly — @guren/orm/drizzle does not re-export SQLite helpers
  return `import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core'

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  email: text('email').notNull(),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
})
`
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

  // Write all DB-variant files in parallel — including SQLite, since an overlay
  // template may ship a schema written for one driver that has to be replaced
  // with the driver the user actually selected.
  await Promise.all([
    writeFile(join(destination, 'config/database.ts'), generateDatabaseConfig(driver), 'utf8'),
    writeFile(join(destination, 'db/schema.ts'), generateSchema(driver), 'utf8'),
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
