import { consola } from 'consola'
import { addAttachments, appBindsStorage } from './add-attachments'
import { addSession } from './add-session'
import { addLint } from './add-lint'
import { assertNotApiOnly } from './app-surface'
import { fileExists, readIfExists } from './discovery'
import { makeAuth } from './make-auth'
import { makeChannel } from './make-channel'
import { API_ONLY_FEATURE_ALTERNATIVE, buildRouteRegistrationHint, makeFeature } from './make-feature'
import { parseFieldsString, type FieldDefinition, type FieldType } from './fields'
import { collectionSlug, schemaIdentifierFor, singularize, tableNameFor } from './inflect'
import { schemaPathFor } from './schema-parser'
import { makeEvent } from './make-event'
import { makeJob } from './make-job'
import { makeListener } from './make-listener'
import { makeMail } from './make-mail'
import { makeNotification } from './make-notification'
import { detectSchemaDialect, ensureMysqlImports, ensurePgImports, ensureSqliteImports, insertImport } from './patch-helpers'
import { wireProviders } from './provider-registrar'
import { DEFAULT_ROUTES_FILE, findRouteRegistrar, wireRouteRegistrar } from './route-registrar'
import { scaffoldTemplateFile } from './scaffold-templates'
import { assertCwdUnsupported, camelCase, pascalCase, writeScaffoldFiles, type WriterOptions } from './utils'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export interface RunBlueprintOptions extends WriterOptions {
  name?: string
  /** Comma-separated field definitions for the resource blueprint, e.g. "title:string,body:text?". */
  fields?: string
  /**
   * Comma-separated attachment collections for the resource blueprint, e.g.
   * "cover:one,images:many". Passed through to `makeFeature`, which refuses
   * it on an app without `configureAttachments()`.
   */
  attach?: string
  /**
   * Skip the scaffold's authentication checks (default false). Scope differs per
   * blueprint: `resource` guards its mutating actions, `admin` the whole route.
   */
  publicAccess?: boolean
}

export interface BlueprintDefinition {
  description: string
  run: (options: RunBlueprintOptions) => Promise<string[]>
}

