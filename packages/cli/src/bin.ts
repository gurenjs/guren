#!/usr/bin/env bun
import { pathToFileURL } from 'node:url'
import { consola } from 'consola'
import { defineCommand, runMain, showUsage } from 'citty'
import { makeAuth } from './make-auth'
import { makeChannel } from './make-channel'
import { makeCommand } from './make-command'
import { makeController } from './make-controller'
import { makeEvent } from './make-event'
import { makeException } from './make-exception'
import { makeFactory } from './make-factory'
import { makeJob } from './make-job'
import { makeListener } from './make-listener'
import { makeMail } from './make-mail'
import { makeMiddleware } from './make-middleware'
import { makeMigration } from './make-migration'
import { makeModel } from './make-model'
import { makeNotification } from './make-notification'
import { makeProvider } from './make-provider'
import { makeResource } from './make-resource'
import { makeRoute } from './make-route'
import { makeSeeder } from './make-seeder'
import { makeTest, type TestRunner } from './make-test'
import { makeView } from './make-view'
import { runDatabaseMigrations, runDatabaseSeeders, resetDatabase } from './db-migrate'
import { runDatabaseRollback, showMigrationStatus } from './db-rollback'
import type { WriterOptions } from './utils'
import { generateRouteTypes } from './routes-types'
import { consoleCommand } from './console'
import { bootstrapApplication, resolveMainEntry, type MaybeApplication } from './runtime'
import { runQueueWorker, listFailedJobs, retryFailedJob, retryAllFailedJobs, flushFailedJobs } from './queue'
import { displayRoutes } from './route-list'
import { cacheConfig, clearConfigCache, showConfigCacheInfo } from './config-cache'
import { createStorageLink, removeStorageLink } from './storage-link'
import { listScheduledTasks, runScheduledTasks } from './schedule'
import { runHealthCheck } from './health-check'
import { publishLanguageFiles, makeLanguage, listLocales } from './lang'

type ForceableArgs = { force?: boolean }

function toWriterOptions(args: ForceableArgs): WriterOptions {
  return {
    force: Boolean(args.force),
  }
}

function createMakeCommand(
  commandName: string,
  description: string,
  argDescription: string,
  makeFn: (name: string, options: WriterOptions) => Promise<string>,
  resourceName: string,
) {
  return defineCommand({
    meta: { name: commandName, description },
    args: {
      name: { type: 'positional', required: true, description: argDescription },
      force: { type: 'boolean', description: 'Overwrite existing files', alias: 'f' },
    },
    async run({ args }) {
      const file = await makeFn(args.name, toWriterOptions(args))
      consola.success(`${resourceName} created at ${file}`)
    },
  })
}

type MakeCommandSpec = {
  name: string
  description: string
  argDescription: string
  makeFn: (name: string, options: WriterOptions) => Promise<string>
  resourceName: string
}

const makeCommandSpecs: MakeCommandSpec[] = [
  { name: 'make:controller', description: 'Generate a new controller file.', argDescription: 'Controller class name', makeFn: makeController, resourceName: 'Controller' },
  { name: 'make:model', description: 'Generate a new model file.', argDescription: 'Model class name', makeFn: makeModel, resourceName: 'Model' },
  { name: 'make:view', description: 'Generate a new view component.', argDescription: 'View component path', makeFn: makeView, resourceName: 'View' },
  { name: 'make:route', description: 'Generate a new route group.', argDescription: 'Route group name', makeFn: makeRoute, resourceName: 'Route' },
  { name: 'make:job', description: 'Generate a new job class.', argDescription: 'Job class name', makeFn: makeJob, resourceName: 'Job' },
  { name: 'make:event', description: 'Generate a new event class.', argDescription: 'Event class name', makeFn: makeEvent, resourceName: 'Event' },
  { name: 'make:mail', description: 'Generate a new mailable class.', argDescription: 'Mail class name', makeFn: makeMail, resourceName: 'Mail' },
  { name: 'make:middleware', description: 'Generate a new middleware.', argDescription: 'Middleware name', makeFn: makeMiddleware, resourceName: 'Middleware' },
  { name: 'make:seeder', description: 'Generate a new database seeder.', argDescription: 'Seeder class name', makeFn: makeSeeder, resourceName: 'Seeder' },
  { name: 'make:notification', description: 'Generate a new notification class.', argDescription: 'Notification class name', makeFn: makeNotification, resourceName: 'Notification' },
  { name: 'make:provider', description: 'Generate a new service provider.', argDescription: 'Provider class name', makeFn: makeProvider, resourceName: 'Provider' },
]

