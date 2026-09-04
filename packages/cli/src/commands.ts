/**
 * The Guren CLI's builtin command registry, importable without running the CLI —
 * the agent-catalog audit reads it to assert a skill only names commands and
 * flags the CLI actually registers (RFC 0011 §2). `bin.ts` imports this and adds
 * the per-invocation, cwd-dependent parts.
 *
 * Nothing here runs at import beyond building the command objects. Keep it that
 * way: a top-level `await` or `process.*` read would run for every importer.
 */
import { readFileSync } from 'node:fs'
import { relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { consola } from 'consola'
import { showUsage } from 'citty'
import type { CommandDef } from 'citty'
import { defineCommand } from './define-command'
import { runCli, UsageError } from './run-cli'
import { newCommand } from './new-command'
import { listBlueprints, runBlueprint } from './blueprints'
import { runDoctor } from './doctor'
import { makeAuth } from './make-auth'
import { makeChannel } from './make-channel'
import { makeCommand, registerScaffoldedCommand } from './make-command'
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
import { buildDocsGraphReport, renderDocsGraphMarkdown } from './docs-graph'
import { makeResource } from './make-resource'
import { makeRoute } from './make-route'
import { makeSeeder } from './make-seeder'
import { makeValidator } from './make-validator'
import { makeTest, type TestRunner } from './make-test'
import { makeView } from './make-view'
import { runDatabaseMigrations, runDatabaseSeeders, resetDatabase } from './db-migrate'
import type { MigrationRunSummary, SeederRunSummary } from './db-migrate'
import { showMigrationStatus } from './db-status'
import type { WriterOptions } from './utils'
import { generateRouteTypes } from './routes-types'
import { describePageManifestSuppression, generatePageTypes, type PageManifestPlan } from './pages-types'
import { generateTranslationTypes } from './i18n-types'
import { generateDataTypes } from './data-types'
import { generateAttachmentTypes } from './attachments-types'
import { generateApiClientTypes } from './api-client-types'
import { generateAgentTypes } from './agents-types'
import { generateOpenApiSpec } from './openapi-generate'
import { generateChannelTypes } from './channel-types'
import { consoleCommand } from './console'
import { bootstrapApplication, resolveMainEntry, type MaybeApplication } from './runtime'
import { runQueueWorker, listFailedJobs, retryFailedJob, retryAllFailedJobs, flushFailedJobs } from './queue'
import { displayRoutes } from './route-list'
import { displayToolInspection, displayTools } from './tool-list'
import { runToolCall } from './tool-call'
import { runToolLog } from './tool-log'
import { runTokenIssue } from './token-issue'
import { runToolDev } from './tool-dev'
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
import { AGENT_TARGETS, parseTargetList, type AgentTarget } from './agent-targets'
import { makeFeature } from './make-feature'
import { parseFieldsString } from './fields'
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

// One definition for every command that takes `--fields`, matching the single
// parser (`parseFieldsString`); three hand-written copies had already drifted.
const FIELDS_ARG = {
  type: 'string' as const,
  alias: 'F',
  description: 'Comma-separated fields, e.g. "title:string,body:text,published:boolean" (append ? for nullable).',
}

const ATTACH_ARG = {
  type: 'string' as const,
  description: 'Comma-separated attachment collections, e.g. "cover:one,images:many" (kind defaults to one). Requires the attachments layer — run `guren add attachments` first.',
}

function createMakeCommand(spec: MakeCommandSpec) {
  const { name: commandName, description, argDescription, makeFn, resourceName, nextStep } = spec
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
      if (nextStep) consola.info(nextStep)
    },
  })
}

type MakeCommandSpec = {
  name: string
  description: string
  argDescription: string
  makeFn: (name: string, options: WriterOptions) => Promise<string>
  resourceName: string
  /**
   * Printed after the success line, for a generator whose output does not work
   * until the user does something else. Only `make:route` needs one: everything
   * else here writes something the framework discovers.
   */
  nextStep?: string
}

