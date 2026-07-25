import { makeAuth } from './make-auth'
import { makeChannel } from './make-channel'
import { makeFeature, parseFieldsString, type FieldDefinition } from './make-feature'
import { makeController } from './make-controller'
import { makeEvent } from './make-event'
import { makeJob } from './make-job'
import { makeListener } from './make-listener'
import { makeMail } from './make-mail'
import { makeModel } from './make-model'
import { makeNotification } from './make-notification'
import { makeRoute } from './make-route'
import { makeView } from './make-view'
import { addImport, addProvider, ensureDrizzleImports, ensureMysqlImports, ensureSqliteImports } from './patch-helpers'
import { camelCase, kebabCase, pascalCase, writeFilesSafe, type WriterOptions } from './utils'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export interface RunBlueprintOptions extends WriterOptions {
  name?: string
  /** Comma-separated field definitions for the resource blueprint, e.g. "title:string,body:text?". */
  fields?: string
  /** Skip authentication checks in mutating actions (resource blueprint). */
  publicAccess?: boolean
}

export interface BlueprintDefinition {
  description: string
  run: (options: RunBlueprintOptions) => Promise<string[]>
}

function pluralizeResourceName(name: string): string {
  if (/[^aeiou]y$/iu.test(name)) {
    return `${name.slice(0, -1)}ies`
  }

  if (/(s|x|z|ch|sh)$/iu.test(name)) {
    return `${name}es`
  }

  return `${name}s`
}

function singularizeResourceName(name: string): string {
  if (/ies$/iu.test(name)) {
    return `${name.slice(0, -3)}y`
  }

  if (/(ches|shes|sses|xes|zes)$/iu.test(name)) {
    return name.slice(0, -2)
  }

  if (/s$/iu.test(name) && !/ss$/iu.test(name)) {
    return name.slice(0, -1)
  }

  return name
}

async function installCoreProvider(importName: string, providerName: string): Promise<void> {
  await addImport('src/app.ts', importName)
  await addProvider('src/app.ts', providerName)
}

async function scaffoldFeatureFiles(
  files: Array<{ path: string; contents: string }>,
  options: WriterOptions,
): Promise<string[]> {
  return writeFilesSafe(files, options)
}