const makeCommands = Object.fromEntries(
  makeCommandSpecs.map((spec) => [
    spec.name,
    createMakeCommand(spec.name, spec.description, spec.argDescription, spec.makeFn, spec.resourceName),
  ]),
)

function ensureDestructiveCommandAllowed(force?: boolean): boolean {
  if (process.env.NODE_ENV === 'production' && !force) {
    consola.error('This command is destructive. Use --force to run in production.')
    process.exit(1)
    return false
  }

  return true
}

const makeTestCommand = defineCommand({
  meta: {
    name: 'make:test',
    description: 'Generate a new test file.',
  },
  args: {
    name: {
      type: 'positional',
      required: true,
      description: 'Test suite name or path',
    },
    runner: {
      type: 'string',
      description: 'Test runner to scaffold for (bun or vitest)',
      valueHint: 'bun|vitest',
    },
    force: {
      type: 'boolean',
      description: 'Overwrite existing files',
      alias: 'f',
    },
  },
  async run({ args }) {
    const runnerArg = args.runner?.toLowerCase()
    let runner: TestRunner | undefined

    if (runnerArg) {
      if (runnerArg !== 'bun' && runnerArg !== 'vitest') {
        consola.error(`Invalid runner "${args.runner}". Expected one of: bun, vitest.`)
        process.exit(1)
        return
      }

      runner = runnerArg
    }

    const writerOptions = toWriterOptions(args)
    const file = await makeTest(args.name, runner ? { ...writerOptions, runner } : writerOptions)
    consola.success(`Test created at ${file}`)
  },
})

const makeAuthCommand = defineCommand({
  meta: {
    name: 'make:auth',
    description: 'Scaffold authentication controllers, views, provider, and database resources.',
  },
  args: {
    force: {
      type: 'boolean',
      description: 'Overwrite existing files',
      alias: 'f',
    },
    install: {
      type: 'boolean',
      description: 'Automatically wire up auth configuration in app.ts and routes',
      alias: 'i',
    },
  },
  async run({ args }) {
    const files = await makeAuth({
      ...toWriterOptions(args),
      install: Boolean(args.install),
    })
    for (const file of files) {
      consola.success(`Created ${file}`)
    }
  },
})

const makeListenerCommand = defineCommand({
  meta: {
    name: 'make:listener',
    description: 'Generate a new event listener class.',
  },
  args: {
    name: {
      type: 'positional',
      required: true,
      description: 'Listener class name',
    },
    event: {
      type: 'string',
      description: 'Event class to listen for',
      alias: 'e',
    },
    force: {
      type: 'boolean',
      description: 'Overwrite existing files',
      alias: 'f',
    },
  },
  async run({ args }) {
    const { makeListener: makeListenerFn } = await import('./make-listener')
    const file = await makeListenerFn(args.name, {
      force: Boolean(args.force),
      event: args.event,
    })
    consola.success(`Listener created at ${file}`)
  },
})

const makeResourceCommand = defineCommand({
  meta: {
    name: 'make:resource',
    description: 'Generate a new API resource class.',
  },
  args: {
    name: {
      type: 'positional',
      required: true,
      description: 'Resource class name',
    },
    model: {
      type: 'string',
      description: 'Model class this resource wraps',
      alias: 'm',
    },
    force: {
      type: 'boolean',
      description: 'Overwrite existing files',
      alias: 'f',
    },
  },
  async run({ args }) {
    const file = await makeResource(args.name, {
      force: Boolean(args.force),
      model: args.model,
    })
    consola.success(`Resource created at ${file}`)
  },
})

const makeFactoryCommand = defineCommand({
  meta: {
    name: 'make:factory',
    description: 'Generate a new model factory class.',
  },
  args: {
    name: {
      type: 'positional',
      required: true,
      description: 'Factory class name',
    },
    model: {
      type: 'string',
      description: 'Model class this factory creates',
      alias: 'm',
    },
    force: {
      type: 'boolean',
      description: 'Overwrite existing files',
      alias: 'f',
    },
  },
  async run({ args }) {
    const file = await makeFactory(args.name, {
      force: Boolean(args.force),
      model: args.model,
    })
    consola.success(`Factory created at ${file}`)
  },
})

