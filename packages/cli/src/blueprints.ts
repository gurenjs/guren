import { consola } from 'consola'
import { addAttachments, appBindsStorage } from './add-attachments'
import { addCache } from './add-cache'
import { addLint } from './add-lint'
import { addOAuth } from './add-oauth'
import { addSession } from './add-session'
import { addPrototype } from './add-prototype'
import { assertNotApiOnly } from './app-surface'
import { CliError } from './cli-error'
import { fileExists, readIfExists } from './discovery'
import { makeAuth } from './make-auth'
import { channelFile } from './make-channel'
import { API_ONLY_FEATURE_ALTERNATIVE, buildRouteRegistrationHint, makeFeature } from './make-feature'
import { parseFieldsString, type FieldDefinition } from './fields'
import { collectionSlug, schemaIdentifierFor, singularize, tableNameFor } from './inflect'
import { autoIncrementPrimaryKey, buildFieldColumn, TABLE_FACTORY } from './schema-columns'
import { schemaDeclaresTable, schemaPathFor, type SchemaDialect } from './schema-parser'
import { eventFile } from './make-event'
import { jobFile } from './make-job'
import { listenerFile } from './make-listener'
import { mailFile } from './make-mail'
import { appMailBindings, MAIL_SCAFFOLD, reportKeptMail } from './mail-scaffold'
import { notificationFile } from './make-notification'
import { appendTableToSchema, detectSchemaDialect, ensureNamedImports, insertImport } from './patch-helpers'
import { DIALECT_BARRELS } from './drizzle-specifiers'
import { wireProviders } from './provider-registrar'
import { DEFAULT_ROUTES_FILE, findRouteRegistrar, wireRouteRegistrar } from './route-registrar'
import { scaffoldTemplateFile } from './scaffold-templates'
import { installServiceScaffold } from './service-scaffold'
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

/** The scaffolded schedule kernel, and the export `SchedulingProvider` imports from it. */
const SCHEDULE_KERNEL_PATH = 'app/Console/Kernel.ts'
const SCHEDULE_KERNEL_EXPORT = 'scheduleTasksKernel'
/** `export` and the name on one line: the function, `const`, and re-export forms. */
const SCHEDULE_KERNEL_EXPORT_PATTERN = /\bexport\b[^\n]*\bscheduleTasksKernel\b/

/** `root` stays behind: blueprints have always scaffolded into the project root. */
function blueprintWriterOptions(options: RunBlueprintOptions): WriterOptions {
  return { force: Boolean(options.force), overwritten: options.overwritten }
}

