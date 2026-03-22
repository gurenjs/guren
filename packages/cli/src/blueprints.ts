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
import { addImport, addProvider } from './patch-helpers'
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
  auth: {
    description: 'Install the default authentication stack for the current app.',
    run: async (options) => makeAuth({ force: Boolean(options.force), install: true }),
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
import OrderPlaced from '../Events/OrderPlaced.js'
import SendOrderReceiptListener from '../Listeners/SendOrderReceiptListener.js'

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
import ProcessWelcomeSequenceJob from '../Jobs/ProcessWelcomeSequenceJob.js'

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
import { appPages } from '../../../resources/js/pages/contracts.js'

type ${collection}IndexProps = PaginatedPageProps<${singular}ResourceData>
type ${singular}FormErrors = ValidationErrors<'title' | 'body'>

export default class ${singular}Controller extends Controller {
  async index(): Promise<Response> {
    const { page } = this.validateQuery(List${collection}QuerySchema)
    const result = await ${singular}.paginate({ page, perPage: 10, orderBy: ['id', 'desc'] })
    const paginator = paginate(result, { path: this.request.path ?? '/${routeName}' })

    return this.inertia(appPages.${routeName}.index, {
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

    return this.inertia(appPages.${routeName}.show, {
      ${variableName}: new ${singular}Resource(${variableName}).toJSON(),
    }, { url: this.request.path, title: '${singular}' })
  }

  async create(): Promise<Response> {
    return this.inertia(appPages.${routeName}.create, {}, { url: this.request.path, title: 'New ${singular}' })
  }

  async store(): Promise<Response> {
    const data = await this.validateBody(${singular}PayloadSchema)
    const ${variableName} = await ${singular}.create(data)
    return this.redirect('/${routeName}/' + ${variableName}?.id)
  }

  async edit(): Promise<Response> {
    const { id } = this.validateParams(${singular}IdParamSchema)
    const ${variableName} = await ${singular}.findOrFail(id)
    return this.inertia(appPages.${routeName}.edit, {
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
import type { PageProps } from '@guren/inertia-client/contracts'
import { appPages } from '../contracts.js'

type Props = PageProps<typeof appPages.${routeName}.index>

export default function ${collection}Index({ data, pagination }: Props) {
  return (
    <main className="mx-auto max-w-3xl space-y-6 px-6 py-12">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-semibold">${collection}</h1>
        <Link href="/${routeName}/new" className="rounded bg-black px-4 py-2 text-white">New ${singular}</Link>
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
import type { PageProps } from '@guren/inertia-client/contracts'
import { appPages } from '../contracts.js'

type Props = PageProps<typeof appPages.${routeName}.show>

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
import type { PageProps } from '@guren/inertia-client/contracts'
import { appPages } from '../contracts.js'

type Props = PageProps<typeof appPages.${routeName}.create>

export default function New${singular}(_: Props) {
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
import type { PageProps } from '@guren/inertia-client/contracts'
import { appPages } from '../contracts.js'

type Props = PageProps<typeof appPages.${routeName}.edit>

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

async function updateResourceSchema(collection: string, routeName: string): Promise<void> {
  const schemaPath = resolve(process.cwd(), 'db/schema.ts')
  let content = await readFile(schemaPath, 'utf8')
  const schemaIdentifier = camelCase(collection)
  const tableName = routeName.replaceAll('-', '_')

  if (content.includes(`export const ${schemaIdentifier} = pgTable(`)) {
    return
  }

  const schemaBlock = `\nexport const ${schemaIdentifier} = pgTable('${tableName}', {\n  id: serial('id').primaryKey(),\n  title: text('title').notNull(),\n  body: text('body'),\n  createdAt: timestamp('created_at', { withTimezone: false }).defaultNow().notNull(),\n})\n`

  content = `${content.trimEnd()}\n${schemaBlock}`
  await writeFile(schemaPath, content, 'utf8')
}

async function updateResourceContracts(
  singular: string,
  collection: string,
  routeName: string,
  routeVar: string,
  variableName: string,
): Promise<void> {
  const contractsPath = resolve(process.cwd(), 'resources/js/pages/contracts.ts')
  let content = await readFile(contractsPath, 'utf8')
  const routeKey = routeName.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase())
  const coreTypes = new Set(['PaginatedPageProps'])
  const coreImportMatches = content.matchAll(/^import type \{([^}]*)\} from '@guren\/core'$/gmu)

  for (const [, imported] of coreImportMatches) {
    for (const item of imported.split(',').map(part => part.trim()).filter(Boolean)) {
      coreTypes.add(item)
    }
  }

  content = content.replace(/^import type \{[^}]*\} from '@guren\/core'\n+/gmu, '')

  const requiredImports = [
    `import type { ${Array.from(coreTypes).sort().join(', ')} } from '@guren/core'`,
    `import type { ${singular}ResourceData } from '../../../app/Http/Resources/${singular}Resource.js'`,
  ]

  const missingImports = requiredImports.filter(importStatement => !content.includes(importStatement))
  if (missingImports.length > 0) {
    const importBlockMatch = content.match(/^(?:import[^\n]*\n)+/u)
    if (importBlockMatch) {
      const updatedImportBlock = `${importBlockMatch[0]}${missingImports.join('\n')}\n`
      content = `${updatedImportBlock}${content.slice(importBlockMatch[0].length)}`
    } else {
      content = `${missingImports.join('\n')}\n\n${content}`
    }
  }

  if (!content.includes(`${routeKey}: {`)) {
    content = content.replace(
      '} as const\n',
      `  ${routeKey}: {\n    index: generatedPages['${routeVar}'].Index.props<PaginatedPageProps<${singular}ResourceData>>(),\n    show: generatedPages['${routeVar}'].Show.props<{ ${variableName}: ${singular}ResourceData }>(),\n    create: generatedPages['${routeVar}'].New.props<Record<string, never>>(),\n    edit: generatedPages['${routeVar}'].Edit.props<{ ${variableName}: ${singular}ResourceData; errors?: ValidationErrors<'title' | 'body'> }>(),\n  },\n} as const\n`,
    )
    await writeFile(contractsPath, content, 'utf8')
  }
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
    const groupBlock = `  router.group('/${routeName}', (${routeVar}) => {\n    ${routeVar}.get('/', [${controllerName}, 'index']).name('${routeName}.index')\n    ${routeVar}.get('/new', [${controllerName}, 'create']).name('${routeName}.create')\n    ${routeVar}.get('/:id', [${controllerName}, 'show']).name('${routeName}.show')\n    ${routeVar}.get('/:id/edit', [${controllerName}, 'edit']).name('${routeName}.edit')\n    ${routeVar}.post('/', [${controllerName}, 'store']).name('${routeName}.store')\n    ${routeVar}.put('/:id', [${controllerName}, 'update']).name('${routeName}.update')\n  })\n`
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