const makeConsoleCommandCommand = defineCommand({
  meta: {
    name: 'make:command',
    description: 'Generate a new console command.',
  },
  args: {
    name: {
      type: 'positional',
      required: true,
      description: 'Command class name',
    },
    command: {
      type: 'string',
      description: 'Console command name (e.g., users:import)',
      alias: 'c',
    },
    force: {
      type: 'boolean',
      description: 'Overwrite existing files',
      alias: 'f',
    },
  },
  async run({ args }) {
    const file = await makeCommand(args.name, {
      force: Boolean(args.force),
      command: args.command,
    })
    consola.success(`Command created at ${file}`)
  },
})

const makeChannelCommand = defineCommand({
  meta: {
    name: 'make:channel',
    description: 'Generate a new broadcasting channel.',
  },
  args: {
    name: {
      type: 'positional',
      required: true,
      description: 'Channel class name',
    },
    channel: {
      type: 'string',
      description: 'Channel name for broadcasting',
    },
    private: {
      type: 'boolean',
      description: 'Create a private channel',
      alias: 'p',
    },
    presence: {
      type: 'boolean',
      description: 'Create a presence channel',
    },
    force: {
      type: 'boolean',
      description: 'Overwrite existing files',
      alias: 'f',
    },
  },
  async run({ args }) {
    const file = await makeChannel(args.name, {
      force: Boolean(args.force),
      channel: args.channel,
      private: Boolean(args.private),
      presence: Boolean(args.presence),
    })
    consola.success(`Channel created at ${file}`)
  },
})

const makeExceptionCommand = defineCommand({
  meta: {
    name: 'make:exception',
    description: 'Generate a new exception class.',
  },
  args: {
    name: {
      type: 'positional',
      required: true,
      description: 'Exception class name',
    },
    status: {
      type: 'string',
      description: 'HTTP status code',
      alias: 's',
    },
    message: {
      type: 'string',
      description: 'Default error message',
      alias: 'm',
    },
    force: {
      type: 'boolean',
      description: 'Overwrite existing files',
      alias: 'f',
    },
  },
  async run({ args }) {
    const file = await makeException(args.name, {
      force: Boolean(args.force),
      status: args.status ? parseInt(args.status, 10) : undefined,
      message: args.message,
    })
    consola.success(`Exception created at ${file}`)
  },
})

const makeMigrationCommand = defineCommand({
  meta: {
    name: 'make:migration',
    description: 'Generate a new SQL migration file using drizzle-kit.',
  },
  args: {
    name: {
      type: 'positional',
      required: false,
      description: 'Optional migration name passed to drizzle-kit',
    },
    schema: {
      type: 'string',
      description: 'Override the schema file path',
      valueHint: 'db/schema.ts',
    },
    out: {
      type: 'string',
      description: 'Override the migrations output directory',
      valueHint: 'db/migrations',
    },
  },
  async run({ args }) {
    await makeMigration({
      name: args.name,
      schema: args.schema,
      out: args.out,
    })
    consola.success('Migration generated.')
  },
})

const migrateCommand = defineCommand({
  meta: {
    name: 'db:migrate',
    description: 'Run all pending database migrations.',
  },
  async run() {
    await runDatabaseMigrations()
    consola.success('Database migrations completed.')
  },
})

const seedCommand = defineCommand({
  meta: {
    name: 'db:seed',
    description: 'Execute database seeders.',
  },
  async run() {
    await runDatabaseSeeders()
    consola.success('Database seeders executed.')
  },
})

const resetCommand = defineCommand({
  meta: {
    name: 'db:reset',
    description: 'Drop all tables, re-run migrations, and optionally re-seed.',
  },
  args: {
    seed: {
      type: 'boolean',
      description: 'Run seeders after migrations',
      alias: 's',
    },
    force: {
      type: 'boolean',
      description: 'Skip confirmation prompt (required in production)',
      alias: 'f',
    },
  },
  async run({ args }) {
    if (!ensureDestructiveCommandAllowed(args.force)) {
      return
    }

    consola.info('Dropping all tables...')
    await resetDatabase({ seed: Boolean(args.seed) })

    if (args.seed) {
      consola.success('Database reset and seeded successfully.')
    } else {
      consola.success('Database reset successfully.')
    }
  },
})

