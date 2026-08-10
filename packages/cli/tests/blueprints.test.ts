import { beforeEach, afterEach, describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  API_ROUTES_FIXTURE,
  BLOG_ROUTES_FIXTURE,
  CAN_DENY_FILE_READS,
  DEFAULT_ROUTES_FIXTURE,
  MYSQL_SCHEMA_FIXTURE,
  PG_SCHEMA_FIXTURE,
  REGISTRAR_LESS_ROUTES_FIXTURE,
  captureWarnings,
  createTempWorkspace,
  seedApiOnlyApp,
  type TempWorkspace,
} from './helpers'
import { listBlueprints, runBlueprint } from '../src/blueprints'
import { runCheck } from '../src/check'

/** Minimum project shape the resource blueprint patches into. */
async function seedResourceWorkspace(schema: string, routes = DEFAULT_ROUTES_FIXTURE): Promise<void> {
  await mkdir('resources/js/pages', { recursive: true })
  await mkdir('routes', { recursive: true })
  await mkdir('db', { recursive: true })
  await writeFile('routes/web.ts', routes)
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

  // The suppression check used to match the collection slug as a quoted-path
  // suffix, so an unrelated `/admin/posts` answered "the posts routes are
  // already registered" for a `Post` resource: eight files scaffolded, the
  // table added — and no route group.
  it('registers the group when the slug only appears inside a longer path', async () => {
    await seedResourceWorkspace(PG_SCHEMA_FIXTURE, `import { Router } from '@guren/core'

export function registerWebRoutes(router: Router): void {
  router.get('/admin/posts', () => 'admin posts')
}

export default registerWebRoutes
`)

    await runBlueprint('resource', { name: 'Post' })

    const routes = await readFile('routes/web.ts', 'utf8')
    expect(routes).toContain("router.group('/posts'")
    expect(routes).toContain("name('posts.index')")
    // The imports the group needs are only sound because the group is there.
    expect(routes).toContain("import PostController from '../app/Http/Controllers/PostController.js'")
    // The route that triggered the false positive is left alone.
    expect(routes).toContain("router.get('/admin/posts', () => 'admin posts')")
  })

  // The direction the anchoring could overshoot in. A hand-wired `/posts` has
  // none of the generated `.name()` calls, so the path literal is the only
  // thing left to recognise it by — anchor it any tighter (on `.group(`, say)
  // and the blueprint registers a second, conflicting set of routes.
  it('leaves hand-registered routes for the same collection alone', async () => {
    await seedResourceWorkspace(PG_SCHEMA_FIXTURE, `import { Router } from '@guren/core'

export function registerWebRoutes(router: Router): void {
  router.get('/posts', () => 'posts')
}

export default registerWebRoutes
`)

    await runBlueprint('resource', { name: 'Post' })

    const routes = await readFile('routes/web.ts', 'utf8')
    expect(routes).not.toContain("router.group('/posts'")
    // A skipped registration must skip its imports too: appended anyway they
    // are unused bindings, and the app stops compiling under noUnusedLocals.
    expect(routes).not.toContain('import PostController')
  })

  // A second run is suppressed by both clauses of the guard — run 1 emits the
  // path literal and the route names. This pins the run-twice contract itself,
  // including the import dedupe, not either clause.
  it('registers the resource group once when re-run', async () => {
    await seedResourceWorkspace(PG_SCHEMA_FIXTURE)

    await runBlueprint('resource', { name: 'Post' })
    await runBlueprint('resource', { name: 'Post', force: true })

    const routes = await readFile('routes/web.ts', 'utf8')
    expect(routes.match(/\.group\('\/posts'/g)).toHaveLength(1)
    expect(routes.match(/import PostController from/g)).toHaveLength(1)
  })

  it('rejects unknown blueprints', async () => {
    await expect(runBlueprint('unknown')).rejects.toThrow('Unknown blueprint')
  })

  // An app scaffolded from the blog template names the registrar's parameter
  // `baseRouter`. The wiring used to match the literal name `router`, so the
  // blueprint wrote routes/admin.ts, registered nothing, added no import, and
  // — inside a try/catch — said nothing about any of it.
  describe('route wiring for a registrar not named `router`', () => {
    beforeEach(async () => {
      await mkdir('routes', { recursive: true })
      await writeFile('routes/web.ts', BLOG_ROUTES_FIXTURE)
    })

    it('imports and calls the admin registrar with the parameter that exists', async () => {
      await runBlueprint('admin')

      const routes = await readFile('routes/web.ts', 'utf8')
      expect(routes).toContain("import registerAdminRoutes from './admin.js'")
      expect(routes).toContain('registerAdminRoutes(baseRouter)')
      // `router` is declared below the call site: passing it would read a
      // `const` before its initialization.
      expect(routes).not.toContain('registerAdminRoutes(router)')
      // The existing import block stays intact, and the call goes inside the
      // registrar rather than above it.
      expect(routes).toContain(`export function registerWebRoutes(baseRouter: Router): void {
  registerAdminRoutes(baseRouter)

  const router = baseRouter.aliasMiddleware(`)
    })

    it('wires each blueprint once, however the argument is spelled', async () => {
      await runBlueprint('admin')
      await runBlueprint('admin', { force: true })
      await runBlueprint('oauth')
      await runBlueprint('oauth', { force: true })

      const routes = await readFile('routes/web.ts', 'utf8')
      expect(routes.match(/registerAdminRoutes\(/g)).toHaveLength(1)
      expect(routes.match(/registerOAuthRoutes\(/g)).toHaveLength(1)
      expect(routes.match(/import registerAdminRoutes from/g)).toHaveLength(1)
    })

    it('hangs the resource group off the registrar parameter', async () => {
      await mkdir('resources/js/pages', { recursive: true })
      await mkdir('db', { recursive: true })
      await writeFile('db/schema.ts', PG_SCHEMA_FIXTURE)

      await runBlueprint('resource', { name: 'Post' })

      const routes = await readFile('routes/web.ts', 'utf8')
      expect(routes).toContain("baseRouter.group('/posts'")
      expect(routes).not.toContain("  router.group('/posts'")
    })

    // The imports used to be anchored on the literal text `export function`,
    // so a registrar exported any other way got the route group and neither
    // import — routes referencing identifiers the file never imported.
    it('imports the controller and validator whatever the registrar exports', async () => {
      await mkdir('resources/js/pages', { recursive: true })
      await mkdir('db', { recursive: true })
      await writeFile('db/schema.ts', PG_SCHEMA_FIXTURE)
      await writeFile('routes/web.ts', `import { Router } from '@guren/core'

export default function registerWebRoutes(appRouter: Router): void {
  appRouter.get('/', () => 'home')
}
`)

      await runBlueprint('resource', { name: 'Post' })

      const routes = await readFile('routes/web.ts', 'utf8')
      expect(routes).toContain("import PostController from '../app/Http/Controllers/PostController.js'")
      expect(routes).toContain("import { PostPayloadSchema } from '../app/Http/Validators/PostValidator.js'")
      expect(routes).toContain("appRouter.group('/posts'")
    })
  })

  // The template is what `create-guren-app` actually ships, so it is the one
  // input the wiring has to survive verbatim — the fixtures above are its
  // reduction, not a substitute for it.
  it('wires into the blog template routes file as shipped', async () => {
    await mkdir('resources/js/pages', { recursive: true })
    await mkdir('routes', { recursive: true })
    await mkdir('db', { recursive: true })
    await writeFile('db/schema.ts', PG_SCHEMA_FIXTURE)
    await writeFile(
      'routes/web.ts',
      await readFile(resolve(import.meta.dir, '../../create-app/templates/blog/routes/web.ts'), 'utf8'),
    )

    await runBlueprint('admin')
    await runBlueprint('resource', { name: 'Comment' })

    const routes = await readFile('routes/web.ts', 'utf8')
    expect(routes).toContain("import registerAdminRoutes from './admin.js'")
    expect(routes).toContain('registerAdminRoutes(baseRouter)')
    expect(routes).toContain("import CommentController from '../app/Http/Controllers/CommentController.js'")
    expect(routes).toContain("baseRouter.group('/comments'")
    // The template's own wiring survives untouched.
    expect(routes).toContain('registerAuthRoutes(router)')
    expect(routes.match(/registerAuthRoutes\(/g)).toHaveLength(1)
  })

  // Silence is the failure mode being fixed: a routes file with no registrar
  // to patch has to be reported, not swallowed.
  describe('route wiring failures', () => {
    beforeEach(async () => {
      await mkdir('routes', { recursive: true })
      await writeFile('routes/web.ts', REGISTRAR_LESS_ROUTES_FIXTURE)
    })

    it('warns instead of writing an unreachable admin routes file', async () => {
      const { result: created, warnings } = await captureWarnings(() => runBlueprint('admin'))

      expect(created.some((file) => file.endsWith('routes/admin.ts'))).toBe(true)
      expect(warnings.join('\n')).toContain('Could not wire registerAdminRoutes()')
      // Not even the import: a registrar nobody calls is an unused binding, and
      // the app it was scaffolded into stops compiling under noUnusedLocals.
      expect(await readFile('routes/web.ts', 'utf8')).toBe(REGISTRAR_LESS_ROUTES_FIXTURE)
    })

    it('fails the resource blueprint rather than dropping its routes', async () => {
      await mkdir('resources/js/pages', { recursive: true })
      await mkdir('db', { recursive: true })
      await writeFile('db/schema.ts', PG_SCHEMA_FIXTURE)

      await expect(runBlueprint('resource', { name: 'Post' })).rejects.toThrow(
        'Could not find a route registrar',
      )
    })
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
    await writeFile('routes/web.ts', DEFAULT_ROUTES_FIXTURE)

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

// Every file the admin blueprint writes is Inertia-shaped, so on the api-only
// starter none of them works: the controller does not typecheck against a
// `@guren/inertia-client` that is not installed, and `routes/admin.ts` reaches
// no registrar, so `/admin` 404s while the CLI reported success. The blueprint
// refuses instead of scaffolding it.
describe('admin blueprint on an API-only app', () => {
  let workspace: TempWorkspace

  beforeEach(async () => {
    workspace = await createTempWorkspace('guren-cli-admin-api-only-')
  })

  afterEach(async () => {
    await workspace.cleanup()
  })

  it('refuses, naming the two signals it read', async () => {
    await seedApiOnlyApp(workspace.dir)

    await expect(runBlueprint('admin')).rejects.toThrow(
      /no @guren\/inertia-client dependency and no routes\/web\.ts/,
    )
  })

  // The half that matters: refusing after the first write would leave exactly
  // the mess the refusal exists to prevent.
  it('writes nothing at all', async () => {
    await seedApiOnlyApp(workspace.dir)

    await expect(runBlueprint('admin')).rejects.toThrow()

    // `existsSync` rather than the `fileExists` the predicate itself calls: a
    // bug in that helper must not be able to make this assertion pass.
    for (const path of [
      'routes/admin.ts',
      'app/Http/Controllers/Admin/AdminDashboardController.ts',
      'resources/js/pages/admin/Dashboard.tsx',
    ]) {
      expect(existsSync(resolve(workspace.dir, path))).toBe(false)
    }
    // And the app's own routes file is untouched.
    expect(await readFile('routes/api.ts', 'utf8')).toBe(API_ROUTES_FIXTURE)
  })

  // The template is what `create-guren-app` ships; the fixture above is its
  // reduction, not a substitute for it.
  it('refuses the api-only template as shipped', async () => {
    const templateDir = resolve(import.meta.dir, '../../create-app/templates/api-only')
    await mkdir('routes', { recursive: true })
    await writeFile('routes/api.ts', await readFile(resolve(templateDir, 'routes/api.ts'), 'utf8'))
    await writeFile('package.json', await readFile(resolve(templateDir, 'package.json'), 'utf8'))

    await expect(runBlueprint('admin')).rejects.toThrow('guren add admin scaffolds an Inertia dashboard')
  })

  // Positive evidence only: no manifest is an unknown app, not an API-only one.
  it('still scaffolds when there is no package.json to judge by', async () => {
    await mkdir('routes', { recursive: true })
    await writeFile('routes/api.ts', API_ROUTES_FIXTURE)

    const created = await runBlueprint('admin')

    expect(created.some((file) => file.endsWith('routes/admin.ts'))).toBe(true)
  })

  // Both signals are required, so each of the next three isolates one of them:
  // any single rescuing signal has to be enough on its own.
  it('scaffolds when routes/web.ts exists but the manifest does not name the client', async () => {
    await mkdir('routes', { recursive: true })
    await writeFile('routes/web.ts', DEFAULT_ROUTES_FIXTURE)
    // A fullstack app in a workspace whose deps are hoisted to the root.
    await writeFile('package.json', JSON.stringify({ name: 'workspace-member' }))

    const created = await runBlueprint('admin')

    expect(created.some((file) => file.endsWith('routes/admin.ts'))).toBe(true)
    expect(await readFile('routes/web.ts', 'utf8')).toContain('registerAdminRoutes(router)')
  })

  it('scaffolds when the manifest names the client but there is no routes/web.ts', async () => {
    await mkdir('routes', { recursive: true })
    await writeFile('routes/api.ts', API_ROUTES_FIXTURE)
    await writeFile('package.json', JSON.stringify({
      name: 'web-app',
      dependencies: { '@guren/inertia-client': '^1.1.0' },
    }))

    const created = await runBlueprint('admin')

    expect(created.some((file) => file.endsWith('resources/js/pages/admin/Dashboard.tsx'))).toBe(true)
  })

  // `routes/web.js` is a route entry `doctor` accepts, so a fullstack app can
  // have one — and only the .ts name used to count as "has a web entry".
  it('scaffolds a JavaScript app whose route entry is routes/web.js', async () => {
    await mkdir('routes', { recursive: true })
    await writeFile('routes/web.js', DEFAULT_ROUTES_FIXTURE)
    await writeFile('package.json', JSON.stringify({ name: 'js-app' }))

    const created = await runBlueprint('admin')

    expect(created.some((file) => file.endsWith('routes/admin.ts'))).toBe(true)
  })

  // An unreadable manifest is another "cannot tell", and it must not surface as
  // a raw filesystem error from a command that was prepared to proceed.
  it.skipIf(!CAN_DENY_FILE_READS)('scaffolds when package.json cannot be read', async () => {
    await mkdir('routes', { recursive: true })
    await writeFile('routes/api.ts', API_ROUTES_FIXTURE)
    await writeFile('package.json', JSON.stringify({ name: 'locked-down' }))
    await chmod('package.json', 0o000)

    try {
      const created = await runBlueprint('admin')
      expect(created.some((file) => file.endsWith('routes/admin.ts'))).toBe(true)
    } finally {
      await chmod('package.json', 0o644)
    }
  })
})

describe('auth blueprint on an API-only app', () => {
  let workspace: TempWorkspace

  beforeEach(async () => {
    workspace = await createTempWorkspace('guren-cli-auth-api-only-')
  })

  afterEach(async () => {
    await workspace.cleanup()
  })

  // One test, because this blueprint is pure delegation to makeAuth() — the
  // only thing it can get wrong is failing to reach the guard at all. What the
  // guard then does, and every branch of the shared predicate behind it, is
  // pinned in make-auth.test.ts and in the admin block above.
  it('reaches the refusal inside makeAuth', async () => {
    await seedApiOnlyApp(workspace.dir)

    await expect(runBlueprint('auth')).rejects.toThrow(
      /no @guren\/inertia-client dependency and no routes\/web\.ts/,
    )
  })
})

describe('resource blueprint on an API-only app', () => {
  let workspace: TempWorkspace

  beforeEach(async () => {
    workspace = await createTempWorkspace('guren-cli-resource-api-only-')
  })

  afterEach(async () => {
    await workspace.cleanup()
  })

  it('refuses, naming the two signals it read', async () => {
    await seedApiOnlyApp(workspace.dir)

    await expect(runBlueprint('resource', { name: 'Post' })).rejects.toThrow(
      /no @guren\/inertia-client dependency and no routes\/web\.ts/,
    )
  })

  // The half that matters. `updateResourceSchema` runs before the route wiring
  // can fail, so the old run appended a table to a file the user wrote — the
  // one casualty deleting a scaffold does not undo.
  it('writes nothing at all, and leaves db/schema.ts byte-identical', async () => {
    await seedApiOnlyApp(workspace.dir)

    await expect(runBlueprint('resource', { name: 'Post' })).rejects.toThrow()

    // `existsSync` rather than the `fileExists` the predicate itself calls: a
    // bug in that helper must not be able to make this assertion pass.
    for (const path of [
      'app/Models/Post.ts',
      'app/Http/Controllers/PostController.ts',
      'app/Http/Resources/PostResource.ts',
      'app/Http/Validators/PostValidator.ts',
      'resources/js/pages/posts/Index.tsx',
      'resources/js/pages/posts/Show.tsx',
      'resources/js/pages/posts/New.tsx',
      'resources/js/pages/posts/Edit.tsx',
    ]) {
      expect(existsSync(resolve(workspace.dir, path))).toBe(false)
    }
    // No `posts` table appended, and the app's own routes file untouched.
    expect(await readFile('db/schema.ts', 'utf8')).toBe(PG_SCHEMA_FIXTURE)
    expect(await readFile('routes/api.ts', 'utf8')).toBe(API_ROUTES_FIXTURE)
  })

  // The template is what `create-guren-app` ships; the fixture above is its
  // reduction, not a substitute for it.
  it('refuses the api-only template as shipped', async () => {
    const templateDir = resolve(import.meta.dir, '../../create-app/templates/api-only')
    await mkdir('routes', { recursive: true })
    await mkdir('db', { recursive: true })
    await writeFile('routes/api.ts', await readFile(resolve(templateDir, 'routes/api.ts'), 'utf8'))
    await writeFile('db/schema.ts', await readFile(resolve(templateDir, 'db/schema.ts'), 'utf8'))
    await writeFile('package.json', await readFile(resolve(templateDir, 'package.json'), 'utf8'))

    await expect(runBlueprint('resource', { name: 'Post' })).rejects.toThrow(
      'guren add resource scaffolds Inertia pages',
    )
  })

  // A usage error must not be reported as an environment one, so the guard is
  // the last check rather than the first: on an API-only app a bad invocation
  // is still reported as a bad invocation.
  it('still reports a missing resource name first', async () => {
    await seedApiOnlyApp(workspace.dir)

    await expect(runBlueprint('resource', {})).rejects.toThrow(
      'The resource blueprint requires a resource name.',
    )
  })

  it('still reports an invalid field type first', async () => {
    await seedApiOnlyApp(workspace.dir)

    await expect(runBlueprint('resource', { name: 'Post', fields: 'title:bogus' })).rejects.toThrow(
      'Invalid field type "bogus"',
    )
  })

  // The manifest signal alone is enough to permit: a fullstack app in a
  // workspace whose deps are hoisted to the root has no client to find.
  // (The other direction — an absent manifest — cannot be isolated here,
  // because every scaffold that succeeds needs the `routes/web.ts` that
  // rescues it anyway. It is pinned in the admin block above.)
  it('scaffolds when routes/web.ts exists but the manifest does not name the client', async () => {
    await seedResourceWorkspace(PG_SCHEMA_FIXTURE)
    await writeFile('package.json', JSON.stringify({ name: 'workspace-member' }))

    const created = await runBlueprint('resource', { name: 'Post' })

    expect(created.some((file) => file.endsWith('resources/js/pages/posts/Index.tsx'))).toBe(true)
    expect(await readFile('routes/web.ts', 'utf8')).toContain("router.group('/posts'")
  })

  // The other signal on its own: an app that declares the client is never
  // refused as API-only. It still fails further in, because
  // `updateResourceRoutes` reads `routes/web.ts` unconditionally — a
  // pre-existing rough edge this guard does not address. Matched on `ENOENT`,
  // which only the later failure can produce: the guard's own message names
  // `routes/web.ts` too, so that string alone would not tell them apart.
  it('does not refuse an app that declares the client', async () => {
    await mkdir('resources/js/pages', { recursive: true })
    await mkdir('routes', { recursive: true })
    await mkdir('db', { recursive: true })
    await writeFile('routes/api.ts', API_ROUTES_FIXTURE)
    await writeFile('db/schema.ts', PG_SCHEMA_FIXTURE)
    await writeFile('package.json', JSON.stringify({
      name: 'web-app',
      dependencies: { '@guren/inertia-client': '^1.1.0' },
    }))

    await expect(runBlueprint('resource', { name: 'Post' })).rejects.toThrow(
      /ENOENT.*routes\/web\.ts/,
    )
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
