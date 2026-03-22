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
  const eventProvider = await read(root, 'examples/blog/app/Providers/EventServiceProvider.ts')
  assert(eventProvider.includes('createEventManager'), 'Blog event provider must create an event manager.')
  assert(eventProvider.includes('createMailManager'), 'Blog event provider must create a mail manager.')
  assert(eventProvider.includes('createQueueManager'), 'Blog event provider must create a queue manager.')
  assert(eventProvider.includes('setMailManager(mailManager)'), 'Blog event provider must connect the mail manager to the mail facade.')
  assert(eventProvider.includes('registerJob(SendWelcomeEmailJob)'), 'Blog event provider must register the welcome email job.')
  assert(eventProvider.includes('registerJob(ProcessNewPostJob)'), 'Blog event provider must register the new post job.')
  assert(eventProvider.includes("this.container.singleton('events'"), 'Blog event provider must register the event manager in the container.')
  assert(eventProvider.includes("this.container.singleton('mail'"), 'Blog event provider must register the mail manager in the container.')
  assert(eventProvider.includes("this.container.singleton('queue'"), 'Blog event provider must register the queue manager in the container.')

  const cacheProvider = await read(root, 'examples/blog/app/Providers/CacheProvider.ts')
  assert(cacheProvider.includes('createCacheManager'), 'Blog cache provider must create a cache manager.')
  assert(cacheProvider.includes("this.container.singleton('cache'"), 'Blog cache provider must register cache in the container.')

  const notificationProvider = await read(root, 'examples/blog/app/Providers/NotificationProvider.ts')
  assert(notificationProvider.includes("this.container.make<NotificationManager>('notifications')"), 'Blog notification provider must resolve notifications from the container.')
  assert(notificationProvider.includes("this.container.make<MailManager>('mail')"), 'Blog notification provider must resolve mail from the container.')
  assert(notificationProvider.includes("notifications.registerChannel('mail'"), 'Blog notification provider must register the mail channel.')
  assert(notificationProvider.includes("notifications.registerChannel('database'"), 'Blog notification provider must register the database channel.')

  const storageProvider = await read(root, 'examples/blog/app/Providers/StorageProvider.ts')
  assert(storageProvider.includes('createStorageManager'), 'Blog storage provider must create a storage manager.')
  assert(storageProvider.includes("this.container.instance('storage'"), 'Blog storage provider must register storage in the container.')

  const broadcastProvider = await read(root, 'examples/blog/app/Providers/BroadcastProvider.ts')
  assert(broadcastProvider.includes('createBroadcastManager'), 'Blog broadcast provider must create a broadcast manager.')
  assert(broadcastProvider.includes('MemoryBroadcastDriver'), 'Blog broadcast provider must use the broadcast memory driver.')
  assert(broadcastProvider.includes("broadcast.channel('announcements'"), 'Blog broadcast provider must register a public channel.')
  assert(broadcastProvider.includes("broadcast.privateChannel('posts.{id}'"), 'Blog broadcast provider must register a private channel.')

  const schedulingProvider = await read(root, 'examples/blog/app/Providers/SchedulingProvider.ts')
  assert(schedulingProvider.includes('createScheduler'), 'Blog scheduling provider must create a scheduler.')
  assert(schedulingProvider.includes('registerBlogSchedules(scheduler)'), 'Blog scheduling provider must register the blog schedule kernel.')
  assert(schedulingProvider.includes("this.container.singleton('scheduler'"), 'Blog scheduling provider must register the scheduler in the container.')

  const scheduleKernel = await read(root, 'examples/blog/app/Console/Kernel.ts')
  assert(scheduleKernel.includes("name('blog:warm-post-cache')"), 'Blog schedule kernel must register the cache warm task.')

  const loginController = await read(root, 'examples/blog/app/Http/Controllers/Auth/LoginController.ts')
  assert(loginController.includes("this.make('events')"), 'Blog login controller must resolve the event manager from the container.')
  assert(loginController.includes('.emit(new UserLoggedIn'), 'Blog login controller must emit auth events through the event manager.')

  const postController = await read(root, 'examples/blog/app/Http/Controllers/PostController.ts')
  assert(postController.includes("new PostCacheService(this.make('cache'))"), 'Blog post controller must resolve cache services from the container.')
  assert(postController.includes("this.make('events').emit"), 'Blog post controller must emit post events through the container event manager.')

  const welcomeMailJob = await read(root, 'examples/blog/app/Jobs/SendWelcomeEmailJob.ts')
  assert(welcomeMailJob.includes("sendWelcomeMail(this.make('mail')"), 'Blog welcome email job must resolve mail through the container.')
}