const freshCommand = defineCommand({
  meta: {
    name: 'db:fresh',
    description: 'Drop all tables and re-run all migrations (alias for db:reset).',
  },
  args: {
    seed: {
      type: 'boolean',
      description: 'Run seeders after migrations',
      alias: 's',
    },
    force: {
      type: 'boolean',
      description: 'Skip confirmation prompt (required in production)',
      alias: 'f',
    },
  },
  async run({ args }) {
    if (!ensureDestructiveCommandAllowed(args.force)) {
      return
    }

    consola.info('Dropping all tables...')
    await resetDatabase({ seed: Boolean(args.seed) })

    if (args.seed) {
      consola.success('Database refreshed and seeded successfully.')
    } else {
      consola.success('Database refreshed successfully.')
    }
  },
})

const routeTypesCommand = defineCommand({
  meta: {
    name: 'routes:types',
    description: 'Generate TypeScript route declarations for client-side helpers.',
  },
  args: {
    routes: {
      type: 'string',
      description: 'Path to the routes entry file',
      valueHint: 'routes/web.ts',
    },
    out: {
      type: 'string',
      description: 'Declaration file to write',
      valueHint: 'types/generated/routes.d.ts',
    },
    app: {
      type: 'string',
      description: 'Application root directory to resolve paths from',
      valueHint: '.',
    },
    force: {
      type: 'boolean',
      description: 'Overwrite existing declaration file',
      alias: 'f',
    },
  },
  async run({ args }) {
    const writerOptions = toWriterOptions(args)
    const { outputPath } = await generateRouteTypes({
      routesFile: args.routes,
      outputFile: args.out,
      appRoot: args.app,
      ...writerOptions,
    })
    consola.success(`Route types generated at ${outputPath}`)
  },
})

const rollbackCommand = defineCommand({
  meta: {
    name: 'db:rollback',
    description: 'Rollback the last database migration(s).',
  },
  args: {
    step: {
      type: 'string',
      description: 'Number of migrations to rollback',
      default: '1',
    },
    batch: {
      type: 'boolean',
      description: 'Rollback the entire last batch',
    },
    force: {
      type: 'boolean',
      description: 'Skip confirmation prompt',
      alias: 'f',
    },
  },
  async run({ args }) {
    if (!ensureDestructiveCommandAllowed(args.force)) {
      return
    }

    await runDatabaseRollback({
      steps: parseInt(args.step ?? '1', 10),
      batch: args.batch,
      force: args.force,
    })
  },
})

const statusCommand = defineCommand({
  meta: {
    name: 'db:status',
    description: 'Show the status of all migrations.',
  },
  async run() {
    await showMigrationStatus()
  },
})

const queueWorkCommand = defineCommand({
  meta: {
    name: 'queue:work',
    description: 'Start a queue worker to process jobs.',
  },
  args: {
    queue: {
      type: 'string',
      description: 'Queue names to process (comma-separated)',
      default: 'default',
    },
    once: {
      type: 'boolean',
      description: 'Process only one job and exit',
    },
    sleep: {
      type: 'string',
      description: 'Sleep time between polls (ms)',
      default: '1000',
    },
    timeout: {
      type: 'string',
      description: 'Job timeout in seconds',
      default: '60',
    },
    'max-jobs': {
      type: 'string',
      description: 'Maximum jobs to process (0 = unlimited)',
      default: '0',
    },
  },
  async run({ args }) {
    await runQueueWorker({
      queue: args.queue,
      once: args.once,
      sleep: parseInt(args.sleep ?? '1000', 10),
      timeout: parseInt(args.timeout ?? '60', 10),
      maxJobs: parseInt(args['max-jobs'] ?? '0', 10),
    })
  },
})

const queueFailedCommand = defineCommand({
  meta: {
    name: 'queue:failed',
    description: 'List all failed queue jobs.',
  },
  args: {
    queue: {
      type: 'string',
      description: 'Filter by queue name',
    },
  },
  async run({ args }) {
    await listFailedJobs(args.queue)
  },
})

