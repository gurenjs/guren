import { beforeEach, afterEach, describe, expect, it } from 'bun:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createTempWorkspace, MYSQL_SCHEMA_FIXTURE, PG_SCHEMA_FIXTURE, SQLITE_SCHEMA_FIXTURE, type TempWorkspace } from './helpers'
import { listBlueprints, runBlueprint } from '../src/blueprints'

/** The directories and route file the resource blueprint expects to patch. */
async function seedResourceWorkspace(schema: string): Promise<void> {
  await mkdir('resources/js/pages', { recursive: true })
  await mkdir('routes', { recursive: true })
  await mkdir('db', { recursive: true })
  await writeFile('routes/web.ts', `import { Router } from '@guren/core'

export function registerWebRoutes(router: Router): void {
  router.get('/', () => 'home')
}

export default registerWebRoutes
`)
  await writeFile('db/schema.ts', schema)
}

describe('blueprints', () => {
  let workspace: TempWorkspace

  beforeEach(async () => {
    workspace = await createTempWorkspace('guren-cli-blueprints-')
  })

  afterEach(async () => {
    await workspace.cleanup()
  })

  it('lists the available scaffold blueprints', () => {
    expect(listBlueprints()).toEqual([
      'admin',
      'auth',
      'broadcasting',
      'cache',
      'events',
      'mail',
      'notifications',
      'oauth',
      'queue',
      'resource',
      'schedule',
      'storage',
    ])
  })

  it('runs the resource blueprint', async () => {
    await seedResourceWorkspace(PG_SCHEMA_FIXTURE)

    const files = await runBlueprint('resource', { name: 'Post' })

    expect(files).toHaveLength(8)
    expect(files.some((file) => file.endsWith('app/Models/Post.ts'))).toBe(true)
    expect(files.some((file) => file.endsWith('app/Http/Controllers/PostController.ts'))).toBe(true)
    expect(files.some((file) => file.endsWith('resources/js/pages/posts/Index.tsx'))).toBe(true)
    expect(files.some((file) => file.endsWith('app/Http/Resources/PostResource.ts'))).toBe(true)
    expect(files.some((file) => file.endsWith('app/Http/Validators/PostValidator.ts'))).toBe(true)

    const controller = await readFile(files.find((file) => file.endsWith('PostController.ts'))!, 'utf8')
    expect(controller).toContain('pages.posts.Index')
    expect(controller).toContain('paginate(result')

    const indexPage = await readFile(files.find((file) => file.endsWith('pages/posts/Index.tsx'))!, 'utf8')
    expect(indexPage).toContain('interface Props')
    expect(indexPage).toContain('PaginatedPageProps')

    const routes = await readFile('routes/web.ts', 'utf8')
    expect(routes).toContain("router.group('/posts'")
    expect(routes).toContain("name('posts.index')")
    expect(routes).toContain(".delete('/:id'")
    expect(routes).toContain("name: 'posts.destroy'")

    const schema = await readFile('db/schema.ts', 'utf8')
    expect(schema).toContain("export const posts = pgTable('posts'")
  })

  // SQLite is the default dialect and was the only one with no `date` case: a
  // date field fell through to `text()`, and the `Date` the validator produces
  // binds to a text column as null — every date silently dropped on write.
  it('stores a date as a timestamp on the default sqlite schema', async () => {
    await seedResourceWorkspace(SQLITE_SCHEMA_FIXTURE)

    await runBlueprint('resource', {
      name: 'Post',
      fields: 'title:string,views:number,published:boolean,publishedAt:date,meta:json',
    })

    const schema = await readFile('db/schema.ts', 'utf8')

    expect(schema).toContain("export const posts = sqliteTable('posts'")
    expect(schema).toContain("publishedAt: integer('published_at', { mode: 'timestamp' }).notNull()")
    expect(schema).not.toContain("publishedAt: text('published_at')")
    expect(schema).toContain("published: integer('published', { mode: 'boolean' }).notNull()")
    expect(schema).toContain("meta: text('meta', { mode: 'json' }).notNull()")
    // The fixture imports no `integer`, so this only passes if the run
    // patched in the builder the new date and boolean columns need.
    expect(schema).toMatch(/import\s*\{[^}]*\binteger\b[^}]*\}\s*from\s*'drizzle-orm\/sqlite-core'/)
  })

  it('adds resource tables to a mysql schema without borrowing another dialect', async () => {
    await seedResourceWorkspace(MYSQL_SCHEMA_FIXTURE)

    await runBlueprint('resource', {
      name: 'Post',
      fields: 'title:string,views:number,published:boolean,publishedAt:date,meta:json',
    })

    const schema = await readFile('db/schema.ts', 'utf8')

    expect(schema).toContain("export const posts = mysqlTable('posts'")
    expect(schema).toContain("publishedAt: timestamp('published_at').notNull()")
    expect(schema).toContain("meta: json('meta').notNull()")
    expect(schema).toContain("published: boolean('published').notNull()")
    // Every builder — the scaffolded ones and the ones this run added — must
    // come from mysql-core. `@guren/orm/drizzle` re-exports the pg builders
    // under the same names, and mixing them is silent at build time.
    const importedModules = [...schema.matchAll(/import\s*\{[^}]*\}\s*from\s*['"]([^'"]+)['"]/g)].map(
      (match) => match[1],
    )
    expect([...new Set(importedModules)]).toEqual(['drizzle-orm/mysql-core'])
  })

  it('rejects unknown blueprints', async () => {
    await expect(runBlueprint('unknown')).rejects.toThrow('Unknown blueprint')
  })

  it('runs the infrastructure blueprints', async () => {
    await mkdir('src', { recursive: true })
    await mkdir('routes', { recursive: true })
    await writeFile('src/app.ts', `import { createApp } from '@guren/core'

const app = createApp({
  routes: () => {},
  providers: [],
})

export default app
`)
    await writeFile('routes/web.ts', `import { Router } from '@guren/core'

export function registerWebRoutes(router: Router): void {
  router.get('/', () => 'home')
}

export default registerWebRoutes
`)

    const adminFiles = await runBlueprint('admin')
    const queueFiles = await runBlueprint('queue')
    const mailFiles = await runBlueprint('mail')
    const eventFiles = await runBlueprint('events')
    const cacheFiles = await runBlueprint('cache')
    const scheduleFiles = await runBlueprint('schedule')
    const notificationFiles = await runBlueprint('notifications')
    const storageFiles = await runBlueprint('storage')
    const broadcastingFiles = await runBlueprint('broadcasting')
    const oauthFiles = await runBlueprint('oauth')

    expect(queueFiles.some((file) => file.endsWith('app/Providers/QueueProvider.ts'))).toBe(true)
    expect(mailFiles.some((file) => file.endsWith('app/Providers/MailProvider.ts'))).toBe(true)
    expect(eventFiles.some((file) => file.endsWith('app/Providers/EventProvider.ts'))).toBe(true)
    expect(cacheFiles.some((file) => file.endsWith('app/Providers/CacheProvider.ts'))).toBe(true)
    expect(scheduleFiles.some((file) => file.endsWith('app/Console/Kernel.ts'))).toBe(true)
    expect(notificationFiles.some((file) => file.endsWith('app/Providers/NotificationProvider.ts'))).toBe(true)
    expect(storageFiles.some((file) => file.endsWith('app/Providers/StorageProvider.ts'))).toBe(true)
    expect(broadcastingFiles.some((file) => file.endsWith('app/Providers/BroadcastProvider.ts'))).toBe(true)
    expect(oauthFiles.some((file) => file.endsWith('app/Providers/OAuthProvider.ts'))).toBe(true)
    expect(oauthFiles.some((file) => file.endsWith('app/Http/Controllers/Auth/OAuthController.ts'))).toBe(true)

    const appSource = await readFile('src/app.ts', 'utf8')
    expect(appSource).toContain('CoreQueueServiceProvider')
    expect(appSource).toContain('CoreMailServiceProvider')
    expect(appSource).toContain('CoreEventServiceProvider')
    expect(appSource).toContain('CoreCacheServiceProvider')
    expect(appSource).toContain('CoreSchedulingServiceProvider')
    expect(appSource).toContain('CoreNotificationServiceProvider')
    expect(appSource).toContain('CoreStorageServiceProvider')
    expect(appSource).toContain('CoreBroadcastServiceProvider')
    expect(appSource).toContain('CoreOAuthServiceProvider')
    expect(appSource).toContain('QueueProvider')
    expect(appSource).toContain('MailProvider')
    expect(appSource).toContain('EventProvider')
    expect(appSource).toContain('CacheProvider')
    expect(appSource).toContain('NotificationProvider')
    expect(appSource).toContain('StorageProvider')
    expect(appSource).toContain('BroadcastProvider')
    expect(appSource).toContain('OAuthProvider')

    const routesSource = await readFile('routes/web.ts', 'utf8')
    expect(adminFiles.some((file) => file.endsWith('app/Http/Controllers/Admin/AdminDashboardController.ts'))).toBe(true)
    expect(adminFiles.some((file) => file.endsWith('resources/js/pages/admin/Dashboard.tsx'))).toBe(true)
    expect(adminFiles.some((file) => file.endsWith('routes/admin.ts'))).toBe(true)
    expect(routesSource).toContain("import registerAdminRoutes from './admin.js'")
    expect(routesSource).toContain('registerAdminRoutes(router)')
  })
})

describe('oauth blueprint output', () => {
  let workspace: TempWorkspace

  beforeEach(async () => {
    workspace = await createTempWorkspace('guren-cli-oauth-blueprint-')
  })

  afterEach(async () => {
    await workspace.cleanup()
  })

  it('does not shadow the base Controller.redirect() helper', async () => {
    await runBlueprint('oauth')

    const controller = await readFile('app/Http/Controllers/Auth/OAuthController.ts', 'utf8')
    // An action named `redirect` overrides the base helper and recurses.
    expect(controller).not.toMatch(/async redirect\(\)/)
    expect(controller).toContain('async redirectToProvider()')
    // Route params are string | undefined — the validator must accept that.
    expect(controller).toContain('validateProvider(value: string | undefined)')

    const routes = await readFile('routes/oauth.ts', 'utf8')
    expect(routes).toContain("[OAuthController, 'redirectToProvider']")
    expect(routes).not.toContain("[OAuthController, 'redirect']")
  })
})