const blueprintRegistry: Record<string, BlueprintDefinition> = {
  admin: {
    description: 'Install a starter admin dashboard with dedicated routes and controller.',
    run: async (options) => {
      const writerOptions: WriterOptions = { force: Boolean(options.force) }
      const created = await scaffoldFeatureFiles([
        {
          path: 'app/Http/Controllers/Admin/AdminDashboardController.ts',
          contents: `import { Controller } from '@guren/core'
import { pages } from '@/.guren/pages.gen'

export default class AdminDashboardController extends Controller {
  async index(): Promise<Response> {
    return this.inertia(pages.admin.Dashboard, {
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
          contents: `import { Router } from '@guren/core'
import AdminDashboardController from '../app/Http/Controllers/Admin/AdminDashboardController.js'

export function registerAdminRoutes(router: Router): void {
  router.get('/admin', [AdminDashboardController, 'index']).name('admin.dashboard')
}

export default registerAdminRoutes
`,
        },
      ], writerOptions)

      try {
        const webRoutesPath = 'routes/web.ts'
        const absoluteWebRoutesPath = resolve(process.cwd(), webRoutesPath)
        const adminImport = "import registerAdminRoutes from './admin.js'"
        await addImport(webRoutesPath, adminImport)

        let routesContent = await readFile(absoluteWebRoutesPath, 'utf8')
        if (!routesContent.includes('registerAdminRoutes(router)')) {
          const registrarPattern = /(export function [^(]+\(\s*router\s*:\s*Router\s*\)\s*(?::\s*[^{]+)?\{\n)/u
          if (registrarPattern.test(routesContent)) {
            routesContent = routesContent.replace(registrarPattern, `$1  registerAdminRoutes(router)\n`)
            await writeFile(absoluteWebRoutesPath, routesContent, 'utf8')
          }
        }
      } catch {
        // skip route auto-wiring when routes/web.ts doesn't exist yet
      }

      return created
    },
  },
  auth: {
    description: 'Install the default authentication stack for the current app.',
    run: async (options) => makeAuth({ force: Boolean(options.force), install: true }),
  },
  oauth: {
    description: 'Install OAuth scaffolding with GitHub, Google, and Discord provider presets.',
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
    // \`?redirectTo=\` is user input — the manager only keeps app-relative
    // paths (or hosts allowlisted via stateConfig.allowedRedirectHosts).
    const { url } = await this.oauth().authorize(provider, {
      redirectTo: this.request.query('redirectTo'),
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
    const { profile, redirectTo } = await this.oauth().handleCallback(provider, { code, state })
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

      await installCoreProvider(
        "import { OAuthServiceProvider as CoreOAuthServiceProvider } from '@guren/core'",
        'CoreOAuthServiceProvider',
      )
      await addImport('src/app.ts', "import OAuthProvider from '../app/Providers/OAuthProvider.js'")
      await addProvider('src/app.ts', 'OAuthProvider')

      try {
        const webRoutesPath = 'routes/web.ts'
        const absoluteWebRoutesPath = resolve(process.cwd(), webRoutesPath)
        const oauthImport = "import registerOAuthRoutes from './oauth.js'"
        await addImport(webRoutesPath, oauthImport)

        let routesContent = await readFile(absoluteWebRoutesPath, 'utf8')
        if (!routesContent.includes('registerOAuthRoutes(router)')) {
          const registrarPattern = /(export function [^(]+\(\s*router\s*:\s*Router\s*\)\s*(?::\s*[^{]+)?\{\n)/u
          if (registrarPattern.test(routesContent)) {
            routesContent = routesContent.replace(registrarPattern, `$1  registerOAuthRoutes(router)\n`)
            await writeFile(absoluteWebRoutesPath, routesContent, 'utf8')
          }
        }
      } catch {
        // skip route auto-wiring when routes/web.ts doesn't exist yet
      }

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

      await installCoreProvider(
        "import { CacheServiceProvider as CoreCacheServiceProvider } from '@guren/core'",
        'CoreCacheServiceProvider',
      )
      await addImport('src/app.ts', "import CacheProvider from '../app/Providers/CacheProvider.js'")
      await addProvider('src/app.ts', 'CacheProvider')

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

      await installCoreProvider(
        "import { EventServiceProvider as CoreEventServiceProvider } from '@guren/core'",
        'CoreEventServiceProvider',
      )
      await addImport('src/app.ts', "import EventProvider from '../app/Providers/EventProvider.js'")
      await addProvider('src/app.ts', 'EventProvider')

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

      await installCoreProvider(
        "import { MailServiceProvider as CoreMailServiceProvider } from '@guren/core'",
        'CoreMailServiceProvider',
      )
      await addImport('src/app.ts', "import MailProvider from '../app/Providers/MailProvider.js'")
      await addProvider('src/app.ts', 'MailProvider')

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

      await installCoreProvider(
        "import { QueueServiceProvider as CoreQueueServiceProvider } from '@guren/core'",
        'CoreQueueServiceProvider',
      )
      await addImport('src/app.ts', "import QueueProvider from '../app/Providers/QueueProvider.js'")
      await addProvider('src/app.ts', 'QueueProvider')

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

      await installCoreProvider(
        "import { NotificationServiceProvider as CoreNotificationServiceProvider } from '@guren/core'",
        'CoreNotificationServiceProvider',
      )
      await addImport('src/app.ts', "import NotificationProvider from '../app/Providers/NotificationProvider.js'")
      await addProvider('src/app.ts', 'NotificationProvider')

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

      await installCoreProvider(
        "import { StorageServiceProvider as CoreStorageServiceProvider } from '@guren/core'",
        'CoreStorageServiceProvider',
      )
      await addImport('src/app.ts', "import StorageProvider from '../app/Providers/StorageProvider.js'")
      await addProvider('src/app.ts', 'StorageProvider')

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

    broadcast.channel(orders.getChannelName(), () => true)
    broadcast.privateChannel(userFeed.getBaseName(), () => true)
  }
}
`,
        },
      ], writerOptions)

      await installCoreProvider(
        "import { BroadcastServiceProvider as CoreBroadcastServiceProvider } from '@guren/core'",
        'CoreBroadcastServiceProvider',
      )
      await addImport('src/app.ts', "import BroadcastProvider from '../app/Providers/BroadcastProvider.js'")
      await addProvider('src/app.ts', 'BroadcastProvider')

      return [publicChannelPath, privateChannelPath, ...created]
    },
  },
  resource: {
    description: 'Scaffold a model, controller, route group, and page entry for a resource.',
    run: async (options) => {
      if (!options.name?.trim()) {
        throw new Error('The resource blueprint requires a resource name.')
      }

      const singular = singularizeResourceName(pascalCase(options.name.trim()))
      const collection = pluralizeResourceName(singular)
      const routeName = kebabCase(collection)
      const routeVar = routeName.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase())
      const fields = parseFieldsString(options.fields ?? '')

      const created = await makeFeature(singular, {
        force: Boolean(options.force),
        fields: options.fields,
        publicAccess: options.publicAccess,
        announce: false,
      })

      await updateResourceSchema(collection, routeName, fields)
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

      await installCoreProvider(
        "import { SchedulingServiceProvider as CoreSchedulingServiceProvider } from '@guren/core'",
        'CoreSchedulingServiceProvider',
      )

      return created
    },
  },
}