const makeCommandSpecs: MakeCommandSpec[] = [
  { name: 'make:controller', description: 'Generate a new controller file.', argDescription: 'Controller class name', makeFn: makeController, resourceName: 'Controller' },
  { name: 'make:model', description: 'Generate a new model file.', argDescription: 'Model class name', makeFn: makeModel, resourceName: 'Model' },
  { name: 'make:view', description: 'Generate a new view component.', argDescription: 'View component path', makeFn: makeView, resourceName: 'View' },
  {
    name: 'make:route',
    description: 'Generate a new route group.',
    argDescription: 'Route group name',
    makeFn: makeRoute,
    resourceName: 'Route',
    // "your route registrar" rather than `routes/web.ts`: `--module` sends this
    // file to `modules/<name>/routes/`, mounted by the module's own `routes.ts`.
    nextStep:
      'Nothing mounts it yet (guren check reports this) — import its registerRoutes from your route '
      + "registrar and call it, passing that registrar's router.",
  },
  { name: 'make:job', description: 'Generate a new job class.', argDescription: 'Job class name', makeFn: makeJob, resourceName: 'Job' },
  { name: 'make:event', description: 'Generate a new event class.', argDescription: 'Event class name', makeFn: makeEvent, resourceName: 'Event' },
  { name: 'make:mail', description: 'Generate a new mailable class.', argDescription: 'Mail class name', makeFn: makeMail, resourceName: 'Mail' },
  { name: 'make:middleware', description: 'Generate a new middleware.', argDescription: 'Middleware name', makeFn: makeMiddleware, resourceName: 'Middleware' },
  { name: 'make:policy', description: 'Generate a new authorization policy.', argDescription: 'Policy class name', makeFn: makePolicy, resourceName: 'Policy' },
  { name: 'make:seeder', description: 'Generate a new database seeder.', argDescription: 'Seeder name', makeFn: makeSeeder, resourceName: 'Seeder' },
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

const docsGraphCommand = defineCommand({
  meta: {
    name: 'docs:graph',
    description:
      'Show the OKF docs relation graph: documents, entities, code paths, and verified edges. Narrow with --entity or --path to answer "what governs this?" before renaming or editing.',
  },
  args: {
    entity: {
      type: 'string',
      description: 'Narrow to the neighborhood of one model entity (case-insensitive).',
    },
    path: {
      type: 'string',
      description: 'Narrow to the neighborhood of one app-root-relative path.',
    },
    app: {
      type: 'string',
      description: 'Application root directory.',
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON.',
    },
  },
  async run({ args }) {
    const report = await buildDocsGraphReport({
      cwd: args.app,
      entity: args.entity,
      path: args.path,
    })
    console.log(args.json ? JSON.stringify(report, null, 2) : renderDocsGraphMarkdown(report))
  },
})

// Its own command rather than a makeCommandSpecs entry, for the extra flags.
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
    by: {
      type: 'string',
      description:
        'OKF actor for generated.by (human:<id>, process:<id>, or <producer>/<version>). Defaults to the git author.',
    },
    force: { type: 'boolean', description: 'Overwrite existing files', alias: 'f' },
    module: MODULE_ARG,
  },
  async run({ args }) {
    const file = await makeAdr(args.name, {
      ...toWriterOptions(args),
      entity: args.entity,
      by: args.by,
    })
    consola.success(`ADR created at ${file}`)
  },
})

// Its own command rather than a makeCommandSpecs entry, for the extra --fields.
const makeValidatorCommand = defineCommand({
  meta: {
    name: 'make:validator',
    description: 'Generate Zod validation schemas (route params, list query, payload) for an entity.',
  },
  args: {
    name: { type: 'positional', required: true, description: 'Entity or validator class name' },
    fields: FIELDS_ARG,
    force: { type: 'boolean', description: 'Overwrite existing files', alias: 'f' },
    module: MODULE_ARG,
  },
  async run({ args }) {
    // Parsed here so an omitted --fields means "empty payload schema" for this
    // command only (make:feature falls back to DEFAULT_FIELDS in fields.ts).
    const fields = args.fields ? parseFieldsString(args.fields) : undefined
    const file = await makeValidator(args.name, { ...toWriterOptions(args), fields })
    consola.success(`Validator created at ${file}`)
  },
})

