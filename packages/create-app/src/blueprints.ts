import { randomBytes } from 'node:crypto'
import { cp, readFile, writeFile } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { toPackageName, toTitleCase } from './utils'

export const APP_BLUEPRINTS = ['default', 'api', 'blog', 'worker'] as const
export type AppBlueprintName = (typeof APP_BLUEPRINTS)[number]
export type RenderingMode = 'spa' | 'ssr'

export const DATABASE_DRIVERS = ['sqlite', 'postgres', 'mysql'] as const
export type DatabaseDriver = (typeof DATABASE_DRIVERS)[number]

interface TemplateLayer {
  dir: string
  excludePaths?: string[]
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
  baseTemplate: TemplateLayer
  overlayTemplateDirs: Partial<Record<RenderingMode, TemplateLayer[]>>
  transformFiles: string[]
  replacements?: (context: BlueprintContext) => Map<string, string>
  postScaffold?: (context: BlueprintContext) => Promise<void>
}

export interface ScaffoldAppBlueprintOptions {
  blueprint?: string
  destination: string
  renderingMode: RenderingMode
  database: DatabaseDriver
}

const DEFAULT_TRANSFORM_FILES = [
  'CLAUDE.md',
  'README.md',
  'package.json',
  'public/index.html',
  'bin/serve.ts',
  'app/Http/Controllers/HomeController.ts',
  'resources/js/pages/Home.tsx',
]

const BLOG_TRANSFORM_FILES = [
  'README.md',
  'public/index.html',
  'app/Providers/EventServiceProvider.ts',
  'app/Http/Controllers/Auth/LoginController.ts',
  'app/Http/Controllers/DashboardController.ts',
  'app/Http/Controllers/PostController.ts',
  'app/Http/Controllers/ProfileController.ts',
  'resources/js/components/Layout.tsx',
]

const API_TRANSFORM_FILES = [
  'README.md',
  'package.json',
  'bin/serve.ts',
]

const BLOG_OVERLAY_EXCLUDES = [
  '.env',
  '.guren',
  'CLAUDE.md',
  'db/migrations',
  'db/schema.ts',
  'node_modules',
  'package.json',
  'public/assets',
  'tests',
  'tsconfig.json',
  'types/generated',
  'vitest.config.ts',
]

const defaultTemplateDir = fileURLToPath(new URL('../templates/default', import.meta.url))
const defaultSsrOverlayDir = fileURLToPath(new URL('../templates/default-ssr', import.meta.url))
const apiTemplateDir = fileURLToPath(new URL('../templates/api-only', import.meta.url))
const exampleBlogDir = fileURLToPath(new URL('../../../examples/blog', import.meta.url))