async function detectSchemaDialect(content: string): Promise<'sqlite' | 'pg' | 'mysql'> {
  if (content.includes('sqliteTable') || content.includes('drizzle-orm/sqlite-core')) {
    return 'sqlite'
  }
  if (content.includes('mysqlTable') || content.includes('drizzle-orm/mysql-core')) {
    return 'mysql'
  }
  return 'pg'
}

function sqliteColumn(field: FieldDefinition): { code: string; imports: string[] } {
  const notNull = field.nullable ? '' : '.notNull()'
  switch (field.type) {
    case 'number':
      return { code: `integer('${snakeCase(field.name)}')${notNull}`, imports: ['integer'] }
    case 'boolean':
      return { code: `integer('${snakeCase(field.name)}', { mode: 'boolean' })${notNull}`, imports: ['integer'] }
    case 'json':
      return { code: `text('${snakeCase(field.name)}', { mode: 'json' })${notNull}`, imports: ['text'] }
    default:
      return { code: `text('${snakeCase(field.name)}')${notNull}`, imports: ['text'] }
  }
}

function pgColumn(field: FieldDefinition): { code: string; imports: string[] } {
  const notNull = field.nullable ? '' : '.notNull()'
  switch (field.type) {
    case 'number':
      return { code: `integer('${snakeCase(field.name)}')${notNull}`, imports: ['integer'] }
    case 'boolean':
      return { code: `boolean('${snakeCase(field.name)}')${notNull}`, imports: ['boolean'] }
    case 'date':
      return { code: `timestamp('${snakeCase(field.name)}', { withTimezone: false })${notNull}`, imports: ['timestamp'] }
    case 'json':
      return { code: `jsonb('${snakeCase(field.name)}')${notNull}`, imports: ['jsonb'] }
    default:
      return { code: `text('${snakeCase(field.name)}')${notNull}`, imports: ['text'] }
  }
}

function mysqlColumn(field: FieldDefinition): { code: string; imports: string[] } {
  const notNull = field.nullable ? '' : '.notNull()'
  switch (field.type) {
    case 'number':
      return { code: `int('${snakeCase(field.name)}')${notNull}`, imports: ['int'] }
    case 'boolean':
      return { code: `boolean('${snakeCase(field.name)}')${notNull}`, imports: ['boolean'] }
    case 'date':
      return { code: `timestamp('${snakeCase(field.name)}')${notNull}`, imports: ['timestamp'] }
    case 'json':
      return { code: `json('${snakeCase(field.name)}')${notNull}`, imports: ['json'] }
    default:
      return { code: `varchar('${snakeCase(field.name)}', { length: 255 })${notNull}`, imports: ['varchar'] }
  }
}

function snakeCase(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
}