const blueprintRegistry: Record<string, BlueprintDefinition> = {
  attachments: {
    description: 'Install the attachments layer: schema table, config, provider, and the prune command.',
    run: async (options) => {
      const writerOptions: WriterOptions = { force: Boolean(options.force) }
      const created: string[] = []
      // Attachments need a 'storage' binding. Judged by looking for one
      // anywhere in the app's sources rather than for a conventional file: a
      // custom CloudStorageProvider must not get a second manager over it.
      const hasConventionalProvider = await fileExists(process.cwd(), 'app/Providers/StorageProvider.ts')
      if (!hasConventionalProvider && !(await appBindsStorage())) {
        consola.info("No 'storage' binding found — installing the storage blueprint first.")
        created.push(...(await blueprintRegistry.storage!.run(options)))
      }
      created.push(...(await addAttachments(writerOptions)))
      return created
    },
  },
  session: {
    description: 'Install database-backed sessions: the schema table and migration, config/session.ts, SessionProvider, and sessions:prune.',
    run: async (options) => (await addSession({ force: Boolean(options.force) })).files,
  },
  lint: {
    description: 'Install oxlint with the Guren rules: .oxlintrc.json, lint scripts, and the oxlint dev dependency.',
    run: async (options) => addLint({ force: Boolean(options.force) }),
  },
  admin: {
    description: 'Install a starter admin dashboard with dedicated routes and controller.',
    run: async (options) => {
      // Before the first write: every file below is Inertia-shaped, so a
      // partial scaffold here is only harder to clean up than none.
      await assertNotApiOnly(process.cwd(), {
        does: 'guren add admin scaffolds an Inertia dashboard',
        instead: 'Scaffold an admin endpoint with guren make:controller and register it in routes/api.ts',
      })

      const writerOptions: WriterOptions = { force: Boolean(options.force) }
      // Same default as `make:feature`: guarded unless the caller opts out.
      const withAuth = !options.publicAccess
      // Guarded in the action as well as on the route, so re-registering the
      // route without middleware cannot silently open the dashboard.
      const controllerGuard = withAuth ? `    await this.auth.userOrFail()\n\n` : ''
      // Inline rather than through an 'auth' alias: `aliasMiddleware('auth', …)`
      // writes into the router shared with routes/web.ts, so it would replace an
      // alias the app configured with different options.
      const routeGuard = withAuth ? `, requireAuthenticated({ redirectTo: '/login' })` : ''
      const created = await writeScaffoldFiles([
        {
          path: 'app/Http/Controllers/Admin/AdminDashboardController.ts',
          contents: `import { Controller } from '@guren/core'
import { pages } from '@/.guren/pages.gen'

export default class AdminDashboardController extends Controller {
  async index(): Promise<Response> {
${controllerGuard}    return this.inertia(pages.admin.Dashboard, {
      stats: {
        users: 0,
        posts: 0,
        comments: 0,
      },
    }, {
      title: 'Admin Dashboard',
      url: '/admin',
    })
  }
}
`,
        },
        scaffoldTemplateFile('admin', 'resources/js/pages/admin/Dashboard.tsx'),
        {
          path: 'routes/admin.ts',
          contents: `import { Router${withAuth ? ', requireAuthenticated' : ''} } from '@guren/core'
import AdminDashboardController from '../app/Http/Controllers/Admin/AdminDashboardController.js'

export function registerAdminRoutes(router: Router): void {
  router.get('/admin', [AdminDashboardController, 'index']${routeGuard}).name('admin.dashboard')
}

export default registerAdminRoutes
`,
        },
      ], writerOptions)

      await wireRouteRegistrar('registerAdminRoutes', "import registerAdminRoutes from './admin.js'")

      return created
    },
  },
  auth: {
    description: 'Install the default authentication stack for the current app.',
    // The API-only refusal lives inside makeAuth(): `guren make:auth` reaches
    // the same scaffold without passing through this registry.
    run: async (options) => makeAuth({ force: Boolean(options.force), install: true }),
  },
  oauth: {
    description: 'Install OAuth scaffolding with GitHub, Google, and Discord provider presets.',
    // No API-only guard, on purpose: the controller answers with `this.json(…)`
    // and `wireRouteRegistrar` warns rather than throws when routes/web.ts is
    // absent, so the scaffold genuinely works on an API-only app.
    run: async (options) => {
      const writerOptions: WriterOptions = { force: Boolean(options.force) }
      const created = await writeScaffoldFiles([
        scaffoldTemplateFile('oauth', 'app/Providers/OAuthProvider.ts'),
        scaffoldTemplateFile('oauth', 'app/Http/Controllers/Auth/OAuthController.ts'),
        scaffoldTemplateFile('oauth', 'routes/oauth.ts'),
      ], writerOptions)

      await wireProviders([
        { name: 'CoreOAuthServiceProvider', importStatement: "import { OAuthServiceProvider as CoreOAuthServiceProvider } from '@guren/core'" },
        { name: 'OAuthProvider' },
      ])

      await wireRouteRegistrar('registerOAuthRoutes', "import registerOAuthRoutes from './oauth.js'")

      return created
    },
  },
  cache: {
    description: 'Install the default cache provider and an example cache service.',
    run: async (options) => {
      const writerOptions: WriterOptions = { force: Boolean(options.force) }
      const created = await writeScaffoldFiles([
        scaffoldTemplateFile('cache', 'app/Providers/CacheProvider.ts'),
        scaffoldTemplateFile('cache', 'app/Services/ApplicationCache.ts'),
      ], writerOptions)

      await wireProviders([
        { name: 'CoreCacheServiceProvider', importStatement: "import { CacheServiceProvider as CoreCacheServiceProvider } from '@guren/core'" },
        { name: 'CacheProvider' },
      ])

      return created
    },
  },
  events: {
    description: 'Install event infrastructure with a sample event and listener.',
    run: async (options) => {
      const writerOptions: WriterOptions = { force: Boolean(options.force) }
      const eventPath = await makeEvent('OrderPlaced', writerOptions)
      const listenerPath = await makeListener('SendOrderReceipt', { ...writerOptions, event: 'OrderPlaced' })
      const created = await writeScaffoldFiles([
        scaffoldTemplateFile('events', 'app/Providers/EventProvider.ts'),
      ], writerOptions)

      await wireProviders([
        { name: 'CoreEventServiceProvider', importStatement: "import { EventServiceProvider as CoreEventServiceProvider } from '@guren/core'" },
        { name: 'EventProvider' },
      ])

      return [eventPath, listenerPath, ...created]
    },
  },
  mail: {
    description: 'Install mail infrastructure with a memory transport and sample mailable.',
    run: async (options) => {
      const writerOptions: WriterOptions = { force: Boolean(options.force) }
      const mailPath = await makeMail('WelcomeEmail', writerOptions)
      const created = await writeScaffoldFiles([
        scaffoldTemplateFile('mail', 'app/Providers/MailProvider.ts'),
      ], writerOptions)

      await wireProviders([
        { name: 'CoreMailServiceProvider', importStatement: "import { MailServiceProvider as CoreMailServiceProvider } from '@guren/core'" },
        { name: 'MailProvider' },
      ])

      return [mailPath, ...created]
    },
  },
  queue: {
    description: 'Install queue infrastructure with a memory driver and sample job.',
    run: async (options) => {
      const writerOptions: WriterOptions = { force: Boolean(options.force) }
      const jobPath = await makeJob('ProcessWelcomeSequence', writerOptions)
      const created = await writeScaffoldFiles([
        scaffoldTemplateFile('queue', 'app/Providers/QueueProvider.ts'),
      ], writerOptions)

      await wireProviders([
        { name: 'CoreQueueServiceProvider', importStatement: "import { QueueServiceProvider as CoreQueueServiceProvider } from '@guren/core'" },
        { name: 'QueueProvider' },
      ])

      return [jobPath, ...created]
    },
  },
  notifications: {
    description: 'Install notification infrastructure with mail/database channels and a sample notification.',
    run: async (options) => {
      const writerOptions: WriterOptions = { force: Boolean(options.force) }
      const notificationPath = await makeNotification('WelcomeUser', writerOptions)
      const created = await writeScaffoldFiles([
        scaffoldTemplateFile('notifications', 'app/Providers/NotificationProvider.ts'),
      ], writerOptions)

      await wireProviders([
        { name: 'CoreNotificationServiceProvider', importStatement: "import { NotificationServiceProvider as CoreNotificationServiceProvider } from '@guren/core'" },
        { name: 'NotificationProvider' },
      ])

      return [notificationPath, ...created]
    },
  },
  storage: {
    description: 'Install storage infrastructure with local/public disks (switchable via STORAGE_DISK) and a sample storage service.',
    run: async (options) => {
      const writerOptions: WriterOptions = { force: Boolean(options.force) }
      const created = await writeScaffoldFiles([
        scaffoldTemplateFile('storage', 'app/Providers/StorageProvider.ts'),
        scaffoldTemplateFile('storage', 'app/Services/FileStorage.ts'),
      ], writerOptions)

      await wireProviders([
        { name: 'CoreStorageServiceProvider', importStatement: "import { StorageServiceProvider as CoreStorageServiceProvider } from '@guren/core'" },
        { name: 'StorageProvider' },
      ])

      return created
    },
  },
  broadcasting: {
    description: 'Install broadcasting infrastructure with a memory driver and sample public/private channels.',
    run: async (options) => {
      const writerOptions: WriterOptions = { force: Boolean(options.force) }
      const publicChannelPath = await makeChannel('Orders', { ...writerOptions, channel: 'orders' })
      const privateChannelPath = await makeChannel('UserFeed', {
        ...writerOptions,
        channel: 'users.{id}.feed',
        private: true,
      })
      const created = await writeScaffoldFiles([
        scaffoldTemplateFile('broadcasting', 'app/Providers/BroadcastProvider.ts'),
      ], writerOptions)

      await wireProviders([
        { name: 'CoreBroadcastServiceProvider', importStatement: "import { BroadcastServiceProvider as CoreBroadcastServiceProvider } from '@guren/core'" },
        { name: 'BroadcastProvider' },
      ])

      return [publicChannelPath, privateChannelPath, ...created]
    },
  },
  resource: {
    description: 'Scaffold a model, controller, route group, and page entry for a resource.',
    run: async (options) => {
      if (!options.name?.trim()) {
        throw new Error('The resource blueprint requires a resource name.')
      }

      const singular = singularize(pascalCase(options.name.trim()))
      const routeName = collectionSlug(singular)
      const routeVar = camelCase(routeName)
      const fields = parseFieldsString(options.fields ?? '')

      // Last of the checks, still before the first write: `updateResourceSchema`
      // runs before the route wiring can fail, so reaching that failure would
      // append a table to the app's own `db/schema.ts`.
      await assertNotApiOnly(process.cwd(), {
        does: 'guren add resource scaffolds Inertia pages and a controller that returns Inertia responses',
        instead: API_ONLY_FEATURE_ALTERNATIVE,
      })

      // Second, so an app the check above recognizes hears about its shape
      // rather than about a missing file.
      await assertResourceTargetsPatchable(routeName)

      const created = await makeFeature(singular, {
        force: Boolean(options.force),
        fields: options.fields,
        attach: options.attach,
        publicAccess: options.publicAccess,
        announce: false,
      })

      await updateResourceSchema(singular, fields)
      await updateResourceRoutes(singular, routeName, routeVar)

      return created
    },
  },
  schedule: {
    description: 'Install a schedule kernel with a sample recurring task.',
    run: async (options) => {
      const writerOptions: WriterOptions = { force: Boolean(options.force) }
      const created = await writeScaffoldFiles([
        scaffoldTemplateFile('schedule', 'app/Console/Kernel.ts'),
      ], writerOptions)

      await wireProviders([{ name: 'CoreSchedulingServiceProvider', importStatement: "import { SchedulingServiceProvider as CoreSchedulingServiceProvider } from '@guren/core'" }])

      return created
    },
  },
}

