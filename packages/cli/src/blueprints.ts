import { consola } from 'consola'
import { assertNotApiOnly } from './app-surface'
import { fileExists, readIfExists } from './discovery'
import { makeAuth } from './make-auth'
import { makeChannel } from './make-channel'
import { API_ONLY_FEATURE_ALTERNATIVE, buildRouteRegistrationHint, makeFeature } from './make-feature'
import { parseFieldsString, type FieldDefinition, type FieldType } from './fields'
import { collectionSlug, schemaIdentifierFor, singularize, tableNameFor } from './inflect'
import { schemaPathFor } from './schema-parser'
import { makeController } from './make-controller'
import { makeEvent } from './make-event'
import { makeJob } from './make-job'
import { makeListener } from './make-listener'
import { makeMail } from './make-mail'
import { makeModel } from './make-model'
import { makeNotification } from './make-notification'
import { makeRoute } from './make-route'
import { makeView } from './make-view'
import { addImport, addProvider, detectSchemaDialect, ensureDrizzleImports, ensureMysqlImports, ensureSqliteImports, insertImport } from './patch-helpers'
import { DEFAULT_ROUTES_FILE, findRouteRegistrar, wireRouteRegistrar } from './route-registrar'
import { assertCwdUnsupported, camelCase, pascalCase, writeScaffoldFiles, type WriterOptions } from './utils'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export interface RunBlueprintOptions extends WriterOptions {
  name?: string
  /** Comma-separated field definitions for the resource blueprint, e.g. "title:string,body:text?". */
  fields?: string
  /**
   * Skip the scaffold's authentication checks. Defaults to false (auth required).
   *
   * Scope differs per blueprint: the resource blueprint guards its mutating
   * actions (store/update/destroy), the admin blueprint guards the whole
   * dashboard route.
   */
  publicAccess?: boolean
}

export interface BlueprintDefinition {
  description: string
  run: (options: RunBlueprintOptions) => Promise<string[]>
}

/** The one file the infrastructure blueprints register their providers in. */
const APP_FILE = 'src/app.ts'

/**
 * Registers a provider in the app file, reporting every outcome.
 *
 * Nothing here may be silent. `addImport`/`addProvider` return
 * `{ modified: false, reason }` rather than throwing, and the results used to be
 * discarded: an app with no `src/app.ts`, or one whose providers array the patch
 * cannot find, got its provider file written, nothing registered, and a success
 * report — and then booted without the feature the CLI just said it installed.
 *
 * Same rule as `wireRouteRegistrar()`, and for the same reason the scaffold is
 * not refused here: every file these blueprints write is deletable, so an
 * unpatchable app file earns a warning naming what to register by hand.
 */
async function installProvider(importStatement: string, providerName: string): Promise<void> {
  // The array first: on a file whose providers array cannot be patched, the
  // import would be a binding nothing uses, and the app it was scaffolded into
  // stops compiling under noUnusedLocals over a feature it never received.
  const registration = await addProvider(APP_FILE, providerName)

  if (registration.modified || registration.reason === 'Provider already registered') {
    const imported = await addImport(APP_FILE, importStatement)
    if (!imported.modified && imported.reason !== 'Import already exists') {
      consola.warn(`Could not add the ${providerName} import to ${APP_FILE}: ${imported.reason}. Add it by hand: ${importStatement}`)
    }
    return
  }

  if (registration.reason === 'File not found') {
    consola.warn(`Could not find ${APP_FILE} — ${providerName} was not registered.`)
  } else {
    consola.warn(`Could not register ${providerName} in ${APP_FILE}: ${registration.reason}.`)
  }
  consola.info(`Add ${providerName} to your createApp() providers array by hand: ${importStatement}`)
}

async function scaffoldFeatureFiles(
  files: Array<{ path: string; contents: string }>,
  options: WriterOptions,
): Promise<string[]> {
  return writeScaffoldFiles(files, options)
}