const blueprintRegistry: Record<string, BlueprintDefinition> = {
  attachments: {
    description: 'Install the attachments layer: schema table, config, provider, and the prune command.',
    run: async (options) => {
      const writerOptions = blueprintWriterOptions(options)
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
    description: 'Install database-backed sessions: the schema table and migration, config/session.ts, and sessions:prune.',
    run: async (options) => (await addSession(blueprintWriterOptions(options))).files,
  },
  lint: {
    description: 'Install oxlint with the Guren rules: .oxlintrc.json, lint scripts, and the oxlint dev dependency.',
    run: async (options) => addLint(blueprintWriterOptions(options)),
  },
  prototype: {
    description: 'Install prototype mode (RFC 0021): the fixture module, the dev:prototype/build:prototype scripts, and the client and app wiring.',
    run: async (options) => addPrototype(blueprintWriterOptions(options)),
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

      const writerOptions = blueprintWriterOptions(options)
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
    run: async (options) => makeAuth({ ...blueprintWriterOptions(options), install: true }),
  },
  oauth: {
    description: 'Install OAuth scaffolding with GitHub, Google, and Discord provider presets.',
    // No API-only guard, on purpose: the controller answers with `this.json(…)`
    // and `wireRouteRegistrar` warns rather than throws when routes/web.ts is
    // absent, so the scaffold genuinely works on an API-only app.
    run: async (options) => addOAuth(blueprintWriterOptions(options)),
  },
  cache: {
    description: 'Install the cache config, an example cache service, and the CACHE_STORE env entry.',
    run: async (options) => addCache(blueprintWriterOptions(options)),
  },
  events: {
    description: 'Install event infrastructure with a sample event and listener.',
    run: async (options) => {
      const writerOptions = blueprintWriterOptions(options)
      const created = await writeScaffoldFiles([
        eventFile('OrderPlaced', writerOptions),
        listenerFile('SendOrderReceipt', { ...writerOptions, event: 'OrderPlaced' }),
        scaffoldTemplateFile('events', 'app/Providers/EventProvider.ts'),
      ], writerOptions)

      await wireProviders([
        { name: 'CoreEventServiceProvider', importStatement: "import { EventServiceProvider as CoreEventServiceProvider } from '@guren/core'" },
        { name: 'EventProvider' },
      ])

      return created
    },
  },
  mail: {
    description: 'Install mail infrastructure with a transport switchable via MAIL_MAILER and a sample mailable.',
    run: async (options) => {
      const writerOptions = blueprintWriterOptions(options)
      const existingMail = await appMailBindings()
      const mailable = mailFile('WelcomeEmail', writerOptions)
      if (existingMail.length > 0) {
        const created = await writeScaffoldFiles([mailable], writerOptions)
        await reportKeptMail(existingMail, 'only the sample mailable was written')
        return created
      }
      return installServiceScaffold(MAIL_SCAFFOLD, writerOptions, [mailable])
    },
  },
  queue: {
    description: 'Install queue infrastructure with sync/memory drivers (switchable via QUEUE_CONNECTION) and a sample job.',
    run: async (options) => {
      const writerOptions = blueprintWriterOptions(options)
      return installServiceScaffold({
        key: 'queue',
        coreProvider: 'QueueServiceProvider',
        provider: 'QueueProvider',
        // A definition binds the queue; the jobs it runs still need a provider's boot().
        definitionProviders: ['JobsProvider'],
        env: [{
          key: 'QUEUE_CONNECTION',
          entry: `
# Which queue driver dispatch uses: sync runs jobs inline, memory queues them for a worker.
QUEUE_CONNECTION=sync
`,
        }],
      }, writerOptions, [jobFile('ProcessWelcomeSequence', writerOptions)])
    },
  },
  notifications: {
    description: 'Install notification infrastructure with mail/database channels and a sample notification.',
    run: async (options) => {
      const writerOptions = blueprintWriterOptions(options)
      const created = await writeScaffoldFiles([
        notificationFile('WelcomeUser', writerOptions),
        scaffoldTemplateFile('notifications', 'app/Providers/NotificationProvider.ts'),
      ], writerOptions)

      await wireProviders([
        { name: 'CoreNotificationServiceProvider', importStatement: "import { NotificationServiceProvider as CoreNotificationServiceProvider } from '@guren/core'" },
        { name: 'NotificationProvider' },
      ])

      return created
    },
  },
  storage: {
    description: 'Install storage infrastructure with local/public disks (switchable via STORAGE_DISK) and a sample storage service.',
    run: async (options) => installServiceScaffold({
      key: 'storage',
      coreProvider: 'StorageServiceProvider',
      provider: 'StorageProvider',
      shared: ['app/Services/FileStorage.ts'],
      env: [{
        key: 'STORAGE_DISK',
        entry: `
# Which disk the app stores to. Declare it in the storage config before naming it here.
STORAGE_DISK=local
`,
      }],
    }, blueprintWriterOptions(options)),
  },
  broadcasting: {
    description: 'Install broadcasting infrastructure with a memory driver and sample public/private channels.',
    run: async (options) => {
      const writerOptions = blueprintWriterOptions(options)
      const created = await writeScaffoldFiles([
        channelFile('Orders', { ...writerOptions, channel: 'orders' }),
        channelFile('UserFeed', { ...writerOptions, channel: 'users.{id}.feed', private: true }),
        scaffoldTemplateFile('broadcasting', 'app/Providers/BroadcastProvider.ts'),
      ], writerOptions)

      await wireProviders([
        { name: 'CoreBroadcastServiceProvider', importStatement: "import { BroadcastServiceProvider as CoreBroadcastServiceProvider } from '@guren/core'" },
        { name: 'BroadcastProvider' },
      ])

      return created
    },
  },
  resource: {
    description: 'Scaffold a model, controller, route group, and page entry for a resource.',
    run: async (options) => (await addResource(options)).created,
  },
  schedule: {
    description: 'Install a schedule kernel with a sample recurring task.',
    run: async (options) => {
      const writerOptions = blueprintWriterOptions(options)
      // The provider imports `scheduleTasksKernel`. A kernel already on disk that
      // exports something else — the registrar shape `schedule:list` also reads —
      // makes that provider a file the app cannot boot, so it is not written.
      const existingKernel = writerOptions.force ? null : await readIfExists(process.cwd(), SCHEDULE_KERNEL_PATH)
      const kernelFeedsProvider = existingKernel === null || SCHEDULE_KERNEL_EXPORT_PATTERN.test(existingKernel)

      // `skipExisting`, so an app that ran this before the provider existed can
      // re-run it for the provider alone: without it the present Kernel.ts aborts
      // the command, and --force would overwrite the tasks the app has written.
      const created = await writeScaffoldFiles([
        scaffoldTemplateFile('schedule', SCHEDULE_KERNEL_PATH),
        ...(kernelFeedsProvider ? [scaffoldTemplateFile('schedule', 'app/Providers/SchedulingProvider.ts')] : []),
      ], { ...writerOptions, skipExisting: true })

      if (!kernelFeedsProvider) {
        consola.warn(`${SCHEDULE_KERNEL_PATH} exports no ${SCHEDULE_KERNEL_EXPORT}() — app/Providers/SchedulingProvider.ts was not written.`)
        consola.info('Feed your own kernel to the scheduler from a provider of your own, or its tasks reach no scheduler: https://guren.dev/en/guides/scheduling')
      }

      // Order matters: the app provider registers after core's and rebinds
      // `scheduler` with the kernel's tasks. Core's binding on its own is an empty
      // scheduler, which no task from the kernel this just wrote ever reaches.
      await wireProviders([
        { name: 'CoreSchedulingServiceProvider', importStatement: "import { SchedulingServiceProvider as CoreSchedulingServiceProvider } from '@guren/core'" },
        ...(kernelFeedsProvider ? [{ name: 'SchedulingProvider' }] : []),
      ])

      return created
    },
  },
}

export interface AddResourceResult {
  created: string[]
  /** The prototype's validator and pages a promotion left as they were. */
  kept: string[]
  /** False when `db/schema.ts` already exported the table and was left as it was. */
  schemaUpdated: boolean
  /** False when `routes/web.ts` already registered the resource's routes. */
  routesUpdated: boolean
}

export async function addResource(options: RunBlueprintOptions): Promise<AddResourceResult> {
  assertCwdUnsupported(options, 'guren add resource')
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

  const kept: string[] = []
  const created = await makeFeature(singular, {
    ...blueprintWriterOptions(options),
    fields: options.fields,
    attach: options.attach,
    publicAccess: options.publicAccess,
    announce: false,
    kept,
  })

  const schemaUpdated = await updateResourceSchema(singular, fields)
  const routesUpdated = await updateResourceRoutes(singular, routeName, routeVar)

  return { created, kept, schemaUpdated, routesUpdated }
}

/** Per dialect, the builders the resource table calls besides its columns', and its `createdAt`. */
const RESOURCE_TABLE: Record<SchemaDialect, { imports: string[]; createdAt: string }> = {
  sqlite: { imports: ['integer', 'text'], createdAt: "text('created_at').notNull().$defaultFn(() => new Date().toISOString())" },
  mysql: { imports: ['int', 'timestamp'], createdAt: "timestamp('created_at').defaultNow().notNull()" },
  pg: { imports: ['serial', 'text', 'timestamp'], createdAt: "timestamp('created_at', { withTimezone: true }).defaultNow().notNull()" },
}

async function updateResourceSchema(singular: string, fields: FieldDefinition[]): Promise<boolean> {
  const schemaPath = resolve(process.cwd(), schemaPathFor(null))
  let content = await readFile(schemaPath, 'utf8')
  const schemaIdentifier = schemaIdentifierFor(singular)
  const tableName = tableNameFor(singular)

  // The same reading `make:feature` gives the table, so the two commands cannot
  // disagree about whether it is already declared.
  if (await schemaDeclaresTable(process.cwd(), schemaIdentifier)) {
    return false
  }

  const dialect = detectSchemaDialect(content)
  const columns = fields.map((field) => buildFieldColumn(dialect, field))
  const factory = TABLE_FACTORY[dialect]
  const { imports, createdAt } = RESOURCE_TABLE[dialect]
  content = ensureNamedImports(content, DIALECT_BARRELS[dialect], [...new Set([factory, ...imports, ...columns.flatMap((c) => c.imports)])])

  const fieldLines = fields.map((field, index) => `  ${field.name}: ${columns[index].code},`).join('\n')
  const schemaBlock = `\nexport const ${schemaIdentifier} = ${factory}('${tableName}', {\n  id: ${autoIncrementPrimaryKey(dialect, 'id').code},\n${fieldLines}\n  createdAt: ${createdAt},\n})\n`
  content = appendTableToSchema(content, schemaIdentifier, schemaBlock).source

  await writeFile(schemaPath, content, 'utf8')
  return true
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
    throw new CliError(
      `guren add resource appends its table to ${schemaFile}, but this app has no ${schemaFile}. `
      + 'Nothing was scaffolded.',
    )
  }

  const routes = await readIfExists(cwd, DEFAULT_ROUTES_FILE)

  if (routes === null) {
    throw new CliError(
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
    throw new CliError(missingRegistrarMessage(routeName))
  }
}

async function updateResourceRoutes(singular: string, routeName: string, routeVar: string): Promise<boolean> {
  const routesPath = resolve(process.cwd(), DEFAULT_ROUTES_FILE)
  let content = await readFile(routesPath, 'utf8')

  if (routesAlreadyRegister(content, routeName)) {
    return false
  }

  const registrar = findRouteRegistrar(content)

  // Unreachable via `addResource`, which settles this in the preflight, but
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

  // After the early return: added when the registration is skipped, these are
  // unused bindings and the app stops compiling under noUnusedLocals.
  for (const statement of [
    `import ${singular}Controller from '../app/Http/Controllers/${singular}Controller.js'`,
    `import { ${singular}PayloadSchema } from '../app/Http/Validators/${singular}Validator.js'`,
  ]) {
    content = insertImport(content, statement) ?? content
  }

  await writeFile(routesPath, content, 'utf8')
  return true
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