interface ColumnCode {
  code: string
  imports: string[]
}

/**
 * Per-dialect column builders, keyed by field type. `Record<FieldType, …>` so a
 * missing key fails to compile — a switch with a `default:` arm is how sqlite
 * shipped without a `date` case and quietly emitted text for it.
 */
type ColumnMapping = Record<FieldType, (name: string, notNull: string) => ColumnCode>

const SQLITE_COLUMNS: ColumnMapping = {
  string: (name, notNull) => ({ code: `text('${name}')${notNull}`, imports: ['text'] }),
  text: (name, notNull) => ({ code: `text('${name}')${notNull}`, imports: ['text'] }),
  number: (name, notNull) => ({ code: `integer('${name}')${notNull}`, imports: ['integer'] }),
  boolean: (name, notNull) => ({ code: `integer('${name}', { mode: 'boolean' })${notNull}`, imports: ['integer'] }),
  // Timestamp mode keeps the record type a `Date`, matching pg/mysql — a bare
  // text column would reject the `Date` that `z.coerce.date()` produces.
  date: (name, notNull) => ({ code: `integer('${name}', { mode: 'timestamp' })${notNull}`, imports: ['integer'] }),
  json: (name, notNull) => ({ code: `text('${name}', { mode: 'json' })${notNull}`, imports: ['text'] }),
}

