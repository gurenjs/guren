import { makeAuth } from './make-auth'
import { makeChannel } from './make-channel'
import { makeController } from './make-controller'
import { makeEvent } from './make-event'
import { makeJob } from './make-job'
import { makeListener } from './make-listener'
import { makeMail } from './make-mail'
import { makeModel } from './make-model'
import { makeNotification } from './make-notification'
import { makeRoute } from './make-route'
import { makeView } from './make-view'
import { addImport, addProvider, ensureDrizzleImports, ensureSqliteImports } from './patch-helpers'
import { camelCase, kebabCase, pascalCase, writeFilesSafe, type WriterOptions } from './utils'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export interface RunBlueprintOptions extends WriterOptions {
  name?: string
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
import { pages } from '../../../../.guren/pages.gen.js'

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

  async redirect(): Promise<Response> {
    const provider = this.validateProvider(this.request.param('provider'))
    const { url } = await this.oauth().authorize(provider)
    return this.redirect(url)
  }

  async callback(): Promise<Response> {
    const provider = this.validateProvider(this.request.param('provider'))
    const code = this.request.query('code')
    const state = this.request.query('state')

    if (!code || !state) {
      return this.json({ error: 'Missing OAuth callback parameters.' }, { status: 400 })
    }

    const profile = await this.oauth().user(provider, { code, state })
    return this.json({ provider, profile }, { status: 200 })
  }

  private validateProvider(value: string): SupportedProvider {
    if (SUPPORTED_PROVIDERS.has(value as SupportedProvider)) {
      return value as SupportedProvider
    }
    throw new Error(\`Unsupported OAuth provider: \${value}\`)
  }
}
`,
        },
        {
          path: 'routes/oauth.ts',
          contents: `import { Router } from '@guren/core'
import OAuthController from '../app/Http/Controllers/Auth/OAuthController.js'

export function registerOAuthRoutes(router: Router): void {
  router.get('/auth/:provider', [OAuthController, 'redirect']).name('oauth.redirect')
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
      default: 'memory',
      from: { email: 'noreply@example.com', name: 'Guren App' },
      transports: {
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
          contents: `import { ServiceProvider, MemoryDriver, createQueueManager, registerJob, type QueueManager } from '@guren/core'
import { ProcessWelcomeSequenceJob } from '../Jobs/ProcessWelcomeSequenceJob.js'

export default class QueueProvider extends ServiceProvider {
  register(): void {
    const queue = createQueueManager({
      default: 'memory',
      drivers: {
        memory: () => new MemoryDriver(),
      },
    })

    this.container.instance('queue', queue)
  }

  boot(): void {
    const queue = this.container.make<QueueManager>('queue')
    queue.driver()
    registerJob(ProcessWelcomeSequenceJob)
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
      const variableName = singular.charAt(0).toLowerCase() + singular.slice(1)
      const writerOptions: WriterOptions = { force: Boolean(options.force) }

      const created = await writeFilesSafe([
        {
          path: `app/Http/Validators/${singular}Validator.ts`,
          contents: `import { z } from 'zod'

export const ${singular}IdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
})

export const List${collection}QuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
})

export const ${singular}PayloadSchema = z.object({
  title: z.string().trim().min(1, 'Title is required.'),
  body: z.string().trim().min(1, 'Body is required.'),
})

export type ${singular}Payload = z.infer<typeof ${singular}PayloadSchema>
`,
        },
        {
          path: `app/Http/Resources/${singular}Resource.ts`,
          contents: `import { Resource } from '@guren/core'
import type { ${singular}Record } from '../../Models/${singular}.js'

export interface ${singular}ResourceData extends Record<string, unknown> {
  id: number
  title: string
  body: string | null
}

export class ${singular}Resource extends Resource<${singular}Record> {
  toArray(): ${singular}ResourceData {
    return {
      id: this.resource.id as number,
      title: this.resource.title as string,
      body: (this.resource.body as string | null) ?? null,
    }
  }

  override toJSON(): ${singular}ResourceData {
    return super.toJSON() as ${singular}ResourceData
  }
}
`,
        },
        {
          path: `app/Http/Controllers/${singular}Controller.ts`,
          contents: `import { Controller, paginate, type PaginatedPageProps, type ValidationErrors } from '@guren/core'
import { ${singular} } from '../../Models/${singular}.js'
import { ${singular}Resource, type ${singular}ResourceData } from '../Resources/${singular}Resource.js'
import { ${singular}IdParamSchema, ${singular}PayloadSchema, List${collection}QuerySchema } from '../Validators/${singular}Validator.js'
import { pages } from '../../../.guren/pages.gen.js'

type ${collection}IndexProps = PaginatedPageProps<${singular}ResourceData>
type ${singular}FormErrors = ValidationErrors<'title' | 'body'>

export default class ${singular}Controller extends Controller {
  async index(): Promise<Response> {
    const { page } = this.validateQuery(List${collection}QuerySchema)
    const result = await ${singular}.paginate({ page, perPage: 10, orderBy: ['id', 'desc'] })
    const paginator = paginate(result, { path: this.request.path ?? '/${routeName}' })

    return this.inertia(pages.${routeVar}.Index, {
      data: result.data.map((${variableName}) => new ${singular}Resource(${variableName}).toJSON()),
      pagination: {
        meta: paginator.meta(),
        links: paginator.links(),
      },
    } satisfies ${collection}IndexProps, { url: this.request.url ?? this.request.path, title: '${collection}' })
  }

  async show(): Promise<Response> {
    const { id } = this.validateParams(${singular}IdParamSchema)
    const ${variableName} = await ${singular}.findOrFail(id)

    return this.inertia(pages.${routeVar}.Show, {
      ${variableName}: new ${singular}Resource(${variableName}).toJSON(),
    }, { url: this.request.path, title: '${singular}' })
  }

  async create(): Promise<Response> {
    return this.inertia(pages.${routeVar}.New, {}, { url: this.request.path, title: 'New ${singular}' })
  }

  async store(): Promise<Response> {
    const data = await this.validateBody(${singular}PayloadSchema)
    const ${variableName} = await ${singular}.create(data)
    return this.redirect('/${routeName}/' + ${variableName}?.id)
  }

  async edit(): Promise<Response> {
    const { id } = this.validateParams(${singular}IdParamSchema)
    const ${variableName} = await ${singular}.findOrFail(id)
    return this.inertia(pages.${routeVar}.Edit, {
      ${variableName}: new ${singular}Resource(${variableName}).toJSON(),
      errors: {} as ${singular}FormErrors,
    }, { url: this.request.path, title: 'Edit ${singular}' })
  }

  async update(): Promise<Response> {
    const { id } = this.validateParams(${singular}IdParamSchema)
    const data = await this.validateBody(${singular}PayloadSchema)
    await ${singular}.update({ id }, data)
    return this.redirect('/${routeName}/' + id)
  }
}
`,
        },
        {
          path: `resources/js/pages/${routeName}/Index.tsx`,
          contents: `import { Link } from '@inertiajs/react'
import type { PaginatedPageProps } from '@guren/core'
import type { ${singular}ResourceData } from '../../../../app/Http/Resources/${singular}Resource.js'

interface Props extends PaginatedPageProps<${singular}ResourceData> {}

export default function ${collection}Index({ data, pagination }: Props) {
  return (
    <main className="mx-auto max-w-3xl space-y-6 px-6 py-12">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-semibold">${collection}</h1>
        <Link href="/${routeName}/create" className="rounded bg-black px-4 py-2 text-white">New ${singular}</Link>
      </div>
      <div className="space-y-4">
        {data.map((${variableName}) => (
          <article key={${variableName}.id} className="rounded border p-4">
            <Link href={'/${routeName}/' + ${variableName}.id} className="text-xl font-medium">${'${'}${variableName}.title}</Link>
            <p className="mt-2 text-sm text-zinc-600">${'${'}${variableName}.body ?? ''}</p>
          </article>
        ))}
      </div>
      <nav className="flex gap-2">
        {pagination.links.pages.map((page) => (
          <Link key={page.page} href={page.url ?? '#'} className="rounded border px-3 py-1">
            {page.page}
          </Link>
        ))}
      </nav>
    </main>
  )
}
`,
        },
        {
          path: `resources/js/pages/${routeName}/Show.tsx`,
          contents: `import { Link } from '@inertiajs/react'
import type { ${singular}ResourceData } from '../../../../app/Http/Resources/${singular}Resource.js'

interface Props {
  ${variableName}: ${singular}ResourceData
}

export default function ${singular}Show({ ${variableName} }: Props) {
  return (
    <main className="mx-auto max-w-3xl space-y-6 px-6 py-12">
      <Link href="/${routeName}">Back</Link>
      <h1 className="text-3xl font-semibold">{${variableName}.title}</h1>
      <p>{${variableName}.body ?? ''}</p>
      <Link href={'/${routeName}/' + ${variableName}.id + '/edit'}>Edit</Link>
    </main>
  )
}
`,
        },
        {
          path: `resources/js/pages/${routeName}/New.tsx`,
          contents: `import { useForm } from '@inertiajs/react'

export default function New${singular}() {
  const form = useForm({ title: '', body: '' })
  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); form.post('/${routeName}') }}>
        <input value={form.data.title} onChange={(event) => form.setData('title', event.target.value)} placeholder="Title" className="w-full rounded border px-3 py-2" />
        <textarea value={form.data.body} onChange={(event) => form.setData('body', event.target.value)} placeholder="Body" className="w-full rounded border px-3 py-2" />
        <button type="submit" className="rounded bg-black px-4 py-2 text-white">Create</button>
      </form>
    </main>
  )
}
`,
        },
        {
          path: `resources/js/pages/${routeName}/Edit.tsx`,
          contents: `import { useForm } from '@inertiajs/react'
import type { ${singular}ResourceData } from '../../../../app/Http/Resources/${singular}Resource.js'
import type { ValidationErrors } from '@guren/core'

interface Props {
  ${variableName}: ${singular}ResourceData
  errors?: ValidationErrors<'title' | 'body'>
}

export default function Edit${singular}({ ${variableName} }: Props) {
  const form = useForm({ title: ${variableName}.title, body: ${variableName}.body ?? '' })
  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); form.put('/${routeName}/' + ${variableName}.id) }}>
        <input value={form.data.title} onChange={(event) => form.setData('title', event.target.value)} className="w-full rounded border px-3 py-2" />
        <textarea value={form.data.body} onChange={(event) => form.setData('body', event.target.value)} className="w-full rounded border px-3 py-2" />
        <button type="submit" className="rounded bg-black px-4 py-2 text-white">Save</button>
      </form>
    </main>
  )
}
`,
        },
      ], writerOptions)

      await updateResourceSchema(collection, routeName)
      const modelPath = await makeModel(singular, writerOptions)
      await updateResourceContracts(singular, collection, routeName, routeVar, variableName)
      await updateResourceRoutes(singular, routeName, routeVar)

      return [...created, modelPath]
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

async function detectSchemaDialect(content: string): Promise<'sqlite' | 'pg'> {
  if (content.includes('sqliteTable') || content.includes('drizzle-orm/sqlite-core')) {
    return 'sqlite'
  }
  return 'pg'
}

async function updateResourceSchema(collection: string, routeName: string): Promise<void> {
  const schemaPath = resolve(process.cwd(), 'db/schema.ts')
  let content = await readFile(schemaPath, 'utf8')
  const schemaIdentifier = camelCase(collection)
  const tableName = routeName.replaceAll('-', '_')

  const dialect = await detectSchemaDialect(content)

  if (dialect === 'sqlite') {
    if (content.includes(`export const ${schemaIdentifier} = sqliteTable(`)) {
      return
    }

    content = ensureSqliteImports(content, ['sqliteTable', 'integer', 'text'])

    const schemaBlock = `\nexport const ${schemaIdentifier} = sqliteTable('${tableName}', {\n  id: integer('id').primaryKey({ autoIncrement: true }),\n  title: text('title').notNull(),\n  body: text('body'),\n  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),\n})\n`

    content = `${content.trimEnd()}\n${schemaBlock}`
  } else {
    if (content.includes(`export const ${schemaIdentifier} = pgTable(`)) {
      return
    }

    content = ensureDrizzleImports(content, ['pgTable', 'serial', 'text', 'timestamp'])

    const schemaBlock = `\nexport const ${schemaIdentifier} = pgTable('${tableName}', {\n  id: serial('id').primaryKey(),\n  title: text('title').notNull(),\n  body: text('body'),\n  createdAt: timestamp('created_at', { withTimezone: false }).defaultNow().notNull(),\n})\n`

    content = `${content.trimEnd()}\n${schemaBlock}`
  }

  await writeFile(schemaPath, content, 'utf8')
}

async function updateResourceContracts(
  _singular: string,
  _collection: string,
  _routeName: string,
  _routeVar: string,
  _variableName: string,
): Promise<void> {
}

async function updateResourceRoutes(singular: string, routeName: string, routeVar: string): Promise<void> {
  const controllerName = `${singular}Controller`
  const routesPath = resolve(process.cwd(), 'routes/web.ts')
  let content = await readFile(routesPath, 'utf8')
  const controllerImport = `import ${controllerName} from '../app/Http/Controllers/${controllerName}.js'`

  if (!content.includes(controllerImport)) {
    content = content.replace(
      /(import[^\n]+\n)(\n)?export function/u,
      `$1${controllerImport}\n\nexport function`,
    )
  }

  if (!content.includes(`'${routeName}.index'`) && !content.includes(`/${routeName}`)) {
    const groupBlock = `  router.group('/${routeName}', (${routeVar}) => {\n    ${routeVar}.get('/', [${controllerName}, 'index']).name('${routeName}.index')\n    ${routeVar}.get('/create', [${controllerName}, 'create']).name('${routeName}.create')\n    ${routeVar}.get('/:id', [${controllerName}, 'show']).name('${routeName}.show')\n    ${routeVar}.get('/:id/edit', [${controllerName}, 'edit']).name('${routeName}.edit')\n    ${routeVar}.post('/', [${controllerName}, 'store']).name('${routeName}.store')\n    ${routeVar}.put('/:id', [${controllerName}, 'update']).name('${routeName}.update')\n  })\n`
    content = content.replace(/\n\}\n(?:\n)?export default/u, `\n${groupBlock}}\n\nexport default`)
    await writeFile(routesPath, content, 'utf8')
  }
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
