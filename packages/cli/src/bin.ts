#!/usr/bin/env bun
import { pathToFileURL } from 'node:url'
import { consola } from 'consola'
import { defineCommand, runMain, showUsage } from 'citty'
import { makeAuth } from './make-auth'
import { makeController } from './make-controller'
import { makeMigration } from './make-migration'
import { makeModel } from './make-model'
import { makeRoute } from './make-route'
import { makeTest, type TestRunner } from './make-test'
import { makeView } from './make-view'
import { runDatabaseMigrations, runDatabaseSeeders } from './db-migrate'
import type { WriterOptions } from './utils'
import { generateRouteTypes } from './routes-types'
import { consoleCommand } from './console'
import { bootstrapApplication, resolveMainEntry, type MaybeApplication } from './runtime'

type ForceableArgs = { force?: boolean }

function toWriterOptions(args: ForceableArgs): WriterOptions {
  return {
    force: Boolean(args.force),
  }
}

const makeControllerCommand = defineCommand({
  meta: {
    name: 'make:controller',
    description: 'Generate a new controller file.',
  },
  args: {
    name: {
      type: 'positional',
      required: true,
      description: 'Controller class name',
    },
    force: {
      type: 'boolean',
      description: 'Overwrite existing files',
      alias: 'f',
    },
  },
  async run({ args }) {
    const file = await makeController(args.name, toWriterOptions(args))
    consola.success(`Controller created at ${file}`)
  },
})

const makeModelCommand = defineCommand({
  meta: {
    name: 'make:model',
    description: 'Generate a new model file.',
  },
  args: {
    name: {
      type: 'positional',
      required: true,
      description: 'Model class name',
    },
    force: {
      type: 'boolean',
      description: 'Overwrite existing files',
      alias: 'f',
    },
  },
  async run({ args }) {
    const file = await makeModel(args.name, toWriterOptions(args))
    consola.success(`Model created at ${file}`)
  },
})

const makeViewCommand = defineCommand({
  meta: {
    name: 'make:view',
    description: 'Generate a new view component.',
  },
  args: {
    name: {
      type: 'positional',
      required: true,
      description: 'View component path',
    },
    force: {
      type: 'boolean',
      description: 'Overwrite existing files',
      alias: 'f',
    },
  },
  async run({ args }) {
    const file = await makeView(args.name, toWriterOptions(args))
    consola.success(`View created at ${file}`)
  },
})

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
  },
  async run({ args }) {
    const files = await makeAuth(toWriterOptions(args))
    for (const file of files) {
      consola.success(`Created ${file}`)
    }
  },
})

const makeRouteCommand = defineCommand({
  meta: {
    name: 'make:route',
    description: 'Generate a new route group.',
  },
  args: {
    name: {
      type: 'positional',
      required: true,
      description: 'Route group name',
    },
    force: {
      type: 'boolean',
      description: 'Overwrite existing files',
      alias: 'f',
    },
  },
  async run({ args }) {
    const file = await makeRoute(args.name, toWriterOptions(args))
    consola.success(`Route created at ${file}`)
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
    'make:auth': makeAuthCommand,
    'make:controller': makeControllerCommand,
    'make:migration': makeMigrationCommand,
    'make:model': makeModelCommand,
    'make:view': makeViewCommand,
    'make:route': makeRouteCommand,
    'make:test': makeTestCommand,
    'db:migrate': migrateCommand,
    'db:seed': seedCommand,
    'routes:types': routeTypesCommand,
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