const queueRetryCommand = defineCommand({
  meta: {
    name: 'queue:retry',
    description: 'Retry a failed job or all failed jobs.',
  },
  args: {
    id: {
      type: 'positional',
      required: false,
      description: 'Job ID to retry (or --all for all jobs)',
    },
    all: {
      type: 'boolean',
      description: 'Retry all failed jobs',
    },
    queue: {
      type: 'string',
      description: 'Filter by queue name (with --all)',
    },
  },
  async run({ args }) {
    if (args.all) {
      await retryAllFailedJobs(args.queue)
    } else if (args.id) {
      await retryFailedJob(args.id)
    } else {
      consola.error('Please provide a job ID or use --all to retry all failed jobs.')
      process.exit(1)
    }
  },
})

const queueFlushCommand = defineCommand({
  meta: {
    name: 'queue:flush',
    description: 'Delete all failed jobs.',
  },
  args: {
    queue: {
      type: 'string',
      description: 'Filter by queue name',
    },
  },
  async run({ args }) {
    await flushFailedJobs(args.queue)
  },
})

const routeListCommand = defineCommand({
  meta: {
    name: 'route:list',
    description: 'List all registered application routes.',
  },
  args: {
    routes: {
      type: 'string',
      description: 'Path to the routes entry file',
      valueHint: 'routes/web.ts',
    },
    app: {
      type: 'string',
      description: 'Application root directory',
    },
    method: {
      type: 'string',
      description: 'Filter by HTTP method (GET, POST, etc.)',
      alias: 'm',
    },
    path: {
      type: 'string',
      description: 'Filter by path pattern',
      alias: 'p',
    },
    name: {
      type: 'string',
      description: 'Filter by route name',
      alias: 'n',
    },
    format: {
      type: 'string',
      description: 'Output format (table, json, compact)',
      default: 'table',
    },
    sort: {
      type: 'string',
      description: 'Sort by (method, path, name)',
      alias: 's',
    },
    reverse: {
      type: 'boolean',
      description: 'Reverse sort order',
      alias: 'r',
    },
  },
  async run({ args }) {
    await displayRoutes({
      routesFile: args.routes,
      appRoot: args.app,
      method: args.method,
      path: args.path,
      name: args.name,
      format: args.format as 'table' | 'json' | 'compact',
      sort: args.sort as 'method' | 'path' | 'name',
      reverse: args.reverse,
    })
  },
})

const configCacheCommand = defineCommand({
  meta: {
    name: 'config:cache',
    description: 'Create a cache file for faster configuration loading.',
  },
  args: {
    config: {
      type: 'string',
      description: 'Config directory path',
      valueHint: 'config',
    },
    cache: {
      type: 'string',
      description: 'Cache output directory',
      valueHint: 'bootstrap/cache',
    },
    app: {
      type: 'string',
      description: 'Application root directory',
    },
  },
  async run({ args }) {
    await cacheConfig({
      configDir: args.config,
      cacheDir: args.cache,
      appRoot: args.app,
    })
  },
})

const configClearCommand = defineCommand({
  meta: {
    name: 'config:clear',
    description: 'Remove the configuration cache file.',
  },
  args: {
    cache: {
      type: 'string',
      description: 'Cache directory path',
      valueHint: 'bootstrap/cache',
    },
    app: {
      type: 'string',
      description: 'Application root directory',
    },
  },
  async run({ args }) {
    clearConfigCache({
      cacheDir: args.cache,
      appRoot: args.app,
    })
  },
})

const configShowCommand = defineCommand({
  meta: {
    name: 'config:show',
    description: 'Show configuration cache info.',
  },
  args: {
    cache: {
      type: 'string',
      description: 'Cache directory path',
      valueHint: 'bootstrap/cache',
    },
    app: {
      type: 'string',
      description: 'Application root directory',
    },
  },
  async run({ args }) {
    showConfigCacheInfo({
      cacheDir: args.cache,
      appRoot: args.app,
    })
  },
})

