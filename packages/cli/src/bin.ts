#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { consola } from 'consola'
import { defineCommand, showUsage } from 'citty'
import type { CommandDef } from 'citty'
import { runCli } from './run-cli'
import { listBlueprints, runBlueprint } from './blueprints'
import { runDoctor } from './doctor'
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
import { makePolicy } from './make-policy'
import { makeMigration } from './make-migration'
import { makeModel } from './make-model'
import { makeModule } from './make-module'
import { makeNotification } from './make-notification'
import { makeProvider } from './make-provider'
import { makeAdr } from './make-adr'
import { writeSpecArtifacts } from './spec-generate'
import { makeResource } from './make-resource'
import { makeRoute } from './make-route'
import { makeSeeder } from './make-seeder'
import { makeTest, type TestRunner } from './make-test'
import { makeView } from './make-view'
import { runDatabaseMigrations, runDatabaseSeeders, resetDatabase } from './db-migrate'
import { showMigrationStatus } from './db-status'
import type { WriterOptions } from './utils'
import { generateRouteTypes } from './routes-types'
import { generatePageTypes } from './pages-types'
import { generateDataTypes } from './data-types'
import { generateApiClientTypes } from './api-client-types'
import { generateOpenApiSpec } from './openapi-generate'
import { generateChannelTypes } from './channel-types'
import { consoleCommand } from './console'
import { bootstrapApplication, resolveMainEntry, type MaybeApplication } from './runtime'
import { runQueueWorker, listFailedJobs, retryFailedJob, retryAllFailedJobs, flushFailedJobs } from './queue'
import { displayRoutes } from './route-list'
import { cacheConfig, clearConfigCache, showConfigCacheInfo } from './config-cache'
import { createStorageLink, removeStorageLink } from './storage-link'
import { listScheduledTasks, runScheduledTasks } from './schedule'
import { runHealthCheck } from './health-check'
import { publishLanguageFiles, makeLanguage, listLocales } from './lang'
import { upgradeCanary, DEFAULT_UPGRADE_TAG } from './upgrade'
import { scaffoldDeploy, type DeployTarget } from './deploy'
import { installPlugin } from './plugin'
import { discoverPluginCommands, createPluginCommandProxy } from './plugin-commands'
import { displayModels } from './model-list'
import { displayContext } from './context'
import { displayEntityContext } from './entity-context'
import { runCheck, renderCheckReport } from './check'
import { runAudit, renderAuditReport } from './audit'
import { generateGuidelines } from './guidelines'
import { installAgentHarness, type AgentHarnessResult } from './agent-harness'
import { makeFeature, parseFieldsString } from './make-feature'
import { generateKeyValue, writeKeyToEnv } from './key-generate'

type ForceableArgs = { force?: boolean; module?: string }

function toWriterOptions(args: ForceableArgs): WriterOptions {
  return {
    force: Boolean(args.force),
    root: args.module,
  }
}

const MODULE_ARG = {
  type: 'string' as const,
  description: 'Scaffold inside modules/<name>/ instead of the project root.',
  alias: 'M',
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
      module: MODULE_ARG,
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
  { name: 'make:policy', description: 'Generate a new authorization policy.', argDescription: 'Policy class name', makeFn: makePolicy, resourceName: 'Policy' },
  { name: 'make:seeder', description: 'Generate a new database seeder.', argDescription: 'Seeder class name', makeFn: makeSeeder, resourceName: 'Seeder' },
  { name: 'make:notification', description: 'Generate a new notification class.', argDescription: 'Notification class name', makeFn: makeNotification, resourceName: 'Notification' },
  { name: 'make:provider', description: 'Generate a new service provider.', argDescription: 'Provider class name', makeFn: makeProvider, resourceName: 'Provider' },
]

const specGenerateCommand = defineCommand({
  meta: {
    name: 'spec:generate',
    description: 'Generate spec views (ER, domain model, screens, modules) into docs/spec.',
  },
  args: {
    routes: {
      type: 'string',
      description: 'Path to routes entry file.',
    },
    app: {
      type: 'string',
      description: 'Application root directory.',
    },
  },
  async run({ args }) {
    await writeSpecArtifacts({ cwd: args.app, routesFile: args.routes })
  },
})

// make:adr takes an extra --entity flag beyond the shared writer options,
// so it gets its own command instead of a makeCommandSpecs entry.
const makeAdrCommand = defineCommand({
  meta: {
    name: 'make:adr',
    description: 'Generate a numbered ADR under docs/adr with linkable frontmatter.',
  },
  args: {
    name: { type: 'positional', required: true, description: 'Decision title (quoted prose)' },
    entity: {
      type: 'string',
      description: 'Model class name to prefill entities:/related: with (case-insensitive).',
    },
    force: { type: 'boolean', description: 'Overwrite existing files', alias: 'f' },
    module: MODULE_ARG,
  },
  async run({ args }) {
    const file = await makeAdr(args.name, { ...toWriterOptions(args), entity: args.entity })
    consola.success(`ADR created at ${file}`)
  },
})

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

function reportDryRun(action: string, message: string, json: boolean, extra?: Record<string, unknown>): void {
  if (json) {
    console.log(JSON.stringify({ dryRun: true, action, message, ...extra }, null, 2))
  } else {
    consola.info(`[dry-run] ${message}`)
  }
}

function reportSuccess(action: string, message: string, json: boolean, extra?: Record<string, unknown>): void {
  if (json) {
    console.log(JSON.stringify({ success: true, action, message, ...extra }, null, 2))
  } else {
    consola.success(message)
  }
}