const PG_COLUMNS: ColumnMapping = {
  string: (name, notNull) => ({ code: `text('${name}')${notNull}`, imports: ['text'] }),
  text: (name, notNull) => ({ code: `text('${name}')${notNull}`, imports: ['text'] }),
  number: (name, notNull) => ({ code: `integer('${name}')${notNull}`, imports: ['integer'] }),
  boolean: (name, notNull) => ({ code: `boolean('${name}')${notNull}`, imports: ['boolean'] }),
  // `timestamptz`, not `timestamp`. Drizzle writes `Date.toISOString()`, so
  // `timestamp without time zone` drops the offset: drizzle reads it back as UTC
  // and stays self-consistent, but psql and any other client see a different
  // instant.
  date: (name, notNull) => ({ code: `timestamp('${name}', { withTimezone: true })${notNull}`, imports: ['timestamp'] }),
  json: (name, notNull) => ({ code: `jsonb('${name}')${notNull}`, imports: ['jsonb'] }),
}

const MYSQL_COLUMNS: ColumnMapping = {
  string: (name, notNull) => ({ code: `varchar('${name}', { length: 255 })${notNull}`, imports: ['varchar'] }),
  text: (name, notNull) => ({ code: `varchar('${name}', { length: 255 })${notNull}`, imports: ['varchar'] }),
  number: (name, notNull) => ({ code: `int('${name}')${notNull}`, imports: ['int'] }),
  boolean: (name, notNull) => ({ code: `boolean('${name}')${notNull}`, imports: ['boolean'] }),
  // Bare `timestamp` on purpose — MySQL has no `timestamptz`, and its TIMESTAMP
  // is already stored as UTC and converted per session, so it round-trips the
  // instant. `datetime` is the one that would drop the offset here.
  date: (name, notNull) => ({ code: `timestamp('${name}')${notNull}`, imports: ['timestamp'] }),
  json: (name, notNull) => ({ code: `json('${name}')${notNull}`, imports: ['json'] }),
}

