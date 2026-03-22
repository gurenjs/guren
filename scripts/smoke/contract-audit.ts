import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

async function read(root: string, relativePath: string): Promise<string> {
  return readFile(join(root, relativePath), 'utf8')
}

async function auditBlog(root: string): Promise<void> {
  const appBootstrap = await read(root, 'src/app.ts')
  assert(appBootstrap.includes('providers: ['), 'Blog app must declare providers through createApp().')
  assert(appBootstrap.includes('CacheProvider'), 'Blog app must register CacheProvider.')
  assert(appBootstrap.includes('EventServiceProvider'), 'Blog app must register EventServiceProvider.')
  assert(appBootstrap.includes('SchedulingProvider'), 'Blog app must register SchedulingProvider.')

  const loginController = await read(root, 'app/Http/Controllers/Auth/LoginController.ts')
  assert(loginController.includes('await this.validateBody('), 'Blog auth controller must use validateBody().')
  assert(!loginController.includes('.safeParse('), 'Blog auth controller must not use manual safeParse().')

  const profileController = await read(root, 'app/Http/Controllers/ProfileController.ts')
  assert(profileController.includes('await this.validateBody('), 'Blog profile controller must use validateBody().')
  assert(!profileController.includes('.safeParse('), 'Blog profile controller must not use manual safeParse().')

  const postController = await read(root, 'app/Http/Controllers/PostController.ts')
  assert(postController.includes('PaginatedPageProps<PostPageResource>'), 'Blog posts index must use PaginatedPageProps.')
  assert(postController.includes('const paginator = paginate(result,'), 'Blog posts index must use paginate(result, ...).')
  assert(postController.includes('new PostResource(post).toJSON()'), 'Blog post controller must send resource output to pages.')
  assert(postController.includes("this.make('events')"), 'Blog post controller must resolve events through the container.')
  assert(postController.includes("new PostCacheService(this.make('cache'))"), 'Blog post controller must construct cache services from the container.')
  assert(!postController.includes('.safeParse('), 'Blog post controller must not use manual safeParse().')

  const postResource = await read(root, 'app/Http/Resources/PostResource.ts')
  assert(postResource.includes('toArray(): PostResourceData'), 'Blog post resource must declare explicit toArray() output.')

  const postCacheService = await read(root, 'app/Services/PostCacheService.ts')
  assert(postCacheService.includes('constructor(private readonly cache: CacheManager)'), 'Blog post cache service must require CacheManager injection.')
  assert(!postCacheService.includes('getCacheManager'), 'Blog post cache service must not pull cache via helper singletons.')
  assert(!postCacheService.includes('getPostCacheService'), 'Blog post cache service must not expose a singleton getter.')

  const contracts = await read(root, 'resources/js/pages/contracts.ts')
  assert(contracts.includes("ValidationErrors<'email' | 'password'>"), 'Blog login contract must expose ValidationErrors.')
  assert(contracts.includes('PaginatedPageProps<PostPageResource>'), 'Blog posts contract must expose PaginatedPageProps.')
  assert(contracts.includes("errors?: ValidationErrors<keyof PostFormValues>"), 'Blog edit contract must expose ValidationErrors.')

  const eventProvider = await read(root, 'app/Providers/EventServiceProvider.ts')
  assert(eventProvider.includes("from '@guren/core'"), 'Blog event provider must use @guren/core imports.')
  assert(eventProvider.includes('createEventManager'), 'Blog event provider must create an event manager.')
  assert(eventProvider.includes('createMailManager'), 'Blog event provider must configure mail through the provider.')
  assert(eventProvider.includes('createQueueManager'), 'Blog event provider must configure queue through the provider.')
  assert(eventProvider.includes("this.container.singleton('events'"), 'Blog event provider must register events in the container.')
  assert(eventProvider.includes("this.container.singleton('mail'"), 'Blog event provider must register mail in the container.')
  assert(eventProvider.includes("this.container.singleton('queue'"), 'Blog event provider must register queue in the container.')

  const cacheProvider = await read(root, 'app/Providers/CacheProvider.ts')
  assert(cacheProvider.includes('createCacheManager'), 'Blog cache provider must create the cache manager.')
  assert(cacheProvider.includes("this.container.singleton('cache'"), 'Blog cache provider must register cache in the container.')

  const schedulingProvider = await read(root, 'app/Providers/SchedulingProvider.ts')
  assert(schedulingProvider.includes('createScheduler'), 'Blog scheduling provider must create a scheduler.')
  assert(schedulingProvider.includes("this.container.singleton('scheduler'"), 'Blog scheduling provider must register the scheduler in the container.')
}