const makeCommands = Object.fromEntries(
  makeCommandSpecs.map((spec) => [
    spec.name,
    createMakeCommand(spec),
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

/**
 * A path as the user would type it: cwd-relative when it is under cwd, verbatim
 * otherwise. `relative()` resolves a relative input against cwd itself, so a
 * config's './db/schema.ts' and an absolute folder both land here.
 */
function describePath(path: string): string {
  const relativePath = relative(process.cwd(), path)
  return relativePath === '' || relativePath.startsWith('..') ? path : relativePath
}

/** The migrations folder as the user would type it, or a stand-in when unknown. */
function describeMigrationsFolder(folder: string | undefined): string {
  return folder ? describePath(folder) : 'the migrations folder'
}

/** The seeders folder as the user would type it, or a stand-in when unknown. */
function describeSeedersFolder(folder: string | undefined): string {
  return folder ? describePath(folder) : 'the seeders folder'
}

function reportSuccess(action: string, message: string, json: boolean, extra?: Record<string, unknown>): void {
  if (json) {
    console.log(JSON.stringify({ success: true, action, message, ...extra }, null, 2))
  } else {
    consola.success(message)
  }
}

/** The two fields every db command reports about a migration run, or nothing when it has no summary. */
function migrationRunFields(summary: MigrationRunSummary | undefined): Record<string, unknown> | undefined {
  return summary && { migrationsFound: summary.migrationsFound, looseSqlFiles: summary.looseSqlFiles }
}

/**
 * Reports a migration run that applied nothing — `db:migrate`, `db:reset` and
 * `db:fresh` can all end on one, where a ✔ would read as an up-to-date database
 * (after a reset, as one that still has its tables).
 */
function reportNoMigrationsApplied(
  action: string,
  summary: MigrationRunSummary,
  outcome: string,
  json: boolean,
  extra?: Record<string, unknown>,
): void {
  const message = `No migrations found in ${describeMigrationsFolder(summary.migrationsFolder)} — ${outcome}.`

  if (json) {
    reportSuccess(action, message, true, { ...migrationRunFields(summary), ...extra })
    return
  }

  consola.warn(message)
  // A folder holding loose .sql files is not one waiting for db:make — the ORM
  // has already explained why they were skipped.
  if (summary.looseSqlFiles === 0) {
    consola.info(`Generate one with \`bun run db:make\`, then re-run \`bun run ${action}\`.`)
  }
}

/** The two fields every db command reports about a seed run, or nothing when it has no summary. */
function seederRunFields(summary: SeederRunSummary | undefined): Record<string, unknown> | undefined {
  return summary && { seedersRan: summary.seedersRan, filesWithoutSeeder: summary.filesWithoutSeeder }
}

/**
 * Reports a seed run that ran nothing. `db/seeders/` is scaffolded empty, so a ✔
 * would describe a database holding none of the rows the seeders would write.
 */
function reportNoSeedersRan(
  action: string,
  summary: SeederRunSummary,
  outcome: string,
  json: boolean,
  extra?: Record<string, unknown>,
): void {
  const message = `No seeders found in ${describeSeedersFolder(summary.seedersFolder)} — ${outcome}.`

  if (json) {
    reportSuccess(action, message, true, { ...seederRunFields(summary), ...extra })
    return
  }

  consola.warn(message)
  // Files that exported no seeder are not a folder waiting for make:seeder —
  // the seeders are written, just in a shape the loader skips.
  if (summary.filesWithoutSeeder === 0) {
    // Always db:seed, never the command that reported this: the migrations are
    // applied by now, so db:reset would drop every table again.
    consola.info('Generate one with `bunx guren make:seeder`, then run `bun run db:seed`.')
  } else {
    consola.info(
      `${summary.filesWithoutSeeder} file(s) there exported no seeder — each must default-export a handler, or export \`seed\`, \`run\`, or \`Seeder\`.`,
    )
  }
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
    const options = {
      force: Boolean(args.force),
      root: args.module,
      command: args.command,
    }
    const file = await makeCommand(args.name, options)
    consola.success(`Command created at ${file}`)
    await registerScaffoldedCommand(args.name, file, options)
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
    // A `string`, not a `positional`: declared positional, `--name x` leaves
    // `args` with neither a `name` key nor the value in `_`, and no
    // unknown-flag error, so drizzle-kit invents its own name. Both spellings
    // are documented, and a `string` arg still leaves the bare positional in
    // `_` for `run()` below.
    name: {
      type: 'string',
      description: 'Migration name, as `--name <name>` or a bare positional',
      valueHint: 'add_posts_table',
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
    dialect: {
      type: 'string',
      description: 'Database dialect, for apps with no drizzle config to declare one',
      valueHint: 'postgresql',
    },
  },
  async run({ args }) {
    // Any of these three drops drizzle-kit's `--config`, which it refuses
    // alongside other flags, so `makeMigration` reassembles the config's
    // dialect, schema and out onto the command line instead.
    const result = await makeMigration({
      name: args.name ?? args._[0],
      schema: args.schema,
      out: args.out,
      // `--dialect` reaches drizzle-kit verbatim, so a repeated flag would
      // arrive comma-joined as a dialect nothing accepts.
      dialect: args.dialect,
    })

    // Overrides drop `--config`, and `generate` has no flag for every field it
    // would have read, so name what was left behind.
    if (result.configUnreadable) {
      consola.warn(
        'Your drizzle config could not be loaded, so the schema and output paths fell back to ' +
          'their defaults — the migration may not describe the schema your config points at. ' +
          'Fix the config so it imports cleanly, or pass --schema/--out explicitly.',
      )
    }

    if (result.droppedConfigFields.length > 0) {
      consola.warn(
        `Your drizzle config sets ${result.droppedConfigFields.join(', ')}, which cannot be passed ` +
          'alongside --schema/--out/--dialect — drizzle-kit used its default instead. ' +
          'Drop the overrides to have the config applied in full.',
      )
    }

    // drizzle-kit exits 0 for "No schema changes, nothing to migrate." too, so
    // the ✔ below is reported off what it wrote, not off the exit code. An
    // unresolvable out dir leaves `migrationsFolder` unset.
    if (result.migrationsFolder && result.created.length === 0) {
      const schema = result.schemaPath ? describePath(result.schemaPath) : 'your schema'
      consola.warn(
        `No migration generated in ${describeMigrationsFolder(result.migrationsFolder)} — ` +
          `${schema} has no changes since the last one.`,
      )
      consola.info(`Edit \`${schema}\` to change your tables, then re-run \`bun run db:make\`.`)
      return
    }

    consola.success(
      result.created.length > 0 ? `Migration generated: ${result.created.join(', ')}.` : 'Migration generated.',
    )
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

    const summary = await runDatabaseMigrations()

    if (summary?.migrationsFound === 0) {
      reportNoMigrationsApplied('db:migrate', summary, 'nothing was applied', Boolean(args.json))
      return
    }

    reportSuccess('db:migrate', 'Database migrations completed.', Boolean(args.json), migrationRunFields(summary))
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

    const summary = await runDatabaseSeeders()

    if (summary?.seedersRan === 0) {
      reportNoSeedersRan('db:seed', summary, 'nothing was seeded', Boolean(args.json))
      return
    }

    reportSuccess('db:seed', 'Database seeders executed.', Boolean(args.json), seederRunFields(summary))
  },
})

/**
 * `db:reset` and `db:fresh` are the same command under two names, sharing one
 * body so the guard against reporting success for a reset that dropped every
 * table and re-applied nothing cannot come to hold for only one.
 */
async function runResetCommand(
  action: 'db:reset' | 'db:fresh',
  doneVerb: 'reset' | 'refreshed',
  args: { seed?: boolean; force?: boolean; json?: boolean; dryRun?: boolean },
): Promise<void> {
  if (!ensureDestructiveCommandAllowed(args.force)) {
    return
  }

  const seed = Boolean(args.seed)
  const json = Boolean(args.json)

  if (args.dryRun) {
    const message = seed
      ? 'Would drop all tables, re-run all migrations, and run seeders.'
      : 'Would drop all tables and re-run all migrations.'
    reportDryRun(action, message, json, { seed })
    return
  }

  consola.info('Dropping all tables...')
  const { migrations, seeders } = await resetDatabase({ seed })
  // Assembled once so every exit below reports the same run the same way.
  const runFields = { ...migrationRunFields(migrations), ...seederRunFields(seeders), seed }

  // The migration half wins when both came back empty: seeding an empty schema
  // could not have worked anyway, and stacking both warnings would bury it.
  if (migrations?.migrationsFound === 0) {
    reportNoMigrationsApplied(action, migrations, 'the tables were dropped and nothing was re-applied', json, runFields)
    return
  }

  if (seeders?.seedersRan === 0) {
    reportNoSeedersRan(action, seeders, `the database was ${doneVerb} but nothing was seeded`, json, runFields)
    return
  }

  const message = seed
    ? `Database ${doneVerb} and seeded successfully.`
    : `Database ${doneVerb} successfully.`
  reportSuccess(action, message, json, runFields)
}

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
    await runResetCommand('db:reset', 'reset', args)
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
    await runResetCommand('db:fresh', 'refreshed', args)
  },
})