function buildColumn(mapping: ColumnMapping, field: FieldDefinition): ColumnCode {
  return mapping[field.type](snakeCase(field.name), field.nullable ? '' : '.notNull()')
}

/**
 * Column name for a field. Deliberately separate from `tableNameFor()`, which
 * goes through `kebabCase()` and collapses `[_\s]+` to one separator: a field
 * name is taken verbatim from the user and `__dunder__` must survive intact.
 */
function snakeCase(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
}

async function updateResourceSchema(singular: string, fields: FieldDefinition[]): Promise<void> {
  const schemaPath = resolve(process.cwd(), schemaPathFor(null))
  let content = await readFile(schemaPath, 'utf8')
  const schemaIdentifier = schemaIdentifierFor(singular)
  const tableName = tableNameFor(singular)

  const dialect = detectSchemaDialect(content)

  if (dialect === 'sqlite') {
    if (content.includes(`export const ${schemaIdentifier} = sqliteTable(`)) {
      return
    }

    const columns = fields.map((field) => buildColumn(SQLITE_COLUMNS, field))
    const imports = [...new Set(['sqliteTable', 'integer', 'text', ...columns.flatMap((c) => c.imports)])]
    content = ensureSqliteImports(content, imports)

    const fieldLines = fields.map((field, index) => `  ${field.name}: ${columns[index].code},`).join('\n')
    const schemaBlock = `\nexport const ${schemaIdentifier} = sqliteTable('${tableName}', {\n  id: integer('id').primaryKey({ autoIncrement: true }),\n${fieldLines}\n  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),\n})\n`

    content = `${content.trimEnd()}\n${schemaBlock}`
  } else if (dialect === 'mysql') {
    if (content.includes(`export const ${schemaIdentifier} = mysqlTable(`)) {
      return
    }

    const columns = fields.map((field) => buildColumn(MYSQL_COLUMNS, field))
    const imports = [...new Set(['mysqlTable', 'int', 'timestamp', ...columns.flatMap((c) => c.imports)])]
    content = ensureMysqlImports(content, imports)

    const fieldLines = fields.map((field, index) => `  ${field.name}: ${columns[index].code},`).join('\n')
    const schemaBlock = `\nexport const ${schemaIdentifier} = mysqlTable('${tableName}', {\n  id: int('id').primaryKey().autoincrement(),\n${fieldLines}\n  createdAt: timestamp('created_at').defaultNow().notNull(),\n})\n`

    content = `${content.trimEnd()}\n${schemaBlock}`
  } else {
    if (content.includes(`export const ${schemaIdentifier} = pgTable(`)) {
      return
    }

    const columns = fields.map((field) => buildColumn(PG_COLUMNS, field))
    const imports = [...new Set(['pgTable', 'serial', 'text', 'timestamp', ...columns.flatMap((c) => c.imports)])]
    content = ensurePgImports(content, imports)

    const fieldLines = fields.map((field, index) => `  ${field.name}: ${columns[index].code},`).join('\n')
    const schemaBlock = `\nexport const ${schemaIdentifier} = pgTable('${tableName}', {\n  id: serial('id').primaryKey(),\n${fieldLines}\n  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),\n})\n`

    content = `${content.trimEnd()}\n${schemaBlock}`
  }

  await writeFile(schemaPath, content, 'utf8')
}