const blueprintRegistry: Record<string, BlueprintDefinition> = {
  admin: {
    description: 'Install a starter admin dashboard with dedicated routes and controller.',
    run: async (options) => {
      // Before the first write: every file below is Inertia-shaped, so a
      // partial scaffold here is only harder to clean up than none.
      await assertNotApiOnly(process.cwd(), {
        does: 'guren add admin scaffolds an Inertia dashboard',
        instead: 'Add an admin endpoint to routes/api.ts by hand',
      })

      const writerOptions: WriterOptions = { force: Boolean(options.force) }
      // Same default as `make:feature`: guarded unless the caller opts out.
      const withAuth = !options.publicAccess
      // Guarded in the action as well as on the route, so re-registering the
      // route without middleware cannot silently open the dashboard. Emitted
      // bare, matching `make:feature`'s own guard — the rationale belongs here,
      // not in the app author's file.
      const controllerGuard = withAuth ? `    await this.auth.userOrFail()\n\n` : ''
      // Attached inline — the shape `make:auth` writes into its own routes file
      // — rather than through an 'auth' alias. This file lands in apps that may
      // never have run `guren add auth`, and `aliasMiddleware('auth', ...)`
      // writes into the router shared with routes/web.ts, so it would silently
      // replace an alias the app configured with different options.
      const routeGuard = withAuth ? `, requireAuthenticated({ redirectTo: '/login' })` : ''
      const created = await scaffoldFeatureFiles([
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
        {
          path: 'resources/js/pages/admin/Dashboard.tsx',
          contents: `type Props = {
  stats: {
    users: number
    posts: number
    comments: number
  }
}

export default function AdminDashboard({ stats }: Props) {
  return (
    <main className="mx-auto max-w-5xl space-y-8 px-6 py-12">
      <header className="space-y-2">
        <p className="text-xs uppercase tracking-wide text-zinc-500">Admin</p>
        <h1 className="text-3xl font-semibold">Dashboard</h1>
      </header>

      <section className="grid gap-4 sm:grid-cols-3">
        <article className="rounded border p-4">
          <p className="text-sm text-zinc-500">Users</p>
          <p className="mt-2 text-2xl font-semibold">{stats.users}</p>
        </article>
        <article className="rounded border p-4">
          <p className="text-sm text-zinc-500">Posts</p>
          <p className="mt-2 text-2xl font-semibold">{stats.posts}</p>
        </article>
        <article className="rounded border p-4">
          <p className="text-sm text-zinc-500">Comments</p>
          <p className="mt-2 text-2xl font-semibold">{stats.comments}</p>
        </article>
      </section>
    </main>
  )
}
`,
        },
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
    // The API-only refusal lives inside makeAuth() rather than here, unlike the
    // admin blueprint's: `guren make:auth` reaches the same scaffold without
    // passing through this registry, so a guard placed here would leave that
    // door open.
    run: async (options) => makeAuth({ force: Boolean(options.force), install: true }),
  },
  oauth: {
    description: 'Install OAuth scaffolding with GitHub, Google, and Discord provider presets.',
    // No API-only guard, on purpose: this is the one entry that touches
    // routes/web.ts without needing it. The controller answers with
    // `this.json(...)`, and `wireRouteRegistrar` warns instead of throwing when
    // the file is absent — the scaffold genuinely works on an API-only app.
    run: async (options) => {
      const writerOptions: WriterOptions = { force: Boolean(options.force) }
      const created = await scaffoldFeatureFiles([
        {
          path: 'app/Providers/OAuthProvider.ts',
          contents: `import { ServiceProvider, type OAuthManager, createGitHubOAuthProviderConfig, createGoogleOAuthProviderConfig, createDiscordOAuthProviderConfig } from '@guren/core'

export default class OAuthProvider extends ServiceProvider {
  register(): void {
    const oauth = this.container.make<OAuthManager>('oauth')

    const githubClientId = process.env.OAUTH_GITHUB_CLIENT_ID
    const githubClientSecret = process.env.OAUTH_GITHUB_CLIENT_SECRET
    const githubRedirectUri = process.env.OAUTH_GITHUB_REDIRECT_URI
    if (githubClientId && githubClientSecret && githubRedirectUri) {
      oauth.registerProvider('github', createGitHubOAuthProviderConfig({
        clientId: githubClientId,
        clientSecret: githubClientSecret,
        redirectUri: githubRedirectUri,
      }))
    }

    const googleClientId = process.env.OAUTH_GOOGLE_CLIENT_ID
    const googleClientSecret = process.env.OAUTH_GOOGLE_CLIENT_SECRET
    const googleRedirectUri = process.env.OAUTH_GOOGLE_REDIRECT_URI
    if (googleClientId && googleClientSecret && googleRedirectUri) {
      oauth.registerProvider('google', createGoogleOAuthProviderConfig({
        clientId: googleClientId,
        clientSecret: googleClientSecret,
        redirectUri: googleRedirectUri,
      }))
    }

    const discordClientId = process.env.OAUTH_DISCORD_CLIENT_ID
    const discordClientSecret = process.env.OAUTH_DISCORD_CLIENT_SECRET
    const discordRedirectUri = process.env.OAUTH_DISCORD_REDIRECT_URI
    if (discordClientId && discordClientSecret && discordRedirectUri) {
      oauth.registerProvider('discord', createDiscordOAuthProviderConfig({
        clientId: discordClientId,
        clientSecret: discordClientSecret,
        redirectUri: discordRedirectUri,
      }))
    }
  }
}
`,
        },
        {
          path: 'app/Http/Controllers/Auth/OAuthController.ts',
          contents: `import { Controller, type OAuthManager } from '@guren/core'

type SupportedProvider = 'github' | 'google' | 'discord'

const SUPPORTED_PROVIDERS = new Set<SupportedProvider>(['github', 'google', 'discord'])

export default class OAuthController extends Controller {
  private oauth(): OAuthManager {
    return this.make<OAuthManager>('oauth')
  }

  // Note: not named \`redirect\` — that would shadow the base
  // Controller.redirect() helper used below.
  async redirectToProvider(): Promise<Response> {
    const provider = this.validateProvider(this.request.param('provider'))

    // Passing the session ties \`state\` to this browser: the manager keeps a
    // binding in it that the callback must present back. Without it an
    // attacker could authorize their own account, keep the \`code\` unconsumed,
    // and walk a visitor through the callback — logging that visitor into the
    // attacker's account.
    // \`?redirectTo=\` is user input — the manager only keeps app-relative
    // paths (or hosts allowlisted via stateConfig.allowedRedirectHosts).
    const { url } = await this.oauth().authorize(provider, {
      redirectTo: this.request.query('redirectTo'),
      session: this.auth.session(),
    })
    return this.redirect(url)
  }

  async callback(): Promise<Response> {
    const provider = this.validateProvider(this.request.param('provider'))
    const code = this.request.query('code')
    const state = this.request.query('state')

    if (!code || !state) {
      return this.json({ error: 'Missing OAuth callback parameters.' }, { status: 400 })
    }

    // Replace this with your own account linking: look the user up by
    // profile.email, create one when missing, then \`await this.auth.login(user)\`
    // and finish with \`return this.redirect(redirectTo ?? '/')\` —
    // \`redirectTo\` is already sanitized against open redirects. Refuse to
    // create an account when \`profile.emailVerified === false\`: the provider
    // is saying it never checked that the address belongs to this user.
    const { profile, redirectTo } = await this.oauth().handleCallback(provider, {
      code,
      state,
      session: this.auth.session(),
    })
    return this.json({ provider, profile, redirectTo }, { status: 200 })
  }

  private validateProvider(value: string | undefined): SupportedProvider {
    if (value && SUPPORTED_PROVIDERS.has(value as SupportedProvider)) {
      return value as SupportedProvider
    }
    throw new Error(\`Unsupported OAuth provider: \${value ?? '(missing)'}\`)
  }
}
`,
        },
        {
          path: 'routes/oauth.ts',
          contents: `import { Router } from '@guren/core'
import OAuthController from '../app/Http/Controllers/Auth/OAuthController.js'

export function registerOAuthRoutes(router: Router): void {
  router.get('/auth/:provider', [OAuthController, 'redirectToProvider']).name('oauth.redirect')
  router.get('/auth/:provider/callback', [OAuthController, 'callback']).name('oauth.callback')
}

export default registerOAuthRoutes
`,
        },
      ], writerOptions)

      await installProvider(
        "import { OAuthServiceProvider as CoreOAuthServiceProvider } from '@guren/core'",
        'CoreOAuthServiceProvider',
      )
      await installProvider(
        "import OAuthProvider from '../app/Providers/OAuthProvider.js'",
        'OAuthProvider',
      )

      await wireRouteRegistrar('registerOAuthRoutes', "import registerOAuthRoutes from './oauth.js'")

      return created
    },
  },
  cache: {
    description: 'Install the default cache provider and an example cache service.',
    run: async (options) => {
      const writerOptions: WriterOptions = { force: Boolean(options.force) }
      const created = await scaffoldFeatureFiles([
        {
          path: 'app/Providers/CacheProvider.ts',
          contents: `import { ServiceProvider, createCacheManager } from '@guren/core'

export default class CacheProvider extends ServiceProvider {
  register(): void {
    this.container.singleton('cache', () => createCacheManager({
      default: 'memory',
      stores: {
        memory: { driver: 'memory' },
      },
    }))
  }
}
`,
        },
        {
          path: 'app/Services/ApplicationCache.ts',
          contents: `import type { CacheManager } from '@guren/core'

export class ApplicationCache {
  constructor(private readonly cache: CacheManager) {}

  async rememberVersion(): Promise<string> {
    return this.cache.store().rememberForever('app:version', async () => 'vNext')
  }
}
`,
        },
      ], writerOptions)

      await installProvider(
        "import { CacheServiceProvider as CoreCacheServiceProvider } from '@guren/core'",
        'CoreCacheServiceProvider',
      )
      await installProvider(
        "import CacheProvider from '../app/Providers/CacheProvider.js'",
        'CacheProvider',
      )

      return created
    },
  },
  events: {
    description: 'Install event infrastructure with a sample event and listener.',
    run: async (options) => {
      const writerOptions: WriterOptions = { force: Boolean(options.force) }
      const eventPath = await makeEvent('OrderPlaced', writerOptions)
      const listenerPath = await makeListener('SendOrderReceipt', { ...writerOptions, event: 'OrderPlaced' })
      const created = await scaffoldFeatureFiles([
        {
          path: 'app/Providers/EventProvider.ts',
          contents: `import { ServiceProvider, type EventManager } from '@guren/core'
import { OrderPlaced } from '../Events/OrderPlaced.js'
import { SendOrderReceiptListener } from '../Listeners/SendOrderReceiptListener.js'

export default class EventProvider extends ServiceProvider {
  register(): void {}

  boot(): void {
    const events = this.container.make<EventManager>('events')
    const listener = new SendOrderReceiptListener()

    events.on(OrderPlaced, (event) => listener.handle(event), {
      priority: SendOrderReceiptListener.priority,
    })
  }
}
`,
        },
      ], writerOptions)

      await installProvider(
        "import { EventServiceProvider as CoreEventServiceProvider } from '@guren/core'",
        'CoreEventServiceProvider',
      )
      await installProvider(
        "import EventProvider from '../app/Providers/EventProvider.js'",
        'EventProvider',
      )

      return [eventPath, listenerPath, ...created]
    },
  },
  mail: {
    description: 'Install mail infrastructure with a memory transport and sample mailable.',
    run: async (options) => {
      const writerOptions: WriterOptions = { force: Boolean(options.force) }
      const mailPath = await makeMail('WelcomeEmail', writerOptions)
      const created = await scaffoldFeatureFiles([
        {
          path: 'app/Providers/MailProvider.ts',
          contents: `import { ServiceProvider, createMailManager, setMailManager, type MailManager } from '@guren/core'

export default class MailProvider extends ServiceProvider {
  register(): void {
    const manager = createMailManager({
      // MAIL_MAILER=log writes messages to the server output (default);
      // 'memory' keeps them inspectable in tests.
      default: process.env.MAIL_MAILER === 'memory' ? 'memory' : 'log',
      from: { email: 'noreply@example.com', name: 'Guren App' },
      transports: {
        log: { driver: 'log' },
        memory: { driver: 'memory' },
      },
    })

    this.container.instance('mail', manager)
  }

  boot(): void {
    const manager = this.container.make<MailManager>('mail')
    setMailManager(manager)
  }
}
`,
        },
      ], writerOptions)

      await installProvider(
        "import { MailServiceProvider as CoreMailServiceProvider } from '@guren/core'",
        'CoreMailServiceProvider',
      )
      await installProvider(
        "import MailProvider from '../app/Providers/MailProvider.js'",
        'MailProvider',
      )

      return [mailPath, ...created]
    },
  },
  queue: {
    description: 'Install queue infrastructure with a memory driver and sample job.',
    run: async (options) => {
      const writerOptions: WriterOptions = { force: Boolean(options.force) }
      const jobPath = await makeJob('ProcessWelcomeSequence', writerOptions)
      const created = await scaffoldFeatureFiles([
        {
          path: 'app/Providers/QueueProvider.ts',
          contents: `import { ServiceProvider, MemoryDriver, SyncDriver, createQueueManager, registerJob, type QueueManager } from '@guren/core'
import { ProcessWelcomeSequenceJob } from '../Jobs/ProcessWelcomeSequenceJob.js'

export default class QueueProvider extends ServiceProvider {
  register(): void {
    const queue = createQueueManager({
      // QUEUE_CONNECTION=sync executes jobs inline on dispatch (default,
      // no worker process needed); 'memory' queues them for a Worker.
      default: process.env.QUEUE_CONNECTION === 'memory' ? 'memory' : 'sync',
      drivers: {
        sync: () => new SyncDriver(),
        memory: () => new MemoryDriver(),
      },
    })

    this.container.instance('queue', queue)
  }

  boot(): void {
    // Register job classes before the driver so sync dispatches can resolve them.
    registerJob(ProcessWelcomeSequenceJob)
    const queue = this.container.make<QueueManager>('queue')
    queue.driver()
  }
}
`,
        },
      ], writerOptions)

      await installProvider(
        "import { QueueServiceProvider as CoreQueueServiceProvider } from '@guren/core'",
        'CoreQueueServiceProvider',
      )
      await installProvider(
        "import QueueProvider from '../app/Providers/QueueProvider.js'",
        'QueueProvider',
      )

      return [jobPath, ...created]
    },
  },
  notifications: {
    description: 'Install notification infrastructure with mail/database channels and a sample notification.',
    run: async (options) => {
      const writerOptions: WriterOptions = { force: Boolean(options.force) }
      const notificationPath = await makeNotification('WelcomeUser', writerOptions)
      const created = await scaffoldFeatureFiles([
        {
          path: 'app/Providers/NotificationProvider.ts',
          contents: `import { ServiceProvider, DatabaseChannel, MailChannel, type NotificationManager } from '@guren/core'
import type { MailManager } from '@guren/core'

export default class NotificationProvider extends ServiceProvider {
  register(): void {}

  boot(): void {
    const notifications = this.container.make<NotificationManager>('notifications')
    const mail = this.container.make<MailManager>('mail')

    notifications.registerChannel('mail', new MailChannel(mail))
    notifications.registerChannel('database', new DatabaseChannel())
  }
}
`,
        },
      ], writerOptions)

      await installProvider(
        "import { NotificationServiceProvider as CoreNotificationServiceProvider } from '@guren/core'",
        'CoreNotificationServiceProvider',
      )
      await installProvider(
        "import NotificationProvider from '../app/Providers/NotificationProvider.js'",
        'NotificationProvider',
      )

      return [notificationPath, ...created]
    },
  },
  storage: {
    description: 'Install storage infrastructure with local/public disks and a sample storage service.',
    run: async (options) => {
      const writerOptions: WriterOptions = { force: Boolean(options.force) }
      const created = await scaffoldFeatureFiles([
        {
          path: 'app/Providers/StorageProvider.ts',
          contents: `import { ServiceProvider, createStorageManager } from '@guren/core'

export default class StorageProvider extends ServiceProvider {
  register(): void {
    this.container.instance('storage', createStorageManager({
      default: 'local',
      disks: {
        local: { driver: 'local', root: './storage/app' },
        public: { driver: 'local', root: './storage/app/public' },
      },
    }))
  }
}
`,
        },
        {
          path: 'app/Services/FileStorage.ts',
          contents: `import type { StorageManager } from '@guren/core'

export class FileStorage {
  constructor(private readonly storage: StorageManager) {}

  async writeHealthcheck(): Promise<void> {
    await this.storage.disk('public').put('health.txt', 'ok')
  }
}
`,
        },
      ], writerOptions)

      await installProvider(
        "import { StorageServiceProvider as CoreStorageServiceProvider } from '@guren/core'",
        'CoreStorageServiceProvider',
      )
      await installProvider(
        "import StorageProvider from '../app/Providers/StorageProvider.js'",
        'StorageProvider',
      )

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
      const created = await scaffoldFeatureFiles([
        {
          path: 'app/Providers/BroadcastProvider.ts',
          contents: `import { ServiceProvider, createBroadcastManager, MemoryBroadcastDriver, type BroadcastManager } from '@guren/core'
import OrdersChannel from '../Broadcasting/OrdersChannel.js'
import UserFeedChannel from '../Broadcasting/UserFeedChannel.js'

export default class BroadcastProvider extends ServiceProvider {
  register(): void {
    this.container.instance('broadcast', createBroadcastManager({
      default: 'memory',
      drivers: {
        memory: () => new MemoryBroadcastDriver(),
      },
    }))
  }

  boot(): void {
    const broadcast = this.container.make<BroadcastManager>('broadcast')
    const orders = new OrdersChannel(broadcast)
    const userFeed = new UserFeedChannel(broadcast)

    // A public channel is open by definition. A private one is not: register
    // the channel's own authorize() so the check in UserFeedChannel is the
    // check that runs.
    broadcast.channel(orders.getChannelName(), () => true)
    broadcast.privateChannel(userFeed.getBaseName(), (channelName, user) => userFeed.authorize(channelName, user))
  }
}
`,
        },
      ], writerOptions)

      await installProvider(
        "import { BroadcastServiceProvider as CoreBroadcastServiceProvider } from '@guren/core'",
        'CoreBroadcastServiceProvider',
      )
      await installProvider(
        "import BroadcastProvider from '../app/Providers/BroadcastProvider.js'",
        'BroadcastProvider',
      )

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

      // Last of the checks, and still before the first write: everything above
      // is pure, so a usage error is reported as one rather than being masked
      // by the app's shape. The page components and the Inertia-returning
      // controller are unusable on an API-only app, and `updateResourceSchema`
      // runs before the route wiring can fail — so reaching that failure
      // appends a table to the app's own `db/schema.ts` as well.
      await assertNotApiOnly(process.cwd(), {
        does: 'guren add resource scaffolds Inertia pages and a controller that returns Inertia responses',
        instead: API_ONLY_FEATURE_ALTERNATIVE,
      })

      // Second, so that an app the check above recognizes hears about its
      // shape rather than about a missing file. What remains here is the app
      // that shape check deliberately permits: one that declares the client,
      // or that has no manifest to read, and still cannot be patched.
      await assertResourceTargetsPatchable(routeName)

      const created = await makeFeature(singular, {
        force: Boolean(options.force),
        fields: options.fields,
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
      const created = await scaffoldFeatureFiles([
        {
          path: 'app/Console/Kernel.ts',
          contents: `import { Schedule } from '@guren/core'

export function scheduleTasksKernel(): Schedule {
  const schedule = new Schedule()

  schedule
    .call(async () => {
      console.log('[Schedule] Running heartbeat task')
    })
    .hourly()
    .name('app-heartbeat')

  return schedule
}

export default scheduleTasksKernel
`,
        },
      ], writerOptions)

      await installProvider(
        "import { SchedulingServiceProvider as CoreSchedulingServiceProvider } from '@guren/core'",
        'CoreSchedulingServiceProvider',
      )

      return created
    },
  },
}

interface ColumnCode {
  code: string
  imports: string[]
}

/**
 * Per-dialect column builders, keyed by field type.
 *
 * The `Record<FieldType, …>` is load-bearing: these used to be switches with a
 * `default:` arm, which is how sqlite shipped without a `date` case and quietly
 * emitted a text column for it. A missing key now fails to compile.
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
  // `timestamptz`, not `timestamp`. A `date` field holds an instant: drizzle
  // writes `Date.toISOString()`, so `timestamp without time zone` keeps the UTC
  // wall clock but drops the offset, and what that wall clock means is then up
  // to the reader. Drizzle parses it back as UTC, so the app stays
  // self-consistent — but a raw `postgres` query, psql, or any other client
  // reads it as local time and sees a different instant. `timestamptz` stores
  // the instant itself, so every reader agrees.
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
 * derives the *table* name in the same emitted statement.
 *
 * A field name is a validated JavaScript identifier taken verbatim from the
 * user, and its underscore runs carry meaning: `__dunder__` must stay
 * `__dunder__`. `tableNameFor()` goes through `kebabCase()`, which collapses
 * `[_\s]+` to one separator — fine for a name that has to round-trip through a
 * slug, wrong for one that has to survive intact. Unifying the two would trade
 * a column the user asked for against a coupling nobody wants.
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
    content = ensureDrizzleImports(content, imports)

    const fieldLines = fields.map((field, index) => `  ${field.name}: ${columns[index].code},`).join('\n')
    const schemaBlock = `\nexport const ${schemaIdentifier} = pgTable('${tableName}', {\n  id: serial('id').primaryKey(),\n${fieldLines}\n  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),\n})\n`

    content = `${content.trimEnd()}\n${schemaBlock}`
  }

  await writeFile(schemaPath, content, 'utf8')
}

/**
 * Whether an app's routes file already registers the resource's own routes.
 *
 * Both probes are anchored on the full literal the registration emits. Matching
 * `/${routeName}'` unanchored made an unrelated `/admin/posts` read as "the
 * posts routes are already registered", so the run reported success while
 * registering nothing.
 */
function routesAlreadyRegister(content: string, routeName: string): boolean {
  return content.includes(`'${routeName}.index'`) || content.includes(`'/${routeName}'`)
}

function missingRegistrarMessage(routeName: string): string {
  return `Could not find a route registrar in ${DEFAULT_ROUTES_FILE}. Register the /${routeName} routes manually.`
}

/**
 * Every reason the two app-owned files this blueprint patches cannot be
 * patched, established before `makeFeature` writes its first file.
 *
 * The blueprint's own output can be deleted; the table appended to the app's
 * `db/schema.ts` cannot be undone by deleting anything, and that patch runs
 * first. Reordering the two patches only chooses which of the app's files is
 * left half-edited for a resource that was never finished — so neither may
 * start until both are known to be reachable.
 *
 * Runs after {@link assertNotApiOnly}, and covers what that check is documented
 * to leave behind: an app declaring `@guren/inertia-client`, or one with no
 * manifest to read, whose `routes/web.ts` is absent or unpatchable anyway. Both
 * are permitted there on purpose — a shape check has to answer "cannot tell"
 * with "proceed" — and both used to arrive here as a raw `ENOENT` seven
 * `node:fs` frames deep, after the schema patch.
 *
 * Scoped to the two questions the patches themselves answer: is each file
 * there, and does the routes file expose something to patch. It is not a
 * promise that the patches will succeed — a target that exists but cannot be
 * read or written still fails in the writer, as it did before.
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

  // Mirrors `updateResourceRoutes` — and must keep mirroring it. Waiving the
  // registrar requirement is only safe because the writer applies this same
  // predicate to the same content: nothing between here and there writes to
  // this file, so whenever the preflight skips this check the writer skips the
  // insert that would have needed one, and its own throw cannot fire.
  // Tightening either site alone reintroduces the half-edited app this function
  // exists to prevent.
  if (!routesAlreadyRegister(routes, routeName) && !findRouteRegistrar(routes)) {
    throw new Error(missingRegistrarMessage(routeName))
  }
}

async function updateResourceRoutes(singular: string, routeName: string, routeVar: string): Promise<void> {
  const routesPath = resolve(process.cwd(), DEFAULT_ROUTES_FILE)
  let content = await readFile(routesPath, 'utf8')

  if (!routesAlreadyRegister(content, routeName)) {
    const registrar = findRouteRegistrar(content)

    // Unreachable via `runBlueprint`, which settles this in the preflight
    // before anything is written — but it is also how the `null` is handled:
    // the insertion below dereferences `registrar`, so dropping this buys
    // nothing but a non-null assertion.
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

    // Insert before the closing brace of the route registrar function.
    const groupBlock = `\n${group.map((line) => `  ${line}`).join('\n')}\n`
    content = content.slice(0, registrar.bodyEnd) + groupBlock + content.slice(registrar.bodyEnd)

    // Inside the guard: these identifiers are only used by the group above,
    // so a skipped registration must skip them too — appended unconditionally
    // they are unused bindings, and the app stops compiling under
    // noUnusedLocals.
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