/**
 * Says out loud that page components were found and deliberately not compiled
 * into a manifest: silently, a fullstack app misread as API-only would lose
 * `.guren/pages.gen.ts` with nothing on screen to explain it. `guren check` and
 * `guren doctor` report the same state for an unwatched run.
 */
function reportSuppressedPageManifest(plan: PageManifestPlan): void {
  const suppressed = describePageManifestSuppression(plan)
  if (!suppressed) return

  consola.warn(`${suppressed.message} ${suppressed.fix}`)
}

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
    const { outputPath: pagesOutputPath, plan: pagesPlan } = await generatePageTypes({
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
    if (pagesOutputPath) consola.success(`Page helpers generated at ${pagesOutputPath}`)
    reportSuppressedPageManifest(pagesPlan)
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
    // codegen's outputs are entirely generated artifacts, safe to overwrite by
    // default — including custom --out/--pages-out destinations. --force is
    // accepted for backward compatibility but is a no-op.
    const writerOptions: WriterOptions = { ...toWriterOptions(args), force: true }
    // These three read disjoint inputs (pages, lang/, app/Models) and write
    // disjoint artifacts, so they run concurrently.
    const [
      { outputPath: pagesOutputPath, plan: pagesPlan },
      { outputPath: translationsOutputPath, keyCount },
      { outputPath: attachmentsOutputPath, models: attachableModels, warnings: attachmentWarnings },
    ] = await Promise.all([
      generatePageTypes({
        appRoot: args.app,
        pagesDir: args.pages,
        outputFile: args.pagesOut,
        extractProps: true,
        ...writerOptions,
      }),
      generateTranslationTypes({ appRoot: args.app, ...writerOptions }),
      generateAttachmentTypes({ appRoot: args.app, ...writerOptions }),
    ])
    if (pagesOutputPath) consola.success(`Page helpers generated at ${pagesOutputPath}`)
    reportSuppressedPageManifest(pagesPlan)
    if (translationsOutputPath) {
      consola.success(`Translation keys generated at ${translationsOutputPath} (${keyCount} keys)`)
    }
    for (const warning of attachmentWarnings) {
      consola.warn(warning)
    }
    if (attachmentsOutputPath) {
      consola.success(
        `Attachment types generated at ${attachmentsOutputPath} (${attachableModels.length} ${attachableModels.length === 1 ? 'model' : 'models'})`,
      )
    }

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
    const {
      outputPath: dataOutputPath,
      definitions: resourceDefinitions,
      warnings: dataWarnings,
    } = await generateDataTypes({
      appRoot: args.app,
      ...writerOptions,
    })
    for (const warning of dataWarnings) {
      consola.warn(warning)
    }
    const { outputPath: channelOutputPath } = await generateChannelTypes({
      appRoot: args.app,
      ...writerOptions,
    })
    // Agent tools sit between data and the API client: they consume the Resource
    // definitions the data generator produced, and the `Data` import they emit
    // resolves against the sibling data.gen.ts.
    const {
      outputPath: agentsOutputPath,
      tools: agentTools,
      warnings: agentWarnings,
    } = await generateAgentTypes(definitions, {
      appRoot: args.app,
      resources: resourceDefinitions,
      ...writerOptions,
    })
    for (const warning of agentWarnings) {
      consola.warn(warning)
    }
    const { outputPath: apiClientOutputPath, warnings: apiClientWarnings } = await generateApiClientTypes(
      definitions,
      { appRoot: args.app, resources: resourceDefinitions, ...writerOptions },
    )
    for (const warning of apiClientWarnings) {
      consola.warn(warning)
    }
    consola.success(`Route types generated at ${outputPath}`)
    consola.success(`Route helpers generated at ${runtimeOutputPath}`)
    consola.success(`Data types generated at ${dataOutputPath}`)
    consola.success(`Channel types generated at ${channelOutputPath}`)
    if (agentsOutputPath) {
      consola.success(
        `Agent tools generated at ${agentsOutputPath} (${agentTools.length} ${agentTools.length === 1 ? 'tool' : 'tools'})`,
      )
    }
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
    // Left `positional`, unlike `context`'s entity arg: citty drops `--id 42`
    // entirely, but here that lands in the `else` below, which reports the
    // missing id and exits 1 — loud enough already.
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

// The `tool:` namespace is RFC 0016's; `agent:` is the coding-agent harness's.
// Both commands derive live from the route graph rather than reading
// `.guren/agents.gen.ts`, so a stale manifest cannot answer for what an agent
// would actually see.
const toolListCommand = defineCommand({
  meta: {
    name: 'tool:list',
    description: 'List the agent tools this application exposes (RFC 0016).',
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
    json: {
      type: 'boolean',
      description: 'Output the derived tools as JSON',
    },
  },
  async run({ args }) {
    await displayTools({ routesFile: args.routes, appRoot: args.app, json: args.json })
  },
})

const toolInspectCommand = defineCommand({
  meta: {
    name: 'tool:inspect',
    description: 'Show one agent tool as it is derived: input, output, authorization, annotations.',
  },
  args: {
    name: {
      type: 'positional',
      description: 'Tool name (defaults to the route name)',
      required: true,
    },
    routes: {
      type: 'string',
      description: 'Path to the routes entry file',
      valueHint: 'routes/web.ts',
    },
    app: {
      type: 'string',
      description: 'Application root directory',
    },
    json: {
      type: 'boolean',
      description: 'Output the derived tool as JSON',
    },
  },
  async run({ args }) {
    await displayToolInspection(args.name, {
      routesFile: args.routes,
      appRoot: args.app,
      json: args.json,
    })
  },
})

const toolCallCommand = defineCommand({
  meta: {
    name: 'tool:call',
    description: 'Invoke one agent tool against this application, the way an agent would (RFC 0016).',
  },
  args: {
    name: {
      type: 'positional',
      description: 'Tool name, as tool:list prints it',
      required: true,
    },
    input: {
      type: 'string',
      description: 'Tool arguments as a JSON object',
      valueHint: '{"title":"Hello"}',
    },
    as: {
      type: 'string',
      description:
        'Authenticate as a user (user:42). Development only: sets GUREN_TESTING=1 for this process, '
        + 'which makes the app accept an injected user instead of a real credential',
      valueHint: 'user:42',
    },
    preflight: {
      type: 'boolean',
      description: 'Ask for a verdict instead of an execution — the handler does not run',
    },
    // No `--routes`: this command dispatches into the booted application, so its
    // tools come from the graph that app actually serves — see `tool-call.ts`.
    app: {
      type: 'string',
      description: 'Application root directory',
    },
    json: {
      type: 'boolean',
      description: 'Output the call result as JSON',
    },
  },
  async run({ args }) {
    await runToolCall({
      name: args.name,
      // Repeat-safe readers: `--input a --input b` would otherwise arrive
      // comma-joined and not be JSON.
      input: args.input,
      as: args.as,
      preflight: Boolean(args.preflight),
      appRoot: args.app,
      json: Boolean(args.json),
    })
  },
})

// Reads the trail the MCP plugin's `audit` sink writes. Boots nothing: an audit
// trail has to be readable when the application it records is not startable.
const toolLogCommand = defineCommand({
  meta: {
    name: 'tool:log',
    description: 'Read this application\'s agent audit trail (RFC 0016).',
  },
  args: {
    file: {
      type: 'string',
      description: 'Base path of the audit trail; dated files sit beside it',
      valueHint: 'storage/logs/agent-audit.log',
    },
    tail: {
      type: 'boolean',
      alias: 'f',
      description: 'Follow the trail as records arrive, across the midnight rollover',
    },
    tool: {
      type: 'string',
      description: 'Only records for this tool',
      valueHint: 'posts.store',
    },
    surface: {
      type: 'string',
      description: 'Only records from this surface (mcp, dev-mcp, cli, webmcp)',
      valueHint: 'mcp',
    },
    denied: {
      type: 'boolean',
      description: 'Only denials',
    },
    since: {
      type: 'string',
      description: 'Only records newer than this duration ago',
      valueHint: '30m',
    },
    number: {
      type: 'string',
      alias: 'n',
      description: 'How many records to show (default 50)',
      valueHint: '50',
    },
    app: {
      type: 'string',
      description: 'Application root directory',
    },
    json: {
      type: 'boolean',
      description: 'Output one raw record per line, for piping',
    },
  },
  async run({ args }) {
    // Repeat-safe readers: `--denied=false --denied=false` would otherwise read
    // as *on* and hide every invocation from a listing that looks complete.
    const rawNumber = args.number
    await runToolLog({
      file: args.file,
      tail: Boolean(args.tail),
      tool: args.tool,
      surface: args.surface,
      denied: Boolean(args.denied),
      since: args.since,
      limit: rawNumber === undefined ? undefined : parseRecordCount(rawNumber),
      appRoot: args.app,
      json: Boolean(args.json),
    })
  },
})

/**
 * Read `-n` as a count. A `string` arg rather than citty's `number`: citty hands
 * `--number abc` across as `NaN`, every comparison against it is false, and the
 * empty listing reads as "no agent calls happened".
 */
function parseRecordCount(raw: string): number {
  const count = Number(raw)
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`-n must be a positive whole number of records — received "${raw}".`)
  }
  return count
}