/**
 * Whether an app's routes file already registers the resource's own routes. Both
 * probes are anchored on the full literal the registration emits: unanchored,
 * an unrelated `/admin/posts` read as already registered and the run reported
 * success while registering nothing.
 */
function routesAlreadyRegister(content: string, routeName: string): boolean {
  return content.includes(`'${routeName}.index'`) || content.includes(`'/${routeName}'`)
}

function missingRegistrarMessage(routeName: string): string {
  return `Could not find a route registrar in ${DEFAULT_ROUTES_FILE}. Register the /${routeName} routes manually.`
}

/**
 * Every reason the two app-owned files this blueprint patches cannot be patched,
 * established before `makeFeature` writes its first file: the table appended to
 * `db/schema.ts` cannot be undone by deleting anything, so neither patch may
 * start until both targets are known reachable. Scoped to that — a target that
 * exists but cannot be written still fails in the writer.
 */
async function assertResourceTargetsPatchable(routeName: string): Promise<void> {
  const cwd = process.cwd()
  const schemaFile = schemaPathFor(null)

  if (!(await fileExists(cwd, schemaFile))) {
    throw new Error(
      `guren add resource appends its table to ${schemaFile}, but this app has no ${schemaFile}. `
      + 'Nothing was scaffolded.',
    )
  }

  const routes = await readIfExists(cwd, DEFAULT_ROUTES_FILE)

  if (routes === null) {
    throw new Error(
      `guren add resource registers the /${routeName} routes in ${DEFAULT_ROUTES_FILE}, but this app has no `
      + `${DEFAULT_ROUTES_FILE}. Nothing was scaffolded. Add a web routes entry, or scaffold the resource with `
      + '`guren make:feature` and wire it into the routes file you have.',
    )
  }

  // Must keep mirroring `updateResourceRoutes`: waiving the registrar
  // requirement is only safe because the writer applies the same predicate to
  // the same content. Tightening either site alone reintroduces the half-edited
  // app this function exists to prevent.
  if (!routesAlreadyRegister(routes, routeName) && !findRouteRegistrar(routes)) {
    throw new Error(missingRegistrarMessage(routeName))
  }
}

async function updateResourceRoutes(singular: string, routeName: string, routeVar: string): Promise<void> {
  const routesPath = resolve(process.cwd(), DEFAULT_ROUTES_FILE)
  let content = await readFile(routesPath, 'utf8')

  if (!routesAlreadyRegister(content, routeName)) {
    const registrar = findRouteRegistrar(content)

    // Unreachable via `runBlueprint`, which settles this in the preflight, but
    // the insertion below dereferences `registrar` either way.
    if (!registrar) {
      throw new Error(missingRegistrarMessage(routeName))
    }

    // The same CRUD block `make:feature` prints for hand-wiring, hung off the
    // registrar's own parameter — whatever it is named.
    const group = buildRouteRegistrationHint({
      singular,
      routeName,
      routeVar,
      withAuth: false,
      receiver: registrar.parameterName,
    })

    const groupBlock = `\n${group.map((line) => `  ${line}`).join('\n')}\n`
    content = content.slice(0, registrar.bodyEnd) + groupBlock + content.slice(registrar.bodyEnd)

    // Inside the guard: appended when the registration is skipped, these are
    // unused bindings and the app stops compiling under noUnusedLocals.
    for (const statement of [
      `import ${singular}Controller from '../app/Http/Controllers/${singular}Controller.js'`,
      `import { ${singular}PayloadSchema } from '../app/Http/Validators/${singular}Validator.js'`,
    ]) {
      content = insertImport(content, statement) ?? content
    }
  }

  await writeFile(routesPath, content, 'utf8')
}

export function listBlueprints(): string[] {
  return Object.keys(blueprintRegistry).sort()
}

export function getBlueprint(name: string): BlueprintDefinition {
  const blueprint = blueprintRegistry[name]
  if (!blueprint) {
    throw new Error(`Unknown blueprint "${name}". Available blueprints: ${listBlueprints().join(', ')}`)
  }
  return blueprint
}

export async function runBlueprint(name: string, options: RunBlueprintOptions = {}): Promise<string[]> {
  assertCwdUnsupported(options, 'guren new --blueprint')
  return getBlueprint(name).run(options)
}