const storageLinkCommand = defineCommand({
  meta: {
    name: 'storage:link',
    description: 'Create a symbolic link from public/storage to storage/app/public.',
  },
  args: {
    force: {
      type: 'boolean',
      description: 'Recreate the link if it already exists',
      alias: 'f',
    },
    relative: {
      type: 'boolean',
      description: 'Use relative path for symbolic link',
      alias: 'r',
    },
    remove: {
      type: 'boolean',
      description: 'Remove the symbolic link instead of creating it',
    },
  },
  async run({ args }) {
    if (args.remove) {
      const success = removeStorageLink()
      if (!success) {
        process.exit(1)
      }
    } else {
      const success = createStorageLink({
        force: Boolean(args.force),
        relative: Boolean(args.relative),
      })
      if (!success) {
        process.exit(1)
      }
    }
  },
})

const scheduleListCommand = defineCommand({
  meta: {
    name: 'schedule:list',
    description: 'List all registered scheduled tasks.',
  },
  args: {
    kernel: {
      type: 'string',
      description: 'Path to the schedule kernel file',
      valueHint: 'app/Console/Kernel.ts',
    },
    app: {
      type: 'string',
      description: 'Application root directory',
    },
  },
  async run({ args }) {
    await listScheduledTasks({
      kernel: args.kernel,
      appRoot: args.app,
    })
  },
})

const scheduleRunCommand = defineCommand({
  meta: {
    name: 'schedule:run',
    description: 'Run scheduled tasks that are due.',
  },
  args: {
    kernel: {
      type: 'string',
      description: 'Path to the schedule kernel file',
      valueHint: 'app/Console/Kernel.ts',
    },
    app: {
      type: 'string',
      description: 'Application root directory',
    },
    task: {
      type: 'string',
      description: 'Run a specific task by name',
      alias: 't',
    },
    force: {
      type: 'boolean',
      description: 'Force run (ignore schedule)',
      alias: 'f',
    },
  },
  async run({ args }) {
    await runScheduledTasks({
      kernel: args.kernel,
      appRoot: args.app,
      task: args.task,
      force: args.force,
    })
  },
})

const healthCheckCommand = defineCommand({
  meta: {
    name: 'health:check',
    description: 'Run application health checks.',
  },
  args: {
    health: {
      type: 'string',
      description: 'Path to the health configuration file',
      valueHint: 'app/health.ts',
    },
    app: {
      type: 'string',
      description: 'Application root directory',
    },
    checks: {
      type: 'string',
      description: 'Run specific checks only (comma-separated)',
      alias: 'c',
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON',
    },
  },
  async run({ args }) {
    await runHealthCheck({
      health: args.health,
      appRoot: args.app,
      checks: args.checks,
      json: args.json,
    })
  },
})

const langPublishCommand = defineCommand({
  meta: {
    name: 'lang:publish',
    description: 'Publish default language file templates.',
  },
  args: {
    path: {
      type: 'string',
      description: 'Path to the language files directory',
      valueHint: 'lang',
    },
    app: {
      type: 'string',
      description: 'Application root directory',
    },
    force: {
      type: 'boolean',
      description: 'Overwrite existing files',
      alias: 'f',
    },
  },
  async run({ args }) {
    const files = publishLanguageFiles({
      path: args.path,
      appRoot: args.app,
      force: args.force,
    })

    if (files.length === 0) {
      consola.info('No files were created.')
    } else {
      consola.info('')
      consola.success(`Published ${files.length} language file(s).`)
    }
  },
})

const makeLangCommand = defineCommand({
  meta: {
    name: 'make:lang',
    description: 'Create a new language locale.',
  },
  args: {
    locale: {
      type: 'positional',
      required: true,
      description: 'Locale code (e.g., ja, es, pt-BR)',
    },
    path: {
      type: 'string',
      description: 'Path to the language files directory',
      valueHint: 'lang',
    },
    app: {
      type: 'string',
      description: 'Application root directory',
    },
    from: {
      type: 'string',
      description: 'Copy structure from existing locale',
    },
    force: {
      type: 'boolean',
      description: 'Overwrite existing files',
      alias: 'f',
    },
  },
  async run({ args }) {
    makeLanguage(args.locale, {
      path: args.path,
      appRoot: args.app,
      from: args.from,
      force: args.force,
    })
  },
})