async function auditApi(root: string): Promise<void> {
  const eventProvider = await read(root, 'examples/api/app/Providers/EventServiceProvider.ts')
  assert(eventProvider.includes('createEventManager'), 'API event provider must create an event manager.')
  assert(eventProvider.includes('createMailManager'), 'API event provider must create a mail manager.')
  assert(eventProvider.includes('createQueueManager'), 'API event provider must create a queue manager.')
  assert(eventProvider.includes('setMailManager(mailManager)'), 'API event provider must connect the mail manager to the mail facade.')
  assert(eventProvider.includes('registerJob(SendRegistrationEmailJob)'), 'API event provider must register the registration email job.')
  assert(eventProvider.includes("this.container.singleton('events'"), 'API event provider must register the event manager in the container.')
  assert(eventProvider.includes("this.container.singleton('mail'"), 'API event provider must register the mail manager in the container.')
  assert(eventProvider.includes("this.container.singleton('queue'"), 'API event provider must register the queue manager in the container.')

  const cacheProvider = await read(root, 'examples/api/app/Providers/CacheProvider.ts')
  assert(cacheProvider.includes('createCacheManager'), 'API cache provider must create a cache manager.')
  assert(cacheProvider.includes("this.container.singleton('cache'"), 'API cache provider must register cache in the container.')

  const notificationProvider = await read(root, 'examples/api/app/Providers/NotificationProvider.ts')
  assert(notificationProvider.includes("this.container.make<NotificationManager>('notifications')"), 'API notification provider must resolve notifications from the container.')
  assert(notificationProvider.includes("this.container.make<MailManager>('mail')"), 'API notification provider must resolve mail from the container.')
  assert(notificationProvider.includes("notifications.registerChannel('mail'"), 'API notification provider must register the mail channel.')
  assert(notificationProvider.includes("notifications.registerChannel('database'"), 'API notification provider must register the database channel.')

  const storageProvider = await read(root, 'examples/api/app/Providers/StorageProvider.ts')
  assert(storageProvider.includes('createStorageManager'), 'API storage provider must create a storage manager.')
  assert(storageProvider.includes("this.container.instance('storage'"), 'API storage provider must register storage in the container.')

  const broadcastProvider = await read(root, 'examples/api/app/Providers/BroadcastProvider.ts')
  assert(broadcastProvider.includes('createBroadcastManager'), 'API broadcast provider must create a broadcast manager.')
  assert(broadcastProvider.includes('MemoryBroadcastDriver'), 'API broadcast provider must use the broadcast memory driver.')
  assert(broadcastProvider.includes("broadcast.channel('tasks'"), 'API broadcast provider must register a public channel.')
  assert(broadcastProvider.includes("broadcast.privateChannel('users.{id}.tasks'"), 'API broadcast provider must register a private channel.')

  const schedulingProvider = await read(root, 'examples/api/app/Providers/SchedulingProvider.ts')
  assert(schedulingProvider.includes('createScheduler'), 'API scheduling provider must create a scheduler.')
  assert(schedulingProvider.includes('registerApiSchedules(scheduler)'), 'API scheduling provider must register the API schedule kernel.')
  assert(schedulingProvider.includes("this.container.singleton('scheduler'"), 'API scheduling provider must register the scheduler in the container.')

  const scheduleKernel = await read(root, 'examples/api/app/Console/Kernel.ts')
  assert(scheduleKernel.includes("name('api:prune-task-cache')"), 'API schedule kernel must register the cache prune task.')

  const authController = await read(root, 'examples/api/app/Http/Controllers/AuthController.ts')
  assert(authController.includes("this.make('events').emit"), 'API auth controller must emit registration events through the container event manager.')

  const taskController = await read(root, 'examples/api/app/Http/Controllers/TaskController.ts')
  assert(taskController.includes("new TaskCacheService(this.make('cache'))"), 'API task controller must resolve cache services from the container.')
  assert(taskController.includes("this.make('events').emit"), 'API task controller must emit task lifecycle events through the container event manager.')

  const registrationMailJob = await read(root, 'examples/api/app/Jobs/SendRegistrationEmailJob.ts')
  assert(registrationMailJob.includes("sendRegistrationMail(this.make('mail')"), 'API registration email job must resolve mail through the container.')
}

async function main(): Promise<void> {
  const root = resolve(process.argv[2] ?? '.')
  await auditBlog(root)
  await auditApi(root)
  console.log(`Feature runtime audit passed for ${root}`)
}

await main()
