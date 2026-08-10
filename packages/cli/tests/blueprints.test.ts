import { beforeEach, afterEach, describe, expect, it } from 'bun:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createTempWorkspace, MYSQL_SCHEMA_FIXTURE, PG_SCHEMA_FIXTURE, type TempWorkspace } from './helpers'
import { listBlueprints, runBlueprint } from '../src/blueprints'
import { runCheck } from '../src/check'

const ROUTES_FIXTURE = `import { Router } from '@guren/core'

export function registerWebRoutes(router: Router): void {
  router.get('/', () => 'home')
}

export default registerWebRoutes
`

/** Minimum project shape the resource blueprint patches into. */
async function seedResourceWorkspace(schema: string): Promise<void> {
  await mkdir('resources/js/pages', { recursive: true })
  await mkdir('routes', { recursive: true })
  await mkdir('db', { recursive: true })
  await writeFile('routes/web.ts', ROUTES_FIXTURE)
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

  // The schema export, the model's import of it, and `guren check`'s table
  // lookup are three separate derivations. They used to disagree: `Category`
  // got `export const categories` but `import { categorys }`, so the generated
  // model did not compile and check warned about the table it had just written.
  it.each([
    // name, model class, schema identifier, table name
    ['Category', 'Category', 'categories', 'categories'],
    ['Box', 'Box', 'boxes', 'boxes'],
    ['Address', 'Address', 'addresses', 'addresses'],
    ['UserProfile', 'UserProfile', 'userProfiles', 'user_profiles'],
    // Already plural: the blueprint singularizes the name before scaffolding,
    // so the class is `New` and the collection must not become `newses`.
    ['News', 'New', 'news', 'news'],
  ])('keeps schema, model, and check in agreement for %s', async (name, className, identifier, tableName) => {
    await seedResourceWorkspace(PG_SCHEMA_FIXTURE)

    await runBlueprint('resource', { name, fields: 'title:string' })

    const schema = await readFile('db/schema.ts', 'utf8')
    expect(schema).toContain(`export const ${identifier} = pgTable('${tableName}'`)

    const model = await readFile(`app/Models/${className}.ts`, 'utf8')
    expect(model).toContain(`import { ${identifier} } from '../../db/schema.js'`)

    const report = await runCheck({ cwd: workspace.dir })
    // Pin this model's own result: the fixture ships a `users` table, so a
    // lookup that resolved every model to `users` would pass a generic
    // "nothing failed" assertion.
    const schemaCheck = report.checks.find((result) => result.key === `model-schema:${className}`)
    expect(schemaCheck?.status).toBe('pass')
  })

  // The check resolves the identifier the scaffolded model actually imports
  // (`userProfiles`), not a name guessed from the class — so overwriting the
  // schema out from under it reports the binding that is actually missing,
  // not a table name nobody ever declared.
  it('reports the bound identifier when its table is missing', async () => {
    await seedResourceWorkspace(PG_SCHEMA_FIXTURE)
    await runBlueprint('resource', { name: 'UserProfile', fields: 'title:string' })
    await writeFile('db/schema.ts', PG_SCHEMA_FIXTURE)

    const report = await runCheck({ cwd: workspace.dir })
    const schemaCheck = report.checks.find((result) => result.key === 'model-schema:UserProfile')

    expect(schemaCheck?.status).toBe('warn')
    expect(schemaCheck?.message).toContain("binds 'userProfiles'")
  })

  // Guards the split between snakeCase() and tableNameFor() — see blueprints.ts.
  // `publishedAt` is the contrast: the rule still splits camel humps, it just
  // does not collapse underscore runs the way the kebab-based rule would.
  it('preserves underscore runs in column names', async () => {
    await seedResourceWorkspace(PG_SCHEMA_FIXTURE)

    await runBlueprint('resource', { name: 'Post', fields: '__dunder__:string,publishedAt:date' })

    const schema = await readFile('db/schema.ts', 'utf8')
    expect(schema).toContain("__dunder__: text('__dunder__')")
    expect(schema).toContain("publishedAt: timestamp('published_at', { withTimezone: true })")
  })

  it('rejects unknown blueprints', async () => {
    await expect(runBlueprint('unknown')).rejects.toThrow('Unknown blueprint')
  })

  // Every field type has to map to a column in every dialect. A missing case
  // silently falls through to the text/varchar default, which then rejects the
  // value the generated validator produces (a `date` field is the example: a
  // bare text column cannot take the `Date` from `z.coerce.date()`).
  //
  // The sqlite and postgres golden-path smokes typecheck a real app scaffolded
  // with all of these; this covers the mysql mapper the same way at the unit
  // level so it cannot drift while its smoke is unavailable.
  const ALL_FIELDS = 'name:string,body:text,count:number,active:boolean,publishedAt:date,meta:json'

  const COLUMN_CASES = [
    {
      dialect: 'sqlite',
      schema: `import { sqliteTable, integer, text } from '@guren/orm/drizzle'

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
})
`,
      columns: [
        "name: text('name').notNull()",
        "body: text('body').notNull()",
        "count: integer('count').notNull()",
        "active: integer('active', { mode: 'boolean' }).notNull()",
        "publishedAt: integer('published_at', { mode: 'timestamp' }).notNull()",
        "meta: text('meta', { mode: 'json' }).notNull()",
      ],
    },
    {
      dialect: 'mysql',
      schema: `import { mysqlTable, int, varchar } from '@guren/orm/drizzle'

export const users = mysqlTable('users', {
  id: int('id').primaryKey().autoincrement(),
  name: varchar('name', { length: 255 }).notNull(),
})
`,
      columns: [
        "name: varchar('name', { length: 255 }).notNull()",
        "body: varchar('body', { length: 255 }).notNull()",
        "count: int('count').notNull()",
        "active: boolean('active').notNull()",
        "publishedAt: timestamp('published_at').notNull()",
        "meta: json('meta').notNull()",
      ],
    },
    {
      dialect: 'postgres',
      schema: `import { pgTable, serial, text } from '@guren/orm/drizzle'

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
})
`,
      columns: [
        "name: text('name').notNull()",
        "body: text('body').notNull()",
        "count: integer('count').notNull()",
        "active: boolean('active').notNull()",
        "publishedAt: timestamp('published_at', { withTimezone: true }).notNull()",
        "meta: jsonb('meta').notNull()",
      ],
    },
  ] as const

  for (const { dialect, schema: fixture, columns } of COLUMN_CASES) {
    it(`maps every field type to a ${dialect} column`, async () => {
      await seedResourceWorkspace(fixture)

      await runBlueprint('resource', { name: 'Entry', fields: ALL_FIELDS })

      const schema = await readFile('db/schema.ts', 'utf8')
      for (const column of columns) {
        expect(schema).toContain(column)
      }
    })
  }

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
    await writeFile('routes/web.ts', ROUTES_FIXTURE)

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

    // The private channel must be registered with the channel's own check, not
    // an allow-all — otherwise UserFeedChannel.authorize() never runs and any
    // caller can subscribe to another user's feed.
    const broadcastProviderSource = await readFile('app/Providers/BroadcastProvider.ts', 'utf8')
    expect(broadcastProviderSource).toContain(
      'broadcast.privateChannel(userFeed.getBaseName(), (channelName, user) => userFeed.authorize(channelName, user))',
    )
    expect(broadcastProviderSource).not.toContain('broadcast.privateChannel(userFeed.getBaseName(), () => true)')
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

// `guren add admin` runs against apps that may never have run `guren add auth`,
// so the guard has to be one that holds without an app-wide 'auth' alias: the
// route carries `requireAuthenticated` inline and the controller re-checks. The
// default is what matters here — a blueprint whose zeros get replaced with real
// queries must not leave the dashboard open.
describe('admin blueprint authentication', () => {
  let workspace: TempWorkspace

  beforeEach(async () => {
    workspace = await createTempWorkspace('guren-cli-admin-blueprint-')
  })

  afterEach(async () => {
    await workspace.cleanup()
  })

  it('guards the dashboard route and controller by default', async () => {
    await runBlueprint('admin')

    const routes = await readFile('routes/admin.ts', 'utf8')
    expect(routes).toContain("import { Router, requireAuthenticated } from '@guren/core'")
    expect(routes).toContain(
      "router.get('/admin', [AdminDashboardController, 'index'], requireAuthenticated({ redirectTo: '/login' })).name('admin.dashboard')",
    )
    // No `aliasMiddleware('auth', ...)`: it writes into the router shared with
    // routes/web.ts, replacing whatever alias the app registered there.
    expect(routes).not.toContain('aliasMiddleware')

    const controller = await readFile('app/Http/Controllers/Admin/AdminDashboardController.ts', 'utf8')
    expect(controller).toContain('await this.auth.userOrFail()')
  })

  it('scaffolds an open dashboard with --public', async () => {
    await runBlueprint('admin', { publicAccess: true })

    const routes = await readFile('routes/admin.ts', 'utf8')
    expect(routes).toContain("import { Router } from '@guren/core'")
    expect(routes).toContain("router.get('/admin', [AdminDashboardController, 'index']).name('admin.dashboard')")
    expect(routes).not.toContain('requireAuthenticated')

    const controller = await readFile('app/Http/Controllers/Admin/AdminDashboardController.ts', 'utf8')
    expect(controller).not.toContain('userOrFail')
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