async function runBunCommand(args: string[]): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath || 'bun', args, {
      stdio: 'inherit',
      env: process.env,
    })

    child.on('error', (error) => {
      rejectPromise(error)
    })

    child.on('close', (code) => {
      if (code === 0) {
        resolvePromise()
      } else {
        rejectPromise(new Error(`bun ${args.join(' ')} exited with code ${code}`))
      }
    })
  })
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
      description: 'Test runner to scaffold for (bun or vitest). Defaults to auto-detecting the target project.',
      valueHint: 'bun|vitest',
    },
    controller: {
      type: 'boolean',
      description: 'Scaffold a controller test in tests/controllers/ with a Controller suffix',
    },
    force: {
      type: 'boolean',
      description: 'Overwrite existing files',
      alias: 'f',
    },
    module: MODULE_ARG,
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
    const file = await makeTest(args.name, {
      ...writerOptions,
      ...(runner ? { runner } : {}),
      controller: Boolean(args.controller),
    })
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
    minimal: {
      type: 'boolean',
      description: 'Skip registration and password reset scaffolding and generate the login-only experience',
    },
    verify: {
      type: 'boolean',
      description: 'Also scaffold email verification (requires the default, non-minimal experience)',
    },
    oauth: {
      type: 'string',
      description: 'Also scaffold OAuth login buttons for the given comma-separated providers (github, google, discord)',
    },
    'oauth-only': {
      type: 'boolean',
      description: 'Make OAuth the only sign-in method: skip password login, registration, and password reset (requires --oauth)',
    },
  },
  async run({ args }) {
    const files = await makeAuth({
      ...toWriterOptions(args),
      install: Boolean(args.install),
      minimal: Boolean(args.minimal),
      verify: Boolean(args.verify),
      oauth: args.oauth,
      oauthOnly: Boolean(args['oauth-only']),
    })
    for (const file of files) {
      consola.success(`Created ${file}`)
    }
  },
})