// `token:` is its own namespace: this one writes into the application's store,
// so unlike its `tool:` neighbours it boots the app.
const tokenIssueCommand = defineCommand({
  meta: {
    name: 'token:issue',
    description: 'Issue an API token scoped to this application\'s agent tools (RFC 0016).',
  },
  args: {
    name: {
      type: 'string',
      description: 'Human-readable token name',
      required: true,
    },
    user: {
      type: 'string',
      description: 'User ID the token authenticates as',
      required: true,
    },
    tools: {
      type: 'string',
      description: 'Comma-separated tool scopes (tools:read, posts.*, posts.store, tools:*)',
      required: true,
    },
    'read-only': {
      type: 'boolean',
      description: 'Grant only read-only tools, stored as concrete tool: entries',
    },
    expires: {
      type: 'string',
      description: 'Expiry as 30d, 12h or 45m (omit to issue a non-expiring token)',
    },
    'allow-unmatched': {
      type: 'boolean',
      description: 'Accept a scope matching no current tool, granting it to tools added later',
    },
    yes: {
      type: 'boolean',
      description: 'Confirm a tools:* grant',
    },
    routes: {
      type: 'string',
      description: 'Path to the routes entry file',
      valueHint: 'routes/web.ts',
    },
    app: {
      type: 'string',
      description: 'Application root directory',
    },
    json: {
      type: 'boolean',
      description: 'Output the issued token as JSON',
    },
  },
  async run({ args }) {
    // Repeat-safe readers, on a command that mints credentials:
    // `--yes=false --yes=false` would authorize a `tools:*` grant the user twice
    // declined, and a repeated `--user` be stored as a principal nobody is.
    const name = args.name
    const user = args.user
    const tools = args.tools
    if (name === undefined || user === undefined || tools === undefined) {
      throw new Error('token:issue requires --name, --user and --tools.')
    }

    await runTokenIssue({
      name,
      user,
      tools,
      readOnly: Boolean(args['read-only']),
      allowUnmatched: Boolean(args['allow-unmatched']),
      yes: Boolean(args.yes),
      expires: args.expires,
      routesFile: args.routes,
      appRoot: args.app,
      json: Boolean(args.json),
    })

    // Booting the app opens whatever the app opens — a database pool, a Redis
    // client — and nothing here closes them, so a one-shot command must exit
    // explicitly. `routes:types` ends the same way.
    process.exit(0)
  },
})