async function updateResourceSchema(collection: string, routeName: string, fields: FieldDefinition[]): Promise<void> {
  const schemaPath = resolve(process.cwd(), 'db/schema.ts')
  let content = await readFile(schemaPath, 'utf8')
  const schemaIdentifier = camelCase(collection)
  const tableName = routeName.replaceAll('-', '_')

  const dialect = await detectSchemaDialect(content)

  if (dialect === 'sqlite') {
    if (content.includes(`export const ${schemaIdentifier} = sqliteTable(`)) {
      return
    }

    const columns = fields.map((field) => sqliteColumn(field))
    const imports = [...new Set(['sqliteTable', 'integer', 'text', ...columns.flatMap((c) => c.imports)])]
    content = ensureSqliteImports(content, imports)

    const fieldLines = fields.map((field, index) => `  ${field.name}: ${columns[index].code},`).join('\n')
    const schemaBlock = `\nexport const ${schemaIdentifier} = sqliteTable('${tableName}', {\n  id: integer('id').primaryKey({ autoIncrement: true }),\n${fieldLines}\n  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),\n})\n`

    content = `${content.trimEnd()}\n${schemaBlock}`
  } else if (dialect === 'mysql') {
    if (content.includes(`export const ${schemaIdentifier} = mysqlTable(`)) {
      return
    }

    const columns = fields.map((field) => mysqlColumn(field))
    const imports = [...new Set(['mysqlTable', 'int', 'timestamp', ...columns.flatMap((c) => c.imports)])]
    content = ensureMysqlImports(content, imports)

    const fieldLines = fields.map((field, index) => `  ${field.name}: ${columns[index].code},`).join('\n')
    const schemaBlock = `\nexport const ${schemaIdentifier} = mysqlTable('${tableName}', {\n  id: int('id').primaryKey().autoincrement(),\n${fieldLines}\n  createdAt: timestamp('created_at').defaultNow().notNull(),\n})\n`

    content = `${content.trimEnd()}\n${schemaBlock}`
  } else {
    if (content.includes(`export const ${schemaIdentifier} = pgTable(`)) {
      return
    }

    const columns = fields.map((field) => pgColumn(field))
    const imports = [...new Set(['pgTable', 'serial', 'text', 'timestamp', ...columns.flatMap((c) => c.imports)])]
    content = ensureDrizzleImports(content, imports)

    const fieldLines = fields.map((field, index) => `  ${field.name}: ${columns[index].code},`).join('\n')
    const schemaBlock = `\nexport const ${schemaIdentifier} = pgTable('${tableName}', {\n  id: serial('id').primaryKey(),\n${fieldLines}\n  createdAt: timestamp('created_at', { withTimezone: false }).defaultNow().notNull(),\n})\n`

    content = `${content.trimEnd()}\n${schemaBlock}`
  }

  await writeFile(schemaPath, content, 'utf8')
}

async function updateResourceRoutes(singular: string, routeName: string, routeVar: string): Promise<void> {
  const controllerName = `${singular}Controller`
  const routesPath = resolve(process.cwd(), 'routes/web.ts')
  let content = await readFile(routesPath, 'utf8')
  const controllerImport = `import ${controllerName} from '../app/Http/Controllers/${controllerName}.js'`
  const validatorImport = `import { ${singular}PayloadSchema } from '../app/Http/Validators/${singular}Validator.js'`

  if (!content.includes(controllerImport)) {
    content = content.replace(
      /(import[^\n]+\n)(\n)?export function/u,
      `$1${controllerImport}\n\nexport function`,
    )
  }

  if (!content.includes(validatorImport)) {
    content = content.replace(
      /(import[^\n]+\n)(\n)?export function/u,
      `$1${validatorImport}\n\nexport function`,
    )
  }

  if (!content.includes(`'${routeName}.index'`) && !content.includes(`/${routeName}'`)) {
    const groupBlock = `\n  router.group('/${routeName}', (${routeVar}) => {\n    ${routeVar}.get('/', [${controllerName}, 'index']).name('${routeName}.index')\n    ${routeVar}.get('/create', [${controllerName}, 'create']).name('${routeName}.create')\n    ${routeVar}.get('/:id', [${controllerName}, 'show']).name('${routeName}.show')\n    ${routeVar}.get('/:id/edit', [${controllerName}, 'edit']).name('${routeName}.edit')\n    ${routeVar}.post('/', { name: '${routeName}.store', body: ${singular}PayloadSchema }, [${controllerName}, 'store'])\n    ${routeVar}.put('/:id', { name: '${routeName}.update', body: ${singular}PayloadSchema }, [${controllerName}, 'update'])\n    ${routeVar}.delete('/:id', { name: '${routeName}.destroy' }, [${controllerName}, 'destroy'])\n  })\n`

    // Insert before the closing brace of the route registrar function.
    const registrarMatch = content.match(/export function [^(]*\(\s*router\s*:\s*Router\s*\)[^{]*\{/u)
    let inserted = false
    if (registrarMatch && registrarMatch.index !== undefined) {
      const openIndex = registrarMatch.index + registrarMatch[0].length - 1
      let depth = 0
      let closeIndex = -1
      for (let i = openIndex; i < content.length; i++) {
        const char = content[i]
        if (char === '{') depth++
        else if (char === '}') {
          depth--
          if (depth === 0) {
            closeIndex = i
            break
          }
        }
      }
      if (closeIndex !== -1) {
        content = content.slice(0, closeIndex) + groupBlock + content.slice(closeIndex)
        inserted = true
      }
    }

    if (!inserted) {
      throw new Error(
        `Could not find a route registrar in routes/web.ts. Register the /${routeName} routes manually.`,
      )
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
  return getBlueprint(name).run(options)
}