const makeModuleCommand = defineCommand({
  meta: {
    name: 'make:module',
    description: 'Scaffold a modules/<name>/ directory and wire it into src/app.ts.',
  },
  args: {
    name: {
      type: 'positional',
      required: true,
      description: 'Module name (e.g., billing)',
    },
    force: {
      type: 'boolean',
      description: 'Overwrite existing files',
      alias: 'f',
    },
  },
  async run({ args }) {
    const { moduleDir, filesCreated } = await makeModule(args.name, toWriterOptions(args))
    for (const file of filesCreated) {
      consola.success(`Created ${file}`)
    }
    consola.info(`Scaffold new components inside it with --module ${args.name}, e.g.:`)
    consola.info(`  bunx guren make:controller Invoice --module ${args.name}`)
    consola.info(`  bunx guren make:model Invoice --module ${args.name}`)
    consola.info(`Module directory: ${moduleDir}`)
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
    module: MODULE_ARG,
  },
  async run({ args }) {
    const { makeListener: makeListenerFn } = await import('./make-listener')
    const file = await makeListenerFn(args.name, {
      force: Boolean(args.force),
      root: args.module,
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
    module: MODULE_ARG,
  },
  async run({ args }) {
    const file = await makeResource(args.name, {
      force: Boolean(args.force),
      root: args.module,
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
    module: MODULE_ARG,
  },
  async run({ args }) {
    const file = await makeFactory(args.name, {
      force: Boolean(args.force),
      root: args.module,
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
    module: MODULE_ARG,
  },
  async run({ args }) {
    const file = await makeCommand(args.name, {
      force: Boolean(args.force),
      root: args.module,
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
    module: MODULE_ARG,
  },
  async run({ args }) {
    const file = await makeChannel(args.name, {
      force: Boolean(args.force),
      root: args.module,
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
    module: MODULE_ARG,
  },
  async run({ args }) {
    const file = await makeException(args.name, {
      force: Boolean(args.force),
      root: args.module,
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
  args: {
    dryRun: {
      type: 'boolean',
      alias: 'd',
      description: 'Show what would happen without executing',
    },
    json: {
      type: 'boolean',
      description: 'Output result as JSON',
    },
  },
  async run({ args }) {
    if (args.dryRun) {
      reportDryRun('db:migrate', 'Would run all pending database migrations.', Boolean(args.json))
      return
    }

    await runDatabaseMigrations()
    reportSuccess('db:migrate', 'Database migrations completed.', Boolean(args.json))
  },
})

const seedCommand = defineCommand({
  meta: {
    name: 'db:seed',
    description: 'Execute database seeders.',
  },
  args: {
    force: {
      type: 'boolean',
      description: 'Run in production without confirmation',
      alias: 'f',
    },
    dryRun: {
      type: 'boolean',
      alias: 'd',
      description: 'Show what would happen without executing',
    },
    json: {
      type: 'boolean',
      description: 'Output result as JSON',
    },
  },
  async run({ args }) {
    if (!ensureDestructiveCommandAllowed(args.force)) {
      return
    }

    if (args.dryRun) {
      reportDryRun('db:seed', 'Would execute database seeders.', Boolean(args.json))
      return
    }

    await runDatabaseSeeders()
    reportSuccess('db:seed', 'Database seeders executed.', Boolean(args.json))
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
      description: 'Run in production without confirmation',
      alias: 'f',
    },
    json: {
      type: 'boolean',
      description: 'Output result as JSON',
    },
    dryRun: {
      type: 'boolean',
      alias: 'd',
      description: 'Show what would happen without executing',
    },
  },
  async run({ args }) {
    if (!ensureDestructiveCommandAllowed(args.force)) {
      return
    }

    if (args.dryRun) {
      const message = args.seed
        ? 'Would drop all tables, re-run all migrations, and run seeders.'
        : 'Would drop all tables and re-run all migrations.'
      reportDryRun('db:reset', message, Boolean(args.json), { seed: Boolean(args.seed) })
      return
    }

    consola.info('Dropping all tables...')
    await resetDatabase({ seed: Boolean(args.seed) })

    const message = args.seed
      ? 'Database reset and seeded successfully.'
      : 'Database reset successfully.'
    reportSuccess('db:reset', message, Boolean(args.json), { seed: Boolean(args.seed) })
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
      description: 'Run in production without confirmation',
      alias: 'f',
    },
    json: {
      type: 'boolean',
      description: 'Output result as JSON',
    },
    dryRun: {
      type: 'boolean',
      alias: 'd',
      description: 'Show what would happen without executing',
    },
  },
  async run({ args }) {
    if (!ensureDestructiveCommandAllowed(args.force)) {
      return
    }

    if (args.dryRun) {
      const message = args.seed
        ? 'Would drop all tables, re-run all migrations, and run seeders.'
        : 'Would drop all tables and re-run all migrations.'
      reportDryRun('db:fresh', message, Boolean(args.json), { seed: Boolean(args.seed) })
      return
    }

    consola.info('Dropping all tables...')
    await resetDatabase({ seed: Boolean(args.seed) })

    const message = args.seed
      ? 'Database refreshed and seeded successfully.'
      : 'Database refreshed successfully.'
    reportSuccess('db:fresh', message, Boolean(args.json), { seed: Boolean(args.seed) })
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
    pages: {
      type: 'string',
      description: 'Frontend pages directory to scan for page contracts',
      valueHint: 'resources/js/pages',
    },
    pagesOut: {
      type: 'string',
      description: 'Runtime page manifest module to write',
      valueHint: '.guren/pages.gen.ts',
    },
    force: {
      type: 'boolean',
      description: 'Overwrite existing files',
      alias: 'f',
    },
  },
  async run({ args }) {
    const writerOptions = toWriterOptions(args)
    const { outputPath: pagesOutputPath } = await generatePageTypes({
      appRoot: args.app,
      pagesDir: args.pages,
      outputFile: args.pagesOut,
      ...writerOptions,
    })
    const { outputPath, runtimeOutputPath } = await generateRouteTypes({
      routesFile: args.routes,
      outputFile: args.out,
      appRoot: args.app,
      ...writerOptions,
    })
    consola.success(`Page helpers generated at ${pagesOutputPath}`)
    consola.success(`Route types generated at ${outputPath}`)
    consola.success(`Route helpers generated at ${runtimeOutputPath}`)
    process.exit(0)
  },
})

const codegenCommand = defineCommand({
  meta: {
    name: 'codegen',
    description: 'Generate framework artifacts such as route declarations and runtime route helpers.',
  },
  args: routeTypesCommand.args,
  async run({ args }) {
    // Unlike make:* and routes:types, codegen's outputs are entirely
    // generated artifacts under .guren/ and types/generated/ — safe to
    // overwrite by default, including custom --out/--pages-out destinations
    // (those flags exist to redirect where a generated artifact lands, not
    // to protect hand-maintained files). --force is still accepted for
    // backward compatibility but is a no-op.
    const writerOptions: WriterOptions = { ...toWriterOptions(args), force: true }
    const { outputPath: pagesOutputPath } = await generatePageTypes({
      appRoot: args.app,
      pagesDir: args.pages,
      outputFile: args.pagesOut,
      extractProps: true,
      ...writerOptions,
    })
    if (pagesOutputPath) consola.success(`Page helpers generated at ${pagesOutputPath}`)

    // Route/API artifacts default to routes/web.ts; skip only when no routes file exists.
    const { existsSync } = await import('node:fs')
    const { resolve: resolvePath } = await import('node:path')
    const routesFile = args.routes ?? 'routes/web.ts'
    const appRoot = args.app ?? process.cwd()
    if (!existsSync(resolvePath(appRoot, routesFile))) {
      consola.warn(`Routes file ${routesFile} not found — skipped route, data, channel, and API client generation.`)
      process.exit(0)
    }

    const { outputPath, runtimeOutputPath, definitions } = await generateRouteTypes({
      routesFile,
      outputFile: args.out,
      appRoot: args.app,
      ...writerOptions,
    })
    const { outputPath: dataOutputPath } = await generateDataTypes({
      appRoot: args.app,
      ...writerOptions,
    })
    const { outputPath: channelOutputPath } = await generateChannelTypes({
      appRoot: args.app,
      ...writerOptions,
    })
    const { outputPath: apiClientOutputPath } = await generateApiClientTypes(
      definitions,
      { appRoot: args.app, ...writerOptions },
    )
    consola.success(`Route types generated at ${outputPath}`)
    consola.success(`Route helpers generated at ${runtimeOutputPath}`)
    consola.success(`Data types generated at ${dataOutputPath}`)
    consola.success(`Channel types generated at ${channelOutputPath}`)
    consola.success(`API client generated at ${apiClientOutputPath}`)
    process.exit(0)
  },
})

const openApiGenerateCommand = defineCommand({
  meta: {
    name: 'openapi:generate',
    description: 'Generate an OpenAPI 3.1 document using the optional @guren/openapi plugin.',
  },
  args: {
    routes: {
      type: 'string',
      description: 'Path to the route registration file',
      default: 'routes/web.ts',
    },
    app: {
      type: 'string',
      description: 'Application root directory',
      default: process.cwd(),
    },
    out: {
      type: 'string',
      description: 'Path to the generated OpenAPI document',
      default: '.guren/openapi.gen.json',
    },
    title: {
      type: 'string',
      description: 'OpenAPI document title. Defaults to package.json name or "Guren API".',
    },
    version: {
      type: 'string',
      description: 'OpenAPI document version. Defaults to package.json version or 1.0.0.',
    },
    description: {
      type: 'string',
      description: 'OpenAPI document description. Defaults to package.json description.',
    },
    server: {
      type: 'string',
      description: 'Server URL to include in the generated OpenAPI document.',
    },
    force: {
      type: 'boolean',
      description: 'Overwrite existing files',
      alias: 'f',
    },
  },
  async run({ args }) {
    const { outputPath, warnings } = await generateOpenApiSpec({
      routesFile: args.routes,
      appRoot: args.app,
      outputFile: args.out,
      title: args.title,
      version: args.version,
      description: args.description,
      server: args.server,
      force: Boolean(args.force),
    })

    consola.success(`OpenAPI document generated at ${outputPath}`)
    for (const warning of warnings) {
      consola.warn(warning)
    }
    process.exit(0)
  },
})

const rollbackCommand = defineCommand({
  meta: {
    name: 'db:rollback',
    description: 'Explain how to undo migrations (Guren uses forward-only drizzle-kit migrations).',
  },
  args: {
    json: {
      type: 'boolean',
      description: 'Output result as JSON',
    },
  },
  async run({ args }) {
    const message =
      'Guren migrations are generated by drizzle-kit and are forward-only — there are no down migrations to roll back.'
    const remedies = [
      'Development: `guren db:reset --seed` drops everything and re-applies all migrations from scratch.',
      'Undo an uncommitted migration: delete its folder under db/migrations/, then `guren db:reset`.',
      'Production: write a new forward migration that reverses the change (edit db/schema.ts, then `bun run db:make`).',
    ]

    if (args.json) {
      console.log(JSON.stringify({ command: 'db:rollback', status: 'unsupported', message, remedies }, null, 2))
    } else {
      consola.error(message)
      consola.info('Instead:')
      for (const remedy of remedies) {
        consola.info(`  • ${remedy}`)
      }
    }
    process.exit(1)
  },
})

const statusCommand = defineCommand({
  meta: {
    name: 'db:status',
    description: 'Show the status of all migrations.',
  },
  args: {
    json: {
      type: 'boolean',
      description: 'Output as JSON',
    },
  },
  async run({ args }) {
    await showMigrationStatus({ json: Boolean(args.json) })
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
    json: {
      type: 'boolean',
      description: 'Output as JSON',
    },
  },
  async run({ args }) {
    await listFailedJobs(args.queue, { json: Boolean(args.json) })
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
    force: {
      type: 'boolean',
      description: 'Run in production without confirmation',
      alias: 'f',
    },
  },
  async run({ args }) {
    if (!ensureDestructiveCommandAllowed(args.force)) {
      return
    }

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
    force: {
      type: 'boolean',
      description: 'Run in production without confirmation',
      alias: 'f',
    },
    dryRun: {
      type: 'boolean',
      alias: 'd',
      description: 'Show what would happen without executing',
    },
  },
  async run({ args }) {
    if (!ensureDestructiveCommandAllowed(args.force)) {
      return
    }

    if (args.dryRun) {
      const queueFilter = args.queue ? ` on queue "${args.queue}"` : ''
      consola.info(`[dry-run] Would delete all failed jobs${queueFilter}.`)
      return
    }

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
    json: {
      type: 'boolean',
      description: 'Output as JSON',
    },
  },
  async run({ args }) {
    showConfigCacheInfo({
      cacheDir: args.cache,
      appRoot: args.app,
      json: Boolean(args.json),
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
      description: 'Overwrite existing link',
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
    json: {
      type: 'boolean',
      description: 'Output as JSON',
    },
  },
  async run({ args }) {
    await listScheduledTasks({
      kernel: args.kernel,
      appRoot: args.app,
      json: Boolean(args.json),
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
      description: 'Run tasks regardless of schedule',
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
    json: {
      type: 'boolean',
      description: 'Output as JSON',
    },
  },
  async run({ args }) {
    const locales = listLocales({
      path: args.path,
      appRoot: args.app,
    })

    if (args.json) {
      consola.log(JSON.stringify(locales, null, 2))
      return
    }

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

const doctorCommand = defineCommand({
  meta: {
    name: 'doctor',
    description: 'Inspect the current workspace for vNext runtime, codegen, and bootstrap issues.',
  },
  args: {
    json: {
      type: 'boolean',
      description: 'Output the doctor report as JSON.',
    },
    strict: {
      type: 'boolean',
      description: 'Exit with code 1 when warnings or failures are reported.',
    },
    next: {
      type: 'boolean',
      description: 'Show actionable next steps for the project.',
    },
  },
  async run({ args }) {
    const report = await runDoctor({
      json: Boolean(args.json),
      next: Boolean(args.next),
    })

    if (args.json) {
      consola.log(JSON.stringify(report, null, 2))
    }

    if (args.strict && (report.hasWarnings || report.hasFailures)) {
      process.exit(1)
    }
  },
})

const keyGenerateCommand = defineCommand({
  meta: {
    name: 'key:generate',
    description: 'Generate a canonical APP_KEY value.',
  },
  args: {
    write: {
      type: 'boolean',
      description: 'Write the generated APP_KEY to .env in the current workspace.',
    },
  },
  async run({ args }) {
    const key = generateKeyValue()

    if (args.write) {
      await writeKeyToEnv(process.cwd(), key)
      consola.success('APP_KEY written to .env')
      return
    }

    consola.log(key)
  },
})

// --- AI Agent Commands ---

const modelListCommand = defineCommand({
  meta: {
    name: 'model:list',
    description: 'List all models with relationships and metadata.',
  },
  args: {
    format: {
      type: 'string',
      description: 'Output format: table, json, or compact.',
      default: 'table',
    },
    app: {
      type: 'string',
      description: 'Application root directory.',
    },
  },
  async run({ args }) {
    await displayModels({
      appRoot: args.app,
      format: args.format as 'table' | 'json' | 'compact',
    })
  },
})

const contextCommand = defineCommand({
  meta: {
    name: 'context',
    description: 'Generate a project context map for AI agents. Pass an entity name (e.g. `guren context User`) for an entity-centric bundle.',
  },
  args: {
    entity: {
      type: 'positional',
      required: false,
      description: 'Model class name for an entity-centric context bundle (case-insensitive).',
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON.',
    },
    routes: {
      type: 'string',
      description: 'Path to routes entry file.',
    },
    app: {
      type: 'string',
      description: 'Application root directory.',
    },
    module: {
      type: 'string',
      description: 'Module name to disambiguate same-named models; "app" selects the application root (entity mode only).',
    },
  },
  async run({ args }) {
    if (args.entity) {
      await displayEntityContext(args.entity, {
        cwd: args.app,
        json: Boolean(args.json),
        routesFile: args.routes,
        module: args.module,
      })
      return
    }

    await displayContext({
      cwd: args.app,
      json: Boolean(args.json),
      routesFile: args.routes,
    })
  },
})

const checkCommand = defineCommand({
  meta: {
    name: 'check',
    description: 'Validate integrity across routes, controllers, pages, and models.',
  },
  args: {
    json: {
      type: 'boolean',
      description: 'Output as JSON.',
    },
    routes: {
      type: 'string',
      description: 'Path to routes entry file.',
    },
    app: {
      type: 'string',
      description: 'Application root directory.',
    },
    arch: {
      type: 'boolean',
      description: 'Run only architecture boundary checks (guren.arch.ts). Fast path for edit hooks.',
    },
    docs: {
      type: 'boolean',
      description: 'Run only doc-link checks (docs/ frontmatter + @docs tags).',
    },
    spec: {
      type: 'boolean',
      description: 'Run only spec drift checks (docs/spec/ vs regenerated views).',
    },
    'docs-ttl': {
      type: 'string',
      description: 'Warn when a doc\'s last_reviewed is older than N days.',
    },
    changed: {
      type: 'boolean',
      description: 'Restrict file-scanning checks to files changed vs. the merge base with main.',
    },
  },
  async run({ args }) {
    const report = await runCheck({
      cwd: args.app,
      json: Boolean(args.json),
      routesFile: args.routes,
      arch: Boolean(args.arch),
      docs: Boolean(args.docs),
      docsTtlDays: args['docs-ttl'] ? Number(args['docs-ttl']) : undefined,
      spec: Boolean(args.spec),
      changed: Boolean(args.changed),
    })

    if (args.json) {
      console.log(JSON.stringify(report, null, 2))
    } else {
      renderCheckReport(report)
    }

    // Only the suite flags (`--arch`/`--docs`/`--spec`) gate on exit code.
    // Plain `guren check` has never set one (it's a v1.0-stable command;
    // changing that default is a breaking change reserved for a major
    // release). The fast-path flags are new, with no prior contract to
    // preserve, so they can gate CI from day one — that's the intended way
    // to enforce boundaries, doc links, and spec freshness in CI.
    if ((args.arch || args.docs || args.spec) && report.failCount > 0) {
      process.exitCode = 1
    }
  },
})

const auditCommand = defineCommand({
  meta: {
    name: 'audit',
    description: 'Run a security audit: validation, authentication, raw SQL, secrets, mass assignment.',
  },
  args: {
    json: {
      type: 'boolean',
      description: 'Output as JSON.',
    },
    routes: {
      type: 'string',
      description: 'Path to routes entry file.',
    },
    app: {
      type: 'string',
      description: 'Application root directory.',
    },
    auditConfig: {
      type: 'string',
      description: 'Path to the ignore config (defaults to config/audit.{ts,js,mjs}).',
    },
  },
  async run({ args }) {
    const report = await runAudit({
      cwd: args.app,
      routesFile: args.routes,
      auditConfigFile: args.auditConfig,
    })

    if (args.json) {
      console.log(JSON.stringify(report, null, 2))
    } else {
      renderAuditReport(report)
    }

    if (report.failCount > 0) {
      process.exitCode = 1
    }
  },
})

const guidelinesCommand = defineCommand({
  meta: {
    name: 'guidelines',
    description: 'Auto-generate project-specific coding guidelines.',
  },
  args: {
    output: {
      type: 'string',
      alias: 'o',
      description: 'Write guidelines to file path (e.g., .claude/rules/project-guidelines.md).',
    },
    app: {
      type: 'string',
      description: 'Application root directory.',
    },
  },
  async run({ args }) {
    const output = await generateGuidelines({
      cwd: args.app,
      output: args.output,
    })

    if (!args.output) {
      console.log(output)
    }
  },
})

function reportAgentHarnessResult(result: AgentHarnessResult): void {
  for (const file of result.written) {
    consola.success(`Wrote ${file}`)
  }
  if (result.skipped.length > 0) {
    consola.info(`Skipped ${result.skipped.length} existing file(s): ${result.skipped.join(', ')}`)
  }
  if (result.mcpEndpointNotEnabled) {
    consola.info(
      '.mcp.json points at the dev server MCP endpoint, which is opt-in. ' +
      'Add `GUREN_MCP=1` to your `dev` script, or start the server with `GUREN_MCP=1 bun run dev`.',
    )
  }
}

const agentInitCommand = defineCommand({
  meta: {
    name: 'agent:init',
    description: 'Install the AI agent harness (CLAUDE.md, .claude/ rules, skills, hooks, .mcp.json).',
  },
  args: {
    force: {
      type: 'boolean',
      alias: 'f',
      description: 'Overwrite existing files, including CLAUDE.md and .claude/settings.json.',
    },
    app: {
      type: 'string',
      description: 'Application root directory.',
    },
  },
  async run({ args }) {
    const result = await installAgentHarness({
      cwd: args.app,
      mode: 'init',
      force: Boolean(args.force),
    })
    reportAgentHarnessResult(result)
    consola.success('AI agent harness is ready. Update it later with `bunx guren agent:sync`.')
  },
})

const agentSyncCommand = defineCommand({
  meta: {
    name: 'agent:sync',
    description: 'Update framework-managed agent harness files (.claude/ rules, skills, agents, hooks).',
  },
  args: {
    app: {
      type: 'string',
      description: 'Application root directory.',
    },
  },
  async run({ args }) {
    const result = await installAgentHarness({
      cwd: args.app,
      mode: 'sync',
    })
    reportAgentHarnessResult(result)
    consola.success('Agent harness synced to the latest framework version.')
  },
})

const makeFeatureCommand = defineCommand({
  meta: {
    name: 'make:feature',
    description: 'Scaffold a complete CRUD feature with all components.',
  },
  args: {
    name: {
      type: 'positional',
      required: true,
      description: 'Feature name (singular, e.g., Product).',
    },
    fields: {
      type: 'string',
      alias: 'F',
      description: 'Field definitions (name:type,...). e.g., title:string,body:text,published:boolean',
    },
    force: {
      type: 'boolean',
      alias: 'f',
      description: 'Overwrite existing files.',
    },
    test: {
      type: 'boolean',
      description: 'Also generate a test file.',
    },
    public: {
      type: 'boolean',
      description: 'Skip authentication checks in mutating actions (default: auth required).',
    },
    policy: {
      type: 'boolean',
      description: 'Also generate an authorization policy and enforce it in store/update/destroy.',
    },
    module: MODULE_ARG,
  },
  async run({ args }) {
    await makeFeature(args.name as string, {
      fields: args.fields,
      force: Boolean(args.force),
      root: args.module,
      withTest: Boolean(args.test),
      publicAccess: Boolean(args.public),
      withPolicy: Boolean(args.policy),
    })
  },
})

const newCommand = defineCommand({
  meta: {
    name: 'new',
    description: 'Scaffold a new Guren application via create-guren-app.',
  },
  args: {
    target: {
      type: 'positional',
      description: 'Directory to create the application in',
      default: '.',
    },
    force: {
      type: 'boolean',
      alias: 'f',
      description: 'Overwrite existing files in the target directory',
    },
    mode: {
      type: 'string',
      description: 'Rendering mode to scaffold (spa or ssr)',
    },
    auth: {
      type: 'boolean',
      description: 'Include authentication scaffolding',
    },
    blueprint: {
      type: 'string',
      description: 'Application blueprint to scaffold (default or blog).',
    },
  },
  async run({ args }) {
    const commandArgs = ['x', 'create-guren-app']

    if (args.target) {
      commandArgs.push(String(args.target))
    }

    if (args.force) {
      commandArgs.push('--force')
    }

    if (args.mode) {
      commandArgs.push('--mode', String(args.mode))
    }

    if (args.auth) {
      commandArgs.push('--auth')
    }

    if (args.blueprint) {
      commandArgs.push('--blueprint', String(args.blueprint))
    }

    await runBunCommand(commandArgs)
  },
})

const addAuthCommand = defineCommand({
  meta: {
    name: 'auth',
    description: 'Add authentication scaffolding to the current application.',
  },
  args: {
    force: {
      type: 'boolean',
      description: 'Overwrite existing files',
      alias: 'f',
    },
  },
  async run({ args }) {
    const files = await runBlueprint('auth', {
      force: Boolean(args.force),
    })

    for (const file of files) {
      consola.success(`Created ${file}`)
    }
  },
})

const addResourceCommand = defineCommand({
  meta: {
    name: 'resource',
    description: 'Scaffold a model, controller, view, and route group for a resource.',
  },
  args: {
    name: {
      type: 'positional',
      required: true,
      description: 'Resource name (singular)',
    },
    fields: {
      type: 'string',
      description: 'Comma-separated fields, e.g. "title:string,body:text,published:boolean" (append ? for nullable)',
    },
    public: {
      type: 'boolean',
      description: 'Skip authentication checks in store/update/destroy actions',
    },
    force: {
      type: 'boolean',
      description: 'Overwrite existing files',
      alias: 'f',
    },
  },
  async run({ args }) {
    const createdFiles = await runBlueprint('resource', {
      name: String(args.name),
      fields: typeof args.fields === 'string' ? args.fields : undefined,
      publicAccess: Boolean(args.public),
      force: Boolean(args.force),
    })

    for (const file of createdFiles) {
      consola.success(`Created ${file}`)
    }

    consola.info('')
    consola.info('Schema and routes were updated automatically. Next steps:')
    consola.info('  • Run `bun run db:make` to generate the migration')
    consola.info('  • Run `bun run db:migrate` to apply it')
    consola.info('  • Run `bun run codegen` (or `bun run dev`) to refresh generated types')
    if (!args.public) {
      consola.info('  • store/update/destroy require a signed-in user — pass --public to opt out')
    }
  },
})

function createAddBlueprintCommand(
  blueprint: string,
  description: string,
  needsName = false,
) {
  return defineCommand({
    meta: {
      name: blueprint,
      description,
    },
    args: {
      ...(needsName
        ? {
            name: {
              type: 'positional' as const,
              required: true,
              description: 'Blueprint argument',
            },
          }
        : {}),
      force: {
        type: 'boolean' as const,
        description: 'Overwrite existing files',
        alias: 'f',
      },
    },
    async run({ args }) {
      const createdFiles = await runBlueprint(blueprint, {
        name: typeof args.name === 'string' ? args.name : undefined,
        force: Boolean(args.force),
      })

      for (const file of createdFiles) {
        consola.success(`Created ${file}`)
      }
    },
  })
}

const addPluginCommand = defineCommand({
  meta: {
    name: 'plugin',
    description: 'Install a plugin package and register its provider in src/app.ts.',
  },
  args: {
    package: {
      type: 'positional',
      required: true,
      description: 'Plugin package name (for example: @acme/guren-plugin-foo)',
    },
    force: {
      type: 'boolean',
      description: 'Overwrite existing plugin registration and published files',
      alias: 'f',
    },
    install: {
      type: 'boolean',
      default: true,
      description: 'Install the package with bun add when missing (--no-install to skip)',
    },
    'ignore-compatibility': {
      type: 'boolean',
      description: 'Register the plugin even when it declares an incompatible Guren version range',
    },
  },
  async run({ args }) {
    const result = await installPlugin({
      packageName: String(args.package),
      force: Boolean(args.force),
      install: args.install !== false,
      ignoreCompatibility: Boolean(args['ignore-compatibility']),
    })

    for (const message of result) {
      switch (message.kind) {
        case 'installed':
          consola.success(`Installed ${message.text}`)
          break
        case 'updated':
          consola.success(`Updated ${message.text}`)
          break
        case 'checked':
          consola.info(`Checked ${message.text}`)
          break
        case 'skipped':
          consola.info(`Skipped ${message.text}`)
          break
        case 'warning':
          consola.warn(message.text)
          break
        case 'hint':
          consola.info(message.text)
          break
      }
    }
  },
})

const addCommand = defineCommand({
  meta: {
    name: 'add',
    description: 'Apply higher-level framework scaffolds to the current application.',
  },
  args: {
    help: {
      type: 'boolean',
      alias: 'h',
      description: 'Show available blueprints.',
    },
  },
  subCommands: {
    admin: createAddBlueprintCommand('admin', 'Install a starter admin dashboard scaffold with routes and page.'),
    auth: addAuthCommand,
    oauth: createAddBlueprintCommand('oauth', 'Install OAuth scaffolding with provider presets and callback routes.'),
    broadcasting: createAddBlueprintCommand('broadcasting', 'Install broadcasting scaffolding with sample public and private channels.'),
    cache: createAddBlueprintCommand('cache', 'Install cache scaffolding and an example cache service.'),
    events: createAddBlueprintCommand('events', 'Install event scaffolding with a sample event and listener.'),
    mail: createAddBlueprintCommand('mail', 'Install mail scaffolding with a sample mailable.'),
    notifications: createAddBlueprintCommand('notifications', 'Install notification scaffolding with sample channels and a sample notification.'),
    queue: createAddBlueprintCommand('queue', 'Install queue scaffolding with a sample job.'),
    resource: addResourceCommand,
    plugin: addPluginCommand,
    schedule: createAddBlueprintCommand('schedule', 'Install a schedule kernel with a sample recurring task.'),
    storage: createAddBlueprintCommand('storage', 'Install storage scaffolding with local/public disks and a sample storage service.'),
  },
  async run(ctx) {
    if (ctx.args.help || ctx.rawArgs.length === 0) {
      consola.info(`Available blueprints: ${listBlueprints().join(', ')}, plugin`)
      await showUsage(ctx.cmd)
    }
  },
})

const upgradeCommand = defineCommand({
  meta: {
    name: 'upgrade',
    description: 'Upgrade Guren dependencies in the current application.',
  },
  args: {
    canary: {
      type: 'boolean',
      description: 'Pin @guren/* dependencies to the canary release tag.',
    },
    tag: {
      type: 'string',
      description: `npm dist-tag to upgrade to (default: ${DEFAULT_UPGRADE_TAG}). All @guren/* packages are aligned to it.`,
    },
    install: {
      type: 'boolean',
      description: 'Run bun install after package.json is updated.',
    },
    dryRun: {
      type: 'boolean',
      description: 'Print the dependency changes without modifying package.json.',
    },
    json: {
      type: 'boolean',
      description: 'Print the upgrade report as JSON.',
    },
    noAutofix: {
      type: 'boolean',
      description: 'Only report fixable issues without applying automatic fixes.',
    },
    checkOnly: {
      type: 'boolean',
      description: 'Run compatibility and deprecation checks without modifying anything.',
    },
  },
  async run({ args }) {
    const tag = args.canary ? 'canary' : typeof args.tag === 'string' && args.tag ? args.tag : DEFAULT_UPGRADE_TAG

    const result = await upgradeCanary({
      install: Boolean(args.install),
      dryRun: Boolean(args.dryRun),
      noAutofix: Boolean(args.noAutofix),
      checkOnly: Boolean(args.checkOnly),
      tag,
    })

    if (args.json) {
      console.log(JSON.stringify(result, null, 2))
      return
    }

    // Version compatibility
    if (result.versionCompatibility) {
      const vc = result.versionCompatibility
      if (vc.warnings.length > 0) {
        consola.box(vc.downgrade ? 'Downgrade' : 'Version compatibility')
        for (const warning of vc.warnings) {
          consola.warn(warning)
        }
      } else {
        consola.success(`Version compatible (${vc.currentVersion} -> ${vc.targetVersion})`)
      }
    }

    // Deprecation warnings
    if (result.deprecationWarnings.length > 0) {
      consola.box('Deprecation warnings')
      for (const dep of result.deprecationWarnings) {
        consola.warn(`${dep.what} (deprecated since ${dep.since}, removed in ${dep.removedIn})`)
        consola.info(`  Replacement: ${dep.replacement}`)
        consola.info(`  Affected files: ${dep.affectedFiles.join(', ')}`)
      }
    }

    // Codemod results
    if (result.codemodResults.length > 0) {
      consola.box(args.dryRun ? 'Codemod preview' : 'Codemods')
      for (const codemod of result.codemodResults) {
        const prefix = codemod.status === 'applied' ? '[applied]' : codemod.status === 'pending' ? '[pending]' : '[skipped]'
        consola.info(`${prefix} ${codemod.description} (${codemod.filesAffected} files)`)
      }
    }

    if (args.checkOnly) {
      consola.info('Check-only mode. No files were modified.')
      return
    }

    if (result.updatedDependencies.length === 0) {
      consola.info('No Guren dependencies needed updating.')
    } else {
      consola.box('Dependency changes')
      for (const dependency of result.updatedDependencies) {
        consola.success(`${dependency.field}: ${dependency.name} ${dependency.previousVersion} -> ${dependency.nextVersion}`)
      }
    }

    if (result.autofixes.length > 0) {
      consola.box(args.dryRun ? 'Autofix preview' : 'Autofixes applied')
      for (const autofix of result.autofixes) {
        const prefix = autofix.applied ? '[applied]' : '[preview]'
        consola.info(`${prefix} ${autofix.title}: ${autofix.summary}`)
      }
    }

    if (result.warnings.length > 0) {
      consola.box('Warnings')
      for (const warning of result.warnings) {
        consola.warn(`${warning.title}: ${warning.message}`)
      }
    }

    if (result.manualSteps.length > 0) {
      consola.box('Manual steps')
      for (const step of result.manualSteps) {
        consola.info(step)
      }
    }

    if (result.recommendedCommands.length > 0) {
      consola.box('Next commands')
      for (const command of result.recommendedCommands) {
        consola.info(command)
      }
    }

    if (args.dryRun) {
      consola.info('Dry run complete. Files were not modified.')
    } else if (result.updatedDependencies.length > 0 || result.autofixes.some((autofix) => autofix.applied)) {
      consola.info(`Updated ${result.packageJsonPath}`)
    }
  },
})

const deployCommand = defineCommand({
  meta: {
    name: 'deploy',
    description: 'Generate deployment recipes for Docker, Fly.io, or Railway.',
  },
  args: {
    target: {
      type: 'string',
      description: 'Deployment target (docker, fly, railway, all)',
      default: 'docker',
    },
    app: {
      type: 'string',
      description: 'Application name used in generated config (e.g. fly.toml app name)',
    },
    port: {
      type: 'string',
      description: 'Application port for generated deployment files (default: 3333)',
    },
    force: {
      type: 'boolean',
      description: 'Overwrite existing deployment files',
      alias: 'f',
    },
  },
  async run({ args }) {
    const rawTarget = String(args.target ?? 'docker')
    const allowedTargets = new Set<DeployTarget>(['docker', 'fly', 'railway', 'all'])
    if (!allowedTargets.has(rawTarget as DeployTarget)) {
      throw new Error(`Invalid deploy target "${rawTarget}". Expected one of: docker, fly, railway, all. For Vercel, use \`bunx guren plugin @guren/plugin-vercel\`.`)
    }

    const port = args.port === undefined ? undefined : Number(args.port)
    if (args.port !== undefined && !Number.isInteger(port)) {
      throw new Error('The --port option must be an integer.')
    }

    const createdFiles = await scaffoldDeploy({
      target: rawTarget as DeployTarget,
      appName: args.app ? String(args.app) : undefined,
      port,
      force: Boolean(args.force),
    })

    for (const file of createdFiles) {
      consola.success(`Created ${file}`)
    }
  },
})

const builtinSubCommands = {
  ...makeCommands,
  'make:adr': makeAdrCommand,
  'spec:generate': specGenerateCommand,
  'make:auth': makeAuthCommand,
  'make:module': makeModuleCommand,
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
  codegen: codegenCommand,
  'route:list': routeListCommand,
  'openapi:generate': openApiGenerateCommand,
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
  add: addCommand,
  plugin: addPluginCommand,
  doctor: doctorCommand,
  'key:generate': keyGenerateCommand,
  new: newCommand,
  upgrade: upgradeCommand,
  deploy: deployCommand,
  console: consoleCommand,
  dev: devCommand,
  // AI Agent commands
  'model:list': modelListCommand,
  context: contextCommand,
  check: checkCommand,
  audit: auditCommand,
  guidelines: guidelinesCommand,
  'make:feature': makeFeatureCommand,
  'agent:init': agentInitCommand,
  'agent:sync': agentSyncCommand,
}

// CLI commands declared by installed plugins (gurenPlugin.commands).
// Discovery only reads package.json files; a plugin's entry module is
// imported lazily when one of its commands is invoked (or renders its own
// usage), never for the root --help listing.
const pluginSubCommands: Record<string, CommandDef> = {}
try {
  const discovered = await discoverPluginCommands(
    process.cwd(),
    new Set(Object.keys(builtinSubCommands)),
  )
  for (const command of discovered) {
    pluginSubCommands[command.name] = createPluginCommandProxy(command)
  }
} catch (error) {
  consola.warn(`Failed to discover plugin commands: ${error instanceof Error ? error.message : String(error)}`)
}

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
  // Null-prototype so a name like `valueOf` or `constructor` can never
  // resolve to an inherited Object member. citty's own dispatch indexes this
  // map unguarded and would otherwise invoke the inherited value as a command.
  subCommands: Object.assign(Object.create(null), builtinSubCommands, pluginSubCommands),
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

const exitCode = await runCli(main, process.argv.slice(2))
if (exitCode !== 0) {
  process.exit(exitCode)
}