const toolDevCommand = defineCommand({
  meta: {
    name: 'tool:dev',
    description: 'Serve this application\'s agent tools locally with a throwaway token (RFC 0016).',
  },
  args: {
    as: {
      type: 'string',
      description: 'User ID tool calls authenticate as (default: a placeholder matching no record)',
    },
    path: {
      type: 'string',
      description: 'Endpoint path, if the app mounted the MCP plugin somewhere other than /mcp',
      valueHint: '/mcp',
    },
    port: {
      type: 'string',
      description: 'Port to listen on (default 3333)',
    },
    host: {
      type: 'string',
      description: 'Hostname to bind (default 127.0.0.1)',
    },
    app: {
      type: 'string',
      description: 'Application root directory',
    },
  },
  async run({ args }) {
    // Decimal digits and nothing else: `parseInt` stops at the first non-digit
    // so `3333abc` would bind 3333, and `Number` turns `--port=`, `0x10` and
    // `1e3` into real ports nobody asked for.
    const rawPort = args.port
    const port = rawPort === undefined ? undefined : Number(rawPort)
    if (
      rawPort !== undefined
      && (!/^\d+$/u.test(rawPort.trim()) || port === undefined || port > 65535)
    ) {
      throw new Error(`Invalid --port value "${rawPort}". Use a port number between 0 and 65535.`)
    }

    await runToolDev({
      as: args.as,
      path: args.path,
      port,
      hostname: args.host,
      appRoot: args.app,
    })

    // Deliberately no process.exit: this command *is* the server, and it ends
    // when the developer stops it — which is when the token stops existing.
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

    // `PORT=0` means "any free port", so this tests for a number, not truthiness.
    const parsedPort = Number.parseInt(process.env.PORT ?? '', 10)
    const port = Number.isInteger(parsedPort) ? parsedPort : 3333
    const hostname = process.env.HOST ?? '0.0.0.0'

    let address: { url?: string } | undefined
    try {
      address = (await app.listen?.({ port, hostname })) as { url?: string } | undefined
    } catch (error) {
      consola.error('Failed to start application listener:', error)
      process.exit(1)
      return
    }

    // Report where it actually bound: the requested port is not it once the walk
    // moves past a busy one, or when PORT=0 lets the OS choose. The fallback is
    // for a `@guren/server` older than the bound-address return.
    consola.success(
      `Development server listening on ${address?.url ?? `http://${hostname}:${port}`}`,
    )
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
    // Declared `string`, not `positional`, so both spellings reach the entity
    // path: citty drops a value passed as a flag to a positional and raises no
    // unknown-flag error, so `guren context --entity User` used to print the
    // whole-project map and exit 0. A `string` arg still leaves the bare
    // positional in `_`.
    entity: {
      type: 'string',
      valueHint: 'User',
      description:
        'Model class name for an entity-centric context bundle (case-insensitive). Also accepted positionally: `guren context User`.',
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
    // Narrowed here so both branches get the same treatment: `--app` and
    // `--routes` reach a `resolve()` that throws on an array either way.
    const cwd = args.app
    const routesFile = args.routes
    const json = Boolean(args.json)
    const entity = args.entity ?? args._[0]

    if (entity) {
      await displayEntityContext(entity, {
        cwd,
        json,
        routesFile,
        module: args.module,
      })
      return
    }

    await displayContext({
      cwd,
      json,
      routesFile,
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
    i18n: {
      type: 'boolean',
      description: 'Run only translation catalog checks (lang/<locale> key and placeholder parity).',
    },
    changed: {
      type: 'boolean',
      description: 'Restrict file-scanning checks to files changed vs. the merge base with main.',
    },
    ci: {
      type: 'boolean',
      description: 'Exit non-zero when any check fails or warns (runs the full suite; for CI gates).',
    },
  },
  async run({ args }) {
    // --ci promises a full-suite gate; letting a suite flag narrow the run
    // underneath it would report success while docs/spec/core went unchecked.
    if (args.ci && (args.arch || args.docs || args.spec || args.i18n)) {
      consola.error('check --ci runs the full suite — drop --arch/--docs/--spec/--i18n (they gate on their own).')
      process.exitCode = 1
      return
    }

    const report = await runCheck({
      cwd: args.app,
      json: Boolean(args.json),
      routesFile: args.routes,
      arch: Boolean(args.arch),
      docs: Boolean(args.docs),
      spec: Boolean(args.spec),
      i18n: Boolean(args.i18n),
      changed: Boolean(args.changed),
    })

    if (args.json) {
      console.log(JSON.stringify(report, null, 2))
    } else {
      renderCheckReport(report)
    }

    // Only the suite flags and the opt-in `--ci` gate on exit code. Plain
    // `guren check` has never set one, and changing that on a v1.0-stable
    // command is a breaking change reserved for a major release.
    if ((args.arch || args.docs || args.spec || args.i18n) && report.failCount > 0) {
      process.exitCode = 1
    }
    // --ci also gates on warns: most integrity problems report as 'warn', so a
    // fail-only gate would wave nearly everything through. Advisory checks are
    // exempt, and the flag lives on the result so JSON consumers see the rule.
    if (args.ci && report.checks.some((c) => !c.advisory && c.status !== 'pass')) {
      process.exitCode = 1
    }
  },
})

const auditCommand = defineCommand({
  meta: {
    name: 'audit',
    description: 'Run a security audit: validation, authentication, raw SQL, secrets, mass assignment, dependency vulnerabilities.',
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
    deps: {
      type: 'boolean',
      default: true,
      description: 'Scan dependencies via bun audit (requires registry access). Disable with --no-deps.',
    },
  },
  async run({ args }) {
    const report = await runAudit({
      cwd: args.app,
      routesFile: args.routes,
      auditConfigFile: args.auditConfig,
      deps: args.deps,
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
  const wroteVerb = result.dryRun ? 'Would write' : 'Wrote'
  const replacedVerb = result.dryRun ? 'would replace' : 'replaced'

  for (const file of result.written) {
    consola.success(`${wroteVerb} ${file}`)
  }
  if (result.replaced.length > 0) {
    // The one destructive step, so it gets the one warning. The sync-specific
    // advice is exactly wrong for init --force, which replaces files the user
    // owns — CLAUDE.md *is* the user's own file.
    const advice =
      result.mode === 'sync'
        ? 'Local edits to framework-managed files do not survive agent:sync. Keep project-specific rules in files of your own — sync never touches files it does not ship.'
        : 'These files were replaced because --force was passed; the previous contents are gone.'
    consola.warn(
      `${result.replaced.length} of those ${replacedVerb} existing contents: ${result.replaced.join(', ')}\n${advice}`,
    )
  }
  if (result.unchanged.length > 0) {
    consola.info(`${result.unchanged.length} file(s) already up to date.`)
  }
  if (result.skipped.length > 0) {
    consola.info(`Skipped ${result.skipped.length} existing file(s): ${result.skipped.join(', ')}`)
  }
  if (result.stale.length > 0) {
    if (result.pruned) {
      consola.success(`Removed ${result.stale.length} stale managed file(s): ${result.stale.join(', ')}`)
    } else if (result.pruneRequested && result.dryRun) {
      consola.info(
        `Would remove ${result.stale.length} stale managed file(s): ${result.stale.join(', ')}`,
      )
    } else {
      consola.info(
        `Found ${result.stale.length} file(s) in framework-managed directories that are not part of the current harness: ${result.stale.join(', ')}\n` +
          'If they are leftovers from an earlier harness version, remove them with `bunx guren agent:sync --prune`. Files you authored yourself are safe to keep — sync never deletes without --prune.',
      )
    }
  }
  for (const hint of result.mcpMergeHints) {
    consola.info(
      `${hint.path} already exists, so it was left alone. Add the Guren MCP server to it yourself:\n${hint.snippet}`,
    )
  }
  if (result.mcpEndpointNotEnabled) {
    consola.info(
      'The agent MCP config points at the dev server MCP endpoint, which is opt-in. ' +
      'Add `GUREN_MCP=1` to your `dev` script, or start the server with `GUREN_MCP=1 bun run dev`.',
    )
  }
}

const AGENT_TARGETS_HELP = `Comma-separated agent targets: ${AGENT_TARGETS.join(', ')}, or "all".`

function parseTargetArg(raw: string): AgentTarget[] {
  try {
    return parseTargetList(raw)
  } catch (error) {
    // a typo is a usage problem: usage + message, not a stack trace
    throw new UsageError(error instanceof Error ? error.message : String(error))
  }
}

const AGENT_INIT_ARGS = {
  force: {
    type: 'boolean',
    alias: 'f',
    description: 'Overwrite existing files, including CLAUDE.md, AGENTS.md, and .claude/settings.json.',
  },
  target: {
    type: 'string',
    description: `${AGENT_TARGETS_HELP} Default: claude.`,
  },
  dryRun: {
    type: 'boolean',
    description:
      'Report what the init would write or replace without changing any file — the preview for --force.',
  },
  app: {
    type: 'string',
    description: 'Application root directory.',
  },
} as const

const agentInitCommand = defineCommand({
  meta: {
    name: 'agent:init',
    description:
      'Install the AI agent harness (CLAUDE.md/AGENTS.md, rules, skills, hooks, MCP config) for the selected agents.',
  },
  args: AGENT_INIT_ARGS,
  async run({ args }) {
    const result = await installAgentHarness({
      cwd: args.app,
      mode: 'init',
      force: Boolean(args.force),
      targets: args.target ? parseTargetArg(args.target) : undefined,
      dryRun: Boolean(args.dryRun),
    })
    reportAgentHarnessResult(result)
    consola.success(
      result.dryRun
        ? agentDryRunClosingLine('agent:init', AGENT_INIT_ARGS, args)
        : 'AI agent harness is ready. Update it later with `bunx guren agent:sync`.',
    )
  },
})

/**
 * The dry run's closing line, whose "run this to apply" hint carries the run's
 * own flags — the applied command must be the previewed one. Derived from the
 * declared arg spec so a future flag cannot fall out of the hint.
 */
function agentDryRunClosingLine(
  commandName: 'agent:init' | 'agent:sync',
  argsSpec: Record<string, { type?: string }>,
  args: Record<string, unknown>,
): string {
  let suffix = ''
  for (const name of Object.keys(argsSpec)) {
    if (name === 'dryRun') continue
    const flag = `--${name.replaceAll(/[A-Z]/gu, (c) => `-${c.toLowerCase()}`)}`
    const value = args[name]
    if (argsSpec[name]?.type === 'boolean') {
      if (value) suffix += ` ${flag}`
    } else if (typeof value === 'string' && value !== '') {
      suffix += ` ${flag} ${value}`
    }
  }
  return `[dry-run] Nothing was written. Run \`bunx guren ${commandName}${suffix}\` to apply.`
}

const AGENT_SYNC_ARGS = {
  target: {
    type: 'string',
    description: `${AGENT_TARGETS_HELP} Default: every target detected on disk.`,
  },
  prune: {
    type: 'boolean',
    description:
      'Delete files in framework-managed directories that are no longer part of the harness. Without this flag they are only reported.',
  },
  dryRun: {
    type: 'boolean',
    description: 'Report what the sync would write, replace, or prune without changing any file.',
  },
  app: {
    type: 'string',
    description: 'Application root directory.',
  },
} as const

const agentSyncCommand = defineCommand({
  meta: {
    name: 'agent:sync',
    description:
      'Update framework-managed agent harness files (rules, skills, agents, hooks) for every installed agent.',
  },
  args: AGENT_SYNC_ARGS,
  async run({ args }) {
    const result = await installAgentHarness({
      cwd: args.app,
      mode: 'sync',
      targets: args.target ? parseTargetArg(args.target) : undefined,
      prune: Boolean(args.prune),
      dryRun: Boolean(args.dryRun),
    })
    reportAgentHarnessResult(result)
    consola.success(
      result.dryRun
        ? agentDryRunClosingLine('agent:sync', AGENT_SYNC_ARGS, args)
        : 'Agent harness synced to the latest framework version.',
    )
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
    fields: FIELDS_ARG,
    attach: ATTACH_ARG,
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
      attach: args.attach,
      force: Boolean(args.force),
      root: args.module,
      withTest: Boolean(args.test),
      publicAccess: Boolean(args.public),
      withPolicy: Boolean(args.policy),
    })
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

const addAdminCommand = defineCommand({
  meta: {
    name: 'admin',
    description: 'Install a starter admin dashboard scaffold with routes and page.',
  },
  args: {
    public: {
      type: 'boolean',
      description: 'Skip the authentication check on the dashboard route (default: auth required)',
    },
    force: {
      type: 'boolean',
      description: 'Overwrite existing files',
      alias: 'f',
    },
  },
  async run({ args }) {
    const createdFiles = await runBlueprint('admin', {
      publicAccess: Boolean(args.public),
      force: Boolean(args.force),
    })

    for (const file of createdFiles) {
      consola.success(`Created ${file}`)
    }

    if (!args.public) {
      // Describes routes/admin.ts, not runtime behaviour — the wiring step
      // above may have reported it could not reach a registrar.
      consola.info(
        `  routes/admin.ts guards /admin and redirects to /login — that sign-in page comes from \`bunx guren add auth\`. Pass --public to opt out.`,
      )
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
    fields: FIELDS_ARG,
    attach: ATTACH_ARG,
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
      attach: typeof args.attach === 'string' ? args.attach : undefined,
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
    admin: addAdminCommand,
    attachments: createAddBlueprintCommand('attachments', 'Install the attachments layer: schema table, config, provider, and the prune command.'),
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

    if (result.deprecationWarnings.length > 0) {
      consola.box('Deprecation warnings')
      for (const dep of result.deprecationWarnings) {
        consola.warn(`${dep.what} (deprecated since ${dep.since}, removed in ${dep.removedIn})`)
        consola.info(`  Replacement: ${dep.replacement}`)
        consola.info(`  Affected files: ${dep.affectedFiles.join(', ')}`)
      }
    }

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
      throw new Error(`Invalid deploy target "${rawTarget}". Expected one of: docker, fly, railway, all. For Vercel, use \`bunx guren plugin @guren/plugin-vercel\`; for AWS Lambda, use \`bunx guren plugin @guren/plugin-lambda\`.`)
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

export const builtinSubCommands = {
  ...makeCommands,
  'make:adr': makeAdrCommand,
  'make:validator': makeValidatorCommand,
  'spec:generate': specGenerateCommand,
  'docs:graph': docsGraphCommand,
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
  'tool:list': toolListCommand,
  'tool:inspect': toolInspectCommand,
  'tool:call': toolCallCommand,
  'tool:log': toolLogCommand,
  'token:issue': tokenIssueCommand,
  'tool:dev': toolDevCommand,
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
  'model:list': modelListCommand,
  context: contextCommand,
  check: checkCommand,
  audit: auditCommand,
  guidelines: guidelinesCommand,
  'make:feature': makeFeatureCommand,
  'agent:init': agentInitCommand,
  'agent:sync': agentSyncCommand,
}