const langListCommand = defineCommand({
  meta: {
    name: 'lang:list',
    description: 'List available language locales.',
  },
  args: {
    path: {
      type: 'string',
      description: 'Path to the language files directory',
      valueHint: 'lang',
    },
    app: {
      type: 'string',
      description: 'Application root directory',
    },
  },
  async run({ args }) {
    const locales = listLocales({
      path: args.path,
      appRoot: args.app,
    })

    if (locales.length === 0) {
      consola.info('No language locales found.')
      consola.info('Run `bunx guren lang:publish` to create default language files.')
    } else {
      console.log('')
      console.log('Available Locales')
      console.log('=================')
      console.log('')
      for (const locale of locales) {
        console.log(`  - ${locale}`)
      }
      console.log('')
      console.log(`Total: ${locales.length} locale(s)`)
    }
  },
})

const devCommand = defineCommand({
  meta: {
    name: 'dev',
    description: 'Start the Guren application in development mode using Bun.',
  },
  async run() {
    let entry: string
    try {
      entry = await resolveMainEntry()
    } catch (error) {
      consola.error(error instanceof Error ? error.message : String(error))
      process.exit(1)
      return
    }

    let mod: Record<string, unknown>
    try {
      mod = await import(pathToFileURL(entry).href)
    } catch (error) {
      consola.error(`Failed to import application entry (${entry}):`, error)
      process.exit(1)
      return
    }

    let app: MaybeApplication
    try {
      app = await bootstrapApplication(mod)
    } catch (error) {
      consola.error(error instanceof Error ? error.message : String(error))
      process.exit(1)
      return
    }

    const port = Number.parseInt(process.env.PORT ?? '', 10) || 3333
    const hostname = process.env.HOST ?? '0.0.0.0'

    try {
      app.listen?.({ port, hostname })
    } catch (error) {
      consola.error('Failed to start application listener:', error)
      process.exit(1)
      return
    }

    consola.success(`Development server listening on http://${hostname}:${port}`)
  },
})

const main = defineCommand({
  meta: {
    name: 'guren',
    description: 'Guren framework CLI utilities.',
  },
  args: {
    help: {
      type: 'boolean',
      alias: 'h',
      description: 'Show this help message',
    },
  },
  subCommands: {
    ...makeCommands,
    'make:auth': makeAuthCommand,
    'make:channel': makeChannelCommand,
    'make:command': makeConsoleCommandCommand,
    'make:exception': makeExceptionCommand,
    'make:factory': makeFactoryCommand,
    'make:listener': makeListenerCommand,
    'make:migration': makeMigrationCommand,
    'make:resource': makeResourceCommand,
    'make:test': makeTestCommand,
    'db:migrate': migrateCommand,
    'db:seed': seedCommand,
    'db:reset': resetCommand,
    'db:fresh': freshCommand,
    'db:rollback': rollbackCommand,
    'db:status': statusCommand,
    'queue:work': queueWorkCommand,
    'queue:failed': queueFailedCommand,
    'queue:retry': queueRetryCommand,
    'queue:flush': queueFlushCommand,
    'routes:types': routeTypesCommand,
    'route:list': routeListCommand,
    'config:cache': configCacheCommand,
    'config:clear': configClearCommand,
    'config:show': configShowCommand,
    'storage:link': storageLinkCommand,
    'schedule:list': scheduleListCommand,
    'schedule:run': scheduleRunCommand,
    'health:check': healthCheckCommand,
    'lang:publish': langPublishCommand,
    'lang:list': langListCommand,
    'make:lang': makeLangCommand,
    console: consoleCommand,
    dev: devCommand,
  },
  async run(ctx) {
    if (ctx.args.help || ctx.rawArgs.length === 0) {
      await showUsage(ctx.cmd)
      return
    }

    const [commandName] = ctx.rawArgs
    const subCommands = ctx.cmd.subCommands ?? {}
    if (commandName && Object.prototype.hasOwnProperty.call(subCommands, commandName)) {
      return
    }

    if (commandName) {
      consola.error(`Unknown command: ${commandName}`)
      await showUsage(ctx.cmd)
      process.exit(1)
    }
  },
})

runMain(main).catch((error) => {
  if (error instanceof Error) {
    consola.error(error.message)
  } else {
    consola.error(String(error))
  }
  process.exit(1)
})