async function auditApi(root: string): Promise<void> {
  const appBootstrap = await read(root, 'src/app.ts')
  assert(appBootstrap.includes('providers: ['), 'API app must declare providers through createApp().')
  assert(appBootstrap.includes('CacheProvider'), 'API app must register CacheProvider.')
  assert(appBootstrap.includes('EventServiceProvider'), 'API app must register EventServiceProvider.')
  assert(appBootstrap.includes('SchedulingProvider'), 'API app must register SchedulingProvider.')

  const authController = await read(root, 'app/Http/Controllers/AuthController.ts')
  assert(authController.includes('await this.validateBody(RegisterSchema)'), 'API auth controller must use validateBody() for register.')
  assert(authController.includes('await this.validateBody(LoginSchema)'), 'API auth controller must use validateBody() for login.')
  assert(authController.includes('new UserResource(user'), 'API auth controller must serialize users through UserResource.')
  assert(authController.includes("this.make('events')"), 'API auth controller must resolve events through the container.')
  assert(!authController.includes('.safeParse('), 'API auth controller must not use manual safeParse().')

  const taskController = await read(root, 'app/Http/Controllers/TaskController.ts')
  assert(taskController.includes('const paginatorInstance = paginate(result,'), 'API task index must use paginate(result, ...).')
  assert(taskController.includes('new TaskResource(task'), 'API task controller must serialize tasks through TaskResource.')
  assert(taskController.includes('await this.validateBody(CreateTaskSchema)'), 'API task create must use validateBody().')
  assert(taskController.includes('await this.validateBody(UpdateTaskSchema)'), 'API task update must use validateBody().')
  assert(taskController.includes("this.make('events')"), 'API task controller must resolve events through the container.')
  assert(taskController.includes("new TaskCacheService(this.make('cache'))"), 'API task controller must construct cache services from the container.')
  assert(!taskController.includes('.safeParse('), 'API task controller must not use manual safeParse().')

  const taskCacheService = await read(root, 'app/Services/TaskCacheService.ts')
  assert(taskCacheService.includes('constructor(private readonly cache: CacheManager)'), 'API task cache service must require CacheManager injection.')
  assert(!taskCacheService.includes('getCacheManager'), 'API task cache service must not pull cache via helper singletons.')
  assert(!taskCacheService.includes('getTaskCacheService'), 'API task cache service must not expose a singleton getter.')

  const eventProvider = await read(root, 'app/Providers/EventServiceProvider.ts')
  assert(eventProvider.includes("from '@guren/core'"), 'API event provider must use @guren/core imports.')
  assert(eventProvider.includes('createEventManager'), 'API event provider must create an event manager.')
  assert(eventProvider.includes('createMailManager'), 'API event provider must configure mail through the provider.')
  assert(eventProvider.includes('createQueueManager'), 'API event provider must configure queue through the provider.')
  assert(eventProvider.includes("this.container.singleton('events'"), 'API event provider must register events in the container.')
  assert(eventProvider.includes("this.container.singleton('mail'"), 'API event provider must register mail in the container.')
  assert(eventProvider.includes("this.container.singleton('queue'"), 'API event provider must register queue in the container.')

  const cacheProvider = await read(root, 'app/Providers/CacheProvider.ts')
  assert(cacheProvider.includes('createCacheManager'), 'API cache provider must create the cache manager.')
  assert(cacheProvider.includes("this.container.singleton('cache'"), 'API cache provider must register cache in the container.')

  const schedulingProvider = await read(root, 'app/Providers/SchedulingProvider.ts')
  assert(schedulingProvider.includes('createScheduler'), 'API scheduling provider must create a scheduler.')
  assert(schedulingProvider.includes("this.container.singleton('scheduler'"), 'API scheduling provider must register the scheduler in the container.')
}

async function auditWeb(root: string): Promise<void> {
  const appBootstrap = await read(root, 'src/app.ts')
  assert(appBootstrap.includes('providers: ['), 'Web app must declare providers through createApp().')
  assert(appBootstrap.includes('DatabaseProvider'), 'Web app must register DatabaseProvider.')

  const homeController = await read(root, 'app/Http/Controllers/HomeController.ts')
  assert(homeController.includes('webPages.home'), 'Web home controller must use page contracts.')
  assert(!homeController.includes("this.inertia('"), 'Web home controller must not use string page names.')

  const docsController = await read(root, 'app/Http/Controllers/DocsController.ts')
  assert(docsController.includes('webPages.docs.index'), 'Web docs controller must use page contracts for index pages.')
  assert(docsController.includes('webPages.docs.show'), 'Web docs controller must use page contracts for show pages.')
  assert(!docsController.includes("this.inertia('"), 'Web docs controller must not use string page names.')

  const contracts = await read(root, 'resources/js/pages/contracts.ts')
  assert(contracts.includes('generatedPages.Home.props'), 'Web contracts must be generated-page based.')
  assert(contracts.includes('generatedPages.Docs.Index.props'), 'Web docs index contract must be generated-page based.')
  assert(contracts.includes('generatedPages.Docs.Show.props'), 'Web docs show contract must be generated-page based.')
}

async function main(): Promise<void> {
  const root = resolve(process.argv[2] ?? '.')
  await auditBlog(join(root, 'examples/blog'))
  await auditApi(join(root, 'examples/api'))
  await auditWeb(join(root, 'web'))
  console.log(`Contract audit passed for ${root}`)
}

await main()