const blueprintRegistry: Record<AppBlueprintName, AppBlueprint> = {
  default: {
    name: 'default',
    description: 'The standard Guren starter blueprint.',
    baseTemplate: {
      dir: defaultTemplateDir,
    },
    overlayTemplateDirs: {
      ssr: [{ dir: defaultSsrOverlayDir }],
    },
    transformFiles: DEFAULT_TRANSFORM_FILES,
  },
  api: {
    name: 'api',
    description: 'API-only starter — no Inertia, no React, no frontend assets.',
    baseTemplate: {
      dir: apiTemplateDir,
    },
    overlayTemplateDirs: {},
    transformFiles: API_TRANSFORM_FILES,
  },
  blog: {
    name: 'blog',
    description: 'The canonical blog-style starter used by the examples workspace.',
    baseTemplate: {
      dir: defaultTemplateDir,
    },
    overlayTemplateDirs: {
      spa: [{ dir: exampleBlogDir, excludePaths: BLOG_OVERLAY_EXCLUDES }],
      ssr: [{ dir: exampleBlogDir, excludePaths: BLOG_OVERLAY_EXCLUDES }],
    },
    transformFiles: [...new Set([...DEFAULT_TRANSFORM_FILES, ...BLOG_TRANSFORM_FILES])],
    replacements: ({ appTitle, packageName }) => new Map<string, string>([
      ['@guren/example-blog', packageName],
      ['Guren Blog Example', `${appTitle} Example`],
      ['Guren Blog', appTitle],
      ['blog.example.com', `${packageName}.example.com`],
    ]),
    postScaffold: async ({ destination, renderingMode, database }) => {
      const packageJsonPath = join(destination, 'package.json')
      const rawPackage = await readFile(packageJsonPath, 'utf8')
      const packageJson = JSON.parse(rawPackage) as {
        scripts?: Record<string, string>
        dependencies?: Record<string, string>
      }

      packageJson.scripts ??= {}
      packageJson.dependencies ??= {}

      const gurenVersion =
        packageJson.dependencies['@guren/core'] ??
        packageJson.dependencies['@guren/server'] ??
        packageJson.dependencies['@guren/orm'] ??
        '^1.0.0'

      packageJson.scripts.typecheck ??= 'tsc --noEmit'
      packageJson.scripts.smoke ??= 'bun run ./smoke.ts'
      packageJson.dependencies['@guren/core'] ??= gurenVersion
      packageJson.dependencies['@inertiajs/core'] ??= '^2.2.15'
      packageJson.dependencies['lucide-react'] ??= '^0.552.0'
      packageJson.dependencies.zod ??= '^4.1.5'

      await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8')

      // Overwrite schema with blog-specific tables (users with auth fields + posts)
      const schemaPath = join(destination, 'db/schema.ts')
      await writeFile(schemaPath, generateBlogSchema(database), 'utf8')

      if (database === 'postgres') {
        await cp(join(exampleBlogDir, 'db/migrations'), join(destination, 'db/migrations'), {
          recursive: true,
          force: true,
        })
      }

      if (renderingMode === 'spa') {
        const mainPath = join(destination, 'src/main.ts')
        const mainSource = await readFile(mainPath, 'utf8')
        if (!mainSource.includes('enableSsr: false')) {
          const updated = mainSource.replace(
            'autoConfigureInertiaAssets(app, {\n  importMeta: import.meta,\n})',
            'autoConfigureInertiaAssets(app, {\n  importMeta: import.meta,\n  enableSsr: false,\n})',
          )
          await writeFile(mainPath, updated, 'utf8')
        }
      }
    },
  },
  worker: {
    name: 'worker',
    description: 'Full-stack app pre-configured with queue, events, cache, and scheduling',
    baseTemplate: {
      dir: defaultTemplateDir,
    },
    overlayTemplateDirs: {
      ssr: [{ dir: defaultSsrOverlayDir }],
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

async function copyTemplate(template: string, destination: string): Promise<void> {
  await cp(template, destination, { recursive: true, force: true })
}

function normalizePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/\/+$/u, '')
}

function shouldExclude(templateRoot: string, sourcePath: string, excludePaths: string[] = []): boolean {
  const relativePath = normalizePath(relative(templateRoot, sourcePath))

  if (relativePath === '' || relativePath === '.') {
    return false
  }

  return excludePaths.some((candidate) => {
    const normalizedCandidate = normalizePath(candidate)
    return relativePath === normalizedCandidate || relativePath.startsWith(`${normalizedCandidate}/`)
  })
}

async function copyLayer(layer: TemplateLayer, destination: string): Promise<void> {
  await cp(layer.dir, destination, {
    recursive: true,
    force: true,
    filter: (sourcePath) => !shouldExclude(layer.dir, sourcePath, layer.excludePaths),
  })
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

const database = createSqliteDatabase({
  migrationsFolder: new URL('../db/migrations', import.meta.url),
  seedersFolder: new URL('../db/seeders', import.meta.url),
  filename: () => process.env.DATABASE_URL ?? '${url}',
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

function generateBlogSchema(driver: DatabaseDriver): string {
  if (driver === 'postgres') {
    return `import { pgTable, serial, text, integer, uniqueIndex } from '@guren/orm/drizzle'

export const users = pgTable(
  'users',
  {
    id: serial('id').primaryKey(),
    name: text('name').notNull(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    rememberToken: text('remember_token'),
  },
  (table) => [uniqueIndex('users_email_unique').on(table.email)],
)

export const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
  excerpt: text('excerpt').notNull(),
  body: text('body'),
  authorId: integer('author_id').notNull().references(() => users.id),
})

export const schema = { posts, users }
export type BlogSchema = typeof schema
`
  }

  if (driver === 'mysql') {
    return `import { mysqlTable, int, varchar, text, uniqueIndex } from '@guren/orm/drizzle'

export const users = mysqlTable(
  'users',
  {
    id: int('id').primaryKey().autoincrement(),
    name: varchar('name', { length: 255 }).notNull(),
    email: varchar('email', { length: 255 }).notNull(),
    passwordHash: varchar('password_hash', { length: 255 }).notNull(),
    rememberToken: varchar('remember_token', { length: 255 }),
  },
  (table) => [uniqueIndex('users_email_unique').on(table.email)],
)

export const posts = mysqlTable('posts', {
  id: int('id').primaryKey().autoincrement(),
  title: varchar('title', { length: 255 }).notNull(),
  excerpt: varchar('excerpt', { length: 500 }).notNull(),
  body: text('body'),
  authorId: int('author_id').notNull().references(() => users.id),
})

export const schema = { posts, users }
export type BlogSchema = typeof schema
`
  }

  return `import { sqliteTable, integer, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

export const users = sqliteTable(
  'users',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    rememberToken: text('remember_token'),
  },
  (table) => [uniqueIndex('users_email_unique').on(table.email)],
)

export const posts = sqliteTable('posts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  excerpt: text('excerpt').notNull(),
  body: text('body'),
  authorId: integer('author_id').notNull().references(() => users.id),
})

export const schema = { posts, users }
export type BlogSchema = typeof schema
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

  // Write all DB-variant files in parallel — including SQLite, since overlay
  // templates (e.g. blog) may ship a PostgreSQL-only schema that must be
  // replaced with the driver the user actually selected.
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

  // Add driver dependency to package.json (SQLite has dep: null, so this is skipped)
  if (dep) {
    const packageJsonPath = join(destination, 'package.json')
    const raw = await readFile(packageJsonPath, 'utf8')
    const pkg = JSON.parse(raw) as { dependencies?: Record<string, string> }
    pkg.dependencies ??= {}
    Object.assign(pkg.dependencies, dep)
    await writeFile(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
  }
}

export function listAppBlueprints(): AppBlueprintName[] {
  return [...APP_BLUEPRINTS]
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

  for (const [token, replacement] of blueprint.replacements?.(context) ?? []) {
    tokenMap.set(token, replacement)
  }

  await copyLayer(blueprint.baseTemplate, options.destination)

  for (const overlay of blueprint.overlayTemplateDirs[options.renderingMode] ?? []) {
    await copyLayer(overlay, options.destination)
  }

  await applyTokenTransforms(options.destination, blueprint.transformFiles, tokenMap)
  await scaffoldEnvFiles(options.destination)
  await applyDatabaseConfig(options.destination, options.database)
  await blueprint.postScaffold?.(context)
  return blueprint
}
